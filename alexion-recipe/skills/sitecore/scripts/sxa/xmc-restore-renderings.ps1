<#
.INJECTED_VARIABLES
    $entriesJson  [string] - JSON array of backup entries, each with
                                                        { itemPath, itemId, originalRenderingsXml, originalFinalRenderingsXml? }.
                            Passed from the TS handler after loading from the backup artifact.

    PURPOSE: Restores __Renderings (shared layout) and, when present, __Final Renderings field
    values from a backup artifact created by
  xmc-migrate-to-page-designs.  Writes the original XML back to each item, effectively undoing
  the rendering migration for the specified items.

  SAFETY: Uses BeginEdit/EndEdit for atomic field writes. Validates item existence and ID match
  before writing.  Reports per-item success/failure.
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/sitecore"

    $debug = [System.Collections.ArrayList]::new()
    $results = [System.Collections.ArrayList]::new()
    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $renderingsFieldId = [Sitecore.FieldIDs]::LayoutField
    $finalRenderingsFieldId = [Sitecore.FieldIDs]::FinalLayoutField

    $entries = $entriesJson | ConvertFrom-Json
    [void]$debug.Add("Restore: $($entries.Count) entries to process")

    $restored = 0
    $skipped = 0
    $failed = 0

    foreach ($entry in $entries) {
        $itemPath = $entry.itemPath
        $itemId = $entry.itemId
        $xml = $entry.originalRenderingsXml
        $hasFinalXml = $entry.PSObject.Properties.Name -contains 'originalFinalRenderingsXml'
        $finalXml = if ($hasFinalXml) { [string]$entry.originalFinalRenderingsXml } else { $null }

        if (-not $xml -or $xml.Length -lt 10) {
            $skipped++
            [void]$results.Add([PSCustomObject]@{
                itemPath = $itemPath
                status   = "skipped"
                reason   = "empty or missing XML"
            })
            continue
        }

        $item = Get-Item -Path "master:$itemPath" -ErrorAction SilentlyContinue
        if (-not $item) {
            $failed++
            [void]$results.Add([PSCustomObject]@{
                itemPath = $itemPath
                status   = "failed"
                reason   = "item not found"
            })
            continue
        }

        # Verify ID matches to prevent writing to wrong item (e.g. if item was moved)
        if ($itemId -and $item.ID.ToString() -ne $itemId) {
            $failed++
            [void]$results.Add([PSCustomObject]@{
                itemPath = $itemPath
                status   = "failed"
                reason   = "ID mismatch: expected $itemId, found $($item.ID.ToString())"
            })
            continue
        }

        try {
            $rawItem = $db.GetItem($item.ID)
            $rawItem.Editing.BeginEdit()
            $rawItem.Fields[$renderingsFieldId].Value = $xml
            if ($hasFinalXml) {
                $rawItem.Fields[$finalRenderingsFieldId].Value = $finalXml
            }
            $rawItem.Editing.EndEdit()
            $restored++
            [void]$results.Add([PSCustomObject]@{
                itemPath      = $itemPath
                status        = "restored"
                restoredShared = $true
                restoredFinal  = $hasFinalXml
            })
        } catch {
            $failed++
            if ($rawItem -and $rawItem.Editing -and $rawItem.Editing.IsEditing) {
                $rawItem.Editing.CancelEdit()
            }
            [void]$results.Add([PSCustomObject]@{
                itemPath = $itemPath
                status   = "failed"
                reason   = $_.Exception.Message
            })
        }
    }

    [void]$debug.Add("Complete: $restored restored, $skipped skipped, $failed failed")

    [PSCustomObject]@{
        Status   = "ok"
        Restored = $restored
        Skipped  = $skipped
        Failed   = $failed
        Total    = $entries.Count
        Results  = @($results)
        Debug    = @($debug)
    } | ConvertTo-Json -Depth 10
} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = @($debug)
    } | ConvertTo-Json -Depth 5
}
