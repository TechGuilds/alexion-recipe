<#
.INJECTED_VARIABLES
  None. This probe takes no parameters.

  Sitecore XP/XM only. XM Cloud sources do not surface sites this way —
  sites live in xmcloud.build.json, not the config Factory — use
  xmc-list-sites on the target connector instead.

  Returns a single PSCustomObject envelope of RAW site data (does not
  filter Sitecore's own system/chrome sites — shell, login, admin, etc. —
  out of the list; pipe the JSON into filter-sites.mjs for that):
    availableLanguages : string[] — every language definition installed
                          on the instance (not scoped to any one site)
    sites : array of { name, rootPath, startItem, hostName,
                        availableLanguages } — one entry per site
                        registered in Sitecore.Configuration.Factory.
                        rootPath/startItem/hostName may be null (some
                        system sites have none). availableLanguages here
                        is scoped to THIS site: only languages with
                        versioned content actually under rootPath.

  Motivation: falls back to Factory-based enumeration (works on any XP/XM
  source) rather than a Layout-Service-driven probe, because an XP MVC
  source with unlicensed Headless Services has no working Layout Service
  to ask.

  Run via: run-powershell-script (source-sitecore), using the default
  background job. The runtime waits for the terminal result and resumes the
  agent; do not use the 25-second foreground shortcut for Setup evidence.
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/"

    $languages = @()
    try {
        $languages = Get-ChildItem -Path "master:/sitecore/system/Languages" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Name } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object -Unique
    } catch {}

    $result = @()
    $names = [Sitecore.Configuration.Factory]::GetSiteNames()
    foreach ($name in $names) {
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $rootPath = $null
        $startItem = $null
        $hostName = $null
        $availableLanguages = @()
        try {
            $site = [Sitecore.Configuration.Factory]::GetSite($name)
            if ($site -and $site.Properties) {
                $rootPath  = $site.Properties['rootPath']
                $startItem = $site.Properties['startItem']
                $hostName  = $site.Properties['hostName']
            }

            if (-not [string]::IsNullOrWhiteSpace($rootPath)) {
                $siteItem = Get-Item -Path ("master:" + $rootPath) -Language * -ErrorAction SilentlyContinue
                if ($siteItem) {
                    $availableLanguages = @($siteItem |
                        Where-Object { $_.Versions.Count -gt 0 } |
                        ForEach-Object { $_.Language.Name } |
                        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                        Sort-Object -Unique)
                }
            }
        } catch {}
        $result += [PSCustomObject]@{
            name      = $name
            rootPath  = $rootPath
            startItem = $startItem
            hostName  = $hostName
            availableLanguages = @($availableLanguages)
        }
    }

    # Wrap in an envelope so the parser sees a stable top-level shape even
    # when the array is empty (ConvertTo-Json on an empty array emits ""
    # without -AsArray).
    [PSCustomObject]@{
        availableLanguages = @($languages)
        sites = @($result)
    } | ConvertTo-Json -Depth 4 -Compress
} catch {
    [PSCustomObject]@{
        status = "failed"
        error  = $_.Exception.Message
    }
}
