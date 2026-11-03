# SitePath, optional FieldNames[] allow-list; language/version and MaxItems scope.
Assert-KajooItemPath $SitePath
Start-KajooExport 'richtext'
Write-KajooRecord 'richtext.jsonl' $null
Read-KajooItems @($SitePath) -Recurse | ForEach-Object {
    $item = $_
    foreach ($field in ($item.Fields | Sort-Object Name)) {
        if ($field.Type -ne 'Rich Text' -or ($FieldNames -and $FieldNames -notcontains $field.Name)) { continue }
        $record = Get-KajooIdentity $item
        $record.fieldId = [string]$field.ID
        $record.fieldName = [string]$field.Name
        $record.html = [string]$field.Value
        # Raw references for inspection, not HTML interpretation or rewriting.
        $record.references = @([regex]::Matches($record.html, '(?i)(?:href|src)\s*=\s*["'']([^"'']*)["'']') | ForEach-Object { $_.Groups[1].Value })
        Write-KajooRecord 'richtext.jsonl' $record
    }
}
Complete-KajooExport @{sitePath=$SitePath; database=$Database; languages=@($Languages); version=$Version; fieldNames=@($FieldNames); html='original, never evaluated'}
