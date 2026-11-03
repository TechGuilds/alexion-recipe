<#
.INJECTED_VARIABLES
  $item           [string] - Sitecore item GUID (with/without braces/dashes) or path (starts with /)
  $database       [string] - Database name (default: "master")
  $includeFields  [string] - "true" to include field values in output (default: "false")
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "${database}:/"

    # Detect GUID vs path
    $resolved = $null
    $parsedId = [Sitecore.Data.ID]::new([System.Guid]::Empty)

    if ([Sitecore.Data.ID]::TryParse($item, [ref]$parsedId)) {
        # GUID — look up by ID
        if (Test-Path $parsedId) {
            $resolved = Get-Item . -ID $parsedId
        }
    } else {
        # Path — look up by path
        $resolved = Get-Item -Path "${database}:${item}" -ErrorAction SilentlyContinue
    }

    if ($resolved) {
        $result = [ordered]@{
            found        = $true
            id           = $resolved.ID.ToString()
            name         = $resolved.Name
            path         = $resolved.Paths.FullPath
            templateName = $resolved.TemplateName
            templateId   = $resolved.TemplateID.ToString()
            created      = $resolved["__Created"]
            updated      = $resolved["__Updated"]
            hasChildren  = $resolved.HasChildren
            parentId     = $resolved.ParentID.ToString()
        }

        if ($includeFields -eq "true") {
            $resolved.Fields.ReadAll()
            $fields = @()
            foreach ($f in $resolved.Fields) {
                if ($f.Name -like "__*") { continue }
                $val = $f.Value
                if ([string]::IsNullOrEmpty($val)) { continue }
                $fields += [ordered]@{
                    name  = $f.Name
                    id    = $f.ID.ToString()
                    type  = $f.Type
                    value = $val
                }
            }
            $result["fields"] = $fields
        }

        [PSCustomObject]$result
    } else {
        [PSCustomObject]@{
            found = $false
            item  = $item
        }
    }
} catch {
    [PSCustomObject]@{
        found = $false
        error = $_.Exception.Message
        item  = $item
    }
}
