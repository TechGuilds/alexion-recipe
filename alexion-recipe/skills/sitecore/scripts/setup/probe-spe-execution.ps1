# .INJECTED_VARIABLES: none
$ErrorActionPreference = 'Stop'

try {
    $root = Get-Item -Path 'master:/sitecore/content'
    $module = Get-Module -Name SPE -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1

    [pscustomobject]@{
        schemaVersion = 1
        status = 'ready'
        capability = 'spe.scriptExecution'
        evidence = [pscustomobject]@{
            database = 'master'
            rootItemId = $root.ID.ToString()
            speModuleVersion = if ($module) { $module.Version.ToString() } else { $null }
        }
    } | ConvertTo-Json -Depth 5 -Compress
}
catch {
    [pscustomobject]@{
        schemaVersion = 1
        status = 'failed'
        capability = 'spe.scriptExecution'
        errorType = $_.Exception.GetType().FullName
        message = $_.Exception.Message
    } | ConvertTo-Json -Depth 5 -Compress
}
