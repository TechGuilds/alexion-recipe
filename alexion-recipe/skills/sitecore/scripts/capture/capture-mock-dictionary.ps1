<#
.SYNOPSIS
  License-free mock-dictionary capture for the MVC migration pipeline.

.DESCRIPTION
  Resolves the source site's dictionary domain, enumerates its Dictionary
  entries via the search index, filters to the harvested key set, reads the
  Phrase for each (all language versions present, or one specific locale when
  requested), and writes one flat { key: phrase } JSON per locale to the Data
  folder for the worker to download.

  Mirrors capture-mock-layouts.ps1 (one-shot SPE Remoting, single JSON
  envelope on stdout) but is much simpler — tiny payload, no bundling/zip.

  Dictionary-root resolution chain (in order; never silently falls through to
  the system dictionary, which on real sources holds only third-party/Coveo
  strings and would re-introduce the empty-mock bug):
    1. explicit $dictionaryRootPath override (caller-supplied)
    2. site.dictionaryDomain attribute (GUID or name) — PROVEN for this source
    3. site.dictionaryPath attribute (GUID or name)
    4. the per-site <rootPath>/<siteName>/Settings/Dictionary convention (last)
    5. ERROR with the resolution attempts (never /sitecore/system/Dictionary)

.INJECTED_VARIABLES
  $keys               [string[]] REQUIRED. Harvested dictionary keys (JSON array on the wire).
  $language           [string]   OPTIONAL. e.g. "en". When set, restricts capture to that
                                 locale; when omitted/empty, captures every language version present.
  $siteName           [string]   REQUIRED (unless $dictionaryRootPath given). Source site, for
                                 dictionaryDomain resolution.
  $dictionaryRootPath [string]   OPTIONAL. Explicit override of the dictionary root item path;
                                 skips dictionaryDomain resolution.

.OUTPUTS
  Single JSON envelope on stdout:
    { rootPath:"Data", outputRelativeDir,
      locales:[ { locale, fileRelativePath, matchedKeyCount } ],
      requestedKeyCount, missingKeys:[...],
      dictionaryRootUsed, rootResolvedBy, language, capturedAt }
  Data-folder layout: kajoo/mock-dictionary/<ts>-<safe-site>-<lang|all>/dictionary.<locale>.json

.NOTES
  PowerShell 5.1 / SPE Remoting. Dictionary entry template:
  {6D1CD897-1936-4A3A-A511-289A94C2A7B1}. Uses Find-Item over
  sitecore_master_index (never a recursive Get-ChildItem over master:/sitecore).
