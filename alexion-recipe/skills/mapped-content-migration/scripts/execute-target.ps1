# Remote SPE entrypoint. Request and this reviewed script/helper bundle are injected by the target connector.
$ErrorActionPreference='Stop'
if (-not (Get-Command Get-TargetObservationKey -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'lib/target-common.ps1')
}
$core=$Request.core
# Hash the exact reviewed UTF-8 bytes; JSON serialization differs between JS and PowerShell.
if ([string]::IsNullOrWhiteSpace([string]$Request.reviewJson) -or (Get-TargetHash ([Text.Encoding]::UTF8.GetBytes([string]$Request.reviewJson))) -cne $Request.reviewSha256) { throw 'Exact reviewed request bytes do not match approval hash' }
$core=$Request.reviewJson | ConvertFrom-Json
if ($Request.version -ne 1 -or $core.version -ne 1 -or $Request.requestId -notmatch '^exec-[a-f0-9]{24}$' -or $Request.reviewSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Versioned target execution request required' }
if ($core.contentMigrationMode -cne 'mapped-content') { throw 'Mapped content execution mode required' }
if ($core.target.database -notmatch '^[a-zA-Z][a-zA-Z0-9_-]*$' -or -not $core.scopeId -or -not $core.taskId -or -not $core.target.instanceId -or -not $core.target.connectorId) { throw 'Explicit target identity required' }
Assert-TargetPath $core.target.rootPath
if ([int]$Request.reservation.sequence -lt 1 -or $Request.reservation.checkpointSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Durable reservation required' }
if (@($core.operations).Count -lt 1 -or @($core.operations).Count -gt 100 -or [long]$core.maxBackupBytes -lt 1024 -or [long]$core.maxBackupBytes -gt 1073741824 -or [long]$core.maxJournalBytes -lt 4096 -or [long]$core.maxJournalBytes -gt 8388608) { throw 'Execution size bounds invalid' }
$physicalDataRoot=[Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder)
if (-not [IO.Path]::IsPathRooted($physicalDataRoot)) { throw 'Physical Sitecore DataFolder required' }
$dataRoot=[IO.Path]::GetFullPath($physicalDataRoot).TrimEnd('\','/')
$scopeHash=Get-TargetHash ([Text.Encoding]::UTF8.GetBytes(($core.target.database.ToLowerInvariant() + '|' + $core.target.rootPath.ToLowerInvariant())))
$scopeDirectory=[IO.Path]::Combine($dataRoot,'kajoo','mapped-content','executions',$scopeHash)
[void][IO.Directory]::CreateDirectory($scopeDirectory)
$requestDirectory=[IO.Path]::Combine($scopeDirectory,$Request.requestId)
$receiptPath=[IO.Path]::Combine($requestDirectory,'receipt.json')
$journalPath=[IO.Path]::Combine($requestDirectory,'journal.jsonl')
function Write-TargetExport {
    $files=@()
    foreach ($file in @($receiptPath,$journalPath)) { if ([IO.File]::Exists($file)) { $record=Get-TargetFileRecord $file; $files+=@{rootPath='Data';path=$record.path;name=[IO.Path]::GetFileName($file);size=$record.bytes} } }
    if ([IO.File]::Exists($receiptPath)) {
        $storedReceipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        foreach ($backup in @($storedReceipt.backups)) {
            foreach ($saved in @($backup.files)) {
                $backupPath=[IO.Path]::GetFullPath([IO.Path]::Combine($dataRoot,$saved.path))
                $backupPrefix=[IO.Path]::Combine($requestDirectory,'backups') + [IO.Path]::DirectorySeparatorChar
                if (-not $backupPath.StartsWith($backupPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup export is outside this fixed request directory' }
                $actual=Get-TargetFileRecord $backupPath
                if ($actual.sha256 -cne $saved.sha256 -or $actual.bytes -ne $saved.bytes) { throw 'Recovery backup export differs from durable receipt' }
                $files+=@{rootPath='Data';path=$actual.path;name=($backup.operationId + '-' + [IO.Path]::GetFileName($backupPath));size=$actual.bytes}
            }
        }
    }
    [ordered]@{kind='kajoo-export';version=1;files=$files;summary=@{requestId=$Request.requestId;reviewSha256=$Request.reviewSha256;terminal=[IO.File]::Exists($receiptPath);duplicate=$script:duplicate}} | ConvertTo-Json -Depth 12 -Compress
}
$script:duplicate=$false
# Claims are never silently replaced, including after a process crash.
$claimPath=[IO.Path]::Combine($scopeDirectory,$Request.requestId + '.claim.json')
if ([IO.File]::Exists($claimPath)) {
    $claim=Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
    if ($claim.reviewSha256 -cne $Request.reviewSha256) { throw 'Request ID already belongs to a different review' }
    $script:duplicate=$true; Write-TargetExport; return
}
$lock=$null; $journal=$null; $receipt=$null; $journalBytes=0; $anyMutation=$false
try {
    try { $lock=[IO.FileStream]::new([IO.Path]::Combine($scopeDirectory,'scope.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough) }
    catch { throw 'Target execution scope is locked; no automatic stale-lock clearing' }
    Write-TargetDurable $claimPath @{version=1;requestId=$Request.requestId;reviewSha256=$Request.reviewSha256;reservation=$Request.reservation}
    [void][IO.Directory]::CreateDirectory($requestDirectory)
    $journal=[IO.FileStream]::new($journalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    $receipt=[ordered]@{version=1;kind='mapped-content-execution';requestId=$Request.requestId;reviewSha256=$Request.reviewSha256;scopeId=$core.scopeId;taskId=$core.taskId;batchPlanSha256=$core.batchPlanSha256;batchId=$core.batchId;target=$core.target;terminal=$true;status='blocked';backups=@();results=@();reused=@();journal=$null}
    function Write-TargetJournal($Value) {
        $bytes=[Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 60 -Compress) + "`n")
        if ($script:journalBytes + $bytes.Length -gt [long]$core.maxJournalBytes) { throw 'Target journal byte bound exceeded' }
        $journal.Write($bytes,0,$bytes.Length); $journal.Flush($true); $script:journalBytes+=$bytes.Length
    }
    try {
        if ($core.PSObject.Properties.Name -contains 'operationKind' -and $core.operationKind -cnotin @('content','references')) { throw 'Unsupported execution operation kind' }
        $approval=$Request.approval
        $approvedAt=Convert-TargetTimestamp $approval.at
        if ($approval.kind -cne 'mutation' -or $approval.choice -cne 'approve' -or $approval.scopeId -cne $core.scopeId -or $approval.taskId -cne $core.taskId -or [string]::IsNullOrWhiteSpace($approval.userResponse) -or $approvedAt -gt [DateTimeOffset]::UtcNow -or -not @($approval.inputs | Where-Object { $_.sha256 -ceq $Request.reviewSha256 }).Count) { throw 'Bound CMS mutation approval required' }
        foreach ($flag in @('speRead','speWrite','fullItemBackup','restoreValidated','exclusiveWriteWindow','fileDownload','journalContinuityVerified')) { if ($core.capabilities.$flag -ne $true) { throw ('Required target capability absent: ' + $flag) } }
        if ($core.target.marker.path -cne $core.target.rootPath) { throw 'Target marker must identify the exact approved root' }
        $requestBytes=[Text.Encoding]::UTF8.GetByteCount(($Request | ConvertTo-Json -Depth 80 -Compress))
        if ([long]$core.maxRequestBytes -lt 1024 -or [long]$core.maxRequestBytes -gt 8388608 -or $requestBytes -gt [long]$core.maxRequestBytes) { throw 'Execution request byte bound exceeded' }
        # Reserve enough journal space for prepared, intent, result and terminal failure records before writes.
        $journalEstimate=4096 + 4 * [Text.Encoding]::UTF8.GetByteCount(($core | ConvertTo-Json -Depth 80 -Compress))
        if ($journalEstimate -gt [long]$core.maxJournalBytes) { throw 'Journal bound cannot contain this approved batch' }
        $expiry=Convert-TargetTimestamp $core.capabilities.expiresAt
        if ($expiry -le [DateTimeOffset]::UtcNow) { throw 'Target capability window expired' }
        foreach ($entry in @(@{name='Get-Item';parameters=@('Path','Language','Version')},@{name='New-Item';parameters=@('Path','Name','ID','ItemType','Language')},@{name='Add-ItemVersion';parameters=@('Item','TargetLanguage','IfExist','IfNoSourceVersion','DoNotCopyFields')},@{name='Export-Item';parameters=@('Item','Root')},@{name='Import-Item';parameters=@('Root')})) {
            $command=Get-Command $entry.name -ErrorAction Stop
            foreach ($parameter in $entry.parameters) { if (-not $command.Parameters.ContainsKey($parameter)) { throw ('Unsupported SPE command parameter: ' + $entry.name + '/' + $parameter) } }
        }
        $marker=Get-TargetItem (Get-TargetGuid $core.target.marker.id)
        if ($null -eq $marker -or [string]$marker.Paths.FullPath -cne $core.target.marker.path -or (Get-TargetGuid $marker.TemplateID) -ne (Get-TargetGuid $core.target.marker.templateId)) { throw 'Target marker mismatch' }
        Assert-TargetTemplates
        foreach ($guard in @($core.guards)) { Assert-TargetGuard $guard }
        if ($core.operationKind -ceq 'references') { Assert-TargetReferenceBindings; Assert-TargetReferenceGuards }
        $seenIds=@{}; $seenOperations=@{}
        foreach ($operation in @($core.operations)) {
            Assert-TargetOperation $operation
            $id=Get-TargetGuid $operation.targetItemId
            if ($seenIds.ContainsKey($id) -or $seenOperations.ContainsKey($operation.operationId)) { throw 'Duplicate target operation identity' }
            $seenIds[$id]=$true; $seenOperations[$operation.operationId]=$true
            $ownGuards=@($core.guards | Where-Object { ($_.lookup -eq 'id' -and (Get-TargetGuid $_.value) -eq $id) -or ($_.lookup -eq 'path' -and $_.value -ieq $operation.targetPath) })
            if (@($ownGuards | Where-Object lookup -eq 'id').Count -ne 1 -or @($ownGuards | Where-Object lookup -eq 'path').Count -ne 1) { throw 'Every operation requires ID and path guards' }
            if ($core.operationKind -ceq 'references' -and @($ownGuards | Where-Object { $_.exists -ne $true }).Count) { throw 'Reference write target must already exist' }
            $existing=@(); if ($operation.action -eq 'update') { $existing=@(($ownGuards | Where-Object lookup -eq 'id').item.versions) }
            $null=Assert-TargetVersions $operation $existing
        }
        foreach ($known in @($core.knownSuccess)) { $post=Assert-TargetObservation (Get-TargetItem $known.targetItemId) $known.post; $receipt.reused+=@{operationId=$known.operationId;targetItemId=$post.id;targetPath=$post.path;templateId=$post.templateId;post=$post} }
        # Take all existing-item backups before the first content mutation. SPE serialization includes stored fields, languages and versions.
        $backupBytes=0
        foreach ($operation in @($core.operations | Where-Object action -eq 'update')) {
            $backupRoot=[IO.Path]::Combine($requestDirectory,'backups',$operation.operationId)
            [void][IO.Directory]::CreateDirectory($backupRoot)
            $item=Get-TargetItem $operation.targetItemId
            Export-Item -Item $item -Root $backupRoot | Out-Null
            $files=@([IO.Directory]::GetFiles($backupRoot,'*',[IO.SearchOption]::AllDirectories))
            if ($files.Count -lt 1 -or $files.Count -gt 1000) { throw 'Target serialization backup file count invalid' }
            $records=@()
            foreach ($file in $files) {
                if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Backup links forbidden' }
                if (([IO.FileInfo]$file).Length -gt ([long]$core.maxBackupBytes - $backupBytes)) { throw 'Target backup byte bound exceeded' }
                $record=Get-TargetFileRecord $file
                if ($record.bytes -lt 1) { throw 'Empty target serialization backup' }
                $backupBytes+=$record.bytes
                if ($backupBytes -gt [long]$core.maxBackupBytes) { throw 'Target backup byte bound exceeded' }
                $records+=$record
            }
            $receipt.backups+=@{operationId=$operation.operationId;targetItemId=$operation.targetItemId;files=$records}
        }
        Write-TargetJournal @{kind='prepared';requestId=$Request.requestId;reviewSha256=$Request.reviewSha256;backups=$receipt.backups}
        $completed=@{}; $stopped=$false
        foreach ($operation in @($core.operations)) {
            $result=[ordered]@{operationId=$operation.operationId;targetItemId=$operation.targetItemId;targetPath=$operation.targetPath;templateId=$operation.templateId;status='skipped';mutated=$false}
            if (-not $stopped) {
                try {
                    if ([DateTimeOffset]::UtcNow -ge $expiry) { throw 'Target capability window expired' }
                    Assert-TargetTemplates
                    if ($core.operationKind -ceq 'references') { Assert-TargetReferenceGuards }
                    foreach ($dependency in @($operation.dependsOn)) { if (-not $completed.ContainsKey($dependency) -and -not @($receipt.reused | Where-Object operationId -eq $dependency).Count) { throw 'Operation dependency has not succeeded' } }
                    # Check own guards and current parent. Earlier approved writes are compared against their verified afterstate.
                    foreach ($guard in @($core.guards)) {
                        $own=($guard.lookup -eq 'id' -and $guard.value -ieq $operation.targetItemId) -or ($guard.lookup -eq 'path' -and $guard.value -ieq $operation.targetPath)
                        if ($own) { Assert-TargetGuard $guard }
                    }
                    $parentPath=$operation.targetPath.Substring(0,$operation.targetPath.LastIndexOf('/'))
                    $parent=Get-TargetItem $parentPath
                    if ($null -eq $parent -or (Get-TargetGuid $parent.ID) -ne (Get-TargetGuid $operation.parentItemId)) { throw 'Target parent identity drift' }
                    $writtenParent=@($receipt.results | Where-Object { $_.targetItemId -ieq $operation.parentItemId -and $_.status -eq 'success' })
                    if ($writtenParent.Count) { $null=Assert-TargetObservation $parent $writtenParent[0].post }
                    else {
                        $parentGuards=@($core.guards | Where-Object { $_.lookup -eq 'path' -and $_.value -ieq $parentPath })
                        if ($parentGuards.Count -ne 1) { throw 'Target parent guard absent' }
                        Assert-TargetGuard $parentGuards[0]
                    }
                    $item=Get-TargetItem $operation.targetItemId
                    $beforeVersions=@(); if ($item) { $beforeVersions=@((Get-TargetObservation $item $operation.expectedPost).versions) }
                    $newVersions=@(Assert-TargetVersions $operation $beforeVersions)
                    Write-TargetJournal @{kind='intent';operationId=$operation.operationId;targetItemId=$operation.targetItemId;action=$operation.action}
                    if ($operation.action -eq 'create') {
                        if ($item) { throw 'Create target already exists' }
                        $initial=$newVersions[0]
                        $result.mutated=$true; $anyMutation=$true
                        $item=New-Item -Path ($core.target.database + ':' + $parentPath) -Name ($operation.targetPath.Split('/')[-1]) -ID $operation.targetItemId -ItemType $operation.templateId -Language $initial.language -ErrorAction Stop
                        if ($null -eq $item -or (Get-TargetGuid $item.ID) -ne (Get-TargetGuid $operation.targetItemId) -or [int][string]$item.Version -ne 1 -or [string]$item.Language -cne $initial.language) { throw 'Created target identity/version differs' }
                        $newVersions=@($newVersions | Select-Object -Skip 1)
                    } elseif ($null -eq $item) { throw 'Update target absent' }
                    foreach ($version in $newVersions) {
                        $result.mutated=$true; $anyMutation=$true
                        $added=@(Add-ItemVersion -Item $item -TargetLanguage $version.language -IfExist Append -IfNoSourceVersion Add -DoNotCopyFields -ErrorAction Stop)
                        if ($added.Count -ne 1 -or [string]$added[0].Language -cne $version.language -or [int][string]$added[0].Version -ne [int]$version.version -or (Get-TargetGuid $added[0].ID) -ne (Get-TargetGuid $operation.targetItemId)) { throw 'Created version differs from approved sequence' }
                    }
                    foreach ($field in @($operation.fields)) {
                        $edit=$item
                        if ($field.storage -eq 'versioned') { $edit=Get-TargetItem $operation.targetItemId $field.language $field.version }
                        elseif ($field.storage -eq 'unversioned') { $edit=Get-TargetItem $operation.targetItemId $field.language }
                        if ($null -eq $edit) { throw 'Exact field write version absent' }
                        $slot=$edit.Fields[[Sitecore.Data.ID]::Parse((Get-TargetGuid $field.fieldId))]
                        if ($null -eq $slot) { throw 'Target field absent' }
                        $approvedTemplate=@($core.templates | Where-Object { $_.id -ieq $operation.templateId })[0]
                        $approvedField=@($approvedTemplate.fields | Where-Object { $_.id -ieq $field.fieldId })[0]
                        $slotStorage=if ($slot.Shared) { 'shared' } elseif ($slot.Unversioned) { 'unversioned' } else { 'versioned' }
                        if ($slotStorage -ne $field.storage -or [string]$slot.Type -ine $approvedField.type -or [string]$slot.Name -cne $approvedField.name) { throw 'Actual target write slot metadata drift' }
                        $edit.Editing.BeginEdit()
                        try { $result.mutated=$true; $anyMutation=$true; $slot.Value=[string]$field.value; $edit.Editing.EndEdit() | Out-Null } catch { $edit.Editing.CancelEdit(); throw }
                    }
                    $post=Assert-TargetObservation (Get-TargetItem $operation.targetItemId) $operation.expectedPost
                    $result.status='success'; $result.post=$post; $completed[$operation.operationId]=$true
                } catch {
                    $result.status='failed'; $result.message=$_.Exception.Message; $stopped=$true
                    try { $remaining=Get-TargetItem $operation.targetItemId; if ($remaining) { $result.post=Get-TargetObservation $remaining $operation.expectedPost } } catch { }
                }
            }
            $receipt.results+=$result
            Write-TargetJournal @{kind='operation';result=$result}
        }
        $receipt.status=if (@($receipt.results | Where-Object status -ne 'success').Count -eq 0) { 'success' } elseif ($anyMutation) { 'partial' } else { 'failed' }
    } catch {
        $receipt.status=if ($anyMutation) { 'partial' } else { 'blocked' }; $receipt.message=$_.Exception.Message
        foreach ($operation in @($core.operations)) { if (-not @($receipt.results | Where-Object operationId -eq $operation.operationId).Count) { $receipt.results+=@{operationId=$operation.operationId;targetItemId=$operation.targetItemId;targetPath=$operation.targetPath;templateId=$operation.templateId;status='skipped';mutated=$false} } }
        Write-TargetJournal @{kind='failure';status=$receipt.status;message=$receipt.message;results=$receipt.results}
    }
    $journal.Flush($true); $journal.Dispose(); $journal=$null
    $receipt.journal=Get-TargetFileRecord $journalPath
    Write-TargetDurable $receiptPath $receipt
} finally {
    if ($journal) { $journal.Dispose() }
    if ($lock) {
        $lock.Dispose()
        # A crash or undurable receipt deliberately leaves the lock for manual investigation.
        if ([IO.File]::Exists($receiptPath)) { [IO.File]::Delete([IO.Path]::Combine($scopeDirectory,'scope.lock')) }
    }
}
Write-TargetExport

