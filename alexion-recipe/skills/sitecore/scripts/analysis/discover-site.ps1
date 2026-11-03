# Required SitePath; optional Database, Languages[], Version ('latest' or '*'),
# IncludeFields[] (explicit allow-list), MaxItems. Prepend remote-common.ps1.
Assert-KajooItemPath $SitePath
Start-KajooExport 'discovery'
Write-KajooRecord 'items.jsonl' $null
Read-KajooItems @($SitePath) -Recurse | ForEach-Object {
    $record = Get-KajooIdentity $_
    $record.fields = [ordered]@{}
    foreach ($name in @($IncludeFields | Sort-Object -Unique)) {
        if ($name) { $record.fields[$name] = Get-KajooField $_ $name }
    }
    $record.hasPresentation = [bool]((Get-KajooField $_ '__Renderings') -or (Get-KajooField $_ '__Final Renderings'))
    Write-KajooRecord 'items.jsonl' $record
}
Complete-KajooExport @{sitePath=$SitePath; database=$Database; languages=@($Languages); version=$Version; includesRoot=$true; fieldAllowList=@($IncludeFields)}