#>
$ErrorActionPreference = 'Stop'
Set-Location "master:\sitecore" | Out-Null
$__capturedAtFallback = (Get-Date).ToUniversalTime().ToString('o')
try {
    # --- param validation (fail fast) ---
    if ([string]::IsNullOrWhiteSpace($siteName) -and [string]::IsNullOrWhiteSpace($dictionaryRootPath)) {
        throw "Either 'siteName' (for dictionaryDomain resolution) or 'dictionaryRootPath' is required."
    }

    # SPE Remoting injects everything as a string; arrays arrive JSON-encoded.
    function ConvertTo-StringArray($v) {
        if ($null -eq $v) { return ,@() }
        if ($v -is [string]) {
            if ([string]::IsNullOrWhiteSpace($v)) { return ,@() }
            try { $parsed = ConvertFrom-Json -InputObject $v -ErrorAction Stop } catch { return ,@($v) }
            if ($null -eq $parsed) { return ,@() }
            return ,@($parsed | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
        return ,@($v)
    }
    $keys = ConvertTo-StringArray $keys
    if ($keys.Count -eq 0) { throw "Required parameter 'keys' is missing or empty." }

    $entryTemplateId = "6D1CD897-1936-4A3A-A511-289A94C2A7B1"

    # --- resolve the dictionary root (ordered chain; report how it resolved) ---
    function Resolve-DictionaryItem($idOrPath) {
        if ([string]::IsNullOrWhiteSpace($idOrPath)) { return $null }
        if ($idOrPath -match '^\{?[0-9A-Fa-f-]{36}\}?$') {
            return Get-Item -Path "master:" -ID $idOrPath -ErrorAction SilentlyContinue
        }
        return Get-Item -Path "master:$idOrPath" -ErrorAction SilentlyContinue
    }

    $dictRootItem = $null
    $rootResolvedBy = $null
    $resolutionAttempts = @()

    # 1. explicit override
    if (-not [string]::IsNullOrWhiteSpace($dictionaryRootPath)) {
        $resolutionAttempts += "explicit-override:'$dictionaryRootPath'"
        $dictRootItem = Resolve-DictionaryItem $dictionaryRootPath
        if ($dictRootItem) { $rootResolvedBy = 'explicit-override' }
    }

    $site = $null
    if (-not $dictRootItem -and -not [string]::IsNullOrWhiteSpace($siteName)) {
        $site = [Sitecore.Configuration.Factory]::GetSite($siteName)
    }

    # 2. site.dictionaryDomain (GUID or name) — proven path
    if (-not $dictRootItem -and $site) {
        $dd = $site.Properties["dictionaryDomain"]
        if (-not [string]::IsNullOrWhiteSpace($dd)) {
            $resolutionAttempts += "dictionaryDomain:'$dd'"
            $dictRootItem = Resolve-DictionaryItem $dd
            if ($dictRootItem) { $rootResolvedBy = 'site.dictionaryDomain' }
        }
    }

    # 3. site.dictionaryPath (GUID or name)
    if (-not $dictRootItem -and $site) {
        $dp = $site.Properties["dictionaryPath"]
        if (-not [string]::IsNullOrWhiteSpace($dp)) {
            $resolutionAttempts += "dictionaryPath:'$dp'"
            $dictRootItem = Resolve-DictionaryItem $dp
            if ($dictRootItem) { $rootResolvedBy = 'site.dictionaryPath' }
        }
    }

    # 4. per-site <rootPath>/<siteName>/Settings/Dictionary convention (truly last)
    if (-not $dictRootItem -and $site -and $site.Properties["rootPath"]) {
        $guess = (($site.Properties["rootPath"]).TrimEnd('/')) + "/" + $siteName + "/Settings/Dictionary"
        $resolutionAttempts += "rootPath-convention:'$guess'"
        $dictRootItem = Get-Item -Path "master:$guess" -ErrorAction SilentlyContinue
        if ($dictRootItem) { $rootResolvedBy = 'rootPath-convention' }
    }

    # 5. ERROR — never silently fall to /sitecore/system/Dictionary
    if (-not $dictRootItem) {
        throw "Could not resolve a dictionary root for siteName='$siteName'. Attempts: $($resolutionAttempts -join '; '). Refusing to fall back to /sitecore/system/Dictionary (holds only third-party strings)."
    }

    # --- enumerate Dictionary entries under the root via the index (fast) ---
    $rootPathLower = $dictRootItem.Paths.FullPath.ToLowerInvariant()
    $hits = Find-Item -Index "sitecore_master_index" -Criteria @(
        @{ Filter = 'Equals';     Field = '_template'; Value = $entryTemplateId },
        @{ Filter = 'StartsWith'; Field = '_fullpath'; Value = $rootPathLower }
    ) -First 5000

    # --- build a fast lookup of requested keys ---
    $want = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($k in $keys) { [void]$want.Add($k) }

    # Restrict to a single locale when requested; otherwise capture all present.
    $targetLanguages = $null
    if (-not [string]::IsNullOrWhiteSpace($language)) { $targetLanguages = @($language) }

    # --- project Phrase per locale into per-locale maps ---
    $maps = @{}   # locale -> @{ key -> phrase }
    foreach ($h in $hits) {
        $base = Get-Item -Path "master:" -ID $h.ItemId -ErrorAction SilentlyContinue
        if (-not $base) { continue }
        $langs = if ($targetLanguages) { $targetLanguages } else { @($base.Languages | ForEach-Object { $_.Name }) }
        foreach ($lang in $langs) {
            $it = Get-Item -Path "master:" -ID $h.ItemId -Language $lang -ErrorAction SilentlyContinue
            if (-not $it -or $it.Versions.Count -eq 0) { continue }
            $k = [string]$it['Key']
            if ([string]::IsNullOrWhiteSpace($k)) { continue }
            if (-not $want.Contains($k)) { continue }
            if (-not $maps.ContainsKey($lang)) { $maps[$lang] = @{} }
            if (-not $maps[$lang].ContainsKey($k)) { $maps[$lang][$k] = [string]$it['Phrase'] }
        }
    }

    # missingKeys = keys absent in ALL locales (Q4 omit-unbacked audit trail).
    $allMatched = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($lang in $maps.Keys) { foreach ($k in $maps[$lang].Keys) { [void]$allMatched.Add($k) } }
    $missing = @($keys | Where-Object { -not $allMatched.Contains($_) })

    # --- write one flat { key: phrase } JSON per locale to the Data folder ---
    $capturedAt    = (Get-Date).ToUniversalTime().ToString("o")
    $timestampSafe = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $safeSite      = ($siteName -replace '[^a-zA-Z0-9]', '-').Trim('-'); if (-not $safeSite) { $safeSite = 'site' }
    $langTag       = if ($targetLanguages) { $language } else { 'all' }
    $dataRoot      = [Sitecore.Configuration.Settings]::DataFolder
    $outputName    = "$timestampSafe-$safeSite-$langTag"
    $outputRelDir  = "kajoo/mock-dictionary/$outputName"
    $stagingRoot   = Join-Path (Join-Path $dataRoot "kajoo\mock-dictionary") $outputName
    if (-not (Test-Path $stagingRoot)) { [void](New-Item -ItemType Directory -Path $stagingRoot -Force) }

    $localesOut = @()
    foreach ($lang in ($maps.Keys | Sort-Object)) {
        $fileName = "dictionary.$lang.json"
        $maps[$lang] | ConvertTo-Json -Depth 4 -Compress |
            Out-File -FilePath (Join-Path $stagingRoot $fileName) -Encoding UTF8 -NoNewline
        $localesOut += [PSCustomObject]@{
            locale           = $lang
            fileRelativePath = "$outputRelDir/$fileName"
            matchedKeyCount  = $maps[$lang].Count
        }
    }

    [PSCustomObject]@{
        rootPath           = 'Data'
        outputRelativeDir  = $outputRelDir
        locales            = $localesOut
        requestedKeyCount  = $keys.Count
        missingKeys        = $missing
        dictionaryRootUsed = $dictRootItem.Paths.FullPath
        rootResolvedBy     = $rootResolvedBy
        language           = $language
        capturedAt         = $capturedAt
    } | ConvertTo-Json -Depth 6
}
catch {
    [PSCustomObject]@{
        error      = $_.Exception.Message
        capturedAt = $__capturedAtFallback
    } | ConvertTo-Json -Depth 6
}

