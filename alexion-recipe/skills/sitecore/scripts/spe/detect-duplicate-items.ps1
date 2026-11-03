<#
.INJECTED_VARIABLES
  $database  [string] - Database name (default: "master")
  $mode      [string] - "full" (default) returns every duplicate group with per-item
                        detail; "count" returns only the remaining group count (the
                        cheap verify-clean probe run after remediation)

Detects duplicate Sitecore items — two or more children of the same parent sharing a
name. These produce "Non-unique item paths cannot be serialized" and block the whole
serialization pull, so they are found and remediated BEFORE pull.

Output ("full"): JSON array of groups
  [ { ParentPath, Name, Count, HasLinks,
      Items: [ { ID, Created, CreatedBy, Updated, IncomingLinks } ] } ]
Output ("count"): { RemainingDuplicateGroups: <n> }
#>
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($database)) { $database = "master" }
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = "full" }

try {
    $connStr = [Sitecore.Configuration.Settings]::GetConnectionString($database)

    if ($mode -eq "count") {
        $sql = @"
SELECT COUNT(*) AS DupGroups
FROM (
    SELECT ParentID, Name
    FROM Items
    GROUP BY ParentID, Name
    HAVING COUNT(*) > 1
) AS Dups
"@
        $sqlConn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $cmd = New-Object System.Data.SqlClient.SqlCommand($sql, $sqlConn)
        $sqlConn.Open()
        $remaining = $cmd.ExecuteScalar()
        $sqlConn.Close()

        [PSCustomObject]@{ RemainingDuplicateGroups = [int]$remaining } | ConvertTo-Json -Depth 3
        return
    }

    $db = [Sitecore.Configuration.Factory]::GetDatabase($database)
    $linkDb = [Sitecore.Globals]::LinkDatabase

    $sql = @"
SELECT ParentID, Name, COUNT(*) AS Cnt
FROM Items
GROUP BY ParentID, Name
HAVING COUNT(*) > 1
ORDER BY Cnt DESC
"@

    $sqlConn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $cmd     = New-Object System.Data.SqlClient.SqlCommand($sql, $sqlConn)
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($cmd)
    $dt      = New-Object System.Data.DataTable
    $sqlConn.Open()
    $adapter.Fill($dt) | Out-Null
    $sqlConn.Close()

    $duplicateItems = foreach ($row in $dt.Rows) {
        $parentItem = $db.GetItem([Sitecore.Data.ID]::Parse($row["ParentID"].ToString()))
        if (-not $parentItem) { continue }

        $childItems = $parentItem.Children | Where-Object { $_.Name -eq $row["Name"] }
        $itemDetails = foreach ($child in $childItems) {
            [PSCustomObject]@{
                ID            = $child.ID.ToString()
                Created       = $child.Fields["__Created"].Value
                CreatedBy     = $child.Fields["__Created by"].Value
                Updated       = $child.Fields["__Updated"].Value
                IncomingLinks = $linkDb.GetReferrers($child).Count
            }
        }

        [PSCustomObject]@{
            ParentPath = $parentItem.Paths.FullPath
            Name       = $row["Name"]
            Count      = [int]$row["Cnt"]
            Items      = $itemDetails
            HasLinks   = ($itemDetails | Where-Object { $_.IncomingLinks -gt 0 }).Count -gt 0
        }
    }

    if ($null -eq $duplicateItems) { $duplicateItems = @() }
    @($duplicateItems) | ConvertTo-Json -Depth 5

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        mode   = $mode
    } | ConvertTo-Json -Depth 3
}
