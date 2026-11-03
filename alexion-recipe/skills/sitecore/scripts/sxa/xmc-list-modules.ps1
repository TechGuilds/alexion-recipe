<#
.INJECTED_VARIABLES
  $layer          [string]  - "Feature" | "Project" | "Foundation" | "all"
  $name           [string]  - Optional name filter (wildcard match)
  $includeFolders [bool]    - Whether to include folder path+ID details
    $showRenderingRegistration [bool] - Whether to include Available Renderings registration details per module
#>
$ErrorActionPreference = "Stop"

try {
    $layers         = if ($layer -eq "all") { @("Feature", "Foundation", "Project") } else { @($layer) }
    $nameSearch     = $name
    $withFolders    = ($includeFolders -eq $true)
        $withRegistration = ($showRenderingRegistration -eq $true)

    $folderRoots = [ordered]@{
        "Renderings"   = "/sitecore/layout/Renderings"
        "Templates"    = "/sitecore/templates"
        "Branches"     = "/sitecore/templates/Branches"
        "Placeholders" = "/sitecore/layout/Placeholder Settings"
        "Layouts"      = "/sitecore/layout/Layouts"
        "Media"        = "/sitecore/media library"
        "Settings"     = "/sitecore/system/Settings"
    }

    $results = @()
    $seen = @{}
    foreach ($l in $layers) {
        $settingsBase = "/sitecore/system/Settings/$l"
        $settingsPath = "master:$settingsBase"
        if (-not (Test-Path $settingsPath)) { continue }

        # Single pass: find all SiteSetupRoot items, then derive module from their parent.
        # A module may have multiple SiteSetupRoot children (e.g. SiteSetupRoot + HeadlessSiteSetupRoot),
        # so deduplicate by Layer+Path using $seen.
        $siteSetupItems = Get-ChildItem -Path $settingsPath -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.TemplateName -match "SiteSetupRoot" }

        foreach ($ssi in $siteSetupItems) {
            $modItem = $ssi.Parent
            if (-not $modItem) { continue }

            # Relative path within layer (e.g. "MyModule" or "Subfolder/MyModule")
            $relPath = $modItem.Paths.Path -replace "^$settingsBase/", ""
            $seenKey = "$l/$relPath"
            if ($seen.ContainsKey($seenKey)) { continue }
            $seen[$seenKey] = $true

            if ($nameSearch -and $relPath -notlike "*$nameSearch*") { continue }

            $entry = [PSCustomObject]@{ Layer = $l; Path = $relPath }

            if ($withFolders) {
                $folders = [ordered]@{}
                foreach ($key in $folderRoots.Keys) {
                    $fp = "master:$($folderRoots[$key])/$l/$relPath"
                    $fi = Get-Item -Path $fp -ErrorAction SilentlyContinue
                    $folders[$key] = if ($fi) {
                        [PSCustomObject]@{ Path = $fi.Paths.FullPath; ID = $fi.ID.ToString() }
                    } else { $null }
                }
                $entry | Add-Member -NotePropertyName "Folders" -NotePropertyValue $folders
            }

            if ($withRegistration) {
                $moduleLeaf = Split-Path $relPath -Leaf
                $branchFolderPath = "master:/sitecore/templates/Branches/$l/$relPath"
                $branchName = "Available Headless $moduleLeaf Renderings"

                $branchItem = $null
                $availableRenderingsItem = $null
                $renderingIds = @()
                $renderingNames = @()

                if (Test-Path $branchFolderPath) {
                    $branchItem = Get-Item -Path "$branchFolderPath/$branchName" -ErrorAction SilentlyContinue
                    if ($branchItem) {
                        $availableRenderingsItem = $branchItem.Children | Select-Object -First 1
                        if ($availableRenderingsItem) {
                            $raw = $availableRenderingsItem["Renderings"]
                            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                                $renderingIds = @($raw.Split("|") | Where-Object { $_ -ne "" })
                                foreach ($rid in $renderingIds) {
                                    $ri = Get-Item -Path "master:" -ID $rid -ErrorAction SilentlyContinue
                                    if ($ri) {
                                        $renderingNames += $ri.Name
                                    } else {
                                        $renderingNames += "(missing:$rid)"
                                    }
                                }
                            }
                        }
                    }
                }

                $entry | Add-Member -NotePropertyName "RenderingRegistration" -NotePropertyValue ([PSCustomObject]@{
                    Status = if ($branchItem -and $availableRenderingsItem) { "found" } elseif (Test-Path $branchFolderPath) { "branch-found-no-item" } else { "branch-folder-missing" }
                    BranchFolderPath = if (Test-Path $branchFolderPath) { "/sitecore/templates/Branches/$l/$relPath" } else { $null }
                    BranchItemPath = if ($branchItem) { $branchItem.Paths.FullPath } else { $null }
                    AvailableRenderingsItemPath = if ($availableRenderingsItem) { $availableRenderingsItem.Paths.FullPath } else { $null }
                    RenderingCount = $renderingIds.Count
                    RenderingIds = $renderingIds
                    RenderingNames = $renderingNames
                })
            }

            $results += $entry
        }
    }

    [PSCustomObject]@{
        Status  = "ok"
        Count   = $results.Count
        Modules = $results
    } | ConvertTo-Json -Depth 6
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
