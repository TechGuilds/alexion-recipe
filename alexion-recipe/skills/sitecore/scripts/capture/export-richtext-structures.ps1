<#
.SYNOPSIS
  Export analysis-ready Rich Text rendering and datasource structures.

.DESCRIPTION
  Writes chunked JSON export files under the Sitecore CM Data folder and
  returns a small downloader-friendly JSON envelope on stdout. The export is
  rendering/datasource centered, with page-level field candidates emitted in a
  separate file for Rich Text fields and text fields that contain HTML-like
  values.

.INJECTED_VARIABLES
  $sitePath            [string]          Sitecore content root. Required.
  $language            [string]          Sitecore language. Required.
  $mode                [string]          full or sample. Defaults to full.
  $samplePaths         [string|string[]] Optional JSON array or array of exact page paths.
  $pageLimit           [int]             Optional page limit for sample validation.
  $bundleSize          [int]             Records per bundle. Defaults to 250.
  $outputRelativeRoot  [string]          Relative folder under Data. Defaults to kajoo/richtext-export.

.OUTPUTS
  System.String - single JSON document on stdout.
#>

$ErrorActionPreference = 'Stop'
Set-Location "master:\sitecore" | Out-Null

$__capturedAtFallback = [DateTime]::UtcNow.ToString('o')
try {

if ([string]::IsNullOrWhiteSpace($sitePath)) {
    throw "Required parameter 'sitePath' is missing or empty."
}
if ([string]::IsNullOrWhiteSpace($language)) {
    throw "Required parameter 'language' is missing or empty."
}
if ($null -eq $bundleSize) { $bundleSize = 250 }
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'full' }
if ([string]::IsNullOrWhiteSpace($outputRelativeRoot)) { $outputRelativeRoot = 'kajoo/richtext-export' }

if ($bundleSize -is [string]) { $bundleSize = [int]$bundleSize }
if ($pageLimit -is [string] -and -not [string]::IsNullOrWhiteSpace($pageLimit)) { $pageLimit = [int]$pageLimit }
if ([int]$bundleSize -lt 1) { throw "bundleSize must be greater than or equal to 1." }
if (@('full', 'sample') -notcontains $mode) { throw "mode must be 'full' or 'sample'." }

