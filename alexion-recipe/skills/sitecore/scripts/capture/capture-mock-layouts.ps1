<#
.SYNOPSIS
  License-free mock-layouts capture for the MVC migration pipeline.

.DESCRIPTION
  Harvests the *raw* per-route inputs needed to assemble JSS-shape Layout
  Service envelopes — without invoking the licensed Layout Service. The
  per-route bundle is:

    raw/<normalized>/page.json    — Probe Z step 1 output
    raw/<normalized>/names.json   — Probe Z step 2 output
    raw/<normalized>/fields.json  — merged Probe Z step 3 output

  Plus a top-level `manifest.json` enumerating routes and capture metadata.

  Assemble downloaded, already-extracted raw files with the adjacent portable
  assemble-mvc-captures.mjs helper. This script does no envelope assembly.

  Only license-free building blocks are used here:
    - Get-Rendering -FinalLayout
    - Sitecore.LayoutService.DefaultItemSerializer (Headless Services package)
    - Sitecore.Links.LinkManager.GetItemUrl

  See docs/mvc/KAJOO-4923-license-free-mock-layouts/IMPLEMENTATION-PLAN.md
  for the full pipeline, plus probe-z/scripts/01..03 for the building-block
  prototypes this script absorbs.

.INJECTED_VARIABLES
  $sitePath              [string]   - Sitecore item path, e.g. "/sitecore/content/PHO/Home". REQUIRED.
  $language              [string]   - Language code, e.g. "en". REQUIRED.
  $siteName              [string]   - Site name for SiteContextSwitcher, e.g. "website". REQUIRED.
                                       Caller (Phase 4 orchestrator) sources this from
                                       handlerConfig.sourceSiteName.
  $routes                [string[]] - OPTIONAL. If supplied, skips discovery and uses these
                                       routes verbatim. Each entry is a Sitecore item path.
  $routePlan             [object[]] - OPTIONAL. Preferred coverage-plan input: a JSON array of
                                       { route, itemPath } objects. `itemPath` is the verbatim
                                       Sitecore Paths.FullPath used to Get-Item the page exactly
                                       (a multi-word item name cannot be resolved from its
                                       lowercased/hyphenated LinkManager route). When supplied,
                                       skips discovery. Takes precedence over $routes.
  $additionalRoutes      [string[]] - OPTIONAL. Routes to union with discovery output
                                       (ignored when $routes or $routePlan is supplied).
  $verboseLogging        [bool]     - OPTIONAL. Default $false. When $true, logs every
                                       per-route attempt (otherwise only headline progress,
                                       skips, and failures).
  $selection             [string]   - "discovery-plan" for approved-plan captures.
  $capturePlanFingerprint [string]  - Approved plan SHA256; echoed into the raw manifest.
  $maxUrls               [int]      - OPTIONAL. Positive attempt cap (unresolved items count).
                                       Omitted or 0 captures all supplied routes.

.OUTPUTS
  System.String — single JSON document on stdout:
    {
      "rootPath":              "Data",
      "outputRelativeDir":     "kajoo/mock-layouts/<timestamp>-<safe-site>-<lang>",
      "manifestRelativePath":  "kajoo/mock-layouts/<timestamp>-<safe-site>-<lang>/manifest.json",
      "bundleCount":           <int>,
      "totalBundleBytes":      <int64>,
      "routeCount":       <int>,    # routes successfully written across all bundles
      "discoveredCount":  <int>,    # discovery output before union
      "additionalCount":  <int>,    # -AdditionalRoutes count (post-dedupe)
      "overrideCount":    <int>,    # -Routes count when supplied; else 0
      "skippedRoutes":    [ "..." ],            # unresolvable inputs
      "failedRoutes":     [ { path, reason } ], # mid-capture errors
      "sourceInstance":   "<host>",
      "sourceItemPath":   "<sitePath>",
      "language":         "<lang>",
      "capturedAt":       "2026-05-04T12:34:56Z"
    }

  Output layout on the CM (under <DataFolder>):
    kajoo/mock-layouts/<ts>-<safe>-<lang>/
      manifest.json        (top-level; the worker pulls this first)
      bundle-001.zip       (≤5 MB compressed; entries at raw/<route>/{page,names,fields}.json)
      bundle-002.zip
      ...
      raw/                 (uncompressed staging tree; preserved for debug)

  Manifest.bundles = [{ filename, routeCount, sizeBytes, rawSizeBytes, routes: [...] }]
  drives the Phase-2 worker's per-bundle download + assemble loop.

.NOTES
  PowerShell 5.1 / .NET Framework. Runs remotely under SPE Remoting.
  Designed for one-shot execution: a single PS session does discovery,
  per-route capture, and final zip — no back-and-forth with the worker
  during capture.
#>

$ErrorActionPreference = 'Stop'
Set-Location "master:\sitecore" | Out-Null

# Top-level capture so any unexpected throw produces a single structured
# JSON envelope on stdout (instead of leaving the SPE session in a Failed
# state with empty output, which surfaces as 'fetch failed' to the worker).
$__capturedAtFallback = (Get-Date).ToUniversalTime().ToString('o')
try {

# ----------------------------------------------------------------------------
# Parameter validation (fail fast — no defaulting for required params).
# ----------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($sitePath)) {
    throw "Required parameter 'sitePath' is missing or empty."
}
if ([string]::IsNullOrWhiteSpace($language)) {
    throw "Required parameter 'language' is missing or empty."
}
if ([string]::IsNullOrWhiteSpace($siteName)) {
    throw "Required parameter 'siteName' is missing or empty."
}

