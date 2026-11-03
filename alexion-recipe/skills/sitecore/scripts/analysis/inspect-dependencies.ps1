# Read-only dependency graph. Compose with remote-common.ps1. Seeds are structured
# {reference: GUID|absolute item path, kind, recursive?:false, optional?:false}.
# Explicit Database/Languages/Version/Devices and MaxItems bound all source reads.
Set-Location ($Database + ':\sitecore') | Out-Null
if (-not $Seeds -or -not $Devices) { throw 'Seeds and Devices must be explicit non-empty arrays' }
Start-KajooExport 'dependencies'
Write-KajooRecord 'dependency-items.jsonl' $null
Write-KajooRecord 'dependency-edges.jsonl' $null
$queue = [System.Collections.Generic.Queue[object]]::new()
$pending = [System.Collections.Generic.List[object]]::new()
$snapshots = @{}
$expanded = @{}
$lookups = @{}
$unscopedLookups = @{}
$expandedUnavailableContainers = @{}
$catalogs = @{}
$resolvedDevices = @{}
$allDevices = [Sitecore.Configuration.Factory]::GetDatabase($Database).Resources.Devices.GetAll()
foreach ($rawDevice in $Devices) {
    $deviceId = ([guid]([string]$rawDevice).Trim('{}')).ToString('D')
    $matches = @($allDevices | Where-Object { ([string]$_.ID).Trim('{}') -ieq $deviceId })
    if ($matches.Count -ne 1) { throw 'Requested device not found or ambiguous' }
    $resolvedDevices[$deviceId] = $matches[0]
}
function Write-DependencyEdge($Request, [string]$Status, $Extra = $null) {
    $edge = [ordered]@{consumer=$Request.consumer; relation=$Request.relation; raw=$Request.raw; kind=$Request.kind; status=$Status; required=$Request.required}
    if ($null -ne $Request.provenance) {
        foreach ($name in $Request.provenance.Keys) { $edge[$name] = $Request.provenance[$name] }
    }
    if ($null -ne $Extra) { foreach ($name in $Extra.Keys) { $edge[$name] = $Extra[$name] } }
    Write-KajooRecord 'dependency-edges.jsonl' $edge
}
function Add-PendingDependency($Request, [string]$Language, $Item = $null) {
    $row = [ordered]@{reference=$Request.reference; kind=$Request.kind; relation=$Request.relation; consumer=$Request.consumer; recursive=$Request.recursive; required=$Request.required; language=$Language; requestedVersion=$Version}
    if ($null -ne $Request.provenance) { foreach ($name in $Request.provenance.Keys) { $row[$name] = $Request.provenance[$name] } }
    if ($null -ne $Item) { $row.targetId=[string]$Item.ID; $row.targetVersion=[string]$Item.Version }
    $pending.Add($row)
}
function Add-DependencyReference($Consumer, [string]$Relation, [string]$Raw, [string]$Kind, [bool]$Recursive = $false, [bool]$Required = $true, $Provenance = $null) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return }
    if ($Raw -match '^(query:|fast:|local:)' -or $Raw -match '\$\(') {
        Write-DependencyEdge @{consumer=$Consumer; relation=$Relation; raw=$Raw; kind=$Kind; required=$Required; provenance=$Provenance} 'dynamic'
        return
    }
    foreach ($part in $Raw.Split('|')) {
        $reference = $part.Trim()
        if (-not $reference) { continue }
        $isId = $false
        try {
            $parsedId = [guid]$reference.Trim('{}')
            if ($parsedId -eq [guid]::Empty) {
                Write-DependencyEdge @{consumer=$Consumer; relation=$Relation; raw=$part; kind=$Kind; required=$Required; provenance=$Provenance} 'empty' @{reason='all-zero GUID denotes an empty Sitecore reference'}
                continue
            }
            $reference = '{' + $parsedId.ToString('D').ToUpperInvariant() + '}'
            $isId = $true
        } catch { }
        if (-not $isId) {
            try { Assert-KajooItemPath $reference } catch {
                Write-DependencyEdge @{consumer=$Consumer; relation=$Relation; raw=$part; kind=$Kind; required=$Required; provenance=$Provenance} 'unresolved-expression'
                return
            }
        }
        $queue.Enqueue(@{consumer=$Consumer; relation=$Relation; raw=$part; reference=$reference; isId=$isId; kind=$Kind; recursive=$Recursive; required=$Required; provenance=$Provenance})
    }
}
function Get-DependencyKind($Item, [string]$Requested) {
    $path = [string]$Item.Paths.FullPath
    if ($path -like '/sitecore/templates/Branches/*') { return 'branch' }
    if ($path -like '/sitecore/templates/*') { return 'template' }
    if ($path -like '/sitecore/layout/Renderings/*') { return 'rendering' }
    if ($path -like '/sitecore/layout/Layouts/*') { return 'layout' }
    if ($path -like '/sitecore/layout/Placeholder Settings/*') { return 'placeholder' }
    if ($path -like '/sitecore/system/Settings/Services/Rendering Contents Resolvers/*') { return 'resolver' }
    return $Requested
}
$referenceFields = @(
    @('__Base template','base-template','template'), @('Datasource Template','datasource-template','template'),
    @('Parameters Template','parameters-template','template'), @('Datasource Location','datasource-location','datasource'),
    @('Rendering Contents Resolver','resolver','resolver'), @('Allowed Controls','allowed-rendering','rendering'),
    @('Page Design','page-design','sxa'), @('PartialDesigns','partial-design','sxa'),
    @('Base Partial Design','base-partial-design','sxa'), @('Page Designs','page-design','sxa'),
    @('__Originator','branch-originator','branch'), @('Branch','branch','branch'),
    @('Modules','module','sxa'), @('Site Modules','module','sxa')
)
$platformMetadataReferenceFields = @('Page Editor Buttons', 'Property Editor', 'Preview publishing targets')
foreach ($seed in $Seeds) {
    if (-not $seed.reference -or -not $seed.kind) { throw 'Every dependency seed needs reference and kind' }
    try { $null = [guid]([string]$seed.reference).Trim('{}') } catch { Assert-KajooItemPath ([string]$seed.reference) }
    Add-DependencyReference $null 'seed' ([string]$seed.reference) ([string]$seed.kind) ([bool]$seed.recursive) (-not [bool]$seed.optional)
}
while ($queue.Count -gt 0) {
    if ($script:kajooVisited -ge [int]$MaxItems) { $script:kajooLimited = $true; break }
    $request = $queue.Dequeue()
    $requestLanguages = if ($null -eq $request.consumer) { @($Languages | Sort-Object -Unique) } else { @([string]$request.consumer.language) }
    foreach ($language in $requestLanguages) {
        if ($script:kajooVisited -ge [int]$MaxItems) {
            $script:kajooLimited = $true
            Add-PendingDependency $request $language
            continue
        }
        $lookupKey = $request.reference + ':' + $language + ':' + $Version
        $lookupComplete = $false
        try {
            if (-not $lookups.ContainsKey($lookupKey)) {
                $parameters = @{Path=($Database + ':'); Language=$language; Version=$Version; ErrorAction='Stop'}
                if ($request.isId) { $parameters.ID = $request.reference } else { $parameters.Path += $request.reference }
                $lookups[$lookupKey] = @(Get-Item @parameters)
            }
            $items = @($lookups[$lookupKey])
            $lookupComplete = $true
            if ($items.Count -eq 0) {
                # Distinguish a genuinely absent reference from an item that exists
                # in this database but has no version in the requested language /
                # version scope. The discovery collector resolves many definition
                # and datasource IDs without imposing the content language scope.
                # Keep that compatibility evidence, but never snapshot or traverse
                # an out-of-scope item as though it were in scope.
                $unscopedKey = $request.reference + ':__unscoped__'
                if (-not $unscopedLookups.ContainsKey($unscopedKey)) {
                    $unscopedParameters = @{Path=($Database + ':'); ErrorAction='Stop'}
                    if ($request.isId) { $unscopedParameters.ID = $request.reference } else { $unscopedParameters.Path += $request.reference }
                    $unscopedLookups[$unscopedKey] = @(Get-Item @unscopedParameters)
                }
                $availableItems = @($unscopedLookups[$unscopedKey])
                if ($availableItems.Count -gt 0) {
                    $available = @($availableItems | Sort-Object { [string]$_.ID }, { [string]$_.Language }, { [string]$_.Version } | ForEach-Object {
                        $availableIdentity = Get-KajooIdentity $_
                        [ordered]@{id=$availableIdentity.id; path=$availableIdentity.path; language=$availableIdentity.language; version=$availableIdentity.version}
                    })
                    Write-DependencyEdge $request 'available-outside-scope' @{language=$language; requestedVersion=$Version; available=$available}
                    # Structural folders can be versionless in the requested
                    # language while containing descendants that do have a
                    # requested-language version. Preserve the folder as an
                    # out-of-scope finding, but bridge its descendants back
                    # through normal scoped lookups instead of treating the
                    # folder itself as migratable content.
                    if ($request.recursive) {
                        $containerKey = $request.reference + ':' + $language
                        if (-not $expandedUnavailableContainers.ContainsKey($containerKey)) {
                            $expandedUnavailableContainers[$containerKey] = $true
                            try {
                                foreach ($container in @($availableItems | Sort-Object { [string]$_.Paths.FullPath }, { [string]$_.ID })) {
                                    $containerIdentity = Get-KajooIdentity $container
                                    foreach ($descendant in @($container.Axes.GetDescendants() | Initialize-Item | Sort-Object { [string]$_.Paths.FullPath }, { [string]$_.ID })) {
                                        $descendantPath = [string]$descendant.Paths.FullPath
                                        if (-not $descendantPath.StartsWith($containerIdentity.path + '/', [StringComparison]::OrdinalIgnoreCase)) {
                                            throw 'Descendant escaped unavailable dependency subtree'
                                        }
                                        Add-DependencyReference $request.consumer 'child-through-out-of-scope-container' ([string]$descendant.ID) $request.kind $true $request.required ([ordered]@{containerId=$containerIdentity.id; containerPath=$containerIdentity.path; containerLanguage=$containerIdentity.language; containerVersion=$containerIdentity.version})
                                    }
                                }
                            } catch {
                                Add-KajooError ($request.reference + ':' + $language) 'Unavailable structural container descendants could not be enumerated'
                            }
                        }
                    }
                    continue
                }
                Write-DependencyEdge $request 'missing' @{language=$language}
                if ($request.required) { Add-KajooError $request.reference 'Required dependency was not found in requested language/version' }
                continue
            }
            $orderedItems = @($items | Sort-Object { [string]$_.ID }, { [string]$_.Version })
            for ($itemIndex = 0; $itemIndex -lt $orderedItems.Count; $itemIndex++) {
                $item = $orderedItems[$itemIndex]
                $identity = Get-KajooIdentity $item
                $key = $identity.id + ':' + $identity.language + ':' + $identity.version
                if ($identity.language -ne $language) { throw 'Language fallback was not accepted' }
                if ($identity.version -eq '0' -and $identity.path -like '/sitecore/content/*') { throw 'Requested content version was unavailable' }
                if ($Version -match '^[1-9][0-9]*$' -and $identity.version -ne $Version -and $identity.version -ne '0') { throw 'Version fallback was not accepted' }
                $kind = Get-DependencyKind $item $request.kind
                if (-not $snapshots.ContainsKey($key)) {
                    if ($script:kajooVisited -ge [int]$MaxItems) {
                        $script:kajooLimited = $true
                        for ($remainingIndex = $itemIndex; $remainingIndex -lt $orderedItems.Count; $remainingIndex++) { Add-PendingDependency $request $language $orderedItems[$remainingIndex] }
                        break
                    }
                    $item.Fields.ReadAll()
                    $record = Get-KajooIdentity $item
                    $record.kind = $kind
                    $record.fields = [ordered]@{}
                    $record.fieldTypes = [ordered]@{}
                    $record.fieldDefinitions = @()
                    foreach ($field in $item.Fields) {
                        $record.fields[[string]$field.Name] = [string]$field.Value
                        $record.fieldTypes[[string]$field.Name] = [string]$field.Type
                        $record.fieldDefinitions += [ordered]@{id=[string]$field.ID; name=[string]$field.Name; type=[string]$field.Type; value=[string]$field.Value}
                    }
                    $record.parentId = if ($null -ne $item.Parent) { [string]$item.Parent.ID } else { $null }
                    Write-KajooRecord 'dependency-items.jsonl' $record
                    $snapshots[$key] = $true
                    $script:kajooVisited++
                    $catalogScope = $identity.language + ':' + $identity.version + ':'
                    # The old discovery also retained unused definitions in verified
                    # module catalogs. Expand only the enclosing module, never all
                    # templates or all content as an implicit fallback.
                    if ($identity.path -match '^(/sitecore/templates/(?:Feature|Foundation|Project)/[^/]+)(?:/|$)') {
                        $catalog = $Matches[1]
                        if (-not $catalogs.ContainsKey($catalogScope + $catalog)) {
                            $catalogs[$catalogScope + $catalog] = $true
                            Add-DependencyReference $identity 'template-module' $catalog 'template' $true
                        }
                    }
                    if ($kind -eq 'resolver' -and $null -ne $item.Parent -and $item.Parent.Paths.FullPath -like '/sitecore/system/Settings/Services/Rendering Contents Resolvers/*') {
                        $catalog = [string]$item.Parent.Paths.FullPath
                        if (-not $catalogs.ContainsKey($catalogScope + $catalog)) {
                            $catalogs[$catalogScope + $catalog] = $true
                            Add-DependencyReference $identity 'resolver-catalog' ([string]$item.Parent.ID) 'resolver' $true
                        }
                    }
                    if ($identity.path -match '^/sitecore/layout/Renderings/(Feature|Foundation|Project)/([^/]+)(?:/|$)') {
                        $module = $Matches[1] + '/' + $Matches[2]
                        if (-not $catalogs.ContainsKey($catalogScope + 'module:' + $module)) {
                            $catalogs[$catalogScope + 'module:' + $module] = $true
                            Add-DependencyReference $identity 'module-settings' ('/sitecore/system/Settings/' + $module) 'sxa' $true $false
                            Add-DependencyReference $identity 'module-branch' ('/sitecore/templates/Branches/' + $module) 'branch' $true $false
                        }
                    }
                    Add-DependencyReference $identity 'item-template' ([string]$item.TemplateID) 'template'
                    foreach ($fieldSpec in $referenceFields) {
                        Add-DependencyReference $identity $fieldSpec[1] (Get-KajooField $item $fieldSpec[0]) $fieldSpec[2] ($fieldSpec[1] -eq 'datasource-location')
                    }
                    foreach ($field in $item.Fields) {
                        # Standard Sitecore fields are retained in the item snapshot, but most
                        # describe editor/publishing UI rather than migratable content. A few
                        # editor fields lack the '__' prefix, so exclude those by their canonical names.
                        if (([string]$field.Name).StartsWith('__', [System.StringComparison]::Ordinal) -or
                            [string]$field.Name -in $platformMetadataReferenceFields) { continue }
                        if ([string]$field.Type -match '^(Droplink|Droptree|Multilist|Treelist|TreelistEx|Checklist|Grouped Droplink)$') {
                            Add-DependencyReference $identity ('field-reference:' + $field.Name) ([string]$field.Value) 'content'
                        }
                    }
                    # Follow the branch originator's ancestors to its actual Branch,
                    # then enumerate that scaffold including $name template usages.
                    if ($identity.path -like '/sitecore/templates/Branches/*' -and $item.TemplateName -notin @('Branch','Command Template') -and $null -ne $item.Parent -and $item.Parent.Paths.FullPath -like '/sitecore/templates/Branches/*') {
                        Add-DependencyReference $identity 'branch-ancestor' ([string]$item.Parent.ID) 'branch'
                    }
                    if ((Get-KajooField $item '__Renderings') -or (Get-KajooField $item '__Final Renderings')) {
                        foreach ($deviceId in ($resolvedDevices.Keys | Sort-Object)) {
                            foreach ($occurrence in @(Get-KajooOccurrences $item $resolvedDevices[$deviceId] -Final)) {
                                $provenance = [ordered]@{deviceId=$deviceId; occurrenceUid=$occurrence.uid; occurrenceIndex=$occurrence.index; placeholder=$occurrence.placeholder; parameters=$occurrence.parameters}
                                Add-DependencyReference $identity 'rendering' $occurrence.renderingId 'rendering' $false $true $provenance
                                Add-DependencyReference $identity 'datasource' $occurrence.datasource 'datasource' $true $true $provenance
                            }
                        }
                        foreach ($fieldName in @('__Renderings','__Final Renderings')) {
                            $xml = Get-KajooField $item $fieldName
                            if (-not $xml) { continue }
                            $document = [System.Xml.XmlDocument]::new()
                            $document.XmlResolver = $null
                            if ($xml -match '<!DOCTYPE') { throw 'DTD is not permitted in layout evidence' }
                            $document.LoadXml($xml)
                            foreach ($device in $document.SelectNodes('//*[local-name()="d"]')) {
                                try { $deviceId = ([guid]([string]$device.GetAttribute('id')).Trim('{}')).ToString('D') } catch { continue }
                                if (-not $resolvedDevices.ContainsKey($deviceId)) { continue }
                                foreach ($attribute in $device.Attributes) {
                                    if ($attribute.LocalName -eq 'l') { Add-DependencyReference $identity 'layout' $attribute.Value 'layout' $false $true ([ordered]@{deviceId=$deviceId}) }
                                }
                            }
                        }
                    }
                }
                Write-DependencyEdge $request 'resolved' @{targetId=$identity.id; targetPath=$identity.path; language=$identity.language; version=$identity.version}
                # Template descendants contain sections, field definitions and
                # standard values. Other folders expand only when explicitly seeded.
                $recurse = $request.recursive -or $item.TemplateName -in @('Template','Template section','Branch','Command Template')
                if ($recurse -and -not $expanded.ContainsKey($key)) {
                    $expanded[$key] = $true
                    foreach ($child in @($item.Children | Sort-Object { $_.Paths.FullPath }, { [string]$_.ID })) {
                        if (-not ([string]$child.Paths.FullPath).StartsWith($identity.path + '/', [StringComparison]::OrdinalIgnoreCase)) { throw 'Child escaped requested dependency subtree' }
                        Add-DependencyReference $identity 'child' ([string]$child.ID) $kind $true
                    }
                }
            }
        } catch {
            $missing = -not $lookupComplete -and $_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound
            $status = if ($missing) { 'missing' } else { 'failed' }
            $failureKind = [string]$_.CategoryInfo.Category
            $errorType = if ($_.Exception) { $_.Exception.GetType().FullName } else { 'PowerShell.ErrorRecord' }
            $message = if ($_.Exception -and $_.Exception.Message) { [string]$_.Exception.Message }
                elseif ($_.ErrorDetails -and $_.ErrorDetails.Message) { [string]$_.ErrorDetails.Message }
                else { [string]$_ }
            # Retain useful diagnostics while avoiding credentials embedded in URLs or unbounded exception text.
            $message = ($message -replace '(?i)https?://[^\s/@:]+:[^\s/@]+@', 'https://[redacted]@' `
                -replace '(?i)(https?://[^\s?]+)\?[^\s]+', '$1?[redacted]' `
                -replace '(?i)([?&](?:access_token|token|api[_-]?key|password|sig|code)=)[^&\s]+', '$1[redacted]' `
                -replace '[\r\n\t]+', ' ').Trim()
            if ($message.Length -gt 512) { $message = $message.Substring(0, 512) }
            $errorId = [string]$_.FullyQualifiedErrorId
            if ($errorId.Length -gt 256) { $errorId = $errorId.Substring(0, 256) }
            Write-DependencyEdge $request $status @{language=$language; failureKind=$failureKind; errorType=$errorType; errorId=$errorId; message=$message}
            if (-not $missing -or $request.required) {
                $scope = $request.reference + ' [' + $request.relation + '; language=' + $language + ']'
                Add-KajooError $scope ($status + ' dependency (' + $failureKind + '; ' + $errorType + '): ' + $message)
            }
        }
    }
}
if ($queue.Count -gt 0) {
    foreach ($request in $queue.ToArray()) {
        $requestLanguages = if ($null -eq $request.consumer) { @($Languages | Sort-Object -Unique) } else { @([string]$request.consumer.language) }
        foreach ($language in $requestLanguages) { Add-PendingDependency $request $language }
    }
}
foreach ($row in $pending) { Write-KajooRecord 'dependency-pending.jsonl' $row }
Complete-KajooExport @{operation='inspect-dependencies'; database=$Database; languages=@($Languages); version=$Version; devices=@($Devices); seeds=@($Seeds); remainingRequests=$pending.Count; collection='typed dependency references and explicit subtrees; dynamic expressions retained, not evaluated'}
