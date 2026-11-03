# Remote SPE entrypoint. The source connector injects only structured Request.
# Exact item/field/version reads; no traversal, content writes or publishing.
$ErrorActionPreference = 'Stop'
if ($null -eq $Request -or $Request.version -ne 1 -or $Request.scope.version -ne 1) { throw 'A versioned capture Request is required' }
$scope = $Request.scope
if ([string]$scope.database -notmatch '^[a-zA-Z][a-zA-Z0-9_-]*$' -or -not $scope.scopeId -or -not $scope.instanceId -or -not $scope.sourceStateId -or -not $Request.requestId) { throw 'Explicit source identity and state are required' }
if ($scope.items.Count -gt 100 -or $scope.renderingInstances.Count -gt 100 -or ($scope.items.Count + $scope.renderingInstances.Count) -lt 1) { throw 'Capture requires 1..100 items and/or 1..100 rendering contexts' }
if ([long]$Request.maxResponseBytes -lt 1024 -or [long]$Request.maxResponseBytes -gt 8388608) { throw 'Response byte limit must be 1024..8388608' }
function Get-CaptureGuid($value) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse([string]$value, [ref]$parsed)) { throw 'Invalid requested GUID' }
    return $parsed.ToString('B').ToUpperInvariant()
}
function Get-CaptureFieldValue($field, $spec, $language, $version) {
    $storage = if ($field.Shared) { 'shared' } elseif ($field.Unversioned) { 'unversioned' } else { 'versioned' }
    if ($storage -ne $spec.storage) { throw 'Field storage changed from approved evidence' }
    if ([string]::IsNullOrWhiteSpace([string]$field.Type)) { throw 'Source field type evidence is unavailable' }
    if ($spec.fieldType -and [string]$field.Type -ine [string]$spec.fieldType) { throw 'Source field type changed' }
    $result = [ordered]@{fieldId=(Get-CaptureGuid $spec.fieldId); storage=$storage; value=[string]$field.Value;fieldType=[string]$field.Type}
    if ($storage -ne 'shared') { $result.language = [string]$language }
    if ($storage -eq 'versioned') { $result.version = [int]$version }
    return $result
}
function Get-CaptureReferences($value, $kind) {
    $ids = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrEmpty($value)) { return @() }
    if ($kind -in @('list','datasource')) {
        foreach ($token in ($value -split '\|')) { if ($token) { $ids.Add((Get-CaptureGuid $token)) } }
    } elseif ($kind -in @('link','media')) {
        $document = [System.Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $settings = [System.Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $reader = [System.Xml.XmlReader]::Create([IO.StringReader]::new($value), $settings)
        try { $document.Load($reader) } finally { $reader.Dispose() }
        $attribute = if ($kind -eq 'media') { 'mediaid' } else { 'id' }
        $target = $document.DocumentElement.GetAttribute($attribute)
        if ($target) { $ids.Add((Get-CaptureGuid $target)) }
    } else { throw 'Unsupported reference kind' }
    return $ids.ToArray()
}
function Read-CaptureItem($spec) {
    if ([string]$spec.path -notmatch '^/sitecore/[^\\:*?\[\]\p{Cc}]+$' -or $spec.path -match '(^|/)\.\.?(/|$)|//|/$') { throw 'Unsafe explicit item path' }
    $inside = $false
    foreach ($root in $scope.rootPaths) { if ($spec.path -ieq $root -or $spec.path.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)) { $inside = $true } }
    if (-not $inside -or -not $spec.versions.Count) { throw 'Item is outside approved roots or version scope' }
    $fields = @{}; $references = @{}; $record = $null
    foreach ($selected in $spec.versions) {
        if ($selected.language -notin $scope.languages -or [int]$selected.version -lt 1) { throw 'Language/version is outside approved scope' }
        $items = @(Get-Item -Path ($scope.database + ':' + $spec.path) -Language $selected.language -Version ([string]$selected.version) -ErrorAction Stop)
        if ($items.Count -ne 1) { throw 'Exact source version was not found' }
        $item = $items[0]
        if ((Get-CaptureGuid $item.ID) -ne (Get-CaptureGuid $spec.id) -or (Get-CaptureGuid $item.TemplateID) -ne (Get-CaptureGuid $spec.templateId) -or [string]$item.Language -cne $selected.language -or [int][string]$item.Version -ne [int]$selected.version -or [string]$item.Paths.FullPath -cne $spec.path) { throw 'Source identity/version differs from approved scope' }
        if ($null -ne $item.Versions -and [int]$item.Versions.Count -lt 1) { throw 'Requested source language has no version' }
        if ($null -eq $record) { $record = [ordered]@{id=(Get-CaptureGuid $item.ID);parentId=(Get-CaptureGuid $item.ParentID);templateId=(Get-CaptureGuid $item.TemplateID);name=[string]$item.Name;path=[string]$item.Paths.FullPath;versions=@($spec.versions);fields=@();references=@()} }
        if ($spec.parentId -and (Get-CaptureGuid $item.ParentID) -ne (Get-CaptureGuid $spec.parentId)) { throw 'Source parent changed' }
        foreach ($fieldSpec in $spec.fields) {
            $fid = Get-CaptureGuid $fieldSpec.fieldId
            $field = $item.Fields[[Sitecore.Data.ID]::Parse($fid)]
            if ($null -eq $field) { throw 'Required source field is absent' }
            $value = Get-CaptureFieldValue $field $fieldSpec $selected.language $selected.version
            $key = $fid + '|' + $value.language + '|' + $value.version
            if ($fields.ContainsKey($key) -and $fields[$key].value -cne $value.value) { throw 'Source shared/unversioned value changed during capture' }
            $fields[$key] = $value
            if ($fieldSpec.referenceKind) {
                $reference = [ordered]@{fieldId=$fid;kind=[string]$fieldSpec.referenceKind;targetSourceIds=@(Get-CaptureReferences $value.value $fieldSpec.referenceKind)}
                if ($value.Contains('language')) { $reference.language = $value.language }
                if ($value.Contains('version')) { $reference.version = $value.version }
                $references[$key] = $reference
            }
        }
    }
    $record.fields = @($fields.Keys | Sort-Object | ForEach-Object { $fields[$_] })
    $record.references = @($references.Keys | Sort-Object | ForEach-Object { $references[$_] })
    return $record
}
function Read-CaptureRendering($spec) {
    $page = @(Get-Item -Path ($scope.database + ':' + (Get-CaptureGuid $spec.pageId)) -Language $spec.language -Version ([string]$spec.version) -ErrorAction Stop)
    if ($page.Count -ne 1 -or [string]$page[0].Language -cne $spec.language -or [int][string]$page[0].Version -ne [int]$spec.version) { throw 'Rendering page version is absent' }
    $inside = $false
    foreach ($root in $scope.rootPaths) { if ([string]$page[0].Paths.FullPath -ieq $root -or $page[0].Paths.FullPath.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)) { $inside = $true } }
    if (-not $inside -or $spec.language -notin $scope.languages -or (Get-CaptureGuid $page[0].ID) -ne (Get-CaptureGuid $spec.pageId)) { throw 'Rendering page is outside approved scope' }
    $devices = [Sitecore.Configuration.Factory]::GetDatabase($scope.database).Resources.Devices.GetAll()
    $device = @($devices | Where-Object { (Get-CaptureGuid $_.ID) -eq (Get-CaptureGuid $spec.deviceId) })
    if ($device.Count -ne 1) { throw 'Requested device is absent' }
    $matches = @(Get-Rendering -Item $page[0] -Device $device[0] -FinalLayout | Where-Object { (Get-CaptureGuid $_.UniqueId) -eq (Get-CaptureGuid $spec.instanceId) })
    if ($matches.Count -ne 1 -or (Get-CaptureGuid $matches[0].ItemID) -ne (Get-CaptureGuid $spec.renderingId)) { throw 'Rendering occurrence is absent or changed' }
    $rendering = $matches[0]
    $record = [ordered]@{instanceId=(Get-CaptureGuid $spec.instanceId);pageId=(Get-CaptureGuid $spec.pageId);deviceId=(Get-CaptureGuid $spec.deviceId);renderingId=(Get-CaptureGuid $spec.renderingId);language=[string]$spec.language;version=[int]$spec.version;parameters=@()}
    if ($spec.datasourceId) {
        # Query/local datasource strings require separate Discovery resolution.
        if ((Get-CaptureGuid $rendering.Datasource) -ne (Get-CaptureGuid $spec.datasourceId)) { throw 'Datasource changed or requires explicit resolution' }
        $record.datasourceId = Get-CaptureGuid $spec.datasourceId
    } elseif ($rendering.Datasource) { throw 'Unexpected rendering datasource' }
    if ($spec.parameterTemplateId) {
        $definition = Get-Item -Path ($scope.database + ':' + (Get-CaptureGuid $spec.renderingId)) -ErrorAction Stop
        if ((Get-CaptureGuid $definition.Fields['Parameters Template'].Value) -ne (Get-CaptureGuid $spec.parameterTemplateId)) { throw 'Rendering parameter template changed' }
        $record.parameterTemplateId = Get-CaptureGuid $spec.parameterTemplateId
    }
    $parameters = [System.Web.HttpUtility]::ParseQueryString([string]$rendering.Parameters)
    foreach ($fieldSpec in $spec.parameters) {
        $definition = Get-Item -Path ($scope.database + ':' + (Get-CaptureGuid $fieldSpec.fieldId)) -ErrorAction Stop
        if ($null -eq $definition -or [string]$definition.Name -notin @($parameters.AllKeys)) { throw 'Required rendering parameter is absent' }
        $type = [string]$definition.Fields['Type'].Value
        if ([string]::IsNullOrWhiteSpace($type) -or ($fieldSpec.fieldType -and $type -ine [string]$fieldSpec.fieldType)) { throw 'Parameter field type evidence is absent or changed' }
        $value = [ordered]@{fieldId=(Get-CaptureGuid $fieldSpec.fieldId);storage=[string]$fieldSpec.storage;value=[string]$parameters[[string]$definition.Name];fieldType=$type}
        if ($fieldSpec.storage -ne 'shared') { $value.language = [string]$spec.language }
        if ($fieldSpec.storage -eq 'versioned') { $value.version = [int]$spec.version }
        $record.parameters += $value
    }
    return $record
}

