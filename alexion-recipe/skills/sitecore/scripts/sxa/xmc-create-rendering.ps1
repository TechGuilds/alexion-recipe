<#
.INJECTED_VARIABLES
  $componentName         [string] - Name of the rendering to create
  $renderingFolderId     [string] - Optional GUID of the target rendering folder
  $layer                 [string] - "Feature" | "Project" | "Foundation" (fallback if no ID)
  $modulePath            [string] - Relative module path (fallback if no ID)
  $hasDatasourceTemplate [bool]   - Whether to create a datasource template
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    Import-Function -Name "Copy-Rendering"

    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")

    # Resolve target module rendering folder — ID takes precedence over path
    $targetModuleItem = $null
    $resolvedLocation = ""
    if ($renderingFolderId -and $renderingFolderId -ne "") {
        $targetModuleItem = $db.GetItem($renderingFolderId)
        $resolvedLocation = if ($targetModuleItem) { $targetModuleItem.Paths.FullPath } else { $renderingFolderId }
        if (-not $targetModuleItem) {
            throw "Target module rendering folder not found for ID: $renderingFolderId"
        }
    } else {
        if (-not $modulePath -or $modulePath -eq "") { throw "Provide either renderingFolderId or (layer + modulePath)." }
        $targetModulePath = "master:/sitecore/layout/Renderings/$layer/$modulePath"
        $targetModuleItem = Get-Item -Path $targetModulePath -ErrorAction SilentlyContinue
        $resolvedLocation = "/sitecore/layout/Renderings/$layer/$modulePath"
        if (-not $targetModuleItem) {
            throw "Target module rendering folder not found at '$resolvedLocation'. Ensure the module exists (use xmc-create-module if needed)."
        }
    }

    $sourceRenderingId = if ($hasDatasourceTemplate) {
        "{2492BAC4-DA07-4C86-87F0-9873D40E2276}"
    } else {
        "{C5F905F8-FD1F-444E-A9E5-AC6B774FF0DE}"
    }
    $sourceRenderingItem = $db.GetItem($sourceRenderingId)
    if (-not $sourceRenderingItem) { throw "Source rendering not found: $sourceRenderingId" }

    $model = New-Object -TypeName "Sitecore.XA.Foundation.Scaffolding.Models.CopyRenderingModel"
    $model.SourceRenderingItem     = $sourceRenderingItem
    $model.RenderingName           = $componentName
    $model.TargetModule            = $targetModuleItem
    $model.RenderingType           = [Sitecore.XA.Foundation.Scaffolding.Models.RenderingType]::JsonRendering
    $model.DatasourceMode          = [Sitecore.XA.Foundation.Scaffolding.Models.DatasourceMode]::Inherit
    $model.RenderingParametersMode = [Sitecore.XA.Foundation.Scaffolding.Models.RenderingParametersMode]::Inherit
    $model.ViewMode                = [Sitecore.XA.Foundation.Scaffolding.Models.ViewMode]::UseExisting

    Copy-Rendering $model

    [PSCustomObject]@{
        Status           = "ok"
        ComponentName    = $componentName
        ModuleFolder     = $resolvedLocation
        HasDatasource    = $hasDatasourceTemplate
        RenderingPath    = "$resolvedLocation/$componentName"
    } | ConvertTo-Json -Depth 3
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
