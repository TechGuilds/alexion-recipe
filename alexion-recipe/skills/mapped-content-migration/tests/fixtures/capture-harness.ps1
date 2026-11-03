# Synthetic Sitecore/SPE doubles. This harness must never run on a Sitecore host.
param([string]$CaptureScript, [string]$EnvelopePath, [string]$SourcePath, [string]$DataRoot)
$ErrorActionPreference = 'Stop'
Add-Type @'
namespace Sitecore.Configuration {
  public static class Settings { public static string DataFolder; }
  public static class Factory { public static object Database; public static object GetDatabase(string name) { return Database; } }
}
namespace Sitecore { public static class MainUtil { public static string MapPath(string path) { return path; } } }
namespace Sitecore.Data {
  public class ID { public string Value; public static ID Parse(string value) { return new ID { Value = value }; } public override string ToString() { return Value; } }
  public class TestFields {
    public System.Collections.Generic.Dictionary<string,object> Values = new System.Collections.Generic.Dictionary<string,object>(System.StringComparer.OrdinalIgnoreCase);
    public object this[ID id] { get { object value; return Values.TryGetValue(id.ToString(), out value) ? value : null; } }
  }
}
'@
[Sitecore.Configuration.Settings]::DataFolder = $DataRoot
$source = Get-Content -LiteralPath $SourcePath -Raw | ConvertFrom-Json
$envelope = Get-Content -LiteralPath $EnvelopePath -Raw | ConvertFrom-Json
$Request = $envelope.parameters.Request
$devices = [pscustomobject]@{ Values=@($source.renderingInstances | ForEach-Object { [pscustomobject]@{ID=$_.deviceId} }) }
$devices | Add-Member -MemberType ScriptMethod -Name GetAll -Value { return $this.Values }
[Sitecore.Configuration.Factory]::Database = [pscustomobject]@{Resources=[pscustomobject]@{Devices=$devices}}
function Get-Item {
    param([string]$Path, [string]$Language, [string]$Version)
    $reference = $Path.Substring($Path.IndexOf(':') + 1)
    $item = @($source.items | Where-Object { $_.path -ieq $reference -or $_.id -ieq $reference })
    if ($item.Count) {
        $row = $item[0]
        if (-not ($row.versions | Where-Object { $_.language -eq $Language -and $_.version -eq [int]$Version })) { return $null }
        $fields = [Sitecore.Data.TestFields]::new()
        foreach ($f in $row.fields) {
            if ($f.storage -ne 'shared' -and $f.language -ne $Language) { continue }
            if ($f.storage -eq 'versioned' -and $f.version -ne [int]$Version) { continue }
            $fields.Values[$f.fieldId.ToUpperInvariant()] = [pscustomobject]@{Value=$f.value;Type=$f.fieldType;Shared=($f.storage -eq 'shared');Unversioned=($f.storage -eq 'unversioned')}
        }
        return [pscustomobject]@{ID=$row.id;ParentID=$row.parentId;TemplateID=$row.templateId;Name=$row.name;Paths=[pscustomobject]@{FullPath=$row.path};Language=$Language;Version=$Version;Versions=@(1);Fields=$fields}
    }
    $rendering = @($source.renderingInstances | Where-Object { $_.renderingId -ieq $reference })
    if ($rendering.Count) { return [pscustomobject]@{Fields=@{'Parameters Template'=[pscustomobject]@{Value=$rendering[0].parameterTemplateId}}} }
    $parameter = @($source.renderingInstances.parameters | Where-Object { $_.fieldId -ieq $reference })
    if ($parameter.Count) { return [pscustomobject]@{Name=$reference.ToUpperInvariant();Fields=@{'Type'=[pscustomobject]@{Value=$parameter[0].fieldType}}} }
    return $null
}
function Get-Rendering {
    param($Item, $Device, [switch]$FinalLayout)
    foreach ($row in $source.renderingInstances) {
        if ($row.pageId -ine $Item.ID -or $row.deviceId -ine $Device.ID) { continue }
        $parameters = ($row.parameters | ForEach-Object { [uri]::EscapeDataString($_.fieldId.ToUpperInvariant()) + '=' + [uri]::EscapeDataString($_.value) }) -join '&'
        [pscustomobject]@{UniqueId=$row.instanceId;ItemID=$row.renderingId;Datasource=$row.datasourceId;Parameters=$parameters}
    }
}
function Set-Item { throw 'Unexpected content mutation' }
function New-Item { throw 'Unexpected content mutation' }
function Remove-Item { throw 'Unexpected content mutation' }
. $CaptureScript
