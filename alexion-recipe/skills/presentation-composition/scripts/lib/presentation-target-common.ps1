# Shared, bounded target observation helpers. No Sitecore mutation functions here.
function Get-PresHash([byte[]]$Bytes) { $sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()} }
function Get-PresGuid($Value) { $g=[guid]::Empty;if(-not [guid]::TryParse([string]$Value,[ref]$g)-or $g-eq[guid]::Empty){throw 'Invalid presentation GUID'};return $g.ToString('B').ToUpperInvariant() }
function Get-PresTime($Value) {
    # PowerShell versions differ: JSON timestamps may arrive as strings or DateTime objects.
    if($Value -is [DateTimeOffset]){return $Value.ToUniversalTime()}
    if($Value -is [DateTime]){return ([DateTimeOffset]::new($Value)).ToUniversalTime()}
    $v=[DateTimeOffset]::MinValue
    if(-not[DateTimeOffset]::TryParse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$v)){throw 'Invalid presentation timestamp'}
    return $v.ToUniversalTime()
}
function Assert-PresPath($Path,$Root) { if([string]$Path -notmatch '^/sitecore/content/[^\\:*?\[\]\p{Cc}]+$'-or $Path-match '(^|/)\.\.?(/|$)|//|/$'-or(-not([string]$Path).StartsWith($Root+'/',[StringComparison]::OrdinalIgnoreCase)-and $Path-ine$Root)){throw 'Presentation path outside approved target site'} }
function Get-PresItem($Identity,[string]$Language,[int]$Version=1) {
    $args=@{Path=($Target.database+':');ErrorAction='SilentlyContinue'}
    if(([string]$Identity).StartsWith('/')){$args.Path=$Target.database+':'+$Identity}else{$args.ID=Get-PresGuid $Identity}
    if($Language){$args.Language=$Language;if($Version-gt0){$args.Version=[string]$Version}}
    $result=@(Get-Item @args);if($result.Count-gt1){throw 'Ambiguous target item'}
    if($result.Count){return $result[0]}
    if($Language-and$Version-eq0){return $null}
    $args.Remove('Version');$args.Remove('Language');$result=@(Get-Item @args);if($result.Count-gt1){throw 'Ambiguous base target item'};if($result.Count){return $result[0]};return $null
}
function Get-PresParameters([string]$Value) {
    $result=[ordered]@{};if(-not$Value){return $result}
    $values=[System.Web.HttpUtility]::ParseQueryString($Value.TrimStart('?'))
    foreach($key in $values.AllKeys){if($null-eq$key-or @($values.GetValues($key)).Count-ne1){throw 'Ambiguous rendering parameter transport'};$result[[string]$key]=[string]$values[$key]};return $result
}
function Get-PresContexts($Item) {
    $contexts=@();foreach($language in @($Item.Languages)){ $versionItem=Get-PresItem ([string]$Item.ID) ([string]$language.Name) 0;if(-not$versionItem){continue};foreach($row in @($versionItem.Versions.GetVersions())){if([string]$row.Language-cne[string]$language.Name){throw 'Language fallback cannot establish context coverage'};if($contexts.Count-ge[long]$Cap.maxContexts){throw 'Context capture bound exceeded'};$contexts+=@{itemId=(Get-PresGuid $Item.ID);language=[string]$row.Language;version=[int][string]$row.Version}} }
    return @($contexts | Sort-Object language,version)
}
function Get-PresOtherDevices([string]$Xml) {
    if(-not$Xml){return @()};$settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
    $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Xml),$settings);try{$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;$doc.Load($reader)}finally{$reader.Dispose()}
    $rows=@();foreach($node in $doc.DocumentElement.ChildNodes){if($node.LocalName-eq'd'-and(Get-PresGuid $node.GetAttribute('id'))-ne(Get-PresGuid $Device.ID)){$rows+=@{id=(Get-PresGuid $node.GetAttribute('id'));xml=$node.OuterXml}}};return @($rows | Sort-Object id)
}
function Get-PresLayout($Item,[bool]$Final) {
    $layout=@(Get-Layout -Item $Item -Device $Device -FinalLayout:$Final -ErrorAction SilentlyContinue)
    if($layout.Count-gt1){throw 'Ambiguous device layout'};$layoutId=if($layout.Count){Get-PresGuid $layout[0].ID}else{$null};$rows=@()
    foreach($row in @(Get-Rendering -Item $Item -Device $Device -FinalLayout:$Final -ErrorAction Stop)){
        $ds=[string]$row.Datasource;$g=[guid]::Empty;if($ds-and[guid]::TryParse($ds,[ref]$g)){$ds=$g.ToString('B').ToUpperInvariant()}
        $rows+=@{uid=(Get-PresGuid $row.UniqueId);renderingId=(Get-PresGuid $row.ItemID);placeholder=[string]$row.Placeholder;parameters=(Get-PresParameters ([string]$row.Parameters));datasourceId=$(if($ds){$ds}else{$null})}
    };return @{layoutId=$layoutId;renderings=@($rows)}
}
function Get-PresFields($Item,$MaterialIds) {
    $result=@();$seen=@{}
    foreach($name in @('__Renderings','__Final Renderings','PartialDesigns','Page Design','TemplatesMapping','Signature','Layout','Component Name','componentName')+@($MaterialIds)){
        $field=$Item.Fields[[string]$name];if(-not$field){$g=[guid]::Empty;if([guid]::TryParse([string]$name,[ref]$g)){$field=$Item.Fields[[Sitecore.Data.ID]::Parse($g.ToString('B'))]}}
        if(-not$field){if($MaterialIds -contains $name){throw 'Requested material field absent'};continue}
        $key=Get-PresGuid $field.ID;if($seen.ContainsKey($key)){continue};$seen[$key]=$true
        $standard='';if($Item.Template.StandardValues){$sf=$Item.Template.StandardValues.Fields[$field.ID];if($sf){$standard=[string]$sf.Value}}
        $result+=@{id=$key;name=[string]$field.Name;type=[string]$field.Type;storage=$(if($field.Shared){'shared'}elseif($field.Unversioned){'unversioned'}else{'versioned'});value=[string]$field.Value;rawValue=[string]$field.GetValue($false,$false);standardValue=$standard}
    };return @($result | Sort-Object name)
}
function Get-PresSnapshot($Item,$Query) {
    if(-not$Item){return $null};$fields=@(Get-PresFields $Item $Query.materialFieldIds)
    $shared=@($fields|Where-Object name -CEQ '__Renderings');$final=@($fields|Where-Object name -CEQ '__Final Renderings')
    $component=@($fields|Where-Object {$_.name-ceq'Component Name'-or$_.name-ceq'componentName'});if($component.Count-gt1-and$component[0].value-cne$component[1].value){throw 'Ambiguous component name fields'}
    return @{id=(Get-PresGuid $Item.ID);path=[string]$Item.Paths.FullPath;templateId=(Get-PresGuid $Item.TemplateID);versionPresent=([string]$Item.Language-ceq$Query.language-and[int][string]$Item.Version-eq[int]$Query.version);contexts=@(Get-PresContexts $Item);fields=$fields;shared=$(if($shared.Count){Get-PresLayout $Item $false}else{$null});final=$(if($final.Count){Get-PresLayout $Item $true}else{$null});sharedOther=@(if($shared.Count){Get-PresOtherDevices $shared[0].value});finalOther=@(if($final.Count){Get-PresOtherDevices $final[0].value});componentName=$(if($component.Count){[string]$component[0].value}else{$null})}
}
function Get-PresQuery($Query) {
    $byId=Get-PresItem $Query.id $Query.language $Query.version;$byPath=if($Query.path){Get-PresItem $Query.path $Query.language $Query.version}else{$null}
    return @{key=$Query.key;query=$Query;byId=(Get-PresSnapshot $byId $Query);byPath=$(if($Query.path){Get-PresSnapshot $byPath $Query}else{$null})}
}
function Get-PresTemplateBases($Definition,$Seen) {
    $result=@();foreach($base in @($Definition.BaseTemplates)){$value=Get-PresGuid $base.ID;if($Seen-contains$value-or$Seen.Count-ge50){throw 'Template base cycle/depth'};$result+=$value;$result+=@(Get-PresTemplateBases $base (@($Seen)+@($value)))};return @($result|Sort-Object -Unique)
}
function Get-PresTemplate($Id,$Language) {
    $item=Get-PresItem $Id $Language 1;if(-not$item){throw 'Required design template absent'};$template=New-Object Sitecore.Data.Items.TemplateItem -ArgumentList $item
    $fields=@();foreach($field in @($template.GetFields())){if($field.Name-notin@('__Renderings','__Final Renderings','PartialDesigns','Signature','Layout')){continue};$value='';if($template.StandardValues){$slot=$template.StandardValues.Fields[$field.ID];if($slot){$value=[string]$slot.Value}}
        $fields+=@{id=(Get-PresGuid $field.ID);name=[string]$field.Name;type=[string]$field.Type;storage=$(if($field.Shared){'shared'}elseif($field.Unversioned){'unversioned'}else{'versioned'});value=$value}
    };return @{id=(Get-PresGuid $Id);language=[string]$Language;baseIds=@(Get-PresTemplateBases $template @((Get-PresGuid $Id)));fields=@($fields|Sort-Object name)}
}
function Get-PresConsumers($TemplateIds) {
    if(-not@($TemplateIds).Count){return @()}
    $queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue((Get-PresItem $Target.marker.id '' 1));$visited=0;$contextCount=0;$consumers=@{}
    foreach($template in $TemplateIds){$consumers[(Get-PresGuid $template)]=@()}
    while($queue.Count){$item=$queue.Dequeue();$visited++;if($visited-gt[long]$Cap.maxReadItems){throw 'Template consumer scan exceeds approved item bound'};Assert-PresPath $item.Paths.FullPath $Target.rootPath
        $key=Get-PresGuid $item.TemplateID;if($consumers.ContainsKey($key)){$contexts=@(Get-PresContexts $item);$contextCount+=$contexts.Count;if($contextCount-gt[long]$Cap.maxContexts){throw 'Template consumer context bound exceeded'};$consumers[$key]+=$contexts}
        foreach($child in @($item.GetChildren())){if($queue.Count+$visited-ge[long]$Cap.maxReadItems){throw 'Template consumer scan exceeds approved item bound'};$queue.Enqueue($child)}
    }
    return @(foreach($key in @($consumers.Keys|Sort-Object)){@{templateId=$key;contexts=@($consumers[$key]|Sort-Object itemId,language,version);complete=$true}})
}
function Assert-PresEnvironment($Request) {
    if($Request.version-ne1-or-not$Request.scopeId-or-not$Target.instanceId-or-not$Target.connectorId-or$Target.database-cnotmatch'^[a-zA-Z][a-zA-Z0-9_-]*$'-or$Target.database-ieq'web'){throw 'Invalid authoring target'}
    Assert-PresPath $Target.rootPath $Target.rootPath;if($Target.marker.path-cne$Target.rootPath){throw 'Exact target site marker required'}
    foreach($flag in @('speRead','fileDownload','stableReadWindow')){if($Cap.$flag-ne$true){throw 'Read capability absent'}}
    foreach($bound in @(@('maxReadItems',1,1000),@('maxContexts',1,5000),@('maxRequestBytes',4096,8388608),@('maxCaptureBytes',4096,16777216),@('maxBackupBytes',4096,67108864),@('maxJournalBytes',4096,16777216))){$value=[long]$Cap.($bound[0]);if($value-lt$bound[1]-or$value-gt$bound[2]){throw ('Invalid capability bound: '+$bound[0])}}
    if((Get-PresTime $Cap.expiresAt)-le[DateTimeOffset]::UtcNow-or(Get-PresTime $Cap.verifiedAt)-gt[DateTimeOffset]::UtcNow){throw 'Capability window expired'}
    $marker=Get-PresItem $Target.marker.id '' 1;if(-not$marker-or[string]$marker.Paths.FullPath-cne$Target.marker.path-or(Get-PresGuid $marker.TemplateID)-ne(Get-PresGuid $Target.marker.templateId)){throw 'Target marker mismatch'}
    $db=[Sitecore.Configuration.Factory]::GetDatabase($Target.database);$found=@($db.Resources.Devices.GetAll()|Where-Object {(Get-PresGuid $_.ID)-eq(Get-PresGuid $Request.deviceId)})
    if($found.Count-ne1){throw 'Exact target device absent'};$script:Device=$found[0]
}
function Write-PresDurable($Path,$Value) {
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 90 -Compress)+"`n");$stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-PresFileRecord($File) {
    $full=[IO.Path]::GetFullPath($File);if(-not$full.StartsWith($DataRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Export outside Sitecore Data folder'}
    if(([IO.File]::GetAttributes($full)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Export links prohibited'};$bytes=[IO.File]::ReadAllBytes($full);return @{file=$full.Substring($DataRoot.Length+1).Replace('\','/');bytes=$bytes.Length;sha256=(Get-PresHash $bytes)}
}
function Write-PresExport($Directory) {
    $files=@([IO.Directory]::GetFiles($Directory,'*',[IO.SearchOption]::AllDirectories)|Sort-Object|ForEach-Object {Get-PresFileRecord $_})
    '<!-- kajoo-export: '+(@{files=$files}|ConvertTo-Json -Depth 20 -Compress)+' -->'
}
