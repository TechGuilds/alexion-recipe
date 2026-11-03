# Remote SPE entrypoint. prepare-request.mjs prepends remote-common.ps1.
# Only real Layout Service REST responses are captured; no presentation synthesis.
if ($APIKey -or $Password -or $AccessToken) { throw 'Do not supply credentials; use APIKeyItemPath on the source server' }
if (-not $ApprovedOrigin -or -not $APIKeyItemPath -or -not $Routes) { throw 'ApprovedOrigin, APIKeyItemPath and Routes must be explicit' }
if ($Mode -ne 'delivery' -or $Device -ne 'site-default' -or $Version -ne 'latest' -or $Devices) {
    throw 'Supported scope is Mode=delivery, Device=site-default, Version=latest; editing, device overrides and numbered versions are unsupported'
}
if ($null -eq $TimeoutSeconds) { $TimeoutSeconds = 30 }
if ($null -eq $MaxResponseBytes) { $MaxResponseBytes = 67108864 }
if ([double]$TimeoutSeconds -ne [int]$TimeoutSeconds -or [int]$TimeoutSeconds -lt 1 -or [int]$TimeoutSeconds -gt 120) { throw 'TimeoutSeconds must be 1..120' }
$responseLimit = [long]0
if ([string]$MaxResponseBytes -notmatch '^[1-9][0-9]*$' -or -not [long]::TryParse([string]$MaxResponseBytes, [ref]$responseLimit) -or $responseLimit -gt 9007199254740991) { throw 'MaxResponseBytes must be a positive safe integer' }
$MaxResponseBytes = $responseLimit

