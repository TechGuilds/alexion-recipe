<#
.INJECTED_VARIABLES
  $sitePath [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenantName/siteName")
#>
$ErrorActionPreference = "Stop"

try {
    $debug = @()
    $site = Get-Item -Path "master:$sitePath" -ErrorAction Stop
    $debug += "Site: $($site.Paths.FullPath)"

    $allItems = @(Get-ChildItem -Path "master:$sitePath" -Recurse -ErrorAction Stop)
    $debug += "Total items under site: $($allItems.Count)"

    # Filter to items with presentation — either shared layout or final layout non-empty
    $pagesWithPresentation = @($allItems | Where-Object {
        $shared = $_.Fields["__Renderings"].Value
        $final  = $_.Fields["__Final Renderings"].Value
        ($shared -and $shared.Trim() -ne "") -or ($final -and $final.Trim() -ne "")
    })
    $debug += "Pages with presentation: $($pagesWithPresentation.Count)"

    # Exclude SXA presentation infrastructure templates (not actual page templates)
    $excludedTemplateIds = @(
        "{1105B8F8-1E00-426B-BF1F-C840742D827B}"  # Page Design
        "{FD2059FD-6043-4DFE-8C04-E2437CE87634}"  # Partial Design
    )
    $pagesWithPresentation = @($pagesWithPresentation | Where-Object {
        $excludedTemplateIds -notcontains $_.TemplateID.ToString()
    })
    $debug += "Pages after excluding PD/Page Design templates: $($pagesWithPresentation.Count)"

    # Group by template ID
    $groups = @($pagesWithPresentation | Group-Object -Property { $_.TemplateID.ToString() })

    # Resolve template name/path for each group and build sorted output
    $templates = [System.Collections.ArrayList]@()
    foreach ($g in $groups) {
        $tplId = $g.Name
        $tplItem = Get-Item -Path "master:" -ID $tplId -ErrorAction SilentlyContinue
        [void]$templates.Add([PSCustomObject]@{
            templateId    = $tplId
            templateName  = if ($tplItem) { $tplItem.Name } else { "(unknown)" }
            templatePath  = if ($tplItem) { $tplItem.Paths.FullPath } else { $null }
            instanceCount = $g.Count
        })
    }

    # Sort descending by instance count
    $templates = @($templates | Sort-Object -Property instanceCount -Descending)

    # Compute percentages
    $totalPages = $pagesWithPresentation.Count
    foreach ($t in $templates) {
        $pct = if ($totalPages -gt 0) { [Math]::Round(($t.instanceCount / $totalPages) * 100, 1) } else { 0 }
        $t | Add-Member -NotePropertyName "percentage" -NotePropertyValue $pct
    }

    [PSCustomObject]@{
        Status                     = "success"
        SitePath                   = $site.Paths.FullPath
        TotalItems                 = $allItems.Count
        TotalPagesWithPresentation = $totalPages
        TemplateCount              = $templates.Count
        Templates                  = $templates
        Debug                      = $debug
    } | ConvertTo-Json -Depth 5
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
