# Synthetic PowerShell contract tests: no Sitecore calls or live claims.
$ErrorActionPreference='Stop'
$scriptPath=Join-Path $PSScriptRoot '../scripts/media-package.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $scriptPath),[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw ($errors | Out-String)}
# Load function definitions only, never execute the remote entrypoint.
foreach ($node in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { . ([scriptblock]::Create($node.Extent.Text)) }
$script:passed=0
function Assert-True($Condition,$Message) {if (-not $Condition) {throw $Message};$script:passed++}
function Assert-Throws($Action,$Pattern) {try {& $Action;throw 'Expected rejection missing'} catch {if ($_.Exception.Message -notmatch $Pattern) {throw};$script:passed++}}
Assert-True ((Get-MediaHash ([Text.Encoding]::UTF8.GetBytes('abc'))) -ceq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'SHA256 differs'
Assert-True ((Get-MediaGuid '{11111111-1111-1111-1111-111111111111}') -ceq '11111111-1111-1111-1111-111111111111') 'GUID normalization differs'
Assert-Throws {Get-MediaGuid 'bad'} 'Invalid media GUID'
foreach ($bad in @('/sitecore/content/x','/sitecore/media library','/sitecore/media library/../x','/sitecore/media library/x//y','/sitecore/media library/x/','/sitecore/media library/x?')) {Assert-Throws {Assert-MediaPath $bad} 'Media path'}
Assert-MediaPath '/sitecore/media library/Alexion/hero'
$rawField=[pscustomobject]@{ID='11111111-1111-1111-1111-111111111111';Name='__Display name';Shared=$false;Unversioned=$false;Value='Original display name'}
$rawField | Add-Member ScriptMethod GetValue {param($standard,$fallback) if ($standard -or $fallback) {throw 'Fallback requested'};return $this.Value}
$observedField=Read-MediaField $rawField 'fr' 3
Assert-True ($observedField.value -ceq 'Original display name' -and $observedField.language -ceq 'fr' -and $observedField.version -eq 3) 'Stable display name metadata lost or fallback used'
$rawField.Name='__Sortorder';$rawField.Shared=$true
Assert-True ((Read-MediaField $rawField 'fr' 3).language -ceq '' -and (Read-MediaField $rawField 'fr' 3).version -eq 0) 'Shared sortorder storage lost'
$rawField.Name='Title';$rawField.Shared=$false;$rawField.Unversioned=$true
Assert-True ((Read-MediaField $rawField 'fr' 3).language -ceq 'fr' -and (Read-MediaField $rawField 'fr' 3).version -eq 0) 'Unversioned storage lost'
foreach ($name in @('Blob','__Revision','__Updated','__Updated by','__Lock')) {$rawField.Name=$name;Assert-True ($null -eq (Read-MediaField $rawField 'fr' 3)) 'Volatile/blob fingerprint field not excluded'}
Assert-True ((Get-MediaJson @{b=2;a=1}) -ceq (Get-MediaJson ([pscustomobject]@{a=1;b=2}))) 'Canonical comparison depends on JSON object insertion order'
Assert-True ((Convert-MediaTimestamp ([DateTime]::UtcNow)) -is [DateTimeOffset]) 'Timestamp normalization failed'
$emptyBlob=[pscustomobject]@{Value=''}
$emptyBlob | Add-Member ScriptMethod GetValue {param($standard,$fallback) if ($standard -or $fallback) {throw 'Blob fallback requested'};return $this.Value}
Assert-Throws {Assert-MediaRawBlob ([pscustomobject]@{Fields=@{}})} 'lacks raw Blob'
Assert-Throws {Assert-MediaRawBlob ([pscustomobject]@{Fields=@{Blob=$emptyBlob}})} 'lacks raw Blob'
$emptyBlob.Value='11111111-1111-1111-1111-111111111111'
Assert-MediaRawBlob ([pscustomobject]@{Fields=@{Blob=$emptyBlob}})
Assert-True $true 'Raw Blob validation rejected stored Blob'
$sharedFolderField=[pscustomobject]@{ID='33333333-3333-3333-3333-333333333333';Name='__Sortorder';Shared=$true;Unversioned=$false;Value='42'}
$sharedFolderField | Add-Member ScriptMethod GetValue {param($standard,$fallback) if ($standard -or $fallback) {throw 'Folder fallback requested'};return $this.Value}
$folderFields=[Collections.Generic.List[object]]::new();$folderFields.Add($sharedFolderField)
$folderFields | Add-Member ScriptMethod ReadAll {} -PassThru | Out-Null
$folderItem=[pscustomobject]@{Fields=$folderFields}
$folderShared=Read-MediaSharedFields $folderItem
Assert-True ($folderShared.Count -eq 1 -and $folderShared['33333333-3333-3333-3333-333333333333||0'].value -ceq '42') 'Versionless folder shared metadata omitted'
$testDirectory=Join-Path ([IO.Path]::GetTempPath()) ('kajoo-media-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testDirectory)
try {
    $script:dataRoot=$testDirectory
    $controlled=Join-Path $testDirectory 'alexion-media';[void][IO.Directory]::CreateDirectory($controlled)
    $path=Join-Path $controlled 'one.update';[IO.File]::WriteAllBytes($path,[byte[]](1,2,3))
    $file=Get-MediaFile $path
    $package=@{id='one';serverPath=$path;bytes=3;sha256=$file.sha256;itemIds=@('11111111-1111-1111-1111-111111111111');order=0}
    Assert-True ((Assert-MediaPackage $package) -ceq $path) 'Verified file descriptor failed'
    $package.bytes=2;Assert-Throws {Assert-MediaPackage $package} 'mismatch';$package.bytes=3
    $package.sha256='0'*64;Assert-Throws {Assert-MediaPackage $package} 'mismatch';$package.sha256=$file.sha256
    $package.bytes=100000001;Assert-Throws {Assert-MediaPackage $package} 'Invalid transferred';$package.bytes=3
    $package.serverPath=Join-Path $testDirectory 'outside.update';Assert-Throws {Assert-MediaPackage $package} 'outside controlled';$package.serverPath=$path
    $durable=Join-Path $testDirectory 'durable.json';Write-MediaDurable $durable @{status='installing'}
    Assert-Throws {Write-MediaDurable $durable @{status='successful'}} 'already exists'
    Assert-True (([IO.File]::ReadAllText($durable) | ConvertFrom-Json).status -ceq 'installing') 'Durable checkpoint replaced'
    # Stub item observations: ID and path queries must both happen, conflicts never disappear.
    $expectedId='11111111-1111-1111-1111-111111111111';$otherId='22222222-2222-2222-2222-222222222222'
    $script:queries=@();$script:fakeItems=@{}
    function Get-MediaItem($Identity) {$script:queries+=[string]$Identity;return $script:fakeItems[[string]$Identity]}
    function Read-MediaItem($Item) {return @{id=[string]$Item.ID;path=$Item.path;templateId=$otherId;parentId=$otherId;isFolder=$false;fields=@();blobs=@()}}
    $script:fakeItems['/sitecore/media library/a']=[pscustomobject]@{ID=$otherId;path='/sitecore/media library/a'}
    $observed=Read-MediaInventory @(@{id=$expectedId;path='/sitecore/media library/a'})
    Assert-True ($observed.missingIds.Count -eq 1 -and $observed.collisions.Count -eq 1 -and $observed.items.Count -eq 1) 'ID/path conflict incorrectly omitted'
    Assert-True ($script:queries.Count -eq 2) 'Both lookups required'
    # Synthetic package exporter: real measured bytes, recursive splitting, no item slicing.
    function Read-MediaItem($Item) {return $Item}
    function Get-MediaItem($Identity) {return $script:fakeItems[$Identity]}
    function Export-Item {param($Item,$Root,[switch]$ItemPathsAbsolute) [IO.File]::WriteAllText((Join-Path $Root ($Item.id+'.item')),$Item.id)}
    function Get-UpdatePackageDiff {param($SourcePath,$TargetPath) if ([IO.Directory]::GetFiles($SourcePath).Count) {throw 'Source not empty'};return @{count=[IO.Directory]::GetFiles($TargetPath).Count}}
    function Export-UpdatePackage {param($CommandList,$Path,$Name) $stream=[IO.File]::Create($Path);try {$stream.SetLength($(if ($CommandList.count -gt 1) {100000001} else {10}))} finally {$stream.Dispose()}}
    $script:workDirectory=Join-Path $testDirectory 'groups';[void][IO.Directory]::CreateDirectory($workDirectory)
    $one=@{id=$expectedId;path='/sitecore/media library/a'};$two=@{id=$otherId;path='/sitecore/media library/b'};$script:fakeItems=@{};$script:fakeItems[$expectedId]=$one;$script:fakeItems[$otherId]=$two
    $parts=@(Export-MediaGroup @($one,$two) 'group')
    Assert-True ($parts.Count -eq 2 -and $parts[0].bytes -eq 10 -and $parts[1].bytes -eq 10) 'Actual-size recursive split failed'
    Assert-True ($parts[0].itemIds.Count -eq 1 -and $parts[1].itemIds.Count -eq 1) 'Item group split corrupted identity'
    function Export-UpdatePackage {param($CommandList,$Path,$Name) $stream=[IO.File]::Create($Path);try {$stream.SetLength(100000001)} finally {$stream.Dispose()}}
    Assert-Throws {Export-MediaGroup @($one) 'oversized'} 'complete media item exceeds'
    # Execute the real entrypoint using Sitecore type shims and SPE command stubs.
    # Production Sitecore assemblies, connector auth and binary semantics remain a pilot gate.
    Add-Type -TypeDefinition @"
namespace Sitecore { public static class MainUtil { public static string MapPath(string path) { return path; } } }
namespace Sitecore.Configuration {
 public static class Settings { public static string DataFolder; }
 public static class Factory { public static object GetDatabase(string name) { return new object(); } }
}
"@
    $entry=([IO.File]::ReadAllText((Resolve-Path $scriptPath)) -split '# Entry point guards occur before Sitecore access or filesystem writes\.',2)[1]
    $script:entryBlock=[scriptblock]::Create($entry)
    $RequestJson='x'*8388609;$RequestSha256='0'*64
    Assert-Throws {& $script:entryBlock} '8 MiB'
    function Invoke-SyntheticInstall([string]$Mode) {
        $case=Join-Path $testDirectory $Mode;[void][IO.Directory]::CreateDirectory($case)
        [Sitecore.Configuration.Settings]::DataFolder=$case;$script:dataRoot=$case
        $mediaDirectory=Join-Path $case 'alexion-media';[void][IO.Directory]::CreateDirectory($mediaDirectory)
        $pilotDirectory=Join-Path $mediaDirectory 'pilots';[void][IO.Directory]::CreateDirectory($pilotDirectory)
        $id='11111111-1111-1111-1111-111111111111';$template='22222222-2222-2222-2222-222222222222'
        $target=@{instanceId='target';connectorId='connector';database='master';deployment='XM';rootPath='/sitecore/media library';marker=@{id=$template;path='/sitecore/media library';templateId=$template}}
        $script:fakeItems=@{};$script:fakeItems[$template]=[pscustomobject]@{ID=$template;TemplateID=$template;Paths=@{FullPath='/sitecore/media library'}}
        $item=@{id=$id;path='/sitecore/media library/a';templateId=$template;parentId=$template;isFolder=$false;fields=@();blobs=@()};$script:fakeItems[$id]=$item;$script:fakeItems[$item.path]=$item
        function Get-MediaItem($Identity) {return $script:fakeItems[[string]$Identity]}
        function Read-MediaItem($Item) {return $Item}
        $expiry=[DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o')
        $pilot=Get-MediaJson @{target=$target;expiresAt=$expiry;adapterVersion='media-package-v1';installMode='Update';binaryRoundTripVerified=$true;restoreVerified=$true;exportScopeVerified=$true}
        $pilotHash=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($pilot));[IO.File]::WriteAllText((Join-Path $pilotDirectory ($pilotHash+'.json')),$pilot)
        $path=Join-Path $mediaDirectory 'media.update';[IO.File]::WriteAllBytes($path,[byte[]](1,2,3));$file=Get-MediaFile $path
        $package=@{id='media-0001';path='media-0001.update';serverPath=$path;bytes=$file.bytes;sha256=$file.sha256;itemIds=@($id);order=1}
        $sourceHash='a'*64
        $manifestJson=Get-MediaJson @{kind='media-package-manifest';version=1;scopeId='site:en';sourceInventorySha256=$sourceHash;maxPackageBytes=100000000;requestSha256=('b'*64);items=@($item);packages=@($package)}
        $manifestHash=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($manifestJson))
        $reviewJson=Get-MediaJson @{scopeId='site:en';taskId='content.media-install';target=$target;operationId='operation-1';planSha256=('c'*64);sourceInventorySha256=$sourceHash;manifestSha256=$manifestHash;package=$package;items=@($item);currentItems=@($item);missingIds=@();collisions=@()}
        if ($Mode -eq 'drift') {$reviewObject=$reviewJson | ConvertFrom-Json;$reviewObject.currentItems[0].fields=@(@{id=$template;language='en';version=1;value='Old value'});$reviewJson=Get-MediaJson $reviewObject}
        $reviewHash=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($reviewJson))
        $requestObject=@{kind='media-request';version=1;scopeId='site:en';taskId='content.media-install';requestId='request-1';action='install';target=$target;capabilities=@{pilotSha256=$pilotHash;speRead=$true;fileTransfer=$true;stableReadWindow=$true;updatePackages=$true;binaryRoundTripVerified=$true;restoreVerified=$true;exclusiveWriteWindow=$true;verifiedAt=[DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o');expiresAt=$expiry};sourceInventorySha256=$sourceHash;manifestJson=$manifestJson;manifestSha256=$manifestHash;reviewJson=$reviewJson;reviewSha256=$reviewHash;approval=@{kind='mutation';choice='approve';scopeId='site:en';taskId='content.media-install';at=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');userResponse='Approve this media installation';inputs=@(@{sha256=$reviewHash})}}
        $script:upgradeCalls=0;$script:mode=$Mode
        function Install-UpdatePackage {
            [CmdletBinding()]param($Path,$UpgradeAction,$InstallMode,$RollbackPackagePath)
            if ($UpgradeAction -eq 'Preview') {if ($script:mode -eq 'preview-warning') {Write-Warning 'Synthetic contingency'};return}
            $script:upgradeCalls++
            if ($script:mode -eq 'post-drift') {$script:fakeItems['11111111-1111-1111-1111-111111111111'].fields=@(@{id='22222222-2222-2222-2222-222222222222';language='en';version=1;value='Unexpected mutation'})}
            if ($script:mode -eq 'unknown') {throw 'Synthetic install interruption'}
        }
        if ($Mode -eq 'bad-approval') {$requestObject.approval.userResponse='';$RequestJson=Get-MediaJson $requestObject;$RequestSha256=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($RequestJson));Assert-Throws {& $script:entryBlock} 'Real response';Assert-True ($script:upgradeCalls -eq 0) 'Invalid approval allowed upgrade';return}
        if ($Mode -eq 'bad-manifest') {$requestObject.manifestJson+=' ';$RequestJson=Get-MediaJson $requestObject;$RequestSha256=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($RequestJson));Assert-Throws {& $script:entryBlock} 'source manifest bytes/hash';Assert-True ($script:upgradeCalls -eq 0) 'Altered manifest allowed upgrade';return}
        if ($Mode -eq 'bad-bytes') {[IO.File]::WriteAllBytes($path,[byte[]](4,5,6))}
        $RequestJson=Get-MediaJson $requestObject;$RequestSha256=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($RequestJson))
        $output=& $script:entryBlock | ConvertFrom-Json
        $resultFile=@($output.files | Where-Object name -eq 'result.json')[0]
        $receipt=[IO.File]::ReadAllText((Join-Path $case $resultFile.path)) | ConvertFrom-Json
        if ($Mode -eq 'success') {Assert-True ($receipt.status -eq 'successful' -and $script:upgradeCalls -eq 1 -and $receipt.manifestSha256 -ceq $manifestHash) 'Exact synthetic install failed'}
        if ($Mode -eq 'preview-warning') {Assert-True ($receipt.status -eq 'failed' -and $script:upgradeCalls -eq 0) 'Preview warning allowed Upgrade'}
        if ($Mode -in @('drift','bad-bytes')) {Assert-True ($receipt.status -eq 'failed' -and $script:upgradeCalls -eq 0) 'Drift/hash mismatch allowed Upgrade'}
        if ($Mode -eq 'post-drift') {Assert-True ($receipt.status -eq 'unknown' -and $script:upgradeCalls -eq 1) 'Post-write mismatch was labelled successful'}
        if ($Mode -eq 'unknown') {
            Assert-True ($receipt.status -eq 'unknown' -and $script:upgradeCalls -eq 1 -and @([IO.Directory]::GetFiles($mediaDirectory,'*.lock')).Count -eq 1) 'Unknown operation did not preserve lock'
            $requestObject.requestId='request-2';$RequestJson=Get-MediaJson $requestObject;$RequestSha256=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($RequestJson))
            $null=& $script:entryBlock
            Assert-True ($script:upgradeCalls -eq 1) 'Unknown package automatically replayed'
            foreach ($lockFile in [IO.Directory]::GetFiles($mediaDirectory,'*.lock')) {[IO.File]::Delete($lockFile)}
            Assert-True (@(Get-MediaUnresolvedOperations).Count -gt 0) 'Deleting lock erased immutable unknown operation history'
        }
    }
    Invoke-SyntheticInstall 'success'
    Invoke-SyntheticInstall 'preview-warning'
    Invoke-SyntheticInstall 'unknown'
    Invoke-SyntheticInstall 'bad-approval'
    Invoke-SyntheticInstall 'bad-manifest'
    Invoke-SyntheticInstall 'bad-bytes'
    Invoke-SyntheticInstall 'drift'
    Invoke-SyntheticInstall 'post-drift'
} finally {
    # Only delete explicitly created synthetic files within this exact temp directory.
    $resolved=[IO.Path]::GetFullPath($testDirectory)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'kajoo-media-test-*') {throw 'Unsafe synthetic cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ('Passed '+$script:passed+' synthetic media assertions; remote script syntax parsed. No live Sitecore validation.')