$relative = 'kajoo/mapped-content/' + [guid]::NewGuid().ToString('N')
$dataRoot = [Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder)
if (-not [IO.Path]::IsPathRooted($dataRoot)) { throw 'Physical Sitecore DataFolder is required' }
$directory = [IO.Path]::Combine($dataRoot, $relative)
[void][IO.Directory]::CreateDirectory($directory)
$file = [IO.Path]::Combine($directory, 'capture.jsonl')
$writer = [IO.StreamWriter]::new([IO.File]::Open($file, [IO.FileMode]::CreateNew), [Text.UTF8Encoding]::new($false))
$writer.NewLine = "`n"
$written = 0; $errors = 0; $responseBytes = 0; $limited = $false
function Write-CaptureRecord($kind, $data) {
    $line = [ordered]@{kind=$kind;data=$data} | ConvertTo-Json -Depth 40 -Compress
    $size = [Text.Encoding]::UTF8.GetByteCount($line + "`n")
    if ($kind -ne 'complete' -and $script:responseBytes + $size -gt [long]$Request.maxResponseBytes - 512) { $script:limited=$true; throw 'Response byte limit reached; reduce the approved batch' }
    $writer.WriteLine($line); $script:responseBytes += $size
}
try {
    Write-CaptureRecord 'header' ([ordered]@{version=1;scopeId=$scope.scopeId;instanceId=$scope.instanceId;database=$scope.database;sourceStateId=$scope.sourceStateId;requestId=$Request.requestId;capturedAt=[DateTime]::UtcNow.ToString('o');valueMode='effective'})
    foreach ($spec in $scope.items) {
        try { Write-CaptureRecord 'item' (Read-CaptureItem $spec); $written++ }
        catch {
            if ($limited) { break }
            $errors++
            try { Write-CaptureRecord 'error' @{id=[string]$spec.id;message='Required source item/field/version could not be captured; inspect scope, source state and limits'} } catch { $errors--; break }
        }
    }
    foreach ($spec in $scope.renderingInstances) {
        if ($limited) { break }
        try { Write-CaptureRecord 'renderingInstance' (Read-CaptureRendering $spec); $written++ }
        catch {
            if ($limited) { break }
            $errors++
            try { Write-CaptureRecord 'error' @{id=[string]$spec.instanceId;message='Required rendering context could not be captured; inspect scope and source state'} } catch { $errors--; break }
        }
    }
    Write-CaptureRecord 'complete' @{requestId=$Request.requestId;written=$written;errors=$errors;partial=($errors -gt 0 -or $limited);limited=$limited}
} finally { $writer.Dispose() }
[ordered]@{kind='kajoo-export';version=1;files=@(@{rootPath='Data';path=$relative+'/capture.jsonl';name='capture.jsonl';size=([IO.FileInfo]$file).Length});summary=@{requestId=$Request.requestId;written=$written;errorCount=$errors;limited=$limited;partial=($errors -gt 0 -or $limited)}} | ConvertTo-Json -Depth 10 -Compress
