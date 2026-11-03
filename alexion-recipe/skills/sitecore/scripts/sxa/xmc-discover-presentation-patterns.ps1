<#
.INJECTED_VARIABLES
  $sitePath     [string] - Full Sitecore path to the site (for context/reporting)
  $templateIds  [string] - Pipe-delimited GUIDs of page templates to analyze

.SYNOPSIS
  Analyzes Standard Values across all page templates and produces a deterministic
  PresentationPlan (PartialDesigns[], PageDesigns[], TemplateAssignments[]) that
  drives the downstream create-partial-designs and migrate-to-page-designs scripts.

.PIPELINE OVERVIEW
  1. Read SV renderings from each template (merged shared+final via -FinalLayout)
  2. Compute RenderingSummary — per-rendering cross-template statistics
  3. Compute TemplateGroups — disjoint template partitions by top-level placeholder
  4. Step 6: Fingerprint-based Page Design suggestions per group
  5. Step 7: Per-placeholder variance analysis (identical/superset/subset/divergent)
  6. Step 7c (W82): PD Compatibility Classification — classifies each SV rendering as
     PD-compatible or PD-incompatible based on per-page modifications
  7. Step 8: Pre-compute Presentation Plan (the execution contract for Phase 3+4)

.EDGE CASES & INVARIANTS
  - Normalization Contract (F107/W57): Normalize-DataSource, Normalize-RenderingParams,
    and Normalize-Text must remain equivalent across all three pipeline scripts.
    See NormalizationContractVersion header below.
  - Query-DS passthrough (F138): Normalize-DataSource only lowercases the "query:" prefix
    and trims whitespace. The query expression text after ":" is NEVER modified.
    This is critical — query-ds renderings resolve at render time to page-specific items,
    so they are safe for PD composition despite appearing to have "the same" datasource
    across pages. Verified empirically: PD-delivered query-ds renderings resolve to
    different items per page (e.g., Basic CTA resolves to page-level Page Components).
  - PD incompatibility (W82/F140): ANY page that deletes a rendering (not in merged layout)
    or overrides its datasource/parameters makes that rendering PD-incompatible.
    Zero tolerance — even 1 page modification disqualifies. PD-incompatible renderings
    stay on template SVs where __Final Renderings can customize them per-page.
  - Nesting split (NESTING_SPLIT): Templates where a rendering's placeholder structure
    differs from the majority are structurally excluded from the main group to prevent
    placeholder path mismatches in PD composition.
  - Ghost placeholders: SV has renderings at a placeholder but 0 pages use it.
    Ghost placeholders are excluded from PD composition (would be dead weight).
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    $debug = @()

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
    # artifact and must not be applied to source discovery inputs.
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
            # Treat them as non-semantic for clustering and matching.
            if ($kDecoded -eq "DynamicPlaceholderId") { continue }

            # Ignore known SXA-injected keys entirely for clustering and matching.
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

        # [F138] Query-DS passthrough guarantee: only the prefix ("query"/"fast") is lowercased.
        # The query expression after ":" is preserved VERBATIM. Do NOT normalize, parse, or
        # rewrite the query text — different templates may have legitimately different query
        # expressions (e.g., Residence vs Residence BaV have different @@templateid predicates).
        # This passthrough is what makes query-ds renderings safe for PD composition: the
        # Sitecore rendering engine resolves the query at render time per-page.
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

    # Split pipe-delimited string (joined by TS handler from array input)
    # Use [char] cast to avoid regex interpretation of pipe character
    $ids = $templateIds.Split([char]"|") | Where-Object { $_ -ne "" }
    $debug += "Analyzing $($ids.Count) template(s) for site $sitePath"

    $templates = @()

    foreach ($id in $ids) {
        # Normalize GUID: strip braces/whitespace, validate format, re-add braces
        $cleanId = $id.Trim() -replace '[{}]', ''
        if ($cleanId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
            $debug += "WARN: Skipping invalid GUID format: $id"
            $templates += [PSCustomObject]@{
                id                = $id.Trim()
                name              = $null
                path              = $null
                hasStandardValues = $false
                renderings        = @()
                error             = "Invalid GUID format"
            }
            continue
        }
        $cleanId = "{$cleanId}"
        $tpl = Get-Item -Path "master:" -ID $cleanId -ErrorAction SilentlyContinue
        if (-not $tpl) {
            $debug += "WARN: Template not found for ID $cleanId"
            $templates += [PSCustomObject]@{
                id                = $cleanId
                name              = $null
                path              = $null
                hasStandardValues = $false
                renderings        = @()
                error             = "Template not found"
            }
            continue
        }

        # Find __Standard Values child
        $sv = Get-ChildItem -Path $tpl.Paths.FullPath | Where-Object { $_.Name -eq "__Standard Values" } | Select-Object -First 1
        if (-not $sv) {
            $debug += "Template '$($tpl.Name)' has no __Standard Values"
            $templates += [PSCustomObject]@{
                id                = $tpl.ID.ToString()
                name              = $tpl.Name
                path              = $tpl.Paths.FullPath
                hasStandardValues = $false
                renderings        = @()
                error             = $null
            }
            continue
        }

        # Get merged renderings (shared + final) — pages inherit from this merged output
        $allRenderings = @(Get-Rendering -Item $sv -FinalLayout -ErrorAction SilentlyContinue)
        $debug += "Template '$($tpl.Name)': $($allRenderings.Count) rendering(s) on merged layout"

        $renderingList = @()
        foreach ($r in $allRenderings) {
            # Resolve rendering item name for richer output
            $renderingName = $null
            if ($r.ItemID) {
                $renderingItem = Get-Item -Path "master:" -ID $r.ItemID -ErrorAction SilentlyContinue
                if ($renderingItem) {
                    $renderingName = $renderingItem.Name
                }
            }

            $renderingList += [PSCustomObject]@{
                itemId      = if ($r.ItemID) { $r.ItemID.ToString() } else { $null }
                name        = $renderingName
                placeholder = $r.Placeholder
                datasource  = $r.Datasource
                parameters  = $r.Parameters
                uniqueId    = $r.UniqueId
            }
        }

        $templates += [PSCustomObject]@{
            id                = $tpl.ID.ToString()
            name              = $tpl.Name
            path              = $tpl.Paths.FullPath
            hasStandardValues = $true
            renderings        = $renderingList
            error             = $null
        }
    }

    $withRenderings = @($templates | Where-Object { $_.renderings.Count -gt 0 })
    $withoutRenderings = @($templates | Where-Object { $_.renderings.Count -eq 0 })

    # Collect distinct placeholders across all templates
    $allPlaceholders = @($templates | ForEach-Object { $_.renderings } | ForEach-Object { $_.placeholder } | Where-Object { $_ } | Sort-Object -Unique)

    # ── Compute RenderingSummary: per-rendering cross-template statistics ──
    # For each distinct rendering (by itemId), computes:
    #   - Which templates it appears on (deduplicated)
    #   - Placeholder pattern variants (GUIDs in paths normalized to {*})
    #   - Enables agents to read exact counts instead of manually counting
    $renderingMap = @{}

    foreach ($tplObj in $templates) {
        if (-not $tplObj.renderings -or $tplObj.renderings.Count -eq 0) { continue }
        foreach ($r in $tplObj.renderings) {
            if (-not $r.itemId) { continue }
            $key = $r.itemId.ToUpperInvariant()
            if (-not $renderingMap.ContainsKey($key)) {
                $renderingMap[$key] = @{
                    name    = $r.name
                    id      = $r.itemId
                    entries = [System.Collections.ArrayList]@()
                }
            }
            $ph = if ($r.placeholder) { $r.placeholder.Trim() } else { "(none)" }
            # Normalize: replace Sitecore GUIDs with {*} so equivalent nesting patterns group together
            $normalizedPh = $ph -replace '\{[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}', '{*}'
            [void]$renderingMap[$key].entries.Add([PSCustomObject]@{
                templateName          = $tplObj.name
                normalizedPlaceholder = $normalizedPh
            })
        }
    }

    $renderingSummary = [System.Collections.ArrayList]@()
    foreach ($key in $renderingMap.Keys) {
        $data = $renderingMap[$key]
        # Deduplicate: one entry per (templateName + normalizedPlaceholder) pair
        $seen = @{}
        $deduped = [System.Collections.ArrayList]@()
        foreach ($e in $data.entries) {
            $deKey = "$($e.templateName)|$($e.normalizedPlaceholder)"
            if (-not $seen.ContainsKey($deKey)) {
                $seen[$deKey] = $true
                [void]$deduped.Add($e)
            }
        }
        $distinctTemplates = @($deduped | Select-Object -ExpandProperty templateName -Unique | Sort-Object)

        # Group by normalized placeholder pattern
        $phGroups = $deduped | Group-Object -Property normalizedPlaceholder
        $variants = [System.Collections.ArrayList]@()
        foreach ($grp in $phGroups) {
            $tplsInVariant = @($grp.Group | Select-Object -ExpandProperty templateName | Sort-Object)
            [void]$variants.Add([PSCustomObject]@{
                pattern   = $grp.Name
                count     = $tplsInVariant.Count
                templates = $tplsInVariant
            })
        }

        [void]$renderingSummary.Add([PSCustomObject]@{
            renderingId         = $data.id
            name                = $data.name
            templateCount       = $distinctTemplates.Count
            templates           = $distinctTemplates
            placeholderVariants = $variants
        })
    }

    # Add structuralNote to renderings with multiple placeholder variants (nesting splits)
    foreach ($entry in $renderingSummary) {
        if ($entry.placeholderVariants.Count -gt 1) {
            $sorted = @($entry.placeholderVariants | Sort-Object -Property count -Descending)
            $majority = $sorted[0]
            $minorities = @($sorted[1..($sorted.Count - 1)])
            $minParts = [System.Collections.ArrayList]@()
            foreach ($m in $minorities) {
                $tplList = $m.templates -join ", "
                [void]$minParts.Add("$($m.count) at '$($m.pattern)' [$tplList]")
            }
            $note = "NESTING_SPLIT: majority=$($majority.count) at '$($majority.pattern)'; minority: " + ($minParts -join "; ")
            $entry | Add-Member -NotePropertyName "structuralNote" -NotePropertyValue $note
        }
    }

    $renderingSummary = @($renderingSummary | Sort-Object -Property templateCount -Descending)

    # ── Compute TemplateGroups: disjoint template partitions with pre-computed analysis ──
    # Purely structural — identifies renderings at the same top-level placeholder whose
    # template sets are completely disjoint (no overlapping templates). The disjoint pair
    # with the highest combined template coverage defines the groups. No placeholder names
    # or rendering names are interpreted for their intent.
    # For each group, computes structural exclusions (from NESTING_SPLIT minority templates)
    # and rendering coverage (set intersection of each rendering's templates with the group).

    # Step 1: Collect single-variant renderings at top-level (non-nested) placeholders
    $topLevelByPh = @{}
    foreach ($entry in $renderingSummary) {
        if ($entry.placeholderVariants.Count -ne 1) { continue }
        $ph = $entry.placeholderVariants[0].pattern
        if (-not $ph -or $ph.StartsWith("/")) { continue }
        if (-not $topLevelByPh.ContainsKey($ph)) {
            $topLevelByPh[$ph] = [System.Collections.ArrayList]@()
        }
        [void]$topLevelByPh[$ph].Add($entry)
    }

    # Step 2: For each placeholder, find the disjoint pair with highest combined coverage
    $templateGroups = [System.Collections.ArrayList]@()
    $assignedTemplates = @{}
    $allTplNames = @($templates | Where-Object { $_.name } | Select-Object -ExpandProperty name | Sort-Object -Unique)

    foreach ($ph in $topLevelByPh.Keys) {
        $cands = @($topLevelByPh[$ph])
        if ($cands.Count -lt 2) { continue }

        # Find best disjoint pair by combined coverage
        $bestPair = $null
        $bestCov = 0
        for ($i = 0; $i -lt $cands.Count; $i++) {
            $setI = @{}
            foreach ($t in $cands[$i].templates) { $setI[$t] = $true }
            for ($j = $i + 1; $j -lt $cands.Count; $j++) {
                $hasOverlap = $false
                foreach ($t in $cands[$j].templates) {
                    if ($setI.ContainsKey($t)) { $hasOverlap = $true; break }
                }
                if (-not $hasOverlap) {
                    $cov = $cands[$i].templateCount + $cands[$j].templateCount
                    if ($cov -gt $bestCov) {
                        $bestCov = $cov
                        $bestPair = @($cands[$i], $cands[$j])
                    }
                }
            }
        }

        if (-not $bestPair -or $bestCov -le [Math]::Floor($allTplNames.Count / 2)) { continue }

        # Extend to 3+ disjoint renderings (greedy from the pair)
        $disjointSet = [System.Collections.ArrayList]@()
        foreach ($p in $bestPair) { [void]$disjointSet.Add($p) }
        $pairIdSet = @{}
        foreach ($p in $bestPair) { $pairIdSet[$p.renderingId] = $true }
        foreach ($c in $cands) {
            if ($pairIdSet.ContainsKey($c.renderingId)) { continue }
            if ($c.templateCount -lt 2) { continue }
            $isDisjoint = $true
            foreach ($existing in $disjointSet) {
                $exSet = @{}
                foreach ($t in $existing.templates) { $exSet[$t] = $true }
                foreach ($t in $c.templates) {
                    if ($exSet.ContainsKey($t)) { $isDisjoint = $false; break }
                }
                if (-not $isDisjoint) { break }
            }
            if ($isDisjoint) { [void]$disjointSet.Add($c) }
        }

        # Build a TemplateGroup for each rendering in the disjoint set
        foreach ($navR in $disjointSet) {
            $grpTpls = @($navR.templates)
            $grpSet = @{}
            foreach ($t in $grpTpls) { $grpSet[$t] = $true }

            # Step 3: Find structural exclusions within this group
            # A template is excluded if a commonly-used rendering (>50% of group) has it
            # in a NESTING_SPLIT minority — meaning the template has a fundamentally
            # different placeholder nesting structure for that rendering.
            $exclMap = @{}
            foreach ($entry in $renderingSummary) {
                if ($entry.placeholderVariants.Count -le 1) { continue }
                if ($entry.renderingId -eq $navR.renderingId) { continue }

                $sorted = @($entry.placeholderVariants | Sort-Object -Property count -Descending)
                $majV = $sorted[0]
                $majTplSet = @{}
                foreach ($t in $majV.templates) { $majTplSet[$t] = $true }

                # Count how many group templates are in the majority variant
                $grpInMaj = 0
                foreach ($t in $grpTpls) {
                    if ($majTplSet.ContainsKey($t)) { $grpInMaj++ }
                }
                # Only flag if this rendering is common in the group (>50% in majority)
                if ($grpInMaj -lt [Math]::Ceiling($grpTpls.Count / 2.0)) { continue }

                # Find minority templates that are in this group
                for ($vi = 1; $vi -lt $sorted.Count; $vi++) {
                    foreach ($mt in $sorted[$vi].templates) {
                        if ($grpSet.ContainsKey($mt)) {
                            if (-not $exclMap.ContainsKey($mt)) {
                                $exclMap[$mt] = [System.Collections.ArrayList]@()
                            }
                            [void]$exclMap[$mt].Add("$($entry.name) at '$($sorted[$vi].pattern)' vs majority at '$($majV.pattern)'")
                        }
                    }
                }
            }

            # Build structural exclusions array
            $structExcl = [System.Collections.ArrayList]@()
            foreach ($tpl in ($exclMap.Keys | Sort-Object)) {
                [void]$structExcl.Add([PSCustomObject]@{
                    template = $tpl
                    reasons  = @($exclMap[$tpl])
                })
            }

            # Compute post-exclusion template list
            $postExclTpls = @($grpTpls | Where-Object { -not $exclMap.ContainsKey($_) } | Sort-Object)
            $postExclSet = @{}
            foreach ($t in $postExclTpls) { $postExclSet[$t] = $true }

            # Step 4: Compute rendering coverage for post-exclusion group
            $covList = [System.Collections.ArrayList]@()
            foreach ($entry in $renderingSummary) {
                if ($entry.renderingId -eq $navR.renderingId) { continue }
                # Count intersection: rendering templates ∩ post-exclusion group templates
                $covers = 0
                foreach ($t in $entry.templates) {
                    if ($postExclSet.ContainsKey($t)) { $covers++ }
                }
                if ($covers -eq 0) { continue }
                # Find missing: group templates NOT in rendering's template list
                $rTplSet = @{}
                foreach ($t in $entry.templates) { $rTplSet[$t] = $true }
                $missingArr = [System.Collections.ArrayList]@()
                foreach ($t in $postExclTpls) {
                    if (-not $rTplSet.ContainsKey($t)) { [void]$missingArr.Add($t) }
                }
                [void]$covList.Add([PSCustomObject]@{
                    renderingId = $entry.renderingId
                    name        = $entry.name
                    covers      = $covers
                    total       = $postExclTpls.Count
                    missing     = @($missingArr)
                })
            }
            $covList = @($covList | Sort-Object -Property covers -Descending)

            foreach ($t in $grpTpls) { $assignedTemplates[$t] = $true }

            [void]$templateGroups.Add([PSCustomObject]@{
                partitionRendering     = [PSCustomObject]@{
                    renderingId = $navR.renderingId
                    name        = $navR.name
                }
                placeholder            = $ph
                templates              = @($grpTpls | Sort-Object)
                templateCount          = $grpTpls.Count
                structuralExclusions   = $structExcl
                postExclusionTemplates = $postExclTpls
                postExclusionCount     = $postExclTpls.Count
                renderingCoverage      = $covList
            })
        }
    }

    $ungroupedTpls = @($allTplNames | Where-Object { -not $assignedTemplates.ContainsKey($_) } | Sort-Object)

    # ── Step 5: Identify universal renderings (present on ALL templates with renderings) ──
    $universalRenderings = [System.Collections.ArrayList]@()
    if ($withRenderings.Count -gt 0) {
        foreach ($entry in $renderingSummary) {
            if ($entry.templateCount -ge $withRenderings.Count) {
                [void]$universalRenderings.Add([PSCustomObject]@{
                    renderingId   = $entry.renderingId
                    name          = $entry.name
                    templateCount = $entry.templateCount
                })
            }
        }
    }

    # ── Step 6: Fingerprint-based Page Design suggestions per TemplateGroup ──
    # Groups templates by their exact rendering set on Standard Values.
    # Eliminates coverage-threshold guesswork — each unique fingerprint = a Page Design suggestion.
    $tplByName = @{}
    foreach ($t in $templates) { if ($t.name) { $tplByName[$t.name] = $t } }

    foreach ($grp in $templateGroups) {
        # 6a. Identify renderings common to ALL post-exclusion templates
        $common = [System.Collections.ArrayList]@()
        [void]$common.Add([PSCustomObject]@{
            renderingId = $grp.partitionRendering.renderingId
            name        = $grp.partitionRendering.name
        })
        foreach ($cov in $grp.renderingCoverage) {
            if ($cov.covers -eq $cov.total) {
                [void]$common.Add([PSCustomObject]@{
                    renderingId = $cov.renderingId
                    name        = $cov.name
                })
            }
        }
        $grp | Add-Member -NotePropertyName "commonRenderings" -NotePropertyValue $common

        # 6b. Compute per-template rendering fingerprint — ALL non-nested placeholders
        # Per F61/F62: ALL renderings need Partial Designs or Page Branches, so the
        # fingerprint must capture the complete SV rendering set. This ensures templates
        # with different body content get different Page Design suggestions.
        # Still filter out nested placeholders (starting with /) as these are
        # sub-placeholder instances, not top-level placement targets.

        $fpMap = @{}
        foreach ($tplName in $grp.postExclusionTemplates) {
            $tplObj = $tplByName[$tplName]
            if (-not $tplObj) { continue }
            $ridSet = @{}
            foreach ($r in $tplObj.renderings) {
                if (-not $r.itemId) { continue }
                # Include renderings at ALL non-nested placeholders (F61: SVs should be empty)
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if (-not $rPh -or $rPh.StartsWith("/")) { continue }
                $ridSet[$r.itemId.ToUpperInvariant()] = $true
            }
            $fp = ($ridSet.Keys | Sort-Object) -join "|"
            if (-not $fpMap.ContainsKey($fp)) {
                $fpMap[$fp] = @{
                    templates    = [System.Collections.ArrayList]@()
                    renderingIds = $ridSet
                }
            }
            [void]$fpMap[$fp].templates.Add($tplName)
        }

        # 6c. Build Page Design suggestions from fingerprint groups
        $commonIdSet = @{}
        foreach ($c in $common) { $commonIdSet[$c.renderingId.ToUpperInvariant()] = $true }
        $suggestions = [System.Collections.ArrayList]@()
        foreach ($fpKey in $fpMap.Keys) {
            $fpData = $fpMap[$fpKey]
            # Renderings in this fingerprint beyond the common set
            $diffs = [System.Collections.ArrayList]@()
            foreach ($rid in $fpData.renderingIds.Keys) {
                if (-not $commonIdSet.ContainsKey($rid)) {
                    $rEntry = $renderingSummary | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid } | Select-Object -First 1
                    [void]$diffs.Add([PSCustomObject]@{
                        renderingId = if ($rEntry) { $rEntry.renderingId } else { $rid }
                        name        = if ($rEntry) { $rEntry.name } else { $rid }
                    })
                }
            }
            # Renderings absent from this fingerprint but present in other groups' fingerprints
            $absent = [System.Collections.ArrayList]@()
            $absentSeen = @{}
            foreach ($otherFpKey in $fpMap.Keys) {
                if ($otherFpKey -eq $fpKey) { continue }
                foreach ($rid in $fpMap[$otherFpKey].renderingIds.Keys) {
                    if (-not $commonIdSet.ContainsKey($rid) -and -not $fpData.renderingIds.ContainsKey($rid) -and -not $absentSeen.ContainsKey($rid)) {
                        $absentSeen[$rid] = $true
                        $rEntry = $renderingSummary | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid } | Select-Object -First 1
                        [void]$absent.Add([PSCustomObject]@{
                            renderingId = if ($rEntry) { $rEntry.renderingId } else { $rid }
                            name        = if ($rEntry) { $rEntry.name } else { $rid }
                        })
                    }
                }
            }
            [void]$suggestions.Add([PSCustomObject]@{
                name                      = $null
                templates                 = @($fpData.templates | Sort-Object)
                templateCount             = $fpData.templates.Count
                differentiatingRenderings = $diffs
                absentRenderings          = $absent
            })
        }
        $suggestions = @($suggestions | Sort-Object -Property templateCount -Descending)
        $grp | Add-Member -NotePropertyName "pageDesignSuggestions" -NotePropertyValue $suggestions
    }

    # ── Step 6d: Analyze structurally excluded templates ──
    # Templates excluded from main groups via NESTING_SPLIT are collected and analyzed.
    # Fingerprinted at partial-relevant placeholders, grouped by identical fingerprint,
    # with overlap detection against main groups' common renderings.
    $allExcludedSet = @{}
    $excludedFromGroup = @{}
    for ($gi = 0; $gi -lt $templateGroups.Count; $gi++) {
        $grpRef = $templateGroups[$gi]
        foreach ($excl in $grpRef.structuralExclusions) {
            $allExcludedSet[$excl.template] = $true
            $excludedFromGroup[$excl.template] = [PSCustomObject]@{
                groupIndex         = $gi
                partitionRendering = $grpRef.partitionRendering.name
                placeholder        = $grpRef.placeholder
                reasons            = $excl.reasons
            }
        }
    }

    $excludedTemplateGroups = [System.Collections.ArrayList]@()
    if ($allExcludedSet.Count -gt 0) {
        $excludedNames = @($allExcludedSet.Keys | Sort-Object)
        $debug += "Step 6d: Analyzing $($excludedNames.Count) excluded templates: $($excludedNames -join ', ')"

        # Fingerprint each excluded template at partial-relevant placeholders
        $exFpMap = @{}
        foreach ($tplName in $excludedNames) {
            $tplObj = $tplByName[$tplName]
            if (-not $tplObj) { continue }
            $ridSet = @{}
            foreach ($r in $tplObj.renderings) {
                if (-not $r.itemId) { continue }
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if (-not $rPh -or $rPh.StartsWith("/")) { continue }
                $ridSet[$r.itemId.ToUpperInvariant()] = $true
            }
            $fp = ($ridSet.Keys | Sort-Object) -join "|"
            if (-not $exFpMap.ContainsKey($fp)) {
                $exFpMap[$fp] = @{
                    templates    = [System.Collections.ArrayList]@()
                    renderingIds = $ridSet
                }
            }
            [void]$exFpMap[$fp].templates.Add($tplName)
        }

        # Gather main groups' common rendering ID sets for overlap detection
        $mainGroupCommons = [System.Collections.ArrayList]@()
        for ($gi = 0; $gi -lt $templateGroups.Count; $gi++) {
            $mgcGrp = $templateGroups[$gi]
            $cSet = @{}
            foreach ($cr in $mgcGrp.commonRenderings) { $cSet[$cr.renderingId.ToUpperInvariant()] = $true }
            [void]$mainGroupCommons.Add(@{
                groupIndex = $gi
                name       = $mgcGrp.partitionRendering.name
                ids        = $cSet
            })
        }

        foreach ($fpKey in $exFpMap.Keys) {
            $fpData = $exFpMap[$fpKey]
            $sortedTpls = @($fpData.templates | Sort-Object)

            # Build rendering list with names
            $exRenderings = [System.Collections.ArrayList]@()
            foreach ($rid in ($fpData.renderingIds.Keys | Sort-Object)) {
                $rEntry = $renderingSummary | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid } | Select-Object -First 1
                [void]$exRenderings.Add([PSCustomObject]@{
                    renderingId = if ($rEntry) { $rEntry.renderingId } else { $rid }
                    name        = if ($rEntry) { $rEntry.name } else { $rid }
                })
            }

            # Compute overlap with each main group's common renderings
            $mainOverlap = [System.Collections.ArrayList]@()
            foreach ($mgc in $mainGroupCommons) {
                $shared = 0
                foreach ($rid in $fpData.renderingIds.Keys) {
                    if ($mgc.ids.ContainsKey($rid)) { $shared++ }
                }
                if ($shared -gt 0) {
                    [void]$mainOverlap.Add([PSCustomObject]@{
                        groupIndex         = $mgc.groupIndex
                        groupName          = $mgc.name
                        sharedCount        = $shared
                        groupCommonCount   = $mgc.ids.Count
                        thisRenderingCount = $fpData.renderingIds.Count
                    })
                }
            }

            # Exclusion context: why each template was excluded from its original group
            $exclCtx = [System.Collections.ArrayList]@()
            foreach ($tpl in $sortedTpls) {
                if ($excludedFromGroup.ContainsKey($tpl)) {
                    [void]$exclCtx.Add([PSCustomObject]@{
                        template           = $tpl
                        partitionRendering = $excludedFromGroup[$tpl].partitionRendering
                        placeholder        = $excludedFromGroup[$tpl].placeholder
                        reasons            = $excludedFromGroup[$tpl].reasons
                    })
                }
            }

            [void]$excludedTemplateGroups.Add([PSCustomObject]@{
                templates        = $sortedTpls
                templateCount    = $sortedTpls.Count
                renderings       = $exRenderings
                renderingCount   = $exRenderings.Count
                mainGroupOverlap = $mainOverlap
                exclusionContext = $exclCtx
            })
        }
        $excludedTemplateGroups = @($excludedTemplateGroups | Sort-Object -Property templateCount -Descending)
        $debug += "Step 6d: Created $($excludedTemplateGroups.Count) excluded group(s) from $($excludedNames.Count) templates"
    }

    # ── Step 7: Per-placeholder variance analysis + subset catalog ──
    # For each TemplateGroup, enumerate all pages of each template under the site,
    # compare their shared layout renderings to the template SV at each top-level
    # placeholder, classify as identical/superset/subset/divergent.
    # Subset pages (fewer renderings than SV) are written to a server-side JSON file
    # that the analysis producer (analysis/stage-files) stages into
    # agent-data/discovery/<siteRoot>/ for downstream agents to read from the substrate.
    $renderingsFieldId = "{F1A1FE9E-A60C-4DDB-A3A0-BB5B29FE732E}"
    $device = Get-LayoutDevice -Default
    $allSubsetPages = [System.Collections.ArrayList]@()
    $debug += "Step 7: Starting per-placeholder variance analysis for $($templateGroups.Count) group(s)"

    # Enumerate all descendants under Home ONCE — reuse for all templates.
    # Also include the Home item itself since Get-ChildItem -Recurse only returns
    # children, not the starting item. Without this, Home would have pageCount=0.
    $homeItem = Get-Item -Path "master:$sitePath/Home" -ErrorAction SilentlyContinue
    $allDescendants = @()
    if ($homeItem) {
        $allDescendants = @(Get-ChildItem -Path $homeItem.Paths.FullPath -Recurse)
        $debug += "Step 7: Enumerated $($allDescendants.Count) descendants under Home (+ Home itself)"
    } else {
        $debug += "Step 7: WARNING — Home item not found at $sitePath/Home, skipping variance"
    }

    # Index descendants by template ID for O(1) lookup per template
    $descendantsByTplId = @{}
    # Add the Home item itself — SXA sites always have Home
    if ($homeItem) {
        $hTplId = $homeItem.TemplateID.ToString()
        $descendantsByTplId[$hTplId] = [System.Collections.ArrayList]@()
        [void]$descendantsByTplId[$hTplId].Add($homeItem)
    }
    foreach ($desc in $allDescendants) {
        $tplIdStr = $desc.TemplateID.ToString()
        if (-not $descendantsByTplId.ContainsKey($tplIdStr)) {
            $descendantsByTplId[$tplIdStr] = [System.Collections.ArrayList]@()
        }
        [void]$descendantsByTplId[$tplIdStr].Add($desc)
    }

    foreach ($grp in $templateGroups) {
        # Collect all non-nested placeholders for this group from SV renderings (F61: all need coverage)
        $grpTopPhs = @{}
        foreach ($tplName in $grp.postExclusionTemplates) {
            $tplObj = $tplByName[$tplName]
            if (-not $tplObj) { continue }
            foreach ($r in $tplObj.renderings) {
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if ($rPh -and -not $rPh.StartsWith("/")) {
                    $grpTopPhs[$rPh] = $true
                }
            }
        }
        $grpTopPhList = @($grpTopPhs.Keys | Sort-Object)

        $varianceStats = [System.Collections.ArrayList]@()
        $grpGhostPhs = [System.Collections.ArrayList]@()

        foreach ($tplName in $grp.postExclusionTemplates) {
            $tplObj = $tplByName[$tplName]
            if (-not $tplObj -or -not $tplObj.id) { continue }

            # Get SV renderings per top-level placeholder
            $svByPh = @{}
            foreach ($r in $tplObj.renderings) {
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if (-not $rPh -or $rPh.StartsWith("/") -or -not $grpTopPhs.ContainsKey($rPh)) { continue }
                if (-not $svByPh.ContainsKey($rPh)) { $svByPh[$rPh] = [System.Collections.ArrayList]@() }
                [void]$svByPh[$rPh].Add($r.itemId.ToUpperInvariant())
            }
            # Sort SV IDs for consistent fingerprinting
            foreach ($phKey in @($svByPh.Keys)) {
                $svByPh[$phKey] = @($svByPh[$phKey] | Sort-Object)
            }

            # Find pages of this template with __Renderings populated
            $tplIdStr = $tplObj.id
            $pagesForTpl = @()
            if ($descendantsByTplId.ContainsKey($tplIdStr)) {
                $pagesForTpl = @($descendantsByTplId[$tplIdStr] | Where-Object {
                    $_.Fields[$renderingsFieldId].Value -and
                    $_.Fields[$renderingsFieldId].Value.Trim() -ne ""
                })
            }

            foreach ($phKey in $grpTopPhList) {
                $svIds = @()
                if ($svByPh.ContainsKey($phKey)) { $svIds = $svByPh[$phKey] }
                if ($svIds.Count -eq 0) { continue }

                $svFp = $svIds -join "|"
                $svIdSet = @{}
                foreach ($sid in $svIds) { $svIdSet[$sid] = $true }

                $stats = @{ identical = 0; subset = 0; superset = 0; divergent = 0; noRenderings = 0 }

                foreach ($page in $pagesForTpl) {
                    $pageRenderings = @(Get-Rendering -Item $page -Device $device -FinalLayout)
                    $pageIds = @($pageRenderings | Where-Object { $_.Placeholder -eq $phKey } | ForEach-Object { $_.ItemID.ToUpperInvariant() } | Sort-Object)
                    $pageFp = $pageIds -join "|"

                    if ($pageIds.Count -eq 0) {
                        $stats.noRenderings++
                    } elseif ($pageFp -eq $svFp) {
                        $stats.identical++
                    } else {
                        $pageIdSet = @{}; foreach ($pgId in $pageIds) { $pageIdSet[$pgId] = $true }
                        $hasExtra = $false; $hasMissing = $false
                        foreach ($pgId in $pageIdSet.Keys) {
                            if (-not $svIdSet.ContainsKey($pgId)) { $hasExtra = $true; break }
                        }
                        foreach ($sid in $svIdSet.Keys) {
                            if (-not $pageIdSet.ContainsKey($sid)) { $hasMissing = $true; break }
                        }
                        if ($hasMissing -and $hasExtra) {
                            $stats.divergent++
                        } elseif ($hasMissing) {
                            $stats.subset++
                            # Catalog this subset page
                            $missingIds = [System.Collections.ArrayList]@()
                            foreach ($sid in $svIdSet.Keys) {
                                if (-not $pageIdSet.ContainsKey($sid)) { [void]$missingIds.Add($sid) }
                            }
                            [void]$allSubsetPages.Add([PSCustomObject]@{
                                pagePath            = $page.Paths.FullPath
                                templateName        = $tplName
                                placeholder         = $phKey
                                presentRenderingIds = @($pageIds)
                                missingRenderingIds = @($missingIds | Sort-Object)
                            })
                        } elseif ($hasExtra) {
                            $stats.superset++
                        } else {
                            $stats.identical++
                        }
                    }
                }

                # Detect ghost placeholder: SV has renderings but 0 pages use this placeholder
                $isGhost = ($pagesForTpl.Count -gt 0 -and $stats.identical -eq 0 -and $stats.superset -eq 0 -and $stats.subset -eq 0 -and $stats.divergent -eq 0 -and $stats.noRenderings -eq $pagesForTpl.Count)

                # F62: Classify suggested tier based on identical%
                $identPct = if ($pagesForTpl.Count -gt 0) { [math]::Round(($stats.identical / $pagesForTpl.Count) * 100, 1) } else { 0 }
                $tier = "noPages"
                if ($pagesForTpl.Count -gt 0) {
                    if ($isGhost) { $tier = "ghost" }
                    elseif ($identPct -ge 95) { $tier = "partial" }
                    else { $tier = "pageBranch" }
                }

                [void]$varianceStats.Add([PSCustomObject]@{
                    templateName     = $tplName
                    placeholder      = $phKey
                    svRenderingCount = $svIds.Count
                    pageCount        = $pagesForTpl.Count
                    identical        = $stats.identical
                    superset         = $stats.superset
                    subset           = $stats.subset
                    divergent        = $stats.divergent
                    noRenderings     = $stats.noRenderings
                    identicalPct     = $identPct
                    isGhost          = $isGhost
                    suggestedTier    = $tier
                })

                if ($isGhost) {
                    [void]$grpGhostPhs.Add([PSCustomObject]@{
                        templateName     = $tplName
                        placeholder      = $phKey
                        svRenderingCount = $svIds.Count
                        svRenderingIds   = @($svIds)
                    })
                }
            }
        }

        # F62: Build per-placeholder tier summary for this group
        # Aggregates variance stats into a per-placeholder recommendation:
        # - "partial" if ALL templates at that placeholder are >= 95% identical
        # - "pageBranch" if ANY template has < 95% identical (editors customize)
        # - "ghost" if ALL templates are ghost at this placeholder
        $phTierSummary = [System.Collections.ArrayList]@()
        $phGroups = $varianceStats | Group-Object -Property placeholder
        foreach ($phGrp in $phGroups) {
            $phTiers = @($phGrp.Group | Select-Object -ExpandProperty suggestedTier)
            $aggTier = "partial"
            if (($phTiers | Where-Object { $_ -eq "pageBranch" }).Count -gt 0) {
                $aggTier = "pageBranch"
            } elseif (($phTiers | Where-Object { $_ -eq "ghost" }).Count -eq $phTiers.Count) {
                $aggTier = "ghost"
            }
            # Collect SV rendering IDs at this placeholder for pageBranch cases
            $phRenderingIds = [System.Collections.ArrayList]@()
            if ($aggTier -eq "pageBranch") {
                foreach ($tplName in $grp.postExclusionTemplates) {
                    $tplObj = $tplByName[$tplName]
                    if (-not $tplObj) { continue }
                    foreach ($r in $tplObj.renderings) {
                        $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                        if ($rPh -eq $phGrp.Name -and $r.itemId) {
                            $rid = $r.itemId.ToUpperInvariant()
                            if (-not ($phRenderingIds | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid })) {
                                $rEntry = $renderingSummary | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid } | Select-Object -First 1
                                [void]$phRenderingIds.Add([PSCustomObject]@{
                                    renderingId = if ($rEntry) { $rEntry.renderingId } else { $r.itemId }
                                    name        = if ($rEntry) { $rEntry.name } else { $r.itemId }
                                })
                            }
                        }
                    }
                }
            }
            [void]$phTierSummary.Add([PSCustomObject]@{
                placeholder = $phGrp.Name
                suggestedTier = $aggTier
                templateCount = $phGrp.Count
                pageBranchRenderings = @($phRenderingIds)
            })
        }

        $grp | Add-Member -NotePropertyName "varianceStats" -NotePropertyValue @($varianceStats)
        $grp | Add-Member -NotePropertyName "ghostPlaceholders" -NotePropertyValue @($grpGhostPhs)
        $grp | Add-Member -NotePropertyName "placeholderTierSummary" -NotePropertyValue @($phTierSummary)
    }

    # ── Step 7b: Variance analysis for excluded template groups ──
    foreach ($exGrp in $excludedTemplateGroups) {
        $exTopPhs = @{}
        foreach ($tplName in $exGrp.templates) {
            $tplObj = $tplByName[$tplName]
            if (-not $tplObj) { continue }
            foreach ($r in $tplObj.renderings) {
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if ($rPh -and -not $rPh.StartsWith("/")) {
                    $exTopPhs[$rPh] = $true
                }
            }
        }
        $exTopPhList = @($exTopPhs.Keys | Sort-Object)

        $exVarianceStats = [System.Collections.ArrayList]@()
        $exGhostPhs = [System.Collections.ArrayList]@()

        foreach ($tplName in $exGrp.templates) {
            $tplObj = $tplByName[$tplName]
            if (-not $tplObj -or -not $tplObj.id) { continue }

            $svByPh = @{}
            foreach ($r in $tplObj.renderings) {
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if (-not $rPh -or $rPh.StartsWith("/") -or -not $exTopPhs.ContainsKey($rPh)) { continue }
                if (-not $svByPh.ContainsKey($rPh)) { $svByPh[$rPh] = [System.Collections.ArrayList]@() }
                [void]$svByPh[$rPh].Add($r.itemId.ToUpperInvariant())
            }
            foreach ($phKey in @($svByPh.Keys)) {
                $svByPh[$phKey] = @($svByPh[$phKey] | Sort-Object)
            }

            $tplIdStr = $tplObj.id
            $pagesForTpl = @()
            if ($descendantsByTplId.ContainsKey($tplIdStr)) {
                $pagesForTpl = @($descendantsByTplId[$tplIdStr] | Where-Object {
                    $_.Fields[$renderingsFieldId].Value -and
                    $_.Fields[$renderingsFieldId].Value.Trim() -ne ""
                })
            }

            foreach ($phKey in $exTopPhList) {
                $svIds = @()
                if ($svByPh.ContainsKey($phKey)) { $svIds = $svByPh[$phKey] }
                if ($svIds.Count -eq 0) { continue }

                $svFp = $svIds -join "|"
                $svIdSet = @{}
                foreach ($sid in $svIds) { $svIdSet[$sid] = $true }

                $stats = @{ identical = 0; subset = 0; superset = 0; divergent = 0; noRenderings = 0 }

                foreach ($page in $pagesForTpl) {
                    $pageRenderings = @(Get-Rendering -Item $page -Device $device -FinalLayout)
                    $pageIds = @($pageRenderings | Where-Object { $_.Placeholder -eq $phKey } | ForEach-Object { $_.ItemID.ToUpperInvariant() } | Sort-Object)
                    $pageFp = $pageIds -join "|"

                    if ($pageIds.Count -eq 0) {
                        $stats.noRenderings++
                    } elseif ($pageFp -eq $svFp) {
                        $stats.identical++
                    } else {
                        $pageIdSet = @{}; foreach ($pgId in $pageIds) { $pageIdSet[$pgId] = $true }
                        $hasExtra = $false; $hasMissing = $false
                        foreach ($pgId in $pageIdSet.Keys) {
                            if (-not $svIdSet.ContainsKey($pgId)) { $hasExtra = $true; break }
                        }
                        foreach ($sid in $svIdSet.Keys) {
                            if (-not $pageIdSet.ContainsKey($sid)) { $hasMissing = $true; break }
                        }
                        if ($hasMissing -and $hasExtra) { $stats.divergent++ }
                        elseif ($hasMissing) {
                            $stats.subset++
                            $missingIds = [System.Collections.ArrayList]@()
                            foreach ($sid in $svIdSet.Keys) {
                                if (-not $pageIdSet.ContainsKey($sid)) { [void]$missingIds.Add($sid) }
                            }
                            [void]$allSubsetPages.Add([PSCustomObject]@{
                                pagePath            = $page.Paths.FullPath
                                templateName        = $tplName
                                placeholder         = $phKey
                                presentRenderingIds = @($pageIds)
                                missingRenderingIds = @($missingIds | Sort-Object)
                            })
                        }
                        elseif ($hasExtra) { $stats.superset++ }
                        else { $stats.identical++ }
                    }
                }

                $isGhost = ($pagesForTpl.Count -gt 0 -and $stats.identical -eq 0 -and $stats.superset -eq 0 -and $stats.subset -eq 0 -and $stats.divergent -eq 0 -and $stats.noRenderings -eq $pagesForTpl.Count)

                # F62: Classify suggested tier
                $identPct = if ($pagesForTpl.Count -gt 0) { [math]::Round(($stats.identical / $pagesForTpl.Count) * 100, 1) } else { 0 }
                $tier = "noPages"
                if ($pagesForTpl.Count -gt 0) {
                    if ($isGhost) { $tier = "ghost" }
                    elseif ($identPct -ge 95) { $tier = "partial" }
                    else { $tier = "pageBranch" }
                }

                [void]$exVarianceStats.Add([PSCustomObject]@{
                    templateName     = $tplName
                    placeholder      = $phKey
                    svRenderingCount = $svIds.Count
                    pageCount        = $pagesForTpl.Count
                    identical        = $stats.identical
                    superset         = $stats.superset
                    subset           = $stats.subset
                    divergent        = $stats.divergent
                    noRenderings     = $stats.noRenderings
                    identicalPct     = $identPct
                    isGhost          = $isGhost
                    suggestedTier    = $tier
                })

                if ($isGhost) {
                    [void]$exGhostPhs.Add([PSCustomObject]@{
                        templateName     = $tplName
                        placeholder      = $phKey
                        svRenderingCount = $svIds.Count
                        svRenderingIds   = @($svIds)
                    })
                }
            }
        }

        # F62: Build per-placeholder tier summary for excluded group
        $exPhTierSummary = [System.Collections.ArrayList]@()
        $exPhGroups = $exVarianceStats | Group-Object -Property placeholder
        foreach ($phGrp in $exPhGroups) {
            $phTiers = @($phGrp.Group | Select-Object -ExpandProperty suggestedTier)
            $aggTier = "partial"
            if (($phTiers | Where-Object { $_ -eq "pageBranch" }).Count -gt 0) {
                $aggTier = "pageBranch"
            } elseif (($phTiers | Where-Object { $_ -eq "ghost" }).Count -eq $phTiers.Count) {
                $aggTier = "ghost"
            }
            $phRenderingIds = [System.Collections.ArrayList]@()
            if ($aggTier -eq "pageBranch") {
                foreach ($tplName in $exGrp.templates) {
                    $tplObj = $tplByName[$tplName]
                    if (-not $tplObj) { continue }
                    foreach ($r in $tplObj.renderings) {
                        $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                        if ($rPh -eq $phGrp.Name -and $r.itemId) {
                            $rid = $r.itemId.ToUpperInvariant()
                            if (-not ($phRenderingIds | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid })) {
                                $rEntry = $renderingSummary | Where-Object { $_.renderingId.ToUpperInvariant() -eq $rid } | Select-Object -First 1
                                [void]$phRenderingIds.Add([PSCustomObject]@{
                                    renderingId = if ($rEntry) { $rEntry.renderingId } else { $r.itemId }
                                    name        = if ($rEntry) { $rEntry.name } else { $r.itemId }
                                })
                            }
                        }
                    }
                }
            }
            [void]$exPhTierSummary.Add([PSCustomObject]@{
                placeholder = $phGrp.Name
                suggestedTier = $aggTier
                templateCount = $phGrp.Count
                pageBranchRenderings = @($phRenderingIds)
            })
        }

        $exGrp | Add-Member -NotePropertyName "varianceStats" -NotePropertyValue @($exVarianceStats)
        $exGrp | Add-Member -NotePropertyName "ghostPlaceholders" -NotePropertyValue @($exGhostPhs)
        $exGrp | Add-Member -NotePropertyName "placeholderTierSummary" -NotePropertyValue @($exPhTierSummary)
    }
    $debug += "Step 7b: Variance analysis complete for $($excludedTemplateGroups.Count) excluded group(s)"

    # ── Step 7c: PD Compatibility Classification (W82) ──
    # PURPOSE: Prevents data loss / data inflation caused by putting editor-customized
    # renderings onto Partial Designs. When a rendering moves to a PD, ALL pages of ALL
    # templates sharing that PD see the same rendering. If even one page had deleted or
    # overridden that rendering, moving it to a PD would "resurrect" or "override-back"
    # the content — breaking that page.
    #
    # CLASSIFICATION RULES:
    # - Query-ds renderings (SV datasource starts with query:) → always compatible (F138)
    #   The datasource is a query expression resolved at render time per page context.
    #   The rendering content differs per page even though the SV datasource is identical.
    # - Zero modifications across all pages → compatible ("universal")
    #   All pages show the same rendering from SV → safe to centralize on PD.
    # - ANY page deletion OR genuine ds/param override → incompatible ("modified")
    #   Zero tolerance. Even 1 page out of 1000 makes it incompatible.
    #
    # SCOPE: Scans ALL SV renderings (both top-level and nested). A nested rendering
    # whose parent is PD-compatible can itself be PD-incompatible.
    #
    # KEY EXAMPLES FROM AUDIT (MySite site):
    #   Hero Banner:        PD-INCOMPATIBLE — 871 per-page deletions/overrides across 11 templates
    #   Intro One Column:   PD-INCOMPATIBLE — 525 across 4 templates
    #   Articles Rollup:    PD-INCOMPATIBLE — 295 across 1 template
    #   Basic CTA:          PD-COMPATIBLE   — query-ds, all 1464 "overrides" are query resolution
    #
    # OUTPUT: pdCompatResults[] with per-rendering classification fed into Step 8b.
    # pdIncompatUidsByTemplate{} consumed in Step 8b to exclude incompatible UIDs from
    # the PD fingerprint and rendering list.
    $debug += "Step 7c: Starting PD compatibility classification (W82)"
    $pdCompatResults = [System.Collections.ArrayList]@()
    # Set of incompatible rendering UIDs per template for use in Step 8b
    $pdIncompatUidsByTemplate = @{}

    try {
    foreach ($tplObj in $withRenderings) {
        $tplId7c = $tplObj.id
        $tplName7c = $tplObj.name

        # Collect ALL SV renderings (both top-level and nested) as PD-compatibility candidates.
        # W82 fix: nested renderings (e.g., Hero Banner at /lockedtop/navcomponents-{UID}-0)
        # must also be scanned for per-page deletions/overrides. A nested rendering whose
        # parent is PD-compatible can itself be PD-incompatible (pages delete or override it).
        $svCandidates = @($tplObj.renderings | Where-Object {
            $rPh = if ($_.placeholder) { $_.placeholder.Trim() } else { "" }
            $rPh -and $_.uniqueId -and $_.itemId
        })
        if ($svCandidates.Count -eq 0) { continue }

        # [F138] Separate query-ds renderings (always PD-compatible) from those needing page scan.
        # Query-ds renderings use Sitecore's query: protocol which resolves at render time
        # relative to the current page context. This means even though the SV datasource text
        # is identical (e.g., "query:ancestor-or-self::*/Page Components/*[...]"), each page
        # gets different resolved content. A PD-delivered query-ds rendering is therefore
        # functionally equivalent to the SV version — no data loss.
        # CAVEAT (F145): Different templates may have different query expressions for the same
        # rendering slot (e.g., Residence SV uses simpler query, Residence BaV SV uses
        # @@templateid-filtered query). The representative template selection in Step 8c
        # determines which expression ends up on the PD.
        $queryDsRenderings = [System.Collections.ArrayList]@()
        $scanRenderings = [System.Collections.ArrayList]@()
        foreach ($r in $svCandidates) {
            $svDs = Normalize-DataSource ([string]$r.datasource)
            if ($svDs -match '^query:') {
                [void]$queryDsRenderings.Add($r)
            } else {
                [void]$scanRenderings.Add($r)
            }
        }

        # Get pages for this template (reuse descendant index from Step 7)
        $pagesForTpl7c = @()
        if ($descendantsByTplId.ContainsKey($tplId7c)) {
            $pagesForTpl7c = @($descendantsByTplId[$tplId7c] | Where-Object {
                $_.Fields[$renderingsFieldId].Value -and
                $_.Fields[$renderingsFieldId].Value.Trim() -ne ""
            })
        }

        # Build lookup for renderings that need page scanning
        $uidCheck = @{}
        foreach ($r in $scanRenderings) {
            if (-not $r.uniqueId) { continue }
            $uid = $r.uniqueId.ToString().ToUpperInvariant()
            $uidCheck[$uid] = @{
                rendering      = $r
                ds             = Normalize-DataSource ([string]$r.datasource)
                params         = Normalize-RenderingParams $r.parameters
                incompatible   = $false
                deletions      = 0
                dsOverrides    = 0
                paramOverrides = 0
            }
        }

        # Scan pages — short-circuit per rendering once any modification found
        $scannedCount = 0
        if ($pagesForTpl7c.Count -gt 0 -and $uidCheck.Count -gt 0) {
            foreach ($page in $pagesForTpl7c) {
                $unresolvedUids = @($uidCheck.Keys | Where-Object { -not $uidCheck[$_].incompatible })
                if ($unresolvedUids.Count -eq 0) { break }
                $scannedCount++
                $pageRenderings7c = @(Get-Rendering -Item $page -Device $device -FinalLayout)
                $pageByUid = @{}
                foreach ($pr in $pageRenderings7c) {
                    if ($pr.UniqueId) {
                        $prUid = $pr.UniqueId.ToString().ToUpperInvariant()
                        $pageByUid[$prUid] = $pr
                    }
                }

                foreach ($uid in $unresolvedUids) {
                    $chk = $uidCheck[$uid]
                    if (-not $pageByUid.ContainsKey($uid)) {
                        # Rendering missing from merged layout → page deleted it
                        $chk.deletions++
                        $chk.incompatible = $true
                    } else {
                        $pageR = $pageByUid[$uid]
                        $pageDs = Normalize-DataSource ([string]$pageR.Datasource)
                        if ($pageDs -ne $chk.ds) {
                            $chk.dsOverrides++
                            $chk.incompatible = $true
                        } else {
                            $pageParams = Normalize-RenderingParams $pageR.Parameters
                            if ($pageParams -ne $chk.params) {
                                $chk.paramOverrides++
                                $chk.incompatible = $true
                            }
                        }
                    }
                }
            }
        }

        # Build per-rendering classification
        $rClassifications = [System.Collections.ArrayList]@()
        $incompatUids7c = @{}
        $compatCount7c = 0
        $incompatCount7c = 0

        foreach ($r in $queryDsRenderings) {
            [void]$rClassifications.Add([PSCustomObject]@{
                renderingId  = $r.itemId
                name         = $r.name
                uniqueId     = $r.uniqueId
                placeholder  = $r.placeholder
                pdCompatible = $true
                reason       = "query-ds"
            })
            $compatCount7c++
        }

        foreach ($uid in $uidCheck.Keys) {
            $chk = $uidCheck[$uid]
            $r = $chk.rendering
            $isCompat = -not $chk.incompatible
            if ($isCompat) { $compatCount7c++ } else { $incompatCount7c++ }
            [void]$rClassifications.Add([PSCustomObject]@{
                renderingId    = $r.itemId
                name           = $r.name
                uniqueId       = $r.uniqueId
                placeholder    = $r.placeholder
                pdCompatible   = $isCompat
                reason         = if ($isCompat) { "universal" } else { "modified" }
                deletions      = $chk.deletions
                dsOverrides    = $chk.dsOverrides
                paramOverrides = $chk.paramOverrides
            })
            if (-not $isCompat) {
                if ($r.uniqueId) {
                    $incompatUids7c[$r.uniqueId.ToString().ToUpperInvariant()] = $true
                }
            }
        }

        if ($incompatUids7c.Count -gt 0) {
            $pdIncompatUidsByTemplate[$tplId7c] = $incompatUids7c
        }

        [void]$pdCompatResults.Add([PSCustomObject]@{
            templateId        = $tplId7c
            templateName      = $tplName7c
            pagesScanned      = $scannedCount
            totalPages        = $pagesForTpl7c.Count
            compatibleCount   = $compatCount7c
            incompatibleCount = $incompatCount7c
            queryDsCount      = $queryDsRenderings.Count
            renderings        = @($rClassifications)
        })

        $debug += "  $tplName7c`: $scannedCount/$($pagesForTpl7c.Count) pages scanned, $compatCount7c compat, $incompatCount7c incompat, $($queryDsRenderings.Count) query-ds"
    }
    } catch {
        $debug += "Step 7c ERROR: $($_.Exception.Message)"
        $debug += "Step 7c STACK: $($_.ScriptStackTrace)"
        $debug += "Step 7c LINE: $($_.InvocationInfo.ScriptLineNumber)"
        throw
    }
    $debug += "Step 7c: Classification complete — $($pdCompatResults.Count) templates classified"

    # ── Step 8: Pre-compute Presentation Plan ──
    # This is the EXECUTION CONTRACT consumed by Phase 3 (create-partial-designs)
    # and Phase 4 (migrate-to-page-designs). The plan is deterministic: given the
    # same SV renderings and page data, it produces the same PD/Page Design structure.
    #
    # DATA FLOW:
    #   Step 7c classifies each SV rendering as PD-compatible or PD-incompatible.
    #   Step 8b builds the PD registry, EXCLUDING PD-incompatible renderings.
    #   Step 8c selects a representative template per PD (richest SV) and rebuilds
    #   the rendering list with UIDs from that specific template's SV.
    #   Step 8d groups templates by PD composition fingerprint into Page Designs.
    #   Step 8e builds the flat template → Page Design assignment lookup.
    #
    # The PartialDesigns[] output includes renderingUids from the representative
    # template. create-partial-designs uses these UIDs to filter which renderings
    # to copy (F140 gate). This ensures only PD-compatible renderings end up on PDs.
    #
    # Algorithm:
    #   1. Build ghost set from tier summaries (skip ghost placeholders)
    #   2. Walk every template → register each placeholder×renderingSet as a Partial Design
    #   3. Track each template's PD composition → fingerprint = Page Design
    #   4. Group templates by composition → unique Page Designs
    #   5. Flat template → Page Design lookup

    $debug += "Step 8: Starting presentation plan computation"

    # 8a. Build ghost set: {groupIdx}:{placeholder} for all ghost-tier entries
    $ghostSet = @{}
    for ($gi = 0; $gi -lt $templateGroups.Count; $gi++) {
        $gObj = $templateGroups[$gi]
        if ($gObj.placeholderTierSummary) {
            foreach ($pts in $gObj.placeholderTierSummary) {
                if ($pts.suggestedTier -eq "ghost") {
                    foreach ($tName in $gObj.postExclusionTemplates) {
                        $ghostSet["$tName|$($pts.placeholder)"] = $true
                    }
                }
            }
        }
    }
    for ($ei = 0; $ei -lt $excludedTemplateGroups.Count; $ei++) {
        $eObj = $excludedTemplateGroups[$ei]
        if ($eObj.placeholderTierSummary) {
            foreach ($pts in $eObj.placeholderTierSummary) {
                if ($pts.suggestedTier -eq "ghost") {
                    foreach ($tName in $eObj.templates) {
                        $ghostSet["$tName|$($pts.placeholder)"] = $true
                    }
                }
            }
        }
    }
    $debug += "Step 8a: Ghost set built with $($ghostSet.Count) template×placeholder entries"

    # 8b. Walk every template, build PD registry keyed by placeholder + rendering fingerprint.
    # PD registry: key = "placeholder|sortedRenderingIds" → PD object.
    # INVARIANT: Two templates with the same fingerprint at a placeholder share one PD.
    # Different fingerprints → different PDs → no data leakage between templates.
    # [W82] PD-incompatible rendering UIDs (from Step 7c) are excluded BEFORE fingerprinting.
    # This ensures incompatible renderings don't appear in any PD, staying on template SVs
    # where __Final Renderings can customize them per-page.
    # [F94] Sub-placeholder (nested) renderings are also fingerprinted, because two templates
    # with the same top-level renderings but different nested compositions need different PDs.
    $pdRegistry = @{}
    # Per-template PD composition: templateName → ordered list of PD keys
    $tplPdComposition = @{}

    foreach ($tplObj in $withRenderings) {
        $tplName = $tplObj.name
        $pdKeysForTpl = [System.Collections.ArrayList]@()

        # W82: Build set of PD-incompatible UIDs for this template
        $tplIncompatUids = @{}
        if ($pdIncompatUidsByTemplate.ContainsKey($tplObj.id)) {
            $tplIncompatUids = $pdIncompatUidsByTemplate[$tplObj.id]
        }
        # Track excluded top-level UIDs (without braces) for nested placeholder matching
        $excludedUidPatterns = @{}

        # Group this template's renderings by placeholder (non-nested only)
        # W82: Skip PD-incompatible renderings — they stay on template SV
        $phRenderings = @{}
        foreach ($r in $tplObj.renderings) {
            if (-not $r.itemId) { continue }
            $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
            if (-not $rPh -or $rPh.StartsWith("/")) { continue }
            # W82: Exclude incompatible renderings from PD composition
            if ($r.uniqueId -and $tplIncompatUids.ContainsKey($r.uniqueId.ToString().ToUpperInvariant())) {
                $uidClean = ($r.uniqueId -replace '[{}]', '').ToUpperInvariant()
                $excludedUidPatterns[$uidClean] = $true
                continue
            }
            if (-not $phRenderings.ContainsKey($rPh)) {
                $phRenderings[$rPh] = [System.Collections.ArrayList]@()
            }
            [void]$phRenderings[$rPh].Add($r)
        }

        # F94: Also index nested renderings by their parent top-level placeholder
        # e.g., /lockedbottom/phCTA-{UID}-0 → parent is "lockedbottom"
        # W82: Skip nested renderings whose parent is PD-incompatible
        $nestedByParentPh = @{}
        foreach ($r in $tplObj.renderings) {
            if (-not $r.itemId) { continue }
            $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
            if (-not $rPh -or -not $rPh.StartsWith("/")) { continue }
            # W82: Check if nested rendering's parent UID is excluded
            $skipNested = $false
            $rPhUpper = $rPh.ToUpperInvariant()
            foreach ($exUid in $excludedUidPatterns.Keys) {
                if ($rPhUpper.Contains($exUid)) { $skipNested = $true; break }
            }
            if ($skipNested) { continue }
            # W82: Also check if the nested rendering itself is PD-incompatible
            # (e.g., Hero Banner: parent Residence Navigation is PD-compatible,
            # but Hero Banner itself has per-page ds overrides → must stay on SV)
            if ($r.uniqueId -and $tplIncompatUids.ContainsKey($r.uniqueId.ToString().ToUpperInvariant())) {
                $nestedUidClean = ($r.uniqueId -replace '[{}]', '').ToUpperInvariant()
                $excludedUidPatterns[$nestedUidClean] = $true
                continue
            }
            # Extract parent: /lockedbottom/phCTA-{UID}-0 → lockedbottom
            $segments = $rPh.TrimStart("/").Split("/")
            if ($segments.Count -lt 2) { continue }
            $parentPh = $segments[0]
            if (-not $nestedByParentPh.ContainsKey($parentPh)) {
                $nestedByParentPh[$parentPh] = [System.Collections.ArrayList]@()
            }
            [void]$nestedByParentPh[$parentPh].Add($r)
        }

        # Determine top-level placeholder encounter order from template renderings.
        # This preserves legacy composition order when building Page Design PartialDesigns lists.
        $phEncounter = [System.Collections.ArrayList]@()
        foreach ($r in $tplObj.renderings) {
            $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
            if (-not $rPh) { continue }
            if ($rPh.StartsWith("/")) { continue }
            if ($phEncounter -notcontains $rPh) {
                [void]$phEncounter.Add($rPh)
            }
        }

        # Include any remaining top-level placeholders not seen above (defensive).
        foreach ($phKey in $phRenderings.Keys) {
            if ($phEncounter -notcontains $phKey) {
                [void]$phEncounter.Add($phKey)
            }
        }

        foreach ($phKey in $phEncounter) {
            # Skip ghost placeholders for this template
            if ($ghostSet.ContainsKey("$tplName|$phKey")) { continue }
            # W82: Skip placeholders where all renderings were filtered as PD-incompatible
            if (-not $phRenderings.ContainsKey($phKey)) { continue }

            $renderings = $phRenderings[$phKey]
            # Build fingerprint from ALL rendering signatures at this top-level placeholder.
            # Signature = itemId + datasource + parameters (everything except UniqueId).
            # NOT deduplicated: instance count matters — a template with 2x Submit Datalayer
            # must get a different PD than one with 4x, otherwise one inherits extra renderings.
            # Same itemId with different datasource/parameters = different rendering = different signature.
            # Parameters are normalized (sorted key=value pairs) to prevent ordering-dependent splits.
            $signatures = @($renderings | ForEach-Object {
                $sig = $_.itemId.ToUpperInvariant()
                $ds  = Normalize-DataSource ([string]$_.datasource)
                $p   = Normalize-RenderingParams $_.parameters
                if ($ds) { $sig += "::ds=$ds" }
                if ($p)  { $sig += "::p=$p" }
                $sig
            } | Sort-Object)

            # F94: Append sub-rendering signatures to fingerprint (double-pipe separator)
            # Different sub-rendering compositions → different PDs → no data loss
            $nestedRenderings = @()
            if ($nestedByParentPh.ContainsKey($phKey)) {
                $nestedRenderings = @($nestedByParentPh[$phKey])
            }
            $nestedSigs = @($nestedRenderings | ForEach-Object {
                $sig = $_.itemId.ToUpperInvariant()
                $ds  = Normalize-DataSource ([string]$_.datasource)
                $p   = Normalize-RenderingParams $_.parameters
                if ($ds) { $sig += "::ds=$ds" }
                if ($p)  { $sig += "::p=$p" }
                $sig
            } | Sort-Object)
            $fp = if ($nestedSigs.Count -gt 0) {
                ($signatures -join "|") + "||" + ($nestedSigs -join "|")
            } else {
                ($signatures -join "|")
            }
            $pdKey = "$phKey|$fp"

            if (-not $pdRegistry.ContainsKey($pdKey)) {
                # Placeholder entry for this fingerprint — renderings will be rebuilt
                # from the representative template later (Step 8c) to get correct UIDs.
                $pdRegistry[$pdKey] = [PSCustomObject]@{
                    placeholder       = $phKey
                    fingerprint       = $fp
                    renderings        = @()  # rebuilt in Step 8c from representative template
                    templates         = [System.Collections.ArrayList]@()
                    nestedCount       = $nestedSigs.Count
                }
            }
            # Register this template + track its nested rendering count for representative selection
            $pdObj = $pdRegistry[$pdKey]
            if ($pdObj.templates -notcontains $tplName) {
                [void]$pdObj.templates.Add($tplName)
            }
            [void]$pdKeysForTpl.Add($pdKey)
        }

        $tplPdComposition[$tplName] = @($pdKeysForTpl)
    }
    $debug += "Step 8b: PD registry has $($pdRegistry.Count) entries across $($withRenderings.Count) templates"

    # 8c. Assign names to Partial Designs
    # Group PDs by placeholder to detect when disambiguation is needed
    $pdsByPlaceholder = @{}
    foreach ($pdKey in $pdRegistry.Keys) {
        $pdObj = $pdRegistry[$pdKey]
        $ph = $pdObj.placeholder
        if (-not $pdsByPlaceholder.ContainsKey($ph)) {
            $pdsByPlaceholder[$ph] = [System.Collections.ArrayList]@()
        }
        [void]$pdsByPlaceholder[$ph].Add($pdKey)
    }

    foreach ($ph in $pdsByPlaceholder.Keys) {
        $keys = $pdsByPlaceholder[$ph]
        if ($keys.Count -eq 1) {
            # Single PD at this placeholder — use placeholder name directly
            $pdRegistry[$keys[0]] | Add-Member -NotePropertyName "name" -NotePropertyValue $ph -Force
        } else {
            # Multiple PDs at same placeholder — disambiguate by rendering names
            # Sort by template count descending so the most common gets the cleanest name
            $sorted = @($keys | Sort-Object { $pdRegistry[$_].templates.Count } -Descending)
            $usedNames = @{}
            foreach ($k in $sorted) {
                $pdObj = $pdRegistry[$k]
                # Build suffix from rendering names (first 2 max for brevity)
                $rNames = @($pdObj.renderings | ForEach-Object { $_.name } | Where-Object { $_ } | Select-Object -First 2)
                $suffix = if ($rNames.Count -gt 0) { $rNames -join " + " } else { "variant" }
                $candidate = "$ph - $suffix"
                # Ensure uniqueness
                if ($usedNames.ContainsKey($candidate)) {
                    $idx = 2
                    while ($usedNames.ContainsKey("$candidate $idx")) { $idx++ }
                    $candidate = "$candidate $idx"
                }
                $usedNames[$candidate] = $true
                $pdObj | Add-Member -NotePropertyName "name" -NotePropertyValue $candidate -Force
            }
        }
    }

    # Build sorted PartialDesigns array
    $partialDesigns = [System.Collections.ArrayList]@()
    foreach ($pdKey in ($pdRegistry.Keys | Sort-Object)) {
        $pdObj = $pdRegistry[$pdKey]
        $scope = if ($pdObj.templates.Count -eq $withRenderings.Count) { "universal" } else { "group" }
        # F94: Pick template with most total renderings under this placeholder tree
        # (top-level + nested). Ensures Copy-SubRenderings has the richest source SV.
        # WHY "REPRESENTATIVE": All templates sharing this PD have identical fingerprints
        # (same ItemIDs, datasources, parameters) — they differ only in UniqueIds, which
        # are instance-specific per SV. The representative provides the UIDs that
        # create-partial-designs uses to copy renderings (F140 renderingUids gate).
        # The richest SV (most nested renderings) is chosen so Copy-SubRenderings
        # doesn't miss nested children that exist on one SV but not another.
        # NOTE: Query-ds expressions are part of the fingerprint (via Normalize-DataSource),
        # so templates with different query expressions CANNOT share a PD. The representative
        # selection has no effect on which query-ds text ends up on the PD — all templates
        # in the group already have the same text.
        $phKey = $pdObj.placeholder
        $bestTplName = $null
        $bestCount = -1
        foreach ($candidateName in $pdObj.templates) {
            $candidateObj = $tplByName[$candidateName]
            if (-not $candidateObj) { continue }
            $totalCount = 0
            foreach ($r in $candidateObj.renderings) {
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if ($rPh -eq $phKey -or ($rPh.StartsWith("/") -and $rPh.TrimStart("/").Split("/")[0] -eq $phKey)) {
                    $totalCount++
                }
            }
            if ($totalCount -gt $bestCount -or ($totalCount -eq $bestCount -and ($null -eq $bestTplName -or $candidateName -lt $bestTplName))) {
                $bestCount = $totalCount
                $bestTplName = $candidateName
            }
        }
        $repTplName = if ($bestTplName) { $bestTplName } else { ($pdObj.templates | Sort-Object) | Select-Object -First 1 }
        $repTplId = if ($repTplName -and $tplByName.ContainsKey($repTplName)) { $tplByName[$repTplName].id } else { $null }

        # [F140] Rebuild renderings[] from the representative template's SV data.
        # UIDs are instance-specific per SV — the same rendering item at the same placeholder
        # on two different template SVs will have DIFFERENT UniqueIds. create-partial-designs
        # uses these UIDs in its renderingUids filter to select exactly which renderings to copy.
        # If we used UIDs from a non-representative template, the filter would match nothing.
        # [W82] PD-incompatible renderings are excluded using the same classification from Step 7c.
        # Both top-level AND nested renderings are filtered: a nested Hero Banner inside a
        # PD-compatible navigation wrapper is still excluded if Hero Banner itself is incompatible.
        # Nested renderings whose PARENT UID is excluded are also cascaded out (parent gone →
        # children have nowhere to attach on the PD).
        $repRenderings = [System.Collections.ArrayList]@()
        if ($repTplName -and $tplByName.ContainsKey($repTplName)) {
            $repTplObj = $tplByName[$repTplName]
            $repIncompatUids = @{}
            if ($repTplObj.id -and $pdIncompatUidsByTemplate.ContainsKey($repTplObj.id)) {
                $repIncompatUids = $pdIncompatUidsByTemplate[$repTplObj.id]
            }
            $repExcludedUidPatterns = @{}
            foreach ($r in $repTplObj.renderings) {
                if (-not $r.itemId) { continue }
                $rPh = if ($r.placeholder) { $r.placeholder.Trim() } else { "" }
                if (-not $rPh) { continue }
                # Top-level: must be at this PD's placeholder and not PD-incompatible
                if (-not $rPh.StartsWith("/")) {
                    if ($rPh -ne $phKey) { continue }
                    if ($r.uniqueId -and $repIncompatUids.ContainsKey($r.uniqueId.ToString().ToUpperInvariant())) {
                        $exUid = ($r.uniqueId -replace '[{}]', '').ToUpperInvariant()
                        $repExcludedUidPatterns[$exUid] = $true
                        continue
                    }
                    [void]$repRenderings.Add([PSCustomObject]@{
                        renderingId = $r.itemId
                        name        = $r.name
                        uniqueId    = $r.uniqueId
                        placeholder = $r.placeholder
                        nested      = $false
                    })
                } else {
                    # Nested: parent placeholder must start with this PD's placeholder
                    $segments = $rPh.TrimStart("/").Split("/")
                    if ($segments.Count -lt 2 -or $segments[0] -ne $phKey) { continue }
                    # Skip if parent UID is excluded
                    $skipNested = $false
                    $rPhUpper = $rPh.ToUpperInvariant()
                    foreach ($exUid in $repExcludedUidPatterns.Keys) {
                        if ($rPhUpper.Contains($exUid)) { $skipNested = $true; break }
                    }
                    if ($skipNested) { continue }
                    # Skip if the rendering itself is PD-incompatible
                    if ($r.uniqueId -and $repIncompatUids.ContainsKey($r.uniqueId.ToString().ToUpperInvariant())) {
                        $nestedUidClean = ($r.uniqueId -replace '[{}]', '').ToUpperInvariant()
                        $repExcludedUidPatterns[$nestedUidClean] = $true
                        continue
                    }
                    [void]$repRenderings.Add([PSCustomObject]@{
                        renderingId = $r.itemId
                        name        = $r.name
                        uniqueId    = $r.uniqueId
                        placeholder = $r.placeholder
                        nested      = $true
                    })
                }
            }
        }

        [void]$partialDesigns.Add([PSCustomObject]@{
            name                    = $pdObj.name
            placeholder             = $pdObj.placeholder
            scope                   = $scope
            representativeTemplateId = $repTplId
            renderings              = @($repRenderings)
            templates               = @($pdObj.templates | Sort-Object)
            templateCount           = $pdObj.templates.Count
        })
    }
    $partialDesigns = @($partialDesigns | Sort-Object { switch ($_.scope) { "universal" { 0 } default { 1 } } }, { -($_.templateCount) })
    $debug += "Step 8c: Named $($partialDesigns.Count) Partial Designs ($($pdsByPlaceholder.Keys.Count) placeholders)"

    # 8d. Build Page Designs from template PD compositions
    # Group templates that share identical PD key sets → same Page Design
    $pdFpMap = @{}
    foreach ($tplName in $tplPdComposition.Keys) {
        $compFp = ($tplPdComposition[$tplName] -join "||")
        if (-not $pdFpMap.ContainsKey($compFp)) {
            $pdFpMap[$compFp] = @{
                pdKeys    = $tplPdComposition[$tplName]
                templates = [System.Collections.ArrayList]@()
            }
        }
        [void]$pdFpMap[$compFp].templates.Add($tplName)
    }

    $pageDesigns = [System.Collections.ArrayList]@()
    $pdSorted = @($pdFpMap.Keys | Sort-Object { $pdFpMap[$_].templates.Count } -Descending)
    $pdIdx = 0
    foreach ($compFp in $pdSorted) {
        $pdData = $pdFpMap[$compFp]
        $sortedTpls = @($pdData.templates | Sort-Object)
        # Name: if only 1 Page Design, use "Default"; otherwise use first template name or index
        $pdName = if ($pdSorted.Count -eq 1) {
            "Default"
        } elseif ($sortedTpls.Count -eq 1) {
            $sortedTpls[0]
        } else {
            $pdIdx++
            "Design $pdIdx"
        }
        # Resolve PD keys to PD names
        $pdRefs = [System.Collections.ArrayList]@()
        foreach ($k in $pdData.pdKeys) {
            $pdObj = $pdRegistry[$k]
            if ($pdObj) { [void]$pdRefs.Add($pdObj.name) }
        }
        [void]$pageDesigns.Add([PSCustomObject]@{
            name              = $pdName
            partialDesigns    = @($pdRefs)
            templates         = $sortedTpls
            templateCount     = $sortedTpls.Count
        })
    }
    $debug += "Step 8d: Built $($pageDesigns.Count) Page Design(s)"

    # 8e. Build TemplateAssignments: flat template → Page Design lookup
    $templateAssignments = [System.Collections.ArrayList]@()
    foreach ($pgd in $pageDesigns) {
        foreach ($tName in $pgd.templates) {
            $tObj = $tplByName[$tName]
            [void]$templateAssignments.Add([PSCustomObject]@{
                templateName = $tName
                templateId   = if ($tObj) { $tObj.id } else { $null }
                pageDesign   = $pgd.name
            })
        }
    }
    $templateAssignments = @($templateAssignments | Sort-Object -Property templateName)
    $debug += "Step 8e: $($templateAssignments.Count) template assignment(s)"

    $presentationPlan = [PSCustomObject]@{
        PartialDesigns      = @($partialDesigns)
        PageDesigns         = @($pageDesigns)
        TemplateAssignments = @($templateAssignments)
    }
    $debug += "Step 8: Presentation plan complete — $($partialDesigns.Count) PDs, $($pageDesigns.Count) Page Designs, $($templateAssignments.Count) assignments"

    # Write subset catalog to server file
    $subsetCatalogFilePath = $null
    if ($allSubsetPages.Count -gt 0) {
        $timestamp = (Get-Date -Format "yyyyMMdd-HHmmss")
        $safeSiteName = ($sitePath -replace '[^a-zA-Z0-9]', '-').Trim('-')
        $catalogFileName = "subset-catalog-$safeSiteName-$timestamp.json"
        $catalogServerPath = "App/subset-catalogs/$catalogFileName"
        $tempDir = [Sitecore.Configuration.Settings]::TempFolderPath
        $catalogDir = Join-Path $tempDir "subset-catalogs"
        if (-not [System.IO.Directory]::Exists($catalogDir)) { [System.IO.Directory]::CreateDirectory($catalogDir) | Out-Null }
        $catalogFullPath = Join-Path $catalogDir $catalogFileName
        $catalogJson = [PSCustomObject]@{
            generatedAt    = (Get-Date -Format "o")
            sitePath       = $sitePath
            totalSubsetPages = $allSubsetPages.Count
            pages          = @($allSubsetPages)
        } | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($catalogFullPath, $catalogJson, [System.Text.Encoding]::UTF8)
        $subsetCatalogFilePath = "Temp/subset-catalogs/$catalogFileName"
        $debug += "Step 7: Wrote subset catalog ($($allSubsetPages.Count) entries) to $subsetCatalogFilePath"
    } else {
        $debug += "Step 7: No subset pages found — no catalog file written"
    }
    $debug += "Step 7: Variance analysis complete. Subset pages: $($allSubsetPages.Count)"

    # Slim Templates to metadata only — raw renderings are already aggregated in
    # RenderingSummary, TemplateGroups, and pageDesignSuggestions. Agents never need
    # the per-template rendering arrays directly. This cuts ~60% of response size.
    $slimTemplates = @($templates | ForEach-Object {
        [PSCustomObject]@{
            id                = $_.id
            name              = $_.name
            path              = $_.path
            hasStandardValues = $_.hasStandardValues
            renderingCount    = $_.renderings.Count
            error             = $_.error
        }
    })

    # Build PD-incompatible rendering summary (cross-template deduplication)
    $pdIncompatSummaryMap = @{}
    foreach ($tplResult in $pdCompatResults) {
        foreach ($rc in $tplResult.renderings) {
            if (-not $rc.pdCompatible) {
                $rid = $rc.renderingId.ToUpperInvariant()
                if (-not $pdIncompatSummaryMap.ContainsKey($rid)) {
                    $pdIncompatSummaryMap[$rid] = @{
                        renderingId = $rc.renderingId
                        name        = $rc.name
                        templates   = [System.Collections.ArrayList]@()
                    }
                }
                if ($pdIncompatSummaryMap[$rid].templates -notcontains $tplResult.templateName) {
                    [void]$pdIncompatSummaryMap[$rid].templates.Add($tplResult.templateName)
                }
            }
        }
    }
    $pdIncompatSummary = [System.Collections.ArrayList]@()
    foreach ($rid in ($pdIncompatSummaryMap.Keys | Sort-Object)) {
        $data = $pdIncompatSummaryMap[$rid]
        [void]$pdIncompatSummary.Add([PSCustomObject]@{
            renderingId       = $data.renderingId
            name              = $data.name
            templatesAffected = $data.templates.Count
            templates         = @($data.templates | Sort-Object)
        })
    }
    $debug += "PD-incompatible renderings: $($pdIncompatSummary.Count) unique across all templates"

    $result = [PSCustomObject]@{
        Status                     = "success"
        SitePath                   = $sitePath
        TotalTemplates             = $templates.Count
        TemplatesWithRenderings    = $withRenderings.Count
        TemplatesWithoutRenderings = $withoutRenderings.Count
        DistinctPlaceholders       = $allPlaceholders
        RenderingSummary           = $renderingSummary
        UniversalRenderings        = $universalRenderings
        TemplateGroups             = $templateGroups
        ExcludedTemplateGroups     = $excludedTemplateGroups
        UngroupedTemplates         = $ungroupedTpls
        PresentationPlan           = $presentationPlan
        PdCompatibility            = @($pdCompatResults)
        PdIncompatibleRenderings   = @($pdIncompatSummary)
        Templates                  = $slimTemplates
        SubsetCatalogFilePath      = $subsetCatalogFilePath
        SubsetPageCount            = $allSubsetPages.Count
        Debug                      = $debug
    }
    $result | ConvertTo-Json -Depth 10

} catch {
    $errDetail = "$($_.Exception.Message) | Line: $($_.InvocationInfo.ScriptLineNumber) | Stack: $($_.ScriptStackTrace)"
    [PSCustomObject]@{
        Status     = "error"
        Error      = $errDetail
        StackTrace = $_.ScriptStackTrace
        Line       = $_.InvocationInfo.ScriptLineNumber
        Debug      = $debug
    } | ConvertTo-Json -Depth 5
}
