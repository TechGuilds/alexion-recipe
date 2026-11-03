<#
.INJECTED_VARIABLES
  $searchPath  [string] - Sitecore path to search for in field values (e.g. "/sitecore/content/MySite")
  $database    [string] - Database name (default: "master")
  $maxResults  [string] - Max detail rows per table (0 = counts only)
#>
$ErrorActionPreference = "Stop"

try {
    $connStr = [Sitecore.Configuration.Settings]::GetConnectionString($database)
    if (-not $connStr) { throw "No connection string found for database: $database" }

    $pattern = "%" + $searchPath + "%"
    $max = [int]$maxResults

    # ─── Helper: run a parameterised query ────────────────────────────────
    function Invoke-SqlQuery {
        param([string]$Query, [hashtable]$Params, [string]$ConnStr)
        $conn = New-Object System.Data.SqlClient.SqlConnection($ConnStr)
        $cmd  = $conn.CreateCommand()
        $cmd.CommandText    = $Query
        $cmd.CommandTimeout = 600          # 10 min
        foreach ($k in $Params.Keys) {
            [void]$cmd.Parameters.AddWithValue($k, $Params[$k])
        }
        $conn.Open()
        $reader = $cmd.ExecuteReader()
        $table  = New-Object System.Data.DataTable
        $table.Load($reader)
        $conn.Close()
        $conn.Dispose()
        # Comma-prefix prevents PowerShell from enumerating DataTable rows
        # on the pipeline, which would unwrap a single-row result to a DataRow
        # (losing .Rows property and causing "Cannot index into a null array").
        return ,$table
    }

    $sqlParams = @{ "@pattern" = $pattern }

    # ─── 1. Counts ────────────────────────────────────────────────────────
    $countSql = @"
SELECT
  (SELECT COUNT(*) FROM SharedFields    sf WHERE sf.Value LIKE @pattern) AS SharedCount,
  (SELECT COUNT(*) FROM VersionedFields vf WHERE vf.Value LIKE @pattern) AS VersionedCount,
  (SELECT COUNT(*) FROM UnversionedFields uf WHERE uf.Value LIKE @pattern) AS UnversionedCount
"@
    $counts = Invoke-SqlQuery -Query $countSql -Params $sqlParams -ConnStr $connStr

    $result = [ordered]@{
        Status          = "ok"
        SearchPath      = $searchPath
        Database        = $database
        SharedCount     = [int]$counts.Rows[0]["SharedCount"]
        VersionedCount  = [int]$counts.Rows[0]["VersionedCount"]
        UnversionedCount = [int]$counts.Rows[0]["UnversionedCount"]
        TotalCount      = [int]$counts.Rows[0]["SharedCount"] + [int]$counts.Rows[0]["VersionedCount"] + [int]$counts.Rows[0]["UnversionedCount"]
    }

    # ─── 2. Details (when maxResults > 0) ────────────────────────────────
    if ($max -gt 0) {
        $db = [Sitecore.Configuration.Factory]::GetDatabase($database)

        # Helper: resolve item path from GUID, with caching
        $pathCache = @{}
        function Get-ItemPath {
            param([string]$idStr)
            if ($pathCache.ContainsKey($idStr)) { return $pathCache[$idStr] }
            $item = $db.GetItem([Sitecore.Data.ID]::Parse($idStr))
            $p = if ($item) { $item.Paths.FullPath } else { "(deleted: $idStr)" }
            $pathCache[$idStr] = $p
            return $p
        }

        function Get-FieldName {
            param([string]$fieldIdStr)
            if ($pathCache.ContainsKey("f_$fieldIdStr")) { return $pathCache["f_$fieldIdStr"] }
            $fi = $db.GetItem([Sitecore.Data.ID]::Parse($fieldIdStr))
            $n = if ($fi) { $fi.Name } else { $fieldIdStr }
            $pathCache["f_$fieldIdStr"] = $n
            return $n
        }

        function Get-Snippet {
            param([string]$val, [string]$search, [int]$context = 80)
            $idx = $val.IndexOf($search, [System.StringComparison]::OrdinalIgnoreCase)
            if ($idx -lt 0) { return $val.Substring(0, [Math]::Min($val.Length, 200)) }
            $start = [Math]::Max(0, $idx - $context)
            $len   = [Math]::Min($val.Length - $start, $search.Length + 2 * $context)
            return "..." + $val.Substring($start, $len) + "..."
        }

        # SharedFields detail
        $sharedSql = "SELECT TOP ($max) sf.ItemId, sf.FieldId, sf.Value FROM SharedFields sf WHERE sf.Value LIKE @pattern ORDER BY sf.ItemId"
        $sharedRows = Invoke-SqlQuery -Query $sharedSql -Params $sqlParams -ConnStr $connStr
        $sharedDetails = @()
        foreach ($r in $sharedRows.Rows) {
            $sharedDetails += [ordered]@{
                ItemPath  = Get-ItemPath $r["ItemId"].ToString()
                ItemId    = $r["ItemId"].ToString()
                FieldName = Get-FieldName $r["FieldId"].ToString()
                FieldId   = $r["FieldId"].ToString()
                Snippet   = Get-Snippet $r["Value"].ToString() $searchPath
            }
        }

        # VersionedFields detail
        $versionedSql = "SELECT TOP ($max) vf.ItemId, vf.FieldId, vf.Value, vf.Language, vf.Version FROM VersionedFields vf WHERE vf.Value LIKE @pattern ORDER BY vf.ItemId"
        $versionedRows = Invoke-SqlQuery -Query $versionedSql -Params $sqlParams -ConnStr $connStr
        $versionedDetails = @()
        foreach ($r in $versionedRows.Rows) {
            $versionedDetails += [ordered]@{
                ItemPath  = Get-ItemPath $r["ItemId"].ToString()
                ItemId    = $r["ItemId"].ToString()
                FieldName = Get-FieldName $r["FieldId"].ToString()
                FieldId   = $r["FieldId"].ToString()
                Language  = $r["Language"].ToString()
                Version   = $r["Version"].ToString()
                Snippet   = Get-Snippet $r["Value"].ToString() $searchPath
            }
        }

        # UnversionedFields detail
        $unversionedSql = "SELECT TOP ($max) uf.ItemId, uf.FieldId, uf.Value, uf.Language FROM UnversionedFields uf WHERE uf.Value LIKE @pattern ORDER BY uf.ItemId"
        $unversionedRows = Invoke-SqlQuery -Query $unversionedSql -Params $sqlParams -ConnStr $connStr
        $unversionedDetails = @()
        foreach ($r in $unversionedRows.Rows) {
            $unversionedDetails += [ordered]@{
                ItemPath  = Get-ItemPath $r["ItemId"].ToString()
                ItemId    = $r["ItemId"].ToString()
                FieldName = Get-FieldName $r["FieldId"].ToString()
                FieldId   = $r["FieldId"].ToString()
                Language  = $r["Language"].ToString()
                Snippet   = Get-Snippet $r["Value"].ToString() $searchPath
            }
        }

        $result["SharedDetails"]      = $sharedDetails
        $result["VersionedDetails"]   = $versionedDetails
        $result["UnversionedDetails"] = $unversionedDetails
        $result["Truncated"]          = ($sharedDetails.Count -ge $max) -or ($versionedDetails.Count -ge $max) -or ($unversionedDetails.Count -ge $max)
    } else {
        $result["Truncated"] = $false
    }

    $result | ConvertTo-Json -Depth 5

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
