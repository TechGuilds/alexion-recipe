<#
.INJECTED_VARIABLES
  None. This probe takes no parameters.

  Sitecore 9.0+ sources only. Role detection primarily reads the
  `role:define` AppSetting, canonical since 9.0 (falls back to file-presence
  markers when empty); topology (XP/XM) detection is built on xConnect
  deployment signals, which do not exist before 9.0. Do not run against, or
  trust results from, a pre-9.0 source.

  Returns a single PSCustomObject of RAW signals only (kernel version, role
  AppSettings/file markers, license modules, XP-deployment DLL/connection-
  string presence, Headless Services bin-anchor DLLs). It does not classify
  topology/role/HS-install-state — pipe the JSON into classify-topology.mjs
  for that. Read-only, single SPE round-trip, no external network calls.

  Field shape (mirrors historical topology-probe.ps1 / SitecoreTopologyProbe,
  see references/setup/topology-and-prerequisites.md):
    KernelVersion, RoleDefine, SearchDefine, EnvironmentType,
    CmShellAppsPresent, CmContentEditorPresent, CmDesktopAspxPresent,
    CmLoginDirPresent, SwitchMasterToWebDir, SpeDirPresent,
    LicenseLicensee, LicenseExpires, LicenseModules, LicenseHasXdb,
    LicenseHasXmCloud, AnalyticsDllPresent, XConnectDllPresent,
    TrackingDllPresent, ProcessingDllPresent, MarketingOpsDllPresent,
    XConnectStringPresent, XConnectStringNames, XdbEnabled,
    HsLayoutServiceDll, HsServicesClientDll, HsJssDll, BaseDir

  Run via: run-powershell-script (source-sitecore), using the default
  background job. The runtime waits for the terminal result and resumes the
  agent; do not use the 25-second foreground shortcut for Setup evidence.
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/"

    $baseDir       = [System.AppDomain]::CurrentDomain.BaseDirectory
    $binDir        = [System.IO.Path]::Combine($baseDir, 'bin')
    $connStrPath   = [System.IO.Path]::Combine($baseDir, 'App_Config\ConnectionStrings.config')
    $licensePath   = [System.IO.Path]::Combine($baseDir, 'App_Data\license.xml')

    $kernelVersion = $null
    try { $kernelVersion = [Sitecore.Configuration.About]::Version } catch {}

    $roleDefine   = $null
    $searchDefine = $null
    $envType      = $null
    try { $roleDefine   = [System.Configuration.ConfigurationManager]::AppSettings['role:define'] } catch {}
    try { $searchDefine = [System.Configuration.ConfigurationManager]::AppSettings['search:define'] } catch {}
    try { $envType      = [System.Configuration.ConfigurationManager]::AppSettings['SITECORE_ENVIRONMENT_TYPE'] } catch {}

    $cmShellAppsPresent     = Test-Path (Join-Path $baseDir 'sitecore\shell\Applications')
    $cmContentEditorPresent = Test-Path (Join-Path $baseDir 'sitecore\shell\Applications\Content Manager')
    $cmDesktopAspxPresent   = Test-Path (Join-Path $baseDir 'sitecore\shell\default.aspx')
    $cmLoginDirPresent      = Test-Path (Join-Path $baseDir 'sitecore\login')
    $switchMasterToWebDir   = Test-Path (Join-Path $baseDir 'App_Config\Include\Z.SwitchMasterToWeb')
    $speDirPresent          = Test-Path (Join-Path $baseDir 'sitecore\shell\client\Applications\PowerShell')

    # License modules. The module IDs are <Object Id="ModuleName"> siblings,
    # not children of <license>. The first <Object>'s <license> child holds
    # the licensee metadata (id/expiration/licensee) — not modules.
    $licenseModules    = @()
    $licenseLicensee   = $null
    $licenseExpires    = $null
    $licenseHasXdb     = $false
    $licenseHasXmCloud = $false
    try {
        if (Test-Path $licensePath) {
            [xml]$lic = Get-Content $licensePath -Raw
            $ns = New-Object System.Xml.XmlNamespaceManager($lic.NameTable)
            $ns.AddNamespace('ds', 'http://www.w3.org/2000/09/xmldsig#')

            foreach ($obj in $lic.SelectNodes("//ds:Object[@Id]", $ns)) {
                $licenseModules += $obj.Attributes['Id'].Value
            }

            $licMeta = $lic.SelectSingleNode("//ds:Object/*[local-name()='license']", $ns)
            if ($licMeta) {
                $licenseeNode = $licMeta.SelectSingleNode("*[local-name()='licensee']")
                $expiresNode  = $licMeta.SelectSingleNode("*[local-name()='expiration']")
                if ($licenseeNode) { $licenseLicensee = $licenseeNode.'#text' }
                if ($expiresNode)  { $licenseExpires  = $expiresNode.'#text' }
            }

            # Matches older Analytics/DMS-era module names too (pre-xConnect
            # licenses still say "Analytics"/"xAnalytics"), not just "xDB" —
            # this signal alone spans further back than 9.0, even though the
            # deployment-side (xConnect DLL) signals below do not.
            $licenseHasXdb = [bool]($licenseModules | Where-Object {
                $_ -match '(?i)^Sitecore\.(xDB|Analytics|xAnalytics|EXM|EmailExperienceManager|MarketingAutomation)$'
            })

            $licenseHasXmCloud = [bool]($licenseModules | Where-Object {
                $_ -match '(?i)^Sitecore\.(XMCloud|CMS\.XMCloud|Cloud)$'
            })
        }
    } catch {}

    $analyticsDllPresent  = Test-Path (Join-Path $binDir 'Sitecore.Analytics.dll')
    $xConnectDllPresent   = Test-Path (Join-Path $binDir 'Sitecore.XConnect.dll')
    $trackingDllPresent   = Test-Path (Join-Path $binDir 'Sitecore.Analytics.Tracking.dll')
    $processingDllPresent = Test-Path (Join-Path $binDir 'Sitecore.Analytics.Processing.dll')
    $marketingOpsDll      = Test-Path (Join-Path $binDir 'Sitecore.Marketing.Operations.dll')

    $xConnectStringPresent = $false
    $xConnectStringNames   = @()
    try {
        if (Test-Path $connStrPath) {
            [xml]$cs = Get-Content $connStrPath -Raw
            $adds = $cs.SelectNodes("//connectionStrings/add")
            foreach ($a in $adds) {
                $n = $a.Attributes['name']
                if ($n -and $n.Value -match '(?i)^xconnect\.') {
                    $xConnectStringPresent = $true
                    $xConnectStringNames += $n.Value
                }
            }
        }
    } catch {}

    $xdbEnabled = $false
    try {
        $raw = [Sitecore.Configuration.Settings]::GetSetting('Xdb.Enabled')
        $xdbEnabled = ($raw -ieq 'true')
    } catch {}

    # HS bin-anchor only; HTTP reachability is a separate caller-side probe
    # (e.g. frontend-migration/scripts/probe-render.mjs against the Layout
    # Service base URL) — pass its result to classify-topology.mjs.
    $hsLayoutServiceDll  = Test-Path (Join-Path $binDir 'Sitecore.LayoutService.dll')
    $hsServicesClientDll = Test-Path (Join-Path $binDir 'Sitecore.Services.Client.dll')
    $hsJssDll            = Test-Path (Join-Path $binDir 'Sitecore.JavaScriptServices.AppServices.dll')

    [PSCustomObject]@{
        KernelVersion           = $kernelVersion
        RoleDefine              = $roleDefine
        SearchDefine            = $searchDefine
        EnvironmentType         = $envType
        CmShellAppsPresent      = $cmShellAppsPresent
        CmContentEditorPresent  = $cmContentEditorPresent
        CmDesktopAspxPresent    = $cmDesktopAspxPresent
        CmLoginDirPresent       = $cmLoginDirPresent
        SwitchMasterToWebDir    = $switchMasterToWebDir
        SpeDirPresent           = $speDirPresent
        LicenseLicensee         = $licenseLicensee
        LicenseExpires          = $licenseExpires
        LicenseModules          = ($licenseModules -join ',')
        LicenseHasXdb           = $licenseHasXdb
        LicenseHasXmCloud       = $licenseHasXmCloud
        AnalyticsDllPresent     = $analyticsDllPresent
        XConnectDllPresent      = $xConnectDllPresent
        TrackingDllPresent      = $trackingDllPresent
        ProcessingDllPresent    = $processingDllPresent
        MarketingOpsDllPresent  = $marketingOpsDll
        XConnectStringPresent   = $xConnectStringPresent
        XConnectStringNames     = ($xConnectStringNames -join ',')
        XdbEnabled              = $xdbEnabled
        HsLayoutServiceDll      = $hsLayoutServiceDll
        HsServicesClientDll     = $hsServicesClientDll
        HsJssDll                = $hsJssDll
        BaseDir                 = $baseDir
    }
} catch {
    [PSCustomObject]@{
        status = "failed"
        error  = $_.Exception.Message
    }
}
