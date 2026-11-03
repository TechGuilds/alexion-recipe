<#
.SYNOPSIS
    Discover layout folders from a site's page template Standard Values.

.DESCRIPTION
    Same discovery logic as diag-layout-discovery.ps1 and xp-discovery scripts.
    Walks the site content tree, collects unique page template IDs,
    resolves each template's __Standard Values → Get-Layout → layout item,
    and returns the unique parent folder paths for serialization config.

.INJECTED_VARIABLES
    $siteRootPath - Sitecore content path to the site root (e.g. "/sitecore/content/MySite")

.OUTPUT
    JSON with: uniquePageTemplates, uniqueLayoutFolders, serializationIncludes[{kind, path}]
#>
$ErrorActionPreference = "Stop"
Set-Location "master:\sitecore" | Out-Null

try {
    $siteRoot = Get-Item -Path "master:$($siteRootPath)" -ErrorAction SilentlyContinue
    if ($null -eq $siteRoot) {
        [PSCustomObject]@{ Error = "Site root not found"; Path = $siteRootPath } | ConvertTo-Json
        return
    }

    # Step 1: Collect unique page template IDs from items that have layouts
    $pageTemplates = @{}
    $allItems = $siteRoot.Axes.GetDescendants()

    foreach ($item in $allItems) {
        $lf = New-Object Sitecore.Data.Fields.LayoutField($item)
        if (-not [string]::IsNullOrWhiteSpace($lf.Value)) {
            $tid = $item.TemplateID.ToString()
            if (-not $pageTemplates.ContainsKey($tid)) {
                $pageTemplates[$tid] = $item.TemplateName
            }
        }
    }

    # Step 2: For each template, resolve SV -> Get-Layout -> layout folder
    $layoutRootPaths = @{}
    foreach ($tid in $pageTemplates.Keys) {
        $tpl = Get-Item -Path "master:" -ID $tid -ErrorAction SilentlyContinue
        if (-not $tpl) { continue }
        $svPath = "master:" + $tpl.Paths.FullPath + "/__Standard Values"
        $sv = Get-Item -Path $svPath -ErrorAction SilentlyContinue
        if (-not $sv) { continue }
        $layoutItem = Get-Layout -Item $sv 2>$null
        if ($null -ne $layoutItem) {
            $folder = Split-Path $layoutItem.Paths.FullPath -Parent
            $folder = $folder.Replace('\', '/')
            if (-not [string]::IsNullOrWhiteSpace($folder) -and -not $layoutRootPaths.ContainsKey($folder)) {
                $layoutRootPaths[$folder] = $true
            }
        }
    }

    # Step 3: Build serialization includes
    $includes = @()
    foreach ($f in ($layoutRootPaths.Keys | Sort-Object)) {
        $includes += [PSCustomObject]@{ kind = "layout"; path = $f }
    }

    [PSCustomObject]@{
        uniquePageTemplates   = $pageTemplates.Count
        uniqueLayoutFolders   = $layoutRootPaths.Count
        serializationIncludes = $includes
    } | ConvertTo-Json -Depth 4

} catch {
    [PSCustomObject]@{
        Error      = $_.Exception.Message
        StackTrace = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 3
}

