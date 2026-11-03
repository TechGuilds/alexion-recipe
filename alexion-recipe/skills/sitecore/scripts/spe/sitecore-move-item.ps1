<#
.INJECTED_VARIABLES
  $itemPath             [string] - Sitecore path of item to move/rename (optional if itemId provided)
  $itemId               [string] - GUID of item to move/rename (optional if itemPath provided)
  $destinationPath      [string] - Target parent path (optional — omit if only renaming)
  $newName              [string] - New item name (optional — omit if only moving)
  $updatePathReferences [string] - "true" | "false" — whether to SQL REPLACE path references
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")

    # ─── Resolve source item ─────────────────────────────────────────────────
    $item = $null
    if ($itemId -and $itemId -ne "") {
        $item = $db.GetItem($itemId)
        if (-not $item) { throw "Item not found for ID: $itemId" }
    } elseif ($itemPath -and $itemPath -ne "") {
        $item = Get-Item -Path "master:$itemPath" -ErrorAction SilentlyContinue
        if (-not $item) { throw "Item not found at path: $itemPath" }
    } else {
        throw "Provide either itemPath or itemId."
    }

    $originalPath = $item.Paths.FullPath
    $originalName = $item.Name
    $moved   = $false
    $renamed = $false

    # ─── Move (change parent) ────────────────────────────────────────────────
    if ($destinationPath -and $destinationPath -ne "") {
        $destItem = Get-Item -Path "master:$destinationPath" -ErrorAction SilentlyContinue
        if (-not $destItem) { throw "Destination not found at path: $destinationPath" }

        $currentParentPath = $item.Parent.Paths.FullPath
        if ($currentParentPath -ne $destItem.Paths.FullPath) {
            Move-Item -Path "master:$($item.Paths.FullPath)" -Destination "master:$($destItem.Paths.FullPath)"
            # Re-fetch item at new location
            $item = $db.GetItem($item.ID)
            $moved = $true
        }
    }

    # ─── Rename ──────────────────────────────────────────────────────────────
    if ($newName -and $newName -ne "") {
        if ($item.Name -ne $newName) {
            $item = $item | Wrap-Item
            $item.Name = $newName
            $renamed = $true
            # Re-fetch to get updated path
            $item = $db.GetItem($item.ID)
        }
    }

    # ─── Update path references (optional) ─────────────────────────────────
    $pathRefsUpdated = [ordered]@{ Shared = 0; Versioned = 0; Unversioned = 0 }
    if ($updatePathReferences -eq "true" -and $moved) {
        $connStr = [Sitecore.Configuration.Settings]::GetConnectionString("master")

        # ── Helper: REPLACE with parameterised SQL ────────────────────────────
        function Invoke-PathReplace {
            param([string]$TableName, [string]$ConnStr, [string]$OldPath, [string]$NewPath)
            $conn = New-Object System.Data.SqlClient.SqlConnection($ConnStr)
            $cmd  = $conn.CreateCommand()
            $cmd.CommandTimeout = 600
            $cmd.CommandText = "UPDATE $TableName SET Value = REPLACE(Value, @oldPath, @newPath) WHERE Value LIKE @pattern"
            [void]$cmd.Parameters.AddWithValue("@oldPath", $OldPath)
            [void]$cmd.Parameters.AddWithValue("@newPath", $NewPath)
            [void]$cmd.Parameters.AddWithValue("@pattern", "%" + $OldPath + "%")
            $conn.Open()
            $affected = $cmd.ExecuteNonQuery()
            $conn.Close()
            $conn.Dispose()
            return $affected
        }

        # ── Helper: end-of-value replacement (path is at the very end) ────────
        # Uses RIGHT() + LEN() so it won't false-match longer names like MySiteTest
        function Invoke-PathReplaceEndOfValue {
            param([string]$TableName, [string]$ConnStr, [string]$OldPath, [string]$NewPath)
            $conn = New-Object System.Data.SqlClient.SqlConnection($ConnStr)
            $cmd  = $conn.CreateCommand()
            $cmd.CommandTimeout = 600
            $cmd.CommandText = @"
UPDATE $TableName
SET    Value = LEFT(Value, LEN(Value + 'X') - 1 - LEN(@oldPath + 'X') + 1) + @newPath
WHERE  RIGHT(Value, LEN(@oldPath + 'X') - 1) = @oldPath
"@
            [void]$cmd.Parameters.AddWithValue("@oldPath", $OldPath)
            [void]$cmd.Parameters.AddWithValue("@newPath", $NewPath)
            $conn.Open()
            $affected = $cmd.ExecuteNonQuery()
            $conn.Close()
            $conn.Dispose()
            return $affected
        }

        # ── Pass 1: Delimiter-suffixed replacements ───────────────────────────
        # Each delimiter marks a boundary after which the path cannot continue
        # as an item name, making the REPLACE safe against partial matches.
        $delimiters = @(
            "/"      # Child path segments (covers ~96% of matches)
            '"'      # XML double-quote attribute end  (__Renderings s:ds="...")
            "|"      # Pipe-delimited multi-value      (Datasource Location, Treelist)
            "'"      # XML single-quote attributes     (rare but valid)
            "&"      # Query string parameters          (Source field: DataSource=...&Include...)
            "<"      # XML tag boundary
            " "      # Space separator
        )

        foreach ($delim in $delimiters) {
            $oldToken = $originalPath + $delim
            $newToken = $item.Paths.FullPath + $delim
            $pathRefsUpdated.Shared      += Invoke-PathReplace "SharedFields"      $connStr $oldToken $newToken
            $pathRefsUpdated.Versioned   += Invoke-PathReplace "VersionedFields"   $connStr $oldToken $newToken
            $pathRefsUpdated.Unversioned += Invoke-PathReplace "UnversionedFields" $connStr $oldToken $newToken
        }

        # ── Pass 2: End-of-value (path is the entire value or last segment) ──
        # Handles: Value="/sitecore/content/MySite" or "...|/sitecore/content/MySite"
        # RIGHT() check ensures /sitecore/content/MySiteTest won't match.
        $pathRefsUpdated.Shared      += Invoke-PathReplaceEndOfValue "SharedFields"      $connStr $originalPath $item.Paths.FullPath
        $pathRefsUpdated.Versioned   += Invoke-PathReplaceEndOfValue "VersionedFields"   $connStr $originalPath $item.Paths.FullPath
        $pathRefsUpdated.Unversioned += Invoke-PathReplaceEndOfValue "UnversionedFields" $connStr $originalPath $item.Paths.FullPath
    }

    # ─── Result ──────────────────────────────────────────────────────────────
    [PSCustomObject]@{
        Status       = "ok"
        ItemId       = $item.ID.ToString()
        OriginalPath = $originalPath
        OriginalName = $originalName
        NewPath      = $item.Paths.FullPath
        NewName      = $item.Name
        Moved        = $moved
        Renamed      = $renamed
        PathRefsUpdated = $pathRefsUpdated
    } | ConvertTo-Json -Depth 3

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