# An explicitly supplied plan must never turn into recursive discovery when
# malformed or empty. These variables are injected by prepare-capture-request.
$planMode = ($selection -eq 'discovery-plan') -or (-not [string]::IsNullOrWhiteSpace($capturePlanFingerprint))
$routePlanSupplied = ($null -ne $routePlan)
if ($planMode -and ($selection -ne 'discovery-plan' -or $capturePlanFingerprint -notmatch '^[a-fA-F0-9]{64}$')) {
    throw 'Plan capture requires selection discovery-plan and a SHA256 capturePlanFingerprint.'
}
if ($null -ne $maxUrls) {
    $parsedMaxUrls = 0
    if (-not [int]::TryParse([string]$maxUrls, [ref]$parsedMaxUrls) -or $parsedMaxUrls -lt 0) { throw 'maxUrls must be a nonnegative integer (0 means all).' }
    $maxUrls = if ($parsedMaxUrls -gt 0) { $parsedMaxUrls } else { $null }
}

if ($null -eq $routes)             { $routes = @() }
if ($null -eq $routePlan)          { $routePlan = @() }
if ($null -eq $additionalRoutes)   { $additionalRoutes = @() }
if ($null -eq $verboseLogging)     { $verboseLogging = $false }

# SPE Remoting injects every variable as a string. When the caller passes
# arrays/booleans they're JSON-encoded on the wire, so coerce here.
function ConvertTo-StringArray($v) {
    if ($null -eq $v) { return ,@() }
    if ($v -is [string]) {
        if ([string]::IsNullOrWhiteSpace($v)) { return ,@() }
        try {
            $parsed = ConvertFrom-Json -InputObject $v -ErrorAction Stop
        } catch {
            return ,@($v)
        }
        if ($null -eq $parsed) { return ,@() }
        return ,@($parsed | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    return ,@($v)
}

# Parse $routePlan — a JSON array of { route, itemPath } objects. Returns an
# array of PSCustomObjects with .route / .itemPath (either may be $null).
function ConvertTo-RoutePlan($v) {
    if ($null -eq $v) { return ,@() }
    $parsed = $v
    if ($v -is [string]) {
        if ([string]::IsNullOrWhiteSpace($v)) { throw 'routePlan must be a non-empty JSON array.' }
        if (-not $v.TrimStart().StartsWith('[')) { throw 'routePlan must be a JSON array.' }
        try { $parsed = ConvertFrom-Json -InputObject $v -ErrorAction Stop } catch { throw 'Invalid routePlan JSON.' }
    }
    if ($null -eq $parsed) { throw 'routePlan must contain at least one page.' }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($e in @($parsed)) {
        if ($null -eq $e) { throw 'routePlan contains an empty entry.' }
        $route    = $null
        $itemPath = $null
        if ($e -is [string]) { throw 'routePlan entries must be objects.' } else {
            if ($e.PSObject.Properties['route'])    { $route    = [string]$e.route }
            if ($e.PSObject.Properties['itemPath']) { $itemPath = [string]$e.itemPath }
        }
        if ([string]::IsNullOrWhiteSpace($route) -or [string]::IsNullOrWhiteSpace($itemPath)) { throw 'routePlan entries require route and itemPath.' }
        if (-not $route.StartsWith('/') -or $route.StartsWith('//') -or $route -match '[\\?#%\x00-\x20:<>"|*]' -or ($route -ne '/' -and @($route.TrimStart('/').Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' -or $_ -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)' }).Count -gt 0)) { throw "Unsafe planned route: $route" }
        if (-not $itemPath.StartsWith('/sitecore/', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'routePlan itemPath must be an absolute Sitecore item path.' }
        if ($e.language -and $e.language -ne $language) { throw 'routePlan language differs from capture language.' }
        [void]$out.Add([PSCustomObject]@{ route = $route; itemPath = $itemPath; itemId = $e.itemId; language = $e.language })
    }
    if ($out.Count -eq 0) { throw 'routePlan must contain at least one page.' }
    return ,@($out.ToArray())
}

$routes           = ConvertTo-StringArray $routes
$additionalRoutes = ConvertTo-StringArray $additionalRoutes
$routePlan        = if ($routePlanSupplied -or $planMode) { ConvertTo-RoutePlan $routePlan } else { @() }
if (($planMode -or $routePlanSupplied) -and $routePlan.Count -eq 0) { throw 'routePlan must contain at least one page; discovery fallback is forbidden.' }
if ($routePlan.Count -gt 0) {
    $planRoutes = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($e in $routePlan) {
        $key = if ($e.route -eq '/') { 'home' } else { $e.route.TrimStart('/') }
        if (-not $planRoutes.Add($key)) { throw "Duplicate route/output in routePlan: $($e.route)" }
    }
}
if ($verboseLogging -is [string])   { $verboseLogging = ($verboseLogging -eq 'true' -or $verboseLogging -eq '1') }

# Normalize so we can compare/dedupe regardless of case or trailing slash.
function Normalize-Path([string] $p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    $t = $p.Trim()
    if ($t.Length -gt 1 -and $t.EndsWith('/')) { $t = $t.TrimEnd('/') }
    return $t
}

$normSitePath = Normalize-Path $sitePath
if (-not $normSitePath.StartsWith('/sitecore/', [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $normSitePath.StartsWith('/sitecore', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "sitePath must be an absolute Sitecore content path starting with /sitecore/, got '$sitePath'."
}

# ----------------------------------------------------------------------------
# Pre-flight type-load probe (fail fast before any discovery work).
# ----------------------------------------------------------------------------
$lsAsm = [AppDomain]::CurrentDomain.GetAssemblies() |
    Where-Object { $_.GetName().Name -eq 'Sitecore.LayoutService' } |
    Select-Object -First 1
if (-not $lsAsm) {
    throw "Sitecore.LayoutService.dll not loadable on this CM. Headless Services is required. See KAJOO-4907 (detect) and KAJOO-4917 (install)."
}
$defaultSerType = $lsAsm.GetType('Sitecore.LayoutService.Serialization.ItemSerializers.DefaultItemSerializer')
$pipelineType   = $lsAsm.GetType('Sitecore.LayoutService.Serialization.Pipelines.GetFieldSerializer.IGetFieldSerializerPipeline')
if (-not $defaultSerType -or -not $pipelineType) {
    throw "Sitecore.LayoutService.dll loaded but DefaultItemSerializer/IGetFieldSerializerPipeline types not found. See KAJOO-4907 (detect) and KAJOO-4917 (install)."
}

# ----------------------------------------------------------------------------
# Shared site context (renders fields like RTE/links without NRE).
# ----------------------------------------------------------------------------
$hostUrl = "http://localhost/"
$req     = New-Object System.Web.HttpRequest("", $hostUrl, "")
$resp    = New-Object System.Web.HttpResponse((New-Object System.IO.StringWriter))
[System.Web.HttpContext]::Current = New-Object System.Web.HttpContext($req, $resp)
$site    = [Sitecore.Configuration.Factory]::GetSite($siteName)
if (-not $site) {
    throw "Site '$siteName' not found in Sitecore configuration."
}
$switcher = New-Object Sitecore.Sites.SiteContextSwitcher($site)

$db          = [Sitecore.Configuration.Factory]::GetDatabase("master")
$lang        = [Sitecore.Globalization.Language]::Parse($language)
$sp          = [Sitecore.DependencyInjection.ServiceLocator]::ServiceProvider
$serializer  = [Activator]::CreateInstance($defaultSerType, @($sp.GetService($pipelineType)))

# Site start path — JSS MockLayoutService route folders are computed from the
# item path *relative to the site start item*, not from LinkManager URLs.
# (LinkManager URLs may include a language prefix or other URL options.)
# StartPath = site.RootPath + site.StartItem (e.g. "/sitecore/content/pho" + "/home").
$siteStartPath = ($site.RootPath.TrimEnd('/') + '/' + $site.StartItem.TrimStart('/')).TrimEnd('/')

$capturedAt    = (Get-Date).ToUniversalTime().ToString("o")
$timestampSafe = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$safeSite      = ($sitePath -replace '[^a-zA-Z0-9]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($safeSite)) { $safeSite = 'site' }

$dataRoot     = [Sitecore.Configuration.Settings]::DataFolder
$kajooBase    = Join-Path $dataRoot "kajoo\mock-layouts"
$outputName   = "$timestampSafe-$safeSite-$language"
if ($planMode) { $outputName += '-' + [guid]::NewGuid().ToString('N') }
$outputRelDir = "kajoo/mock-layouts/$outputName"
$stagingRoot  = Join-Path $kajooBase $outputName
$rawRoot      = Join-Path $stagingRoot "raw"
# Bundle target: ~12 MB raw on disk -> typically ~3–4 MB compressed for JSON
# (well under the measured 8 MB egress cap on PHO/nginx).
$bundleTargetBytes = 12MB

if (-not (Test-Path $rawRoot)) { [void](New-Item -ItemType Directory -Path $rawRoot -Force) }

# All progress/diagnostic logging goes to this file (included in the zip).
# Stdout is reserved for the single JSON result envelope at the end of the
# script. Mixing Write-Output with the final ConvertTo-Json corrupts the
# response the SPE worker receives, especially for large captures.
$logPath = Join-Path $stagingRoot 'capture.log'
[void](New-Item -ItemType File -Path $logPath -Force)
function Write-Log([string] $msg) {
    $line = ('[{0}] {1}' -f ((Get-Date).ToUniversalTime().ToString('o')), $msg)
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

# Resolve sourceInstance for the manifest (host the script is running on).
$sourceInstance = $null
try { $sourceInstance = [System.Net.Dns]::GetHostName() } catch { $sourceInstance = $env:COMPUTERNAME }

# ----------------------------------------------------------------------------
# Helpers absorbed from probe-z/scripts/01-page-snapshot.ps1,
# 02-rendering-names.ps1, 03-datasource-batch.ps1.
# ----------------------------------------------------------------------------

# Route folder = the LinkManager-generated item URL, cleaned to match exactly
# what the runtime MockSitecoreClient looks up on disk. LinkManager already
# encodes a Sitecore item name's spaces as hyphens (via EncodeNameReplacements),
# so the on-disk folder matches the URL the Next.js app requests — e.g. the item
# 'External Advisory Committees' -> '/about/external-advisory-committees/...'.
#
# Cleaning mirrors MockSitecoreClient.getPage(): strip any scheme/host, drop
# query/fragment, URL-decode (%20 -> space etc.), trim slashes, and lower-case.
# An empty path (the site-start/home item, whose URL is '/') maps to 'home'.
#
# NOTE: this function does NOT strip language embedding. The caller already does
# that at the GetItemUrl call site by passing UrlOptions with
# LanguageEmbedding = Never, so every URL that reaches here is already locale-less
# (and the start item's URL is empty/'/', hitting the 'home' rule below). A prior
# version of this comment claimed DefaultOptions emits no language segment for the
# source site — that was false and reintroduced an /en prefix (commit 9b570e31).
#
# Examples:
#   '/'                                        -> 'home'
#   '/about'                                   -> 'about'
#   '/about/external-advisory-committees/oiac' -> 'about/external-advisory-committees/oiac'
function Normalize-RouteOutputPath([string] $itemUrl) {
    if ([string]::IsNullOrWhiteSpace($itemUrl)) { return 'home' }
    $u = $itemUrl.Trim()
    # Strip scheme + host if LinkManager returned an absolute URL.
    $m = [regex]::Match($u, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+(?<path>/.*)?$')
    if ($m.Success) { $u = $m.Groups['path'].Value }
    # Drop query string / fragment.
    $u = ($u -split '[?#]')[0]
    if ([string]::IsNullOrWhiteSpace($u)) { return 'home' }
    # URL-decode to mirror the client's decodeURIComponent().
    try { $u = [System.Uri]::UnescapeDataString($u) } catch { }
    $u = $u.Trim('/')
    if ([string]::IsNullOrWhiteSpace($u)) { return 'home' }
    return $u.ToLowerInvariant()
}

# Capture page snapshot (Probe Z step 1) — page metadata + slim renderings + datasource IDs.
function Capture-PageSnapshot([Sitecore.Data.Items.Item] $page) {
    # Layout definition (default device): the layout-definition GUID is what lets
    # MCP-side analyzeLayoutDistribution bucket pages by their actual chrome layout,
    # and the layout item's "Path" field is the source .cshtml view path consumed by
    # the MVC Styles agent. Both degrade to $null (-> 'unknown' downstream) on failure.
    #
    # LOAD-BEARING: Visualization.GetLayout($device) returns a NON-hydrated reference
    # whose ["Path"] field is null. The full layout-definition item must be re-fetched
    # by ID before reading "Path".
    $layoutId = $null
    $layoutFilePath = $null
    try {
        $device = Get-LayoutDevice -Default
        if ($device) {
            $layoutRef = $page.Visualization.GetLayout($device)
            if ($layoutRef) {
                $layoutId = $layoutRef.ID.ToString()
                $layoutDef = $page.Database.GetItem($layoutRef.ID)
                if ($layoutDef) { $layoutFilePath = $layoutDef["Path"] }
            }
        }
    } catch {
        # Tolerate layout-resolution failures — both fields stay null and degrade to
        # 'unknown' at MCP-side assembly. Not a route-level failure.
    }

    $out = [ordered]@{
        Page = [ordered]@{
            Id             = $page.ID.ToString()
            Name           = $page.Name
            Path           = $page.Paths.FullPath
            TemplateId     = $page.TemplateID.ToString()
            TemplateName   = $page.TemplateName
            Language       = $page.Language.Name
            FieldsJson     = $serializer.Serialize($page)
            LayoutId       = $layoutId
            LayoutFilePath = $layoutFilePath
        }
    }

    $rends = Get-Rendering -Item $page -FinalLayout
    $out.Renderings = @($rends | Select-Object UniqueID, ItemID, Placeholder, Datasource, Parameters)

    $dsList = New-Object System.Collections.Generic.List[string]
    foreach ($r in $rends) {
        if ($r.Datasource -and $r.Datasource.Trim().Length -gt 0 -and -not $dsList.Contains($r.Datasource)) {
            [void]$dsList.Add($r.Datasource)
        }
    }
    $out.DatasourceIds   = $dsList
    $out.DatasourceCount = $dsList.Count
    $out.RenderingCount  = $rends.Count
    return $out
}

# Resolve rendering display names for a unique set of rendering item IDs (Probe Z step 2).
function Resolve-RenderingNames([string[]] $itemIds) {
    $map = [ordered]@{}
    foreach ($id in $itemIds) {
        if ([string]::IsNullOrWhiteSpace($id)) { continue }
        if ($map.Contains($id)) { continue }
        try {
            $i = $db.GetItem($id)
            if ($i) { $map[$id] = $i.Name }
        } catch {
            # Tolerate individual lookup failures — name will fall back to 'Unknown'
            # at MCP-side assembly. Not a route-level failure.
        }
    }
    return $map
}

# Serialize a batch of datasource items (Probe Z step 3). Returns id -> field-json string.
function Serialize-DatasourceBatch([string[]] $itemIds) {
    $map = [ordered]@{}
    foreach ($id in $itemIds) {
        if ([string]::IsNullOrWhiteSpace($id)) { continue }
        if ($map.Contains($id)) { continue }
        try {
            $i = $db.GetItem($id, $lang)
            if ($i) { $map[$id] = $serializer.Serialize($i) }
        } catch {
            # Tolerate per-datasource failures so one broken DS doesn't poison the route.
            # MCP-side assembly will simply omit fields for missing entries.
        }
    }
    return $map
}

# ----------------------------------------------------------------------------
# Discovery
# ----------------------------------------------------------------------------

# Resolve $sitePath itself first — it must exist and be reachable.
$siteItem = $null
try { $siteItem = Get-Item -Path "master:$normSitePath" -ErrorAction Stop }
catch { throw "sitePath not resolvable: '$sitePath'. Underlying error: $($_.Exception.Message)" }
if (-not $siteItem) {
    throw "sitePath not resolvable: '$sitePath'."
}

$discoveredItems = New-Object System.Collections.Generic.List[object]
# routePlan (LinkManager routes + verbatim itemPaths) takes precedence over the
# legacy $routes override, which takes precedence over recursive discovery.
$useRoutePlan    = ($routePlan.Count -gt 0)
$useDiscovery    = (-not $useRoutePlan) -and ($routes.Count -eq 0)
$overrideCount   = if ($useRoutePlan) { $routePlan.Count } else { $routes.Count }

if ($useDiscovery) {
    Write-Log "discovering pages under $normSitePath ..."
    # Stream the recursive walk through the pipeline so we never materialize
    # the full subtree in memory (subtrees of 5k-10k items are common).
    $siteItem | ForEach-Object {
        if ((($_.Fields['__Final Renderings'] -and -not [string]::IsNullOrWhiteSpace($_.Fields['__Final Renderings'].Value)) -or
             ($_.Fields['__Renderings']        -and -not [string]::IsNullOrWhiteSpace($_.Fields['__Renderings'].Value)))) {
            [void]$discoveredItems.Add($_)
        }
    }
    Get-ChildItem -Path "master:$normSitePath" -Recurse | ForEach-Object {
        if ((($_.Fields['__Final Renderings'] -and -not [string]::IsNullOrWhiteSpace($_.Fields['__Final Renderings'].Value)) -or
             ($_.Fields['__Renderings']        -and -not [string]::IsNullOrWhiteSpace($_.Fields['__Renderings'].Value)))) {
            [void]$discoveredItems.Add($_)
        }
    }
    Write-Log "discovered $($discoveredItems.Count) page(s) with renderings."
}

# Build the resolved-input list. Each entry: @{ Item = ..., Path = '...' }.
$resolved      = New-Object System.Collections.Generic.List[object]
$skippedRoutes = New-Object System.Collections.Generic.List[string]
$outcomes      = New-Object System.Collections.Generic.List[object]
$attemptedUrls = 0
$seenPaths     = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)

# Resolve one capture input to a content item.
#
#   $itemPath  — verbatim Sitecore Paths.FullPath (preferred; resolves a
#                multi-word item exactly). When supplied, it is the only
#                resolution attempted — a clean LinkManager route cannot
#                round-trip a spaced/title-cased item name, so we never
#                guess. Unresolvable → recorded skip, never a silent drop.
#   $route     — site-relative URL ('/', '/about/...') OR an absolute
#                '/sitecore/*' item path (discovery + legacy modes). Used
#                only when $itemPath is absent.
#
# There is exactly ONE route-derivation mechanism in this pipeline
# (LinkManager, producer-side); this function does NO slugifying and NO
# slug-walk recovery — those were the guesses that dropped multi-word items.
function Try-Resolve([string] $route, [string] $itemPath) {
    $dedupeKey = if (-not [string]::IsNullOrWhiteSpace($itemPath)) { Normalize-Path $itemPath } else { Normalize-Path $route }
    if (-not $dedupeKey) { return $null }
    if (-not $seenPaths.Add($dedupeKey)) { return 'duplicate' }  # silently dedupe

    $label = if (-not [string]::IsNullOrWhiteSpace($itemPath)) { $itemPath } else { $route }
    $np    = $null
    $itm   = $null

    if (-not [string]::IsNullOrWhiteSpace($itemPath)) {
        # Exact resolution by verbatim item path.
        $np = Normalize-Path $itemPath
        try { $itm = Get-Item -Path "master:$np" -Language $language -ErrorAction Stop } catch { $itm = $null }
    } else {
        # Site-relative URL ('/about/...') or absolute '/sitecore/*' path.
        # Join the site start path onto relative routes so Get-Item resolves.
        $r = Normalize-Path $route
        if (-not $r) { return $null }
        $isRelative = ($r -notlike '/sitecore/*')
        $np = if ($isRelative) {
            if ($r -eq '/') { $siteStartPath } else { $siteStartPath + $r }
        } else { $r }
        try { $itm = Get-Item -Path "master:$np" -Language $language -ErrorAction Stop } catch { $itm = $null }
    }

    if (-not $itm) {
        Write-Log "WARN unresolvable input route: $label"
        [void]$skippedRoutes.Add($label)
        return $null
    }
    $hasRends = ($itm.Fields['__Final Renderings'] -and -not [string]::IsNullOrWhiteSpace($itm.Fields['__Final Renderings'].Value)) -or
                ($itm.Fields['__Renderings']        -and -not [string]::IsNullOrWhiteSpace($itm.Fields['__Renderings'].Value))
    if (-not $hasRends) {
        Write-Log "WARN input route has no renderings: $label"
        [void]$skippedRoutes.Add($label)
        return $null
    }
    return @{ Item = $itm; Path = $np }
}

if ($useRoutePlan) {
    foreach ($e in $routePlan) {
        if ($null -ne $maxUrls -and $attemptedUrls -ge $maxUrls) {
            [void]$skippedRoutes.Add($e.itemPath)
            [void]$outcomes.Add([ordered]@{ route = $e.route; itemId = $e.itemId; itemPath = $e.itemPath; language = $language; status = 'skipped'; reason = 'maxUrls limit reached' })
            continue
        }
        $attemptedUrls++
        $entry = Try-Resolve $e.route $e.itemPath
        if ($entry -and $entry -ne 'duplicate') {
            $identityMatches = (-not $e.itemId -or ($entry.Item.ID.ToString() -replace '[{}-]', '') -eq ($e.itemId -replace '[{}-]', '')) -and ($entry.Item.Paths.FullPath -ceq $e.itemPath) -and ($entry.Item.Language.Name -eq $language)
            if (-not $identityMatches) {
                [void]$skippedRoutes.Add($e.itemPath)
                [void]$outcomes.Add([ordered]@{ route = $e.route; itemId = $e.itemId; itemPath = $e.itemPath; language = $language; status = 'failed'; reason = 'Resolved item identity differs from plan' })
                continue
            }
            $entry.Route = $e.route
            [void]$resolved.Add($entry)
        } else {
            [void]$outcomes.Add([ordered]@{ route = $e.route; itemId = $e.itemId; itemPath = $e.itemPath; language = $language; status = 'failed'; reason = 'Item unresolved, duplicated, or has no renderings' })
        }
    }
} elseif ($useDiscovery) {
    foreach ($it in $discoveredItems) {
        if ($null -ne $maxUrls -and $attemptedUrls -ge $maxUrls) { [void]$skippedRoutes.Add($it.Paths.FullPath); continue }
        $attemptedUrls++
        $entry = Try-Resolve $it.Paths.FullPath $null
        if ($entry -and $entry -ne 'duplicate') { [void]$resolved.Add($entry) }
    }
    foreach ($extra in $additionalRoutes) {
        if ($null -ne $maxUrls -and $attemptedUrls -ge $maxUrls) { [void]$skippedRoutes.Add($extra); continue }
        $attemptedUrls++
        $entry = Try-Resolve $extra $null
        if ($entry -and $entry -ne 'duplicate') { [void]$resolved.Add($entry) }
    }
} else {
    foreach ($r in $routes) {
        if ($null -ne $maxUrls -and $attemptedUrls -ge $maxUrls) { [void]$skippedRoutes.Add($r); continue }
        $attemptedUrls++
        $entry = Try-Resolve $r $null
        if ($entry -and $entry -ne 'duplicate') { [void]$resolved.Add($entry) }
    }
}

$discoveredCount = if ($useDiscovery) { $discoveredItems.Count } else { 0 }
$additionalCount = if ($useDiscovery) { $additionalRoutes.Count } else { 0 }
# Requested = how many distinct inputs the caller asked for. In routePlan /
# routes / discovery mode this is the completeness denominator the consumer
# checks: requested == captured + recordedFailures (skipped + failed).
$requestedCount  = if ($useRoutePlan) { $routePlan.Count }
                   elseif ($useDiscovery) { $discoveredItems.Count + $additionalRoutes.Count }
                   else { $routes.Count }

if ($resolved.Count -eq 0 -and -not $useRoutePlan) {
    # Tear down site context before throwing.
    try { $switcher.Dispose() } catch { }
    [System.Web.HttpContext]::Current = $null
    throw "No resolvable routes to capture (after discovery + input filtering). skippedRoutes=$($skippedRoutes.Count)."
}

# ----------------------------------------------------------------------------
# Per-route capture (errors are non-fatal — accumulate into failedRoutes).
# ----------------------------------------------------------------------------
$failedRoutes = New-Object System.Collections.Generic.List[object]
$writtenRoutes = New-Object System.Collections.Generic.List[object]

$idx = 0
$total = $resolved.Count
try {
    foreach ($entry in $resolved) {
        $idx++
        $itm  = $entry.Item
        $path = $entry.Path
        $normalized = $null
        try {
            # LOAD-BEARING: LanguageEmbedding = Never is the single switch that delivers
            # BOTH correct outputs here. (1) It strips the culture segment from the route
            # URL, so we write public/mock-layouts/<path>/index.json — NOT a locale-nested
            # public/mock-layouts/<locale>/<path>/index.json the mock client never reads.
            # (2) It collapses the start item's URL to '/'/empty, so Normalize-RouteOutputPath's
            # empty/'/' -> 'home' rule maps home to public/mock-layouts/home/index.json instead
            # of the root. DefaultOptions embeds the language for this site and reintroduces
            # the /en nesting + root-level home (the regression from commit 9b570e31). DO NOT
            # remove these options as "redundant".
            #
            # SINGLE-LANGUAGE CONTRACT — REVISIT FOR MULTI-LANGUAGE: the capture output and the
            # mock-layouts tree have no language dimension. One capture run is one language and
            # the mock client reads locale-less paths. We KNOW we must return here to design a
            # real per-language layout when we support customers with multiple languages — the
            # locale-stripping is a deliberate, time-limited simplification, not an oversight.
            $urlOptions = [Sitecore.Links.UrlOptions]::DefaultOptions
            $urlOptions.LanguageEmbedding = [Sitecore.Links.LanguageEmbedding]::Never
            $itemUrl = if ($useRoutePlan) { $entry.Route } else { [Sitecore.Links.LinkManager]::GetItemUrl($itm, $urlOptions) }
            $normalized = if ($useRoutePlan) { if ($itemUrl -eq '/') { 'home' } else { $itemUrl.TrimStart('/') } } else { Normalize-RouteOutputPath $itemUrl }
            if ($verboseLogging) {
                Write-Log "[$idx/$total] capturing $path  ->  $normalized"
            } elseif (($idx % 25) -eq 0 -or $idx -eq 1 -or $idx -eq $total) {
                Write-Log "progress $idx/$total"
            }

            $snap = Capture-PageSnapshot $itm

            # Resolve unique rendering item IDs (slim shape stores ItemID per rendering).
            $renderingIds = @()
            $seenRId = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($r in $snap.Renderings) {
                $rid = $r.ItemID
                if ($rid -and $seenRId.Add([string]$rid)) { $renderingIds += [string]$rid }
            }
            $names = Resolve-RenderingNames $renderingIds

            # All datasources serialized in one in-process pass. Probe-z's batching was
            # a transport-limit workaround for run-powershell-script; this script is one
            # session that calls the serializer directly, so no batching is needed.
            $dsAll = $snap.DatasourceIds
            $fields = [ordered]@{}
            if ($dsAll -and $dsAll.Count -gt 0) {
                $fields = Serialize-DatasourceBatch $dsAll
            }

            # Stage the three raw files for this route.
            $routeDir = Join-Path $rawRoot ($normalized -replace '/', '\')
            if (-not (Test-Path $routeDir)) { [void](New-Item -ItemType Directory -Path $routeDir -Force) }

            $snap   | ConvertTo-Json -Depth 8  -Compress | Out-File -FilePath (Join-Path $routeDir 'page.json')   -Encoding UTF8 -NoNewline
            $names  | ConvertTo-Json -Depth 4  -Compress | Out-File -FilePath (Join-Path $routeDir 'names.json')  -Encoding UTF8 -NoNewline
            $fields | ConvertTo-Json -Depth 4  -Compress | Out-File -FilePath (Join-Path $routeDir 'fields.json') -Encoding UTF8 -NoNewline

            $rawHashes = [ordered]@{}
            foreach ($filename in @('page.json', 'names.json', 'fields.json')) {
                $rawHashes[$filename] = (Get-FileHash -LiteralPath (Join-Path $routeDir $filename) -Algorithm SHA256).Hash.ToLowerInvariant()
            }

            [void]$writtenRoutes.Add([ordered]@{
                path        = $path
                route       = $itemUrl
                itemId      = $itm.ID.ToString()
                itemPath    = $itm.Paths.FullPath
                language    = $itm.Language.Name
                hashes      = $rawHashes
                normalized  = $normalized
                url         = $itemUrl
                renderings  = $snap.RenderingCount
                datasources = $snap.DatasourceCount
            })
            [void]$outcomes.Add([ordered]@{ route = $itemUrl; itemId = $itm.ID.ToString(); itemPath = $itm.Paths.FullPath; language = $itm.Language.Name; status = 'captured'; normalized = $normalized; hashes = $rawHashes })
        } catch {
            $reason = $_.Exception.Message
            Write-Log "ERROR route '$path' failed: $reason"
            $failedRoute = if ($useRoutePlan) { $entry.Route } else { $itemUrl }
            [void]$failedRoutes.Add([ordered]@{ path = $path; route = $failedRoute; itemId = $itm.ID.ToString(); itemPath = $itm.Paths.FullPath; language = $language; reason = $reason })
            [void]$outcomes.Add([ordered]@{ route = $failedRoute; itemId = $itm.ID.ToString(); itemPath = $itm.Paths.FullPath; language = $language; status = 'failed'; reason = $reason })
        }
    }
}
finally {
    try { $switcher.Dispose() } catch { }
    [System.Web.HttpContext]::Current = $null
}

# ----------------------------------------------------------------------------
# Manifest + zip
# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# Bundle bin-packing
# ----------------------------------------------------------------------------
# Greedy bin-pack on raw on-disk size: each route's raw bytes are summed,
# routes are grouped sequentially so no group exceeds $bundleTargetBytes
# (single oversized routes become their own group with a warning). Each group
# is then zipped into bundle-NNN.zip with entry paths `raw/<normalized>/<file>`
# so the worker can extract directly into its raw tree.
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ($writtenRoutes.Count -eq 0 -and -not $useRoutePlan) {
    throw "Capture produced zero successful routes. skippedRoutes=$($skippedRoutes.Count) failedRoutes=$($failedRoutes.Count)."
}

$routeSizes = New-Object System.Collections.Generic.List[object]
foreach ($wr in $writtenRoutes) {
    $rd  = Join-Path $rawRoot ($wr.normalized -replace '/', '\')
    $sum = (Get-ChildItem -LiteralPath $rd -File -Recurse | Measure-Object -Property Length -Sum).Sum
    if (-not $sum) { $sum = 0 }
    [void]$routeSizes.Add([ordered]@{ Route = $wr; Dir = $rd; SizeBytes = [int64]$sum })
}

$bundleGroups = New-Object System.Collections.Generic.List[object]
$cur          = [ordered]@{ Routes = New-Object System.Collections.Generic.List[object]; SizeBytes = [int64]0 }
foreach ($rs in $routeSizes) {
    if ($cur.Routes.Count -gt 0 -and ($cur.SizeBytes + $rs.SizeBytes) -gt $bundleTargetBytes) {
        [void]$bundleGroups.Add($cur)
        $cur = [ordered]@{ Routes = New-Object System.Collections.Generic.List[object]; SizeBytes = [int64]0 }
    }
    [void]$cur.Routes.Add($rs)
    $cur.SizeBytes += $rs.SizeBytes
    if ($rs.SizeBytes -gt $bundleTargetBytes) {
        Write-Log ("WARN oversized single-route bundle: {0} (rawBytes={1})" -f $rs.Route.normalized, $rs.SizeBytes)
    }
}
if ($cur.Routes.Count -gt 0) { [void]$bundleGroups.Add($cur) }

$bundleInfos = New-Object System.Collections.Generic.List[object]
$bIdx = 0
foreach ($g in $bundleGroups) {
    $bIdx++
    $bn = ('bundle-{0:D3}.zip' -f $bIdx)
    $bp = Join-Path $stagingRoot $bn
    if (Test-Path $bp) { Remove-Item -LiteralPath $bp -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($bp, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($rs in $g.Routes) {
            $normRel = $rs.Route.normalized
            foreach ($f in Get-ChildItem -LiteralPath $rs.Dir -File) {
                $entryName = "raw/$normRel/$($f.Name)"
                [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $zip, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            }
        }
    } finally {
        $zip.Dispose()
    }
    $info = Get-Item $bp
    [void]$bundleInfos.Add([ordered]@{
        filename     = $bn
        routeCount   = $g.Routes.Count
        sizeBytes    = [int64]$info.Length
        rawSizeBytes = [int64]$g.SizeBytes
        routes       = @($g.Routes | ForEach-Object { $_.Route.normalized })
    })
    Write-Log ("bundle {0} : {1} route(s), raw={2} B, zip={3} B" -f $bn, $g.Routes.Count, $g.SizeBytes, $info.Length)
}

$manifest = [ordered]@{
    selection       = $(if ($planMode) { 'discovery-plan' } else { 'legacy' })
    capturePlanFingerprint = $capturePlanFingerprint
    outcomes        = $outcomes
    attemptedUrls   = $attemptedUrls
    maxUrls         = $maxUrls
    captureKind     = 'mock-layouts-license-free-raw'
    capturedAt      = $capturedAt
    sourceInstance  = $sourceInstance
    sourceItemPath  = $sitePath
    siteName        = $siteName
    language        = $language
    requestedCount  = $requestedCount
    routes          = $writtenRoutes
    skippedRoutes   = $skippedRoutes
    failedRoutes    = $failedRoutes
    bundles         = $bundleInfos
}
$manifest | ConvertTo-Json -Depth 6 -Compress |
    Out-File -FilePath (Join-Path $stagingRoot 'manifest.json') -Encoding UTF8 -NoNewline

# ----------------------------------------------------------------------------
# Result envelope (the worker reads this as the script's stdout JSON).
# ----------------------------------------------------------------------------
$totalBundleBytes = 0
foreach ($bi in $bundleInfos) { $totalBundleBytes += [int64]$bi.sizeBytes }

$result = [ordered]@{
    selection            = $(if ($planMode) { 'discovery-plan' } else { 'legacy' })
    capturePlanFingerprint = $capturePlanFingerprint
    outcomes             = $outcomes
    attemptedUrls        = $attemptedUrls
    maxUrls              = $maxUrls
    rootPath             = 'Data'
    outputRelativeDir    = $outputRelDir
    manifestRelativePath = "$outputRelDir/manifest.json"
    bundleCount          = $bundleInfos.Count
    totalBundleBytes     = [int64]$totalBundleBytes
    routeCount           = $writtenRoutes.Count
    requestedCount       = $requestedCount
    discoveredCount      = $discoveredCount
    additionalCount      = $additionalCount
    overrideCount        = $overrideCount
    skippedRoutes        = $skippedRoutes
    failedRoutes         = $failedRoutes
    sourceInstance       = $sourceInstance
    sourceItemPath       = $sitePath
    siteName             = $siteName
    language             = $language
    capturedAt           = $capturedAt
}
$result | ConvertTo-Json -Depth 6

}
catch {
    # Single-shot error envelope. Stdout is the only channel the worker reads,
    # so we MUST emit valid JSON here even on catastrophic failure.
    $err = $_
    $errorOutcomes = if ($null -ne $outcomes) { $outcomes.ToArray() } else { @() }
    $errorEnvelope = [ordered]@{
        selection      = $selection
        capturePlanFingerprint = $capturePlanFingerprint
        outcomes       = @($errorOutcomes)
        ok             = $false
        error          = $err.Exception.Message
        errorType      = $err.Exception.GetType().FullName
        scriptStackTrace = [string]$err.ScriptStackTrace
        invocationLine = [string]$err.InvocationInfo.Line
        invocationPos  = [string]$err.InvocationInfo.PositionMessage
        sourceItemPath = $sitePath
        siteName       = $siteName
        language       = $language
        capturedAt     = $__capturedAtFallback
    }
    $errorEnvelope | ConvertTo-Json -Depth 6
}

