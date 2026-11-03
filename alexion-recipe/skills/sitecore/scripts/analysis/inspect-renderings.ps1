# ItemPaths[] exact rendering roots/items. Recurse opt-in; common scope parameters.
Start-KajooExport 'renderings'
Write-KajooRecord 'renderings.jsonl' $null
$fieldNames = @('Component Name','Controller','Controller Action','Path','Datasource Template','Datasource Location','Parameters Template','Rendering Contents Resolver','ComponentQuery','Placeholders','Layout Service Placeholders','Cacheable','VaryByData','VaryByDevice','VaryByLogin','VaryByParameters','VaryByQueryString','VaryByUser')
Read-KajooItems $ItemPaths -Recurse:([bool]$Recurse) | ForEach-Object {
    $record = Get-KajooIdentity $_
    $record.fields = [ordered]@{}
    $record.missingFields = @()
    foreach ($name in $fieldNames) {
        $record.fields[$name] = Get-KajooField $_ $name
        if ($null -eq $record.fields[$name]) { $record.missingFields += $name }
    }
    Write-KajooRecord 'renderings.jsonl' $record
}
Complete-KajooExport @{itemPaths=@($ItemPaths); database=$Database; languages=@($Languages); version=$Version; recurse=[bool]$Recurse}
