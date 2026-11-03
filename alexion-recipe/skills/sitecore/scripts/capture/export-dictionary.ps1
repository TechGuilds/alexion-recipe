# DictionaryRoots[] and Domain required. No implicit global dictionary fallback.
if (-not $DictionaryRoots -or -not $Domain) { throw 'DictionaryRoots and Domain must be explicit' }
Start-KajooExport 'dictionary'
Write-KajooRecord 'dictionary.jsonl' $null
$seenKeys = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
Read-KajooItems $DictionaryRoots -Recurse | ForEach-Object {
    $key = Get-KajooField $_ 'Key'
    if (-not [string]::IsNullOrWhiteSpace($key)) {
        $record = Get-KajooIdentity $_
        $record.domain = $Domain
        $record.key = $key
        $record.phrase = Get-KajooField $_ 'Phrase'
        $record.fallback = 'not inferred; values as read under explicit SPE language/version'
        # Versions belong to each item; they are not separate key namespaces.
        $identity = @([string]$Domain, [string]$_.Language, $key) | ConvertTo-Json -Compress
        if (-not $seenKeys.ContainsKey($identity)) {
            $seenKeys[$identity] = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        }
        $contributors = $seenKeys[$identity]
        [void]$contributors.Add([string]$_.ID)
        $record.duplicate = $contributors.Count -gt 1
        if ($record.duplicate) { Add-KajooError $identity 'Duplicate dictionary key; choose precedence explicitly' }
        Write-KajooRecord 'dictionary.jsonl' $record
    }
}
Complete-KajooExport @{roots=@($DictionaryRoots); domain=$Domain; database=$Database; languages=@($Languages); version=$Version; fallback='not inferred'}
