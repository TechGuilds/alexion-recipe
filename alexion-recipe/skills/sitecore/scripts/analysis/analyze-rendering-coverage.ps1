# Required SitePath, RenderingIds[] and Devices[]; optional RenderingNames[].
# Uses the selected source connector and produces a manifest-backed coverage.jsonl export.
Assert-KajooItemPath $SitePath
if (-not $RenderingIds -or @($RenderingIds).Count -eq 0) { throw 'RenderingIds must contain at least one rendering item ID' }
if ($RenderingIds -is [string]) { $RenderingIds = @($RenderingIds) }
if ($RenderingNames -is [string]) { $RenderingNames = @($RenderingNames) }
Start-KajooExport 'rendering-coverage'
Write-KajooRecord 'coverage.jsonl' $null

function Normalize-KajooGuid([string] $Value) {
    try { return ([guid]$Value.Trim('{}')).ToString('D').ToUpperInvariant() }
    catch { throw 'RenderingIds must contain valid Sitecore GUIDs' }
}

function Get-KajooRelativeRoute($Item) {
    if ($null -eq $Item) { return $null }
    try {
        $options = [Sitecore.Links.UrlOptions]::DefaultOptions
        $options.LanguageEmbedding = [Sitecore.Links.LanguageEmbedding]::Never
        $options.AlwaysIncludeServerUrl = $false
        $options.SiteResolving = $true
        $url = [Sitecore.Links.LinkManager]::GetItemUrl($Item, $options)
        if ([string]::IsNullOrWhiteSpace($url)) { return $null }
        if ($url -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $url = ([System.Uri]$url).AbsolutePath }
        try { $url = [System.Uri]::UnescapeDataString($url) } catch { }
        if (-not $url.StartsWith('/')) { $url = '/' + $url }
        if ($url.Length -gt 1) { $url = $url.TrimEnd('/') }
        return $url.ToLowerInvariant()
    } catch { return $null }
}

$renderingIds = @($RenderingIds | ForEach-Object { Normalize-KajooGuid ([string]$_) })
if (@($renderingIds | Select-Object -Unique).Count -ne $renderingIds.Count) { throw 'RenderingIds must be unique' }
if (-not $Devices) { throw 'Devices must explicitly list Sitecore device IDs' }
$deviceIds = @($Devices | ForEach-Object { Normalize-KajooGuid ([string]$_) } | Sort-Object -Unique)
$availableDevices = [Sitecore.Configuration.Factory]::GetDatabase($Database).Resources.Devices.GetAll()
$devicesById = @{}
foreach ($id in $deviceIds) {
    $matches = @($availableDevices | Where-Object { ([string]$_.ID).Trim('{}') -ieq $id })
    if ($matches.Count -ne 1) { throw 'Requested device not found or ambiguous in selected database' }
    $devicesById[$id] = $matches[0]
}
$namesById = @{}
for ($index = 0; $index -lt $renderingIds.Count; $index++) {
    $id = $renderingIds[$index]
    $namesById[$id] = if ($index -lt @($RenderingNames).Count -and $RenderingNames[$index]) { [string]$RenderingNames[$index] } else { $id }
    try {
        if ($null -eq (Get-Item -Path ($Database + ':') -ID ('{' + $id + '}') -ErrorAction Stop)) { throw 'missing definition' }
    } catch { Add-KajooError $id 'Rendering definition was not found in the requested database' }
}