$origin = $null
if (-not [uri]::TryCreate([string]$ApprovedOrigin, [UriKind]::Absolute, [ref]$origin)) { throw 'Invalid approved source origin' }
if ($origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/' -or $origin.Scheme -notin @('https','http')) { throw 'Expected an origin only, without credentials, path, query or fragment' }
if ($origin.Scheme -eq 'http' -and -not $origin.IsLoopback) { throw 'Plain HTTP is supported only for same-source loopback; use HTTPS otherwise' }
# Reserved nonsecret connector injection from powershellServerUrl.origin.
# The connector must reject user parameter collisions before creating the session.
# SPEStartScriptSession may have no HttpContext even with background=false.
if ($KajooSourceOrigin -isnot [string] -or -not $KajooSourceOrigin -or $KajooSourceOrigin -cne $origin.GetLeftPart([UriPartial]::Authority)) { throw 'ApprovedOrigin must exactly match connector-injected KajooSourceOrigin; trusted source origin is required' }
Assert-KajooItemPath $APIKeyItemPath
if (-not $APIKeyItemPath.StartsWith('/sitecore/system/Settings/Services/API Keys/', [StringComparison]::Ordinal) -or $APIKeyItemPath.EndsWith('/')) { throw 'APIKeyItemPath must identify an item under the source API Keys folder' }

$matrix = @($Routes)
if ($matrix.Count -lt 1 -or $matrix.Count -gt 10000) { throw 'Routes must contain 1..10000 explicit entries' }
foreach ($row in $matrix) {
    $names = if ($row -is [System.Collections.IDictionary]) { @($row.Keys) } else { @($row.PSObject.Properties.Name) }
    if (@($names | Where-Object { $_ -cnotin @('item','site','language') }).Count -gt 0 -or @($names).Count -ne 3) { throw 'Each route must contain only item, site and language; per-route mode/device/version overrides are unsupported' }
    if ($row.item -isnot [string] -or -not $row.item.StartsWith('/') -or $row.item -match '[?#\\\x00-\x1f]' -or $row.item -match '(^|/)\.\.?(/|$)') { throw 'Route item must be an explicit absolute route path without query, fragment or traversal' }
    if ($row.site -isnot [string] -or $row.site -notmatch '^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$' -or $row.language -isnot [string] -or $row.language -notmatch '^[A-Za-z][A-Za-z0-9-]{0,31}$') { throw 'Each route requires a valid explicit site and language' }
    try { $siteContext = [Sitecore.Sites.SiteContextFactory]::GetSiteContext([string]$row.site) }
    catch { throw 'Cannot resolve source site configuration' }
    if ($null -eq $siteContext -or $siteContext.Name -cne $row.site -or $siteContext.Database.Name -cne $Database) { throw 'Route site must exist and its configured delivery database must match Database; database override is unsupported' }
}

try {
    $keyItem = Get-Item -Path ('master:' + $APIKeyItemPath) -ErrorAction Stop
    if ($null -eq $keyItem -or [string]$keyItem.Paths.FullPath -cne $APIKeyItemPath) { throw 'Invalid key item' }
    $keyGuid = [guid]::Empty
    if (-not [guid]::TryParse([string]$keyItem.ID, [ref]$keyGuid) -or $keyGuid -eq [guid]::Empty) { throw 'Invalid key item ID' }
    $layoutApiKey = $keyGuid.ToString('D')
} catch { throw 'Source API key item lookup failed; inspect item path and SPE access on the source server' }

Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$handler.UseCookies = $false
$handler.UseDefaultCredentials = $false
$handler.UseProxy = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
$client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
$endpoint = '/sitecore/api/layout/render/jss'
$seen = @{}
$succeeded = 0
$failed = 0
Start-KajooExport 'layouts'
Write-KajooRecord 'layouts.jsonl' $null
try {
    for ($index = 0; $index -lt $matrix.Count; $index++) {
        $row = $matrix[$index]
        $record = [ordered]@{
            index=$index; item=[string]$row.item; site=[string]$row.site; language=[string]$row.language
            database=$Database; version='latest'; mode='delivery'; device='site-default'
            origin=$origin.GetLeftPart([UriPartial]::Authority); endpoint=$endpoint
            authentication='source-api-key-item'; status=$null; success=$false; error=$null
            rawFile=$null; sha256=$null; bytes=0
        }
        $identity = [string]$row.site + [char]0 + [string]$row.language + [char]0 + [string]$row.item
        $rawPath = $null
        $request = $null
        $response = $null
        $inputStream = $null
        $outputStream = $null
        $cancel = $null
        try {
            if ($seen.ContainsKey($identity)) { $record.error='duplicate-route'; throw 'Route rejected' }
            $seen[$identity] = $true
            if ($script:kajooVisited -ge [int]$MaxItems) { $script:kajooLimited=$true; $record.error='route-limit'; throw 'Route rejected' }
            $script:kajooVisited++
            $query = 'item=' + [uri]::EscapeDataString([string]$row.item) + '&sc_site=' + [uri]::EscapeDataString([string]$row.site) + '&sc_lang=' + [uri]::EscapeDataString([string]$row.language) + '&sc_apikey=' + [uri]::EscapeDataString($layoutApiKey)
            $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, ($record.origin + $endpoint + '?' + $query))
            $cancel = [Threading.CancellationTokenSource]::new()
            $cancel.CancelAfter([TimeSpan]::FromSeconds([int]$TimeoutSeconds))
            $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
            $record.status = [int]$response.StatusCode
            if ($record.status -ge 300 -and $record.status -lt 400) { $record.error='redirect'; throw 'Route rejected' }
            if ($record.status -ne 200) { $record.error='http-status'; throw 'Route rejected' }
            $mediaType = [string]$response.Content.Headers.ContentType.MediaType
            if ($mediaType -notmatch '^application/(?:json|[a-z0-9.+-]+\+json)$') { $record.error='non-json-content'; throw 'Route rejected' }
            if ($response.Content.Headers.ContentLength -gt [long]$MaxResponseBytes) { $record.error='body-limit'; throw 'Route rejected' }
            $rawName = 'layout-' + ($index + 1).ToString('D6') + '.json'
            $rawPath = [IO.Path]::Combine($script:kajooDirectory, $rawName)
            $outputStream = [IO.File]::Open($rawPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $buffer = [byte[]]::new(65536)
            $pending = [byte[]]::new(0)
            # Retain a tail across chunks so an echoed credential cannot be split
            # across writes. No body, reason phrase, URL or exception is logged.
            $secrets = @($layoutApiKey.ToLowerInvariant(), $keyGuid.ToString('N').ToLowerInvariant())
            while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
                $record.bytes += $count
                if ($record.bytes -gt [long]$MaxResponseBytes) { $record.error='body-limit'; throw 'Route rejected' }
                $combined = [byte[]]::new($pending.Length + $count)
                [Array]::Copy($pending, 0, $combined, 0, $pending.Length)
                [Array]::Copy($buffer, 0, $combined, $pending.Length, $count)
                $ascii = ([regex]::Replace([Text.Encoding]::ASCII.GetString($combined), '\\u([0-9a-fA-F]{4})', { param($match) [string][char][Convert]::ToInt32($match.Groups[1].Value,16) })).ToLowerInvariant()
                foreach ($secret in $secrets) {
                    if ($ascii.Contains($secret)) { $record.error='credential-in-response'; throw 'Route rejected' }
                }
                $writeCount = [Math]::Max(0, $combined.Length - 1024)
                if ($writeCount -gt 0) { $outputStream.Write($combined, 0, $writeCount) }
                $pending = [byte[]]::new($combined.Length - $writeCount)
                [Array]::Copy($combined, $writeCount, $pending, 0, $pending.Length)
            }
            if ($pending.Length -gt 0) { $outputStream.Write($pending, 0, $pending.Length) }
            $outputStream.Dispose(); $outputStream=$null
            try {
                $rawText = [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($rawPath))
                $layout = $rawText | ConvertFrom-Json -ErrorAction Stop
            } catch { $record.error='invalid-json'; throw 'Route rejected' }
            # Detect JSON-escaped credential echoes before exposing an artifact.
            $decoded = ([regex]::Replace($rawText, '\\u([0-9a-fA-F]{4})', { param($match) [string][char][Convert]::ToInt32($match.Groups[1].Value,16) })).ToLowerInvariant()
            foreach ($secret in $secrets) {
                if ($decoded.Contains($secret)) { $record.error='credential-in-response'; throw 'Route rejected' }
            }
            if ($null -eq $layout.sitecore.route) { $record.error='null-route' }
            elseif ($null -ne $layout.error -or $null -ne $layout.errors -or $layout.sitecore.context -isnot [pscustomobject] -or $layout.sitecore.route -isnot [pscustomobject] -or $layout.sitecore.route.fields -isnot [pscustomobject] -or $layout.sitecore.route.placeholders -isnot [pscustomobject]) { $record.error='invalid-layout' }
            $hashStream = [IO.File]::OpenRead($rawPath)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $record.sha256 = ([BitConverter]::ToString($sha.ComputeHash($hashStream))).Replace('-','').ToLowerInvariant() }
            finally { $hashStream.Dispose(); $sha.Dispose() }
            $record.rawFile = $rawName
            if (-not $record.error) { $record.success=$true; $succeeded++ }
        } catch {
            if (-not $record.error) {
                if ($null -ne $cancel -and $cancel.IsCancellationRequested) { $record.error='timeout' }
                else { $record.error='request-or-stream-failed' }
            }
        } finally {
            if ($null -ne $outputStream) { $outputStream.Dispose() }
            if ($null -ne $inputStream) { $inputStream.Dispose() }
            if ($null -ne $response) { $response.Dispose() }
            if ($null -ne $request) { $request.Dispose() }
            if ($null -ne $cancel) { $cancel.Dispose() }
            if ($rawPath -and -not $record.rawFile -and [IO.File]::Exists($rawPath)) { [IO.File]::Delete($rawPath) }
        }
        if (-not $record.success) { $failed++; Add-KajooError ('route-' + $index) $record.error }
        Write-KajooRecord 'layouts.jsonl' $record
    }
    Write-KajooRecord 'capture-summary.jsonl' ([ordered]@{kind='layout-capture'; version=1; total=$matrix.Count; succeeded=$succeeded; failed=$failed; partial=($failed -gt 0 -or $script:kajooLimited)})
} finally {
    $client.Dispose()
    $handler.Dispose()
    $layoutApiKey=$null; $keyGuid=[guid]::Empty; $keyItem=$null; $query=$null; $secrets=$null; $secret=$null
}
Complete-KajooExport @{origin=$origin.GetLeftPart([UriPartial]::Authority); endpoint=$endpoint; database=$Database; version='latest'; mode='delivery'; device='site-default'; total=$matrix.Count; succeeded=$succeeded; failed=$failed}
