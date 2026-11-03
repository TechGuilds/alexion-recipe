# Connector-only SPE adapter. Inject the exact reviewed $RequestJson and $RequestSha256.
# Requires XP/XM SPE, a server-owned pilot attestation and original-blob round-trip proof.
# No CLI Sitecore credentials, publishing, transforms, automatic rollback or retry.
# SPE reference: https://doc.sitecorepowershell.com/appendix/packaging/export-item
# https://doc.sitecorepowershell.com/appendix/packaging/get-updatepackagediff
# https://doc.sitecorepowershell.com/appendix/packaging/export-updatepackage
# https://doc.sitecorepowershell.com/appendix/packaging/install-updatepackage
# Pilot attestations must be provisioned by a trusted server operator, never from
# request-provided booleans. Keep the pilots directory outside connector upload paths.
$ErrorActionPreference = 'Stop'
function Get-MediaHash([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
}
function ConvertTo-MediaCanonical($Value) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $sorted=[ordered]@{};foreach ($key in @($Value.Keys | Sort-Object)) {$sorted[[string]$key]=ConvertTo-MediaCanonical $Value[$key]};return $sorted
    }
    if ($Value -is [Collections.IEnumerable]) {
        $array=@();foreach ($entry in $Value) {$array+=,(ConvertTo-MediaCanonical $entry)};return ,$array
    }
    $sorted=[ordered]@{};foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {$sorted[$property.Name]=ConvertTo-MediaCanonical $property.Value};return $sorted
}
function Get-MediaJson($Value) { return ConvertTo-Json -InputObject (ConvertTo-MediaCanonical $Value) -Depth 90 -Compress }
function Convert-MediaTimestamp($Value) {
    if ($Value -is [DateTimeOffset]) {return $Value}
    if ($Value -is [DateTime]) {return [DateTimeOffset]::new($Value)}
    return [DateTimeOffset]::Parse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
}
function Get-MediaGuid($Value) {
    $id = [guid]::Empty
    if (-not [guid]::TryParse([string]$Value,[ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid media GUID' }
    return $id.ToString('D').ToLowerInvariant()
}
function Assert-MediaPath([string]$Path) {
    if ($Path -cnotmatch '^/sitecore/media library/[^\\:*?\[\]\p{Cc}]+$' -or $Path -match '(^|/)\.\.?(/|$)|//|/$') { throw 'Media path must be strictly below /sitecore/media library' }
}
function Assert-MediaPhysicalPath([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path);$boundary=[IO.Path]::GetFullPath($script:dataRoot).TrimEnd('\','/')
    if ($full -cne $boundary -and -not $full.StartsWith($boundary+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {throw 'Media filesystem path escapes DataFolder'}
    $cursor=$full
    while ($cursor.Length -ge $boundary.Length) {
        if (([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) -and (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {throw 'Media filesystem reparse points are unsupported'}
        if ($cursor -ieq $boundary) {break}
        $cursor=[IO.Path]::GetDirectoryName($cursor)
        if (-not $cursor) {throw 'Media filesystem boundary unavailable'}
    }
}
function Write-MediaDurable([string]$Path,$Value) {
    Assert-MediaPhysicalPath $Path
    $bytes = [Text.Encoding]::UTF8.GetBytes((Get-MediaJson $Value))
    $stream = [IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Get-MediaFile([string]$Path) {
    Assert-MediaPhysicalPath $Path
    if (-not [IO.File]::Exists($Path)) { throw 'Package file absent' }
    $stream = [IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return @{bytes=$stream.Length;sha256=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()} } finally { $hash.Dispose(); $stream.Dispose() }
}
function Get-MediaTargetKey {
    return Get-MediaHash ([Text.Encoding]::UTF8.GetBytes(($script:request.target.instanceId+'|'+$script:request.target.database.ToLowerInvariant()+'|/sitecore/media library')))
}
function Get-MediaUnresolvedOperations {
    $unresolved=@();$targetKey=Get-MediaTargetKey
    $lockPath=[IO.Path]::Combine($script:dataRoot,'alexion-media',($targetKey+'.lock'))
    if ([IO.File]::Exists($lockPath)) {$unresolved+=@{status='unknown';reason='Exclusive media writer lock exists';lockId=$targetKey}}
    $directory=[IO.Path]::Combine($script:dataRoot,'alexion-media','operations',$targetKey)
    if ([IO.Directory]::Exists($directory)) {
        $files=@([IO.Directory]::GetFiles($directory,'*.installing.json'))
        if ($files.Count -gt 10000) {throw 'Operation history exceeds safe read bound; operator reconciliation required'}
        foreach ($file in $files) {
            $resultPath=$file.Replace('.installing.json','.result.json')
            if (-not [IO.File]::Exists($resultPath) -or ([IO.File]::ReadAllText($resultPath) | ConvertFrom-Json).status -cne 'successful') {$unresolved+=@{status='unknown';operationId=[IO.Path]::GetFileName($file).Replace('.installing.json','');reason='Durable install intent lacks successful verified terminal result'}}
        }
    }
    return @($unresolved)
}
function Read-MediaField($Field,[string]$Language,[int]$Version) {
    if ([string]$Field.Name -in @('__Revision','__Updated','__Updated by','__Lock','Blob')) {return $null}
    $lang=if ($Field.Shared) {''} else {$Language}
    $number=if ($Field.Shared -or $Field.Unversioned) {0} else {$Version}
    return [ordered]@{id=(Get-MediaGuid $Field.ID);language=$lang;version=$number;value=[string]$Field.GetValue($false,$false)}
}
function Get-MediaItem($Identity) { return $script:database.GetItem([string]$Identity) }
function Read-MediaSharedFields($Item) {
    $fields=@{};$Item.Fields.ReadAll()
    foreach ($field in $Item.Fields) {
        if (-not $field.Shared) {continue}
        $record=Read-MediaField $field '' 0
        if ($null -ne $record) {$fields[($record.id+'||0')]=$record}
    }
    return $fields
}
function Assert-MediaRawBlob($Version) {
    $blob=$Version.Fields['Blob']
    if ($null -eq $blob -or [string]::IsNullOrEmpty([string]$blob.GetValue($false,$false))) {throw 'Nonfolder media version lacks raw Blob; fallback and file-based media are unsupported'}
}
function Read-MediaItem($Item) {
    Assert-MediaPath ([string]$Item.Paths.FullPath)
    if ($null -eq $Item.Paths.PSObject.Properties['IsMediaItem']) {throw 'Media classification unavailable'}
    $isFolder=-not [bool]$Item.Paths.IsMediaItem
    $fields=Read-MediaSharedFields $Item; $blobs=@()
    # Database.GetItem(language,version) alone is insufficient: exact raw versions and
    # Field.GetValue(false,false) prevent language, version and standard-value fallback.
    foreach ($language in @($Item.Languages | Sort-Object Name)) {
        $localized=$script:database.GetItem($Item.ID,$language,[Sitecore.Data.Version]::Latest)
        if ($null -eq $localized) {throw 'Configured media language unavailable'}
        $localized.Fields.ReadAll()
        foreach ($field in $localized.Fields) {
            if (-not $field.Unversioned -or $field.Shared) {continue}
            $record=Read-MediaField $field ([string]$language.Name) 0
            if ($null -ne $record) {$fields[($record.id+'|'+$record.language+'|0')]=$record}
        }
        foreach ($version in @($localized.Versions.GetVersions() | Sort-Object { [int][string]$_.Version })) {
            if ([string]$version.Language.Name -cne [string]$language.Name -or [int][string]$version.Version -lt 1) { throw 'Unexpected fallback version' }
            $version.Fields.ReadAll()
            foreach ($field in $version.Fields) {
                $record=Read-MediaField $field ([string]$language.Name) ([int][string]$version.Version)
                if ($null -eq $record) {continue}
                $key=$record.id+'|'+$record.language+'|'+$record.version
                if ($fields.ContainsKey($key) -and (Get-MediaJson $fields[$key]) -cne (Get-MediaJson $record)) { throw 'Media changed during capture' }
                $fields[$key]=$record
            }
            $media=[Sitecore.Data.Items.MediaItem]::new($version)
            if (-not $isFolder) {
                Assert-MediaRawBlob $version
                $stream=$media.GetMediaStream()
                if ($null -eq $stream) { throw 'Original media stream unavailable' }
                $hash=[Security.Cryptography.SHA256]::Create()
                try {
                    if (-not $stream.CanSeek) { throw 'Original media stream length unavailable' }
                    $length=$stream.Length
                    $digest=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
                    $blobs+= [ordered]@{language=[string]$language.Name;version=[int][string]$version.Version;bytes=$length;sha256=$digest}
                } finally { $hash.Dispose();$stream.Dispose() }
            }
        }
    }
    if (-not $isFolder -and $blobs.Count -lt 1) {throw 'Nonfolder media has no real binary versions'}
    return [ordered]@{id=(Get-MediaGuid $Item.ID);path=[string]$Item.Paths.FullPath;templateId=(Get-MediaGuid $Item.TemplateID);parentId=(Get-MediaGuid $Item.ParentID);isFolder=$isFolder;fields=@($fields.Keys | Sort-Object | ForEach-Object {$fields[$_]});blobs=@($blobs)}
}
function Read-MediaInventory($Expected) {
    $records=@{}; $missing=@(); $collisions=@()
    foreach ($spec in @($Expected)) {
        Assert-MediaPath $spec.path
        $id=Get-MediaGuid $spec.id
        $byId=Get-MediaItem $id; $byPath=Get-MediaItem $spec.path
        if ($null -eq $byId) { $missing+=$id } else { $records[(Get-MediaGuid $byId.ID)]=Read-MediaItem $byId }
        if ($null -ne $byPath) {
            $found=Get-MediaGuid $byPath.ID
            $records[$found]=Read-MediaItem $byPath
            if ($found -cne $id) { $collisions+=@{expectedId=$id;observedId=$found;path=$spec.path} }
        }
    }
    return [ordered]@{items=@($records.Values | Sort-Object path,id);missingIds=@($missing | Sort-Object -Unique);collisions=@($collisions | Sort-Object path)}
}
function Get-MediaObservationKey($Observation) {
    return Get-MediaJson ([ordered]@{items=@($Observation.items | Sort-Object path,id);missingIds=@($Observation.missingIds | Sort-Object);collisions=@($Observation.collisions | Sort-Object path)})
}
function Assert-MediaPackage($Package) {
    if ($Package.id -notmatch '^[a-zA-Z0-9_-]+$' -or $Package.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$Package.bytes -lt 1 -or [long]$Package.bytes -gt 100000000 -or -not [IO.Path]::IsPathRooted([string]$Package.serverPath)) { throw 'Invalid transferred package descriptor' }
    $path=[IO.Path]::GetFullPath([string]$Package.serverPath)
    $prefix=[IO.Path]::Combine($script:dataRoot,'alexion-media')+[IO.Path]::DirectorySeparatorChar
    if (-not $path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($path) -cne '.update') { throw 'Package outside controlled media transfer directory' }
    $actual=Get-MediaFile $path
    if ($actual.bytes -ne $Package.bytes -or $actual.sha256 -cne $Package.sha256) { throw 'Transferred package bytes/hash mismatch' }
    return $path
}
function Assert-MediaManifest($Packages,$ExpectedItems) {
    if ($script:request.manifestSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-MediaHash ([Text.Encoding]::UTF8.GetBytes([string]$script:request.manifestJson))) -cne $script:request.manifestSha256) {throw 'Exact trusted source manifest bytes/hash required'}
    $manifest=$script:request.manifestJson | ConvertFrom-Json
    if (@($manifest.items).Count -lt 1 -or @($manifest.items).Count -gt 5000 -or @($manifest.packages).Count -gt 5000 -or @($ExpectedItems).Count -gt 5000) {throw 'Manifest item/package bound exceeded'}
    if ($manifest.kind -cne 'media-package-manifest' -or $manifest.version -ne 1 -or $manifest.scopeId -cne $script:request.scopeId -or $manifest.sourceInventorySha256 -cne $script:request.sourceInventorySha256 -or $manifest.maxPackageBytes -ne 100000000 -or $manifest.requestSha256 -notmatch '^[a-f0-9]{64}$') {throw 'Source manifest binding invalid'}
    $seen=@{};$order=@{};$owners=@{}
    foreach ($package in @($manifest.packages)) {
        if ($seen.ContainsKey([string]$package.id) -or $order.ContainsKey([int]$package.order) -or [int]$package.order -lt 1 -or [long]$package.bytes -lt 1 -or [long]$package.bytes -gt 100000000 -or $package.sha256 -notmatch '^[a-f0-9]{64}$' -or @($package.itemIds).Count -lt 1) {throw 'Source manifest package invalid'}
        $seen[[string]$package.id]=$package;$order[[int]$package.order]=$true
        foreach ($id in @($package.itemIds)) {if ($owners.ContainsKey([string]$id)) {throw 'Duplicate manifest package item'};$owners[[string]$id]=[int]$package.order}
    }
    if ($seen.Count -lt 1 -or (Get-MediaJson @($owners.Keys | Sort-Object)) -cne (Get-MediaJson @($manifest.items.id | Sort-Object))) {throw 'Manifest item membership incomplete'}
    foreach ($item in @($manifest.items)) {Assert-MediaPath $item.path;if ($owners.ContainsKey([string]$item.parentId) -and $owners[[string]$item.parentId] -gt $owners[[string]$item.id]) {throw 'Manifest parent dependency order invalid'}}
    foreach ($package in @($Packages)) {
        $original=$seen[[string]$package.id]
        if ($null -eq $original -or $original.sha256 -cne $package.sha256 -or $original.bytes -ne $package.bytes -or $original.order -ne $package.order -or (Get-MediaJson @($original.itemIds)) -cne (Get-MediaJson @($package.itemIds))) {throw 'Package is not the verified original source export'}
    }
    foreach ($item in @($ExpectedItems)) {
        $original=@($manifest.items | Where-Object {$_.id -ceq $item.id})
        if ($original.Count -ne 1 -or (Get-MediaJson $original[0]) -cne (Get-MediaJson $item)) {throw 'Item differs from trusted source manifest'}
    }
}
function Assert-MediaPilot {
    if ($script:request.capabilities.pilotSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Server-owned pilot proof required' }
    $path=[IO.Path]::Combine($script:dataRoot,'alexion-media','pilots',$script:request.capabilities.pilotSha256+'.json')
    if ((Get-MediaFile $path).sha256 -cne $script:request.capabilities.pilotSha256) { throw 'Pilot proof hash mismatch' }
    $pilot=[IO.File]::ReadAllText($path) | ConvertFrom-Json
    if ((Get-MediaJson $pilot.target) -cne (Get-MediaJson $script:request.target) -or (Convert-MediaTimestamp $pilot.expiresAt) -le [DateTimeOffset]::UtcNow) { throw 'Pilot proof binding/expiry mismatch' }
    foreach ($flag in @('binaryRoundTripVerified','restoreVerified','exportScopeVerified')) { if ($pilot.$flag -ne $true) { throw ('Missing server pilot evidence: '+$flag) } }
    # Pilot must validate this SPE build's Export-Item original blobs, complete exact
    # item scope, add-only empty->desired diff, Update installation and restore.
    if ($pilot.adapterVersion -cne 'media-package-v1' -or $pilot.installMode -cne 'Update') { throw 'Unsupported pilot adapter/install mode' }
}
function Export-MediaGroup($Items,[string]$GroupId) {
    $work=[IO.Path]::Combine($script:workDirectory,$GroupId)
    [void][IO.Directory]::CreateDirectory($work)
    $empty=[IO.Path]::Combine($work,'empty');$desired=[IO.Path]::Combine($work,'desired')
    [void][IO.Directory]::CreateDirectory($empty);[void][IO.Directory]::CreateDirectory($desired)
    foreach ($spec in @($Items)) {
        $item=Get-MediaItem $spec.id
        if ($null -eq $item -or (Get-MediaJson (Read-MediaItem $item)) -cne (Get-MediaJson $spec)) { throw 'Source changed before export' }
        Export-Item -Item $item -Root $desired -ItemPathsAbsolute -WarningAction Stop | Out-Null
    }
    if (@([IO.Directory]::GetFiles($desired,'*',[IO.SearchOption]::AllDirectories)).Count -eq 0) { throw 'Empty serialization export' }
    $commands=Get-UpdatePackageDiff -SourcePath $empty -TargetPath $desired -WarningAction Stop
    $packagePath=[IO.Path]::Combine($work,$GroupId+'.update')
    Export-UpdatePackage -CommandList $commands -Path $packagePath -Name $GroupId -WarningAction Stop | Out-Null
    foreach ($spec in @($Items)) { if ((Get-MediaJson (Read-MediaItem (Get-MediaItem $spec.id))) -cne (Get-MediaJson $spec)) { throw 'Source changed during package export' } }
    $file=Get-MediaFile $packagePath
    if ($file.bytes -gt 100000000) {
        if (@($Items).Count -le 1) { throw 'A complete media item exceeds the 100 MB hard cap' }
        $half=[int][Math]::Floor(@($Items).Count/2)
        return @(@(Export-MediaGroup @($Items)[0..($half-1)] ($GroupId+'a')) + @(Export-MediaGroup @($Items)[$half..(@($Items).Count-1)] ($GroupId+'b')))
    }
    if ($file.bytes -lt 1) { throw 'Empty update package' }
    return @([ordered]@{id=$GroupId;path=($GroupId+'.update');serverPath=$packagePath;bytes=$file.bytes;sha256=$file.sha256;itemIds=@($Items | ForEach-Object {$_.id});order=0})
}
# Entry point guards occur before Sitecore access or filesystem writes.
if ([Text.Encoding]::UTF8.GetByteCount([string]$RequestJson) -gt 8388608) {throw 'Media request exceeds 8 MiB limit'}
if ([string]::IsNullOrWhiteSpace([string]$RequestJson) -or $RequestSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-MediaHash ([Text.Encoding]::UTF8.GetBytes($RequestJson))) -cne $RequestSha256) { throw 'Exact media request bytes/hash required' }
$script:request=$RequestJson | ConvertFrom-Json
if ($request.kind -cne 'media-request' -or $request.version -ne 1 -or $request.action -cnotin @('capture','package','inspect','install','verify')) { throw 'Unsupported media request' }
if ([string]::IsNullOrWhiteSpace([string]$request.scopeId) -or ([string]$request.scopeId).Length -gt 256 -or [string]$request.scopeId -match '\p{Cc}') {throw 'Unsafe or missing scope identity'}
if ([string]$request.requestId -notmatch '^[a-zA-Z0-9_-]{1,100}$') {throw 'Unsafe or missing request identity'}
if ([string]$request.taskId -notmatch '^[a-zA-Z0-9_.-]{1,100}$') {throw 'Unsafe or missing task identity'}
if ($request.target.deployment -cnotin @('XP','XM') -or $request.target.rootPath -cne '/sitecore/media library' -or $request.target.database -notmatch '^[a-zA-Z][a-zA-Z0-9_-]*$' -or $request.target.database -ine 'master' -or -not $request.target.instanceId -or -not $request.target.connectorId) { throw 'Explicit XP/XM media target required; SitecoreAI unsupported' }
foreach ($flag in @('speRead','fileTransfer','stableReadWindow')) { if ($request.capabilities.$flag -ne $true) { throw ('Missing capability: '+$flag) } }
$now=[DateTimeOffset]::UtcNow
if ((Convert-MediaTimestamp $request.capabilities.verifiedAt) -gt $now -or (Convert-MediaTimestamp $request.capabilities.expiresAt) -le $now) { throw 'Capability window expired or invalid' }
$script:database=[Sitecore.Configuration.Factory]::GetDatabase($request.target.database)
if ($null -eq $database) { throw 'Database absent' }
$marker=Get-MediaItem (Get-MediaGuid $request.target.marker.id)
if ($null -eq $marker -or [string]$marker.Paths.FullPath -cne $request.target.marker.path -or (Get-MediaGuid $marker.TemplateID) -cne (Get-MediaGuid $request.target.marker.templateId)) { throw 'Instance marker mismatch' }
$physicalRoot=[Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder)
if (-not [IO.Path]::IsPathRooted($physicalRoot)) { throw 'Physical DataFolder required' }
$script:dataRoot=[IO.Path]::GetFullPath($physicalRoot).TrimEnd('\','/')
$scopeHash=Get-MediaHash ([Text.Encoding]::UTF8.GetBytes(($request.scopeId+'|'+$request.target.instanceId+'|'+$request.target.database)))
$scopeDirectory=[IO.Path]::Combine($dataRoot,'alexion-media',$scopeHash)
Assert-MediaPhysicalPath $scopeDirectory
[void][IO.Directory]::CreateDirectory($scopeDirectory)
$script:workDirectory=[IO.Path]::Combine($scopeDirectory,$request.requestId)
Assert-MediaPhysicalPath $workDirectory
if ([IO.Directory]::Exists($workDirectory)) {throw 'Exclusive media request directory already exists'}
# Atomic claim is permanent, even on failure. No retry can replay a partial mutation.
$claim=[IO.FileStream]::new(($workDirectory+'.claim'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $claim.Write(([Text.Encoding]::UTF8.GetBytes($RequestSha256)),0,64);$claim.Flush($true) } finally {$claim.Dispose()}
[void][IO.Directory]::CreateDirectory($workDirectory)
$exportFiles=@();$result=$null
if ($request.action -eq 'capture') {
    if (@($request.selectors).Count -lt 1 -or @($request.selectors).Count -gt 100) { throw 'Explicit 1..100 media selectors required' }
    $selected=@{}
    $maxItems=5000;if ($request.maxItems) {$maxItems=[int]$request.maxItems};if ($maxItems -lt 1 -or $maxItems -gt 5000) {throw 'maxItems outside 1..5000'}
    foreach ($selector in @($request.selectors)) {
        if ($selector.path -cne '/sitecore/media library') {Assert-MediaPath $selector.path} elseif ($selector.includeDescendants -ne $true) {throw 'Selecting media root requires descendants'}
        if ($selector.includeDescendants -isnot [bool]) {throw 'Explicit descendant selection required'}
        $root=Get-MediaItem $selector.path;if ($null -eq $root) {throw 'Selected media absent'}
        $queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue($root)
        while ($queue.Count) {
            $item=$queue.Dequeue();if ([string]$item.Paths.FullPath -cne '/sitecore/media library') {$selected[(Get-MediaGuid $item.ID)]=$item}
            if ($selected.Count -gt $maxItems) {throw 'Media item bound exceeded'}
            if ($selector.includeDescendants) {foreach ($child in $item.Children) {$queue.Enqueue($child)}}
        }
        $parent=if ($selector.path -cne '/sitecore/media library') {$root.Parent} else {$null}
        while ($null -ne $parent -and [string]$parent.Paths.FullPath -cne '/sitecore/media library') {Assert-MediaPath $parent.Paths.FullPath;$selected[(Get-MediaGuid $parent.ID)]=$parent;$parent=$parent.Parent}
    }
    if ($selected.Count -lt 1 -or $selected.Count -gt $maxItems) {throw 'Media selection empty or ancestor item bound exceeded'}
    $items=@($selected.Values | Sort-Object { $_.Paths.FullPath } | ForEach-Object {Read-MediaItem $_})
    foreach ($item in $items) {if ((Get-MediaJson (Read-MediaItem (Get-MediaItem $item.id))) -cne (Get-MediaJson $item)) {throw 'Source changed during inventory'}}
    if ((Convert-MediaTimestamp $request.capabilities.expiresAt) -le [DateTimeOffset]::UtcNow) {throw 'Source read capability expired'}
    $result=[ordered]@{kind='media-inventory';version=1;scopeId=$request.scopeId;target=$request.target;requestId=$request.requestId;requestSha256=$RequestSha256;capturedAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=$request.capabilities.expiresAt;complete=$true;unresolvedOperations=@(Get-MediaUnresolvedOperations);selectors=@($request.selectors);items=$items;missingIds=@();collisions=@()}
} elseif ($request.action -eq 'package') {
    Assert-MediaPilot
    foreach ($flag in @('updatePackages','binaryRoundTripVerified')) {if ($request.capabilities.$flag -ne $true) {throw ('Missing export capability: '+$flag)}}
    if ($request.maxPackageBytes -and [long]$request.maxPackageBytes -ne 100000000) {throw 'Package hard cap is exactly 100000000 bytes'}
    if ((Get-MediaHash ([Text.Encoding]::UTF8.GetBytes([string]$request.inventoryJson))) -cne $request.sourceInventorySha256) {throw 'Source inventory exact bytes/hash required'}
    $inventory=$request.inventoryJson | ConvertFrom-Json
    if ($inventory.complete -ne $true -or $inventory.scopeId -cne $request.scopeId -or (Get-MediaJson $inventory.target) -cne (Get-MediaJson $request.target) -or (Convert-MediaTimestamp $inventory.expiresAt) -le [DateTimeOffset]::UtcNow -or (Get-MediaJson @($inventory.items)) -cne (Get-MediaJson @($request.items)) -or (Get-MediaJson @($inventory.selectors)) -cne (Get-MediaJson @($request.selectors)) -or @($request.items).Count -lt 1) {throw 'Fresh bound source inventory required'}
    if ((Convert-MediaTimestamp $request.capabilities.expiresAt) -le [DateTimeOffset]::UtcNow) {throw 'Source capability expired before packaging'}
    $packages=@(Export-MediaGroup @($request.items | Sort-Object path,id) 'media-0001')
    foreach ($spec in @($request.items)) {if ((Get-MediaJson (Read-MediaItem (Get-MediaItem $spec.id))) -cne (Get-MediaJson $spec)) {throw 'Source changed during complete package run'}}
    if ((Convert-MediaTimestamp $request.capabilities.expiresAt) -le [DateTimeOffset]::UtcNow) {throw 'Source capability expired during packaging'}
    for ($index=0;$index -lt $packages.Count;$index++) {$packages[$index].order=$index+1}
    foreach ($package in $packages) {$exportFiles+=@{rootPath='Data';path=$package.serverPath.Substring($dataRoot.Length+1).Replace('\','/');name=$package.path;size=$package.bytes}}
    $result=[ordered]@{kind='media-package-manifest';version=1;scopeId=$request.scopeId;requestId=$request.requestId;requestSha256=$RequestSha256;completedAt=[DateTimeOffset]::UtcNow.ToString('o');source=$request.target;sourceInventorySha256=$request.sourceInventorySha256;maxPackageBytes=100000000;items=@($request.items);packages=$packages}
} elseif ($request.action -in @('inspect','verify')) {
    Assert-MediaManifest $request.packages $request.items
    foreach ($package in @($request.packages)) {$null=Assert-MediaPackage $package}
    $observation=Read-MediaInventory $request.items
    if ((Get-MediaObservationKey (Read-MediaInventory $request.items)) -cne (Get-MediaObservationKey $observation)) {throw 'Target changed during inventory read'}
    if ((Convert-MediaTimestamp $request.capabilities.expiresAt) -le [DateTimeOffset]::UtcNow) {throw 'Target read capability expired'}
    $result=[ordered]@{kind='media-inventory';version=1;scopeId=$request.scopeId;target=$request.target;requestId=$request.requestId;requestSha256=$RequestSha256;sourceInventorySha256=$request.sourceInventorySha256;capturedAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=$request.capabilities.expiresAt;complete=$true;unresolvedOperations=@(Get-MediaUnresolvedOperations);items=$observation.items;missingIds=$observation.missingIds;collisions=$observation.collisions}
} else {
    Assert-MediaPilot
    foreach ($flag in @('updatePackages','binaryRoundTripVerified','restoreVerified','exclusiveWriteWindow')) {if ($request.capabilities.$flag -ne $true) {throw ('Missing write capability: '+$flag)}}
    if ((Get-MediaHash ([Text.Encoding]::UTF8.GetBytes([string]$request.reviewJson))) -cne $request.reviewSha256) {throw 'Exact approved review bytes required'}
    $review=$request.reviewJson | ConvertFrom-Json;$approval=$request.approval
    if ($review.scopeId -cne $request.scopeId -or $review.taskId -cne $request.taskId -or (Get-MediaJson $review.target) -cne (Get-MediaJson $request.target) -or $review.operationId -notmatch '^[a-zA-Z0-9_-]{1,100}$' -or $review.planSha256 -notmatch '^[a-f0-9]{64}$' -or $review.sourceInventorySha256 -notmatch '^[a-f0-9]{64}$') {throw 'Review binding invalid'}
    if ($approval.kind -cne 'mutation' -or $approval.choice -cne 'approve' -or $approval.scopeId -cne $request.scopeId -or $approval.taskId -cne $request.taskId -or [string]::IsNullOrWhiteSpace($approval.userResponse) -or (Convert-MediaTimestamp $approval.at) -gt [DateTimeOffset]::UtcNow -or @($approval.inputs | Where-Object {$_.sha256 -ceq $request.reviewSha256}).Count -ne 1) {throw 'Real response bound to exact media review required'}
    if ($review.manifestSha256 -cne $request.manifestSha256 -or $review.sourceInventorySha256 -cne $request.sourceInventorySha256) {throw 'Approved manifest binding invalid'}
    Assert-MediaManifest @($review.package) $review.items
    $lock=$null;$heldPackage=$null;$started=$false
    try {
        if (@(Get-MediaUnresolvedOperations).Count -ne 0) {throw 'Unresolved media operation requires operator reconciliation'}
        $targetKey=Get-MediaTargetKey
        $lockPath=[IO.Path]::Combine($dataRoot,'alexion-media',($targetKey+'.lock'))
        $lock=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $operationsDirectory=[IO.Path]::Combine($dataRoot,'alexion-media','operations',$targetKey);[void][IO.Directory]::CreateDirectory($operationsDirectory)
        $operationPath=[IO.Path]::Combine($operationsDirectory,($review.operationId+'.operation.json'))
        Write-MediaDurable $operationPath @{status='prepared';requestSha256=$RequestSha256;reviewSha256=$request.reviewSha256;operationId=$review.operationId}
        $packagePath=Assert-MediaPackage $review.package
        # Read sharing lets the installer read, while excluding modification/deletion.
        $heldPackage=[IO.FileStream]::new($packagePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $null=Assert-MediaPackage $review.package
        if (@($review.items).Count -lt 1 -or (Get-MediaJson @($review.package.itemIds | Sort-Object)) -cne (Get-MediaJson @($review.items.id | Sort-Object))) {throw 'Exact one-package item scope required'}
        $before=Read-MediaInventory $review.items
        $expected=@{items=@($review.currentItems);missingIds=@($review.missingIds);collisions=@($review.collisions)}
        if ((Get-MediaObservationKey $before) -cne (Get-MediaObservationKey $expected) -or @($before.collisions).Count -ne 0) {throw 'Target drift or path conflict'}
        # Backups serialize every existing exact item. Pilot proves external original
        # blobs are included and restore was exercised; no assumed blob support.
        $backup=[IO.Path]::Combine($workDirectory,'backup');[void][IO.Directory]::CreateDirectory($backup)
        foreach ($item in $before.items) {Export-Item -Item (Get-MediaItem $item.id) -Root $backup -ItemPathsAbsolute -WarningAction Stop | Out-Null}
        $backups=@();foreach ($file in [IO.Directory]::GetFiles($backup,'*',[IO.SearchOption]::AllDirectories)) {$record=Get-MediaFile $file;$backups+=@{serverPath=$file;bytes=$record.bytes;sha256=$record.sha256};$exportFiles+=@{rootPath='Data';path=$file.Substring($dataRoot.Length+1).Replace('\','/');name=[IO.Path]::GetFileName($file);size=$record.bytes}}
        if (@($before.items).Count -gt 0 -and $backups.Count -lt 1) {throw 'Existing media backup absent'}
        Write-MediaDurable ([IO.Path]::Combine($workDirectory,'backups.json')) $backups
        $warnings=@();$rollback=[IO.Path]::Combine($workDirectory,'rollback.update')
        $preview=@(Install-UpdatePackage -Path $packagePath -UpgradeAction Preview -InstallMode Update -RollbackPackagePath $rollback -WarningVariable warnings)
        Write-MediaDurable ([IO.Path]::Combine($workDirectory,'preview.json')) @{contingencies=@($preview | ForEach-Object {[string]$_});warnings=@($warnings | ForEach-Object {[string]$_})}
        if ($warnings.Count -ne 0 -or $preview.Count -ne 0) {throw 'Preview warnings/contingencies require explicit separate review; installation blocked'}
        if ((Get-MediaObservationKey (Read-MediaInventory $review.items)) -cne (Get-MediaObservationKey $before)) {throw 'Target changed during backup/preview'}
        if ((Convert-MediaTimestamp $request.capabilities.expiresAt) -le [DateTimeOffset]::UtcNow) {throw 'Write capability expired'}
        Write-MediaDurable ([IO.Path]::Combine($workDirectory,'installing.json')) @{status='installing';operationId=$review.operationId;packageSha256=$review.package.sha256;reviewSha256=$request.reviewSha256;backups=$backups}
        Write-MediaDurable ([IO.Path]::Combine($operationsDirectory,($review.operationId+'.installing.json'))) @{status='installing';operationId=$review.operationId;requestSha256=$RequestSha256;reviewSha256=$request.reviewSha256}
        $started=$true;$warnings=@()
        $contingencies=@(Install-UpdatePackage -Path $packagePath -UpgradeAction Upgrade -InstallMode Update -RollbackPackagePath $rollback -WarningVariable warnings)
        $post=Read-MediaInventory $review.items
        $desired=@{items=@($review.items);missingIds=@();collisions=@()}
        if ($warnings.Count -ne 0 -or $contingencies.Count -ne 0 -or (Get-MediaObservationKey $post) -cne (Get-MediaObservationKey $desired)) {throw 'Install emitted contingencies or exact media readback differs'}
        $result=@{kind='media-install-receipt';version=1;target=$request.target;manifestSha256=$request.manifestSha256;sourceInventorySha256=$request.sourceInventorySha256;packageId=$review.package.id;packageSha256=$review.package.sha256;completedAt=[DateTimeOffset]::UtcNow.ToString('o');scopeId=$request.scopeId;requestId=$request.requestId;requestSha256=$RequestSha256;reviewSha256=$request.reviewSha256;operationId=$review.operationId;status='successful';backups=$backups;post=$post;independentVerificationRequired=$true}
    } catch {
        $result=@{kind='media-install-receipt';version=1;target=$request.target;manifestSha256=$request.manifestSha256;sourceInventorySha256=$request.sourceInventorySha256;packageId=$review.package.id;packageSha256=$review.package.sha256;completedAt=[DateTimeOffset]::UtcNow.ToString('o');scopeId=$request.scopeId;requestId=$request.requestId;requestSha256=$RequestSha256;reviewSha256=$request.reviewSha256;operationId=$review.operationId;status=$(if ($started) {'unknown'} else {'failed'});message=[string]$_.Exception.Message;independentVerificationRequired=$true}
    } finally {
        if ($null -ne $operationsDirectory -and $started) {Write-MediaDurable ([IO.Path]::Combine($operationsDirectory,($review.operationId+'.result.json'))) $result}
        if ($null -ne $heldPackage) {$heldPackage.Dispose()}
        # Keep the permanent scope lock after unknown outcomes. Operator recovery is required.
        if ($null -ne $lock) {$lock.Dispose();if (-not $started -or $result.status -eq 'successful') {[IO.File]::Delete($lockPath)}}
    }
}
$resultPath=[IO.Path]::Combine($workDirectory,'result.json');Write-MediaDurable $resultPath $result
$exportFiles+=@{rootPath='Data';path=$resultPath.Substring($dataRoot.Length+1).Replace('\','/');name='result.json';size=([IO.FileInfo]$resultPath).Length}
foreach ($name in @('preview.json','backups.json','installing.json','rollback.update')) {$file=[IO.Path]::Combine($workDirectory,$name);if ([IO.File]::Exists($file)) {$exportFiles+=@{rootPath='Data';path=$file.Substring($dataRoot.Length+1).Replace('\','/');name=$name;size=([IO.FileInfo]$file).Length}}} 
[ordered]@{kind='kajoo-export';version=1;files=$exportFiles;summary=@{requestId=$request.requestId;action=$request.action;status=$result.status}} | ConvertTo-Json -Depth 12 -Compress
