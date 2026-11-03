# Exact, bounded, read-only SPE collector. RequestJson and RequestSha256 are connector parameters.
$ErrorActionPreference='Stop'
if($RequestJson-isnot[string]-or$RequestSha256-cnotmatch'^[a-f0-9]{64}$'){throw 'Exact read request required'}
$bytes=[Text.Encoding]::UTF8.GetBytes($RequestJson);if($bytes.Length-gt8388608-or(Get-PresHash $bytes)-cne$RequestSha256){throw 'Read request bytes/hash mismatch'}
$request=$RequestJson|ConvertFrom-Json;$Target=$request.target;$Cap=$request.capabilities
Assert-PresEnvironment $request
if($request.kind-cne'presentation-read-request'-or$request.queries-isnot[array]-or$request.queries.Count-lt1-or$request.queries.Count-gt[long]$Cap.maxReadItems-or$request.collectorSha256-cnotmatch'^[a-f0-9]{64}$'){throw 'Invalid bounded presentation read request'}
$state=[ordered]@{version=1;kind='presentation-target-state';scopeId=$request.scopeId;target=$Target;requestSha256=$RequestSha256;collectorSha256=$request.collectorSha256;capturedAt=[DateTimeOffset]::UtcNow.ToString('o');queries=@();templates=@();consumers=@();complete=$false;errors=@()}
try {
    foreach($query in $request.queries){$state.queries+=Get-PresQuery $query}
    foreach($template in $request.templateIds){foreach($language in $request.languages){$state.templates+=Get-PresTemplate $template $language}}
    $state.consumers=@(Get-PresConsumers $request.consumerTemplateIds)
    $state.complete=$true
}catch{$state.errors+=@{message=$_.Exception.Message}}
if((Get-PresTime $Cap.expiresAt)-le[DateTimeOffset]::UtcNow){$state.complete=$false;$state.errors+=@{message='Read window expired'}}
$out=[Text.Encoding]::UTF8.GetBytes(($state|ConvertTo-Json -Depth 90 -Compress)+"`n");if($out.Length-gt[long]$Cap.maxCaptureBytes){$state.complete=$false;$state.queries=@();$state.templates=@();$state.consumers=@();$state.errors=@(@{message='Presentation capture byte bound exceeded'})}
$DataRoot=[IO.Path]::GetFullPath([Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder));$directory=[IO.Path]::Combine($DataRoot,'kajoo-presentation-read',[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($directory)
Write-PresDurable ([IO.Path]::Combine($directory,'presentation-state.json')) $state
Write-PresExport $directory
