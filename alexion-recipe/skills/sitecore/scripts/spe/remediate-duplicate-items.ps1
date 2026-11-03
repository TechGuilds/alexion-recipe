<#
.INJECTED_VARIABLES
  $actions   [string] - JSON array of remediation actions, MAX 5 per call:
                        [ { "ID": "{GUID}", "Action": "DELETE" },
                          { "ID": "{GUID}", "Action": "RENAME", "NewName": "Foo_duplicate_20210120" } ]
  $database  [string] - Database name (default: "master")

Executes ONE approved batch of duplicate remediations. Batches are capped at 5 so a
mid-batch failure stays small and reportable; the caller loops batches and reports
progress after each. An item that is already gone counts as success (desired state
reached) — a per-item failure is recorded and the rest of the batch continues.

Output: JSON array of per-action results
  [ { ID, Path/OldPath, NewName?, Action: DELETED|RENAMED|NOT_FOUND|FAILED, Success, Error? } ]
#>
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($database)) { $database = "master" }

try {
    $parsed = $actions | ConvertFrom-Json
    if ($null -eq $parsed) { throw "actions is empty or not valid JSON" }
    $parsed = @($parsed)
    if ($parsed.Count -gt 5) { throw "Batch size $($parsed.Count) exceeds the max of 5 — split into smaller batches" }

    $db = [Sitecore.Configuration.Factory]::GetDatabase($database)

    $results = foreach ($op in $parsed) {
        try {
            $item = $db.GetItem([Sitecore.Data.ID]::Parse($op.ID))
            if (-not $item) {
                # Already deleted externally — desired state reached.
                [PSCustomObject]@{ ID = $op.ID; Action = "NOT_FOUND"; Success = $true }
                continue
            }

            $path = $item.Paths.FullPath

            switch ($op.Action.ToUpperInvariant()) {
                "DELETE" {
                    $item.Delete()
                    [PSCustomObject]@{ ID = $op.ID; Path = $path; Action = "DELETED"; Success = $true }
                }
                "RENAME" {
                    if ([string]::IsNullOrWhiteSpace($op.NewName)) { throw "RENAME requires NewName" }
                    $item.Editing.BeginEdit()
                    $item.Name = $op.NewName
                    $item.Editing.EndEdit()
                    [PSCustomObject]@{ ID = $op.ID; OldPath = $path; NewName = $op.NewName; Action = "RENAMED"; Success = $true }
                }
                default { throw "Unknown Action '$($op.Action)' — expected DELETE or RENAME" }
            }
        } catch {
            [PSCustomObject]@{ ID = $op.ID; Action = "FAILED"; Success = $false; Error = $_.Exception.Message }
        }
    }

    @($results) | ConvertTo-Json -Depth 3

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