$outputRelativeRoot = $outputRelativeRoot.Trim().Replace('\', '/')
if ($outputRelativeRoot.StartsWith('/') -or $outputRelativeRoot -match '^[a-zA-Z]:') {
    throw "outputRelativeRoot must be a relative path under the Sitecore Data folder."
}
if (($outputRelativeRoot -split '/') -contains '..') {
    throw "outputRelativeRoot must not contain '..' path segments."
}
if ([string]::IsNullOrWhiteSpace($outputRelativeRoot.Trim('/'))) {
    throw "outputRelativeRoot must not be empty."
}

function ConvertTo-StringArray {
    param($Value)

    if ($null -eq $Value) { return ,@() }
    if ($Value -is [string]) {
        if ([string]::IsNullOrWhiteSpace($Value)) { return ,@() }
        try {
            $parsed = ConvertFrom-Json -InputObject $Value -ErrorAction Stop
        } catch {
            return ,@($Value)
        }
        if ($null -eq $parsed) { return ,@() }
        return ,@($parsed | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    return ,@($Value | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Convert-RenderingParameters {
    param([string]$Parameters)

    $result = [ordered]@{}
    if ([string]::IsNullOrWhiteSpace($Parameters)) { return $result }

    foreach ($pair in ($Parameters -split '&')) {
        if ([string]::IsNullOrWhiteSpace($pair)) { continue }
        $parts = $pair -split '=', 2
        $key = [System.Web.HttpUtility]::UrlDecode($parts[0])
        $value = ''
        if ($parts.Length -gt 1) { $value = [System.Web.HttpUtility]::UrlDecode($parts[1]) }
        if (-not [string]::IsNullOrWhiteSpace($key)) { $result[$key] = $value }
    }

    return $result
}

function Get-HtmlFacts {
    param([string]$Value)

    $topLevelTags = New-Object System.Collections.Generic.List[string]
    $classNames = New-Object System.Collections.Generic.HashSet[string]

    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        $tagMatches = [regex]::Matches($Value, '<\s*([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>')
        foreach ($match in $tagMatches) {
            $tag = $match.Groups[1].Value.ToLowerInvariant()
            if ($topLevelTags.Count -lt 10 -and -not $topLevelTags.Contains($tag)) {
                [void]$topLevelTags.Add($tag)
            }

            $attrs = $match.Groups[2].Value
            $classMatch = [regex]::Match($attrs, 'class\s*=\s*["'']([^"'']+)["'']')
            if ($classMatch.Success) {
                foreach ($className in ($classMatch.Groups[1].Value -split '\s+')) {
                    if (-not [string]::IsNullOrWhiteSpace($className)) { [void]$classNames.Add($className) }
                }
            }
        }
    }

    return [ordered]@{
        hasHtml = (-not [string]::IsNullOrWhiteSpace($Value) -and $Value -match '<\s*[a-zA-Z][^>]*>')
        topLevelTags = @($topLevelTags)
        classNames = @($classNames | Sort-Object)
        linkCount = if ([string]::IsNullOrWhiteSpace($Value)) { 0 } else { ([regex]::Matches($Value, '<\s*a\b', 'IgnoreCase')).Count }
        mediaReferenceCount = if ([string]::IsNullOrWhiteSpace($Value)) { 0 } else { ([regex]::Matches($Value, '(<\s*img\b|/-/media/|~/media/)', 'IgnoreCase')).Count }
    }
}

function Get-FieldSnapshot {
    param($Item, [bool]$IncludeStandardFields = $false)

    $fields = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Item) { return @() }

    $Item.Fields.ReadAll()
    foreach ($field in $Item.Fields) {
        if (-not $IncludeStandardFields -and $field.Name -like "__*") { continue }

        $value = [string]$field.Value
        $htmlFacts = Get-HtmlFacts -Value $value
        [void]$fields.Add([PSCustomObject][ordered]@{
            name = $field.Name
            id = $field.ID.ToString()
            type = [string]$field.Type
            value = $value
            valueLength = $value.Length
            hasValue = -not [string]::IsNullOrWhiteSpace($value)
            hasHtml = $htmlFacts.hasHtml
            topLevelTags = $htmlFacts.topLevelTags
            classNames = $htmlFacts.classNames
            linkCount = $htmlFacts.linkCount
            mediaReferenceCount = $htmlFacts.mediaReferenceCount
        })
    }

    return $fields.ToArray()
}

function Test-PageFieldCandidate {
    param($FieldSnapshot)

    if ($null -eq $FieldSnapshot) { return $false }
    if ($FieldSnapshot.type -eq 'Rich Text') { return $true }
    if (-not $FieldSnapshot.hasHtml) { return $false }

    return @(
        'Multi-Line Text',
        'Single-Line Text',
        'Memo'
    ) -contains $FieldSnapshot.type
}

function Resolve-DatasourceItem {
    param($SourceValue, $ContextItem)

    if ([string]::IsNullOrWhiteSpace($SourceValue)) {
        return [ordered]@{ item = $null; kind = 'none'; error = $null }
    }

    $source = [string]$SourceValue
    if ($source.StartsWith('local:', [System.StringComparison]::OrdinalIgnoreCase)) {
        $relative = $source.Substring(6).TrimStart('/')
        $path = 'master:' + $ContextItem.Paths.FullPath + '/' + $relative
        $item = Get-Item -Path $path -Language $language -ErrorAction SilentlyContinue
        return [ordered]@{ item = $item; kind = 'local'; error = if ($null -eq $item) { "Could not resolve local datasource: $source" } else { $null } }
    }

    if ($source.StartsWith('/')) {
        $item = Get-Item -Path ('master:' + $source) -Language $language -ErrorAction SilentlyContinue
        return [ordered]@{ item = $item; kind = 'path'; error = if ($null -eq $item) { "Could not resolve path datasource: $source" } else { $null } }
    }

    try {
        $item = Get-Item -Path 'master:' -ID $source -Language $language -ErrorAction SilentlyContinue
        return [ordered]@{ item = $item; kind = 'id'; error = if ($null -eq $item) { "Could not resolve ID datasource: $source" } else { $null } }
    } catch {
        return [ordered]@{ item = $null; kind = 'id'; error = $_.Exception.Message }
    }
}

function Resolve-RenderingDatasourceItem {
    param($Rendering, $ContextItem, $RenderingParameters)

    $datasourceRaw = [string]$Rendering.Datasource
    if ([string]::IsNullOrWhiteSpace($datasourceRaw)) { $datasourceRaw = [string]$Rendering.DataSource }

    $resolution = Resolve-DatasourceItem -SourceValue $datasourceRaw -ContextItem $ContextItem
    if ($null -ne $resolution.item -or -not [string]::IsNullOrWhiteSpace($datasourceRaw)) {
        $resolution['raw'] = $datasourceRaw
        $resolution['source'] = 'rendering-datasource'
        return $resolution
    }

    $relativePath = $null
    if ($null -ne $RenderingParameters -and $RenderingParameters.Contains('DataSourceRelativePath')) {
        $relativePath = [string]$RenderingParameters['DataSourceRelativePath']
    }

    if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $resolution['raw'] = $datasourceRaw
        $resolution['source'] = 'none'
        return $resolution
    }

    $resolvedPath = 'master:' + $ContextItem.Paths.FullPath.TrimEnd('/') + '/' + $relativePath.TrimStart('/')
    $item = Get-Item -Path $resolvedPath -Language $language -ErrorAction SilentlyContinue
    $err = $null
    if ($null -eq $item) { $err = "Could not resolve DataSourceRelativePath: $relativePath" }

    return [ordered]@{
        item = $item
        kind = 'parameter-relative-path'
        error = $err
        raw = $relativePath
        source = 'rendering-parameter:DataSourceRelativePath'
    }
}

function Get-RenderingItemInfo {
    param($Rendering)

    $renderingItem = $null
    if ($null -ne $Rendering.ItemID) {
        try { $renderingItem = Get-Item -Path 'master:' -ID $Rendering.ItemID -ErrorAction SilentlyContinue } catch { $renderingItem = $null }
    }

    return [ordered]@{
        item = $renderingItem
        id = if ($null -ne $Rendering.ItemID) { $Rendering.ItemID.ToString() } else { $null }
        name = if ($null -ne $renderingItem) { $renderingItem.Name } else { $null }
        path = if ($null -ne $renderingItem) { $renderingItem.Paths.FullPath } else { $null }
    }
}

function Get-DatasourceSnapshotKey {
    param($Item)

    if ($null -eq $Item) { return $null }
    if ($null -ne $Item.ID) { return 'id:' + $Item.ID.ToString() }
    if ($null -ne $Item.Paths -and -not [string]::IsNullOrWhiteSpace($Item.Paths.FullPath)) {
        return 'path:' + $Item.Paths.FullPath
    }

    return $null
}

function Test-ItemHasRenderings {
    param($Item)

    if ($null -eq $Item) { return $false }

    return (($Item.Fields['__Final Renderings'] -and -not [string]::IsNullOrWhiteSpace($Item.Fields['__Final Renderings'].Value)) -or
            ($Item.Fields['__Renderings'] -and -not [string]::IsNullOrWhiteSpace($Item.Fields['__Renderings'].Value)))
}

function Write-JsonFile {
    param($Value, [string]$Path, [int]$Depth)

    if ($null -eq $Value) {
        'null' | Out-File -FilePath $Path -Encoding UTF8
        return
    }

    $valueCount = $null
    try {
        if ($null -ne $Value.PSObject.Properties['Count']) {
            $valueCount = [int]$Value.Count
        }
    } catch {
        $valueCount = $null
    }

    if ($null -ne $valueCount -and $valueCount -eq 0) {
        '[]' | Out-File -FilePath $Path -Encoding UTF8
        return
    }

    $Value | ConvertTo-Json -Depth $Depth | Out-File -FilePath $Path -Encoding UTF8
}

function Add-FileEntry {
    param($Files, [string]$OutputRelDir, [string]$OutputDir, [string]$RelativeFile)

    $relativeDiskPath = $RelativeFile.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $path = Join-Path $OutputDir $relativeDiskPath
    $info = Get-Item -Path $path
    [void]$Files.Add([ordered]@{
        name = $RelativeFile
        rootPath = 'Data'
        relativePath = ($OutputRelDir + '/' + $RelativeFile)
        sizeBytes = [int64]$info.Length
    })
}

$samplePathList = ConvertTo-StringArray $samplePaths
$runId = [guid]::NewGuid().ToString('N')
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$dataRootSetting = [Sitecore.Configuration.Settings]::DataFolder
$dataRoot = [Sitecore.MainUtil]::MapPath($dataRootSetting)
if ([string]::IsNullOrWhiteSpace($dataRoot)) {
    throw "Could not resolve Sitecore DataFolder setting '$dataRootSetting' to a physical filesystem path."
}

$safeSite = ($sitePath -replace '[^a-zA-Z0-9]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($safeSite)) { $safeSite = 'site' }
$safeLanguage = ($language -replace '[^a-zA-Z0-9]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($safeLanguage)) { $safeLanguage = 'language' }
$safeMode = ($mode -replace '[^a-zA-Z0-9]', '-').Trim('-')
$outputName = $timestamp + '-' + $safeSite + '-' + $safeLanguage + '-' + $safeMode + '-' + $runId.Substring(0, 8)
$normalizedRelativeRoot = $outputRelativeRoot.Trim('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
$outputRelDir = ($outputRelativeRoot.Trim('/') + '/' + $outputName)
$outputDir = Join-Path (Join-Path $dataRoot $normalizedRelativeRoot) $outputName
$recordsDir = Join-Path $outputDir 'records'
$indexesDir = Join-Path $outputDir 'indexes'
[void](New-Item -ItemType Directory -Path $recordsDir -Force)
[void](New-Item -ItemType Directory -Path $indexesDir -Force)

$pageItems = New-Object System.Collections.Generic.List[object]
if ($samplePathList.Count -gt 0) {
    foreach ($itemPath in $samplePathList) {
        $item = Get-Item -Path ('master:' + $itemPath) -Language $language -ErrorAction SilentlyContinue
        if ($null -ne $item) { [void]$pageItems.Add($item) }
    }
} else {
    $root = Get-Item -Path ('master:' + $sitePath) -Language $language
    if ($null -ne $root) {
        if (Test-ItemHasRenderings -Item $root) {
            [void]$pageItems.Add($root)
        }

        if (-not $pageLimit -or $pageItems.Count -lt [int]$pageLimit) {
            Get-ChildItem -Path ('master:' + $sitePath) -Language $language -Recurse | ForEach-Object {
                if ($pageLimit -and $pageItems.Count -ge [int]$pageLimit) { return }
                if (Test-ItemHasRenderings -Item $_) {
                    [void]$pageItems.Add($_)
                }
            }
        }
    }
}

$records = New-Object System.Collections.Generic.List[object]
$datasourceSnapshots = New-Object System.Collections.Generic.List[object]
$datasourceSnapshotByKey = @{}
$datasourceReferenceCounts = @{}
$datasourcePagesByKey = @{}
$unresolved = New-Object System.Collections.Generic.List[object]
$pageFieldCandidates = New-Object System.Collections.Generic.List[object]

foreach ($pageItem in $pageItems) {
    $pageItem = Get-Item -Path ('master:' + $pageItem.Paths.FullPath) -Language $language -ErrorAction SilentlyContinue
    if ($null -eq $pageItem) { continue }

    $renderings = @(Get-Rendering -Item $pageItem -FinalLayout)
    foreach ($rendering in $renderings) {
        $renderingInfo = Get-RenderingItemInfo -Rendering $rendering
        $renderingParameters = Convert-RenderingParameters -Parameters ([string]$rendering.Parameters)
        $datasourceResolution = Resolve-RenderingDatasourceItem -Rendering $rendering -ContextItem $pageItem -RenderingParameters $renderingParameters
        $datasourceRaw = [string]$datasourceResolution.raw
        $datasourceItem = $datasourceResolution.item
        $datasourceFields = @(Get-FieldSnapshot -Item $datasourceItem -IncludeStandardFields $true)
        $datasourceSnapshotKey = Get-DatasourceSnapshotKey -Item $datasourceItem
        $hasRichTextField = @($datasourceFields | Where-Object { $_.type -eq 'Rich Text' }).Count -gt 0
        $hasHtmlField = @($datasourceFields | Where-Object { $_.hasHtml }).Count -gt 0
        $renderingLooksRelevant = (($renderingInfo.name -match '(?i)rich|html') -or $hasRichTextField -or $hasHtmlField)

        if (-not $renderingLooksRelevant) { continue }

        if (-not [string]::IsNullOrWhiteSpace($datasourceSnapshotKey)) {
            if (-not $datasourceReferenceCounts.ContainsKey($datasourceSnapshotKey)) {
                $datasourceReferenceCounts[$datasourceSnapshotKey] = 0
            }
            $datasourceReferenceCounts[$datasourceSnapshotKey]++

            if (-not $datasourcePagesByKey.ContainsKey($datasourceSnapshotKey)) {
                $datasourcePagesByKey[$datasourceSnapshotKey] = New-Object System.Collections.Generic.HashSet[string]
            }
            [void]$datasourcePagesByKey[$datasourceSnapshotKey].Add($pageItem.Paths.FullPath)

            if (-not $datasourceSnapshotByKey.ContainsKey($datasourceSnapshotKey)) {
                $snapshot = [ordered]@{
                    schemaVersion = 1
                    sourceKind = 'datasource'
                    snapshotKey = $datasourceSnapshotKey
                    language = $language
                    datasource = [ordered]@{
                        id = if ($null -ne $datasourceItem) { $datasourceItem.ID.ToString() } else { $null }
                        path = if ($null -ne $datasourceItem) { $datasourceItem.Paths.FullPath } else { $null }
                        name = if ($null -ne $datasourceItem) { $datasourceItem.Name } else { $null }
                        templateName = if ($null -ne $datasourceItem) { $datasourceItem.TemplateName } else { $null }
                        templateId = if ($null -ne $datasourceItem) { $datasourceItem.TemplateID.ToString() } else { $null }
                    }
                    fields = $datasourceFields
                }
                $datasourceSnapshotByKey[$datasourceSnapshotKey] = $snapshot
                [void]$datasourceSnapshots.Add($snapshot)
            }
        }

        $record = [ordered]@{
            schemaVersion = 1
            sourceKind = 'rendering'
            language = $language
            page = [ordered]@{
                id = $pageItem.ID.ToString()
                path = $pageItem.Paths.FullPath
                name = $pageItem.Name
                templateName = $pageItem.TemplateName
                templateId = $pageItem.TemplateID.ToString()
            }
            rendering = [ordered]@{
                uid = if ($null -ne $rendering.UniqueId) { $rendering.UniqueId.ToString() } else { $null }
                id = $renderingInfo.id
                name = $renderingInfo.name
                path = $renderingInfo.path
                placeholder = [string]$rendering.Placeholder
                parametersRaw = [string]$rendering.Parameters
                parameters = $renderingParameters
                datasourceRaw = $datasourceRaw
            }
            datasource = [ordered]@{
                resolved = ($null -ne $datasourceItem)
                resolutionKind = $datasourceResolution.kind
                resolutionSource = $datasourceResolution.source
                resolutionError = $datasourceResolution.error
                id = if ($null -ne $datasourceItem) { $datasourceItem.ID.ToString() } else { $null }
                path = if ($null -ne $datasourceItem) { $datasourceItem.Paths.FullPath } else { $null }
                name = if ($null -ne $datasourceItem) { $datasourceItem.Name } else { $null }
                templateName = if ($null -ne $datasourceItem) { $datasourceItem.TemplateName } else { $null }
                templateId = if ($null -ne $datasourceItem) { $datasourceItem.TemplateID.ToString() } else { $null }
                fieldCount = $datasourceFields.Count
                snapshotKey = $datasourceSnapshotKey
            }
        }

        [void]$records.Add($record)
        if ($null -eq $datasourceItem -and -not [string]::IsNullOrWhiteSpace($datasourceRaw)) {
            [void]$unresolved.Add([ordered]@{
                pagePath = $pageItem.Paths.FullPath
                renderingName = $renderingInfo.name
                datasourceRaw = $datasourceRaw
                resolutionKind = $datasourceResolution.kind
                resolutionSource = $datasourceResolution.source
                error = $datasourceResolution.error
            })
        }
    }

    $pageFields = @(Get-FieldSnapshot -Item $pageItem | Where-Object { Test-PageFieldCandidate -FieldSnapshot $_ })
    if ($pageFields.Count -gt 0) {
        [void]$pageFieldCandidates.Add([ordered]@{
            language = $language
            page = [ordered]@{
                id = $pageItem.ID.ToString()
                path = $pageItem.Paths.FullPath
                name = $pageItem.Name
                templateName = $pageItem.TemplateName
                templateId = $pageItem.TemplateID.ToString()
            }
            fields = $pageFields
        })
    }
}

foreach ($snapshot in $datasourceSnapshots) {
    $snapshotKey = [string]$snapshot['snapshotKey']
    $snapshot['referenceCount'] = if ($datasourceReferenceCounts.ContainsKey($snapshotKey)) {
        [int]$datasourceReferenceCounts[$snapshotKey]
    } else {
        0
    }
    $snapshot['pageCount'] = if ($datasourcePagesByKey.ContainsKey($snapshotKey)) {
        [int]$datasourcePagesByKey[$snapshotKey].Count
    } else {
        0
    }
}

$bundleInfos = New-Object System.Collections.Generic.List[object]
$bundleIndex = 0
for ($offset = 0; $offset -lt $records.Count; $offset += [int]$bundleSize) {
    $bundleIndex++
    $bundleName = 'bundle-{0:D3}.json' -f $bundleIndex
    $bundlePath = Join-Path $recordsDir $bundleName
    $count = [Math]::Min([int]$bundleSize, $records.Count - $offset)
    $bundleRecords = @($records | Select-Object -Skip $offset -First $count)
    Write-JsonFile -Value $bundleRecords -Path $bundlePath -Depth 12
    $fileInfo = Get-Item -Path $bundlePath
    [void]$bundleInfos.Add([ordered]@{
        file = 'records/' + $bundleName
        recordCount = $count
        sizeBytes = [int64]$fileInfo.Length
    })
}

$datasourcesDir = Join-Path $outputDir 'datasources'
[void](New-Item -ItemType Directory -Path $datasourcesDir -Force)
$datasourceBundleInfos = New-Object System.Collections.Generic.List[object]
$datasourceBundleIndex = 0
for ($offset = 0; $offset -lt $datasourceSnapshots.Count; $offset += [int]$bundleSize) {
    $datasourceBundleIndex++
    $bundleName = 'bundle-{0:D3}.json' -f $datasourceBundleIndex
    $bundlePath = Join-Path $datasourcesDir $bundleName
    $count = [Math]::Min([int]$bundleSize, $datasourceSnapshots.Count - $offset)
    $bundleSnapshots = @($datasourceSnapshots | Select-Object -Skip $offset -First $count)
    Write-JsonFile -Value $bundleSnapshots -Path $bundlePath -Depth 12
    $fileInfo = Get-Item -Path $bundlePath
    [void]$datasourceBundleInfos.Add([ordered]@{
        file = 'datasources/' + $bundleName
        datasourceCount = $count
        sizeBytes = [int64]$fileInfo.Length
    })
}

$byDatasourcePages = New-Object System.Collections.Generic.List[object]
foreach ($snapshot in $datasourceSnapshots) {
    $snapshotKey = [string]$snapshot['snapshotKey']
    $pages = @()
    if ($datasourcePagesByKey.ContainsKey($snapshotKey)) {
        $pages = @($datasourcePagesByKey[$snapshotKey] | Sort-Object)
    }

    [void]$byDatasourcePages.Add([ordered]@{
        snapshotKey = $snapshotKey
        datasource = $snapshot['datasource']
        pageCount = $pages.Count
        pages = $pages
    })
}

$byRendering = @{}
$byDatasourceTemplate = @{}
$byPageTemplate = @{}
$byResolutionSource = @{}
foreach ($record in $records) {
    $renderingName = if ($record.rendering.name) { $record.rendering.name } else { 'unknown' }
    $datasourceTemplate = if ($record.datasource.templateName) { $record.datasource.templateName } else { 'unresolved-or-none' }
    $pageTemplate = if ($record.page.templateName) { $record.page.templateName } else { 'unknown' }
    $resolutionSource = if ($record.datasource.resolutionSource) { $record.datasource.resolutionSource } else { 'unknown' }
    if (-not $byRendering.ContainsKey($renderingName)) { $byRendering[$renderingName] = 0 }
    if (-not $byDatasourceTemplate.ContainsKey($datasourceTemplate)) { $byDatasourceTemplate[$datasourceTemplate] = 0 }
    if (-not $byPageTemplate.ContainsKey($pageTemplate)) { $byPageTemplate[$pageTemplate] = 0 }
    if (-not $byResolutionSource.ContainsKey($resolutionSource)) { $byResolutionSource[$resolutionSource] = 0 }
    $byRendering[$renderingName]++
    $byDatasourceTemplate[$datasourceTemplate]++
    $byPageTemplate[$pageTemplate]++
    $byResolutionSource[$resolutionSource]++
}

Write-JsonFile -Value $byRendering -Path (Join-Path $indexesDir 'by-rendering.json') -Depth 4
Write-JsonFile -Value $byDatasourceTemplate -Path (Join-Path $indexesDir 'by-datasource-template.json') -Depth 4
Write-JsonFile -Value $byDatasourcePages -Path (Join-Path $indexesDir 'by-datasource-pages.json') -Depth 12
Write-JsonFile -Value $byPageTemplate -Path (Join-Path $indexesDir 'by-page-template.json') -Depth 4
Write-JsonFile -Value $byResolutionSource -Path (Join-Path $indexesDir 'by-resolution-source.json') -Depth 4
Write-JsonFile -Value $unresolved -Path (Join-Path $indexesDir 'unresolved-datasources.json') -Depth 6
Write-JsonFile -Value $pageFieldCandidates -Path (Join-Path $outputDir 'page-field-candidates.json') -Depth 10

$summary = [ordered]@{
    schemaVersion = 1
    mode = $mode
    language = $language
    siteRootPath = $sitePath
    pagesScanned = $pageItems.Count
    renderingRecords = $records.Count
    unresolvedDatasources = $unresolved.Count
    pageFieldCandidatePages = $pageFieldCandidates.Count
    bundleCount = $bundleInfos.Count
    datasourceCount = $datasourceSnapshots.Count
    datasourceBundleCount = $datasourceBundleInfos.Count
    byRendering = $byRendering
    byDatasourceTemplate = $byDatasourceTemplate
    byPageTemplate = $byPageTemplate
    byResolutionSource = $byResolutionSource
}
Write-JsonFile -Value $summary -Path (Join-Path $outputDir 'summary.json') -Depth 8

$relativeFiles = New-Object System.Collections.Generic.List[string]
foreach ($relativeFile in @(
    'summary.json',
    'page-field-candidates.json',
    'indexes/by-rendering.json',
    'indexes/by-datasource-template.json',
    'indexes/by-datasource-pages.json',
    'indexes/by-page-template.json',
    'indexes/by-resolution-source.json',
    'indexes/unresolved-datasources.json'
)) {
    [void]$relativeFiles.Add($relativeFile)
}
foreach ($bundleInfo in $bundleInfos) { [void]$relativeFiles.Add($bundleInfo.file) }
foreach ($bundleInfo in $datasourceBundleInfos) { [void]$relativeFiles.Add($bundleInfo.file) }

$files = New-Object System.Collections.Generic.List[object]
foreach ($relativeFile in $relativeFiles) {
    Add-FileEntry -Files $files -OutputRelDir $outputRelDir -OutputDir $outputDir -RelativeFile $relativeFile
}

$pageLimitValue = $null
if ($null -ne $pageLimit -and -not [string]::IsNullOrWhiteSpace([string]$pageLimit)) {
    $pageLimitValue = [int]$pageLimit
}

$manifest = [ordered]@{}
$manifest['schemaVersion'] = 1
$manifest['exportKind'] = 'richtext-structures'
$manifest['runId'] = $runId
$manifest['generatedAt'] = [DateTime]::UtcNow.ToString('o')
$manifest['mode'] = $mode
$manifest['language'] = $language
$manifest['siteRootPath'] = $sitePath
$manifest['rootPath'] = 'Data'
$manifest['dataRootSetting'] = $dataRootSetting
$manifest['outputRelativeDir'] = $outputRelDir
$manifest['manifestRelativePath'] = ($outputRelDir + '/manifest.json')
$manifest['bundleSize'] = [int]$bundleSize
$manifest['pageLimit'] = $pageLimitValue
$manifest['requestedSamplePathCount'] = $samplePathList.Count
$manifest['pagesScanned'] = $pageItems.Count
$manifest['renderingRecords'] = $records.Count
$manifest['unresolvedDatasources'] = $unresolved.Count
$manifest['pageFieldCandidatePages'] = $pageFieldCandidates.Count
$manifest['bundleCount'] = $bundleInfos.Count
$manifest['datasourceCount'] = $datasourceSnapshots.Count
$manifest['datasourceBundleCount'] = $datasourceBundleInfos.Count
$manifest['bundles'] = $bundleInfos.ToArray()
$manifest['datasourceBundles'] = $datasourceBundleInfos.ToArray()
$manifest['files'] = $files.ToArray()
$manifestPath = Join-Path $outputDir 'manifest.json'
Write-JsonFile -Value $manifest -Path $manifestPath -Depth 8

$allRelativeFiles = @($relativeFiles) + @('manifest.json')
$previousManifestSize = -1
$manifestSizeConverged = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $nextFiles = New-Object System.Collections.Generic.List[object]
    foreach ($relativeFile in $allRelativeFiles) {
        Add-FileEntry -Files $nextFiles -OutputRelDir $outputRelDir -OutputDir $outputDir -RelativeFile $relativeFile
    }

    $manifest['files'] = $nextFiles.ToArray()
    Write-JsonFile -Value $manifest -Path $manifestPath -Depth 8

    $currentManifestSize = (Get-Item -LiteralPath $manifestPath).Length
    $files = $nextFiles
    if ($currentManifestSize -eq $previousManifestSize) {
        $manifestSizeConverged = $true
        break
    }
    $previousManifestSize = $currentManifestSize
}

if (-not $manifestSizeConverged) {
    throw 'manifest.json size metadata did not converge after 10 attempts.'
}

[ordered]@{
    ok = $true
    exportKind = 'richtext-structures'
    runId = $runId
    rootPath = 'Data'
    outputRelativeDir = $outputRelDir
    manifestRelativePath = ($outputRelDir + '/manifest.json')
    files = $files.ToArray()
    pagesScanned = $pageItems.Count
    renderingRecords = $records.Count
    unresolvedDatasources = $unresolved.Count
    pageFieldCandidatePages = $pageFieldCandidates.Count
    bundleCount = $bundleInfos.Count
} | ConvertTo-Json -Depth 8
} catch {
    $positionMessage = $null
    try { $positionMessage = $_.InvocationInfo.PositionMessage } catch { }
    $scriptStackTrace = $null
    try { $scriptStackTrace = $_.ScriptStackTrace } catch { }
    $errorType = $null
    try { $errorType = $_.Exception.GetType().FullName } catch { }
    [ordered]@{
        ok = $false
        exportKind = 'richtext-structures'
        error = $_.Exception.Message
        errorType = $errorType
        positionMessage = $positionMessage
        scriptStackTrace = $scriptStackTrace
        capturedAt = $__capturedAtFallback
    } | ConvertTo-Json -Depth 8
}
