# Runs in PowerShell 7 with SPE test doubles, not a Sitecore compatibility test.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path ([IO.Path]::GetTempPath()) ('kajoo-spe-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($data)
Add-Type @'
namespace Sitecore.Configuration { public static class Settings { public static string DataFolder; } }
namespace Sitecore { public static class MainUtil { public static string MapPath(string path) { return path; } } }
namespace Sitecore.Configuration { public static class Factory {
  public static string LastDatabase;
  public static TestDatabase GetDatabase(string name) { LastDatabase = name; return new TestDatabase(); }
} }
public class TestDatabase { public TestResources Resources = new TestResources(); }
public class TestResources { public TestDevices Devices = new TestDevices(); }
public class TestDevices { public TestDevice[] GetAll() { return new[] { new TestDevice() }; } }
public class TestDevice { public string ID = "{FE5D7FDF-64B8-446F-A16C-12CEA264723B}"; public string Name = "Default"; }
public class TestField { public string ID; public string Name; public string Value; public string Type; }
public class TestFields : System.Collections.Generic.List<TestField> {
  public TestField this[string name] { get { return Find(f => f.Name == name); } }
}
'@
[Sitecore.Configuration.Settings]::DataFolder = $data
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function New-TestItem($id, $path, $values) {
    $fields = [TestFields]::new()
    foreach ($key in $values.Keys) {
        $fields.Add([TestField]@{ID='field-' + $key; Name=$key; Value=$values[$key]; Type=$(if ($key -eq 'Body') {'Rich Text'} else {'Single-Line Text'})})
    }
    $axes = [pscustomobject]@{ RootPath=$path }
    $axes | Add-Member -MemberType ScriptMethod -Name GetDescendants -Value {
        $script:axesCalls++
        $prefix = [string]$this.RootPath + '/'
        @($script:items | Where-Object { $_.Paths.FullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
    }
    [pscustomobject]@{ ID=$id; Name=($path -split '/')[-1]; Paths=[pscustomobject]@{FullPath=$path}; TemplateID='template-1'; TemplateName='Page'; Language='en'; Version=1; Versions=[pscustomobject]@{Count=1}; Fields=$fields; Axes=$axes }
}
$axisOnly = New-TestItem 'axis-only' '/sitecore/content/Demo/Versionless Container' @{}
$axisOnly.Versions = [pscustomobject]@{Count=0}
$script:items = @(
    (New-TestItem 'root' '/sitecore/content/Demo' @{Body='<p>你好 &amp; café</p>'; '__Renderings'='<r />'; '__Final Renderings'='<r />'; 'Page Design'='{DESIGN-1}'}),
    (New-TestItem 'child' '/sitecore/content/Demo/Child' @{Body='<a href="~/link.aspx?_id=ABC">Link</a>'; '__Renderings'='<r />'}),
    $axisOnly,
    (New-TestItem 'rendering-1' '/sitecore/layout/Renderings/Feature/Hero' @{'Controller'='Feature.HeroController'; 'Controller Action'='Index'; 'Component Name'='Hero'; 'Datasource Template'='/sitecore/templates/Feature/Hero'; 'Rendering Contents Resolver'='resolver-1'}),
    (New-TestItem 'dict' '/sitecore/content/Dictionary/Hello' @{Key='hello'; Phrase='Bonjour'}),
    (New-TestItem 'dict-duplicate' '/sitecore/content/Dictionary/Hello2' @{Key='hello'; Phrase='Salut'})
)
function Get-Item { param($Path,$ID,$Language,$Version,$ErrorAction)
    if ($Path -match '/Broken$') { throw 'fixture access denied' }
    $matches = @($script:items | Where-Object { (($ID -and $_.ID -eq $ID) -or (-not $ID -and $_.Paths.FullPath -eq ($Path -replace '^(master|web):', ''))) -and (-not $Language -or $_.Language -eq $Language) })
    if ($Version -eq '*') { return $matches }
    if ($Version -match '^[1-9][0-9]*$') { return @($matches | Where-Object { [string]$_.Version -eq [string]$Version }) }
    @($matches | Group-Object ID, Language | ForEach-Object { $_.Group | Sort-Object Version -Descending | Select-Object -First 1 })
}
function Initialize-Item { process { $_ } }
function Get-ChildItem { param($Path,$Language,$Version,$ErrorAction)
    $parent = ($Path -replace '^master:', '').TrimEnd('/')
    @($script:items | Where-Object { ($_.Paths.FullPath.Substring(0,$_.Paths.FullPath.LastIndexOf('/'))) -eq $parent })
}
function Get-LayoutDevice { [CmdletBinding()] param([switch]$Default,[string]$Name) throw 'Use the explicit database device collection' }
function Get-Rendering { param($Item,[switch]$FinalLayout,$Device,$ErrorAction)
    @(
      [pscustomobject]@{UniqueID='uid-1';ItemID='rendering-1';Placeholder='main';Datasource='ds-1';Parameters='a=1'},
      [pscustomobject]@{UniqueID='uid-2';ItemID='rendering-1';Placeholder='main';Datasource='ds-2';Parameters='a=2'}
    )
}
function Run-Export($scriptName, $parameters) {
    & {
        foreach ($key in $parameters.Keys) { Set-Variable -Name $key -Value $parameters[$key] }
        . (Join-Path $root 'scripts/remote-common.ps1')
        try { . (Join-Path $root ('scripts/' + $scriptName)) }
        finally { foreach ($writer in $script:kajooWriters.Values) { $writer.Dispose() } }
    } | ConvertFrom-Json
}
function Read-Export($manifest, $name) {
    $entry = @($manifest.files | Where-Object name -eq $name)[0]
    Assert ($null -ne $entry) "Missing export $name"
    $path = Join-Path $data $entry.path
    Assert ([IO.File]::ReadAllBytes($path).Length -eq $entry.size) 'manifest byte size mismatch'
    @([IO.File]::ReadAllLines($path) | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}
try {
    $script:axesCalls = 0
    $discovery = Run-Export 'analysis/discover-site.ps1' @{SitePath='/sitecore/content/Demo';Languages=@('en')}
    Assert ($discovery.kind -eq 'kajoo-export' -and $discovery.version -eq 1) 'export contract'
    $rows = @(Read-Export $discovery 'items.jsonl')
    Assert ($rows.Count -eq 2 -and $rows[0].id -eq 'root') 'root-inclusive deterministic discovery'
    Assert ($script:axesCalls -eq 1) 'latest-version recursive discovery did not use one descendant traversal'
    Assert ($discovery.summary.partial -eq $false) 'complete discovery unexpectedly partial'
    $limited = Run-Export 'analysis/discover-site.ps1' @{SitePath='/sitecore/content/Demo';MaxItems=1}
    Assert ($limited.summary.partial -eq $true) 'limit must mark partial'
    $languageGap = Run-Export 'analysis/discover-site.ps1' @{SitePath='/sitecore/content/Demo';Languages=@('en','fr')}
    Assert ($languageGap.summary.partial -eq $true -and $languageGap.summary.visited -eq 2) 'wrong-language fallback must remain partial'
    $rejectedLimit = $false
    try { Run-Export 'analysis/discover-site.ps1' @{SitePath='/sitecore/content/Demo';MaxItems=0} } catch { $rejectedLimit = $true }
    Assert $rejectedLimit 'zero limit was silently defaulted'
    $renderings = Run-Export 'analysis/inspect-renderings.ps1' @{ItemPaths=@('/sitecore/layout/Renderings/Feature/Hero','/sitecore/layout/Renderings/Broken')}
    $rows = @(Read-Export $renderings 'renderings.jsonl')
    Assert ($rows[0].fields.Controller -eq 'Feature.HeroController') 'controller identity lost'
    Assert ($renderings.summary.partial -eq $true) 'access failure swallowed'
    $presentation = Run-Export 'analysis/inspect-presentation.ps1' @{ItemPaths=@('/sitecore/content/Demo');Devices=@('fe5d7fdf-64b8-446f-a16c-12cea264723b')}
    $rows = @(Read-Export $presentation 'presentation.jsonl')
    Assert ($rows[0].final.Count -eq 2 -and $rows[0].final[1].uid -eq 'uid-2') 'repeated rendering occurrence lost'
    Assert ($rows[0].sharedXml -eq '<r />') 'raw shared presentation lost'
    Assert ($rows[0].sxa.pageDesign -eq '{DESIGN-1}' -and -not $rows[0].sxa.expanded) 'direct design reference lost or falsely expanded'
    Assert (-not $presentation.summary.partial) 'SXA reference is a finding, not failed presentation extraction'
    Assert ([Sitecore.Configuration.Factory]::LastDatabase -eq 'master') 'device lookup used an implicit database'
    $webPresentation = Run-Export 'analysis/inspect-presentation.ps1' @{ItemPaths=@('/sitecore/content/Demo');Devices=@('fe5d7fdf-64b8-446f-a16c-12cea264723b');Database='web'}
    Assert (-not $webPresentation.summary.partial -and [Sitecore.Configuration.Factory]::LastDatabase -eq 'web') 'explicit web database was ignored'
    $missingDevice = Run-Export 'analysis/inspect-presentation.ps1' @{ItemPaths=@('/sitecore/content/Demo');Devices=@('00000000-0000-0000-0000-000000000000')}
    Assert ($missingDevice.summary.partial -and @(Read-Export $missingDevice 'presentation.jsonl').Count -eq 0) 'missing device was accepted'
    $richtext = Run-Export 'capture/export-richtext.ps1' @{SitePath='/sitecore/content/Demo'}
    $rows = @(Read-Export $richtext 'richtext.jsonl')
    Assert ($rows.Count -eq 2 -and $rows[0].html -eq '<p>你好 &amp; café</p>') 'HTML/Unicode fidelity'
    $script:items[4].Version = 2
    $dictionary = Run-Export 'capture/export-dictionary.ps1' @{DictionaryRoots=@('/sitecore/content/Dictionary/Hello','/sitecore/content/Dictionary/Hello2');Domain='demo'}
    $rows = @(Read-Export $dictionary 'dictionary.jsonl')
    Assert ($rows.Count -eq 2 -and $rows[1].duplicate -eq $true) 'dictionary duplicate hidden'
    Assert ($dictionary.summary.partial -eq $true) 'duplicate ambiguity must remain unresolved'
    $historical = New-TestItem 'dict' '/sitecore/content/Dictionary/Hello' @{Key='hello'; Phrase='Earlier phrase'}
    $historical.Version = 3
    $script:items += $historical
    $versions = Run-Export 'capture/export-dictionary.ps1' @{DictionaryRoots=@('/sitecore/content/Dictionary/Hello');Domain='demo';Version='*'}
    $rows = @(Read-Export $versions 'dictionary.jsonl')
    Assert ($rows.Count -eq 2 -and -not $versions.summary.partial -and -not ($rows | Where-Object duplicate)) 'historical versions of one item were classified as competing keys'
    $rejected = $false
    try { Run-Export 'analysis/discover-site.ps1' @{SitePath='/sitecore/content/../system'} } catch { $rejected = $true }
    Assert $rejected 'unsafe scope was accepted'
    # Real source item names include punctuation; structured parameters are data,
    # not PowerShell source. These must not abort an otherwise valid page batch.
    $punctuatedPath = "/sitecore/content/Demo/What's next, research & development!"
    $script:items += New-TestItem 'punctuated' $punctuatedPath @{'__Renderings'='<r />'}
    $punctuated = Run-Export 'analysis/inspect-presentation.ps1' @{ItemPaths=@('/sitecore/content/Demo/Child', $punctuatedPath);Devices=@('fe5d7fdf-64b8-446f-a16c-12cea264723b')}
    Assert (-not $punctuated.summary.partial -and @(Read-Export $punctuated 'presentation.jsonl').Count -eq 2) 'valid punctuation aborted presentation batch'
    foreach ($unsafe in @('/sitecore/content/Demo/*','/sitecore/content/Demo/[ab]','/sitecore/content/Demo/../Other','/sitecore/content/Demo//Other','master:/sitecore/content/Demo',"/sitecore/content/Demo/Bad`nName")) {
        $rejected = $false
        try { Run-Export 'analysis/discover-site.ps1' @{SitePath=$unsafe} } catch { $rejected = $true }
        Assert $rejected "unsafe scope was accepted: $unsafe"
    }
    'PASS: remote fixtures, manifests, bounded discovery, occurrence fidelity, Unicode, duplicates and scope rejection'
} finally {
    [IO.Directory]::Delete($data, $true)
}
