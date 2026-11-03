# Execute with pwsh. This tests the real traversal against deterministic SPE doubles.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('kajoo-dependencies-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtureRoot)
Add-Type @'
namespace Sitecore.Configuration { public static class Settings { public static string DataFolder; }
public static class Factory { public static FixtureDatabase GetDatabase(string name) { return new FixtureDatabase(); } } }
namespace Sitecore { public static class MainUtil { public static string MapPath(string path) { return path; } } }
public class FixtureDatabase { public FixtureResources Resources = new FixtureResources(); }
public class FixtureResources { public FixtureDevices Devices = new FixtureDevices(); }
public class FixtureDevices { public FixtureDevice[] GetAll() { return new[]{new FixtureDevice(),new FixtureDevice { ID="{22222222-2222-2222-2222-222222222222}" }}; } }
public class FixtureDevice { public string ID="{11111111-1111-1111-1111-111111111111}"; }
public class FixtureField { public string ID; public string Name; public string Value; public string Type; }
public class FixtureFields : System.Collections.Generic.List<FixtureField> {
 public bool DenyRead;
 public FixtureField this[string name] { get { return Find(f=>f.Name==name); } }
 public void ReadAll() { if (DenyRead) throw new System.InvalidOperationException("fixture field read denied"); }
}
'@
[Sitecore.Configuration.Settings]::DataFolder = $fixtureRoot
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Id($n) { '{00000000-0000-0000-0000-' + ([int]$n).ToString('D12') + '}' }
$script:items = @{}
$script:deny = $null
$script:extraVersionItem = $null
$script:extraLanguageItems = @()
$script:hiddenRequestedLanguageIds = @{}
$script:providerSelected = $false
function New-Record($n,$path,$templateName,$templateId,$values) {
 $fields=[FixtureFields]::new()
 foreach ($name in $values.Keys) { $fields.Add([FixtureField]@{ID=(Id ($n+1000));Name=$name;Value=$values[$name];Type='Single-Line Text'}) }
 $axes=[pscustomobject]@{RootPath=$path}
 $axes | Add-Member -MemberType ScriptMethod -Name GetDescendants -Value {
  $prefix=[string]$this.RootPath + '/'
  @($script:items.Values | Where-Object { $_.Paths.FullPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) })
 }
 $item=[pscustomobject]@{ID=(Id $n);Name=($path -split '/')[-1];Paths=[pscustomobject]@{FullPath=$path};TemplateName=$templateName;TemplateID=$templateId;Language='en';Version=1;Fields=$fields;Children=@();Parent=$null;Axes=$axes}
 $script:items[$item.ID]=$item
 return $item
}
$meta=New-Record 99 '/sitecore/templates/System/Templates/Template' 'Template' (Id 99) @{}
$page=New-Record 1 '/sitecore/content/Demo/Home' 'Page' (Id 10) @{'__Originator'=(Id 31);'__Renderings'=('<r><d id="{11111111-1111-1111-1111-111111111111}" l="' + (Id 70) + '" /><d id="{22222222-2222-2222-2222-222222222222}" l="' + (Id 71) + '" /></r>')}
$page.Fields.Add([FixtureField]@{ID=(Id 1002);Name='Empty Reference';Value='{00000000-0000-0000-0000-000000000000}';Type='Droplink'})
$page.Fields.Add([FixtureField]@{ID=(Id 1001);Name='__Editors';Value=(Id 98);Type='Multilist'})
$page.Fields.Add([FixtureField]@{ID=(Id 1003);Name='__Ribbon';Value=(Id 9901);Type='Droplink'})
$page.Fields.Add([FixtureField]@{ID=(Id 1004);Name='Page Editor Buttons';Value=(Id 9902);Type='Multilist'})
$page.Fields.Add([FixtureField]@{ID=(Id 1005);Name='Property Editor';Value=(Id 9903);Type='Treelist'})
$template=New-Record 10 '/sitecore/templates/Project/Demo/Page' 'Template' (Id 99) @{'__Base template'=(Id 11)}
$base=New-Record 11 '/sitecore/templates/Foundation/Common/Base' 'Template' (Id 99) @{'__Base template'=(Id 10)}
$section=New-Record 12 '/sitecore/templates/Project/Demo/Page/Content' 'Template section' (Id 99) @{}
$field=New-Record 13 '/sitecore/templates/Project/Demo/Page/Content/Title' 'Template field' (Id 99) @{Type='Single-Line Text';Source='';Shared='0';Unversioned='0'}
$standard=New-Record 14 '/sitecore/templates/Project/Demo/Page/__Standard Values' 'Page' (Id 10) @{Title='Default title';'Page Design'=(Id 60)}
$template.Children=@($section,$standard); $section.Children=@($field)
$rendering=New-Record 20 '/sitecore/layout/Renderings/Feature/Demo/Hero' 'Json Rendering' (Id 99) @{'Datasource Template'=(Id 40);'Parameters Template'=(Id 41);'Datasource Location'='query:./ancestor-or-self::*';'Rendering Contents Resolver'=(Id 50);'Component Name'='Hero'}
$branch=New-Record 30 '/sitecore/templates/Branches/Project/Demo/Landing' 'Branch' (Id 99) @{}
$scaffold=New-Record 31 '/sitecore/templates/Branches/Project/Demo/Landing/$name' 'Page' (Id 42) @{}
$branch.Children=@($scaffold);$scaffold.Parent=$branch
$ds=New-Record 2 '/sitecore/content/Shared/Hero' 'Hero Data' (Id 40) @{Title='Shared content'}
$dataTemplate=New-Record 40 '/sitecore/templates/Feature/Demo/Hero' 'Template' (Id 99) @{}
$paramsTemplate=New-Record 41 '/sitecore/templates/Feature/Demo/Params' 'Template' (Id 99) @{}
$scaffoldTemplate=New-Record 42 '/sitecore/templates/Project/Demo/Landing' 'Template' (Id 99) @{}
$resolver=New-Record 50 '/sitecore/system/Settings/Services/Rendering Contents Resolvers/Demo/Hero' 'Rendering Contents Resolver' (Id 99) @{Type='Demo.Resolver, Demo';'Item Selector Query'='query:./*'}
$design=New-Record 60 '/sitecore/content/Demo/Presentation/Page Designs/Default' 'Page Design' (Id 99) @{PartialDesigns=(Id 61)}
$partial=New-Record 61 '/sitecore/content/Demo/Presentation/Partial Designs/Header' 'Partial Design' (Id 99) @{'Base Partial Design'=(Id 62)}
$basePartial=New-Record 62 '/sitecore/content/Demo/Presentation/Partial Designs/Base' 'Partial Design' (Id 99) @{'Base Partial Design'=(Id 61)}
$layout=New-Record 70 '/sitecore/layout/Layouts/Project/Demo/Main' 'Layout' (Id 99) @{Path='/layouts/main.cshtml'}
$otherLayout=New-Record 71 '/sitecore/layout/Layouts/Project/Demo/Other' 'Layout' (Id 99) @{Path='/layouts/other.cshtml'}
$placeholder=New-Record 80 '/sitecore/layout/Placeholder Settings/Project/Demo/main' 'Placeholder' (Id 99) @{'Placeholder Key'='main';'Allowed Controls'=(Id 20)}
$duplicate=New-Record 81 '/sitecore/layout/Placeholder Settings/Project/Demo/main' 'Placeholder' (Id 99) @{'Placeholder Key'='main'}
$phRoot=New-Record 82 '/sitecore/layout/Placeholder Settings/Project/Demo' 'Folder' (Id 99) @{}
$phRoot.Children=@($placeholder,$duplicate)
# A used resolver's verified parent catalog also contains an unused definition.
$resolverFolder=New-Record 51 '/sitecore/system/Settings/Services/Rendering Contents Resolvers/Demo' 'Folder' (Id 99) @{}
$unusedResolver=New-Record 52 '/sitecore/system/Settings/Services/Rendering Contents Resolvers/Demo/Unused' 'Rendering Contents Resolver' (Id 99) @{Type='Demo.Unused, Demo'}
$resolverFolder.Children=@($resolver,$unusedResolver);$resolver.Parent=$resolverFolder;$unusedResolver.Parent=$resolverFolder
$moduleTemplates=New-Record 90 '/sitecore/templates/Feature/Demo' 'Template Folder' (Id 99) @{}
$unusedTemplate=New-Record 91 '/sitecore/templates/Feature/Demo/Unused' 'Template' (Id 99) @{}
$moduleTemplates.Children=@($dataTemplate,$paramsTemplate,$unusedTemplate)
$projectTemplates=New-Record 92 '/sitecore/templates/Project/Demo' 'Template Folder' (Id 99) @{}
$projectTemplates.Children=@($template,$scaffoldTemplate)
$foundationTemplates=New-Record 93 '/sitecore/templates/Foundation/Common' 'Template Folder' (Id 99) @{}
$foundationTemplates.Children=@($base)
$moduleSettings=New-Record 94 '/sitecore/system/Settings/Feature/Demo' 'Module' (Id 99) @{}
$siteSetup=New-Record 95 '/sitecore/system/Settings/Feature/Demo/Site Setup' 'HeadlessSiteSetupRoot' (Id 99) @{}
$addItem=New-Record 96 '/sitecore/system/Settings/Feature/Demo/Site Setup/Available Renderings' 'AddItem' (Id 99) @{Item=(Id 20)}
$moduleSettings.Children=@($siteSetup);$siteSetup.Children=@($addItem)
function Set-Location { param($Path) Assert ($Path -eq 'master:\sitecore') 'wrong database provider'; $script:providerSelected=$true }
function Get-Item { param($Path,$ID,$Language,$Version,$ErrorAction)
 Assert $script:providerSelected 'Sitecore provider not selected before reads'
 if ($Path -like '*ThrowsMissing') { throw [System.Management.Automation.ErrorRecord]::new([System.Management.Automation.ItemNotFoundException]::new('fixture missing'), 'PathNotFound', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $Path) }
 if ($script:deny -and $ID -eq $script:deny) { throw 'fixture access denied' }
 if ($ID) {
  if ($script:items.ContainsKey([string]$ID)) {
   if ($Language) { $script:items[[string]$ID] | Where-Object { $_.Language -eq $Language -and -not $script:hiddenRequestedLanguageIds.ContainsKey([string]$_.ID) } }
   else { $script:items[[string]$ID] }
  }
  if ($script:extraVersionItem -and $script:extraVersionItem.ID -eq $ID) {
   if ($Language) { $script:extraVersionItem | Where-Object { $_.Language -eq $Language -and -not $script:hiddenRequestedLanguageIds.ContainsKey([string]$_.ID) } }
   else { $script:extraVersionItem }
  }
  $script:extraLanguageItems | Where-Object { $_.ID -eq $ID -and (-not $Language -or ($_.Language -eq $Language -and -not $script:hiddenRequestedLanguageIds.ContainsKey([string]$_.ID))) }
  return
 }
 $script:items.Values | Where-Object { $_.Paths.FullPath -eq ($Path -replace '^master:', '') -and (-not $Language -or ($_.Language -eq $Language -and -not $script:hiddenRequestedLanguageIds.ContainsKey([string]$_.ID))) }
 if ($script:extraVersionItem -and $script:extraVersionItem.Paths.FullPath -eq ($Path -replace '^master:', '')) {
  if ($Language) { $script:extraVersionItem | Where-Object { $_.Language -eq $Language -and -not $script:hiddenRequestedLanguageIds.ContainsKey([string]$_.ID) } }
  else { $script:extraVersionItem }
 }
 $script:extraLanguageItems | Where-Object { $_.Paths.FullPath -eq ($Path -replace '^master:', '') -and (-not $Language -or ($_.Language -eq $Language -and -not $script:hiddenRequestedLanguageIds.ContainsKey([string]$_.ID))) }
}
function Initialize-Item { process { $_ } }
function Get-Rendering { param($Item,$Device,[switch]$FinalLayout,$ErrorAction)
 if ($Item.ID -eq (Id 1)) { [pscustomobject]@{ItemID=(Id 20);UniqueID=(Id 100);Placeholder='main';Datasource=(Id 2);Parameters='style=hero'} }
}
function Run-Dependencies($parameters) {
 & {
  foreach ($key in $parameters.Keys) { Set-Variable -Name $key -Value $parameters[$key] }
  . (Join-Path $root 'scripts/remote-common.ps1')
  try { . (Join-Path $root 'scripts/analysis/inspect-dependencies.ps1') }
  finally { foreach ($writer in $script:kajooWriters.Values) { $writer.Dispose() } }
 } | ConvertFrom-Json
}
function Rows($manifest,$name) {
 $file=@($manifest.files | Where-Object name -eq $name)[0]
 Assert ($null -ne $file) "Missing $name"
 $path=Join-Path $fixtureRoot $file.path
 Assert ([IO.File]::ReadAllBytes($path).Length -eq $file.size) 'manifest size mismatch'
 @([IO.File]::ReadAllLines($path) | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}
try {
 $p=@{Database='master';Languages=@('en');Version='latest';Devices=@('{11111111-1111-1111-1111-111111111111}');MaxItems=200;Seeds=@(
  @{reference=$page.Paths.FullPath;kind='content';recursive=$false},
  @{reference=$phRoot.Paths.FullPath;kind='placeholder';recursive=$true},
  @{reference='/sitecore/content/Demo/Optional Missing';kind='sxa';recursive=$false;optional=$true}
 )}
 $manifest=Run-Dependencies $p
 $nodes=@(Rows $manifest 'dependency-items.jsonl'); $edges=@(Rows $manifest 'dependency-edges.jsonl')
 foreach ($n in @(1,2,10,11,12,13,14,20,30,31,40,41,42,50,60,61,62,70,80,81,82,99)) { Assert ((Id $n) -in $nodes.id) "Missing dependency $n" }
 foreach ($n in @(51,52,90,91,92,93,94,95,96)) { Assert ((Id $n) -in $nodes.id) "Missing catalog/module dependency $n" }
 Assert ($nodes.Count -eq @($nodes.id | Sort-Object -Unique).Count) 'cycle or multiple consumers duplicated node snapshots'
 Assert (($nodes | Where-Object id -eq (Id 14)).fields.Title -eq 'Default title') 'standard values omitted'
 Assert (($nodes | Where-Object id -eq (Id 13)).fields.Type -eq 'Single-Line Text') 'field definition omitted'
 Assert (($nodes | Where-Object id -eq (Id 50)).fields.Type -eq 'Demo.Resolver, Demo') 'resolver configuration lost'
 Assert (@($edges | Where-Object { $_.relation -eq 'datasource' -and $_.targetId -eq (Id 2) -and $_.consumer.id -eq (Id 1) }).Count -gt 0) 'external datasource lost its consumer'
 Assert (@($edges | Where-Object { $_.status -eq 'dynamic' -and $_.raw -like 'query:*' }).Count -gt 0) 'dynamic datasource was guessed or discarded'
 Assert (@($edges | Where-Object { $_.relation -eq 'base-template' -and $_.targetId -eq (Id 10) }).Count -gt 0) 'template cycle edge lost'
 Assert (@($edges | Where-Object { $_.relation -eq 'base-partial-design' -and $_.targetId -eq (Id 61) }).Count -gt 0) 'SXA cycle edge lost'
 Assert (@($nodes | Where-Object path -eq $placeholder.Paths.FullPath).Count -eq 2) 'duplicate same-path IDs collapsed during traversal'
 Assert (@($nodes | Where-Object id -eq (Id 71)).Count -eq 0) 'unrequested device layout entered closure'
 Assert (@($edges | Where-Object { $_.relation -eq 'layout' -and $_.targetId -eq (Id 70) -and $_.deviceId -eq '11111111-1111-1111-1111-111111111111' }).Count -eq 1) 'requested layout lost device provenance'
 Assert (@($edges | Where-Object { $_.relation -eq 'rendering' -and $_.occurrenceUid -eq (Id 100) -and $_.occurrenceIndex -eq 0 -and $_.deviceId -eq '11111111-1111-1111-1111-111111111111' }).Count -gt 0) 'rendering occurrence provenance lost'
 Assert (@($edges | Where-Object { $_.relation -eq 'field-reference:__Editors' }).Count -eq 0) '__Editors metadata was treated as a content dependency'
 Assert (@($edges | Where-Object { $_.relation -in @('field-reference:__Ribbon','field-reference:Page Editor Buttons','field-reference:Property Editor') }).Count -eq 0) 'Sitecore editor metadata was treated as a migration content dependency'
 Assert (@($edges | Where-Object { $_.relation -eq 'field-reference:Empty Reference' -and $_.status -eq 'empty' -and $_.raw -eq '{00000000-0000-0000-0000-000000000000}' }).Count -eq 1) 'all-zero GUID was not retained as an empty reference'
 Assert (@($nodes | Where-Object id -eq '{00000000-0000-0000-0000-000000000000}').Count -eq 0) 'all-zero GUID was incorrectly queued as an item'
 Assert (-not $manifest.summary.partial) 'cycles and optional verified absence should not be failed collection'
 Assert (@($edges | Where-Object { $_.status -eq 'missing' -and $_.required -eq $false -and $_.raw -eq '/sitecore/content/Demo/Optional Missing' }).Count -eq 1) 'optional absence not recorded'
 $p.Seeds += @{reference='/sitecore/content/Demo/ThrowsMissing';kind='sxa';optional=$true}
 $optional=Run-Dependencies $p
 Assert (-not $optional.summary.partial) 'SPE ObjectNotFound for an optional probe became a failed collection'
 $p.Seeds[-1].optional=$false
 $required=Run-Dependencies $p
 Assert ($required.summary.partial) 'required missing reference was silently optional'
 $p.Seeds=$p.Seeds[0..2]
 $script:deny=Id 50
 $failed=Run-Dependencies $p
 Assert ($failed.summary.partial) 'unreadable required resolver was treated as complete'
 Assert (@(Rows $failed 'dependency-edges.jsonl' | Where-Object { $_.status -eq 'failed' -and $_.raw -eq (Id 50) }).Count -gt 0) 'failed dependency lacks evidence'
 $failure=Rows $failed 'dependency-edges.jsonl' | Where-Object { $_.status -eq 'failed' -and $_.raw -eq (Id 50) } | Select-Object -First 1
 Assert ($failure.message -match 'fixture access denied' -and $failure.errorType -and $failure.failureKind) 'failed dependency lacks actionable error details'
 $errorRecord=Rows $failed 'errors.jsonl' | Where-Object { $_.scope -like ('*' + (Id 50) + '*') } | Select-Object -First 1
 Assert ($errorRecord.message -match 'fixture access denied') 'error log discarded the underlying failure message'
 $script:deny=$null;$p.MaxItems=3
 $limited=Run-Dependencies $p
 Assert ($limited.summary.partial -and $limited.summary.limited -and $limited.summary.visited -eq 3) 'bounded traversal lost its incomplete state'
 Assert (@(Rows $limited 'dependency-pending.jsonl').Count -gt 0) 'bounded traversal discarded its recovery frontier'
 $p.MaxItems=200;$p.Seeds=@(@{reference=$placeholder.Paths.FullPath;kind='placeholder'})
 $samePath=Run-Dependencies $p
 Assert (-not $samePath.summary.partial) 'same-path IDs made direct lookup partial'
 Assert (@(Rows $samePath 'dependency-items.jsonl' | Where-Object path -eq $placeholder.Paths.FullPath).Count -eq 2) 'direct path lookup dropped same-path IDs'
 $script:extraVersionItem=$page.PSObject.Copy();$script:extraVersionItem.Version=2
 $p.Seeds=@(@{reference=$page.Paths.FullPath;kind='content'});$p.Version='*';$p.MaxItems=1;$p.Languages=@('en','fr')
 $versionLimited=Run-Dependencies $p
 $versionEdges=@(Rows $versionLimited 'dependency-edges.jsonl')
 Assert ($versionLimited.summary.partial -and $versionLimited.summary.limited) 'multi-version limit was not partial'
 Assert (@($versionEdges | Where-Object { $_.status -eq 'resolved' -and $_.targetId -eq (Id 1) -and $_.version -eq '2' }).Count -eq 0) 'uncollected version was marked resolved'
 Assert (@(Rows $versionLimited 'dependency-pending.jsonl' | Where-Object { $_.targetId -eq (Id 1) -and $_.targetVersion -eq '2' -and $_.language -eq 'en' }).Count -eq 1) 'multi-version limit lost exact pending scope'
 Assert (@(Rows $versionLimited 'dependency-pending.jsonl' | Where-Object { $_.reference -eq $page.Paths.FullPath -and $_.language -eq 'fr' }).Count -eq 1) 'limit lost remaining language scope'
 Assert (@(Rows $versionLimited 'dependency-pending.jsonl' | Where-Object { $_.consumer.language -eq 'en' -and $_.language -eq 'fr' }).Count -eq 0) 'pending consumer reference crossed language scope'
 $script:extraVersionItem=$null;$p.MaxItems=200;$p.Version='2';$p.Languages=@('en')
 $wrongVersion=Run-Dependencies $p
 Assert ($wrongVersion.summary.partial) 'provider version fallback was accepted'
 Assert (@(Rows $wrongVersion 'dependency-edges.jsonl' | Where-Object { $_.status -eq 'failed' -and $_.raw -eq $page.Paths.FullPath }).Count -gt 0) 'version fallback failure lacks edge'
 $p.Version='latest';$p.Seeds=@(@{reference=$page.Paths.FullPath;kind='content'},@{reference=$page.Paths.FullPath;kind='content'});$page.Fields.DenyRead=$true
 $deniedFields=Run-Dependencies $p
 Assert ($deniedFields.summary.partial) 'field read failure was accepted'
 Assert (@(Rows $deniedFields 'dependency-edges.jsonl' | Where-Object { $_.status -eq 'resolved' -and $_.targetId -eq (Id 1) }).Count -eq 0) 'field read failure left an accepted edge without snapshot'
 $page.Fields.DenyRead=$false
 $p.Seeds=@(@{reference=$meta.Paths.FullPath;kind='template'});$meta.Version=0
 $unversionedMetadata=Run-Dependencies $p
 Assert (-not $unversionedMetadata.summary.partial) 'unversioned metadata was rejected for numeric content scope'
 $meta.Version=1;$page.Version=0;$p.Seeds=@(@{reference=$page.Paths.FullPath;kind='content'});$p.Version='latest'
 $unversionedContent=Run-Dependencies $p
 Assert ($unversionedContent.summary.partial) 'versionless content was accepted as requested content version'
 $page.Version=1
 $frenchTemplate=$template.PSObject.Copy();$frenchTemplate.Language='fr';$script:extraLanguageItems=@($frenchTemplate)
 $p.Languages=@('en','fr');$p.Seeds=@(@{reference=$page.Paths.FullPath;kind='content'})
 $crossLanguage=Run-Dependencies $p
 Assert (@(Rows $crossLanguage 'dependency-edges.jsonl' | Where-Object { $_.status -eq 'resolved' -and $_.consumer.id -eq (Id 1) -and $_.consumer.language -eq 'en' -and $_.targetId -eq (Id 10) -and $_.language -eq 'fr' }).Count -eq 0) 'consumer reference resolved in another language'
 $script:extraLanguageItems=@();$p.Languages=@('en')
 $frenchDataTemplate=$dataTemplate.PSObject.Copy();$frenchDataTemplate.Language='fr'
 $frenchUnusedTemplate=$unusedTemplate.PSObject.Copy();$frenchUnusedTemplate.Language='fr'
 $frenchModuleTemplates=$moduleTemplates.PSObject.Copy();$frenchModuleTemplates.Language='fr';$frenchModuleTemplates.Children=@($frenchDataTemplate,$frenchUnusedTemplate)
 $script:extraLanguageItems=@($frenchDataTemplate,$frenchUnusedTemplate,$frenchModuleTemplates)
 $p.Languages=@('en','fr');$p.Seeds=@(@{reference=$dataTemplate.Paths.FullPath;kind='template'})
 $multilingualCatalog=Run-Dependencies $p
 Assert (@(Rows $multilingualCatalog 'dependency-items.jsonl' | Where-Object { $_.id -eq (Id 91) -and $_.language -eq 'fr' }).Count -eq 1) 'French unused module template was suppressed by catalog deduplication'
 $script:extraLanguageItems=@();$p.Languages=@('en')
 $frenchOnlyReference=$unusedTemplate.PSObject.Copy();$frenchOnlyReference.ID=Id 97;$frenchOnlyReference.Language='fr';$frenchOnlyReference.Paths=[pscustomobject]@{FullPath='/sitecore/content/Demo/French only reference'}
 $script:extraLanguageItems=@($frenchOnlyReference)
 $page.Fields.Add([FixtureField]@{ID=(Id 1006);Name='French only reference';Value=(Id 97);Type='Droplink'})
 $p.Seeds=@(@{reference=$page.Paths.FullPath;kind='content'})
 $outOfScope=Run-Dependencies $p
 $outOfScopeEdges=@(Rows $outOfScope 'dependency-edges.jsonl')
 $outside=$outOfScopeEdges | Where-Object { $_.relation -eq 'field-reference:French only reference' -and $_.status -eq 'available-outside-scope' } | Select-Object -First 1
 Assert ($null -ne $outside -and $outside.available[0].language -eq 'fr' -and $outside.available[0].id -eq (Id 97)) 'out-of-scope existence was confused with a truly missing dependency'
 Assert (-not $outOfScope.summary.partial) 'out-of-scope item presence was reported as a tool/capture failure'
 Assert (@(Rows $outOfScope 'dependency-items.jsonl' | Where-Object id -eq (Id 97)).Count -eq 0) 'out-of-scope item was imported into requested-language snapshots'
 $script:extraLanguageItems=@()
 $versionlessContainer=New-Record 110 '/sitecore/content/Demo/Versionless Container' 'Folder' (Id 99) @{}
 $publishedDescendant=New-Record 111 '/sitecore/content/Demo/Versionless Container/Published Child' 'Page' (Id 10) @{Title='Published'}
 $versionlessContainer.Children=@($publishedDescendant); $publishedDescendant.Parent=$versionlessContainer
 $script:hiddenRequestedLanguageIds[[string]$versionlessContainer.ID]=$true
 $p.Seeds=@(@{reference=$versionlessContainer.Paths.FullPath;kind='content';recursive=$true})
 $bridged=Run-Dependencies $p
 $bridgedNodes=@(Rows $bridged 'dependency-items.jsonl'); $bridgedEdges=@(Rows $bridged 'dependency-edges.jsonl')
 Assert ($bridgedNodes.id -contains $publishedDescendant.ID) 'published descendant beneath an unavailable structural container was not collected'
 Assert (-not ($bridgedNodes.id -contains $versionlessContainer.ID)) 'unavailable structural container was incorrectly captured as content'
 Assert (@($bridgedEdges | Where-Object { $_.status -eq 'available-outside-scope' -and $_.raw -eq $versionlessContainer.Paths.FullPath }).Count -eq 1) 'structural container scope limitation was not retained'
 Assert (-not $bridged.summary.partial) 'published descendants beneath an unavailable structural container made collection partial'
 $script:hiddenRequestedLanguageIds=@{}
 $p.MaxItems=200; $p.Seeds=@(@{reference='query:./*';kind='content'})
 $invalid=$false
 try { Run-Dependencies $p } catch { $invalid=$true }
 Assert $invalid 'dynamic root seed was falsely accepted as collected scope'
 'PASS: dependency closure, reverse consumers, inherited templates, branch scaffolds, datasource/resolver/layout/SXA refs, metadata exclusions, cycles, duplicates and bounded failures'
} finally { [IO.Directory]::Delete($fixtureRoot,$true) }
