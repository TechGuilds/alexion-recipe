param([string]$InputPath,[string]$OutputPath)
# Synthetic SPE adapter: production collector, snapshot helpers and writer run unchanged.
# Environment discovery and template metadata lookup are replaced; this harness never connects to Sitecore.
$ErrorActionPreference='Stop'
$fixture=Get-Content -LiteralPath $InputPath -Raw|ConvertFrom-Json
Add-Type @'
namespace Sitecore { public static class MainUtil { public static string MapPath(string p) { return p; } } }
namespace Sitecore.Configuration { public static class Settings { public static string DataFolder {get;set;} } }
namespace Sitecore.Data { public static class ID { public static string Parse(string s) { return System.Guid.Parse(s).ToString("B").ToUpperInvariant(); } } }
namespace Sitecore.Text {
 public sealed class UrlString {
  readonly System.Collections.Generic.Dictionary<string,string> pairs = new System.Collections.Generic.Dictionary<string,string>(System.StringComparer.OrdinalIgnoreCase);
  public string this[string key] {get {return pairs.ContainsKey(key) ? pairs[key] : null;} set {pairs[key]=value;}}
  public override string ToString() {
   var parts = new System.Collections.Generic.List<string>();
   foreach(var pair in pairs) parts.Add(System.Net.WebUtility.UrlEncode(pair.Key)+"="+System.Net.WebUtility.UrlEncode(pair.Value));
   return string.Join("&",parts);
  }
 }
}
'@
[Sitecore.Configuration.Settings]::DataFolder=$fixture.dataRoot
$script:writes=0;$script:exports=0;$script:events=@();$script:items=@{}
$scripts=Join-Path $PSScriptRoot '../scripts'
. (Join-Path $scripts 'lib/presentation-target-common.ps1')
function Assert-PresEnvironment($Request){$script:Device=[pscustomobject]@{ID=$Request.deviceId}}
function Get-PresItem($Identity,[string]$Language,[int]$Version=1){
    $matches=@($script:items.Values|Where-Object {(([string]$_.ID)-ieq([string]$Identity)-or$_.Paths.FullPath-ceq$Identity)-and(-not$Language-or$_.Language-ceq$Language)-and(-not$Language-or$Version-eq0-or$_.Version-eq$Version)})
    if($matches.Count){return @($matches|Sort-Object Version -Descending)[0]};return $null
}
function Get-PresTemplate($Id,$Language){return @($fixture.templates|Where-Object {$_.id-ieq$Id-and$_.language-ceq$Language})[0]}
function New-SyntheticItem($row,[string]$Language='en',[int]$Version=1){
    $fields=@{};foreach($spec in $row.fields){
        $field=[pscustomobject]@{ID=$spec.id;Name=$spec.name;Type=$spec.type;Shared=($spec.storage-eq'shared');Unversioned=($spec.storage-eq'unversioned');Value=[string]$spec.value}
        $field|Add-Member ScriptMethod GetValue {param($standard,$fallback) return $this.Value}
        $fields[$spec.name]=$field;$fields[(Get-PresGuid $spec.id)]=$field
    }
    $editing=[pscustomobject]@{}
    $editing|Add-Member ScriptMethod BeginEdit {$script:events+='begin';if($fixture.failEdit){throw 'Synthetic edit failure'}}
    $editing|Add-Member ScriptMethod EndEdit {$script:writes++;$script:events+='scalar'}
    $editing|Add-Member ScriptMethod CancelEdit {$script:events+='cancel'}
    $item=[pscustomobject]@{ID=$row.id;TemplateID=$row.templateId;Paths=[pscustomobject]@{FullPath=$row.path};Language=$Language;Version=$Version;Languages=@([pscustomobject]@{Name=$Language});Fields=$fields;Template=[pscustomobject]@{StandardValues=$null};Editing=$editing;SharedLayout=$row.shared;FinalLayout=$row.final;Children=@()}
    $versions=[pscustomobject]@{Rows=@([pscustomobject]@{Language=$Language;Version=$Version})};$versions|Add-Member ScriptMethod GetVersions {return $this.Rows};$item|Add-Member NoteProperty Versions $versions
    $item|Add-Member ScriptMethod GetChildren {return $this.Children}
    $key=(Get-PresGuid $row.id);if($Language-cne'en'-or$Version-ne1){$key+='|'+$Language+'|'+$Version};$script:items[$key]=$item
    $siblings=@($script:items.Values|Where-Object ID -EQ $row.id);$languages=@($siblings.Language|Sort-Object -Unique|ForEach-Object {[pscustomobject]@{Name=$_}})
    foreach($sibling in $siblings){$sibling.Languages=$languages;$siblingLanguage=$sibling.Language;$sibling.Versions.Rows=@($siblings|Where-Object Language -CEQ $siblingLanguage|Sort-Object Version|ForEach-Object {[pscustomobject]@{Language=$_.Language;Version=$_.Version}})}
    return $item
}
foreach($row in $fixture.items){$language=if($row.language){[string]$row.language}else{'en'};$version=if($row.version){[int]$row.version}else{1};$null=New-SyntheticItem $row $language $version}
if($fixture.children){$script:items[(Get-PresGuid $fixture.items[0].id)].Children=@($fixture.children|ForEach-Object {$script:items[(Get-PresGuid $_)]})}
function Get-Layout {[CmdletBinding()]param($Item,$Device,[switch]$FinalLayout) $layout=if($FinalLayout){$Item.FinalLayout}else{$Item.SharedLayout};if($layout.layoutId){[pscustomobject]@{ID=$layout.layoutId}}}
function Get-Rendering {[CmdletBinding()]param($Item,$Device,[switch]$FinalLayout) $layout=if($FinalLayout){$Item.FinalLayout}else{$Item.SharedLayout};foreach($row in $layout.renderings){$parameters=@($row.parameters.PSObject.Properties|ForEach-Object {[Web.HttpUtility]::UrlEncode($_.Name)+'='+[Web.HttpUtility]::UrlEncode([string]$_.Value)})-join'&';[pscustomobject]@{UniqueId=$row.uid;ItemID=$row.renderingId;Placeholder=$row.placeholder;Parameters=$parameters;Datasource=$row.datasourceId}}}
function Remove-Rendering {[CmdletBinding()]param($Item,$Instance,$Device,[switch]$FinalLayout) $layout=if($FinalLayout){$Item.FinalLayout}else{$Item.SharedLayout};$layout.renderings=@($layout.renderings|Where-Object uid -NE $Instance.UniqueId);$script:writes++;$script:events+='remove'}
function Set-Layout {[CmdletBinding()]param($Item,$Layout,$Device,[switch]$FinalLayout) $value=if($FinalLayout){$Item.FinalLayout}else{$Item.SharedLayout};$value.layoutId=$Layout.ID;$script:writes++;$script:events+='layout'}
function New-Rendering {[CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject,$Placeholder) process {[pscustomobject]@{UniqueId='';ItemID=$InputObject.ID;Placeholder=$Placeholder}}}
function Add-Rendering {[CmdletBinding()]param($Item,$Instance,$PlaceHolder,$Device,[switch]$FinalLayout,$DataSource,[hashtable]$Parameter)
    if($fixture.failAdd){throw 'Synthetic rendering failure'}
    $layout=if($FinalLayout){$Item.FinalLayout}else{$Item.SharedLayout};$parameters=[pscustomobject]@{};if($Parameter){$parameters=[pscustomobject]$Parameter}
    $uid=if($fixture.corruptUid){'{00000000-0000-0000-0000-000000009999}'}else{$Instance.UniqueId}
    $layout.renderings+=@([pscustomobject]@{uid=$uid;renderingId=$Instance.ItemID;placeholder=$PlaceHolder;parameters=$parameters;datasourceId=$DataSource});$script:writes++;$script:events+='add'
}
function Export-Item {[CmdletBinding()]param($Item,$Root) $script:exports++;$script:events+='backup';[IO.File]::WriteAllText((Join-Path $Root (($Item.ID.Trim('{}'))+'.json')),($fixture.items|ConvertTo-Json -Depth 50))}
function Import-Item {}
function New-Item {
    [CmdletBinding()]param([string]$Path,[string]$Name,[string]$ItemType,[string]$ForceId,[string]$Language)
    if(-not$ForceId){throw 'SPE New-Item requires the approved ForceId'}
    $template=Get-PresTemplate $ItemType $Language;if(-not$template){throw 'Synthetic template absent'}
    $itemPath=$Path.Substring($Path.IndexOf(':')+1)+'/'+$Name
    if((Get-PresItem $ForceId '' 1)-or(Get-PresItem $itemPath '' 1)){throw 'Synthetic item already exists'}
    $row=[pscustomobject]@{id=(Get-PresGuid $ForceId);templateId=(Get-PresGuid $ItemType);path=$itemPath;fields=@($template.fields);shared=[pscustomobject]@{layoutId=$null;renderings=@()};final=[pscustomobject]@{layoutId=$null;renderings=@()}}
    $script:writes++;$script:events+='create:'+ $Language
    New-SyntheticItem $row $Language
}
function Add-ItemVersion {
    [CmdletBinding()]param($Item,[string]$TargetLanguage,[ValidateSet('Skip')][string]$IfExist)
    $existing=Get-PresItem $Item.ID $TargetLanguage 1;if($existing){return $existing}
    $template=Get-PresTemplate $Item.TemplateID $TargetLanguage;if(-not$template){throw 'Synthetic language template absent'}
    $row=[pscustomobject]@{id=$Item.ID;templateId=$Item.TemplateID;path=$Item.Paths.FullPath;fields=@($template.fields);shared=$Item.SharedLayout;final=[pscustomobject]@{layoutId=$null;renderings=@()}}
    $created=New-SyntheticItem $row $TargetLanguage
    foreach($spec in $template.fields){if($spec.storage-ceq'shared'){$slot=$Item.Fields[$spec.name];$created.Fields[$spec.name]=$slot;$created.Fields[(Get-PresGuid $spec.id)]=$slot}}
    $script:writes++;$script:events+='version:'+ $TargetLanguage
    return $created
}
$RequestJson=[string]$fixture.requestJson;$RequestSha256=[string]$fixture.requestSha256
$errorText=$null;$outputs=@()
try {
    $entryScript=if($fixture.mode-eq'capture'){'capture-presentation-state.ps1'}else{'execute-presentation.ps1'}
    $outputs+= . (Join-Path $scripts $entryScript)
    if($fixture.repeat){$outputs+= . (Join-Path $scripts $entryScript)}
}catch{$errorText=$_.Exception.Message+" STACK "+$_.ScriptStackTrace}
$receipt=$null;$state=$null;$files=@()
if(Test-Path -LiteralPath $fixture.dataRoot){foreach($file in Get-ChildItem -LiteralPath $fixture.dataRoot -Recurse -File){$files+=@{path=$file.FullName;bytes=$file.Length;sha256=(Get-PresHash ([IO.File]::ReadAllBytes($file.FullName)))};if($file.Name-eq'receipt.json'){$receipt=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json};if($file.Name-eq'presentation-state.json'){$state=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json}}}
@{error=$errorText;receipt=$receipt;state=$state;writes=$script:writes;exports=$script:exports;events=$script:events;outputs=$outputs;files=$files}|ConvertTo-Json -Depth 90|Set-Content -LiteralPath $OutputPath -Encoding utf8



