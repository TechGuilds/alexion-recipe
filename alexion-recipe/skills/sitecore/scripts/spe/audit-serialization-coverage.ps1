<#
.INJECTED_VARIABLES
  $auditPlanJson [string] - JSON from serialization/prepare-coverage-audit.mjs
  $database      [string] - Sitecore database name (default: "master")

Read-only target coverage probe. It compares expected target-root counts with
the already-recorded transfer plan in one remote operation. It does not pull,
parse serialized YAML, push, publish, clear caches, or alter content.
#>
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($database)) { $database = "master" }

try {
    # ConvertFrom-Json has no -Depth parameter in the Windows PowerShell host
    # used by Sitecore PowerShell Extensions.
    $plan = $auditPlanJson | ConvertFrom-Json
    if ($plan.version -ne 1 -or $plan.kind -ne "content-coverage-audit-plan") {
        throw "auditPlanJson must be a version 1 content-coverage-audit-plan"
    }
    $db = [Sitecore.Configuration.Factory]::GetDatabase($database)
    if ($null -eq $db) { throw "Database not found: $database" }

    $includeResults = @()
    foreach ($include in @($plan.targetIncludes)) {
        $targetPath = [string]$include.targetPath
        $root = Get-Item -Path "${database}:$targetPath" -ErrorAction SilentlyContinue
        $actualCount = 0
        if ($null -ne $root) {
            if ($include.scope -eq "SingleItem") {
                $actualCount = 1
            } elseif ($include.scope -eq "DescendantsOnly") {
                $actualCount = @($root.Axes.GetDescendants()).Count
            } else {
                $actualCount = 1 + @($root.Axes.GetDescendants()).Count
            }
        }
        $includeResults += [PSCustomObject]@{
            namespace            = [string]$include.namespace
            sourcePath           = [string]$include.sourcePath
            targetPath           = $targetPath
            scope                = [string]$include.scope
            expectedItemCount    = [int]$include.expectedItemCount
            actualItemCount      = [int]$actualCount
            rootFound            = ($null -ne $root)
            matchesExpectedCount = (($null -ne $root) -and ([int]$actualCount -eq [int]$include.expectedItemCount))
        }
    }

    [PSCustomObject]@{
        version             = 1
        kind                = "content-coverage-audit-observation"
        inspectionSha256    = [string]$plan.inspectionSha256
        expectedItemCount   = [int]$plan.expectedItemCount
        includeResults      = $includeResults
        matchedIncludes     = @($includeResults | Where-Object { $_.matchesExpectedCount }).Count
        mismatchedIncludes  = @($includeResults | Where-Object { -not $_.matchesExpectedCount }).Count
    } | ConvertTo-Json -Depth 20
} catch {
    [PSCustomObject]@{
        version = 1
        kind = "content-coverage-audit-observation"
        error = $_.Exception.Message
    } | ConvertTo-Json -Depth 5
}
