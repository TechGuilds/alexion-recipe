<#
.INJECTED_VARIABLES
  $sitePath [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
#>
$ErrorActionPreference = "Stop"

try {
    $pdDesignTplId       = "{FD2059FD-6043-4DFE-8C04-E2437CE87634}"
    $pdDesignFolderTplId = "{FCD9DD5E-FF94-47AB-8387-30D8084EF6BB}"

    $rootPath = "$sitePath/Presentation/Partial Designs"
    $root = Get-Item -Path "master:$rootPath" -ErrorAction SilentlyContinue
    if (-not $root) {
        throw "Partial Designs folder not found at $rootPath"
    }

    $allItems = @(Get-ChildItem -Path "master:$rootPath" -Recurse -ErrorAction SilentlyContinue)
    $filtered = @($allItems | Where-Object {
        $tid = $_.TemplateID.ToString()
        $tid -eq $pdDesignTplId -or $tid -eq $pdDesignFolderTplId
    })

    $items = @($filtered | ForEach-Object {
        $relativePath = $_.Paths.FullPath.Replace($rootPath, "")
        @{
            name         = $_.Name
            id           = $_.ID.ToString()
            templateName = $_.TemplateName
            relativePath = $relativePath
        }
    })

    $designCount = @($items | Where-Object { $_.templateName -eq "Partial Design" }).Count
    $folderCount = @($items | Where-Object { $_.templateName -eq "Partial Design Folder" }).Count

    [PSCustomObject]@{
        Status              = "ok"
        RootPath            = $rootPath
        RootId              = $root.ID.ToString()
        TotalPartialDesigns = $designCount
        TotalFolders        = $folderCount
        Items               = $items
    } | ConvertTo-Json -Depth 5
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
