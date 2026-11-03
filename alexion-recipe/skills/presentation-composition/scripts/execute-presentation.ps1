# Approved presentation writes only. The connector supplies RequestJson and RequestSha256.
$ErrorActionPreference='Stop'
function ConvertTo-PresCanonical($Value) {
    if($null-eq$Value){return 'null'}
    if($Value-is[string]-or$Value-is[ValueType]){return ($Value|ConvertTo-Json -Compress)}
    if($Value-is[Collections.IDictionary]){$names=@($Value.Keys|Sort-Object);$pairs=@(foreach($name in $names){($name|ConvertTo-Json -Compress)+':'+(ConvertTo-PresCanonical $Value[$name])});return '{'+($pairs-join',')+'}'}
    if($Value-is[Collections.IEnumerable]){$parts=@(foreach($entry in $Value){ConvertTo-PresCanonical $entry});return '['+($parts-join',')+']'}
    $pairs=@(foreach($name in @($Value.PSObject.Properties.Name|Sort-Object)){($name|ConvertTo-Json -Compress)+':'+(ConvertTo-PresCanonical $Value.$name)});return '{'+($pairs-join',')+'}'
}
function Assert-PresEqual($Actual,$Expected,[string]$Message) {if((ConvertTo-PresCanonical $Actual)-cne(ConvertTo-PresCanonical $Expected)){throw $Message}}
function Get-PresNormalizedRows($Rows) {return @(foreach($row in $Rows){@{uid=(Get-PresGuid $row.uid);renderingId=(Get-PresGuid $row.renderingId);placeholder=$row.placeholder;parameters=$row.parameters;datasourceId=$(if($row.datasourceId){Get-PresGuid $row.datasourceId}else{$null})}})}
function Get-PresMapping($Value) {
    if(-not$Value){return @()};$text=[string]$Value
    for($i=0;-not$text.Contains('=')-and$i-lt2;$i++){$text=[Web.HttpUtility]::UrlDecode($text)}
    $rows=@();$seen=@{};foreach($pair in $text.Split('&')){$split=$pair.IndexOf('=');if($split-lt1){throw 'Invalid TemplatesMapping'};$key=(Get-PresGuid ([Web.HttpUtility]::UrlDecode($pair.Substring(0,$split)))).Trim('{}').ToLowerInvariant();$value=(Get-PresGuid ([Web.HttpUtility]::UrlDecode($pair.Substring($split+1)))).Trim('{}').ToLowerInvariant();if($seen.ContainsKey($key)){throw 'Duplicate template mapping'};$seen[$key]=$true;$rows+=@{templateId=$key;designId=$value}};return @($rows|Sort-Object templateId)
}
function Assert-PresPost($Operation,$Post) {
    foreach($context in $Operation.contexts){$actual=@($Post|Where-Object key -CEQ $context.query.key);if($actual.Count-ne1-or-not$actual[0].item){throw 'Incomplete presentation read-back'};$item=$actual[0].item
        if((Get-PresGuid $item.id)-ne(Get-PresGuid $Operation.itemId)-or(Get-PresGuid $item.templateId)-ne(Get-PresGuid $Operation.templateId)-or$item.path-cne$Operation.path-or-not$item.versionPresent){throw 'Presentation identity/context read-back differs'}
        if(-not$context.before-and$Operation.action-eq'create'){$expected=@($Operation.contexts|ForEach-Object {@{itemId=(Get-PresGuid $Operation.itemId);language=$_.query.language;version=[int]$_.query.version}}|Sort-Object language,version);Assert-PresEqual $item.contexts $expected 'New design version coverage differs'}
        foreach($layout in $context.layouts){$value=if($layout.final){$item.final}else{$item.shared};if(-not$value-or(Get-PresGuid $value.layoutId)-ne(Get-PresGuid $layout.layoutId)){throw 'Layout read-back differs'};Assert-PresEqual (Get-PresNormalizedRows $value.renderings) (Get-PresNormalizedRows $layout.renderings) 'Rendering occurrence read-back differs'}
        foreach($field in $context.fields){$actualField=@($item.fields|Where-Object name -CEQ $field.name);if($actualField.Count-ne1-or(Get-PresGuid $actualField[0].id)-ne(Get-PresGuid $field.fieldId)-or$actualField[0].storage-cne$field.storage){throw 'Field metadata read-back differs'};$raw=$actualField[0].value
            if($field.kind-ceq'mapping'){Assert-PresEqual @(Get-PresMapping $raw) $field.mappings 'Template mappings read-back differs'}elseif($field.name-ceq'PartialDesigns'){Assert-PresEqual @($(if($raw){$raw.Split('|')|ForEach-Object {Get-PresGuid $_}})) @($(if($field.value){$field.value.Split('|')|ForEach-Object {Get-PresGuid $_}})) 'Partial Design references differ'}elseif($field.name-in@('Page Design','Layout')){if($raw-or$field.value){if(-not$raw-or-not$field.value-or(Get-PresGuid $raw)-ne(Get-PresGuid $field.value)){throw 'Design association differs'}}}elseif($raw-cne$field.value){throw 'Presentation scalar differs'}
        }
        if($context.before){Assert-PresEqual $item.contexts $context.before.contexts 'Unexpected versions';Assert-PresEqual $item.sharedOther $context.before.sharedOther 'Other shared device changed';Assert-PresEqual $item.finalOther $context.before.finalOther 'Other final device changed'
            $changed=@($context.fields|ForEach-Object {$_.name})+@($context.layouts|ForEach-Object {if($_.final){'__Final Renderings'}else{'__Renderings'}})
            foreach($prior in $context.before.fields){if($changed-ccontains$prior.name){continue};$after=@($item.fields|Where-Object name -CEQ $prior.name);if($after.Count-ne1-or$after[0].value-cne$prior.value-or$after[0].rawValue-cne$prior.rawValue){throw 'Unapproved material/presentation changed'}}
        }
    }
}
function Get-PresOperationPost($Operation) {return @(foreach($ctx in $Operation.contexts){$observed=Get-PresQuery $ctx.query;if($ctx.query.path){Assert-PresEqual $observed.byId $observed.byPath 'Post ID/path collision'};@{key=$ctx.query.key;item=$observed.byId}})}
function Assert-PresGuard($Guard) {Assert-PresEqual (Get-PresQuery $Guard.query) $Guard ('Target drift: '+$Guard.key)}
function Assert-PresOperation($Operation) {
    Assert-PresPath $Operation.path $Target.rootPath
    if($Operation.action-notin@('create','update')-or$Operation.kind-notin@('partial','design','page','mapping')){throw 'Unsupported presentation mutation'}
    if($Operation.kind-eq'page'-and$Operation.action-ne'update'){throw 'Page content must already exist'}
    if($Operation.kind-eq'mapping'-and($Operation.path-cne$review.profile.pageFolder.path-or(Get-PresGuid $Operation.itemId)-ne(Get-PresGuid $review.profile.pageFolder.id))){throw 'Template mapping write outside Page Designs folder'}
    if($Operation.kind-in@('partial','design')){$folder=if($Operation.kind-eq'partial'){$review.profile.partialFolder}else{$review.profile.pageFolder};$template=if($Operation.kind-eq'partial'){$review.profile.partialTemplateId}else{$review.profile.pageTemplateId};if([IO.Path]::GetDirectoryName($Operation.path).Replace('\','/')-cne$folder.path-or(Get-PresGuid $Operation.templateId)-ne(Get-PresGuid $template)){throw 'Design destination/template differs'}}
    foreach($ctx in $Operation.contexts){if((Get-PresGuid $ctx.query.id)-ne(Get-PresGuid $Operation.itemId)-or$ctx.query.path-cne$Operation.path){throw 'Operation context outside identity'}
        foreach($field in $ctx.fields){$allowed=switch($Operation.kind){'partial'{@('Signature')};'design'{@('PartialDesigns','Layout')};'page'{@('Page Design')};'mapping'{@('TemplatesMapping')}};if($field.name-cnotin$allowed-or$field.storage-notin@('shared','unversioned','versioned')){throw 'Unapproved presentation field'};if($field.name-eq'Layout'-and$review.profile.pageDesignLayoutField-cne'Layout'){throw 'Layout field adapter not enabled'}
            $metadata=if($ctx.before){@($ctx.before.fields|Where-Object name -CEQ $field.name)}else{@($review.templates|Where-Object {(Get-PresGuid $_.id)-eq(Get-PresGuid $Operation.templateId)-and$_.language-ceq$ctx.query.language}|ForEach-Object {$_.fields}|Where-Object name -CEQ $field.name)}
            if($metadata.Count-ne1-or(Get-PresGuid $metadata[0].id)-ne(Get-PresGuid $field.fieldId)-or$metadata[0].type-cne$field.type-or$metadata[0].storage-cne$field.storage){throw 'Operation field metadata differs'}
        }
        foreach($layout in $ctx.layouts){if($Operation.kind-notin@('partial','page')-or[bool]$layout.final-ne($Operation.kind-eq'page')-or(Get-PresGuid $layout.deviceId)-ne(Get-PresGuid $Device.ID)){throw 'Unapproved layout write'};if(@($layout.renderings).Count-gt500){throw 'Rendering occurrence bound exceeded'};foreach($row in $layout.renderings){[void](Get-PresGuid $row.uid);[void](Get-PresGuid $row.renderingId);if($row.datasourceId){[void](Get-PresGuid $row.datasourceId)};if(-not$row.placeholder-or$row.placeholder-match'[\p{Cc}\\]'){throw 'Invalid physical placeholder'}}}
    }
}
function Set-PresScalar($Item,$Field) {
    $slot=$Item.Fields[[Sitecore.Data.ID]::Parse((Get-PresGuid $Field.fieldId))];if(-not$slot-or$slot.Name-cne$Field.name){throw 'Actual presentation field absent'}
    $value=[string]$Field.value
    if($Field.kind-ceq'mapping'){$map=New-Object Sitecore.Text.UrlString;foreach($entry in $Field.mappings){$map[(Get-PresGuid $entry.templateId)]=(Get-PresGuid $entry.designId)};$value=[Web.HttpUtility]::UrlEncode($map.ToString())}
    $Item.Editing.BeginEdit();try{$slot.Value=$value;[void]$Item.Editing.EndEdit()}catch{$Item.Editing.CancelEdit();throw}
}
function Set-PresLayout($Item,$Layout) {
    foreach($instance in @(Get-Rendering -Item $Item -Device $Device -FinalLayout:([bool]$Layout.final))){Remove-Rendering -Item $Item -Instance $instance -Device $Device -FinalLayout:([bool]$Layout.final) -ErrorAction Stop}
    $layoutItem=Get-PresItem $Layout.layoutId '' 1;if(-not$layoutItem){throw 'Target layout no longer exists'}
    Set-Layout -Item $Item -Layout $layoutItem -Device $Device -FinalLayout:([bool]$Layout.final) -ErrorAction Stop
    foreach($row in $Layout.renderings){$renderingItem=Get-PresItem $row.renderingId '' 1;if(-not$renderingItem){throw 'Target rendering no longer exists'};if($row.datasourceId-and-not(Get-PresItem $row.datasourceId '' 1)){throw 'Datasource no longer exists'}
        $instance=$renderingItem|New-Rendering -Placeholder $row.placeholder;$instance.UniqueId=Get-PresGuid $row.uid
        $parameters=@{};foreach($property in $row.parameters.PSObject.Properties){$parameters[$property.Name]=[string]$property.Value}
        $args=@{Item=$Item;Instance=$instance;PlaceHolder=[string]$row.placeholder;Device=$Device;FinalLayout=[bool]$Layout.final;ErrorAction='Stop'}
        if($row.datasourceId){$args.DataSource=Get-PresGuid $row.datasourceId};if($parameters.Count){$args.Parameter=$parameters}
        Add-Rendering @args|Out-Null
    }
}
if($RequestJson-isnot[string]-or$RequestSha256-cnotmatch'^[a-f0-9]{64}$'){throw 'Exact mutation request required'}
$bytes=[Text.Encoding]::UTF8.GetBytes($RequestJson);if($bytes.Length-gt8388608-or(Get-PresHash $bytes)-cne$RequestSha256){throw 'Mutation request bytes/hash differ'}
$request=$RequestJson|ConvertFrom-Json;$reviewBytes=[Text.Encoding]::UTF8.GetBytes([string]$request.reviewJson);if((Get-PresHash $reviewBytes)-cne$request.reviewSha256){throw 'Exact review hash differs'}
$review=$request.reviewJson|ConvertFrom-Json;$Target=$review.target;$Cap=$review.capabilities
Assert-PresEnvironment $review
if($review.kind-cne'presentation-mutation-review'-or$request.version-ne1-or$request.requestId-cnotmatch'^presentation-[a-f0-9]{24}$'-or$review.operations-isnot[array]-or$review.operations.Count-lt1-or$review.operations.Count-gt20-or$bytes.Length-gt[long]$Cap.maxRequestBytes){throw 'Invalid bounded presentation request'}
foreach($flag in @('speWrite','fullItemBackup','restoreValidated','exclusiveWriteWindow','journalContinuityVerified','layoutRoundtripValidated','authoringDatabaseValidated')){if($Cap.$flag-ne$true){throw ('Write capability absent: '+$flag)}}
$approval=$request.approval
if($approval.kind-cne'mutation'-or$approval.choice-cne'approve'-or$approval.scopeId-cne$review.scopeId-or$approval.taskId-cne$review.taskId-or-not$approval.userResponse-or(Get-PresTime $approval.at)-gt[DateTimeOffset]::UtcNow-or-not@($approval.inputs|Where-Object sha256 -CEQ $request.reviewSha256).Count){throw 'Current exact mutation approval required'}
if($request.reservation-cne$review.checkpointSha256){throw 'Reservation/review checkpoint differs'}
foreach($command in @('Export-Item','Import-Item','Get-Layout','Set-Layout','Get-Rendering','Remove-Rendering','New-Rendering','Add-Rendering','Add-ItemVersion')){if(-not(Get-Command $command -ErrorAction SilentlyContinue)){throw ('Verified SPE command absent: '+$command)}}
foreach($operation in $review.operations){Assert-PresOperation $operation}
$DataRoot=[IO.Path]::GetFullPath([Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder));$scope=Get-PresHash ([Text.Encoding]::UTF8.GetBytes($Target.instanceId+'|'+$Target.database.ToLowerInvariant()+'|'+$Target.rootPath.ToLowerInvariant()))
$scopeDirectory=[IO.Path]::Combine($DataRoot,'kajoo-presentation-write',$scope);[void][IO.Directory]::CreateDirectory($scopeDirectory)
$directory=[IO.Path]::Combine($scopeDirectory,$request.requestId);$receiptPath=[IO.Path]::Combine($directory,'receipt.json')
if([IO.Directory]::Exists($directory)){
    if(-not[IO.File]::Exists($receiptPath)){throw 'Previous request effects unknown; reconcile without resubmitting'}
    $prior=[IO.File]::ReadAllText($receiptPath)|ConvertFrom-Json;if($prior.requestSha256-cne$RequestSha256-or$prior.reviewSha256-cne$request.reviewSha256){throw 'Request claim collision'};Write-PresExport $directory;return
}
$lockPath=[IO.Path]::Combine($scopeDirectory,'active.lock');$lock=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$terminal=$false
try {
    foreach($guard in $review.guards){Assert-PresGuard $guard}
    Assert-PresEqual @(Get-PresConsumers $review.consumerTemplateIds) @($review.consumers) 'Template consumer impact drift'
    foreach($template in $review.templates){Assert-PresEqual (Get-PresTemplate $template.id $template.language) $template 'Design template metadata drift'}
    [void][IO.Directory]::CreateDirectory($directory);Write-PresDurable ([IO.Path]::Combine($directory,'claim.json')) @{requestId=$request.requestId;requestSha256=$RequestSha256;reviewSha256=$request.reviewSha256;at=[DateTimeOffset]::UtcNow.ToString('o')}
    $backupRoot=[IO.Path]::Combine($directory,'backups');[void][IO.Directory]::CreateDirectory($backupRoot);$backupBytes=0;$backups=@()
    foreach($operation in $review.operations){if($operation.action-ne'update'){continue};$item=Get-PresItem $operation.itemId '' 1;if(-not$item){throw 'Backup item absent'};Export-Item -Item $item -Root $backupRoot -ErrorAction Stop|Out-Null}
    foreach($file in [IO.Directory]::GetFiles($backupRoot,'*',[IO.SearchOption]::AllDirectories)){$record=Get-PresFileRecord $file;$backupBytes+=$record.bytes;if($backupBytes-gt[long]$Cap.maxBackupBytes){throw 'Backup byte bound exceeded'};$backups+=$record}
    if(@($review.operations|Where-Object action -EQ 'update').Count-and-not$backups.Count){throw 'Full item backup export is empty'}
    foreach($guard in $review.guards){Assert-PresGuard $guard}
    Assert-PresEqual @(Get-PresConsumers $review.consumerTemplateIds) @($review.consumers) 'Template consumer impact drift'
    $results=@();$journal=@();$stopped=$false
    foreach($operation in $review.operations){
        if($stopped){$results+=@{operationId=$operation.operationId;status='skipped';post=@()};continue}
        $entry=[IO.Path]::Combine($directory,('intent-'+$results.Count+'.json'));Write-PresDurable $entry @{operationId=$operation.operationId;operation=$operation;at=[DateTimeOffset]::UtcNow.ToString('o')};$journal+=Get-PresFileRecord $entry
        try {
            if((Get-PresTime $Cap.expiresAt)-le[DateTimeOffset]::UtcNow){throw 'Write window expired'}
            foreach($ctx in $operation.contexts){$actual=Get-PresQuery $ctx.query;Assert-PresEqual $actual.byId $ctx.before 'Operation before-state drift';if($ctx.query.path){Assert-PresEqual $actual.byId $actual.byPath 'Operation path collision'}}
            if($operation.action-eq'create'){
                $first=$operation.contexts[0].query;$parent=[IO.Path]::GetDirectoryName($operation.path).Replace('\','/');$name=$operation.path.Substring($parent.Length+1)
                New-Item -Path ($Target.database+':'+$parent) -Name $name -ItemType (Get-PresGuid $operation.templateId) -ForceId (Get-PresGuid $operation.itemId) -Language $first.language -ErrorAction Stop|Out-Null
                foreach($ctx in @($operation.contexts|Select-Object -Skip 1)){$base=Get-PresItem $operation.itemId $first.language 1;Add-ItemVersion -Item $base -TargetLanguage $ctx.query.language -IfExist Skip -ErrorAction Stop|Out-Null}
            }
            foreach($ctx in $operation.contexts){$item=Get-PresItem $operation.itemId $ctx.query.language $ctx.query.version;if(-not$item-or[string]$item.Language-cne$ctx.query.language-or[int][string]$item.Version-ne[int]$ctx.query.version){throw 'Exact target version unavailable'};foreach($layout in $ctx.layouts){Set-PresLayout $item $layout};foreach($field in $ctx.fields){Set-PresScalar $item $field}}
            $post=@(Get-PresOperationPost $operation);Assert-PresPost $operation $post;$results+=@{operationId=$operation.operationId;status='success';post=$post}
        }catch{$post=@();try{$post=@(Get-PresOperationPost $operation)}catch{};$results+=@{operationId=$operation.operationId;status='failed';post=$post;error=$_.Exception.Message};$stopped=$true}
        $entry=[IO.Path]::Combine($directory,('result-'+($results.Count-1)+'.json'));Write-PresDurable $entry $results[-1];$journal+=Get-PresFileRecord $entry
        if((@($journal|Measure-Object bytes -Sum).Sum)-gt[long]$Cap.maxJournalBytes){throw 'Journal byte bound exceeded; reconcile reserved request'}
    }
    $receipt=@{version=1;kind='presentation-execution-receipt';scopeId=$review.scopeId;taskId=$review.taskId;requestId=$request.requestId;requestSha256=$RequestSha256;reviewSha256=$request.reviewSha256;applicationPlanSha256=$review.applicationPlanSha256;batchId=$review.batchId;target=$Target;status=$(if($stopped){'failed'}else{'success'});results=@($results);backups=@($backups);journal=@($journal)}
    if([Text.Encoding]::UTF8.GetByteCount(($receipt|ConvertTo-Json -Depth 90 -Compress))-gt[long]$Cap.maxCaptureBytes){throw 'Receipt byte bound exceeded; reconcile reserved request'}
    Write-PresDurable $receiptPath $receipt;$terminal=$true;Write-PresExport $directory
}finally{$lock.Dispose();if($terminal){[IO.File]::Delete($lockPath)}}
