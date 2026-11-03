<#
.INJECTED_VARIABLES
  $item           [string] - Sitecore item GUID (with/without braces/dashes)
  $database       [string] - Database name (default: "master")
  $recurse        [string] - "true" to delete item and all descendants (default: "false")
  $permanently    [string] - "true" to bypass recycle bin (default: "false")
  $disableEvents  [string] - "true" to wrap in EventDisabler + BulkUpdateContext (default: "true")
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "${database}:/"

    # Resolve item by ID
    $parsedId = [Sitecore.Data.ID]::new([System.Guid]::Empty)
    if (-not [Sitecore.Data.ID]::TryParse($item, [ref]$parsedId)) {
        throw "Invalid item ID: $item"
    }

    if (-not (Test-Path $parsedId)) {
        [PSCustomObject]@{
            Status = "not-found"
            id     = $item
        } | ConvertTo-Json -Depth 3
        return
    }

    $resolved = Get-Item . -ID $parsedId
    $itemPath = $resolved.Paths.FullPath
    $itemName = $resolved.Name
    $templateName = $resolved.TemplateName

    # Count descendants
    $descendants = @(Get-ChildItem -Path "${database}:${itemPath}" -Recurse -ErrorAction SilentlyContinue)
    $descendantCount = $descendants.Count

    # Guard: if has children and recurse is not true, refuse
    if ($descendantCount -gt 0 -and $recurse -ne "true") {
        [PSCustomObject]@{
            Status          = "has-children"
            id              = $resolved.ID.ToString()
            name            = $itemName
            path            = $itemPath
            templateName    = $templateName
            descendantCount = $descendantCount
            message         = "Item has $descendantCount descendants. Set recurse=true to delete the item and all its children."
        } | ConvertTo-Json -Depth 3
        return
    }

    # Build Remove-Item args
    $removeArgs = @{
        Path = "${database}:${itemPath}"
    }
    if ($recurse -eq "true") {
        $removeArgs["Recurse"] = $true
    }
    if ($permanently -eq "true") {
        $removeArgs["Permanently"] = $true
    }

    # Execute delete — optionally wrapped in performance contexts
    if ($disableEvents -eq "true") {
        New-UsingBlock (New-Object Sitecore.Data.BulkUpdateContext) {
            New-UsingBlock (New-Object Sitecore.Data.Events.EventDisabler) {
                Remove-Item @removeArgs
            }
        }
    } else {
        Remove-Item @removeArgs
    }

    [PSCustomObject]@{
        Status          = "deleted"
        id              = $resolved.ID.ToString()
        name            = $itemName
        path            = $itemPath
        templateName    = $templateName
        descendantCount = $descendantCount
        recurse         = ($recurse -eq "true")
        permanently     = ($permanently -eq "true")
        disableEvents   = ($disableEvents -eq "true")
    } | ConvertTo-Json -Depth 3

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        id     = $item
    } | ConvertTo-Json -Depth 3
}
