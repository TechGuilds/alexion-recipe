# Shared remote target helpers. Loaded by the target SPE entrypoint only.
function Convert-TargetTimestamp($Value) {
    # PowerShell versions differ: JSON timestamps may arrive as strings or DateTime objects.
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTime]) { return ([DateTimeOffset]::new($Value)).ToUniversalTime() }
    $parsed=[DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) { throw 'Invalid execution timestamp' }
    return $parsed.ToUniversalTime()
}
function Get-TargetGuid($Value) {
    $id = [guid]::Empty
    if (-not [guid]::TryParse([string]$Value, [ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid target GUID' }
    return $id.ToString('B').ToUpperInvariant()
}
function Assert-TargetPath($Path) {
    if ([string]$Path -notmatch '^/sitecore/content(?:/[^\\:*?\[\]\p{Cc}]+)?$' -or $Path -match '(^|/)\.\.?(/|$)|//|/$') { throw 'Unsafe target content path' }
    if ($Path -ine $core.target.rootPath -and -not $Path.StartsWith($core.target.rootPath + '/', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target path outside approved root' }
}
function Get-TargetHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Get-TargetFileRecord($File) {
    $full = [IO.Path]::GetFullPath($File)
    if (-not $full.StartsWith($dataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact outside DataFolder' }
    $stream=[IO.File]::OpenRead($full); $sha=[Security.Cryptography.SHA256]::Create()
    try { $digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant(); $length=$stream.Length }
    finally { $sha.Dispose(); $stream.Dispose() }
    return @{path=$full.Substring($dataRoot.Length + 1).Replace('\','/');sha256=$digest;bytes=$length}
}
function Write-TargetDurable($Path, $Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 70 -Compress) + "`n")
    $stream = [IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Get-TargetItem($Value, $Language, $Version) {
    $parameters = @{Path=($core.target.database + ':' + $Value);ErrorAction='Stop'}
    if ($Language) { $parameters.Language=$Language }
    if ($Version) { $parameters.Version=[string]$Version }
    try { $found = @(Get-Item @parameters) }
    catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return $null }; throw }
    if ($found.Count -gt 1) { throw 'Ambiguous target lookup' }
    if ($found.Count) { return $found[0] }
    return $null
}
function Get-TargetObservation($Item, $Spec) {
    if ($null -eq $Item) { throw 'Target observation item absent' }
    $all = @(Get-Item -Path ($core.target.database + ':' + (Get-TargetGuid $Item.ID)) -Language '*' -Version '*' -ErrorAction Stop)
    $versions = @($all | Where-Object { [int][string]$_.Version -gt 0 } | ForEach-Object { @{language=[string]$_.Language;version=[int][string]$_.Version} } | Sort-Object { $_.language }, { $_.version })
    $fields = @()
    foreach ($selected in @($Spec.fields)) {
        $versionItem = $Item
        if ($selected.storage -eq 'unversioned') {
            $versionItem = @($all | Where-Object { [string]$_.Language -ceq $selected.language } | Select-Object -First 1)
            if (-not $versionItem.Count) { $versionItem = Get-TargetItem (Get-TargetGuid $Item.ID) $selected.language '1' } else { $versionItem=$versionItem[0] }
        } elseif ($selected.storage -eq 'versioned') { $versionItem = Get-TargetItem (Get-TargetGuid $Item.ID) $selected.language $selected.version }
        $field = if ($null -ne $versionItem) { $versionItem.Fields[[Sitecore.Data.ID]::Parse((Get-TargetGuid $selected.fieldId))] } else { $null }
        $row = [ordered]@{fieldId=(Get-TargetGuid $selected.fieldId);storage=$selected.storage;present=($null -ne $field)}
        if ($selected.storage -ne 'shared') { $row.language=[string]$selected.language }
        if ($selected.storage -eq 'versioned') { $row.version=[int]$selected.version }
        if ($null -ne $field) {
            $storage = if ($field.Shared) { 'shared' } elseif ($field.Unversioned) { 'unversioned' } else { 'versioned' }
            if ($storage -ne $selected.storage) { throw 'Target field storage drift' }
            $row.value=[string]$field.Value
        }
        $fields += $row
    }
    return [ordered]@{id=(Get-TargetGuid $Item.ID);templateId=(Get-TargetGuid $Item.TemplateID);path=[string]$Item.Paths.FullPath;versionsComplete=$true;versions=$versions;fields=$fields}
}
function Get-TargetObservationKey($Observation) {
    $versions = @($Observation.versions | ForEach-Object { [string]$_.language + '|' + [int]$_.version } | Sort-Object)
    $fields = @($Observation.fields | ForEach-Object { @((Get-TargetGuid $_.fieldId),$_.storage,$_.language,$_.version,[bool]$_.present,$_.value) | ConvertTo-Json -Compress } | Sort-Object)
    return (@((Get-TargetGuid $Observation.id),(Get-TargetGuid $Observation.templateId),[string]$Observation.path,[bool]$Observation.versionsComplete,$versions,$fields) | ConvertTo-Json -Depth 30 -Compress)
}
function Assert-TargetObservation($Item, $Expected) {
    $actual = Get-TargetObservation $Item $Expected
    if ((Get-TargetObservationKey $actual) -cne (Get-TargetObservationKey $Expected)) { throw 'Target observation drift' }
    return $actual
}
function Assert-TargetGuard($Guard) {
    if ($Guard.lookup -notin @('id','path')) { throw 'Unsupported target guard' }
    $item = Get-TargetItem $Guard.value
    if ([bool]$Guard.exists -ne ($null -ne $item)) { throw 'Target existence drift' }
    if ($Guard.exists) { $null = Assert-TargetObservation $item $Guard.item }
}
function Get-TargetBaseTemplateIds($Definition, $Ancestors) {
    if (@($Ancestors).Count -gt 64) { throw 'Target template inheritance depth exceeded' }
    foreach ($base in @($Definition.BaseTemplates)) {
        $id=Get-TargetGuid $base.ID
        if ($id -in $Ancestors) { throw 'Target template inheritance cycle' }
        $id
        Get-TargetBaseTemplateIds $base (@($Ancestors) + @($id))
    }
}
function Assert-TargetTemplates {
    foreach ($template in @($core.templates)) {
        if ($template.kind -notin @('content','datasource','folder')) { throw 'Only content and folder templates may be used' }
        $item = Get-TargetItem (Get-TargetGuid $template.id)
        if ($null -eq $item -or [string]$item.Paths.FullPath -cne $template.path -or [string]$item.Name -cne $template.name) { throw 'Target template identity drift' }
        # Resolve the effective template (including inherited fields) before inspecting SDK field definitions.
        $effective = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($item.ID, $item.Database)
        if ($null -eq $effective) { throw 'Effective target template unavailable' }
        $effectiveFields = @($effective.GetFields())
        $definition = New-Object Sitecore.Data.Items.TemplateItem -ArgumentList $item
        $actualBases=@(Get-TargetBaseTemplateIds $definition @((Get-TargetGuid $template.id)) | Sort-Object -Unique)
        $approvedBases=@($template.baseTemplateIds | ForEach-Object { Get-TargetGuid $_ } | Sort-Object -Unique)
        if (($actualBases | ConvertTo-Json -Compress) -cne ($approvedBases | ConvertTo-Json -Compress)) { throw 'Target transitive base template IDs drift' }
        $actual = @($definition.GetFields())
        $expected = @($template.fields)
        if ($actual.Count -ne $expected.Count -or $effectiveFields.Count -ne $expected.Count) { throw 'Effective target template field count drift' }
        foreach ($spec in $expected) {
            $match = @($actual | Where-Object { (Get-TargetGuid $_.ID) -eq (Get-TargetGuid $spec.id) })
            if ($match.Count -ne 1) { throw 'Effective target template field drift' }
            if (@($effectiveFields | Where-Object { (Get-TargetGuid $_.ID) -eq (Get-TargetGuid $spec.id) }).Count -ne 1) { throw 'Effective target template field ID drift' }
            $field=$match[0]
            $storage=if ($field.Shared) { 'shared' } elseif ($field.Unversioned) { 'unversioned' } else { 'versioned' }
            if ([string]$field.Name -cne $spec.name -or [string]$field.Type -ine $spec.type -or $storage -ne $spec.storage -or (Get-TargetGuid $field.InnerItem.Parent.Parent.ID) -ne (Get-TargetGuid $spec.declaringTemplateId)) { throw 'Target template field metadata drift' }
        }
    }
}
function Assert-TargetVersions($Operation, $Existing) {
    $seen=@{}
    foreach ($version in @($Existing)) { $seen[[string]$version.language] = [Math]::Max([int]$seen[[string]$version.language],[int]$version.version) }
    $new=@($Operation.versionsToCreate | Sort-Object language, version)
    if ($Operation.action -eq 'create' -and $Operation.kind -eq 'folder') { $new=@(@{language=$core.structuralLanguage;version=1}) }
    foreach ($version in $new) {
        if ([string]$version.language -notmatch '^[a-zA-Z][a-zA-Z0-9-]{0,34}$' -or [int]$version.version -ne ([int]$seen[[string]$version.language] + 1)) { throw 'Version creation must be exact and contiguous' }
        $seen[[string]$version.language]=[int]$version.version
    }
    if ($Operation.action -eq 'create' -and -not $new.Count) { throw 'Create requires an explicit initial version' }
    $actualAfter=@(@($Existing) + @($new) | ForEach-Object { [string]$_.language + '|' + [int]$_.version } | Sort-Object)
    $approvedAfter=@($Operation.expectedPost.versions | ForEach-Object { [string]$_.language + '|' + [int]$_.version } | Sort-Object)
    if (($actualAfter | ConvertTo-Json -Compress) -cne ($approvedAfter | ConvertTo-Json -Compress)) { throw 'Expected post versions differ from observed versions and approved additions' }
    return $new
}
function Assert-TargetOperation($Operation) {
    Assert-TargetPath $Operation.targetPath
    if ($Operation.operationId -notmatch '^op-[a-f0-9]{24}$' -or $Operation.action -notin @('create','update') -or $Operation.kind -notin @('content','folder')) { throw 'Unsupported target operation' }
    if ($core.operationKind -eq 'references' -and ($Operation.action -cne 'update' -or $Operation.kind -cne 'content' -or @($Operation.versionsToCreate).Count)) { throw 'Reference execution only updates existing content without version additions' }
    $null=Get-TargetGuid $Operation.targetItemId; $null=Get-TargetGuid $Operation.parentItemId
    $template=@($core.templates | Where-Object { (Get-TargetGuid $_.id) -eq (Get-TargetGuid $Operation.templateId) })
    if ($template.Count -ne 1) { throw 'Operation template absent from approved evidence' }
    $forbiddenTemplates=@('{AB86861A-6030-46C5-B394-E8F99E8B87DB}','{455A3E98-A627-4B40-8035-E683A0331AC7}','{E269FBB5-3750-427A-9149-7AA950B49301}','{99F8905D-4A87-4EB8-9F8B-A9BEBFB3ADD6}','{2A3E91A0-7987-4B44-AB34-35C2D9D4F814}')
    foreach ($templateId in @($template[0].id) + @($template[0].baseTemplateIds)) { if ((Get-TargetGuid $templateId) -in $forbiddenTemplates) { throw 'Template and rendering definitions cannot be written' } }
    foreach ($field in @($Operation.fields)) {
        $definition=@($template[0].fields | Where-Object { (Get-TargetGuid $_.id) -eq (Get-TargetGuid $field.fieldId) })
        if ($definition.Count -ne 1 -or $definition[0].storage -ne $field.storage -or $definition[0].type -match '^(?i:blob|attachment|layout)$' -or $definition[0].name -match '^__(?i:(?:final\s*)?renderings|security|lock|workflow(?: state)?|created(?: by)?|updated(?: by)?)$') { throw 'Field is outside writable content scope' }
        if ($core.operationKind -eq 'references') { Assert-TargetReferenceValue $field.value $definition[0].type }
        if ($field.storage -notin @('shared','unversioned','versioned') -or ($field.storage -ne 'shared' -and -not $field.language) -or ($field.storage -eq 'versioned' -and [int]$field.version -lt 1)) { throw 'Invalid field language/version scope' }
        $post=@($Operation.expectedPost.fields | Where-Object { (Get-TargetGuid $_.fieldId) -eq (Get-TargetGuid $field.fieldId) -and $_.storage -eq $field.storage -and $_.language -ceq $field.language -and $_.version -eq $field.version -and $_.present -eq $true -and $_.value -ceq $field.value })
        if ($post.Count -ne 1) { throw 'Written field lacks exact approved postcondition' }
    }
    if ((Get-TargetGuid $Operation.expectedPost.id) -ne (Get-TargetGuid $Operation.targetItemId) -or (Get-TargetGuid $Operation.expectedPost.templateId) -ne (Get-TargetGuid $Operation.templateId) -or $Operation.expectedPost.path -cne $Operation.targetPath -or $Operation.expectedPost.versionsComplete -ne $true) { throw 'Invalid expected target identity' }
}

function Assert-TargetReferenceValue($Value, $Type) {
    if ($Value -isnot [string]) { throw 'Reference field requires a raw string' }
    $typeName=([string]$Type).Trim().ToLowerInvariant()
    $lists=@('multilist','multilist with search','checklist','treelist','treelistex')
    $singles=@('internal link','droplink','droptree','grouped droplink')
    if ($typeName -notin ($lists + $singles + @('general link','general link with search','image','file'))) { throw 'Unsupported reference field type' }
    if ($Value -ceq '') { return }
    $ids=@()
    $guidPattern='^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'
    if ($typeName -in ($lists + $singles)) {
        $ids=@($Value.Split('|'))
        if ($typeName -in $singles -and $ids.Count -ne 1) { throw 'Single reference requires one GUID' }
    } else {
        $tag=if ($typeName -in @('general link','general link with search')) { 'link' } elseif ($typeName -eq 'file') { 'file' } else { 'image' }
        $pattern='^\s*<' + $tag + '((?:\s+[a-zA-Z_][a-zA-Z0-9_.-]*\s*=\s*(?:"[^"]*"|''[^'']*''))*)\s*/>\s*$'
        if (-not [regex]::IsMatch($Value,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)) { throw 'Unsupported reference XML format' }
        $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
        $reader=$null
        try {
            $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Value),$settings)
            $document=[Xml.XmlDocument]::new();$document.XmlResolver=$null;$document.Load($reader)
            $name=if ($tag -eq 'link') { 'id' } else { 'mediaid' }
            # Validate the raw slot, not an entity-decoded or whitespace-normalized XML value.
            $attributes=@([regex]::Matches($Value,'([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=\s*(?:"([^"]*)"|''([^'']*)'')') | Where-Object { $_.Groups[1].Value -ceq $name })
            if ($attributes.Count) {
                $attribute=$attributes[0];$raw=if ($attribute.Groups[2].Success) { $attribute.Groups[2].Value } else { $attribute.Groups[3].Value }
                if ($raw -cne '') { $ids=@($raw) }
            }
        } finally { if ($reader) { $reader.Dispose() } }
    }
    foreach ($id in $ids) {
        if (-not [regex]::IsMatch($id,$guidPattern)) { throw 'Reference slot requires a complete braced GUID' }
        $normalized=Get-TargetGuid $id
        if (-not @($core.referenceBindings | Where-Object { (Get-TargetGuid $_.targetItemId) -eq $normalized }).Count) { throw 'Reference target has no reviewed binding' }
    }
}

function Assert-TargetReferenceBindings {
    if ($core.referenceBindings -isnot [array] -or $core.referenceGuards -isnot [array]) { throw 'Reference bindings and guards arrays are required' }
    $seen=@{}
    foreach ($binding in @($core.referenceBindings)) {
        $id=Get-TargetGuid $binding.targetItemId
        $null=Get-TargetGuid $binding.sourceItemId;$null=Get-TargetGuid $binding.templateId
        if ($binding.existing -isnot [bool] -or $binding.targetPath -notmatch '^/sitecore/(?:content|media library)(?:/[^\\:*?\[\]\p{Cc}]+)?$' -or $binding.targetPath -match '(^|/)\.\.?(/|$)|//|/$') { throw 'Invalid reference binding metadata' }
        if ($seen.ContainsKey($id)) { throw 'Duplicate reference target binding' };$seen[$id]=$true
        $guards=@($core.referenceGuards | Where-Object { $_.item -and (Get-TargetGuid $_.item.id) -eq $id })
        if (@($guards | Where-Object lookup -CEQ 'id').Count -ne 1 -or @($guards | Where-Object lookup -CEQ 'path').Count -ne 1 -or $guards.Count -ne 2) { throw 'Every reference binding requires exact ID and path guards' }
        foreach ($guard in $guards) {
            if ($guard.exists -isnot [bool] -or $guard.exists -ne $true -or (Get-TargetGuid $guard.item.templateId) -ne (Get-TargetGuid $binding.templateId) -or $guard.item.path -cne $binding.targetPath -or ($guard.lookup -ceq 'id' -and (Get-TargetGuid $guard.value) -ne $id) -or ($guard.lookup -ceq 'path' -and $guard.value -cne $binding.targetPath)) { throw 'Reference guard differs from binding metadata' }
        }
        if ((Get-TargetObservationKey $guards[0].item) -cne (Get-TargetObservationKey $guards[1].item)) { throw 'Reference ID and path observations differ' }
    }
    foreach ($guard in @($core.referenceGuards)) {
        if ($guard.lookup -cnotin @('id','path') -or $guard.exists -ne $true -or -not $guard.item -or -not $seen.ContainsKey((Get-TargetGuid $guard.item.id))) { throw 'Reference guard lacks an exact binding' }
    }
}

function Assert-TargetReferenceGuards {
    foreach ($guard in @($core.referenceGuards)) {
        $written=@($receipt.results | Where-Object { $_.status -eq 'success' -and (Get-TargetGuid $_.targetItemId) -eq (Get-TargetGuid $guard.item.id) })
        if ($written.Count) { Assert-TargetGuard ([pscustomobject]@{lookup=$guard.lookup;value=$guard.value;exists=$true;item=$written[-1].post}) }
        else { Assert-TargetGuard $guard }
    }
}
