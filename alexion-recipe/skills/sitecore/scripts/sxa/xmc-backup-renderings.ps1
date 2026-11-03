<#
.INJECTED_VARIABLES
  $sitePath    [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
  $scope       [string] - (Optional) "sv" | "pages" | "both" (default)
  $templateId  [string] - (Optional) GUID of a single template to back up. If empty, backs up all.
  $phase       [string] - "plan" (default) = enumerate items, return metadata only (no XML)
                           "fetch" = return layout XML for specific item IDs
  $itemIds     [string] - Comma-separated item GUIDs (fetch phase only)

  PURPOSE: Two-phase backup of __Renderings and __Final Renderings XML.
  Phase "plan" enumerates which items need backup (small output — metadata only).
  Phase "fetch" retrieves layout XML for a batch of item IDs (called repeatedly by TS handler).
  This avoids CliXml serialization timeout on large sites.

  Read-only — does NOT modify any Sitecore items.
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/sitecore"
    $debug = [System.Collections.ArrayList]::new()
    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $renderingsFieldId = [Sitecore.FieldIDs]::LayoutField
    $finalRenderingsFieldId = [Sitecore.FieldIDs]::FinalLayoutField

    $effectivePhase = if ([string]::IsNullOrWhiteSpace($phase)) { "plan" } else { $phase.ToLower().Trim() }

    # ═══════════════════════════════════════════════════════════
    # FETCH PHASE — return layout XML for specific item IDs
    # ═══════════════════════════════════════════════════════════
    if ($effectivePhase -eq "fetch") {
        if ([string]::IsNullOrWhiteSpace($itemIds)) {
            throw "fetch phase requires itemIds"
        }
        $ids = @($itemIds -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        [void]$debug.Add("Fetch: $($ids.Count) item(s)")

        $entries = [System.Collections.ArrayList]::new()
        foreach ($id in $ids) {
            try {
                $scId = [Sitecore.Data.ID]::Parse($id)
                $rawItem = $db.GetItem($scId)
                if (-not $rawItem) {
                    [void]$debug.Add("WARN: $id not found")
                    continue
                }
                [void]$entries.Add([PSCustomObject]@{
                    itemId                     = $rawItem.ID.ToString()
                    originalRenderingsXml      = $rawItem.Fields[$renderingsFieldId].Value
                    originalFinalRenderingsXml = $rawItem.Fields[$finalRenderingsFieldId].Value
                })
            } catch {
                [void]$debug.Add("WARN: $id error — $($_.Exception.Message)")
            }
        }

        [PSCustomObject]@{
            Status  = "ok"
            Phase   = "fetch"
            Count   = $entries.Count
            Entries = @($entries)
            Debug   = @($debug)
        } | ConvertTo-Json -Depth 5
        return
    }

    # ═══════════════════════════════════════════════════════════
    # PLAN PHASE — enumerate items to back up (metadata only, no XML)
    # ═══════════════════════════════════════════════════════════
    $effectiveScope = if ([string]::IsNullOrWhiteSpace($scope) -or $scope -eq "both") { "both" }
                      elseif ($scope -eq "sv") { "sv" }
                      elseif ($scope -eq "pages") { "pages" }
                      else { "both" }
    [void]$debug.Add("Plan | Scope: $effectiveScope | Site: $sitePath")

    # ── Parse TemplatesMapping ──
    $pageDesignsItem = Get-Item -Path "master:$sitePath/Presentation/Page Designs" -ErrorAction SilentlyContinue
    if (-not $pageDesignsItem) {
        throw "Page Designs folder not found at $sitePath/Presentation/Page Designs"
    }
    $tplMappingRaw = $pageDesignsItem.TemplatesMapping
    if (-not $tplMappingRaw) {
        throw "TemplatesMapping field is empty on Page Designs folder"
    }

    $decoded = [System.Web.HttpUtility]::UrlDecode($tplMappingRaw)
    $tplToPd = @{}
    foreach ($pair in ($decoded -split '&')) {
        if ($pair -match '^(.+?)=(.+)$') {
            $tplToPd[$matches[1]] = $matches[2]
        }
    }
    [void]$debug.Add("TemplatesMapping: $($tplToPd.Count) template(s)")
    if ($tplToPd.Count -eq 0) { throw "TemplatesMapping parsed to 0 entries" }

    # ── Filter to single template if requested ──
    $scopedTemplates = @{}
    if (-not [string]::IsNullOrWhiteSpace($templateId)) {
        $cleanId = $templateId.Trim()
        if ($tplToPd.ContainsKey($cleanId)) {
            $scopedTemplates[$cleanId] = $tplToPd[$cleanId]
        } else { throw "Template $cleanId not found in TemplatesMapping" }
    } else {
        $scopedTemplates = $tplToPd.Clone()
    }

    $items = [System.Collections.ArrayList]::new()

    # ── Enumerate SVs ──
    if ($effectiveScope -ne "pages") {
        foreach ($tplId in @($scopedTemplates.Keys)) {
            $tpl = Get-Item -Path "master:" -ID $tplId -ErrorAction SilentlyContinue
            if (-not $tpl) {
                [void]$debug.Add("WARN: Template $tplId not found")
                continue
            }
            $sv = Get-ChildItem -Path $tpl.Paths.FullPath | Where-Object { $_.Name -eq "__Standard Values" } | Select-Object -First 1
            if (-not $sv) { continue }

            $rawItem = $db.GetItem($sv.ID)
            $sharedXml = $rawItem.Fields[$renderingsFieldId].Value
            $finalXml  = $rawItem.Fields[$finalRenderingsFieldId].Value
            if ((-not $sharedXml -or $sharedXml.Length -lt 10) -and (-not $finalXml -or $finalXml.Length -lt 10)) {
                continue
            }

            [void]$items.Add([PSCustomObject]@{
                itemId       = $sv.ID.ToString()
                itemPath     = $sv.Paths.FullPath
                itemKind     = "sv"
                templateId   = $tplId
                templateName = $tpl.Name
            })
        }
        [void]$debug.Add("SVs: $($items.Count)")
    }

    # ── Enumerate pages ──
    $pageItemCount = 0
    if ($effectiveScope -ne "sv") {
        $presentationPath = "$sitePath/Presentation"
        $siteItem = Get-Item -Path "master:$sitePath"
        $pageCandidates = @(Get-ChildItem -Path $siteItem.Paths.FullPath -Recurse)
        [void]$debug.Add("Candidates: $($pageCandidates.Count) items under site")

        foreach ($page in $pageCandidates) {
            if ($page.Paths.FullPath.StartsWith($presentationPath)) { continue }
            $pageTplId = $page.TemplateID.ToString()
            if (-not $scopedTemplates.ContainsKey($pageTplId)) { continue }

            $rawItem = $db.GetItem($page.ID)
            if (-not $rawItem) { continue }

            $sharedField = $rawItem.Fields[$renderingsFieldId]
            $finalField  = $rawItem.Fields[$finalRenderingsFieldId]

            $hasShared = $sharedField -and $sharedField.HasValue -and (-not $sharedField.ContainsStandardValue)
            $hasFinal  = $finalField  -and $finalField.HasValue  -and (-not $finalField.ContainsStandardValue)
            if (-not $hasShared -and -not $hasFinal) { continue }

            $sLen = if ($hasShared) { $sharedField.Value.Length } else { 0 }
            $fLen = if ($hasFinal)  { $finalField.Value.Length }  else { 0 }
            if ($sLen -lt 10 -and $fLen -lt 10) { continue }

            [void]$items.Add([PSCustomObject]@{
                itemId       = $page.ID.ToString()
                itemPath     = $page.Paths.FullPath
                itemKind     = "page"
                templateId   = $pageTplId
                templateName = $page.TemplateName
            })
            $pageItemCount++
        }
        [void]$debug.Add("Pages: $pageItemCount")
    }

    [void]$debug.Add("Total: $($items.Count) items to back up")

    [PSCustomObject]@{
        Status     = "ok"
        Phase      = "plan"
        Scope      = $effectiveScope
        TotalItems = $items.Count
        Items      = @($items)
        Debug      = @($debug)
    } | ConvertTo-Json -Depth 3
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = @($debug)
    } | ConvertTo-Json -Depth 3
}
