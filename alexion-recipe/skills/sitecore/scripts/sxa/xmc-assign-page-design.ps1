<#
.INJECTED_VARIABLES
  $sitePath        [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
  $pageDesignName  [string] - Name of the Page Design to assign (e.g. "Default", "Homepage")
  $templateIds     [string] - JSON array of template GUIDs to map to this Page Design (e.g. ["{guid1}","{guid2}"])
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/sitecore"

    # ── Constants ──
    $debug = [System.Collections.ArrayList]::new()

    # ── Parse input ──
    $templateGuids = @($templateIds | ConvertFrom-Json)
    [void]$debug.Add("Template IDs to map: $($templateGuids.Count) — $($templateGuids -join ', ')")

    if ($templateGuids.Count -eq 0) {
        throw "No template IDs provided — at least one template ID is required"
    }

    # ── Validate site exists ──
    $site = Get-Item -Path "master:$sitePath" -ErrorAction SilentlyContinue
    if (-not $site) {
        throw "Site not found at $sitePath"
    }
    [void]$debug.Add("Site found: $($site.Name)")

    # ── Validate Page Designs folder exists ──
    $pageDesignFolder = Get-Item -Path "master:$sitePath/Presentation/Page Designs" -ErrorAction SilentlyContinue
    if (-not $pageDesignFolder) {
        throw "Page Designs folder not found at $sitePath/Presentation/Page Designs"
    }

    # ── Validate Page Design exists ──
    $pageDesign = Get-Item -Path "master:$sitePath/Presentation/Page Designs/$pageDesignName" -ErrorAction SilentlyContinue
    if (-not $pageDesign) {
        throw "Page Design '$pageDesignName' not found at $sitePath/Presentation/Page Designs/$pageDesignName"
    }
    [void]$debug.Add("Page Design found: $($pageDesign.Name) (ID: $($pageDesign.ID))")

    # ── Update TemplatesMapping ──
    $existingMapping = $pageDesignFolder.TemplatesMapping
    $map = [Sitecore.Text.UrlString]::new()
    
    # Parse existing mappings (URL-encoded querystring format: {guid1}={guid2}&{guid3}={guid4})
    if ($existingMapping) {
        $decoded = [System.Web.HttpUtility]::UrlDecode($existingMapping)
        foreach ($pair in ($decoded -split '&')) {
            if ($pair -match '^(.+?)=(.+)$') {
                $map[$matches[1]] = $matches[2]
            }
        }
        [void]$debug.Add("Loaded existing mappings: $decoded")
    } else {
        [void]$debug.Add("No existing mappings found — creating new TemplatesMapping")
    }
    
    # Track what we're changing
    $added = 0
    $updated = 0
    
    # Add/update mappings for the specified templates
    foreach ($tplId in $templateGuids) {
        $existingDesign = $map[$tplId]
        if ($existingDesign -and $existingDesign -ne $pageDesign.ID.ToString()) {
            [void]$debug.Add("Overriding template $tplId → was: $existingDesign, now: $($pageDesign.ID)")
            $updated++
        } elseif (-not $existingDesign) {
            [void]$debug.Add("Mapping template $tplId → Page Design $($pageDesign.ID)")
            $added++
        } else {
            [void]$debug.Add("Template $tplId already mapped to this Page Design — no change")
        }
        $map[$tplId] = $pageDesign.ID.ToString()
    }
    
    # URL-encode and save
    $pageDesignFolder.TemplatesMapping = [System.Web.HttpUtility]::UrlEncode($map.toString())
    [void]$debug.Add("TemplatesMapping updated: $($map.toString())")

    [PSCustomObject]@{
        Status           = "ok"
        PageDesignName   = $pageDesignName
        PageDesignId     = $pageDesign.ID.ToString()
        TemplatesMapped  = $templateGuids.Count
        MappingsAdded    = $added
        MappingsUpdated  = $updated
        Debug            = @($debug)
    } | ConvertTo-Json -Depth 5
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = @($debug)
    } | ConvertTo-Json -Depth 5
}
