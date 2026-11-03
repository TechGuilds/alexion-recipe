<#
.INJECTED_VARIABLES
  $modulePath [string] - Relative module path within layer (e.g. "MyModule" or "Sub/MyModule")
  $layer      [string] - "Feature" | "Project" | "Foundation"
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    Import-Function -Name "Add-HeadlessModule"
    Import-Function -Name "Get-ModuleStartLocation"

    $Layer = $layer
    $ModPath = $modulePath
    $ModName = Split-Path $ModPath -Leaf
    $Tail    = Split-Path $ModPath -Parent
    if (-not $Tail) { $Tail = "" }

    $availableContainers = Get-ModuleStartLocation
    $selectedContainers = [System.Collections.ArrayList]@($availableContainers.Values)

    # Ensure settings container is present (required when setup templates are specified)
    if (-not $selectedContainers.Contains("/sitecore/system/Settings/{0}")) {
        $selectedContainers.Add("/sitecore/system/Settings/{0}") | Out-Null
    }

    $roots = $selectedContainers |
        Where-Object   { $_ } |
        ForEach-Object { $_ -f $Layer } |
        Where-Object   { $_ -and (Test-Path "master:$_") } |
        ForEach-Object { Get-Item -Path "master:$_" }

    # Settings root is required — without it SetupItemTemplatesIds won't fire
    $settingsPath = "/sitecore/system/Settings/$Layer"
    $hasSettingsRoot = $roots | Where-Object { $_.Paths.Path -eq $settingsPath }
    if (-not $hasSettingsRoot) {
        throw "Required settings root not found at '$settingsPath'. Ensure the $Layer layer exists in /sitecore/system/Settings/."
    }

    $model = New-Object "Sitecore.XA.Foundation.Scaffolding.Models.NewModuleModel"
    $model.Tail                  = $Tail
    $model.Roots                 = $roots
    $model.Name                  = $ModName
    $model.SetupItemTemplatesIds = @(
        "{F036B5E0-37FB-4537-9D36-EF84E5BD41B7}",
        "{BED31D6F-D968-45A9-B54E-12D7F977D861}"
    )

    Add-HeadlessModule $model

    # Collect all created items with purpose labels
    $purposeMap = @{
        "/sitecore/system/Settings"             = "Settings"
        "/sitecore/layout/Renderings"           = "Renderings"
        "/sitecore/templates/Branches"          = "Branches"
        "/sitecore/templates"                   = "Templates"
        "/sitecore/layout/Placeholder Settings" = "Placeholders"
        "/sitecore/layout/Layouts"              = "Layouts"
        "/sitecore/media library"               = "Media"
    }

    $createdItems = @()
    foreach ($root in $model.Roots) {
        $itemPath = $root.Paths.Path + "/" + $ModPath
        $item = Get-Item -Path $itemPath -ErrorAction SilentlyContinue
        if ($item) {
            $purpose = "Unknown"
            # Match longest prefix first (Branches before Templates)
            $longestMatch = ""
            foreach ($prefix in $purposeMap.Keys) {
                if ($root.Paths.Path.StartsWith($prefix) -and $prefix.Length -gt $longestMatch.Length) {
                    $longestMatch = $prefix
                }
            }
            if ($longestMatch -ne "") { $purpose = $purposeMap[$longestMatch] }
            $createdItems += [PSCustomObject]@{
                Purpose = $purpose
                Name    = $item.Name
                Path    = $item.Paths.FullPath
                ID      = $item.ID.ToString()
            }
        }
    }

    [PSCustomObject]@{
        Status       = "ok"
        ModuleName   = $ModName
        ModulePath   = $ModPath
        Layer        = $Layer
        CreatedItems = $createdItems
    } | ConvertTo-Json -Depth 4
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
