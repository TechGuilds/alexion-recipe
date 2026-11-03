# Prepend to one analysis/capture entrypoint using prepare-request.mjs.
# SPE executes this in the authenticated source session. No content mutations.
$ErrorActionPreference = 'Stop'
if (-not $Database) { $Database = 'master' }
if ($Database -notmatch '^[a-zA-Z][a-zA-Z0-9_-]*$') { throw 'Invalid database name' }
if (-not $Languages) { $Languages = @('en') }
if ($Languages -is [string]) { $Languages = @($Languages) }
if (-not $Version) { $Version = 'latest' }
if ($null -eq $MaxItems) { $MaxItems = 10000 }
if ([string]$MaxItems -notmatch '^[1-9][0-9]*$' -or [long]$MaxItems -gt [int]::MaxValue) { throw 'MaxItems must be a positive integer' }
$script:kajooErrors = [System.Collections.Generic.List[object]]::new()
$script:kajooFiles = [System.Collections.Generic.List[object]]::new()
$script:kajooWriters = @{}
$script:kajooVisited = 0
$script:kajooLimited = $false

function Assert-KajooItemPath([string]$Path) {
    # Paths arrive as structured values, never executable source. Permit real item
    # punctuation (apostrophes, commas, ampersands, Unicode), but not provider
    # switches, wildcard expansion, control characters or traversal.
    if ($Path -notmatch '^/sitecore/[^\\:*?\[\]\p{Cc}]+$' -or $Path -match '(^|/)\.\.?(/|$)|//|/$') {
        throw 'Expected an explicit Sitecore item path without traversal'
    }
}
function Add-KajooError([string]$Scope, [string]$Message) {
    # Do not serialize exception stacks/request URLs that may contain credentials.
    $script:kajooErrors.Add([ordered]@{scope=$Scope; message=$Message})
}
function Start-KajooExport([string]$Operation) {
    $script:kajooRelative = 'kajoo/skills/' + $Operation + '-' + [guid]::NewGuid().ToString('N')
    $dataRoot = [Sitecore.MainUtil]::MapPath([Sitecore.Configuration.Settings]::DataFolder)
    if ([string]::IsNullOrWhiteSpace($dataRoot) -or -not [IO.Path]::IsPathRooted($dataRoot)) { throw 'Sitecore DataFolder could not be resolved to a physical directory' }
    $script:kajooDirectory = [IO.Path]::Combine($dataRoot, $script:kajooRelative)
    [void][IO.Directory]::CreateDirectory($script:kajooDirectory)
}
function Write-KajooRecord([string]$Name, $Record) {
    if ($Name -notmatch '^[a-z][a-z0-9-]*\.jsonl$') { throw 'Invalid export filename' }
    if (-not $script:kajooWriters.ContainsKey($Name)) {
        $path = [IO.Path]::Combine($script:kajooDirectory, $Name)
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $script:kajooWriters[$Name] = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    }
    if ($null -ne $Record) { $script:kajooWriters[$Name].WriteLine(($Record | ConvertTo-Json -Depth 40 -Compress)) }
}
function Complete-KajooExport($Details) {
    try {
        foreach ($issue in $script:kajooErrors) { Write-KajooRecord 'errors.jsonl' $issue }
    } finally {
        foreach ($writer in $script:kajooWriters.Values) { $writer.Dispose() }
    }
    foreach ($file in ([IO.DirectoryInfo]::new($script:kajooDirectory).GetFiles() | Sort-Object Name)) {
        $script:kajooFiles.Add([ordered]@{rootPath='Data'; path=$script:kajooRelative + '/' + $file.Name; name=$file.Name; size=$file.Length})
    }
    [ordered]@{
        kind='kajoo-export'; version=1; files=@($script:kajooFiles.ToArray())
        summary=[ordered]@{visited=$script:kajooVisited; partial=($script:kajooLimited -or $script:kajooErrors.Count -gt 0); limited=$script:kajooLimited; errorCount=$script:kajooErrors.Count; scope=$Details}
    } | ConvertTo-Json -Depth 12 -Compress
}
function Get-KajooField($Item, [string]$Name) {
    $field = $Item.Fields[$Name]
    if ($null -eq $field) { return $null }
    return [string]$field.Value
}
function Get-KajooIdentity($Item) {
    [ordered]@{id=[string]$Item.ID; path=[string]$Item.Paths.FullPath; name=[string]$Item.Name; templateId=[string]$Item.TemplateID; templateName=[string]$Item.TemplateName; language=[string]$Item.Language; version=[string]$Item.Version}
}
function Test-KajooRequestedLanguageHasVersion($Item) {
    # Axes.GetDescendants() can expose a structural item under the root's
    # language context even when that item has no version in that language.
    # Item.Version alone is not sufficient evidence in that case. Only omit a
    # row when Sitecore explicitly reports zero versions; preserve compatibility
    # with lightweight providers that do not expose Item.Versions.
    $versionsProperty = $Item.PSObject.Properties['Versions']
    if ($null -eq $versionsProperty -or $null -eq $versionsProperty.Value) { return $true }
    try { return [int]$versionsProperty.Value.Count -gt 0 } catch { return $true }
}
function Read-KajooItems([string[]]$Roots, [switch]$Recurse) {
    if (-not $Roots -or $Roots.Count -eq 0) { throw 'At least one explicit item path is required' }
    foreach ($path in $Roots) { Assert-KajooItemPath $path }
    $seenPaths = @{}
    $seenItems = @{}
    foreach ($rootPath in ($Roots | Sort-Object -Unique)) {
        $rootPath = $rootPath.TrimEnd('/')
        foreach ($language in ($Languages | Sort-Object -Unique)) {
            if ($script:kajooVisited -ge [int]$MaxItems) { $script:kajooLimited = $true; return }
            $rootItems = @()
            try {
                $rootItems = @(Get-Item -Path ($Database + ':' + $rootPath) -Language $language -Version $Version -ErrorAction Stop)
            } catch {
                Add-KajooError ($rootPath + ':' + $language) 'Item enumeration failed; inspect SPE access and version scope'
                continue
            }
            if ($rootItems.Count -eq 0) {
                Add-KajooError ($rootPath + ':' + $language) 'Item or language/version not found'
                continue
            }

# Use a broad-scan optimization for the common latest
            # version case: Sitecore returns the full descendant set in one cached
            # traversal, and Initialize-Item makes its fields available locally.
            # The explicitly scoped root supplies language context; reject any
            # descendant that does not preserve that context or a real version.
            if ($Recurse -and $Version -eq 'latest') {
                $descendants = @()
                try {
                    $descendants = @($rootItems[0].Axes.GetDescendants() | Initialize-Item)
                } catch {
                    Add-KajooError ($rootPath + ':' + $language) 'Descendant enumeration failed; inspect SPE access and source tree'
                }
                $scopedItems = @($rootItems) + @($descendants)
                foreach ($item in ($scopedItems | Sort-Object { [string]$_.Paths.FullPath }, { [string]$_.Version })) {
                    $path = [string]$item.Paths.FullPath
                    if ($path -ne $rootPath -and -not $path.StartsWith($rootPath + '/', [StringComparison]::OrdinalIgnoreCase)) {
                        Add-KajooError ($rootPath + ':' + $language) 'Descendant escaped requested subtree'
                        break
                    }
                    # The axis can expose a tree node with no version in this
                    # language. It is not a fallback row and is omitted just as
                    # Get-ChildItem -Language omits it in the compatibility path.
                    if ([string]$item.Language -ne [string]$language -or [string]$item.Version -eq '0' -or -not (Test-KajooRequestedLanguageHasVersion $item)) { continue }
                    $pathKey = $language + ':' + $path
                    $key = [string]$item.ID + ':' + [string]$item.Language + ':' + [string]$item.Version
                    if ($seenPaths.ContainsKey($pathKey) -or $seenItems.ContainsKey($key)) { continue }
                    if ($script:kajooVisited -ge [int]$MaxItems) { $script:kajooLimited = $true; return }
                    $seenPaths[$pathKey] = $true
                    $seenItems[$key] = $true
                    $script:kajooVisited++
                    Write-Output $item
                }
                continue
            }

            # Keep the original exact item/path traversal for explicit-version
            # and all-version scopes. Those modes must retain their prior matching
            # semantics rather than inherit the root's version context.
            $paths = [System.Collections.Generic.List[string]]::new()
            $paths.Add($rootPath)
            if ($Recurse) {
                try {
                    foreach ($descendant in @($rootItems[0].Axes.GetDescendants())) {
                        $descendantPath = [string]$descendant.Paths.FullPath
                        if (-not $descendantPath.StartsWith($rootPath + '/', [StringComparison]::OrdinalIgnoreCase)) {
                            throw 'Descendant escaped requested subtree'
                        }
                        $paths.Add($descendantPath)
                    }
                } catch {
                    Add-KajooError ($rootPath + ':' + $language) 'Descendant enumeration failed; inspect SPE access and source tree'
                }
            }

            $orderedPaths = @($paths | Sort-Object -Unique)
            for ($pathIndex = 0; $pathIndex -lt $orderedPaths.Count; $pathIndex++) {
                $path = [string]$orderedPaths[$pathIndex]
                $pathKey = $language + ':' + $path
                if ($seenPaths.ContainsKey($pathKey)) { continue }
                $seenPaths[$pathKey] = $true
                if ($script:kajooVisited -ge [int]$MaxItems) {
                    if ($pathIndex -lt $orderedPaths.Count) { $script:kajooLimited = $true }
                    return
                }

                try {
                    $items = if ($path -eq $rootPath) { $rootItems } else { @(Get-Item -Path ($Database + ':' + $path) -Language $language -Version $Version -ErrorAction Stop) }
                    foreach ($item in ($items | Sort-Object { [string]$_.Version })) {
                        if ([string]$item.Language -ne [string]$language -or [string]$item.Version -eq '0' -or -not (Test-KajooRequestedLanguageHasVersion $item)) {
                            Add-KajooError ($path + ':' + $language) 'Requested language/version unavailable; fallback was not accepted'
                            continue
                        }
                        $key = [string]$item.ID + ':' + [string]$item.Language + ':' + [string]$item.Version
                        if ($seenItems.ContainsKey($key)) { continue }
                        if ($script:kajooVisited -ge [int]$MaxItems) { $script:kajooLimited = $true; return }
                        $seenItems[$key] = $true
                        $script:kajooVisited++
                        Write-Output $item
                    }
                } catch {
                    if ($path -eq $rootPath -or $_.CategoryInfo.Category -ne 'ObjectNotFound') {
                        Add-KajooError ($path + ':' + $language) 'Item read failed; inspect SPE access and version scope'
                    }
                }
            }
        }
    }
}
function Get-KajooOccurrences($Item, $Device, [switch]$Final) {
    $index = 0
    foreach ($rendering in @(Get-Rendering -Item $Item -Device $Device -FinalLayout:$Final -ErrorAction Stop)) {
        [ordered]@{index=$index; uid=[string]$rendering.UniqueID; renderingId=[string]$rendering.ItemID; placeholder=[string]$rendering.Placeholder; datasource=[string]$rendering.Datasource; parameters=[string]$rendering.Parameters}
        $index++
    }
}