# Scan each scoped item once; LinkDatabase referrers are NOT presentation usage.
# Get-Rendering -FinalLayout resolves inherited/shared/final presentation like the
# producer. Raw XML presence alone can miss inherited presentation.
$groups = @{}
function Get-KajooCoverageGroup([string]$Language, [string]$VersionScope, [string]$DeviceId) {
    $key = $Language + ':' + $VersionScope + ':' + $DeviceId
    if (-not $groups.ContainsKey($key)) {
        $groups[$key] = @{language=$Language; version=$VersionScope; deviceId=$DeviceId; pages=@{}}
    }
    return $groups[$key]
}
if ($Version -ne '*') {
    foreach ($language in $Languages) {
        foreach ($deviceId in $deviceIds) { $null = Get-KajooCoverageGroup $language $Version $deviceId }
    }
}
Read-KajooItems @($SitePath) -Recurse | ForEach-Object {
    $item = $_
    $path = [string]$item.Paths.FullPath
    if ($path -ine $SitePath -and -not $path.StartsWith($SitePath + '/', [StringComparison]::OrdinalIgnoreCase)) { throw 'Page escaped requested subtree' }
    foreach ($deviceId in $deviceIds) {
        $versionScope = if ($Version -eq '*') { [string]$item.Version } else { [string]$Version }
        $group = Get-KajooCoverageGroup ([string]$item.Language) $versionScope $deviceId
        try {
            $occurrences = @(Get-KajooOccurrences $item $devicesById[$deviceId] -Final)
            if ($occurrences.Count -eq 0 -and -not (Get-KajooField $item '__Renderings') -and -not (Get-KajooField $item '__Final Renderings')) { continue }
            $used = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($occurrence in $occurrences) {
                $id = Normalize-KajooGuid ([string]$occurrence.renderingId)
                if ($namesById.ContainsKey($id)) { [void]$used.Add($id) }
            }
            $key = [string]$item.ID + ':' + [string]$item.Version
            $group.pages[$key] = @{item=$item; used=$used}
        } catch { Add-KajooError ($path + ':' + $item.Language + ':' + $item.Version + ':' + $deviceId) 'Resolved final presentation could not be collected' }
    }
}

foreach ($groupKey in ($groups.Keys | Sort-Object)) {
    $group = $groups[$groupKey]
    $threshold = [math]::Ceiling($group.pages.Count * 0.8)
    foreach ($id in $renderingIds) {
        $count = @($group.pages.Values | Where-Object { $_.used.Contains($id) }).Count
        Write-KajooRecord 'coverage.jsonl' ([ordered]@{type='frequency'; renderingId=$id; name=$namesById[$id]; pageCount=$count; isGlobal=($group.pages.Count -gt 0 -and $count -ge $threshold); language=$group.language; version=$group.version; deviceId=$group.deviceId})
    }
    $uncovered = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($id in $renderingIds) { [void]$uncovered.Add($id) }
    $cumulative = 0
    while ($uncovered.Count -gt 0) {
        $bestPage = $null; $bestIds = @()
        foreach ($entry in ($group.pages.Values | Sort-Object { $_.item.Paths.FullPath }, { [string]$_.item.Version })) {
            $newIds = @($entry.used | Where-Object { $uncovered.Contains($_) } | Sort-Object)
            if ($newIds.Count -gt $bestIds.Count) { $bestPage = $entry.item; $bestIds = $newIds }
        }
        if ($null -eq $bestPage) { break }
        foreach ($id in $bestIds) { [void]$uncovered.Remove($id) }
        $cumulative += $bestIds.Count
        $route = Get-KajooRelativeRoute $bestPage
        if (-not $route) { Add-KajooError ([string]$bestPage.Paths.FullPath) 'LinkManager route unavailable; do not invent a route from the item path' }
        $names = @($bestIds | ForEach-Object { $namesById[$_] })
        Write-KajooRecord 'coverage.jsonl' ([ordered]@{type='coverage'; route=$route; itemId=[string]$bestPage.ID; itemPath=[string]$bestPage.Paths.FullPath; language=$group.language; version=[string]$bestPage.Version; versionScope=$group.version; deviceId=$group.deviceId; renderingIds=@($bestIds); renderingNames=$names; cumulativeCoverage=$cumulative})
    }
    foreach ($id in ($uncovered | Sort-Object)) {
        Write-KajooRecord 'coverage.jsonl' ([ordered]@{type='uncovered'; renderingId=$id; name=$namesById[$id]; language=$group.language; version=$group.version; deviceId=$group.deviceId})
    }
    Write-KajooRecord 'coverage.jsonl' ([ordered]@{type='meta'; totalPages=$group.pages.Count; globalThreshold=$threshold; language=$group.language; version=$group.version; deviceId=$group.deviceId; basis='SPE resolved final presentation'})
}
Complete-KajooExport @{operation='analyze-rendering-coverage'; sitePath=$SitePath; database=$Database; languages=@($Languages); version=$Version; devices=@($deviceIds); renderingCount=$renderingIds.Count; basis='SPE resolved final presentation'}
