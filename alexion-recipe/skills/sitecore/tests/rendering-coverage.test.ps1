# Run with pwsh. SPE/LinkManager doubles exercise the producer, not real server compatibility.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('kajoo-coverage-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtureRoot)
Add-Type @'
namespace Sitecore.Configuration {
 public static class Settings { public static string DataFolder; }
 public static class Factory { public static FixtureDatabase GetDatabase(string name) { return new FixtureDatabase(); } }
}
namespace Sitecore { public static class MainUtil { public static string MapPath(string path) { return path; } } }
public class FixtureDatabase { public FixtureResources Resources = new FixtureResources(); }
public class FixtureResources { public FixtureDevices Devices = new FixtureDevices(); }
public class FixtureDevices { public FixtureDevice[] GetAll() { return new[] {new FixtureDevice {ID="{11111111-1111-1111-1111-111111111111}"},new FixtureDevice {ID="{22222222-2222-2222-2222-222222222222}"}}; } }
public class FixtureDevice { public string ID; }
namespace Sitecore.Links {
 public enum LanguageEmbedding { Never }
 public class UrlOptions {
  public static UrlOptions DefaultOptions { get { return new UrlOptions(); } }
  public LanguageEmbedding LanguageEmbedding; public bool AlwaysIncludeServerUrl; public bool SiteResolving;
 }
 public static class LinkManager {
  public static string GetItemUrl(object item, UrlOptions options) {
   return (string)System.Management.Automation.PSObject.AsPSObject(item).Properties["Route"].Value;
  }
 }
}
'@
[Sitecore.Configuration.Settings]::DataFolder = $fixtureRoot
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$script:r1 = '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}'
$script:r2 = '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}'
$script:r3 = '{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}'
$script:d1 = '{11111111-1111-1111-1111-111111111111}'
$script:d2 = '{22222222-2222-2222-2222-222222222222}'
function New-Page($id, $path, $language, $version, $route) {
 [pscustomobject]@{ID=$id; Paths=[pscustomobject]@{FullPath=$path}; Language=$language; Version=$version; Route=$route; Fields=@{}; Name=$id}
}
$script:pages = @(
 (New-Page 'root' '/sitecore/content/Demo' 'en' 1 '/home'),
 (New-Page 'root' '/sitecore/content/Demo' 'fr' 1 '/accueil'),
 (New-Page 'child' '/sitecore/content/Demo/Child' 'en' 1 '/child'),
 (New-Page 'child' '/sitecore/content/Demo/Child' 'fr' 1 '/enfant'),
 (New-Page 'outside' '/sitecore/content/DemoOther' 'en' 1 '/outside')
)
$script:failPage = $null
$script:referrerCalls = 0
$script:presentationCalls = 0
function Get-Item { param($Path,$ID,$Language,$Version,$ErrorAction)
 if ($ID) { return [pscustomobject]@{ ID=$ID; Paths=[pscustomobject]@{FullPath='/sitecore/layout/Renderings/' + $ID} } }
 $script:pages | Where-Object { $_.Paths.FullPath -eq ($Path -replace '^master:', '') -and $_.Language -eq $Language -and ($Version -in @('latest','*') -or [string]$_.Version -eq $Version) }
}
function Get-ChildItem { param($Path,$Language,$ErrorAction)
 $parent = $Path -replace '^master:', ''
 $script:pages | Where-Object { $_.Language -eq $Language -and $_.Paths.FullPath.Substring(0,$_.Paths.FullPath.LastIndexOf('/')) -eq $parent }
}
function Get-ItemReferrer { param($Item)
 $script:referrerCalls++
 # The only link is unrelated content, and the path shares a prefix but not the subtree.
 $script:pages | Where-Object ID -eq 'outside'
}
function Get-Rendering { param($Item,$Device,[switch]$FinalLayout,$ErrorAction)
 $script:presentationCalls++
 if ($Item.ID -eq $script:failPage) { throw 'fixture presentation unavailable' }
 if (-not $FinalLayout) { throw 'coverage must use effective final presentation' }
 if ($Device.ID -eq $script:d2) { return }
 $ids = if ($Item.ID -eq 'root' -and $Item.Language -eq 'en') { @($script:r1,$script:r1) } else { @($script:r2) }
 foreach ($id in $ids) { [pscustomobject]@{ItemID=$id;UniqueID=[guid]::NewGuid().ToString();Placeholder='main';Datasource='';Parameters=''} }
}
function Run-Coverage($parameters) {
 & {
  foreach ($key in $parameters.Keys) { Set-Variable -Name $key -Value $parameters[$key] }
  . (Join-Path $root 'scripts/remote-common.ps1')
  try { . (Join-Path $root 'scripts/analysis/analyze-rendering-coverage.ps1') }
  finally { foreach ($writer in $script:kajooWriters.Values) { $writer.Dispose() } }
 } | ConvertFrom-Json
}
function Read-Rows($manifest) {
 $file = @($manifest.files | Where-Object name -eq 'coverage.jsonl')[0]
 $path = Join-Path $fixtureRoot $file.path
 Assert ([IO.File]::ReadAllBytes($path).Length -eq $file.size) 'manifest size mismatch'
 @([IO.File]::ReadAllLines($path) | ForEach-Object { $_ | ConvertFrom-Json })
}
try {
 $parameters = @{SitePath='/sitecore/content/Demo';RenderingIds=@($script:r1,$script:r2,$script:r3);RenderingNames=@('Hero','Footer','Unused');Languages=@('en');Devices=@($script:d1);Database='master';Version='latest'}
 $manifest = Run-Coverage $parameters
 $rows = Read-Rows $manifest
 $hero = $rows | Where-Object { $_.type -eq 'frequency' -and $_.name -eq 'Hero' }
 $unused = $rows | Where-Object { $_.type -eq 'frequency' -and $_.name -eq 'Unused' }
 Assert ($script:referrerCalls -eq 0) 'coverage must not use link-database referrers as presentation usage'
 Assert ($hero.pageCount -eq 1) 'inherited presentation lost or repeated occurrence counted as multiple pages'
 Assert ($unused.pageCount -eq 0) 'unrelated link became rendering usage'
 Assert (-not $manifest.summary.partial) 'valid presentation export was partial'
 $routes = @($rows | Where-Object type -eq 'coverage')
 Assert ($routes.Count -eq 2 -and '/outside' -notin $routes.route) 'greedy coverage escaped scope or lost a rendering'
 Assert (@($rows | Where-Object type -eq 'uncovered').Count -eq 1) 'unused rendering absent from uncovered set'
 Assert (($rows | Where-Object type -eq 'meta').basis -eq 'SPE resolved final presentation') 'missing coverage provenance'

 $parameters.Languages = @('en','fr')
 $multi = Run-Coverage $parameters
 $routes = @(Read-Rows $multi | Where-Object type -eq 'coverage')
 Assert ($routes.Count -eq 3 -and @($routes | Where-Object language -eq 'fr').Count -eq 1) 'coverage incorrectly merged language scopes'
 Assert (-not $multi.summary.partial) 'complete multilingual export was partial'
 $parameters.Languages = @('en')
 $parameters.Devices = @($script:d1,$script:d2)
 $devices = Run-Coverage $parameters
 Assert (@(Read-Rows $devices | Where-Object { $_.type -eq 'uncovered' -and $_.deviceId -eq $script:d2.Trim('{}') }).Count -eq 3) 'empty device scope was merged with another device'
 $parameters.Devices = @($script:d1)
 $script:pages += New-Page 'root' '/sitecore/content/Demo' 'en' 2 '/home-v2'
 $parameters.Version = '*'
 $versions = Run-Coverage $parameters
 $versionRows = @(Read-Rows $versions | Where-Object type -eq 'coverage')
 Assert ($versionRows.Count -eq 3 -and @($versionRows | Where-Object version -eq '2').Count -eq 1) 'historical version coverage was merged or reread as latest'
 Assert (@(Read-Rows $versions | Where-Object type -eq 'meta').Count -eq 2) 'version scopes were not retained'
 $script:pages = @($script:pages | Where-Object Version -eq 1)
 $parameters.Version = 'latest'
 $script:pages[0].Route = $null
 $missingRoute = Run-Coverage $parameters
 Assert ($missingRoute.summary.partial) 'LinkManager failure was treated as a complete route plan'
 Assert (@(Read-Rows $missingRoute | Where-Object { $_.type -eq 'coverage' -and -not $_.route }).Count -eq 1) 'missing route was guessed from its item path'
 $script:pages[0].Route = '/home'
 $script:failPage = 'child'
 $failed = Run-Coverage $parameters
 Assert ($failed.summary.partial -and $failed.summary.errorCount -gt 0) 'presentation failure was classified as complete absence'
 $script:failPage = $null
 $parameters.MaxItems = 1
 $limited = Run-Coverage $parameters
 Assert ($limited.summary.partial -and $limited.summary.limited) 'bounded scan cannot prove whole-site absence'
 $parameters.MaxItems = 10000
 $parameters.Devices = @('{00000000-0000-0000-0000-000000000000}')
 $rejected = $false
 try { Run-Coverage $parameters } catch { $rejected = $true }
 Assert $rejected 'unknown device accepted'
 'PASS: resolved final usage, inherited/repeated renderings, unrelated links, language/device isolation and partial failures'
} finally {
 [IO.Directory]::Delete($fixtureRoot, $true)
}
