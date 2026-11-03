param([string]$SourcePath)
$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText($SourcePath, [System.Text.Encoding]::UTF8)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors.Message -join '; ') }
$helperNames = @('Get-SitecoreParentPath', 'Get-RenderingFieldValue', 'Get-RenderingDefinitionDetail', 'Register-RenderingDependencies', 'Test-IsRenderingDefinition', 'Initialize-RenderingInventoryRoots', 'Get-TemplateItemSafe', 'Get-RenderingSafe', 'Write-RenderingInstanceEvidence', 'Get-VariantNodeEvidence', 'Get-RenderingVariantEvidence', 'Get-DiscoverySiteForItem', 'Get-DefinitionItemSafe', 'Get-ValidatedRenderingRoot', 'Register-UnresolvedRenderingReference')
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) {
    if ($helperNames -contains $function.Name) { Invoke-Expression $function.Extent.Text }
}
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Output-Line { param($Message, $ForegroundColor) }
function Initialize-Item { process { $_ } }
function Add-TemplateRootPath { param($Path) $templateRootPaths[$Path] = $true }
$itemsByPath = @{}
$itemsById = @{}
function Get-ItemSafe {
    param($Path, $ID, $Language)
    if ($ID) { return $itemsById[$ID] }
    return $itemsByPath[($Path -replace '^master:', '')]
}
function New-TestItem {
    param($Id, $Name, $Path, $TemplateName = 'Json Rendering', $TemplateId = 'json-template', $Values = @{}, $Children = @())
    $fields = @{}
    foreach ($key in $Values.Keys) { $fields[$key] = @{ Value = $Values[$key] } }
    $axes = [pscustomobject]@{ Items = @($Children) }
    $axes | Add-Member ScriptMethod GetDescendants { return $this.Items }
    $item = [pscustomobject]@{ ID = $Id; Name = $Name; Paths = @{ FullPath = $Path }; TemplateName = $TemplateName; TemplateID = $TemplateId; Fields = $fields; Axes = $axes }
    $itemsByPath[$Path] = $item
    $itemsById[$Id] = $item
    return $item
}
$Database = 'master'
$Language = 'en'
$SiteRootPath = '/sitecore/content/Site/Home'
$RenderingRootsJson = '["/sitecore/layout/Renderings/Feature/Unused","/sitecore/layout/Renderings/Feature/Unused/"]'
$renderingRootPaths = @{}
$configuredRenderingRoots = @()
$availableRenderingItems = @{}
$script:suspiciousRenderingRoots = New-Object System.Collections.ArrayList
$script:renderingInventoryComplete = $true
$script:unresolvedRenderingReferences = New-Object System.Collections.ArrayList
$script:unresolvedRenderingReferenceKeys = @{}
$renderingTemplateKinds = @{}
$renderingDetails = @{}
$renderingCatalog = @{}
$renderingPageMapping = @{}
$allRenderings = New-Object System.Collections.ArrayList
$renderingParameterTemplates = @{}
$renderingParameterTemplateUsage = New-Object System.Collections.ArrayList
$datasourceTemplates = @{}
$templateRootPaths = @{}
$renderingContentsResolverRootPaths = @{}
$renderingContentsResolvers = @{}
$stats = @{ total_renderings = 0; rendering_templates = @{}; renderings_with_component_graphql = 0; renderings_with_resolvers = 0 }
$script:renderingUsageComplete = $true
$folderTemplate = New-TestItem 'folder-template' 'Folder' '/sitecore/templates/Common/Folder' 'Template'
$baseTemplate = New-TestItem 'json-template' 'Json Rendering' '/sitecore/templates/Json' 'Template'
$customTemplate = New-TestItem 'custom-template' 'Custom Rendering' '/sitecore/templates/Custom' 'Template' 'template' @{ '__Base template' = 'json-template' }
$ds = New-TestItem 'ds-template' 'Banner Data' '/sitecore/templates/Feature/Banner/Data' 'Template'
$parameters = New-TestItem 'parameters-template' 'Banner Parameters' '/sitecore/templates/Feature/Banner/Parameters' 'Template'
$resolver = New-TestItem 'resolver' 'Banner Resolver' '/sitecore/system/Modules/Resolvers/Banner' 'Resolver' 'resolver-template' @{ Type = 'Example.Resolver' }
$unused = New-TestItem 'unused' 'Banner' '/sitecore/layout/Renderings/Feature/Unused/Banner' 'Custom Rendering' 'custom-template' @{ 'Component Name' = 'Banner'; 'Datasource Template' = 'ds-template'; 'Parameters Template' = 'parameters-template'; 'Rendering Contents Resolver' = 'resolver'; Path = '/Views/Banner.cshtml' }
$unusedRoot = New-TestItem 'unused-root' 'Unused' '/sitecore/layout/Renderings/Feature/Unused' 'Folder' 'folder-template' @{} @($unused)
$sxa = New-TestItem 'sxa' 'SxaOnly' '/sitecore/layout/Renderings/Feature/Sxa/SxaOnly'
$sxaRoot = New-TestItem 'sxa-root' 'Sxa' '/sitecore/layout/Renderings/Feature/Sxa' 'Folder' 'folder-template' @{} @($sxa)
$available = New-TestItem 'available' 'Available Renderings' '/sitecore/content/Site/Presentation/Available Renderings' 'Available Renderings' 'available-template' @{ Renderings = 'missing-one|sxa|missing-two|missing-one' }
Initialize-RenderingInventoryRoots
Assert ($script:unresolvedRenderingReferences.Count -eq 2) 'Missing SXA references were not recorded or duplicates were logged'
Assert ($script:unresolvedRenderingReferences[0].source_item_path -eq $available.Paths.FullPath) 'Missing reference source path was lost'
Assert (-not $script:renderingInventoryComplete) 'Broken references were reported as a complete inventory'
Assert ($script:renderingUsageComplete) 'SXA inventory gaps incorrectly invalidated page usage scanning'
$script:rootReads = 0
$unusedRoot.Axes | Add-Member ScriptMethod GetDescendants { $script:rootReads++; return $this.Items } -Force
$renderingRootPaths['/sitecore/layout/Renderings/Feature/Unused/Nested'] = $true
Assert ($configuredRenderingRoots.Count -eq 1) 'Roots were not deduplicated'
Assert ($availableRenderingItems.ContainsKey('sxa')) 'Nearest-site SXA reference was not discovered'
# Execute the actual folder inventory block, including recognition and dependencies.
$start = $source.IndexOf('    Write-Output-Line "STEP 3:')
$end = $source.IndexOf('    Write-Output-Line "STEP 3.5:', $start)
Invoke-Expression $source.Substring($start, $end - $start)
Assert ($script:rootReads -eq 1) 'Overlapping rendering roots triggered repeated traversal'
Assert ($renderingCatalog.Count -eq 2) 'Unused folder or SXA definition is missing'
Assert ($renderingCatalog['unused']['view_path'] -eq '/Views/Banner.cshtml') 'MVC view path was lost'
Assert ($datasourceTemplates.ContainsKey('dstemplate')) 'Unused datasource dependency was not registered'
Assert ($renderingParameterTemplates.ContainsKey('parameterstemplate')) 'Unused parameters dependency was not registered'
Assert ($renderingContentsResolvers.ContainsKey('resolver')) 'Unused resolver dependency was not registered'
Assert ($renderingCatalog['sxa']['discovery_sources'] -contains 'sxa-available-renderings') 'SXA provenance was lost'
Assert ($renderingCatalog['unused']['discovery_sources'] -contains 'configured-root') 'Root provenance was lost'
Assert ($null -eq $renderingCatalog['unused']['placeholder']) 'Unused occurrence metadata was fabricated'
$pageItems = @()
$start = $source.IndexOf('    # Export the complete catalog')
$end = $source.IndexOf('    # Convert placeholder settings', $start)
$exportBlock = $source.Substring($start, $end - $start)
Invoke-Expression $exportBlock
Assert ($renderingsDetailedArray.Count -eq 2) 'Complete export dropped unused definitions'
Assert ($renderingCatalog['unused']['usageStatus'] -eq 'not-used-in-scanned-scope') 'Unused usage status is wrong'
Assert ($renderingCatalog['unused']['pageFrequency'] -eq 0) 'Unused page frequency is wrong'
$warningCount = $script:unresolvedRenderingReferences.Count
$brokenDatasourceDetail = $renderingCatalog['unused'].Clone()
$brokenDatasourceDetail['datasource_template'] = '/sitecore/templates/Missing/Example|ds-template'
Register-RenderingDependencies -Item $unused -Detail $brokenDatasourceDetail -IsUsed $false
Assert ($script:unresolvedRenderingReferences.Count -eq ($warningCount + 1)) 'Broken datasource template was not captured'
$datasourceWarning = $script:unresolvedRenderingReferences[$warningCount]
Assert ($datasourceWarning.id -eq '/sitecore/templates/Missing/Example') 'Missing datasource template path was lost'
Assert ($datasourceWarning.discovery_source -eq 'datasource-template') 'Datasource warning type was lost'
Assert ($datasourceWarning.source_item_path -eq $unused.Paths.FullPath) 'Affected rendering path was lost'
Assert ($datasourceTemplates.ContainsKey('dstemplate')) 'Valid datasource dependency was skipped'
Assert ($renderingParameterTemplates.ContainsKey('parameterstemplate')) 'Later parameter dependency was skipped'
$reportDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'kajoo-inventory-' + [guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($reportDir)
$outputDir = $reportDir
try {
    $reportStart = $source.IndexOf('    $renderingDetailsFile = Join-Path')
    $reportEnd = $source.IndexOf('    # 5b.', $reportStart)
    Invoke-Expression $source.Substring($reportStart, $reportEnd - $reportStart)
    $report = Get-Content -LiteralPath $renderingDetailsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (-not $report.inventory_scan_complete) 'Inventory gap flag was missing from report'
    Assert ($report.unresolved_rendering_references.Count -eq 3) 'Missing references were not exported in report'
} finally {
    [System.IO.File]::Delete([System.IO.Path]::Combine($reportDir, 'rendering-details.json'))
    [System.IO.Directory]::Delete($reportDir)
}
$script:renderingUsageComplete = $false
Invoke-Expression $exportBlock
Assert ($renderingCatalog['unused']['usageStatus'] -eq 'unknown') 'Incomplete scan was incorrectly labelled unused'
Assert ($null -eq $renderingCatalog['unused']['pageFrequency']) 'Incomplete frequency was incorrectly zero'
# Layout failures must mark usage incomplete.
$script:renderingUsageComplete = $true
function Get-Rendering { throw 'simulated layout failure' }
Get-RenderingSafe -Item $unused -FinalLayout | Out-Null
Assert (-not $script:renderingUsageComplete) 'Layout errors were silently ignored'
$RenderingRootsJson = '["/sitecore/content/Site"]'
$invalidRejected = $false
try { Initialize-RenderingInventoryRoots } catch { $invalidRejected = $true }
Assert $invalidRejected 'PowerShell accepted an invalid root'
$RenderingRootsJson = $null
$renderingRootPaths['/sitecore/layout/Renderings/Missing'] = $true
$missingRejected = $false
try { Invoke-Expression $source.Substring($source.IndexOf('    Write-Output-Line "STEP 3:'), $source.IndexOf('    Write-Output-Line "STEP 3.5:') - $source.IndexOf('    Write-Output-Line "STEP 3:')) } catch { $missingRejected = $_.Exception.Message -like '*Rendering folder could not be read*' }
Assert $missingRejected 'A missing root was silently accepted'
Write-Output 'Inventory assertions passed'
$script:observedVariantReferences = @{}
$script:observedVariantRenderings = @{}
$script:instanceEvidenceCount = 0
$script:instanceEvidenceWriter = New-Object System.IO.StringWriter
$page = New-TestItem 'page' 'Article' '/sitecore/content/Site/Home/Article'
$instance = [pscustomobject]@{ ItemID = 'unused'; UniqueID = 'instance'; Placeholder = 'main'; Datasource = 'data-a'; Parameters = 'FieldNames=%7B12345678-1234-1234-1234-123456789012%7D&Style=Wide' }
Write-RenderingInstanceEvidence -Page $page -Rendering $instance -Definition $unused
$instance.Parameters = 'Style=Narrow'
$instance.Datasource = 'data-b'
Write-RenderingInstanceEvidence -Page $page -Rendering $instance -Definition $unused
$records = @($script:instanceEvidenceWriter.ToString().Trim() -split "`r?`n" | ForEach-Object { ConvertFrom-Json $_ })
Assert ($records.Count -eq 2) 'Instance evidence collapsed different configurations'
Assert ($records[0].variantId -eq '12345678123412341234123456789012') 'Variant reference was not decoded'
Assert ($records[1].datasource -eq 'data-b') 'Per-instance datasource was lost'
Assert ($records[0].itemPath -eq $page.Paths.FullPath) 'Page association was lost'
$variant = New-TestItem '12345678-1234-1234-1234-123456789012' 'Default' '/sitecore/content/Site/Presentation/Rendering Variants/Banner/Default' 'Variant Definition'
$variant.Fields = @([pscustomobject]@{ Name = 'Tag'; Value = 'h2' })
$unusedVariant = New-TestItem 'unused-variant' 'Unused' '/sitecore/content/Site/Presentation/Rendering Variants/Banner/Unused' 'Variant Definition'
$variantRoot = New-TestItem 'variant-root' 'Rendering Variants' '/sitecore/content/Site/Presentation/Rendering Variants' 'Folder' 'folder-template' @{} @($variant, $unusedVariant)
$catalog = Get-RenderingVariantEvidence
Assert ($catalog.variants.Count -eq 2) 'Unused variant definition was missed'
Assert ($catalog.variants[0].renderingIds -contains 'unused') 'Variant association was lost'
Assert ($catalog.variants[0].observed) 'Observed variant was reported unused'
Assert ($catalog.variants[0].fields.Tag -eq 'h2') 'Variant metadata was lost'
Assert (-not $catalog.variants[1].observed) 'Unused variant was reported observed'
$script:observedVariantReferences['missing-variant'] = 'missing-variant'
$catalog = Get-RenderingVariantEvidence
Assert ($catalog.unresolvedReferences -contains 'missing-variant') 'Unresolved variant reference was silently dropped'
Write-Output 'Instance and variant assertions passed'
$script:renderingDefinitionItems = @{}
$script:itemReads = 0
function Get-ItemSafe { param($Path, $ID, $Language) $script:itemReads++; if ($ID) { return $itemsById[$ID] }; return $itemsByPath[($Path -replace '^master:', '')] }
$rendering = $instance
$start = $source.IndexOf('                    $definitionKey =')
$end = $source.IndexOf('                    $renderingItem = $script:renderingDefinitionItems[$definitionKey]', $start)
$end = $source.IndexOf("`n", $end)
$lookupBlock = $source.Substring($start, $end - $start)
Invoke-Expression $lookupBlock
Invoke-Expression $lookupBlock
Assert ($script:itemReads -eq 1) 'Repeated rendering instances were fetched more than once'
Write-Output 'Definition cache assertions passed'

# Run the real language fallback helper, including negative results and cache behavior.
$Language = 'fr-FR'
$script:lookupLanguages = New-Object System.Collections.ArrayList
$script:availableLanguage = 'en'
function Get-ItemSafe {
    param($Path, $ID, $Language = 'en')
    [void]$script:lookupLanguages.Add($Language)
    if ($Language -ne $script:availableLanguage) { return $null }
    if ($ID) { return $itemsById[$ID] }
    return $itemsByPath[($Path -replace '^master:', '')]
}
foreach ($kind in @('definition', 'folder')) {
    foreach ($availableLanguage in @('fr-FR', 'en', 'missing')) {
        $script:availableLanguage = $availableLanguage
        $script:lookupLanguages.Clear()
        $result = if ($kind -eq 'definition') { Get-DefinitionItemSafe -Path 'master:' -ID 'unused' } else { Get-DefinitionItemSafe -Path 'master:/sitecore/layout/Renderings/Feature/Unused' }
        $expectedLanguages = if ($availableLanguage -eq 'fr-FR') { 'fr-FR' } else { 'fr-FR,en' }
        Assert (($script:lookupLanguages -join ',') -eq $expectedLanguages) "Wrong lookup order for $kind / $availableLanguage"
        Assert (($null -ne $result) -eq ($availableLanguage -ne 'missing')) "Wrong lookup result for $kind / $availableLanguage"
        Assert ($Language -eq 'fr-FR') 'Definition lookup changed the content language'
    }
}
$Language = 'en'
$script:availableLanguage = 'en'
$script:lookupLanguages.Clear()
Get-DefinitionItemSafe -Path 'master:' -ID 'missing' | Out-Null
Assert ($script:lookupLanguages.Count -eq 1) 'English lookup repeated the same language'
$Language = 'fr-FR'
$script:renderingDefinitionItems = @{}
$script:lookupLanguages.Clear()
Invoke-Expression $lookupBlock
Invoke-Expression $lookupBlock
Assert (($script:lookupLanguages -join ',') -eq 'fr-FR,en') 'English rendering fallback was not cached'
$script:renderingDefinitionItems = @{}
$script:availableLanguage = 'missing'
$script:lookupLanguages.Clear()
Invoke-Expression $lookupBlock
Invoke-Expression $lookupBlock
Assert ($script:lookupLanguages.Count -eq 2) 'Failed rendering lookups were not cached'
$script:availableLanguage = 'en'

$badParameters = $renderingCatalog['unused'].Clone()
$badParameters['parameters_template'] = 'missing-parameters'
$beforeWarnings = $script:unresolvedRenderingReferences.Count
Register-RenderingDependencies -Item $unused -Detail $badParameters -IsUsed $false
Register-RenderingDependencies -Item $unused -Detail $renderingCatalog['unused'] -IsUsed $false
Assert ($script:unresolvedRenderingReferences.Count -eq ($beforeWarnings + 1)) 'Missing parameters template did not log and continue'
Assert ($script:unresolvedRenderingReferences[-1].discovery_source -eq 'parameters-template') 'Parameters warning type was lost'

$emptyBase = '{00000000-0000-0000-0000-000000000000}'
$baseFolderTemplate = New-TestItem 'empty-base-template' 'Folder' '/sitecore/templates/Common/EmptyBase' 'Template' 'template' @{ '__Base template' = $emptyBase }
$folderItem = New-TestItem 'folder-item' 'Folder' '/sitecore/layout/Renderings/Feature/Folder' 'Folder' 'empty-base-template'
$beforeWarnings = $script:unresolvedRenderingReferences.Count
Assert (-not (Test-IsRenderingDefinition -Item $folderItem -TemplateNames @('Json Rendering'))) 'Folder was classified as a rendering'
Assert ($script:unresolvedRenderingReferences.Count -eq $beforeWarnings) 'Empty base GUID was incorrectly reported as missing'
$partialTemplate = New-TestItem 'partial-template' 'Custom' '/sitecore/templates/CustomPartial' 'Template' 'template' @{ '__Base template' = "missing-base|$emptyBase|json-template" }
$partialRendering = New-TestItem 'partial-rendering' 'Custom' '/sitecore/layout/Renderings/Feature/Custom' 'Custom' 'partial-template'
Assert (Test-IsRenderingDefinition -Item $partialRendering -TemplateNames @('Json Rendering')) 'Missing inheritance branch hid a valid rendering base'
Assert ($script:unresolvedRenderingReferences[-1].discovery_source -eq 'rendering-template') 'Missing inheritance reference was not captured'

# Inferred roots must originate from supported rendering definitions in the permitted tree.
$outside = New-TestItem 'layout-reference' 'layout' '/sitecore/layout' 'Folder' 'folder-template'
$warningCount = $script:unresolvedRenderingReferences.Count
$root = Get-ValidatedRenderingRoot -Definition $outside -Reference 'layout-reference' -SourceItemPath $available.Paths.FullPath -DiscoverySource 'sxa-available-renderings'
Assert ([string]::IsNullOrWhiteSpace($root)) 'Unrelated item introduced a broad rendering root'
Assert ($script:suspiciousRenderingRoots[-1].resolved_item_path -eq '/sitecore/layout') 'Rejected root provenance was lost'
$root = Get-ValidatedRenderingRoot -Definition $folderItem -Reference 'folder-item' -SourceItemPath $available.Paths.FullPath -DiscoverySource 'sxa-available-renderings'
Assert ([string]::IsNullOrWhiteSpace($root)) 'Rendering folder reference was accepted as a rendering definition'
$root = Get-ValidatedRenderingRoot -Definition $unused -Reference 'unused' -SourceItemPath $available.Paths.FullPath -DiscoverySource 'sxa-available-renderings'
Assert ($root -eq '/sitecore/layout/Renderings/Feature/Unused') 'Valid custom rendering inheritance was rejected'
$available.Fields['Renderings'].Value = 'layout-reference|folder-item|sxa'
$renderingRootPaths = @{}
$RenderingRootsJson = $null
Initialize-RenderingInventoryRoots
Assert (-not $renderingRootPaths.ContainsKey('/sitecore')) 'SXA reference added /sitecore to the scan'
Assert ($renderingRootPaths.ContainsKey('/sitecore/layout/Renderings/Feature/Sxa')) 'Invalid SXA references prevented valid definitions from being discovered'
Assert (-not $source.Contains('TemporaryExcludedContentPaths')) 'Temporary content exclusions remain in production discovery'
Assert (-not $source.Contains('/sitecore/content/FFB/')) 'Instance-specific test path remains in production discovery'
Write-Output 'Language fallback, dependency resilience and inferred-root assertions passed'

# Content site selection is independent of SPE's shell site and retains the nearest site.
$script:discoverySiteContexts = @(
    [pscustomobject]@{ Name = 'parent'; RootPath = '/sitecore/content/Site'; StartItem = '/Home' },
    [pscustomobject]@{ Name = 'nested'; RootPath = '/sitecore/content/Site/Home/Subsite'; StartItem = '/Home' }
)
$mockPage = [pscustomobject]@{ Paths = @{FullPath='/sitecore/content/Site/Home/Subsite/Home/About Us'} }
Assert ((Get-DiscoverySiteForItem $mockPage).Name -eq 'nested') 'Route selection ignored nearest content site'
$mockPage.Paths.FullPath = '/sitecore/content/Site/Home/About Us'
Assert ((Get-DiscoverySiteForItem $mockPage).Name -eq 'parent') 'Content site was not found'
$mockPage.Paths.FullPath = '/sitecore/content/Site/Presentation/Partial Designs/Header'
Assert ($null -eq (Get-DiscoverySiteForItem $mockPage)) 'Shared design was treated as a website page'
Assert ($null -eq (Get-DiscoverySiteForItem $null)) 'Null item produced a content site'
Write-Output 'Content site routing assertions passed'

# Exercise the real export blocks added for the source mapping contract.
$psItemsByKey = @{ 'unused-slot' = @{ id = 'aabb'; placeholder_key = 'unused-slot'; path = '/sitecore/layout/Placeholder Settings/Unused' } }
$renderingCatalog = @{ unused = @{ path = '/sitecore/layout/Renderings/Unused'; placeholders = 'AABB' } }
$placeholderSettingItems = @{}
$stats = @{}
$blockStart = $source.IndexOf('$psItemsById = @{}')
$blockEnd = $source.IndexOf('# Convert placeholder setting items to array', $blockStart)
Assert ($blockStart -ge 0 -and $blockEnd -gt $blockStart) 'Unused rendering placeholder export block missing'
Invoke-Expression $source.Substring($blockStart, $blockEnd - $blockStart)
Assert ($placeholderSettingItems.ContainsKey('aabb')) 'Unused rendering lost its placeholder settings'

$field = New-TestItem -Id '{11111111-1111-1111-1111-111111111111}' -Name 'Title' -Path '/sitecore/templates/Hero/Data/Title' -Values @{ Type = 'Single-Line Text'; Source = 'query:source'; Shared = '1'; Unversioned = '0' }
$section = @{ Name = 'Data' }
$fieldAssignment = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$fieldInfo' }, $true)
Invoke-Expression $fieldAssignment.Extent.Text
Assert ($fieldInfo.id -eq '11111111111111111111111111111111') 'Field identity was not exported'
Assert ($fieldInfo.path -eq '/sitecore/templates/Hero/Data/Title') 'Field path was not exported'
Assert ($fieldInfo.shared -eq $true -and $fieldInfo.unversioned -eq $false) 'Field storage flags were not exported'
Write-Output 'Source mapping export assertions passed'
