param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$fixture=Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$script:RequestJson=[string]$fixture.requestJson; $script:RequestSha256=[string]$fixture.requestSha256
$global:reads=@(); $global:writes=0; $global:markerReads=0
Add-Type @'
namespace Sitecore { public static class MainUtil { public static string MapPath(string p) { return p; } } }
namespace Sitecore.Configuration { public static class Settings { public static string DataFolder {get;set;} } }
namespace Sitecore.Data {
 public sealed class ID { readonly System.Guid value; private ID(System.Guid g) {value=g;} public static ID Parse(string value) {return new ID(System.Guid.Parse(value));} public override string ToString() {return value.ToString("B").ToUpperInvariant();} }
 public sealed class DoubleFieldCollection {
  readonly System.Collections.Generic.Dictionary<string,object> ids = new System.Collections.Generic.Dictionary<string,object>(System.StringComparer.OrdinalIgnoreCase);
  public void Add(string id, object value) {ids[id]=value;}
  public object this[ID id] {get {object value; return ids.TryGetValue(id.ToString(),out value)?value:null;}}
  public object this[string name] {get {throw new System.Exception("Name field access forbidden");}}
 }
}
'@
[Sitecore.Configuration.Settings]::DataFolder=$fixture.dataRoot
$global:databaseItems=@()
foreach ($row in $fixture.items) {
    $fields=[Sitecore.Data.DoubleFieldCollection]::new()
    foreach ($field in $row.fields) { $fields.Add($field.fieldId,[pscustomobject]@{Value=[string]$field.value;Shared=($field.storage -eq 'shared');Unversioned=($field.storage -eq 'unversioned');Type=$field.fieldType}) }
    $global:databaseItems+=[pscustomobject]@{ID=$row.id;TemplateID=$row.templateId;ParentID=$row.parentId;Paths=[pscustomobject]@{FullPath=$row.path};Language=$row.language;Version=$row.version;Fields=$fields}
}
function Get-Item {
    [CmdletBinding()]param($Path,$Language,$Version)
    $global:reads+=@{path=$Path;language=$Language;version=$Version}
    $value=([string]$Path).Substring(([string]$Path).IndexOf(':')+1)
    if ($value -eq $fixture.markerId) { $global:markerReads++; if ($fixture.markerChanges -and $global:markerReads -gt 1) { return $null } }
    $found=@($global:databaseItems | Where-Object { $_.ID -ieq $value -or $_.Paths.FullPath -ieq $value })
    if ($fixture.readError -eq $value) { throw 'synthetic read failure' }
    if ($Language -eq '*' -and $Version -eq '*') { return $found }
    if ($Language) { $found=@($found | Where-Object Language -ceq $Language) }
    if ($Version) { $found=@($found | Where-Object Version -eq ([int]$Version)) }
    if ($found.Count) { return $found[0] }; return $null
}
function New-Item { $global:writes++; throw 'Content mutation forbidden' }
function Set-Item { $global:writes++; throw 'Content mutation forbidden' }
function Remove-Item { $global:writes++; throw 'Content mutation forbidden' }
function Add-ItemVersion { $global:writes++; throw 'Content mutation forbidden' }
function Publish-Item { $global:writes++; throw 'Content mutation forbidden' }
try {
    $outputs=@()
    $count=if ($fixture.repeat) { 2 } else { 1 }
    for ($i=0;$i -lt $count;$i++) {
        if ($fixture.script) { $outputs+=(& ([ScriptBlock]::Create([string]$fixture.script)) | ConvertFrom-Json) }
        else { $outputs+=(& (Join-Path $PSScriptRoot '../../scripts/capture-target.ps1') | ConvertFrom-Json) }
    }
    $states=@($outputs | ForEach-Object { Get-Content -LiteralPath ([IO.Path]::Combine($fixture.dataRoot,$_.files[0].path)) -Raw | ConvertFrom-Json })
    @{outputs=$outputs;states=$states;reads=$global:reads;writes=$global:writes} | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath $OutputPath
} catch { @{error=$_.Exception.ToString();reads=$global:reads;writes=$global:writes} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath }
