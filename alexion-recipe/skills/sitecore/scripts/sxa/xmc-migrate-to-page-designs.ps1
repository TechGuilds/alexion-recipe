<#
.INJECTED_VARIABLES
  $sitePath    [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
  $mode        [string] - "dry-run" or "execute". Dry-run reports what would change without modifying anything.
  $templateId  [string] - (Optional) GUID of a single template to process. If empty, processes all mapped templates.
  $pagePath    [string] - (Optional) Path to a single page — resolves its template and processes only that template.
  $limitCount  [string] - (Optional) Max number of templates to process (default: 0 = all).
  $scope       [string] - (Optional) "both" (default) = SVs then pages. "sv" and "pages" are DEPRECATED
                          because the page pass depends on SV-pass cross-context for orphan detection
                          and FR placeholder rewriting. Split runs produce incomplete results.

.SYNOPSIS
  Strips shared-layout renderings from template Standard Values and/or page items that
  are now covered by Page Design → Partial Design composition. After create-partial-designs,
  create-page-designs, and assign-page-designs have run, the shared renderings on template SVs
  are duplicates of what's in the Partial Designs. This tool strips those duplicates so pages
  get their presentation exclusively from the Page Design chain.

.PIPELINE POSITION
  3 of 3: discover → create-partial-designs → [MIGRATE-TO-PAGE-DESIGNS]
  Input: TemplatesMapping on Page Designs folder + PD rendering signatures
  Output: Stripped SVs and pages; rewritten placeholder paths on preserved/orphan renderings

.ALGORITHM (MULTI-PASS)
  PASS 1 — SV shared-layout strip:
    Read shared-layout renderings from each SV. Signature-match against PD rendering set.
    Direct matches + sub-placeholder descendants → STRIP set. Everything else → PRESERVE.
    Remove-Rendering on shared layout removes from __Renderings field.
    SIDE EFFECT: Remove-Rendering from shared layout can create phantom <p:d /> entries
    in __Final Renderings (Sitecore records the "delta" of the removal). This is expected
    and harmless — Pass 2 cleans up any final-only phantom entries.

  PASS 2 — SV final-layout strip:
    After Pass 1, re-read the SV's merged layout. Any remaining PD-matched renderings
    (now only in __Final Renderings) are stripped with Remove-Rendering -FinalLayout.

  F141 — SV orphan remap:
    Preserved SV renderings may reference stripped UIDs in their placeholder paths.
    These are rewritten to canonical SXA composed form (placeholderKey/slot-ordinal-dynamicId)
    using the PD compose info (PD rendering UID → placeholder key + DynPHId).

  PASS 3 — Page shared-layout strip:
    For each page with a populated __Renderings field: signature-match against PD set.
    Cross-pass: SV-stripped UIDs are tracked as "phantom parents" — page-level children
    referencing stripped SV UIDs are detected as orphans even though the page itself
    didn't have the parent rendering in its shared field.
    Pages where ALL renderings match PD → reset (field reverted to standard value = inherit).
    Pages with mixed matches → surgical removal (deepest-first to avoid cascade issues).

  ORPHAN CHILD REMAP:
    Page-specific children of PD-covered parents have their placeholder paths rewritten
    from UID-based to SXA composed form. Written to BOTH shared AND final layouts.
    Uses same compose-info pattern as SV orphan remap.

  W76 — FR PLACEHOLDER REWRITE PASS:
    Separate pass over ALL pages with Final Renderings containing legacy UID-based or
    pre-SV-strip placeholder paths. Resolves to canonical PD-composed format.
    Three resolver paths:
    - Form A (legacy orphan): /root/slot-{GUID}-ordinal → single-level resolver
    - Form B (already normalized): /root/key/slot-ordinal-dynamic → verify canonical
    - Form C (multi-level UID): contains GUID segments → compose-based multi-level resolver
    PARENT-PRESERVED GUARD: Renderings whose parent UID belongs to a preserved (not stripped)
    rendering are SKIPPED — their UID-based placeholder is still valid.

.SCOPE REQUIREMENT
  Always use scope="both". The SV pass populates svStripDataByTemplate{} which the
  page pass and FR pass consume for orphan detection and placeholder rewriting.
  Running scope="sv" then scope="pages" separately loses this cross-pass context.

.DATASOURCE & SIGNATURE MATCHING
  Get-RenderingSignature = ItemID + Normalize-DataSource(ds) + Normalize-RenderingParams(params)
  Query-ds renderings: because Normalize-DataSource preserves query text verbatim (F138),
  a SV rendering with query-ds will signature-match the same rendering on the PD
  (which was copied verbatim by create-partial-designs). The query-ds rendering on the
  SV is correctly stripped as a PD duplicate.
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/sitecore"

    Import-Function -Name Get-DesignItem
    Import-Function -Name Get-ItemByIdSafe

    $debug = [System.Collections.ArrayList]::new()
    $isDryRun = ($mode -ne "execute")
    $effectiveScope = if ([string]::IsNullOrWhiteSpace($scope)) { "both" }
                      elseif ($scope -eq "sv") { "sv" }
                      elseif ($scope -eq "pages") { "pages" }
                      elseif ($scope -eq "both") { "both" }
                      else { "sv" }
    [void]$debug.Add("Mode: $(if ($isDryRun) { 'dry-run' } else { 'execute' }) | Scope: $effectiveScope")

    # NORMALIZATION CONTRACT (F107 / W57)
    # NormalizationContractVersion: 2026-03-17-d
    #
    # IMPORTANT: Keep normalization logic equivalent across ALL THREE scripts:
    # 1) xmc-discover-presentation-patterns.ps1
    # 2) xmc-create-partial-designs.ps1
    # 3) xmc-migrate-to-page-designs.ps1
    #
    # Keep source-value normalization behavior equivalent in the other two files
    # and keep the same contract version value. A rule explicitly marked
    # MIGRATION-ONLY may handle a target-side transport artifact and must not be
    # applied to source discovery or creation inputs.
    #
    # Contract scope:
    # - Rendering parameter canonicalization: deterministic parsing, stable ordering,
    #   equivalent encoding/entity forms normalize to one canonical representation
    #   without destructive semantic rewrites.
    # - Datasource canonicalization: typed handling for GUID, Sitecore path,
    #   query/fast query/URI-like values, and safe opaque-string fallback.
    #
    # Non-goals:
    # - No raw XML delta parsing changes.
    # - No rewrite of cmdlet-based strip/copy flow.
    #
    # Tracking: F107, W57, W35, W36, F102
    $NormalizationContractVersion = "2026-03-17-d"

    function Normalize-Text([string]$raw) {
        if ($null -eq $raw) { return "" }
        $text = [string]$raw
        if ([string]::IsNullOrWhiteSpace($text)) { return "" }
        $decoded = [System.Web.HttpUtility]::HtmlDecode($text)
        if ($null -eq $decoded) { $decoded = $text }
        $decoded = $decoded -replace [char]160, ' '
        return $decoded.Trim()
    }

    function Normalize-RenderingParams([string]$raw) {
        $text = Normalize-Text $raw
        if ([string]::IsNullOrWhiteSpace($text)) { return "" }
        # Strip leading '?' that Sitecore may prefix on query-string-style parameters
        $text = $text.TrimStart('?')
        if ([string]::IsNullOrWhiteSpace($text)) { return "" }

        # MIGRATION-ONLY: SPE can serialize an empty Parameter hashtable on a newly added rendering
        # as the literal lower-case "s". It is not a source rendering parameter and
        # must not make an otherwise identical PD signature look different.
        if ($text -ceq "s") { return "" }

        $sxaNoValueKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($k in @("GridParameters", "FieldNames", "Styles", "RenderingIdentifier", "CSSStyles")) {
            [void]$sxaNoValueKeys.Add($k)
        }

        $parts = @($text -split "&" | Where-Object { $_ -ne "" })
        $tuples = [System.Collections.ArrayList]::new()
        foreach ($part in $parts) {
            $kv = $part -split "=", 2
            $k = Normalize-Text $kv[0]
            if (-not $k) { continue }

            $hasExplicitEquals = ($kv.Count -gt 1)
            $v = if ($hasExplicitEquals) { $kv[1] } else { "" }
            $v = Normalize-Text $v
            $kDecoded = [System.Web.HttpUtility]::UrlDecode($k)
            $vDecoded = [System.Web.HttpUtility]::UrlDecode($v)
            if ($null -eq $kDecoded) { $kDecoded = $k }
            if ($null -eq $vDecoded) { $vDecoded = $v }
            # Normalize underscores to spaces in key names (layout XML may store either)
            $kDecoded = $kDecoded -replace '_', ' '

            # XM Cloud may inject DynamicPlaceholderId values that are absent in source.
            # Treat them as non-semantic for parity and strip matching.
            if ($kDecoded -eq "DynamicPlaceholderId") { continue }

            # Ignore known SXA-injected keys entirely for parity and strip matching.
            if ($sxaNoValueKeys.Contains($kDecoded)) { continue }

            [void]$tuples.Add([PSCustomObject]@{
                key = $kDecoded
                hasEquals = $hasExplicitEquals
                value = $vDecoded
            })
        }

        $sorted = @($tuples | Sort-Object key, hasEquals, value)
        return (@($sorted | ForEach-Object {
            if ($_.hasEquals) {
                "$($_.key)=$($_.value)"
            } else {
                "$($_.key)"
            }
        }) -join "&")
    }

    function Normalize-DataSource([string]$raw) {
        $text = Normalize-Text $raw
        if ([string]::IsNullOrWhiteSpace($text)) { return "" }

        $urlDecoded = [System.Web.HttpUtility]::UrlDecode($text)
        if ($null -ne $urlDecoded -and $urlDecoded -ne "") { $text = $urlDecoded }

        $guidNoBraces = $text -replace '[{}-]', ''
        if ($guidNoBraces -match '^[0-9a-fA-F]{32}$') {
            $g = $guidNoBraces.ToUpperInvariant()
            return "{$($g.Substring(0,8))-$($g.Substring(8,4))-$($g.Substring(12,4))-$($g.Substring(16,4))-$($g.Substring(20,12))}"
        }
        if ($text -match '^\{?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}?$') {
            $g = ($text -replace '[{}]', '').ToUpperInvariant()
            return "{$g}"
        }

        if ($text.StartsWith('/')) {
            $text = ($text -replace '\\', '/') -replace '/+', '/'
            if ($text.Length -gt 1) { $text = $text.TrimEnd('/') }
            return $text.ToLowerInvariant()
        }

        # [F138] Query-DS passthrough: only the prefix is lowercased. The query expression
        # after ":" is preserved VERBATIM. This is critical for signature matching:
        # a query-ds rendering on the SV and the same one on the PD (copied by create-partial-designs)
        # must produce identical signatures so the SV copy is correctly detected as a PD duplicate.
        # Do NOT modify query text — see discover script for detailed rationale.
        if ($text -match '^(query|fast):') {
            $parts = $text -split ':', 2
            $prefix = $parts[0].ToLowerInvariant()
            $rest = if ($parts.Count -gt 1) { $parts[1].Trim() } else { "" }
            return "${prefix}:$rest"
        }

        if ($text -match '^(sitecore|media)://') {
            $parts = $text -split '://', 2
            $scheme = $parts[0].ToLowerInvariant()
            $rest = if ($parts.Count -gt 1) { $parts[1].Trim() } else { "" }
            return "${scheme}://$rest"
        }

        return $text
    }

    # Rendering signature = ItemID + normalized datasource + normalized parameters.
    # This is the IDENTITY function for matching SV/page renderings against PD renderings.
    # Two renderings with the same signature are considered duplicates.
    # [F138] Query-ds datasources are normalized identically in all three scripts
    # (only prefix lowercased), so SV query-ds renderings signature-match PD copies.
    function Get-RenderingSignature($rendering) {
        if (-not $rendering -or -not $rendering.ItemID) { return "" }
        $itemId = $rendering.ItemID.ToString().ToUpperInvariant()
        $ds = Normalize-DataSource ([string]$rendering.Datasource)
        $p = Normalize-RenderingParams ([string]$rendering.Parameters)
        return "$itemId|$ds|$p"
    }

    function New-UidSet {
        # PowerShell enumerates an empty collection returned from a function as
        # no pipeline output. The unary comma preserves the HashSet object so
        # callers always receive a usable case-insensitive UID set.
        return ,[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    }

    function Test-UidReference([string]$value, [string]$uid) {
        if ([string]::IsNullOrWhiteSpace($value) -or [string]::IsNullOrWhiteSpace($uid)) { return $false }
        return $value.IndexOf($uid, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }

    function Test-LayoutXmlUid([string]$layoutXml, [string]$uid) {
        if ([string]::IsNullOrWhiteSpace($layoutXml) -or [string]::IsNullOrWhiteSpace($uid)) { return $false }
        return $layoutXml.IndexOf($uid, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }

    # [F141] Normalize-PlaceholderKey: reduces dynamic GUIDs and numeric suffixes to {*}
    # Used for placeholder canonicalization during variance analysis and orphan remap.
    # e.g., "/lockedtop/phNav-{A1B2C3D4-...}-0" → "/lockedtop/phNav-{*}"
    function Normalize-PlaceholderKey([string]$raw) {
        $text = Normalize-Text $raw
        if ([string]::IsNullOrWhiteSpace($text)) { return "" }
        $normalized = $text -replace '\{[0-9A-Fa-f-]{36}\}', '{*}'
        $normalized = $normalized -replace '-\d+', '-{*}'
        $normalized = $normalized -replace '(-\{\*\})+', '-{*}'
        return $normalized
    }

    # ── Step 1: Read TemplatesMapping from Page Designs folder ──
    $site = Get-Item -Path "master:$sitePath" -ErrorAction SilentlyContinue
    if (-not $site) {
        throw "Site not found at $sitePath"
    }

    $pageDesignsFolder = Get-Item -Path "master:$sitePath/Presentation/Page Designs" -ErrorAction SilentlyContinue
    if (-not $pageDesignsFolder) {
        throw "Page Designs folder not found at $sitePath/Presentation/Page Designs"
    }

    $rawMapping = $pageDesignsFolder.TemplatesMapping
    if (-not $rawMapping) {
        throw "No TemplatesMapping found on Page Designs folder — run xmc-assign-page-design first"
    }

    # Parse URL-encoded querystring format: {tplGuid}={pdGuid}&{tplGuid2}={pdGuid2}&...
    $decoded = [System.Web.HttpUtility]::UrlDecode($rawMapping)
    $tplToPd = @{}
    foreach ($pair in ($decoded -split '&')) {
        if ($pair -match '^(.+?)=(.+)$') {
            $tplToPd[$matches[1]] = $matches[2]
        }
    }
    [void]$debug.Add("TemplatesMapping loaded: $($tplToPd.Count) template(s) mapped to Page Designs")

    # ── Step 2: Build PD rendering signature sets per Page Design ──
    # Collect ALL rendering signatures from all Partial Designs of each Page Design
    $pdRenderingsByDesign = @{}
    $pdSigToUidByDesign = @{}  # signature → PD rendering UniqueId (for orphan child remap)
    $pdNameByDesign = @{}      # designId → designItem.Name (for substrate outcome emit)
    $uniqueDesignIds = @($tplToPd.Values | Sort-Object -Unique)
    [void]$debug.Add("Unique Page Designs referenced: $($uniqueDesignIds.Count)")

    foreach ($designId in $uniqueDesignIds) {
        $designItem = Get-ItemByIdSafe $designId
        if (-not $designItem) {
            [void]$debug.Add("WARN: Page Design $designId not found — templates using it will be skipped")
            continue
        }
        $pdNameByDesign[$designId] = $designItem.Name

        # Read PartialDesigns field (pipe-delimited GUIDs)
        $pdField = $designItem.Fields["PartialDesigns"].Value
        if (-not $pdField) {
            [void]$debug.Add("Page Design '$($designItem.Name)' has no Partial Designs — nothing to match")
            $pdRenderingsByDesign[$designId] = [System.Collections.Generic.HashSet[string]]::new()
            continue
        }

        $pdIds = $pdField.Split([char]"|") | Where-Object { $_ -ne "" }
        $renderingSet = [System.Collections.Generic.HashSet[string]]::new()
        $sigToUidMap = @{}

        foreach ($pdId in $pdIds) {
            $pdItem = Get-ItemByIdSafe $pdId
            if (-not $pdItem) {
                [void]$debug.Add("WARN: Partial Design $pdId not found — skipping")
                continue
            }

            $pdRenderings = @(Get-Rendering -Item $pdItem -ErrorAction SilentlyContinue)
            foreach ($r in $pdRenderings) {
                $sig = Get-RenderingSignature $r
                if ($sig) {
                    [void]$renderingSet.Add($sig)
                    if ($r.UniqueId) { $sigToUidMap[$sig] = $r.UniqueId }
                }
            }
            [void]$debug.Add("  PD '$($pdItem.Name)': $($pdRenderings.Count) rendering(s) → cumulative signatures: $($renderingSet.Count)")
        }

        $pdRenderingsByDesign[$designId] = $renderingSet
        $pdSigToUidByDesign[$designId] = $sigToUidMap
        [void]$debug.Add("Page Design '$($designItem.Name)': $($renderingSet.Count) unique rendering signatures from $($pdIds.Count) Partial Design(s)")
    }

    # ── Result collections ──
    $results = [System.Collections.ArrayList]::new()
    $totalStripped = 0
    $totalPreserved = 0
    $totalTemplatesModified = 0
    $totalSvOrphansRemapped = 0

    # ── Steps 3+4: Template SV processing (scope = sv or both) ──
    if ($effectiveScope -ne "pages") {
    $scopedTemplates = @{}

    if (-not [string]::IsNullOrWhiteSpace($pagePath)) {
        # Single page mode: resolve page's template, then process that template
        $fullPath = if ($pagePath.StartsWith("/sitecore")) { $pagePath } else { "$sitePath$pagePath" }
        $page = Get-Item -Path "master:$fullPath" -ErrorAction SilentlyContinue
        if (-not $page) {
            throw "Page not found at $fullPath"
        }
        $pageTplId = $page.TemplateID.ToString()
        if ($tplToPd.ContainsKey($pageTplId)) {
            $scopedTemplates[$pageTplId] = $tplToPd[$pageTplId]
        } else {
            throw "Page template $pageTplId ($($page.TemplateName)) is not mapped to any Page Design in TemplatesMapping"
        }
        [void]$debug.Add("Scope: single page '$fullPath' → template $pageTplId")
    }
    elseif (-not [string]::IsNullOrWhiteSpace($templateId)) {
        $cleanId = $templateId.Trim()
        if (-not $cleanId.StartsWith("{")) { $cleanId = "{$cleanId}" }
        if ($tplToPd.ContainsKey($cleanId)) {
            $scopedTemplates[$cleanId] = $tplToPd[$cleanId]
        } else {
            throw "Template $cleanId is not in TemplatesMapping — not mapped to any Page Design"
        }
        [void]$debug.Add("Scope: single template $cleanId")
    }
    else {
        $scopedTemplates = $tplToPd.Clone()
        [void]$debug.Add("Scope: all $($tplToPd.Count) mapped template(s)")
    }

    # Apply limit
    $maxTemplates = if (-not [string]::IsNullOrWhiteSpace($limitCount) -and $limitCount -ne "0") {
        [int]$limitCount
    } else {
        $scopedTemplates.Count
    }
    if ($maxTemplates -lt $scopedTemplates.Count) {
        $keys = @($scopedTemplates.Keys)
        $limitedKeys = $keys[0..($maxTemplates - 1)]
        $filtered = @{}
        foreach ($k in $limitedKeys) { $filtered[$k] = $scopedTemplates[$k] }
        $scopedTemplates = $filtered
        [void]$debug.Add("Limited to $maxTemplates template(s)")
    }

    # Get-StripPlan: Partitions a rendering set into STRIP and PRESERVE.
    # Direct matches: renderings whose signature exists in the PD rendering set.
    # Descendants: renderings whose placeholder path contains a stripped rendering's UID.
    # The descendant walk uses a fixpoint loop (iterates until no new stripUids found)
    # to handle arbitrary nesting depth. This is the same pattern used for both SV and page passes.
    function Get-StripPlan {
        param(
            [array]$Renderings,
            [System.Collections.Generic.HashSet[string]]$RenderingSet
        )

        $directMatches = @($Renderings | Where-Object {
            $sig = Get-RenderingSignature $_
            $sig -and $RenderingSet.Contains($sig)
        })
        $stripUids = New-UidSet
        foreach ($m in $directMatches) {
            if ($m.UniqueId) { [void]$stripUids.Add($m.UniqueId) }
        }

        # Descendant detection by placeholder UID chain
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($r in $Renderings) {
                if (-not $r.UniqueId) { continue }
                if ($stripUids.Contains($r.UniqueId)) { continue }
                if (-not $r.Placeholder) { continue }
                foreach ($uid in @($stripUids)) {
                    if (Test-UidReference $r.Placeholder $uid) {
                        [void]$stripUids.Add($r.UniqueId)
                        $changed = $true
                        break
                    }
                }
            }
        }

        $toStrip = @($Renderings | Where-Object { $_.UniqueId -and $stripUids.Contains($_.UniqueId) })
        $toPreserve = @($Renderings | Where-Object { -not $_.UniqueId -or -not $stripUids.Contains($_.UniqueId) })

        return [PSCustomObject]@{
            directMatches = $directMatches
            stripUids = $stripUids
            toStrip = $toStrip
            toPreserve = $toPreserve
        }
    }

    # Cross-pass SV strip data: populated during SV pass, consumed during page pass.
    # Contains: stripUids (which SV renderings were removed), uidToSig (UID→signature map),
    # and preservedDynPH (F141: UID→DynPHId for preserved orphans).
    # The page pass uses stripUids as "phantom parents" — page-level children that reference
    # SV-stripped UIDs in their placeholder paths are detected as orphans even though the
    # page itself didn't have those parent renderings in its __Renderings field.
    # Without this cross-pass data, those children would be invisible to the page pass
    # and would keep stale UID-based placeholder paths that no longer resolve.
    $svStripDataByTemplate = @{}

    # ── Step 4: Process each template SV ──
    foreach ($tplId in @($scopedTemplates.Keys)) {
        $designId = $scopedTemplates[$tplId]
        $renderingSet = $pdRenderingsByDesign[$designId]
        if (-not $renderingSet) {
            [void]$debug.Add("WARN: No PD rendering set for Page Design $designId — skipping template $tplId")
            [void]$results.Add([PSCustomObject]@{
                templateId          = $tplId
                templateName        = $null
                pageDesignId        = $designId
                pageDesignName      = $pdNameByDesign[$designId]
                status              = "skipped"
                reason              = "Page Design not found or has no rendering set"
                renderingsStripped  = 0
                renderingsPreserved = 0
            })
            continue
        }

        # ── Get template + Standard Values ──
        $tpl = Get-Item -Path "master:" -ID $tplId -ErrorAction SilentlyContinue
        if (-not $tpl) {
            [void]$debug.Add("WARN: Template $tplId not found — skipping")
            [void]$results.Add([PSCustomObject]@{
                templateId          = $tplId
                templateName        = $null
                pageDesignId        = $designId
                pageDesignName      = $pdNameByDesign[$designId]
                status              = "skipped"
                reason              = "template not found"
                renderingsStripped  = 0
                renderingsPreserved = 0
            })
            continue
        }

        $sv = Get-ChildItem -Path $tpl.Paths.FullPath | Where-Object { $_.Name -eq "__Standard Values" } | Select-Object -First 1
        if (-not $sv) {
            [void]$debug.Add("Template '$($tpl.Name)' has no __Standard Values — skipping")
            [void]$results.Add([PSCustomObject]@{
                templateId          = $tplId
                templateName        = $tpl.Name
                pageDesignId        = $designId
                pageDesignName      = $pdNameByDesign[$designId]
                status              = "skipped"
                reason              = "no Standard Values"
                renderingsStripped  = 0
                renderingsPreserved = 0
            })
            continue
        }

        # ── Two-pass candidate planning ──
        # Pass 1: shared layout renderings (Get-Rendering without -FinalLayout)
        # Pass 2: merged layout (Get-Rendering -FinalLayout) minus Pass 1 strips
        #
        # WHY TWO PASSES:
        # Remove-Rendering from shared layout (Pass 1) can create phantom <p:d /> entries
        # in __Final Renderings. Sitecore's layout delta mechanism records the removal as
        # a "patch" in the final field. Pass 2 cleans up these phantoms plus any
        # pre-existing final-only renderings that match PD signatures.
        #
        # Pass 1 plan: shared layout renderings on SV
        $sharedRenderings = @(Get-Rendering -Item $sv -ErrorAction SilentlyContinue)
        # Merged view needed to discover final-only SV renderings for pass 2 planning
        $mergedRenderings = @(Get-Rendering -Item $sv -FinalLayout -ErrorAction SilentlyContinue)

        [void]$debug.Add("Template '$($tpl.Name)': shared=$($sharedRenderings.Count), merged=$($mergedRenderings.Count) on __Standard Values")

        if ($sharedRenderings.Count -eq 0 -and $mergedRenderings.Count -eq 0) {
            [void]$results.Add([PSCustomObject]@{
                templateId          = $tplId
                templateName        = $tpl.Name
                pageDesignId        = $designId
                pageDesignName      = $pdNameByDesign[$designId]
                status              = "no-change"
                reason              = "no shared or final renderings on Standard Values"
                renderingsStripped  = 0
                renderingsPreserved = 0
            })
            continue
        }

        $pass1 = Get-StripPlan -Renderings $sharedRenderings -RenderingSet $renderingSet
        $toStripShared = @($pass1.toStrip)

        # Simulate post-pass1 state for dry-run planning of pass 2 final-only removals
        $remainingMerged = @($mergedRenderings | Where-Object { -not $_.UniqueId -or -not $pass1.stripUids.Contains($_.UniqueId) })
        $pass2 = Get-StripPlan -Renderings $remainingMerged -RenderingSet $renderingSet
        $toStripFinal = @($pass2.toStrip)

        # Merge strip details from both passes, de-duplicated by UniqueId
        $stripByUid = @{}
        foreach ($r in $toStripShared) {
            if ($r.UniqueId) {
                $sig = Get-RenderingSignature $r
                $stripByUid[$r.UniqueId] = [PSCustomObject]@{ rendering = $r; pass = "shared"; isDirect = ($sig -and $renderingSet.Contains($sig)) }
            }
        }
        foreach ($r in $toStripFinal) {
            if ($r.UniqueId -and -not $stripByUid.ContainsKey($r.UniqueId)) {
                $sig = Get-RenderingSignature $r
                $stripByUid[$r.UniqueId] = [PSCustomObject]@{ rendering = $r; pass = "final"; isDirect = ($sig -and $renderingSet.Contains($sig)) }
            }
        }
        $toStrip = @($stripByUid.Values)
        $toPreserve = @($remainingMerged | Where-Object { -not $_.UniqueId -or -not $pass2.stripUids.Contains($_.UniqueId) })

        # Save SV strip data for page-pass orphan detection (cross-pass UID context)
        $svStripData = @{
            stripUids = New-UidSet
            uidToSig = @{}
            preservedDynPH = @{}  # F141: uid → DynPHId for preserved orphans (consumed by page pass)
        }
        foreach ($uid in $stripByUid.Keys) {
            [void]$svStripData.stripUids.Add($uid)
            $sig = Get-RenderingSignature $stripByUid[$uid].rendering
            if ($sig) { $svStripData.uidToSig[$uid] = $sig }
        }
        $svStripDataByTemplate[$tplId] = $svStripData

        [void]$debug.Add("  → STRIP(shared): $($toStripShared.Count) ($($pass1.directMatches.Count) direct + $($toStripShared.Count - $($pass1.directMatches.Count)) sub-placeholder)")
        [void]$debug.Add("  → STRIP(final):  $($toStripFinal.Count) ($($pass2.directMatches.Count) direct + $($toStripFinal.Count - $($pass2.directMatches.Count)) sub-placeholder)")
        [void]$debug.Add("  → STRIP(total unique): $($toStrip.Count)")
        [void]$debug.Add("  → PRESERVE: $($toPreserve.Count)")

        # ── Execute or report ──
        $status = "no-change"
        if ($toStrip.Count -gt 0) {
            if ($isDryRun) {
                $status = "dry-run"
                [void]$debug.Add("  DRY-RUN: Would remove shared=$($toStripShared.Count), final-only=$($toStripFinal.Count), total=$($toStrip.Count) from '$($tpl.Name)' __Standard Values")
            } else {
                # Pass 1: shared renderings
                $uidsShared = @($toStripShared | Sort-Object { ($_.Placeholder -split '/').Count } -Descending | ForEach-Object { $_.UniqueId })
                $removedSharedCount = 0
                foreach ($uid in $uidsShared) {
                    $freshRenderings = @(Get-Rendering -Item $sv -ErrorAction SilentlyContinue)
                    $target = $freshRenderings | Where-Object { $_.UniqueId -eq $uid } | Select-Object -First 1
                    if ($target) {
                        Remove-Rendering -Item $sv -Instance $target
                        $removedSharedCount++
                    } else {
                        [void]$debug.Add("  WARN: Shared pass UniqueId $uid not found on re-read")
                    }
                }

                # Re-fetch SV before final pass
                $sv = Get-Item -Path "master:" -ID $sv.ID -ErrorAction SilentlyContinue

                # Pass 2: remaining final-only renderings
                $uidsFinal = @($toStripFinal | Sort-Object { ($_.Placeholder -split '/').Count } -Descending | ForEach-Object { $_.UniqueId })
                $removedFinalCount = 0
                foreach ($uid in $uidsFinal) {
                    $freshFinal = @(Get-Rendering -Item $sv -FinalLayout -ErrorAction SilentlyContinue)
                    $target = $freshFinal | Where-Object { $_.UniqueId -eq $uid } | Select-Object -First 1
                    if ($target) {
                        Remove-Rendering -Item $sv -Instance $target -FinalLayout
                        $removedFinalCount++
                    } else {
                        [void]$debug.Add("  WARN: Final pass UniqueId $uid not found on re-read")
                    }
                }

                $status = "executed"
                $totalTemplatesModified++
                [void]$debug.Add("  EXECUTED: Removed shared=$removedSharedCount/$($toStripShared.Count), final=$removedFinalCount/$($toStripFinal.Count) from '$($tpl.Name)' __Standard Values")
            }
        }

        # ── F141: SV Orphan Remap — rewrite placeholder paths on preserved SV renderings ──
        # After stripping PD-matched renderings, preserved renderings may reference stripped UIDs
        # in their placeholder paths. Example: A "Related Content" rendering preserved on the SV
        # was nested under a Navigation rendering that was stripped. Its placeholder was:
        #   /lockedtop/phContent-{STRIPPED_UID}-0
        # Post-strip, the UID no longer exists. Remap rewrites this to canonical SXA form:
        #   /lockedtop/pd-key/phContent-0-1
        # using the PD compose info (PD rendering UID → placeholder key + DynPHId).
        # The remapped renderings also get fresh DynamicPlaceholderIds assigned
        # to prevent collisions with PD-delivered renderings.
        # NOTE: Remap runs on BOTH shared AND final layouts to keep them consistent.
        $svOrphansRemappedThisTemplate = 0
        if ($toStrip.Count -gt 0 -and $toPreserve.Count -gt 0) {
            $svOrphans = [System.Collections.ArrayList]::new()
            $svOrphanUids = New-UidSet
            $changed = $true
            while ($changed) {
                $changed = $false
                foreach ($r in $toPreserve) {
                    if (-not $r.UniqueId -or $svOrphanUids.Contains($r.UniqueId)) { continue }
                    if (-not $r.Placeholder) { continue }
                    $isOrphan = $false
                    foreach ($uid in @($stripByUid.Keys)) {
                        if (Test-UidReference $r.Placeholder $uid) { $isOrphan = $true; break }
                    }
                    if (-not $isOrphan) {
                        foreach ($uid in @($svOrphanUids)) {
                            if (Test-UidReference $r.Placeholder $uid) { $isOrphan = $true; break }
                        }
                    }
                    if ($isOrphan) {
                        [void]$svOrphans.Add($r)
                        [void]$svOrphanUids.Add($r.UniqueId)
                        $changed = $true
                    }
                }
            }

            if ($svOrphans.Count -gt 0) {
                [void]$debug.Add("  SV ORPHAN REMAP: $($svOrphans.Count) preserved rendering(s) reference stripped UIDs on '$($tpl.Name)' SV")
                $sigToUidMap = $pdSigToUidByDesign[$designId]
                if ($sigToUidMap) {
                    $svStrippedUidToSig = @{}
                    foreach ($uid in $stripByUid.Keys) {
                        $sig = Get-RenderingSignature $stripByUid[$uid].rendering
                        if ($sig) { $svStrippedUidToSig[$uid] = $sig }
                    }

                    # Build PD compose info: PD UID → { placeholderKey, dynamicId }
                    $svComposeInfo = @{}
                    $designItemSv = Get-ItemByIdSafe $designId
                    if ($designItemSv) {
                        $pdFieldSv = $designItemSv.Fields["PartialDesigns"].Value
                        if ($pdFieldSv) {
                            $partialIdsSv = @($pdFieldSv.Split([char]"|") | Where-Object { $_ -ne "" })
                            $svDevice = Get-LayoutDevice -Default
                            foreach ($partIdSv in $partialIdsSv) {
                                $partItemSv = Get-ItemByIdSafe $partIdSv
                                if (-not $partItemSv) { continue }
                                $pdNameSv = $partItemSv.Name
                                $phSettingsPathSv = "master:$sitePath/Presentation/Placeholder Settings/Partial Design/$pdNameSv"
                                $phSettingsItemSv = Get-Item -Path $phSettingsPathSv -ErrorAction SilentlyContinue
                                if (-not $phSettingsItemSv) { continue }
                                $phKeySv = $phSettingsItemSv["Placeholder Key"]
                                if ([string]::IsNullOrWhiteSpace($phKeySv)) { continue }
                                $pdRenderingsSv = @(Get-Rendering -Item $partItemSv -Device $svDevice -ErrorAction SilentlyContinue)
                                foreach ($pdR in $pdRenderingsSv) {
                                    if (-not $pdR.UniqueId) { continue }
                                    $dynIdSv = "1"
                                    if ($pdR.Parameters -match 'DynamicPlaceholderId=(\d+)') { $dynIdSv = $Matches[1] }
                                    $svComposeInfo[$pdR.UniqueId] = @{ placeholderKey = $phKeySv; dynamicId = $dynIdSv }
                                }
                            }
                        }
                    }

                    $uidSegPatternSv = '^(.+)-(\{[A-Fa-f0-9-]+\})-(\d+)$'
                    $svMaxDynPH = 0
                    foreach ($ci in $svComposeInfo.Values) {
                        $v = [int]$ci.dynamicId
                        if ($v -gt $svMaxDynPH) { $svMaxDynPH = $v }
                    }
                    $svDynPhCounter = $svMaxDynPH

                    # Assign DynPHIds to all preserved SV orphans (pages may have children in their slots)
                    $svOrphanDynPH = @{}
                    foreach ($o in $svOrphans) {
                        $svDynPhCounter++
                        $svOrphanDynPH[$o.UniqueId] = $svDynPhCounter
                    }

                    # Build remap plan
                    $svOrphanRemapPlan = [System.Collections.ArrayList]::new()
                    foreach ($orphan in $svOrphans) {
                        $newPh = $orphan.Placeholder
                        $anyReplaced = $false
                        foreach ($oldUid in @($stripByUid.Keys)) {
                            if (Test-UidReference $newPh $oldUid) {
                                $parentSig = $svStrippedUidToSig[$oldUid]
                                if ($parentSig -and $sigToUidMap.ContainsKey($parentSig)) {
                                    $pdUid = $sigToUidMap[$parentSig]
                                    $newPh = $newPh.Replace($oldUid, $pdUid)
                                    $anyReplaced = $true
                                }
                            }
                        }
                        if ($anyReplaced) {
                            $phSegs = $newPh.Split("/")
                            $composedSegs = [System.Collections.ArrayList]::new()
                            $lastInjectedKey = $null
                            foreach ($seg in $phSegs) {
                                if (-not $seg) { [void]$composedSegs.Add(""); continue }
                                if ($seg -match $uidSegPatternSv) {
                                    $slotN = $Matches[1]; $uidM = $Matches[2]; $ordM = $Matches[3]
                                    if ($svComposeInfo.ContainsKey($uidM)) {
                                        $ci = $svComposeInfo[$uidM]
                                        if ($ci.placeholderKey -ne $lastInjectedKey) {
                                            [void]$composedSegs.Add("$($ci.placeholderKey)/$slotN-$ordM-$($ci.dynamicId)")
                                            $lastInjectedKey = $ci.placeholderKey
                                        } else {
                                            [void]$composedSegs.Add("$slotN-$ordM-$($ci.dynamicId)")
                                        }
                                    } else {
                                        [void]$composedSegs.Add($seg)
                                    }
                                } else {
                                    [void]$composedSegs.Add($seg)
                                }
                            }
                            $finalPh = $composedSegs -join "/"
                            $freshDynPH = $svOrphanDynPH[$orphan.UniqueId]
                            [void]$svOrphanRemapPlan.Add(@{ uid = $orphan.UniqueId; finalPh = $finalPh; freshDynPHId = $freshDynPH })
                        } else {
                            [void]$debug.Add("  WARN: Could not plan SV remap for orphan $($orphan.UniqueId) on '$($tpl.Name)'")
                        }
                    }

                    if ($svOrphanRemapPlan.Count -gt 0) {
                        if ($isDryRun) {
                            $svOrphansRemappedThisTemplate = $svOrphanRemapPlan.Count
                            [void]$debug.Add("  SV ORPHAN DRY-RUN: $($svOrphanRemapPlan.Count) rendering(s) would be remapped on '$($tpl.Name)' SV")
                        } else {
                            $sv = Get-Item -Path "master:" -ID $sv.ID -ErrorAction SilentlyContinue
                            foreach ($plan in $svOrphanRemapPlan) {
                                [void]$debug.Add("  SV REMAP $($plan.uid): → '$($plan.finalPh)' DynPH=$($plan.freshDynPHId)")
                                $freshRenderings = @(Get-Rendering -Item $sv -ErrorAction SilentlyContinue)
                                $target = $freshRenderings | Where-Object { $_.UniqueId -eq $plan.uid } | Select-Object -First 1
                                if ($target) {
                                    $target.Placeholder = $plan.finalPh
                                    if ($plan.freshDynPHId) {
                                        $rawP = if ($target.Parameters) { $target.Parameters.TrimStart('?') } else { "" }
                                        $cleanP = ($rawP -split '&' | Where-Object { $_ -and $_ -notmatch '^DynamicPlaceholderId=' }) -join '&'
                                        $target.Parameters = if ($cleanP) { "$cleanP&DynamicPlaceholderId=$($plan.freshDynPHId)" } else { "DynamicPlaceholderId=$($plan.freshDynPHId)" }
                                    }
                                    Set-Rendering -Item $sv -Instance $target
                                }
                                # Also remap on final layout if present
                                $svDeviceRm = Get-LayoutDevice -Default
                                $freshFr = @(Get-Rendering -Item $sv -FinalLayout -Device $svDeviceRm -ErrorAction SilentlyContinue)
                                $targetFr = $freshFr | Where-Object { $_.UniqueId -eq $plan.uid } | Select-Object -First 1
                                if ($targetFr -and $targetFr.Placeholder -ne $plan.finalPh) {
                                    $targetFr.Placeholder = $plan.finalPh
                                    if ($plan.freshDynPHId) {
                                        $rawP = if ($targetFr.Parameters) { $targetFr.Parameters.TrimStart('?') } else { "" }
                                        $cleanP = ($rawP -split '&' | Where-Object { $_ -and $_ -notmatch '^DynamicPlaceholderId=' }) -join '&'
                                        $targetFr.Parameters = if ($cleanP) { "$cleanP&DynamicPlaceholderId=$($plan.freshDynPHId)" } else { "DynamicPlaceholderId=$($plan.freshDynPHId)" }
                                    }
                                    Set-Rendering -Item $sv -Instance $targetFr -FinalLayout
                                }
                            }
                            $svOrphansRemappedThisTemplate = $svOrphanRemapPlan.Count
                            [void]$debug.Add("  SV ORPHAN EXECUTED: $($svOrphanRemapPlan.Count) rendering(s) remapped on '$($tpl.Name)' SV")
                        }
                    }

                    # Store preserved DynPH data for page pass consumption
                    $svStripData.preservedDynPH = $svOrphanDynPH
                } else {
                    [void]$debug.Add("  WARN: No PD sig-to-UID map for design $designId — $($svOrphans.Count) SV orphan(s) not remapped")
                }
            }
        }
        $totalSvOrphansRemapped += $svOrphansRemappedThisTemplate

        $totalStripped += $toStrip.Count
        $totalPreserved += $toPreserve.Count

        [void]$results.Add([PSCustomObject]@{
            templateId            = $tplId
            templateName          = $tpl.Name
            pageDesignId          = $designId
            pageDesignName        = $pdNameByDesign[$designId]
            status                = $status
            renderingsStripped    = $toStrip.Count
            renderingsPreserved   = $toPreserve.Count
            svOrphansRemapped     = $svOrphansRemappedThisTemplate
        })
    }
    } # end if: SV scope

    # ── Step 5: Page-level processing (scope = pages or both) ──
    $pageStatusCounts = @{}
    $pageActionCounts = @{}
    $totalPagesProcessed = 0
    $totalPagesReset = 0
    $totalPagesStripped = 0
    $totalPageRenderingsStripped = 0
    $totalPageRenderingsPreserved = 0
    $totalDryRunInheritedSvRenderings = 0
    # FR rewrite counters (W76)
    $totalFrCandidatesEvaluated = 0
    $totalFrRewritesApplied = 0
    $totalFrNoopsCanonical = 0
    $totalFrSkipped = 0
    $totalOrphanChildrenRemapped = 0

    if ($effectiveScope -ne "sv") {
    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $renderingsFieldId = [Sitecore.FieldIDs]::LayoutField
    $presentationPath = "$sitePath/Presentation"
    $device = Get-LayoutDevice -Default
    # Cache: Partial Design name → Placeholder Key (avoids repeated Get-Item calls)
    $placeholderKeyCache = @{}
    # Cache: template ID → Page Design item (avoids repeated Get-DesignItem per page)
    $designItemCache = @{}
    # Cache: Partial Design ID → renderings array (avoids repeated Get-Rendering per PD)
    $pdRenderingsCache = @{}
    # Cache: designIdStr → @{ pdUid → @{ placeholderKey; dynamicId } } (orphan final-layout composition)
    $pdUidComposeInfoByDesign = @{}

    # ── W76: FR placeholder resolver ──
    # Resolves a legacy-UID or normalized placeholder to its canonical PD-composed form.
    # Based on proven prototype: docs/conversion/w77/w77-dynamic-placeholder-candidate.ps1
    function Resolve-FrPlaceholder {
        param(
            [Parameter(Mandatory)]$Rendering,
            [Parameter(Mandatory)]$PageDesignItem,
            [string]$SitePath,
            $Device,
            [hashtable]$Cache,
            $StripUids = $null
        )

        $ph = $Rendering.Placeholder
        $result = [PSCustomObject]@{
            childUid = $Rendering.UniqueId
            currentPlaceholder = $ph
            candidatePlaceholder = $null
            decision = "skip"
            reasonCode = $null
            resolverStage = $null
            rootToken = $null
            slotToken = $null
            ordinal = $null
            resolvedPlaceholderKey = $null
            resolvedDynamicPlaceholderId = $null
            resolvedPartialDesign = $null
            pageDesignId = $PageDesignItem.ID.ToString()
        }

        # ── Parse placeholder form ──
        $rootToken = $null; $slotToken = $null; $ordinal = $null; $parentUid = $null
        if ($ph -match '^/([^/]+)/([A-Za-z0-9_-]+)-(\{[A-Fa-f0-9-]+\})-(\d+)$') {
            # Form A (legacy-orphan): /root/slot-{GUID}-ordinal
            $rootToken = $Matches[1]; $slotToken = $Matches[2]; $parentUid = $Matches[3]; $ordinal = $Matches[4]
            $result.resolverStage = "stage1"
        }
        elseif ($ph -match '^/([^/]+)/([^/]+)/([A-Za-z0-9_-]+)-(\d+)-(\d+)$') {
            # Form B (normalized): /root/key/slot-ordinal-dynamic
            $rootToken = $Matches[1]; $slotToken = $Matches[3]; $ordinal = $Matches[4]
            $result.resolverStage = "stage1"
        }
        else {
            $result.reasonCode = "unsupported_placeholder_format"
            return $result
        }
        $result.rootToken = $rootToken
        $result.slotToken = $slotToken
        $result.ordinal = $ordinal

        # ── Guard: skip if parent UID belongs to a preserved (not stripped) rendering ──
        # CRITICAL: If the parent rendering was NOT stripped (still lives on SV/page), the
        # UID-based placeholder path is still valid — the rendering engine resolves it via
        # the parent's UniqueId. Rewriting it to the composed form would BREAK resolution
        # because there's no PD composition in play for preserved renderings.
        # This was the key insight from W77/W82 validation: only orphaned children
        # (whose parent was stripped) need placeholder rewriting.
        if ($parentUid -and $StripUids -and -not $StripUids.Contains($parentUid)) {
            $result.decision = "skip"
            $result.reasonCode = "parent_preserved"
            return $result
        }

        # ── Resolve matching Partial Design for root token ──
        $pdField = $PageDesignItem.Fields["PartialDesigns"].Value
        if (-not $pdField) {
            $result.reasonCode = "page_design_no_partials"
            return $result
        }
        $partialIds = @($pdField.Split([char]"|") | Where-Object { $_ -ne "" })

        $matchedPartial = $null
        $dynamicId = $null
        foreach ($partId in $partialIds) {
            $partialItem = Get-ItemByIdSafe $partId
            if (-not $partialItem) { continue }

            # Cache PD renderings to avoid repeated Get-Rendering per Partial Design
            $pdCacheKey = $partialItem.ID.ToString()
            if (-not $script:pdRenderingsCache.ContainsKey($pdCacheKey)) {
                $script:pdRenderingsCache[$pdCacheKey] = @(Get-Rendering -Item $partialItem -Device $Device -ErrorAction SilentlyContinue)
            }
            $pdRenderings = $script:pdRenderingsCache[$pdCacheKey]

            $rootRendering = $pdRenderings |
                Where-Object { $_.Placeholder -eq $rootToken } |
                Select-Object -First 1

            if ($rootRendering) {
                $matchedPartial = $partialItem
                if ($rootRendering.Parameters -match 'DynamicPlaceholderId=(\d+)') {
                    $dynamicId = $Matches[1]
                }
                if (-not $dynamicId) { $dynamicId = "1" }
                break
            }
        }

        if (-not $matchedPartial) {
            $result.reasonCode = "partial_root_unresolved"
            return $result
        }
        $result.resolvedPartialDesign = $matchedPartial.Name
        $result.resolvedDynamicPlaceholderId = $dynamicId

        # ── Resolve Placeholder Key (cached) ──
        $cacheKey = $matchedPartial.Name
        if ($Cache.ContainsKey($cacheKey)) {
            $resolvedKey = $Cache[$cacheKey]
        } else {
            $phSettingsPath = "master:$SitePath/Presentation/Placeholder Settings/Partial Design/$($matchedPartial.Name)"
            $phSettingsItem = Get-Item -Path $phSettingsPath -ErrorAction SilentlyContinue
            if (-not $phSettingsItem) {
                $result.reasonCode = "placeholder_settings_not_found"
                return $result
            }
            $resolvedKey = $phSettingsItem["Placeholder Key"]
            if ([string]::IsNullOrWhiteSpace($resolvedKey)) {
                $result.reasonCode = "placeholder_key_empty"
                return $result
            }
            $Cache[$cacheKey] = $resolvedKey
        }
        $result.resolvedPlaceholderKey = $resolvedKey

        # ── Build canonical placeholder ──
        $canonical = "/$rootToken/$resolvedKey/$slotToken-$ordinal-$dynamicId"
        $result.candidatePlaceholder = $canonical

        if ($ph -eq $canonical) {
            $result.decision = "noop-canonical"
            $result.reasonCode = "candidate_same_as_current"
        } else {
            $result.decision = "rewrite"
        }
        return $result
    }

    # Determine page candidates based on pagePath/templateId filters
    $pageCandidates = @()
    if (-not [string]::IsNullOrWhiteSpace($pagePath)) {
        # Single page mode
        $fullPath = if ($pagePath.StartsWith("/sitecore")) { $pagePath } else { "$sitePath$pagePath" }
        $singlePage = Get-Item -Path "master:$fullPath" -ErrorAction SilentlyContinue
        if (-not $singlePage) { throw "Page not found at $fullPath" }
        $pageCandidates = @($singlePage)
        [void]$debug.Add("Page scope: single page '$fullPath'")
    }
    elseif (-not [string]::IsNullOrWhiteSpace($templateId)) {
        # All pages of a specific template
        $cleanId = $templateId.Trim()
        if (-not $cleanId.StartsWith("{")) { $cleanId = "{$cleanId}" }
        $pageCandidates = @(Get-ChildItem -Path "master:$sitePath" -Recurse | Where-Object { $_.TemplateID.ToString().ToUpper() -eq $cleanId.ToUpper() })
        [void]$debug.Add("Page scope: pages of template $cleanId ($($pageCandidates.Count) found)")
    }
    else {
        # All items under site
        $pageCandidates = @(Get-ChildItem -Path "master:$sitePath" -Recurse)
        [void]$debug.Add("Page scope: all items under site ($($pageCandidates.Count) total)")
    }

    foreach ($page in $pageCandidates) {
        # Skip presentation items (Partial Designs, Page Designs, etc.)
        if ($page.Paths.FullPath.StartsWith($presentationPath)) { continue }

        $rawItem = $db.GetItem($page.ID)
        if (-not $rawItem) { continue }

        $sharedField = $rawItem.Fields[$renderingsFieldId]
        if (-not $sharedField -or $sharedField.ContainsStandardValue -or -not $sharedField.HasValue) { continue }
        $val = $sharedField.Value
        if (-not $val -or $val.Length -le 10) { continue }

        $totalPagesProcessed++

        # Resolve effective Page Design using SXA built-in (respects TemplatesMapping + page-level overrides)
        $designItem = Get-DesignItem $page
        if (-not $designItem) {
            $pageStatusCounts["skipped"] = [int]$pageStatusCounts["skipped"] + 1
            continue
        }

        $designIdStr = $designItem.ID.ToString()

        # Get or build PD rendering set (reuses Step 2 cache when available)
        if (-not $pdRenderingsByDesign.ContainsKey($designIdStr)) {
            $pdField = $designItem.Fields["PartialDesigns"].Value
            if (-not $pdField) {
                $pdRenderingsByDesign[$designIdStr] = [System.Collections.Generic.HashSet[string]]::new()
                $pdSigToUidByDesign[$designIdStr] = @{}
            } else {
                $partialIds = $pdField.Split([char]"|") | Where-Object { $_ -ne "" }
                $newSet = [System.Collections.Generic.HashSet[string]]::new()
                $newSigToUid = @{}
                foreach ($partId in $partialIds) {
                    $partialItem = Get-ItemByIdSafe $partId
                    if (-not $partialItem) { continue }
                    $pRenderings = @(Get-Rendering -Item $partialItem -ErrorAction SilentlyContinue)
                    foreach ($r in $pRenderings) {
                        $sig = Get-RenderingSignature $r
                        if ($sig) {
                            [void]$newSet.Add($sig)
                            if ($r.UniqueId) { $newSigToUid[$sig] = $r.UniqueId }
                        }
                    }
                }
                $pdRenderingsByDesign[$designIdStr] = $newSet
                $pdSigToUidByDesign[$designIdStr] = $newSigToUid
            }
            [void]$debug.Add("  Built PD rendering set for '$($designItem.Name)': $($pdRenderingsByDesign[$designIdStr].Count) signatures")
        }

        $renderingSet = $pdRenderingsByDesign[$designIdStr]
        if (-not $renderingSet -or $renderingSet.Count -eq 0) {
            $pageStatusCounts["skipped"] = [int]$pageStatusCounts["skipped"] + 1
            continue
        }

        # Get page renderings
        $pageRenderings = @(Get-Rendering -Item $page -ErrorAction SilentlyContinue)
        if ($pageRenderings.Count -eq 0) { continue }

        # Cross-pass: merge SV-stripped UIDs as phantom parents for orphan detection.
        # A dry-run has not actually removed those SV renderings yet, so Get-Rendering
        # still returns them in the page's merged layout. Suppress only inherited
        # copies while planning and retain a same-UID rendering if it appears in the
        # page's raw layout field. This keeps the page forecast in execute order.
        $svData = $svStripDataByTemplate[$page.TemplateID.ToString().ToUpper()]
        if (-not $svData) { $svData = $svStripDataByTemplate[$page.TemplateID.ToString()] }
        $pageRenderingsForPlan = $pageRenderings
        if ($isDryRun -and $svData -and $svData.stripUids.Count -gt 0) {
            $rawPageLayout = [string]$sharedField.Value
            $suppressed = @($pageRenderings | Where-Object {
                $_.UniqueId -and $svData.stripUids.Contains($_.UniqueId) -and
                -not (Test-LayoutXmlUid $rawPageLayout $_.UniqueId)
            })
            if ($suppressed.Count -gt 0) {
                $totalDryRunInheritedSvRenderings += $suppressed.Count
                $pageRenderingsForPlan = @($pageRenderings | Where-Object {
                    -not $_.UniqueId -or -not $svData.stripUids.Contains($_.UniqueId) -or
                    (Test-LayoutXmlUid $rawPageLayout $_.UniqueId)
                })
                [void]$debug.Add("  Page '$($page.Name)': dry-run suppressed $($suppressed.Count) inherited SV rendering(s) before page planning")
            }
        }

        # SURGICAL partition: direct signature matches.
        $directMatches = @($pageRenderingsForPlan | Where-Object {
            $sig = Get-RenderingSignature $_
            $sig -and $renderingSet.Contains($sig)
        })
        $stripUids = New-UidSet
        foreach ($m in $directMatches) {
            if ($m.UniqueId) { [void]$stripUids.Add($m.UniqueId) }
        }

        # These UIDs were stripped from the SV but page-level children still reference them.
        $phantomUids = New-UidSet
        if ($svData) {
            foreach ($uid in $svData.stripUids) {
                if (-not $stripUids.Contains($uid)) {
                    [void]$phantomUids.Add($uid)
                }
            }
        }

        # Find sub-placeholder descendants (arbitrary nesting depth)
        # Only strip descendants whose signature is also in the PD set.
        # Page-specific children (signature NOT in PD set) are preserved and remapped.
        # Check against both page $stripUids AND SV $phantomUids for cross-pass orphan detection.
        $orphanChildren = [System.Collections.ArrayList]::new()
        $orphanChildrenUids = New-UidSet
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($r in $pageRenderingsForPlan) {
                if (-not $r.UniqueId -or $stripUids.Contains($r.UniqueId)) { continue }
                if ($orphanChildrenUids.Contains($r.UniqueId)) { continue }
                if (-not $r.Placeholder) { continue }
                $isDescendant = $false
                # Check against page-level $stripUids
                foreach ($uid in @($stripUids)) {
                    if (Test-UidReference $r.Placeholder $uid) {
                        $isDescendant = $true
                        break
                    }
                }
                # Also check against SV-stripped phantom UIDs (cross-pass)
                if (-not $isDescendant) {
                    foreach ($uid in @($phantomUids)) {
                        if (Test-UidReference $r.Placeholder $uid) {
                            $isDescendant = $true
                            break
                        }
                    }
                }
                # Also check against already-detected orphan children (multi-level nesting)
                if (-not $isDescendant) {
                    foreach ($uid in @($orphanChildrenUids)) {
                        if (Test-UidReference $r.Placeholder $uid) {
                            $isDescendant = $true
                            break
                        }
                    }
                }
                if ($isDescendant) {
                    $childSig = Get-RenderingSignature $r
                    if ($childSig -and $renderingSet.Contains($childSig)) {
                        # Descendant is also PD-covered → strip it
                        [void]$stripUids.Add($r.UniqueId)
                        $changed = $true
                    } else {
                        # Page-specific child of PD-covered parent → preserve + remap
                        [void]$orphanChildren.Add($r)
                        [void]$orphanChildrenUids.Add($r.UniqueId)
                    }
                }
            }
        }

        $toStrip = @($pageRenderingsForPlan | Where-Object { $_.UniqueId -and $stripUids.Contains($_.UniqueId) })
        $toPreserve = @($pageRenderingsForPlan | Where-Object { -not $_.UniqueId -or -not $stripUids.Contains($_.UniqueId) })

        if ($orphanChildren.Count -gt 0) {
            [void]$debug.Add("  Page '$($page.Name)': $($orphanChildren.Count) orphan children detected (phantomUids=$($phantomUids.Count), pageStripUids=$($stripUids.Count))")
        }

        if ($toStrip.Count -eq 0 -and $orphanChildren.Count -eq 0) {
            $pageStatusCounts["no-change"] = [int]$pageStatusCounts["no-change"] + 1
            continue
        }

        # ── Build orphan remap plan (data prep before strip removes parent renderings) ──
        $orphanRemapPlan = [System.Collections.ArrayList]::new()
        if ($orphanChildren.Count -gt 0) {
            $sigToUidMap = $pdSigToUidByDesign[$designIdStr]
            if ($sigToUidMap) {
                $strippedUidToSig = @{}
                foreach ($r in $pageRenderingsForPlan) {
                    if ($r.UniqueId -and $stripUids.Contains($r.UniqueId)) {
                        $sig = Get-RenderingSignature $r
                        if ($sig) { $strippedUidToSig[$r.UniqueId] = $sig }
                    }
                }
                # Cross-pass: merge SV-stripped UID→sig mappings for orphan remap
                if ($svData -and $svData.uidToSig) {
                    foreach ($uid in $svData.uidToSig.Keys) {
                        if (-not $strippedUidToSig.ContainsKey($uid)) {
                            $strippedUidToSig[$uid] = $svData.uidToSig[$uid]
                        }
                    }
                }
                # Build compose info map for this design (lazy, cached) — maps PD rendering UID → { placeholderKey, dynamicId }
                if (-not $pdUidComposeInfoByDesign.ContainsKey($designIdStr)) {
                    $composeMap = @{}
                    $pdFieldC = $designItem.Fields["PartialDesigns"].Value
                    if ($pdFieldC) {
                        $partialIdsC = @($pdFieldC.Split([char]"|") | Where-Object { $_ -ne "" })
                        foreach ($partIdC in $partialIdsC) {
                            $partItemC = Get-ItemByIdSafe $partIdC
                            if (-not $partItemC) { continue }
                            $pdNameC = $partItemC.Name
                            if ($placeholderKeyCache.ContainsKey($pdNameC)) {
                                $phKeyC = $placeholderKeyCache[$pdNameC]
                            } else {
                                $phSettingsPathC = "master:$sitePath/Presentation/Placeholder Settings/Partial Design/$pdNameC"
                                $phSettingsItemC = Get-Item -Path $phSettingsPathC -ErrorAction SilentlyContinue
                                if ($phSettingsItemC) {
                                    $phKeyC = $phSettingsItemC["Placeholder Key"]
                                    $placeholderKeyCache[$pdNameC] = $phKeyC
                                } else { $phKeyC = $null }
                            }
                            if (-not $phKeyC) { continue }
                            $pdCacheKeyC = $partItemC.ID.ToString()
                            if (-not $pdRenderingsCache.ContainsKey($pdCacheKeyC)) {
                                $pdRenderingsCache[$pdCacheKeyC] = @(Get-Rendering -Item $partItemC -Device $device -ErrorAction SilentlyContinue)
                            }
                            foreach ($pdRC in $pdRenderingsCache[$pdCacheKeyC]) {
                                if (-not $pdRC.UniqueId) { continue }
                                $dynIdC = "1"
                                if ($pdRC.Parameters -match 'DynamicPlaceholderId=(\d+)') { $dynIdC = $Matches[1] }
                                $composeMap[$pdRC.UniqueId] = @{ placeholderKey = $phKeyC; dynamicId = $dynIdC }
                            }
                        }
                    }
                    $pdUidComposeInfoByDesign[$designIdStr] = $composeMap
                }
                $composeInfo = $pdUidComposeInfoByDesign[$designIdStr]

                # F141: Merge preserved SV rendering DynPHIds into compose info
                # Enables compose to resolve SV UIDs (not just PD UIDs) in placeholder paths
                $tplKeyForSv = $page.TemplateID.ToString()
                if ($svStripDataByTemplate.ContainsKey($tplKeyForSv)) {
                    $svDataForCompose = $svStripDataByTemplate[$tplKeyForSv]
                    if ($svDataForCompose.preservedDynPH) {
                        foreach ($svUid in $svDataForCompose.preservedDynPH.Keys) {
                            if (-not $composeInfo.ContainsKey($svUid)) {
                                $composeInfo[$svUid] = @{ placeholderKey = $null; dynamicId = $svDataForCompose.preservedDynPH[$svUid].ToString() }
                            }
                        }
                    }
                }

                $uidSegPattern = '^(.+)-(\{[A-Fa-f0-9-]+\})-(\d+)$'

                # Pre-compute max existing DynPHId (page renderings + PD renderings)
                $maxDynPH = 0
                foreach ($r in $pageRenderings) {
                    if ($r.Parameters -match 'DynamicPlaceholderId=(\d+)') {
                        if ([int]$Matches[1] -gt $maxDynPH) { $maxDynPH = [int]$Matches[1] }
                    }
                }
                foreach ($ci in $composeInfo.Values) {
                    $v = [int]$ci.dynamicId
                    if ($v -gt $maxDynPH) { $maxDynPH = $v }
                }
                $dynPhCounter = $maxDynPH

                # Assign fresh DynPHIds to parent orphans (orphans whose UID appears in another orphan's path)
                $orphanFreshDynPH = @{}       # orphanUid → freshId
                $pdUidToFreshDynPH = @{}      # pdUidAfterSwap → freshId (for compose path building)

                foreach ($o in $orphanChildren) {
                    $oUid = $o.UniqueId
                    $isParent = $orphanChildren | Where-Object { $_.UniqueId -ne $oUid -and (Test-UidReference $_.Placeholder $oUid) }
                    if ($isParent) {
                        $dynPhCounter++
                        $orphanFreshDynPH[$oUid] = $dynPhCounter
                        $svSig = $strippedUidToSig[$oUid]
                        if ($svSig -and $sigToUidMap.ContainsKey($svSig)) {
                            $pdUidToFreshDynPH[$sigToUidMap[$svSig]] = $dynPhCounter
                        }
                    }
                }

                foreach ($orphan in $orphanChildren) {
                    $newPh = $orphan.Placeholder
                    $anyReplaced = $false
                    # Check both page-stripped UIDs and SV phantom UIDs
                    $allRemapUids = [System.Collections.ArrayList]::new()
                    foreach ($uid in @($stripUids)) { [void]$allRemapUids.Add($uid) }
                    foreach ($uid in @($phantomUids)) { [void]$allRemapUids.Add($uid) }
                    foreach ($oldUid in $allRemapUids) {
                        if (Test-UidReference $newPh $oldUid) {
                            $parentSig = $strippedUidToSig[$oldUid]
                            if ($parentSig -and $sigToUidMap.ContainsKey($parentSig)) {
                                $pdUid = $sigToUidMap[$parentSig]
                                $newPh = $newPh.Replace($oldUid, $pdUid)
                                $anyReplaced = $true
                            }
                        }
                    }
                    if ($anyReplaced) {
                        # Compose finalPh: resolve PD-UID segments to placeholderKey/slot-ord-dynId form
                        # Track last injected PD key — only inject once per PD context (not per segment)
                        $phSegs = $newPh.Split("/")
                        $composedSegs = [System.Collections.ArrayList]::new()
                        $lastInjectedKey = $null
                        foreach ($seg in $phSegs) {
                            if (-not $seg) { [void]$composedSegs.Add(""); continue }
                            if ($seg -match $uidSegPattern) {
                                $slotN = $Matches[1]; $uidM = $Matches[2]; $ordM = $Matches[3]
                                if ($composeInfo.ContainsKey($uidM)) {
                                    $ci = $composeInfo[$uidM]
                                    $effectiveDynId = if ($pdUidToFreshDynPH.ContainsKey($uidM)) { $pdUidToFreshDynPH[$uidM] } else { $ci.dynamicId }
                                    if (-not $ci.placeholderKey) {
                                        # F141: Preserved SV rendering — no PD key prefix, just slot-ord-dynId
                                        [void]$composedSegs.Add("$slotN-$ordM-$effectiveDynId")
                                    } elseif ($ci.placeholderKey -ne $lastInjectedKey) {
                                        # New PD context → inject placeholder key prefix
                                        [void]$composedSegs.Add("$($ci.placeholderKey)/$slotN-$ordM-$effectiveDynId")
                                        $lastInjectedKey = $ci.placeholderKey
                                    } else {
                                        # Same PD context → already inside wrapper, slot only
                                        [void]$composedSegs.Add("$slotN-$ordM-$effectiveDynId")
                                    }
                                } else {
                                    [void]$composedSegs.Add($seg)
                                }
                            } else {
                                [void]$composedSegs.Add($seg)
                            }
                        }
                        $finalPh = $composedSegs -join "/"
                        $freshDynPH = if ($orphanFreshDynPH.ContainsKey($orphan.UniqueId)) { $orphanFreshDynPH[$orphan.UniqueId] } else { $null }
                        [void]$orphanRemapPlan.Add(@{ uid = $orphan.UniqueId; newPh = $newPh; finalPh = $finalPh; freshDynPHId = $freshDynPH })
                    } else {
                        [void]$debug.Add("  WARN: Could not plan remap for orphan $($orphan.UniqueId) in '$($page.Name)'")
                    }
                }
            } else {
                [void]$debug.Add("  WARN: No PD sig-to-UID map for design $designIdStr — $($orphanChildren.Count) orphan(s) not remapped")
            }
        }

        if ($toStrip.Count -eq 0 -and $orphanRemapPlan.Count -eq 0) {
            $pageStatusCounts["no-change"] = [int]$pageStatusCounts["no-change"] + 1
            continue
        }

        # Determine action: reset (all match PD) vs surgical (mixed)
        $action = if ($toPreserve.Count -eq 0) { "reset" } else { "surgical" }
        $status = "no-change"

        if ($isDryRun) {
            $status = "dry-run-$action"
            [void]$debug.Add("  Page '$($page.Name)': $action — STRIP $($toStrip.Count), PRESERVE $($toPreserve.Count)")
        } else {
            if ($action -eq "reset") {
                # All renderings match PD — reset field to standard value (inherit from SV → PD)
                $rawItem.Editing.BeginEdit()
                $rawItem.Fields[$renderingsFieldId].Reset()
                $rawItem.Editing.EndEdit()
                $status = "executed-reset"
                $totalPagesReset++
            } else {
                # Surgical removal — F45-safe: re-read after each removal, deepest-first
                $uidsToStrip = @($toStrip | Sort-Object { ($_.Placeholder -split '/').Count } -Descending | ForEach-Object { $_.UniqueId })
                $removedCount = 0
                foreach ($uid in $uidsToStrip) {
                    $freshRenderings = @(Get-Rendering -Item $page -ErrorAction SilentlyContinue)
                    $target = $freshRenderings | Where-Object { $_.UniqueId -eq $uid } | Select-Object -First 1
                    if ($target) {
                        Remove-Rendering -Item $page -Instance $target
                        $removedCount++
                    } else {
                        [void]$debug.Add("  WARN: UniqueId $uid not found on re-read for '$($page.Name)'")
                    }
                }
                $status = "executed-surgical"
                $totalPagesStripped++
            }
        }

        # ── Execute orphan remap AFTER strip pass (prevents strip from overwriting) ──
        # Writes composed SXA placeholder path to BOTH shared + final layouts.
        # Shared needs composed path because UID-based paths reference PD rendering UIDs
        # that only resolve through PD composition — UID form no longer works post-strip.
        if ($orphanRemapPlan.Count -gt 0) {
            if (-not $isDryRun) {
                foreach ($plan in $orphanRemapPlan) {
                    [void]$debug.Add("  REMAP orphan $($plan.uid): finalPh='$($plan.finalPh)' freshDynPHId='$($plan.freshDynPHId)'")
                    # Remap on shared layout — write composed SXA path + inject DynPHId for parent orphans.
                    $freshRenderings = @(Get-Rendering -Item $page -ErrorAction SilentlyContinue)
                    $target = $freshRenderings | Where-Object { $_.UniqueId -eq $plan.uid } | Select-Object -First 1
                    if ($target) {
                        $oldPh = $target.Placeholder
                        [void]$debug.Add("    shared BEFORE: '$oldPh'")
                        $target.Placeholder = $plan.finalPh
                        if ($plan.freshDynPHId) {
                            $rawP = if ($target.Parameters) { $target.Parameters.TrimStart('?') } else { "" }
                            $cleanP = ($rawP -split '&' | Where-Object { $_ -and $_ -notmatch '^DynamicPlaceholderId=' }) -join '&'
                            $target.Parameters = if ($cleanP) { "$cleanP&DynamicPlaceholderId=$($plan.freshDynPHId)" } else { "DynamicPlaceholderId=$($plan.freshDynPHId)" }
                        }
                        Set-Rendering -Item $page -Instance $target
                        # Post-write verify
                        $verifyShared = @(Get-Rendering -Item $page -ErrorAction SilentlyContinue)
                        $verifyTarget = $verifyShared | Where-Object { $_.UniqueId -eq $plan.uid } | Select-Object -First 1
                        [void]$debug.Add("    shared AFTER:  '$($verifyTarget.Placeholder)'")
                        [void]$debug.Add("    shared WROTE:  $($verifyTarget.Placeholder -eq $plan.finalPh)")
                        $totalOrphanChildrenRemapped++
                    } else {
                        [void]$debug.Add("  WARN: Orphan $($plan.uid) not found on post-strip shared read for '$($page.Name)'")
                    }
                    # Remap on final layout — composed path + DynPHId injection
                    $freshFr = @(Get-Rendering -Item $page -FinalLayout -Device $device -ErrorAction SilentlyContinue)
                    $targetFr = $freshFr | Where-Object { $_.UniqueId -eq $plan.uid } | Select-Object -First 1
                    if ($targetFr) {
                        $oldFrPh = $targetFr.Placeholder
                        [void]$debug.Add("    final BEFORE:  '$oldFrPh'")
                        $targetFr.Placeholder = $plan.finalPh
                        if ($plan.freshDynPHId) {
                            $rawP = if ($targetFr.Parameters) { $targetFr.Parameters.TrimStart('?') } else { "" }
                            $cleanP = ($rawP -split '&' | Where-Object { $_ -and $_ -notmatch '^DynamicPlaceholderId=' }) -join '&'
                            $targetFr.Parameters = if ($cleanP) { "$cleanP&DynamicPlaceholderId=$($plan.freshDynPHId)" } else { "DynamicPlaceholderId=$($plan.freshDynPHId)" }
                        }
                        Set-Rendering -Item $page -Instance $targetFr -FinalLayout
                        # Post-write verify final
                        $verifyFr = @(Get-Rendering -Item $page -FinalLayout -Device $device -ErrorAction SilentlyContinue)
                        $verifyFrTarget = $verifyFr | Where-Object { $_.UniqueId -eq $plan.uid } | Select-Object -First 1
                        [void]$debug.Add("    final AFTER:   '$($verifyFrTarget.Placeholder)'")
                        [void]$debug.Add("    final WROTE:   $($verifyFrTarget.Placeholder -eq $plan.finalPh)")
                    }
                }
            } else {
                $totalOrphanChildrenRemapped += $orphanRemapPlan.Count
            }
        }

        $totalPageRenderingsStripped += $toStrip.Count
        $totalPageRenderingsPreserved += $toPreserve.Count

        $pageStatusCounts[$status] = [int]$pageStatusCounts[$status] + 1
        $pageActionCounts[$action] = [int]$pageActionCounts[$action] + 1
    }

    # ── W76: FR placeholder rewrite pass ──
    # SEPARATE from the page strip pass. Processes ALL pages with FR candidates,
    # including pages that had no shared-layout overrides (fr-only pages).
    # PURPOSE: After SV strip, FR renderings may still have UID-based placeholder paths
    # that reference now-removed SV rendering UIDs. Rewrites them to canonical SXA composed form.
    #
    # THREE RESOLVER PATHS:
    # Form A (legacy orphan):  /root/slot-{GUID}-ordinal
    #   → Single-level resolver: finds matching Partial Design with root-token rendering, resolves
    #     Placeholder Key from Placeholder Settings, builds /root/key/slot-ordinal-dynamicId
    # Form B (already normalized): /root/key/slot-ordinal-dynamic
    #   → Verify canonical: if already matches expected form, noop
    # Form C (multi-level UID): placeholder contains GUID segments at multiple levels
    #   → Compose-based resolver: replaces each UID segment using PD compose info
    #
    # PARENT-PRESERVED GUARD (critical): If a rendering's parent UID belongs to a PRESERVED
    # (not stripped) rendering, the rewrite is SKIPPED. The UID-based path is still valid
    # because the parent rendering still exists on the SV/page. Rewriting it would break
    # the placeholder resolution chain. This guard prevented false rewrites in validation.
    #
    # Pre/post-write verification: each rewrite is verified by re-reading the FR rendering
    # and checking that the placeholder was actually updated. Failures are logged and counted.
    $frFormA = '^/([^/]+)/([A-Za-z0-9_-]+)-\{[A-Fa-f0-9-]+\}-(\d+)$'
    $frFormB = '^/([^/]+)/([^/]+)/([A-Za-z0-9_-]+)-(\d+)-(\d+)$'
    # F141: Multi-level UID pattern — any placeholder segment containing a GUID
    # Used to detect candidates that Resolve-FrPlaceholder (single-level) cannot handle.
    $frFormUid = '\{[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}\}'

    foreach ($page in $pageCandidates) {
        if ($page.Paths.FullPath.StartsWith($presentationPath)) { continue }

        # Get page FR renderings
        $frRenderings = @(Get-Rendering -Item $page -FinalLayout -Device $device -ErrorAction SilentlyContinue)
        if ($frRenderings.Count -eq 0) { continue }

        # Filter to candidates with legacy-UID or normalized placeholders
        $frCandidates = @($frRenderings | Where-Object {
            $_.Placeholder -match $frFormA -or $_.Placeholder -match $frFormB -or $_.Placeholder -match $frFormUid
        })
        if ($frCandidates.Count -eq 0) { continue }

        # Resolve Page Design for this page (cached by template ID)
        $tplKey = $page.TemplateID.ToString()
        if (-not $designItemCache.ContainsKey($tplKey)) {
            $designItemCache[$tplKey] = Get-DesignItem $page
        }
        $frDesignItem = $designItemCache[$tplKey]
        if (-not $frDesignItem) { continue }

        $pageFrDecisions = [System.Collections.ArrayList]::new()
        $svStripUids = if ($svStripDataByTemplate.ContainsKey($tplKey)) { $svStripDataByTemplate[$tplKey].stripUids } else { $null }

        foreach ($candidate in $frCandidates) {
            $totalFrCandidatesEvaluated++

            $decision = $null
            if ($candidate.Placeholder -match $frFormA -or $candidate.Placeholder -match $frFormB) {
                # Single-level resolver (Form A / Form B)
                $decision = Resolve-FrPlaceholder `
                    -Rendering $candidate `
                    -PageDesignItem $frDesignItem `
                    -SitePath $sitePath `
                    -Device $device `
                    -Cache $placeholderKeyCache `
                    -StripUids $svStripUids
            } else {
                # F141: Multi-level compose-based resolver (Form C — placeholder has UID segments)
                $decision = [PSCustomObject]@{
                    childUid = $candidate.UniqueId
                    currentPlaceholder = $candidate.Placeholder
                    candidatePlaceholder = $null
                    decision = "skip"
                    reasonCode = $null
                    resolverStage = "multi-level"
                }
                $frDesignIdStr = $frDesignItem.ID.ToString()

                # Lazy-build compose info for this design (same pattern as page pass)
                if (-not $pdUidComposeInfoByDesign.ContainsKey($frDesignIdStr)) {
                    $composeMapFr = @{}
                    $pdFieldFr = $frDesignItem.Fields["PartialDesigns"].Value
                    if ($pdFieldFr) {
                        $partialIdsFr = @($pdFieldFr.Split([char]"|") | Where-Object { $_ -ne "" })
                        foreach ($partIdFr in $partialIdsFr) {
                            $partItemFr = Get-ItemByIdSafe $partIdFr
                            if (-not $partItemFr) { continue }
                            $pdNameFr = $partItemFr.Name
                            if ($placeholderKeyCache.ContainsKey($pdNameFr)) {
                                $phKeyFr = $placeholderKeyCache[$pdNameFr]
                            } else {
                                $phSettingsPathFr = "master:$sitePath/Presentation/Placeholder Settings/Partial Design/$pdNameFr"
                                $phSettingsItemFr = Get-Item -Path $phSettingsPathFr -ErrorAction SilentlyContinue
                                if ($phSettingsItemFr) {
                                    $phKeyFr = $phSettingsItemFr["Placeholder Key"]
                                    $placeholderKeyCache[$pdNameFr] = $phKeyFr
                                } else { $phKeyFr = $null }
                            }
                            if (-not $phKeyFr) { continue }
                            $pdCacheKeyFr = $partItemFr.ID.ToString()
                            if (-not $pdRenderingsCache.ContainsKey($pdCacheKeyFr)) {
                                $pdRenderingsCache[$pdCacheKeyFr] = @(Get-Rendering -Item $partItemFr -Device $device -ErrorAction SilentlyContinue)
                            }
                            foreach ($pdRFr in $pdRenderingsCache[$pdCacheKeyFr]) {
                                if (-not $pdRFr.UniqueId) { continue }
                                $dynIdFr = "1"
                                if ($pdRFr.Parameters -match 'DynamicPlaceholderId=(\d+)') { $dynIdFr = $Matches[1] }
                                $composeMapFr[$pdRFr.UniqueId] = @{ placeholderKey = $phKeyFr; dynamicId = $dynIdFr }
                            }
                        }
                    }
                    $pdUidComposeInfoByDesign[$frDesignIdStr] = $composeMapFr
                }
                $frComposeInfo = $pdUidComposeInfoByDesign[$frDesignIdStr]

                # Merge SV preserved DynPH data into compose info
                if ($svStripDataByTemplate.ContainsKey($tplKey)) {
                    $svDataFr = $svStripDataByTemplate[$tplKey]
                    if ($svDataFr.preservedDynPH) {
                        foreach ($svUidFr in $svDataFr.preservedDynPH.Keys) {
                            if (-not $frComposeInfo.ContainsKey($svUidFr)) {
                                $frComposeInfo[$svUidFr] = @{ placeholderKey = $null; dynamicId = $svDataFr.preservedDynPH[$svUidFr].ToString() }
                            }
                        }
                    }
                }

                # Get stripped UID → sig mapping from SV data for UID replacement
                $frUidToSig = if ($svStripDataByTemplate.ContainsKey($tplKey)) { $svStripDataByTemplate[$tplKey].uidToSig } else { @{} }
                $frSigToUid = if ($pdSigToUidByDesign.ContainsKey($frDesignIdStr)) { $pdSigToUidByDesign[$frDesignIdStr] } else { @{} }

                # Step 1: Replace stripped UIDs with PD UIDs
                $frNewPh = $candidate.Placeholder
                $frAnyReplaced = $false
                foreach ($frOldUid in @($frUidToSig.Keys)) {
                        if (Test-UidReference $frNewPh $frOldUid) {
                        $frSig = $frUidToSig[$frOldUid]
                        if ($frSig -and $frSigToUid.ContainsKey($frSig)) {
                            $frNewPh = $frNewPh.Replace($frOldUid, $frSigToUid[$frSig])
                            $frAnyReplaced = $true
                        }
                    }
                }

                # Step 2: Compose all UID segments to canonical form
                if ($frAnyReplaced -or $frComposeInfo.Count -gt 0) {
                    $uidSegPatternFr = '^(.+)-(\{[A-Fa-f0-9-]+\})-(\d+)$'
                    $phSegsFr = $frNewPh.Split("/")
                    $composedSegsFr = [System.Collections.ArrayList]::new()
                    $lastInjKeyFr = $null
                    $allResolved = $true
                    foreach ($segFr in $phSegsFr) {
                        if (-not $segFr) { [void]$composedSegsFr.Add(""); continue }
                        if ($segFr -match $uidSegPatternFr) {
                            $slotFr = $Matches[1]; $uidFr = $Matches[2]; $ordFr = $Matches[3]
                            if ($frComposeInfo.ContainsKey($uidFr)) {
                                $ciFr = $frComposeInfo[$uidFr]
                                if (-not $ciFr.placeholderKey) {
                                    [void]$composedSegsFr.Add("$slotFr-$ordFr-$($ciFr.dynamicId)")
                                } elseif ($ciFr.placeholderKey -ne $lastInjKeyFr) {
                                    [void]$composedSegsFr.Add("$($ciFr.placeholderKey)/$slotFr-$ordFr-$($ciFr.dynamicId)")
                                    $lastInjKeyFr = $ciFr.placeholderKey
                                } else {
                                    [void]$composedSegsFr.Add("$slotFr-$ordFr-$($ciFr.dynamicId)")
                                }
                            } else {
                                $allResolved = $false
                                [void]$composedSegsFr.Add($segFr)
                            }
                        } else {
                            [void]$composedSegsFr.Add($segFr)
                        }
                    }
                    $composedPhFr = $composedSegsFr -join "/"
                    if ($composedPhFr -ne $candidate.Placeholder) {
                        $decision.candidatePlaceholder = $composedPhFr
                        if (-not $allResolved) {
                            $decision.decision = "skip"
                            $decision.reasonCode = "partial_multi_level_resolve"
                        } else {
                            $decision.decision = "rewrite"
                        }
                    } else {
                        $decision.decision = "noop-canonical"
                        $decision.reasonCode = "candidate_same_as_current"
                    }
                } else {
                    $decision.reasonCode = "no_compose_data_for_multi_level"
                }
            }

            if ($decision.decision -eq "rewrite") {
                if ($isDryRun) {
                    $totalFrRewritesApplied++
                } else {
                    # Pre-write check: verify child still exists with expected placeholder
                    $freshFr = @(Get-Rendering -Item $page -FinalLayout -Device $device -ErrorAction SilentlyContinue)
                    $target = $freshFr | Where-Object { $_.UniqueId -eq $candidate.UniqueId } | Select-Object -First 1
                    if ($target -and $target.Placeholder -eq $decision.currentPlaceholder) {
                        $target.Placeholder = $decision.candidatePlaceholder
                        Set-Rendering -Item $page -Instance $target -FinalLayout
                        # Post-write check
                        $verifyFr = @(Get-Rendering -Item $page -FinalLayout -Device $device -ErrorAction SilentlyContinue)
                        $verified = $verifyFr | Where-Object { $_.UniqueId -eq $candidate.UniqueId } | Select-Object -First 1
                        if ($verified -and $verified.Placeholder -eq $decision.candidatePlaceholder) {
                            $totalFrRewritesApplied++
                        } else {
                            $decision.decision = "skip"
                            $decision.reasonCode = "postcheck_failed"
                            $totalFrSkipped++
                        }
                    } else {
                        $decision.decision = "skip"
                        $decision.reasonCode = "precondition_failed"
                        $totalFrSkipped++
                    }
                }
            }
            elseif ($decision.decision -eq "noop-canonical") {
                $totalFrNoopsCanonical++
            }
            else {
                $totalFrSkipped++
            }

            [void]$pageFrDecisions.Add($decision)
        }

        # Count FR-only pages (pages processed only by FR rewrite, not by shared-layout stripping)
        $pageStatusCounts["fr-only"] = [int]$pageStatusCounts["fr-only"] + 1
    }

    [void]$debug.Add("Page scope complete: $totalPagesProcessed pages, $totalPagesReset reset, $totalPagesStripped surgical, $totalDryRunInheritedSvRenderings inherited SV rendering(s) suppressed for dry-run parity")
    [void]$debug.Add("FR rewrite: $totalFrCandidatesEvaluated evaluated, $totalFrRewritesApplied rewrites, $totalFrNoopsCanonical noops, $totalFrSkipped skipped")
    } # end if: page scope

    # ── Output (aggregates only — no per-page or debug arrays) ──
    [PSCustomObject]@{
        Status                       = "ok"
        Mode                         = if ($isDryRun) { "dry-run" } else { "execute" }
        Scope                        = $effectiveScope
        TemplatesProcessed           = $results.Count
        TemplatesModified            = $totalTemplatesModified
        TotalRenderingsStripped      = $totalStripped
        TotalRenderingsPreserved     = $totalPreserved
        PagesProcessed               = $totalPagesProcessed
        PagesReset                   = $totalPagesReset
        PagesSurgical                = $totalPagesStripped
        TotalPageRenderingsStripped  = $totalPageRenderingsStripped
        TotalPageRenderingsPreserved = $totalPageRenderingsPreserved
        SimulatedInheritedSvRenderings = $totalDryRunInheritedSvRenderings
        FrCandidatesEvaluated        = $totalFrCandidatesEvaluated
        FrRewritesApplied            = $totalFrRewritesApplied
        FrNoopsCanonical             = $totalFrNoopsCanonical
        FrSkipped                    = $totalFrSkipped
        OrphanChildrenRemapped       = $totalOrphanChildrenRemapped
        SvOrphansRemapped            = $totalSvOrphansRemapped
        Results                      = @($results)
        PageStatusCounts             = $pageStatusCounts
        PageActionCounts             = $pageActionCounts
        Debug                        = @($debug)
    } | ConvertTo-Json -Depth 5
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 5
}
