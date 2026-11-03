<#
.INJECTED_VARIABLES
  $sitePath          [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
  $partialDesignsJson [string] - JSON array of partial design specs:
    [{ "name": "Header", "renderingSource": { "templateId": "{GUID}", "sourcePlaceholder": "lockedtop", "targetPlaceholder": "lockedtop" } },
     { "name": "Footer", "renderingSource": { "pagePath": "/Home/legal", "sourcePlaceholder": "lockedbottom" } },
     { "name": "Empty PD" }]
    Each entry: name (required), renderingSource (optional — omit for empty PD).
    renderingSource: templateId OR pagePath (mutually exclusive), sourcePlaceholder (required), targetPlaceholder (optional, defaults to sourcePlaceholder).

.SYNOPSIS
  Creates Partial Design items under site/Presentation/Partial Designs and copies
  renderings from a source SV (or page) into each PD. Called by the orchestrator
  after xmc-discover-presentation-patterns produces the PresentationPlan.

.PIPELINE POSITION
  2 of 3: discover → [CREATE-PARTIAL-DESIGNS] → migrate-to-page-designs
  Input: PartialDesigns[] from discovery's PresentationPlan
  Output: Created PD items with renderings copied from representative template SVs

.DATASOURCE HANDLING (F138/F145)
  Datasources are passed through Normalize-DataSource which:
  - GUIDs: uppercases + brace-normalizes
  - Paths: lowercases + de-dupes slashes
  - query: / fast: expressions: lowercases ONLY the prefix, preserves query text VERBATIM
  This means a query-ds like "query:ancestor-or-self::*[@@templateid='{...}']/Page Components//*[...]"
  is copied exactly as-is from the source SV to the PD. The Sitecore rendering engine
  resolves it at render time per-page, so each page gets its own content despite sharing
  the PD rendering. See F138 for empirical validation, F145 for cross-template query variance.

.RENDERING FILTERING (F140 / W82)
  When renderingUids is provided in the spec, only renderings whose UniqueId is in the
  list get copied. This is the PD-compatibility gate: discovery classifies renderings
  and emits UIDs of compatible-only renderings. Incompatible renderings (those with
  per-page deletions or ds/param overrides) are excluded from PDs, staying on template
  SVs where __Final Renderings can customize them per-page.
  Note: renderingUids are INSTANCE-SPECIFIC per SV. The discovery tool rebuilds them
  from the representative template (Step 8c). Passing UIDs from a different template
  would match nothing — the representative template ID must match the source.

.NESTING & ORPHAN HANDLING
  Copy-SubRenderings recursively walks the rendering tree, rewriting placeholder paths
  from source UID-based format to PD DynamicPlaceholderId format. Renderings not
  reached by the recursive walk (broken parent chain) are copied verbatim as orphans
  with their original placeholder paths preserved (NO DATA LOSS guarantee).
#>
$ConfirmPreference = "None"
$ErrorActionPreference = "Stop"

$globalDebug = [System.Collections.ArrayList]::new()

try {
    Set-Location "master:/sitecore"

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
    # MIGRATION-ONLY in the migration script handles a target-side transport
    # artifact and must not be applied to source creation inputs.
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
            # Treat them as non-semantic for parity and matching.
            if ($kDecoded -eq "DynamicPlaceholderId") { continue }

            # Ignore known SXA-injected keys entirely for parity and matching.
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
        # after ":" is preserved VERBATIM. See discover-presentation-patterns.ps1 for detailed
        # explanation. This guarantee is critical for PD composition — do NOT modify query text.
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

    function Get-ParamHashFromRendering([string]$raw) {
        $normalized = Normalize-RenderingParams $raw
        $paramHash = @{}
        if (-not $normalized) { return $paramHash }

        $pairs = $normalized -split "&"
        foreach ($pair in $pairs) {
            $kv = $pair -split "=", 2
            $key = if ($kv.Count -gt 0) { $kv[0].Trim() } else { "" }
            if (-not $key) { continue }
            $value = if ($kv.Count -gt 1) { $kv[1] } else { "" }
            $paramHash[$key] = $value
        }

        return $paramHash
    }

    # ── Constants ──
    $pdDesignTplId = "{FD2059FD-6043-4DFE-8C04-E2437CE87634}"   # Partial Design template
    $maxDepth = 10
    [void]$globalDebug.Add("ConfirmPreference=$ConfirmPreference, ErrorActionPreference=$ErrorActionPreference")

    # ── Parse input array ──
    $specs = $partialDesignsJson | ConvertFrom-Json
    if (-not $specs -or $specs.Count -eq 0) {
        throw "partialDesignsJson is empty or invalid"
    }
    # Force to array (ConvertFrom-Json unwraps single-element arrays)
    $specs = @($specs)
    [void]$globalDebug.Add("Received $($specs.Count) partial design spec(s)")

    # ── Validate site exists ──
    $site = Get-Item -Path "master:$sitePath" -ErrorAction SilentlyContinue
    if (-not $site) {
        throw "Site not found at $sitePath"
    }
    [void]$globalDebug.Add("Site found: $($site.Name)")

    # ── Validate Partial Designs folder exists ──
    $pdFolder = Get-Item -Path "master:$sitePath/Presentation/Partial Designs" -ErrorAction SilentlyContinue
    if (-not $pdFolder) {
        throw "Partial Designs folder not found at $sitePath/Presentation/Partial Designs"
    }

    $device = Get-LayoutDevice -Default

    # ── Results tracking ──
    $results = [System.Collections.ArrayList]::new()
    $errors = [System.Collections.ArrayList]::new()
    $totalCreated = 0
    $totalAlreadyExisted = 0
    $totalFailed = 0

    # ──────────────────────────────────────────────────────────────────────────
    # Helper: Add a single rendering to a Partial Design, preserving datasource + parameters
    # ──────────────────────────────────────────────────────────────────────────
    function Add-RenderingToPD {
        param(
            [Parameter(Mandatory)]$SourceRendering,
            [Parameter(Mandatory)]$PlaceholderKey,
            [Parameter(Mandatory)]$PartialDesign
        )

        $rItem = Get-Item -Path "master:" -ID $SourceRendering.ItemID -ErrorAction SilentlyContinue
        if (-not $rItem) {
            [void]$globalDebug.Add("WARNING: Rendering item not found for ID $($SourceRendering.ItemID) — skipping")
            return $null
        }

        $newDef = $rItem | New-Rendering -Placeholder $PlaceholderKey

        $addParams = @{
            Item        = $PartialDesign
            PlaceHolder = $PlaceholderKey
            Instance    = $newDef
        }

        # [F138] Normalize-DataSource preserves query-ds text verbatim (only lowercases prefix).
        # The normalized datasource is passed directly to Add-Rendering -DataSource.
        # This is the critical link in the query-ds passthrough chain:
        #   SV rendering.Datasource → Normalize-DataSource → Add-Rendering -DataSource on PD
        # The query expression never gets parsed, rewritten, or evaluated during copy.
        $normalizedDs = Normalize-DataSource ([string]$SourceRendering.Datasource)
        if ($normalizedDs) {
            $addParams["DataSource"] = $normalizedDs
        }

        $paramHash = Get-ParamHashFromRendering ([string]$SourceRendering.Parameters)
        if ($paramHash.Count -gt 0) {
            $addParams["Parameter"] = $paramHash
        }

        Add-Rendering @addParams -Confirm:$false

        # Guard the SPE empty-parameter transport artifact at its source. A lone
        # lower-case "s" is produced by the target cmdlet for an empty hashtable;
        # clear only that exact artifact and preserve all real source parameters.
        if ($paramHash.Count -eq 0) {
            $created = @(Get-Rendering -Item $PartialDesign -Device $device | Where-Object {
                $_.ItemID -eq $SourceRendering.ItemID -and $_.Placeholder -eq $PlaceholderKey
            }) | Select-Object -Last 1
            if ($created -and ([string]$created.Parameters).Trim() -ceq "s") {
                $created.Parameters = ""
                Set-Rendering -Item $PartialDesign -Instance $created
                [void]$globalDebug.Add("Normalized empty parameter artifact for $($rItem.Name) at '$PlaceholderKey'")
            }
        }
        return @{
            renderingId   = $SourceRendering.ItemID
            renderingName = $rItem.Name
            datasource    = $SourceRendering.Datasource
            placeholder   = $PlaceholderKey
        }
    }

    # ──────────────────────────────────────────────────────────────────────────
    # Helper: Recursively copy sub-placeholder children using Headless SXA dynamic PH format (W37/F83/F84)    #
    # PLACEHOLDER REWRITING:
    # Source SVs use UID-based dynamic placeholder paths: /lockedbottom/phCTA-{GUID}-0
    # PDs use numeric DynamicPlaceholderId format:        /lockedbottom/phCTA-1
    # This function rewrites the path for each level of nesting, using the DynPhId
    # assigned by Sitecore when the parent rendering was added to the PD.
    #
    # F140 FILTERING:
    # When AllowedUids is provided, only children whose UniqueId is in the set are copied.
    # This prevents PD-incompatible nested renderings from leaking onto PDs.
    # Example: A Navigation wrapper (PD-compatible) may contain a Hero Banner child
    # (PD-incompatible). The Hero Banner is skipped, but the Navigation is still copied.
    #
    # DEPTH LIMIT: maxDepth ($maxDepth) prevents runaway recursion on corrupt layout data.    # ──────────────────────────────────────────────────────────────────────────
    function Copy-SubRenderings {
        param(
            [Parameter(Mandatory)][string]$SourceUid,
            [Parameter(Mandatory)]$PartialDesign,
            [Parameter(Mandatory)][hashtable]$DynPhMap,
            [Parameter(Mandatory)][hashtable]$ChildrenByParentUid,
            [Parameter(Mandatory)][System.Collections.ArrayList]$RenderingDetails,
            [ref]$DescendantsAdded,
            # F140: Optional set of allowed rendering UniqueIds.
            # When provided, only children whose UniqueId is in this set are copied.
            # This prevents PD-incompatible nested renderings from leaking onto PDs.
            $AllowedUids = $null,
            # Track which UIDs have been copied so fallback pass knows what's missing
            $CopiedUids = $null,
            [int]$Depth = 0
        )
        if ($Depth -ge $maxDepth) {
            [void]$globalDebug.Add("WARNING: Max recursion depth ($maxDepth) reached for UID $SourceUid — stopping")
            return
        }
        if (-not $ChildrenByParentUid.ContainsKey($SourceUid)) { return }

        $parentInfo = $DynPhMap[$SourceUid]
        if (-not $parentInfo) {
            [void]$globalDebug.Add("WARNING: No DynPH mapping for source $SourceUid at depth $Depth — children not copied")
            return
        }
        $parentPH = $parentInfo.placeholder

        foreach ($child in $ChildrenByParentUid[$SourceUid]) {
            # F140: Skip children not in the allowed rendering UID set (PD-incompatible)
            if ($AllowedUids -and -not $AllowedUids.Contains($child.UniqueId)) {
                [void]$globalDebug.Add("SKIP child $($child.ItemID) uid=$($child.UniqueId) at depth $Depth — not in renderingUids (PD-incompatible)")
                continue
            }
            $childPH = $child.Placeholder
            $lastSegment = ($childPH -split "/" | Where-Object { $_ })[-1]
            $childBaseName = $lastSegment -replace '-\{[0-9A-Fa-f-]+\}-\d+$', ''
            if ($childBaseName -match '\{') {
                $childBaseName = $childBaseName.Substring(0, $childBaseName.IndexOf('{'))
                $childBaseName = $childBaseName.TrimEnd('-')
            }

            $cleanParentPH = $parentPH.TrimStart('/')
            # Use Headless SXA numeric DynPhId when available, fall back to UID-based format
            if ($parentInfo.dynPhId) {
                $newChildPlaceholder = "/$cleanParentPH/$childBaseName-$($parentInfo.dynPhId)"
            } else {
                $newChildPlaceholder = "/$cleanParentPH/$childBaseName-$($parentInfo.newUid)-0"
            }

            [void]$globalDebug.Add("Rewriting child PH: '$childPH' → '$newChildPlaceholder'")

            $childDetail = Add-RenderingToPD -SourceRendering $child -PlaceholderKey $newChildPlaceholder -PartialDesign $PartialDesign
            if ($childDetail) {
                $DescendantsAdded.Value++
                [void]$RenderingDetails.Add($childDetail)
                if ($CopiedUids -and $child.UniqueId) { [void]$CopiedUids.Add($child.UniqueId) }

                if ($child.UniqueId) {
                    $pdAfter = Get-Rendering -Item $PartialDesign -Device $device
                    $newChild = @($pdAfter | Where-Object {
                        $_.ItemID -eq $child.ItemID -and $_.Placeholder -eq $newChildPlaceholder
                    }) | Select-Object -Last 1
                    if ($newChild) {
                        $childDynId = $null
                        if ($newChild.Parameters -and $newChild.Parameters -match 'DynamicPlaceholderId=(\d+)') {
                            $childDynId = $Matches[1]
                        }
                        # Always map — use DynPhId when available, fall back to new UID
                        $DynPhMap[$child.UniqueId] = @{
                            placeholder = $newChildPlaceholder
                            dynPhId     = $childDynId
                            newUid      = $newChild.UniqueId
                        }
                        Copy-SubRenderings -SourceUid $child.UniqueId -PartialDesign $PartialDesign `
                            -DynPhMap $DynPhMap -ChildrenByParentUid $ChildrenByParentUid `
                            -RenderingDetails $RenderingDetails -DescendantsAdded $DescendantsAdded `
                            -AllowedUids $AllowedUids -CopiedUids $CopiedUids -Depth ($Depth + 1)
                    }
                }
            }
        }
    }

    # ──────────────────────────────────────────────────────────────────────────
    # Main loop: process each partial design spec sequentially
    # ──────────────────────────────────────────────────────────────────────────
    foreach ($spec in $specs) {
        $pdName = $spec.name
        $debugLines = [System.Collections.ArrayList]::new()

        try {
            # ── Validate item name (F102: use sanitized name, set display name if different) ──
            $itemName = [Sitecore.Data.Items.ItemUtil]::ProposeValidItemName($pdName)
            if ($itemName -ne $pdName) {
                [void]$debugLines.Add("Sanitized item name: '$pdName' -> '$itemName' (display name preserved)")
            }

            # ── Determine if we have a rendering source ──
            $rs = $spec.renderingSource
            $hasSource = $rs -and (
                (-not [string]::IsNullOrWhiteSpace($rs.templateId)) -or
                (-not [string]::IsNullOrWhiteSpace($rs.pagePath))
            )

            # ── Idempotency: check if PD already exists (try both sanitized and original name) ──
            $existingPd = Get-Item -Path "master:$sitePath/Presentation/Partial Designs/$itemName" -ErrorAction SilentlyContinue
            if (-not $existingPd -and $itemName -ne $pdName) {
                $existingPd = Get-Item -Path "master:$sitePath/Presentation/Partial Designs/$pdName" -ErrorAction SilentlyContinue
            }
            $created = $false

            if ($existingPd) {
                [void]$debugLines.Add("Partial Design '$itemName' already exists — will add renderings to existing item")
                $pd = $existingPd
            } else {
                $pd = New-Item -Path "master:$sitePath/Presentation/Partial Designs/$itemName" -ItemType $pdDesignTplId -Language "en" -Confirm:$false -Force
                if (-not $pd) {
                    throw "Failed to create Partial Design at $sitePath/Presentation/Partial Designs/$itemName"
                }
                $created = $true
                [void]$debugLines.Add("Created Partial Design '$itemName'")
                # Set display name if it differs from item name
                if ($itemName -ne $pdName) {
                    $pd.Editing.BeginEdit()
                    $pd.Fields["__Display name"].Value = $pdName
                    $pd.Editing.EndEdit() | Out-Null
                    [void]$debugLines.Add("Set display name to '$pdName'")
                }
            }

            # ── Initialize per-item counters ──
            $added = 0
            $skipped = 0
            $descendantsAdded = 0
            $orphansAdded = 0
            $renderingDetails = [System.Collections.ArrayList]::new()
            $dynPhMap = @{}
            $copiedUids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

            if (-not $hasSource) {
                [void]$debugLines.Add("No rendering source — created empty Partial Design")
            }
            else {
                # ── Validate sourcePlaceholder ──
                $sourcePH = $rs.sourcePlaceholder
                if ([string]::IsNullOrWhiteSpace($sourcePH)) {
                    throw "sourcePlaceholder is required when renderingSource is provided"
                }
                $targetPH = if (-not [string]::IsNullOrWhiteSpace($rs.targetPlaceholder)) { $rs.targetPlaceholder } else { $sourcePH }

                # ── Resolve source item ──
                $sourceItem = $null
                if (-not [string]::IsNullOrWhiteSpace($rs.templateId)) {
                    $cleanId = $rs.templateId.Trim()
                    if (-not $cleanId.StartsWith("{")) { $cleanId = "{$cleanId}" }
                    $template = Get-Item -Path "master:" -ID $cleanId -ErrorAction SilentlyContinue
                    if (-not $template) { throw "Template not found for ID $cleanId" }
                    $stdValuesPath = "$($template.Paths.FullPath)/__Standard Values"
                    $sourceItem = Get-Item -Path "master:$stdValuesPath" -ErrorAction SilentlyContinue
                    if (-not $sourceItem) { throw "Standard Values not found at $stdValuesPath" }
                    [void]$debugLines.Add("Source: SV of $($template.Name) ($cleanId)")
                }
                else {
                    $fullSourcePath = "$sitePath$($rs.pagePath)"
                    $sourceItem = Get-Item -Path "master:$fullSourcePath" -ErrorAction SilentlyContinue
                    if (-not $sourceItem) { throw "Source page not found at $fullSourcePath" }
                    [void]$debugLines.Add("Source: page at $fullSourcePath")
                }

                # ── Copy layout ──
                $sourceLayout = Get-Layout -Item $sourceItem -Device $device
                if ($sourceLayout) {
                    Set-Layout -Item $pd -Layout $sourceLayout -Device $device -Confirm:$false
                }

                # ── Read and filter renderings (merged shared+final — what pages inherit) ──
                $allRenderings = Get-Rendering -Item $sourceItem -Device $device -FinalLayout
                if (-not $allRenderings) { $allRenderings = @() }

                $matched = @($allRenderings | Where-Object { $_.Placeholder -eq $sourcePH })
                [void]$debugLines.Add("Top-level renderings matching '$sourcePH': $($matched.Count)")

                # ── Filter by renderingUids when provided (F140 — PD-compatibility gate) ──
                # This is the PRIMARY defense against PD-incompatible renderings.
                # Discovery classifies renderings as PD-compatible vs PD-incompatible (Step 7c)
                # and emits only compatible UIDs in the PresentationPlan.
                # When renderingUids is supplied, only copy renderings whose UniqueId is in the list.
                # UIDs are instance-specific per SV — two identical renderings (same ItemID, same
                # datasource) on two different template SVs have different UIDs. This is why the
                # representative template from discovery must match the source template here.
                # Also gates Copy-SubRenderings via AllowedUids parameter — nested children of
                # compatible parents are also filtered (e.g., Hero Banner child of Navigation).
                $allowedUids = $null
                if ($rs.renderingUids -and $rs.renderingUids.Count -gt 0) {
                    $allowedUids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                    foreach ($uid in $rs.renderingUids) {
                        [void]$allowedUids.Add($uid.Trim())
                    }
                    $beforeCount = $matched.Count
                    $matched = @($matched | Where-Object { $allowedUids.Contains($_.UniqueId) })
                    [void]$debugLines.Add("After renderingUids filter: $($matched.Count) of $beforeCount (allowed UIDs: $($allowedUids.Count))")
                }

                # ── Build children-by-parent-UID lookup ──
                $childrenByParentUid = @{}
                $allUids = @($allRenderings | Where-Object { $_.UniqueId } | ForEach-Object { $_.UniqueId })
                foreach ($uid in $allUids) {
                    $children = @($allRenderings | Where-Object {
                        $_.Placeholder -and $_.Placeholder.Contains($uid)
                    })
                    if ($children.Count -gt 0) {
                        $childrenByParentUid[$uid] = $children
                    }
                }

                # ── Check existing renderings on PD ──
                $existingRenderings = Get-Rendering -Item $pd -Device $device
                if (-not $existingRenderings) { $existingRenderings = @() }
                $existingRenderingIds = @($existingRenderings | ForEach-Object { $_.ItemID })

                # ── Copy renderings ──
                foreach ($r in $matched) {
                    if ($existingRenderingIds -contains $r.ItemID) {
                        $skipped++
                        continue
                    }

                    $detail = Add-RenderingToPD -SourceRendering $r -PlaceholderKey $targetPH -PartialDesign $pd
                    if (-not $detail) {
                        $skipped++
                        continue
                    }
                    $added++
                    [void]$renderingDetails.Add($detail)
                    if ($r.UniqueId) { [void]$copiedUids.Add($r.UniqueId) }

                    # Map source UID → DynPH info, then recursively copy descendants
                    $sourceUid = $r.UniqueId
                    if ($sourceUid) {
                        $pdRenderings = Get-Rendering -Item $pd -Device $device
                        $newParent = @($pdRenderings | Where-Object {
                            $_.ItemID -eq $r.ItemID -and $_.Placeholder -eq $targetPH
                        }) | Select-Object -Last 1
                        if ($newParent) {
                            $dynPhId = $null
                            if ($newParent.Parameters -and $newParent.Parameters -match 'DynamicPlaceholderId=(\d+)') {
                                $dynPhId = $Matches[1]
                            }
                            # Always map — use DynPhId when available, fall back to new UID
                            $dynPhMap[$sourceUid] = @{
                                placeholder = $targetPH
                                dynPhId     = $dynPhId
                                newUid      = $newParent.UniqueId
                            }
                            $descRef = [ref]$descendantsAdded
                            Copy-SubRenderings -SourceUid $sourceUid -PartialDesign $pd `
                                -DynPhMap $dynPhMap -ChildrenByParentUid $childrenByParentUid `
                                -RenderingDetails $renderingDetails -DescendantsAdded $descRef `
                                -AllowedUids $allowedUids -CopiedUids $copiedUids
                            $descendantsAdded = $descRef.Value
                        }
                    }
                }

                # ── Fallback pass: copy orphan renderings not reached by recursive walk ──
                # NO DATA LOSS GUARANTEE: if a rendering UID is in the allowed list but wasn't
                # copied (e.g. its placeholder references a parent UID that doesn't exist on this SV,
                # or its parent was PD-incompatible and filtered), copy it with its original
                # placeholder preserved. It will sit on the PD with its original path — faithful
                # reproduction rather than silent data loss. The rendering may not resolve visually
                # until a parent is added, but the data is preserved.
                if ($allowedUids) {
                    $uncoped = @($allRenderings | Where-Object {
                        $_.UniqueId -and
                        $allowedUids.Contains($_.UniqueId) -and
                        -not $copiedUids.Contains($_.UniqueId)
                    })
                    foreach ($orphan in $uncoped) {
                        $orphanDetail = Add-RenderingToPD -SourceRendering $orphan -PlaceholderKey $orphan.Placeholder -PartialDesign $pd
                        if ($orphanDetail) {
                            $orphansAdded++
                            [void]$copiedUids.Add($orphan.UniqueId)
                            [void]$renderingDetails.Add($orphanDetail)
                            [void]$debugLines.Add("Orphan rendering copied: uid=$($orphan.UniqueId) item=$($orphan.ItemID) ph='$($orphan.Placeholder)'")
                        }
                    }
                }

                [void]$debugLines.Add("Added $added top-level + $descendantsAdded descendant(s) + $orphansAdded orphan(s), skipped $skipped")
            }

            # ── Record success ──
            $action = if ($created) { "created" } else { "already_exists" }
            if ($created) { $totalCreated++ } else { $totalAlreadyExisted++ }

            [void]$results.Add([PSCustomObject]@{
                name             = $pdName
                itemName         = $itemName
                id               = $pd.ID.ToString()
                path             = $pd.Paths.FullPath
                action           = $action
                renderingsCopied = $added + $descendantsAdded + $orphansAdded
                debug            = @($debugLines)
            })
        }
        catch {
            $totalFailed++
            [void]$errors.Add([PSCustomObject]@{
                name    = $pdName
                error   = "CreateFailed"
                message = $_.Exception.Message
            })
            [void]$globalDebug.Add("ERROR processing '$pdName': $($_.Exception.Message)")
        }
    }

    # ── Final output ──
    $status = if ($totalFailed -eq 0) { "success" } elseif ($totalCreated -gt 0 -or $totalAlreadyExisted -gt 0) { "partial" } else { "error" }

    [PSCustomObject]@{
        Status              = $status
        TotalRequested      = $specs.Count
        TotalCreated        = $totalCreated
        TotalAlreadyExisted = $totalAlreadyExisted
        TotalFailed         = $totalFailed
        PartialDesigns      = @($results)
        Errors              = @($errors)
        Debug               = @($globalDebug)
    } | ConvertTo-Json -Depth 6
}
catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = @($globalDebug)
    } | ConvertTo-Json -Depth 6
}
