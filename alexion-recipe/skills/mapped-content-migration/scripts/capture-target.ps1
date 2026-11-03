# Read-only SPE entrypoint. Connector injects exact UTF-8 RequestJson and RequestSha256.
# No descendants, write APIs, or imports from the target mutation implementation.
$ErrorActionPreference='Stop'
function Get-ReadbackHash([byte[]]$Bytes) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Get-ReadbackGuid($Value) {
    $id=[guid]::Empty
    if (-not [guid]::TryParse([string]$Value,[ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid readback GUID' }
    return $id.ToString('B').ToUpperInvariant()
}
function Assert-ReadbackPath($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^/sitecore/(?:content|media library)(?:/[^\\:*?\[\]\p{Cc}]+)?$' -or $Value -match '(^|/)\.\.?(/|$)|//|/$') { throw 'Unsafe readback path' }
}
function Get-ReadbackTimestamp($Value) {
    if ($Value -is [DateTime]) { return ([DateTimeOffset]::new($Value)).ToUniversalTime() }
    $parsed=[DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) { throw 'Invalid capability timestamp' }
    return $parsed.ToUniversalTime()
}
if ($RequestJson -isnot [string] -or $RequestSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Exact request JSON and SHA-256 required' }
$requestBytes=[Text.Encoding]::UTF8.GetBytes($RequestJson)
if ($requestBytes.Length -gt 8388608 -or (Get-ReadbackHash $requestBytes) -cne $RequestSha256) { throw 'Request bytes/hash mismatch' }
$request=$RequestJson | ConvertFrom-Json
if ($request.version -ne 1 -or $request.requestId -cnotmatch '^verify-[a-f0-9]{24}$' -or $request.expectedSha256 -cnotmatch '^[a-f0-9]{64}$' -or $request.collectorSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid request provenance' }
$target=$request.target; $cap=$request.capabilities
if (-not $request.scopeId -or -not $request.readbackId -or -not $target.instanceId -or -not $target.connectorId -or $target.database -cnotmatch '^[a-zA-Z][a-zA-Z0-9_-]*$') { throw 'Explicit target identity required' }
Assert-ReadbackPath $target.rootPath
Assert-ReadbackPath $target.marker.path
$null=Get-ReadbackGuid $target.marker.id; $null=Get-ReadbackGuid $target.marker.templateId
if ($cap.speRead -isnot [bool] -or $cap.fileDownload -isnot [bool] -or $cap.stableReadWindow -isnot [bool] -or $cap.speRead -cne $true -or $cap.fileDownload -cne $true -or $cap.stableReadWindow -cne $true) { throw 'Confirmed read/download/stable-window capabilities required' }
foreach ($bound in @($cap.maxCaptureBytes,$cap.maxRequestBytes,$request.maxBytes)) { if ($bound -isnot [int] -and $bound -isnot [long]) { throw 'Integer capture/request byte bounds required' } }
if ($cap.maxCaptureBytes -lt 4096 -or $cap.maxCaptureBytes -gt 8388608 -or $cap.maxRequestBytes -lt 1024 -or $cap.maxRequestBytes -gt 8388608 -or $request.maxBytes -lt 4096 -or $request.maxBytes -gt $cap.maxCaptureBytes -or $requestBytes.Length -gt $cap.maxRequestBytes) { throw 'Invalid capture/request byte bounds' }
if ($request.queries -isnot [array] -or $request.queries.Count -lt 1 -or $request.queries.Count -gt 100) { throw 'Capture requires 1..100 exact queries' }
foreach ($query in $request.queries) {
    if ($query.lookup -ceq 'id') { $null=Get-ReadbackGuid $query.value }
    elseif ($query.lookup -ceq 'path') { Assert-ReadbackPath $query.value }
    else { throw 'Only exact ID/path queries supported' }
    if ($query.fields -isnot [array]) { throw 'Explicit fields array required' }
    $seen=@{}
    foreach ($field in $query.fields) {
        $id=Get-ReadbackGuid $field.fieldId
        if ($field.storage -cnotin @('shared','unversioned','versioned')) { throw 'Invalid field storage' }
        if ($field.storage -ne 'shared' -and $field.language -cnotmatch '^[a-zA-Z][a-zA-Z0-9-]{0,34}$') { throw 'Explicit field language required' }
        if ($field.storage -eq 'shared' -and $null -ne $field.language) { throw 'Shared field cannot select language' }
        if ($field.storage -eq 'versioned') { if ($field.version -isnot [int] -and $field.version -isnot [long]) { throw 'Integer field version required' }; if ($field.version -lt 1) { throw 'Positive field version required' } }
        elseif ($null -ne $field.version) { throw 'Only versioned fields select version' }
        $key=$id+'|'+$field.storage+'|'+$field.language+'|'+$field.version
        if ($seen.ContainsKey($key)) { throw 'Duplicate field selector' }; $seen[$key]=$true
    }
}
function Get-ReadbackItem($Value,$Language,$Version) {
    $parameters=@{Path=($target.database+':'+$Value);ErrorAction='Stop'}
    if ($Language) { $parameters.Language=$Language }; if ($Version) { $parameters.Version=[string]$Version }
    try { $items=@(Get-Item @parameters) } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return $null }; throw }
    if ($items.Count -gt 1) { throw 'Ambiguous exact readback query' }
    if ($items.Count) { return $items[0] }; return $null
}
function Assert-ReadbackWindow {
    $now=[DateTimeOffset]::UtcNow; $verified=Get-ReadbackTimestamp $cap.verifiedAt; $expires=Get-ReadbackTimestamp $cap.expiresAt
    if ($verified -gt $now -or $expires -le $now -or $expires -le $verified) { throw 'Read capability window expired or invalid' }
    $marker=Get-ReadbackItem (Get-ReadbackGuid $target.marker.id) $null $null
    if ($null -eq $marker -or (Get-ReadbackGuid $marker.ID) -cne (Get-ReadbackGuid $target.marker.id) -or (Get-ReadbackGuid $marker.TemplateID) -cne (Get-ReadbackGuid $target.marker.templateId) -or [string]$marker.Paths.FullPath -cne $target.marker.path) { throw 'Target root marker changed' }
}
function Read-ReadbackObservation($Item,$Query) {
    $id=Get-ReadbackGuid $Item.ID
    Assert-ReadbackPath ([string]$Item.Paths.FullPath)
    if ($Query.lookup -ceq 'id' -and $id -cne (Get-ReadbackGuid $Query.value)) { throw 'Exact item ID mismatch' }
    if ($Query.lookup -ceq 'path' -and [string]$Item.Paths.FullPath -cne $Query.value) { throw 'Exact item path mismatch' }
    $all=@(Get-Item -Path ($target.database+':'+$id) -Language '*' -Version '*' -ErrorAction Stop)
    $versions=@(); $seen=@{}
    foreach ($row in $all) {
        if ((Get-ReadbackGuid $row.ID) -cne $id -or [string]$row.Paths.FullPath -cne [string]$Item.Paths.FullPath -or (Get-ReadbackGuid $row.TemplateID) -cne (Get-ReadbackGuid $Item.TemplateID) -or (Get-ReadbackGuid $row.ParentID) -cne (Get-ReadbackGuid $Item.ParentID)) { throw 'Version identity drift' }
        $rawVersion=[string]$row.Version; $version=0
        if ($rawVersion -cnotmatch '^[0-9]+$' -or -not [int]::TryParse($rawVersion,[ref]$version)) { throw 'Invalid observed version' }
        # SPE may return a version-zero placeholder for an existing versionless item.
        # Identity still must match above; the placeholder is not a language/version tuple.
        if ($version -eq 0) { continue }
        $language=[string]$row.Language
        if ($language -cnotmatch '^[a-zA-Z][a-zA-Z0-9-]{0,34}$') { throw 'Invalid observed language/version' }
        $key=$language+'|'+$version
        if ($seen.ContainsKey($key)) { throw 'Duplicate observed language/version' }; $seen[$key]=$true
        $versions+=@{language=$language;version=$version}
    }
    $fields=@()
    foreach ($selected in $Query.fields) {
        $versionItem=$Item
        if ($selected.storage -eq 'unversioned') { $matches=@($all | Where-Object { [string]$_.Language -ceq $selected.language } | Sort-Object { [int][string]$_.Version }); $versionItem=if ($matches.Count) { $matches[0] } else { $null } }
        elseif ($selected.storage -eq 'versioned') { $matches=@($all | Where-Object { [string]$_.Language -ceq $selected.language -and [int][string]$_.Version -eq $selected.version }); $versionItem=if ($matches.Count) { Get-ReadbackItem $id $selected.language $selected.version } else { $null } }
        if ($null -ne $versionItem -and ((Get-ReadbackGuid $versionItem.ID) -cne $id -or ($selected.storage -ne 'shared' -and [string]$versionItem.Language -cne $selected.language) -or ($selected.storage -eq 'versioned' -and [int][string]$versionItem.Version -ne $selected.version))) { throw 'Selected field version drift' }
        $field=if ($null -ne $versionItem) { $versionItem.Fields[[Sitecore.Data.ID]::Parse((Get-ReadbackGuid $selected.fieldId))] } else { $null }
        $record=[ordered]@{fieldId=(Get-ReadbackGuid $selected.fieldId);storage=$selected.storage;present=($null -ne $field)}
        if ($selected.storage -ne 'shared') { $record.language=$selected.language }; if ($selected.storage -eq 'versioned') { $record.version=[int]$selected.version }
        if ($null -ne $field) { $storage=if ($field.Shared) { 'shared' } elseif ($field.Unversioned) { 'unversioned' } else { 'versioned' }; if ($storage -cne $selected.storage) { throw 'Field storage drift' }; if ([string]::IsNullOrWhiteSpace([string]$field.Type)) { throw 'Field type unavailable' }; $record.fieldType=[string]$field.Type; $record.value=[string]$field.Value }
        $fields+=$record
    }
    return [ordered]@{id=$id;templateId=(Get-ReadbackGuid $Item.TemplateID);path=[string]$Item.Paths.FullPath;parentId=(Get-ReadbackGuid $Item.ParentID);versionsComplete=$true;versions=@($versions | Sort-Object { $_.language },{ $_.version });fields=$fields}
}
Assert-ReadbackWindow
$state=[ordered]@{version=1;scopeId=$request.scopeId;instanceId=$target.instanceId;database=$target.database;rootPath='/sitecore';targetStateId=$request.readbackId;capturedAt=[DateTime]::UtcNow.ToString('o');valueMode='effective';requestId=$request.requestId;requestSha256=$RequestSha256;collectorSha256=$request.collectorSha256;expectedSha256=$request.expectedSha256;complete=$false;errors=@();queries=@()}
foreach ($query in $request.queries) {
    try {
        $item=Get-ReadbackItem $query.value $null $null
        $result=[ordered]@{lookup=$query.lookup;value=$query.value;exists=($null -ne $item)}
        if ($null -ne $item) { $result.item=Read-ReadbackObservation $item $query }
        $state.queries+=$result
    } catch { $state.errors+=@{lookup=$query.lookup;value=$query.value;message='Exact item/field/version read failed; inspect target identity and field scope'} }
}
try { Assert-ReadbackWindow } catch { $state.errors+=@{lookup=$request.queries[0].lookup;value=$request.queries[0].value;message='Read capability window or root marker changed during capture'} }
$state.complete=($state.errors.Count -eq 0)
$bytes=[Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 60 -Compress)+"`n")
if ($bytes.Length -gt $request.maxBytes) {
    $state.complete=$false; $state.queries=@(); $state.errors=@(@{lookup=$request.queries[0].lookup;value=$request.queries[0].value;message='Capture byte limit exceeded; reduce request batch'})
    $bytes=[Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 20 -Compress)+"`n")
    if ($bytes.Length -gt $request.maxBytes) { throw 'Capture error envelope exceeds byte bound' }
}
$dataRoot=[Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder)
if (-not [IO.Path]::IsPathRooted($dataRoot)) { throw 'Physical Sitecore DataFolder required' }
$relative='kajoo/mapped-content/readbacks/'+$request.requestId+'/'+[guid]::NewGuid().ToString('N')
$directory=[IO.Path]::Combine($dataRoot,$relative); [void][IO.Directory]::CreateDirectory($directory)
$file=[IO.Path]::Combine($directory,'target-readback.json')
$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
[ordered]@{kind='kajoo-export';version=1;files=@(@{rootPath='Data';path=$relative+'/target-readback.json';name='target-readback.json';size=$bytes.Length;sha256=(Get-ReadbackHash $bytes)});summary=@{requestId=$request.requestId;complete=$state.complete;errorCount=$state.errors.Count;queryCount=$state.queries.Count}} | ConvertTo-Json -Depth 10 -Compress
