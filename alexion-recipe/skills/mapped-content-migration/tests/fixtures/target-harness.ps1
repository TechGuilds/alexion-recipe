param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$fixture=Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$script:Request=$fixture.request
$global:databaseItems=@{}
$global:writes=0; $global:exports=0
Add-Type @'
namespace Sitecore { public static class MainUtil { public static string MapPath(string p) { return p; } } }
namespace Sitecore.Data {
 public sealed class ID { readonly System.Guid value; private ID(System.Guid g) {value=g;} public static ID Parse(string value) {return new ID(System.Guid.Parse(value));} public override string ToString() {return value.ToString("B").ToUpperInvariant();} }
 public sealed class DoubleFieldCollection {
  readonly System.Collections.Generic.Dictionary<string,object> ids = new System.Collections.Generic.Dictionary<string,object>(System.StringComparer.OrdinalIgnoreCase);
  readonly System.Collections.Generic.Dictionary<string,object> names = new System.Collections.Generic.Dictionary<string,object>(System.StringComparer.Ordinal);
  public void Add(string id, string name, object value) {ids[id]=value; names[name]=value;}
  public object this[ID id] {get {object value; return ids.TryGetValue(id.ToString(),out value)?value:null;}}
  public object this[string name] {get {object value; return names.TryGetValue(name,out value)?value:null;}}
 }
}
namespace Sitecore.Configuration { public static class Settings { public static string DataFolder {get;set;} } }
namespace Sitecore.Data.Items { public static class DoubleFields { public static object[] Rows = new object[0]; public static object[] Bases = new object[0]; } public class TemplateItem { public TemplateItem(object i) { } public object[] BaseTemplates {get {return DoubleFields.Bases;}} public object[] GetFields() { return DoubleFields.Rows; } } }
namespace Sitecore.Data.Managers { public class DoubleTemplate { public object[] GetFields() { return Sitecore.Data.Items.DoubleFields.Rows; } } public static class TemplateManager { public static DoubleTemplate GetTemplate(object id, object database) { return new DoubleTemplate(); } } }
'@
[Sitecore.Configuration.Settings]::DataFolder=$fixture.dataRoot
$metadata=@()
foreach ($field in @($Request.core.templates[0].fields)) {
    $metadata+=[pscustomobject]@{ID=$field.id;Name=$field.name;Type=$field.type;Shared=($field.storage -eq 'shared');Unversioned=($field.storage -eq 'unversioned');InnerItem=[pscustomobject]@{Parent=[pscustomobject]@{Parent=[pscustomobject]@{ID=$field.declaringTemplateId}}}}
}
if ($fixture.metadataDrift -and $metadata.Count) { $metadata[0].Type='Blob' }
[Sitecore.Data.Items.DoubleFields]::Rows=[object[]]$metadata
$bases=@()
if ($null -ne $fixture.baseTree) { $bases=@($fixture.baseTree) }
else { foreach ($id in @($Request.core.templates[0].baseTemplateIds)) { $bases+=[pscustomobject]@{ID=$id;BaseTemplates=@()} } }
[Sitecore.Data.Items.DoubleFields]::Bases=[object[]]$bases
function New-DoubleItem($row) {
    $fields=[Sitecore.Data.DoubleFieldCollection]::new()
    foreach ($definition in [Sitecore.Data.Items.DoubleFields]::Rows) { $fields.Add($definition.ID,$definition.Name,[pscustomobject]@{Name=$definition.Name;Value='';Shared=$definition.Shared;Unversioned=$definition.Unversioned;Type=$definition.Type}) }
    foreach ($spec in @($row.fields)) {
        $field=$fields[[Sitecore.Data.ID]::Parse($spec.fieldId)]
        if ($null -ne $field) { $field.Value=[string]$spec.value }
        else { $fields.Add($spec.fieldId,'Unmapped',[pscustomobject]@{Name='Unmapped';Value=[string]$spec.value;Shared=($spec.storage -eq 'shared');Unversioned=($spec.storage -eq 'unversioned');Type='Single-Line Text'}) }
    }
    $editing=[pscustomobject]@{}
    $editing | Add-Member ScriptMethod BeginEdit { }
    $editing | Add-Member ScriptMethod EndEdit { $global:writes++; if ($fixture.failEdit) { throw 'synthetic edit failure' }; return $true }
    $editing | Add-Member ScriptMethod CancelEdit { }
    $template=[pscustomobject]@{}; $template | Add-Member ScriptMethod GetFields { return @() }
    return [pscustomobject]@{ID=$row.id;TemplateID=$row.templateId;Name=$row.path.Split('/')[-1];Paths=[pscustomobject]@{FullPath=$row.path};Language=$row.language;Version=$row.version;Fields=$fields;Editing=$editing;Template=$template}
}
foreach ($row in $fixture.items) { $global:databaseItems[$row.id.ToUpperInvariant() + '|' + $row.language + '|' + $row.version]=New-DoubleItem $row }
function Get-Item {
    [CmdletBinding()]param($Path,$Language,$Version)
    $value=([string]$Path).Substring(([string]$Path).IndexOf(':')+1)
    $found=@($global:databaseItems.Values | Where-Object { $_.ID -ieq $value -or $_.Paths.FullPath -ieq $value })
    if ($Language -eq '*' -and $Version -eq '*') { return $found }
    if ($Language) { $found=@($found | Where-Object Language -ceq $Language) }
    if ($Version) { $found=@($found | Where-Object Version -eq ([int]$Version)) }
    if ($found.Count) { return $found[0] }
    return $null
}
function New-Item {
    [CmdletBinding()]param($Path,$Name,$ID,$ItemType,$Language)
    $global:writes++
    if ($fixture.wrongCreatedVersion) { $Language='fr' }
    $pathValue=([string]$Path).Substring(([string]$Path).IndexOf(':')+1) + '/' + $Name
    $item=New-DoubleItem ([pscustomobject]@{id=$ID;templateId=$ItemType;path=$pathValue;language=$Language;version=1;fields=@()})
    $global:databaseItems[$ID.ToUpperInvariant() + '|' + $Language + '|1']=$item
    return $item
}
function Add-ItemVersion {
    [CmdletBinding()]param($Item,$TargetLanguage,$IfExist,$IfNoSourceVersion,[switch]$DoNotCopyFields)
    $global:writes++
    $matching=@($global:databaseItems.Values | Where-Object { $_.ID -ieq $Item.ID -and $_.Language -ceq $TargetLanguage })
    $next=1; foreach ($match in $matching) { $next=[Math]::Max($next,([int]$match.Version + 1)) }
    $new=New-DoubleItem ([pscustomobject]@{id=$Item.ID;templateId=$Item.TemplateID;path=$Item.Paths.FullPath;language=$TargetLanguage;version=$next;fields=@()})
    $global:databaseItems[$Item.ID.ToUpperInvariant() + '|' + $TargetLanguage + '|' + $next]=$new
    return $new
}
function Export-Item {
    [CmdletBinding()]param($Item,$Root)
    $global:exports++
    [IO.File]::WriteAllText([IO.Path]::Combine($Root,'item.item'),($global:databaseItems.Values | ConvertTo-Json -Depth 12))
}
function Import-Item { [CmdletBinding()]param($Root) throw 'Restore must never be automatic' }
try {
    if ($fixture.script) { $output=& ([ScriptBlock]::Create([string]$fixture.script)) }
    else { $output=& (Join-Path $PSScriptRoot '../../scripts/execute-target.ps1') }
    if ($fixture.repeat) { $output=& (Join-Path $PSScriptRoot '../../scripts/execute-target.ps1') }
    $parsed=$output | ConvertFrom-Json
    $receiptFile=@($parsed.files | Where-Object name -eq 'receipt.json')
    $receipt=$null
    if ($receiptFile.Count) { $receipt=Get-Content -LiteralPath ([IO.Path]::Combine($fixture.dataRoot,$receiptFile[0].path)) -Raw | ConvertFrom-Json }
    @{output=$parsed;receipt=$receipt;writes=$global:writes;exports=$global:exports} | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath $OutputPath
} catch { @{error=$_.Exception.ToString();writes=$global:writes;exports=$global:exports} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath }

