# .INJECTED_VARIABLES
# SiteRootPath   (required) - selected source Sitecore content root
# Database       (optional, default: master)
# Language       (optional, default: en)
# GenerateReports (required for Discovery acceptance; pass $true)
# RenderingRootsJson (optional JSON string array; folders under /sitecore/layout/Renderings)
# The variables are injected by source-sitecore/run-powershell-script. Do not
# add credentials or interpolate connector values into this script.
# .END_INJECTED_VARIABLES
#
# Phase 2: Discovery Script for Sitecore Site Audit (V3 - Performance Optimized)
# Purpose: Complete discovery to understand the entire data structure and presentation architecture
#          WITH serialization path optimization to separate site-nested vs shared data folders
# Output: JSON objects to console for items, renderings, templates, and detailed analysis
#         PLUS serialization-config.json with optimized paths for Sitecore CLI serialization
#
# ORIGINAL V3 PERFORMANCE CHANGES (preserved):
#   - STEP 1: .Axes.GetDescendants() replaces BFS queue (1 API call vs N)
#   - STEP 3/3.5/4/5: .Axes.GetDescendants() per folder root replaces BFS
#   - STEP 6.5 branch scaffold: .Axes.GetDescendants() replaces BFS
# Enhanced evidence port adds independent rendering roots, instances/variants,
# unresolved-reference diagnostics and mapping dependencies; transport stays kajoo-export v1.

# Parameters are set as variables before this script runs
# Validate and set defaults
if ([string]::IsNullOrWhiteSpace($Database)) {
    $Database = "master"
}

if ([string]::IsNullOrWhiteSpace($Language)) {
    $Language = "en"
}

if ([string]::IsNullOrWhiteSpace($SiteRootPath)) {
    Write-Error "SiteRootPath parameter is required"
    [PSCustomObject]@{
        Success = $false
        Error = "SiteRootPath parameter is required"
    } | ConvertTo-Json -Depth 3
    return
}

# Default GenerateReports to true if not specified
if ($null -eq $GenerateReports) {
    $GenerateReports = $false
}

# Set the database context (REQUIRED for Sitecore PowerShell)
Set-Location -Path "$($Database):"

# Initialize output collection (List[string] avoids O(n²) array copy on each +=)
$script:output = [System.Collections.Generic.List[string]]::new()

# Helper function to write to both host and output object
function Write-Output-Line {
    param(
        [string]$Message,
        [string]$ForegroundColor = "White"
    )
    Write-Host $Message -ForegroundColor $ForegroundColor
    $script:output.Add($Message)
}

Write-Output-Line ("=" * 80) "Cyan"
Write-Output-Line "PHASE 2: DEPENDENCY-DRIVEN DISCOVERY" "Cyan"
Write-Output-Line ("=" * 80) "Cyan"
Write-Output-Line ""
Write-Output-Line "Strategy: Start from site root, discover all dependencies for XM Cloud migration" "Yellow"
Write-Output-Line "Site Root: $SiteRootPath" "Yellow"
Write-Output-Line "Database: $Database" "Yellow"
Write-Output-Line "Language: $Language" "Yellow"
Write-Output-Line ""

# ==============================================================================
# HELPER FUNCTIONS - Safe wrappers for SPE cmdlets
# ==============================================================================
# These wrapper functions suppress "item not found" and other SPE errors that
# would otherwise clutter the console output. All functions return $null or 
# empty arrays on failure, allowing the script to continue gracefully.
# 
# To modify error handling behavior, edit these functions in one place rather
# than updating dozens of try-catch blocks throughout the script.
# ==============================================================================

function Get-ItemSafe {
    <#
    .SYNOPSIS
    Safe wrapper for Get-Item that suppresses "item not found" errors
    
    .DESCRIPTION
    Attempts to get a Sitecore item, returning $null if not found instead of 
    throwing errors to the console. All errors are silently handled.
    
    .PARAMETER Path
    The path to the item
    
    .PARAMETER ID
    The ID of the item
    
    .PARAMETER Language
    The language version
    #>
    param(
        [string]$Path,
        [string]$ID,
        [string]$Language
    )
    
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        
        if ($ID) {
            if ($Language) {
                $item = Get-Item -Path $Path -ID $ID -Language $Language 2>$null
            }
            else {
                $item = Get-Item -Path $Path -ID $ID 2>$null
            }
        }
        elseif ($Language) {
            $item = Get-Item -Path $Path -Language $Language 2>$null
        }
        else {
            $item = Get-Item -Path $Path 2>$null
        }
        
        $ErrorActionPreference = 'Continue'
        return $item
    }
    catch {
        $ErrorActionPreference = 'Continue'
        return $null
    }
}

function Get-ChildItemSafe {
    <#
    .SYNOPSIS
    Safe wrapper for Get-ChildItem that suppresses "item not found" errors
    
    .DESCRIPTION
    Attempts to get child items, returning empty array if not found instead of 
    throwing errors to the console. All errors are silently handled.
    
    .PARAMETER Path
    The path to get children from
    
    .PARAMETER Language
    The language version
    #>
    param(
        [string]$Path,
        [string]$Language
    )
    
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        
        if ($Language) {
            $items = Get-ChildItem -Path $Path -Language $Language 2>$null
        }
        else {
            $items = Get-ChildItem -Path $Path 2>$null
        }
        
        $ErrorActionPreference = 'Continue'
        return $items
    }
    catch {
        $ErrorActionPreference = 'Continue'
        return @()
    }
}

function Get-RenderingSafe {
    <#
    .SYNOPSIS
    Reads rendering usage and records incomplete scans on layout errors
    
    .DESCRIPTION
    Returns $null on failure and marks usage incomplete so missing usage is not treated as unused
    or cannot be read. All errors are silently handled.
    
    .PARAMETER Item
    The item to get renderings from
    
    .PARAMETER FinalLayout
    Switch to use final layout
    #>
    param(
        [Parameter(Mandatory = $true)]
        $Item,
        
        [switch]$FinalLayout
    )
    
    try {
        $ErrorActionPreference = 'Stop'
        
        if ($FinalLayout) {
            $renderings = Get-Rendering -Item $Item -FinalLayout -ErrorAction Stop
        }
        else {
            $renderings = Get-Rendering -Item $Item -ErrorAction Stop
        }
        
        $ErrorActionPreference = 'Continue'
        return $renderings
    }
    catch {
        $ErrorActionPreference = 'Continue'
        $script:renderingUsageComplete = $false
        Write-Output-Line "Could not read rendering usage: $($_.Exception.Message)" 'Yellow'
        return $null
    }
}

function Get-DefinitionItemSafe {
    # Structural definitions may only have English versions even for translated pages.
    param([string]$Path, $ID)
    $lookup = @{ Path = $Path; Language = $Language }
    if ($ID) { $lookup['ID'] = $ID }
    $item = Get-ItemSafe @lookup
    if ($null -eq $item -and $Language -ine 'en') {
        $lookup['Language'] = 'en'
        $item = Get-ItemSafe @lookup
        if ($null -ne $item) {
            Write-Output-Line "INFO: Definition $Path $ID resolved using language fallback '$Language' -> 'en'." 'Gray'
        }
    }
    return $item
}

function Get-TemplateItemSafe {
    <#
    .SYNOPSIS
    Resolves a template reference that may be either a GUID/ID or a full Sitecore path.
    The Datasource Template and Parameters Template fields on rendering definitions can
    store either form, and Get-Item silently returns null if you pass a path as -ID.
    #>
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $v = $Value.Trim()
    if ($v -match '^/sitecore/') {
        # Path form — e.g. /sitecore/templates/Feature/CTA/Basic CTA
        return Get-DefinitionItemSafe -Path "$($Database):$v"
    } else {
        # GUID/ID form
        return Get-DefinitionItemSafe -Path "$($Database):" -ID $v
    }
}

function Test-IsTemplateLayerBoundary {
    <#
    .SYNOPSIS
    Returns $true if adding the given path to templateRootPaths would be too broad.

    Two rules (Option C):
      1. The path is a direct child of /sitecore/templates  (e.g. /sitecore/templates/Feature,
         /sitecore/templates/Peek, /sitecore/templates/System) — any top-level namespace under
         the templates root is a boundary because traversing it would pull everything in that tree.
      2. The path's last segment is a standard Helix layer name (Feature / Foundation / Project,
         case-insensitive) anywhere in the tree — this catches nested Helix layers such as
         /sitecore/templates/Branches/Project or /sitecore/templates/Branches/Feature.
    #>
    param([string]$NormalizedPath)

    $templatesRoot = '/sitecore/templates'
    $helixLayerNames = @('feature', 'foundation', 'project')

    # Rule 1: direct child of /sitecore/templates
    $parentOfCandidate = Split-Path $NormalizedPath -Parent
    if ($parentOfCandidate.ToLower() -eq $templatesRoot) {
        return $true
    }

    # Rule 2: last segment is a Helix layer name
    $leafSegment = Split-Path $NormalizedPath -Leaf
    if ($helixLayerNames -contains $leafSegment.ToLower()) {
        return $true
    }

    # Rule 3: Branches path at module-container level — /sitecore/templates/Branches/<Layer>/<Module>
    # Stops bubbling at e.g. /sitecore/templates/Branches/Project/MySite so individual branch
    # template items (Category Filter, White Paper Page, etc.) don't spill into templateRootPaths.
    if ($NormalizedPath -imatch '^/sitecore/templates/branches/[^/]+/[^/]+$') {
        return $true
    }

    return $false
}

function Add-TemplateRootPath {
    <#
    .SYNOPSIS
    Adds a template folder to templateRootPaths, also bubbling up one level unless that
    parent would be too broad to include (as determined by Test-IsTemplateLayerBoundary).

    This ensures that e.g. /Feature/CTA is captured when only /Feature/CTA/Parameters
    was directly discovered, so templates living at the module root are not silently missed.
    #>
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }

    $normalizedPath = $Path.Replace('\', '/')

    # Never serialize /sitecore/templates/System or any sub-path — these are default Sitecore
    # templates that XM Cloud ships with. If custom templates were incorrectly placed under
    # System, they would need to be handled manually.
    if ($normalizedPath -imatch '^/sitecore/templates/system(/|$)') {
        return
    }

    # Add the discovered path itself
    if (-not $script:templateRootPaths.ContainsKey($normalizedPath)) {
        $script:templateRootPaths[$normalizedPath] = $true
    }

    # Bubble up one level, stopping at any layer boundary
    $parentPath = Split-Path $normalizedPath -Parent
    if (-not [string]::IsNullOrWhiteSpace($parentPath)) {
        $parentNormalized = $parentPath.Replace('\', '/')
        if (-not (Test-IsTemplateLayerBoundary -NormalizedPath $parentNormalized)) {
            if (-not $script:templateRootPaths.ContainsKey($parentNormalized)) {
                $script:templateRootPaths[$parentNormalized] = $true
            }
        }
    }
}

# ==============================================================================
# END HELPER FUNCTIONS
# ==============================================================================

# Collections to store discovered items - Using ArrayList for O(1) append performance
$allItems = New-Object System.Collections.ArrayList
$allItemsLookup = @{}  # Path -> Item reference lookup for deduplication
$pageItems = New-Object System.Collections.ArrayList  # Items with layouts (pages)
$datasourceItems = New-Object System.Collections.ArrayList  # Items used as datasources
$allRenderings = New-Object System.Collections.ArrayList  # All rendering definition items discovered
$renderingParameterTemplates = @{}  # Templates used for rendering parameters
$renderingParameterTemplateUsage = New-Object System.Collections.ArrayList  # Rendering item -> param template reverse map (for STEP 6.5)
$datasourceTemplates = @{}  # Templates used for datasources
$renderingDetails = @{}  # Rendering ID -> configuration observed on pages
$renderingCatalog = @{}  # Complete rendering-definition catalog
$configuredRenderingRoots = @()
$availableRenderingItems = @{}
$script:suspiciousRenderingRoots = New-Object System.Collections.ArrayList
$script:renderingInventoryComplete = $true
$script:unresolvedRenderingReferences = New-Object System.Collections.ArrayList
$script:unresolvedRenderingReferenceKeys = @{}
$renderingTemplateKinds = @{}
$script:renderingUsageComplete = $true
$placeholderSettings = @{}  # Placeholder key -> usage data
$placeholderSettingItems = @{}  # Placeholder Settings items from /sitecore/layout/Placeholder Settings
$branchTemplates = @{}  # Branch templates discovered
$placeholderRenderingFrequency = @{}  # placeholder key -> renderingId -> page count (for SXA partial design inference)
$placeholderMaxPage = @{}  # placeholder key -> @{ path; count } — page with the most renderings in that placeholder (for representative_page_path)
$psItemsByKey = @{}  # PS item base key -> PS item details (populated in STEP 0.5, used for inline matching during page crawl)
$dynamicPlaceholderBases = @{}  # base name -> @{ isDynamic; parentRenderings; segmentPattern; usedInTemplates }
$renderingPageMapping = @{}  # renderingId -> ArrayList of page paths (which pages use each rendering)

# Folder path tracking - unique parent folders to traverse recursively later
$renderingRootPaths = @{}  # Unique rendering folder paths to traverse
$datasourceRootPaths = @{}  # Unique datasource folder paths to traverse
$branchTemplateRootPaths = @{}  # Unique branch template folder paths to traverse
$templateRootPaths = @{}  # Unique template folder paths to traverse
$renderingContentsResolverRootPaths = @{}  # Unique rendering contents resolver folder paths to traverse
$layoutRootPaths = @{}  # Unique layout folder paths (e.g. /sitecore/layout/Layouts/Project/TG)
$layoutDiscoveredTemplates = @{}  # Page template IDs already checked for layout (dedup)

# GraphQL and Resolver tracking
$renderingContentsResolvers = @{}  # Resolver ID -> Resolver details (used by renderings)
$allRenderingContentsResolvers = New-Object System.Collections.ArrayList  # All resolver items discovered

# Helper function to calculate depth
function Get-ItemDepth {
    param([string]$Path)
    return ($Path -split '/').Count - 1
}

# Helper function to check if item has layout (uses Sitecore's LayoutField which merges shared + final)
function Test-ItemHasLayout {
    param($Item)
    $layoutField = New-Object Sitecore.Data.Fields.LayoutField($Item)
    return (-not [string]::IsNullOrWhiteSpace($layoutField.Value))
}

# Helper function to create item object
function New-ItemObject {
    param(
        $Item,
        [bool]$HasLayout
    )
    
    # Get all field values (non-standard fields only)
    $fields = @{}
    foreach ($field in $Item.Fields) {
        # Skip standard Sitecore fields (those starting with __)
        if (-not $field.Name.StartsWith("__")) {
            $fields[$field.Name] = $field.Value
        }
    }
    
    return @{
        id            = $Item.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
        name          = $Item.Name
        path          = $Item.Paths.FullPath
        template_id   = $Item.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
        template_name = $Item.TemplateName
        has_layout    = $HasLayout
        depth         = Get-ItemDepth -Path $Item.Paths.FullPath
        fields        = $fields
    }
}

# Statistics counters
$stats = @{
    total_items                        = 0
    page_items                         = 0
    datasource_items                   = 0
    non_page_non_datasource_items      = 0
    page_templates                     = @{}          # Templates used by items with layouts (presentation)
    content_item_templates             = @{}  # All templates used by content items (pages + datasources + other)
    rendering_templates                = @{}     # Templates used by rendering definitions
    discovered_templates               = @{}    # Templates discovered from folder traversal
    total_renderings                   = 0
    total_rendering_contents_resolvers = 0
    renderings_with_component_graphql  = 0  # Migration flag: renderings using Component GraphQL
    renderings_with_resolvers          = 0          # Migration flag: renderings using Rendering Contents Resolvers
    total_branch_templates             = 0
    total_placeholder_settings         = 0
    max_depth                          = 0
    items_by_depth                     = @{}
    start_time                         = Get-Date
}

# ==============================================================================
# STEP 0: INSTANCE CAPABILITY PROBE
# ==============================================================================
# Reads server-side Sitecore configuration to determine which APIs/services are
# available on this instance. Results are included in the return object so the
# push agent knows at runtime which lookup tools to use — no re-probing needed.
#
# PowerShell 5.1 rules (SPE runs on 5.1, not 7):
#   - No ?. null-conditional — use explicit $null checks
#   - Policy setting stores full assembly-qualified type name — use -match not -eq
#   - Use GetConfigNodes("api/GraphQL/endpoints/*") wildcard, NOT GetConfigNode on
#     the parent node — the latter forces a full config merge and can hang
#   - [Sitecore.About]::Version not accessible — use FileVersionInfo on kernel assembly
# ==============================================================================

Write-Output-Line ("=" * 80) "Cyan"
Write-Output-Line "STEP 0: INSTANCE CAPABILITY PROBE" "Cyan"
Write-Output-Line ("=" * 80) "Cyan"
Write-Output-Line "" "White"

$script:instanceCapabilities = @{}

# Sitecore kernel version
try {
    $kernelAssembly = [System.Reflection.Assembly]::GetAssembly([Sitecore.Configuration.Settings])
    $script:instanceCapabilities["sitecoreVersion"] = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($kernelAssembly.Location).FileVersion
    Write-Output-Line "  ✓ Sitecore version: $($script:instanceCapabilities['sitecoreVersion'])" "White"
} catch {
    $script:instanceCapabilities["sitecoreVersion"] = "unknown"
    Write-Output-Line "  ⚠ Could not determine Sitecore version: $_" "Yellow"
}

# Item Service (SSC) — policy stored as full assembly-qualified type name, use -match
try {
    $sscPolicy = [Sitecore.Configuration.Settings]::GetSetting("Sitecore.Services.SecurityPolicy", "not-set")
    $sscBlocked = $sscPolicy -match "ServicesLocalOnlyPolicy"
    $script:instanceCapabilities["itemService"] = @{
        externalCallsBlocked = $sscBlocked
        securityPolicy       = $sscPolicy
    }
    if ($sscBlocked) {
        Write-Output-Line "  ✗ Item Service (SSC): blocked — ServicesLocalOnlyPolicy" "Yellow"
    } else {
        Write-Output-Line "  ✓ Item Service (SSC): available" "Green"
    }
} catch {
    $script:instanceCapabilities["itemService"] = @{ error = "$_" }
    Write-Output-Line "  ⚠ Item Service check failed: $_" "Yellow"
}

# ServicesAPI role
try {
    $servicesApiRoleExists = [Sitecore.Security.Accounts.Role]::Exists("sitecore\ServicesAPI")
    $script:instanceCapabilities["servicesApiRoleExists"] = $servicesApiRoleExists
    Write-Output-Line "  $(if ($servicesApiRoleExists) { '✓' } else { '✗' }) ServicesAPI role: $(if ($servicesApiRoleExists) { 'exists' } else { 'not installed' })" "$(if ($servicesApiRoleExists) { 'Green' } else { 'Yellow' })"
} catch {
    $script:instanceCapabilities["servicesApiRoleExists"] = $false
    Write-Output-Line "  ⚠ ServicesAPI role check failed: $_" "Yellow"
}

# GraphQL endpoints — enumerate directly from merged config, one node at a time
# Uses GetConfigNodes("api/GraphQL/endpoints/*") wildcard to avoid slow full-tree merge
try {
    $endpointNodes = [Sitecore.Configuration.Factory]::GetConfigNodes("api/GraphQL/endpoints/*")
    $graphqlEndpoints = @()
    if ($null -ne $endpointNodes) {
        foreach ($node in $endpointNodes) {
            $urlAttr = $node.Attributes["url"]
            $graphqlEndpoints += @{
                name = $node.LocalName
                url  = if ($null -ne $urlAttr) { $urlAttr.Value } else { $null }
            }
        }
    }
    $script:instanceCapabilities["graphql"] = @{
        available  = ($graphqlEndpoints.Count -gt 0)
        endpoints  = $graphqlEndpoints
    }
    if ($graphqlEndpoints.Count -gt 0) {
        Write-Output-Line "  ✓ GraphQL: $($graphqlEndpoints.Count) endpoint(s) found" "Green"
        foreach ($ep in $graphqlEndpoints) {
            Write-Output-Line "      $($ep.name): $($ep.url)" "White"
        }
    } else {
        Write-Output-Line "  ✗ GraphQL: no endpoints found in config" "Yellow"
    }
} catch {
    $script:instanceCapabilities["graphql"] = @{ available = $false; error = "$_" }
    Write-Output-Line "  ⚠ GraphQL endpoint check failed: $_" "Yellow"
}

# xDB / Analytics
try {
    $xdbEnabled         = [Sitecore.Configuration.Settings]::GetSetting("Xdb.Enabled", "not-set")
    $xdbTrackingEnabled = [Sitecore.Configuration.Settings]::GetSetting("Xdb.Tracking.Enabled", "not-set")
    $script:instanceCapabilities["xdb"] = @{
        enabled         = $xdbEnabled
        trackingEnabled = $xdbTrackingEnabled
    }
    Write-Output-Line "  $(if ($xdbEnabled -eq 'true') { '⚠' } else { '✓' }) xDB: enabled=$xdbEnabled, tracking=$xdbTrackingEnabled$(if ($xdbEnabled -eq 'true') { ' — xDB templates will not exist in XMCloud' } else { '' })" "$(if ($xdbEnabled -eq 'true') { 'Yellow' } else { 'White' })"
} catch {
    $script:instanceCapabilities["xdb"] = @{ error = "$_" }
}

# ECM / EXM — check for module container item (may be absent even if ECM templates are present)
try {
    $ecmItem = Get-Item -Path "master:/sitecore/system/Modules/Email Experience Manager" -ErrorAction SilentlyContinue
    $exmItem = Get-Item -Path "master:/sitecore/system/Modules/EXM" -ErrorAction SilentlyContinue
    $ecmInstalled = ($null -ne $ecmItem)
    $exmInstalled = ($null -ne $exmItem)
    $script:instanceCapabilities["emailModule"] = @{
        ecmInstalled = $ecmInstalled
        exmInstalled = $exmInstalled
        note         = if (-not $ecmInstalled -and -not $exmInstalled) { "Module items absent but ECM templates may still exist as residual artifacts" } else { $null }
    }
    Write-Output-Line "  $(if ($ecmInstalled -or $exmInstalled) { '⚠' } else { '✓' }) Email module: ECM=$(if ($ecmInstalled) { 'installed' } else { 'not installed (check for residual templates)' }), EXM=$(if ($exmInstalled) { 'installed' } else { 'not installed' })" "$(if ($ecmInstalled -or $exmInstalled) { 'Yellow' } else { 'White' })"
} catch {
    $script:instanceCapabilities["emailModule"] = @{ error = "$_" }
}

# SXA
try {
    $sxaItem = Get-Item -Path "master:/sitecore/system/Settings/Feature/Experience Accelerator" -ErrorAction SilentlyContinue
    $sxaInstalled = ($null -ne $sxaItem)
    $script:instanceCapabilities["sxaInstalled"] = $sxaInstalled
    Write-Output-Line "  $(if ($sxaInstalled) { '⚠' } else { '✓' }) SXA: $(if ($sxaInstalled) { 'installed — SXA-specific templates will not exist in XMCloud' } else { 'not installed' })" "$(if ($sxaInstalled) { 'Yellow' } else { 'White' })"
} catch {
    $script:instanceCapabilities["sxaInstalled"] = $false
}

# Headless Services 19+ (required for xpmvc2sai migrations; informational for xpheadless2sai)
try {
    $hsItem = Get-Item -Path "master:/sitecore/system/Modules/Layout Service" -ErrorAction SilentlyContinue
    $hsInstalled = ($null -ne $hsItem)
    $script:instanceCapabilities["headlessServices"] = @{ installed = $hsInstalled }
    Write-Output-Line "  $(if ($hsInstalled) { '✓' } else { '⚠' }) Headless Services: $(if ($hsInstalled) { 'installed' } else { 'NOT installed — required for MVC migrations (xpmvc2sai)' })" "$(if ($hsInstalled) { 'White' } else { 'Yellow' })"
} catch {
    $script:instanceCapabilities["headlessServices"] = @{ installed = $false; error = "$_" }
    Write-Output-Line "  ⚠ Headless Services: probe failed ($_)" "Yellow"
}

# Publishing Service
try {
    $pubUrl = [Sitecore.Configuration.Settings]::GetSetting("PublishingService.UrlRoot", "not-set")
    $pubConfigured = ($pubUrl -ne "not-set" -and -not [string]::IsNullOrWhiteSpace($pubUrl))
    $script:instanceCapabilities["publishingService"] = @{ configured = $pubConfigured; urlRoot = $pubUrl }
    Write-Output-Line "  $(if ($pubConfigured) { '✓' } else { '○' }) Publishing Service: $(if ($pubConfigured) { $pubUrl } else { 'not configured (legacy publisher)' })" "White"
} catch {
    $script:instanceCapabilities["publishingService"] = @{ configured = $false }
}

# Determine recommended lookup tool for push agent
$sscBlocked   = $script:instanceCapabilities["itemService"].externalCallsBlocked -eq $true
$graphqlAvail = $script:instanceCapabilities["graphql"].available -eq $true
$script:instanceCapabilities["recommendedLookupTool"] = if (-not $sscBlocked) { "get-item" } elseif ($graphqlAvail) { "graphql-query" } else { "powershell-only" }

Write-Output-Line "" "White"
Write-Output-Line "  → Recommended lookup tool for push agent: $($script:instanceCapabilities['recommendedLookupTool'])" "Cyan"
Write-Output-Line "" "White"
Write-Output-Line "✓ STEP 0 complete" "Green"
Write-Output-Line "" "White"

# ==============================================================================
# STEP 0.5: WALK PLACEHOLDER SETTINGS TREE
# ==============================================================================
# Walk the entire PS tree once (~15-30 items). Store ALL PS items in $psItemsByKey
# keyed by Placeholder Key value. This replaces the old STEP 7 BFS which only
# matched against raw placeholder path strings from layout XML (F77 bug).
# ==============================================================================
Write-Output-Line "STEP 0.5: Walking Placeholder Settings tree..." "Green"
Write-Output-Line "" "White"

$placeholderSettingsRoot = Get-ItemSafe -Path "master:/sitecore/layout/Placeholder Settings"
if ($null -ne $placeholderSettingsRoot) {
    $psQueue = New-Object System.Collections.Queue
    $psQueue.Enqueue($placeholderSettingsRoot)
    $psVisited = @{}

    while ($psQueue.Count -gt 0) {
        $psItem = $psQueue.Dequeue()
        $psPath = $psItem.Paths.FullPath
        if ($psVisited.ContainsKey($psPath)) { continue }
        $psVisited[$psPath] = $true

        if ($psItem.TemplateName -eq "Placeholder") {
            $keyField = $psItem.Fields["Placeholder Key"]
            $keyValue = if ($null -ne $keyField -and -not [string]::IsNullOrWhiteSpace($keyField.Value)) {
                $keyField.Value
            } else {
                $psItem.Name
            }

            # Resolve allowed renderings
            $allowedControlsField = $psItem.Fields["Allowed Controls"]
            $allowedRenderings = New-Object System.Collections.ArrayList
            if ($null -ne $allowedControlsField -and -not [string]::IsNullOrWhiteSpace($allowedControlsField.Value)) {
                $renderingIds = $allowedControlsField.Value -split '\|'
                foreach ($rId in $renderingIds) {
                    if (-not [string]::IsNullOrWhiteSpace($rId)) {
                        $rItem = Get-ItemSafe -Path "master:" -ID $rId
                        if ($null -ne $rItem) {
                            [void]$allowedRenderings.Add(@{
                                id   = $rItem.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                                name = $rItem.Name
                                path = $rItem.Paths.FullPath
                            })
                        }
                    }
                }
            }

            $psId = $psItem.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
            $psItemsByKey[$keyValue] = @{
                id                   = $psId
                name                 = $psItem.Name
                path                 = $psPath
                placeholder_key      = $keyValue
                allowed_renderings   = $allowedRenderings
                metadata_placeholder = $psItem.Fields["MetaDataPlaceholder"].Value
                editable             = $psItem.Fields["Is Editable"].Value
                parent_folder_path   = (Split-Path $psPath -Parent) -replace '\\', '/'
            }
        }

        $psChildren = Get-ChildItemSafe -Path $psPath
        if ($null -ne $psChildren) {
            foreach ($child in $psChildren) {
                $psQueue.Enqueue($child)
            }
        }
    }
    Write-Output-Line "✓ Discovered $($psItemsByKey.Count) Placeholder Settings items" "Green"
} else {
    Write-Output-Line "⚠ Placeholder Settings root not found at /sitecore/layout/Placeholder Settings" "Yellow"
}
Write-Output-Line "" "White"


# Rendering inventory helpers. Definition metadata is independent of page placement.
function Get-SitecoreParentPath {
    param([string]$Path)
    return $Path.Substring(0, $Path.LastIndexOf('/'))
}
function Get-RenderingFieldValue {
    param($Item, [string]$Name)
    $field = $Item.Fields[$Name]
    if ($null -eq $field -or [string]::IsNullOrWhiteSpace($field.Value)) { return $null }
    return $field.Value
}

function Get-RenderingDefinitionDetail {
    param($Item)
    $detail = @{
        id = $Item.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        name = $Item.Name
        path = $Item.Paths.FullPath
        template_id = $Item.TemplateID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        template_name = $Item.TemplateName
        placeholder = $null
        parameters = $null
    }
    $fields = @{
        component_name = 'Component Name'
        datasource_template = 'Datasource Template'
        datasource_location = 'Datasource Location'
        parameters_template = 'Parameters Template'
        component_query = 'ComponentQuery'
        rendering_contents_resolver = 'Rendering Contents Resolver'
        placeholders = 'Placeholders'
        other_properties = 'OtherProperties'
        controller_class = 'Controller'
        controller_action = 'Controller Action'
        layout_service_placeholders = 'Layout Service Placeholders'
        view_path = 'Path'
    }
    foreach ($key in $fields.Keys) {
        $detail[$key] = Get-RenderingFieldValue -Item $Item -Name $fields[$key]
    }
    $detail['has_datasource_template'] = $null -ne $detail['datasource_template']
    $detail['has_component_query'] = $null -ne $detail['component_query']
    $detail['has_rendering_contents_resolver'] = $null -ne $detail['rendering_contents_resolver']
    return $detail
}

function Register-RenderingDependencies {
    param($Item, [hashtable]$Detail, [bool]$IsUsed)
    if ($Detail['has_component_query']) { $stats.renderings_with_component_graphql++ }
    if ($Detail['has_rendering_contents_resolver']) { $stats.renderings_with_resolvers++ }

    $resolverReference = $Detail['rendering_contents_resolver']
    if (-not [string]::IsNullOrWhiteSpace($resolverReference)) {
        $resolver = Get-ItemSafe -Path "$($Database):" -ID $resolverReference
        if ($null -eq $resolver) { throw "Unresolved resolver for rendering $($Item.Paths.FullPath): $resolverReference" }
        $id = $resolver.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        $renderingContentsResolverRootPaths[(Get-SitecoreParentPath -Path $resolver.Paths.FullPath)] = $true
        if (-not $renderingContentsResolvers.ContainsKey($id)) {
            $renderingContentsResolvers[$id] = @{
                id = $id
                name = $resolver.Name
                path = $resolver.Paths.FullPath
                template_name = $resolver.TemplateName
                used_by_rendering = $Item.Name
                is_used = $IsUsed
                type = Get-RenderingFieldValue -Item $resolver -Name 'Type'
            }
        } elseif ($IsUsed) {
            $renderingContentsResolvers[$id]['is_used'] = $true
        }
    }

    foreach ($reference in @($Detail['datasource_template'] -split '\|')) {
        if ([string]::IsNullOrWhiteSpace($reference)) { continue }
        $template = Get-TemplateItemSafe -Value $reference
        if ($null -eq $template) {
            Register-UnresolvedRenderingReference -Id $reference -SourceItemPath $Item.Paths.FullPath -DiscoverySource 'datasource-template' -Reason 'Datasource template could not be resolved'
            continue
        }
        $id = $template.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        $datasourceTemplates[$id] = $template.Name
        Add-TemplateRootPath -Path (Get-SitecoreParentPath -Path $template.Paths.FullPath)
    }

    $parameterReference = $Detail['parameters_template']
    if (-not [string]::IsNullOrWhiteSpace($parameterReference)) {
        $template = Get-TemplateItemSafe -Value $parameterReference
        if ($null -eq $template) {
            Register-UnresolvedRenderingReference -Id $parameterReference -SourceItemPath $Item.Paths.FullPath -DiscoverySource 'parameters-template' -Reason 'Parameters template could not be resolved'
            return
        }
        $id = $template.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        $renderingParameterTemplates[$id] = $template.Name
        [void]$renderingParameterTemplateUsage.Add(@{
            paramTemplateId = $id
            renderingPath = $Item.Paths.FullPath
            renderingId = $Detail['id']
            renderingName = $Item.Name
            is_used = $IsUsed
        })
        Add-TemplateRootPath -Path (Get-SitecoreParentPath -Path $template.Paths.FullPath)
    }
}

function Test-IsRenderingDefinition {
    param($Item, [string[]]$TemplateNames)
    $templateKey = $Item.TemplateID.ToString()
    if ($renderingTemplateKinds.ContainsKey($templateKey)) { return $renderingTemplateKinds[$templateKey] }
    if ($TemplateNames -contains $Item.TemplateName) { $renderingTemplateKinds[$templateKey] = $true; return $true }
    # Custom rendering templates can inherit from standard rendering templates.
    $pending = New-Object System.Collections.Queue
    $pending.Enqueue($Item.TemplateID.ToString())
    $seen = @{}
    while ($pending.Count -gt 0) {
        $id = [string]$pending.Dequeue()
        if ([string]::IsNullOrWhiteSpace($id) -or $id.Trim().Trim('{', '}').Replace('-', '') -eq ('0' * 32)) { continue }
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        $template = Get-DefinitionItemSafe -Path "$($Database):" -ID $id
        if ($null -eq $template) {
            Register-UnresolvedRenderingReference -Id $id -SourceItemPath $Item.Paths.FullPath -DiscoverySource 'rendering-template' -Reason 'Rendering template inheritance reference could not be resolved'
            continue
        }
        if ($TemplateNames -contains $template.Name) { $renderingTemplateKinds[$templateKey] = $true; return $true }
        $baseIds = Get-RenderingFieldValue -Item $template -Name '__Base template'
        foreach ($baseId in @($baseIds -split '\|')) {
            if (-not [string]::IsNullOrWhiteSpace($baseId)) { $pending.Enqueue($baseId) }
        }
    }
    $renderingTemplateKinds[$templateKey] = $false
    return $false
}

function Write-RenderingInstanceEvidence {
    param($Page, $Rendering, $Definition)
    $variantId = $null
    foreach ($pair in @(([string]$Rendering.Parameters) -split '&')) {
        $parts = $pair -split '=', 2
        if ($parts.Count -eq 2 -and $parts[0] -match '^(FieldNames|RenderingVariant|VariantId)$') {
            $value = [System.Uri]::UnescapeDataString($parts[1].Replace('+', ' '))
            if ($value -match '^\{?[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\}?$') {
                $variantId = $value.Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
                $script:observedVariantReferences[$variantId] = $value
                if (-not $script:observedVariantRenderings.ContainsKey($variantId)) { $script:observedVariantRenderings[$variantId] = @{} }
                $sourceId = $Rendering.ItemID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
                $script:observedVariantRenderings[$variantId][$sourceId] = $true
            }
        }
    }
    $record = @{
        renderingId = $Rendering.ItemID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        renderingName = $Definition.Name
        instanceId = if ($Rendering.UniqueID) { $Rendering.UniqueID.ToString() } else { $null }
        pageId = $Page.ID.ToString()
        itemPath = $Page.Paths.FullPath
        language = $Language
        deviceId = if ($Rendering.DeviceID) { $Rendering.DeviceID.ToString() } else { $null }
        placeholder = if ($null -ne $Rendering.Placeholder) { [string]$Rendering.Placeholder } else { $null }
        datasource = if ($null -ne $Rendering.Datasource) { [string]$Rendering.Datasource } else { $null }
        parameters = if ($null -ne $Rendering.Parameters) { [string]$Rendering.Parameters } else { $null }
        variantId = $variantId
    }
    $script:instanceEvidenceWriter.WriteLine(($record | ConvertTo-Json -Depth 8 -Compress))
    $script:instanceEvidenceCount++
}

function Get-VariantNodeEvidence {
    param($Item)
    $values = @{}
    foreach ($field in $Item.Fields) {
        if ($field.Name -and -not $field.Name.StartsWith('__') -and -not [string]::IsNullOrEmpty($field.Value)) { $values[$field.Name] = [string]$field.Value }
    }
    return @{ path = $Item.Paths.FullPath; template = $Item.TemplateName; fields = $values }
}

function Get-RenderingVariantEvidence {
    $started = Get-Date
    $referenceLookups = 0
    # Read the nearest site variant subtree once. Folder-name associations are accepted
    # only when exactly one rendering matches; ambiguity stays visible in the artifact.
    $items = @{}
    $candidate = $SiteRootPath.TrimEnd('/')
    $rootPath = $null
    while ($candidate -match '^/sitecore/content/.+') {
        $root = Get-ItemSafe -Path "$($Database):$candidate/Presentation/Rendering Variants" -Language $Language
        if ($null -ne $root) {
            $rootPath = $root.Paths.FullPath
            foreach ($item in @($root.Axes.GetDescendants() | Initialize-Item -ErrorAction Stop)) { $items[$item.Paths.FullPath] = $item }
            break
        }
        $candidate = $candidate.Substring(0, $candidate.LastIndexOf('/'))
    }
    $unresolved = New-Object System.Collections.ArrayList
    $knownIds = @{}
    foreach ($item in $items.Values) { $knownIds[$item.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()] = $true }
    $referencedGroups = @{}
    foreach ($reference in $script:observedVariantReferences.Keys) {
        if ($knownIds.ContainsKey($reference)) { continue }
        $item = Get-ItemSafe -Path "$($Database):" -ID $script:observedVariantReferences[$reference] -Language $Language
        $referenceLookups++
        if ($null -eq $item) { [void]$unresolved.Add($reference); continue }
        $items[$item.Paths.FullPath] = $item
        $groupPath = Get-SitecoreParentPath -Path $item.Paths.FullPath
        if (-not $referencedGroups.ContainsKey($groupPath)) {
            $referencedGroups[$groupPath] = $true
            $group = Get-ItemSafe -Path "$($Database):$groupPath" -Language $Language
            $scanRoot = if ($null -ne $group) { $group } else { $item }
            foreach ($child in @($scanRoot.Axes.GetDescendants() | Initialize-Item -ErrorAction Stop)) {
                $items[$child.Paths.FullPath] = $child
                $knownIds[$child.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()] = $true
            }
        }
    }
    $variants = New-Object System.Collections.ArrayList
    foreach ($item in ($items.Values | Sort-Object { $_.Paths.FullPath })) {
        $id = $item.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
        # SXA variants are direct children of component groups, plus explicit GUID references.
        $parentPath = Get-SitecoreParentPath -Path $item.Paths.FullPath
        $groupPath = Get-SitecoreParentPath -Path $parentPath
        if (-not (($rootPath -and $groupPath -eq $rootPath) -or $referencedGroups.ContainsKey($parentPath) -or $script:observedVariantReferences.ContainsKey($id))) { continue }
        $groupName = ($parentPath -split '/')[-1]
        $variantMatches = @($renderingCatalog.Values | Where-Object { $_['name'] -eq $groupName -or $_['component_name'] -eq $groupName })
        $renderingIds = @()
        if ($script:observedVariantRenderings.ContainsKey($id)) { $renderingIds = @($script:observedVariantRenderings[$id].Keys) }
        elseif ($variantMatches.Count -eq 1) { $renderingIds = @($variantMatches[0]['id']) }
        $nodes = @($items.Values | Where-Object { $_.Paths.FullPath.StartsWith($item.Paths.FullPath + '/', [System.StringComparison]::OrdinalIgnoreCase) } | Sort-Object { $_.Paths.FullPath } | ForEach-Object { Get-VariantNodeEvidence $_ })
        $node = Get-VariantNodeEvidence $item
        [void]$variants.Add(@{ id = $id; name = $item.Name; path = $item.Paths.FullPath; renderingIds = @($renderingIds); fields = $node.fields; nodes = @($nodes); observed = $script:observedVariantReferences.ContainsKey($id) })
    }
    return @{ schemaVersion = 1; siteRoot = $SiteRootPath; language = $Language; root = $rootPath; variants = @($variants); unresolvedReferences = @($unresolved); metrics = @{ durationMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds); variantCount = $variants.Count; referenceLookups = $referenceLookups; referencedGroupsScanned = $referencedGroups.Count } }
}

function Register-UnresolvedRenderingReference {
    param([string]$Id, [string]$SourceItemPath, [string]$DiscoverySource, [string]$Reason = 'Rendering definition could not be resolved')
    $script:renderingInventoryComplete = $false
    $key = "$DiscoverySource|$SourceItemPath|$Id".ToLowerInvariant()
    if ($script:unresolvedRenderingReferenceKeys.ContainsKey($key)) { return }
    $script:unresolvedRenderingReferenceKeys[$key] = $true
    [void]$script:unresolvedRenderingReferences.Add(@{
        id = $Id
        source_item_path = $SourceItemPath
        discovery_source = $DiscoverySource
        database = $Database
        reason = $Reason
    })
    Write-Output-Line "WARNING: $($Reason): $Id (source: $SourceItemPath, database: $Database). Continuing discovery." 'Yellow'
}

function Get-ValidatedRenderingRoot {
    param($Definition, [string]$Reference, [string]$SourceItemPath, [string]$DiscoverySource)
    $resolvedPath = $Definition.Paths.FullPath
    $root = Get-SitecoreParentPath -Path $resolvedPath
    $reason = $null
    if ($resolvedPath -notmatch '^/sitecore/layout/Renderings/.+' -or $root -notmatch '^/sitecore/layout/Renderings(?:/|$)') {
        $reason = 'Reference resolved outside the rendering definitions tree'
    } elseif (-not (Test-IsRenderingDefinition -Item $Definition -TemplateNames @('Json Rendering', 'View Rendering', 'Controller Rendering', 'Method Rendering', 'Sublayout', 'XSLT Rendering', 'Url Rendering', 'Razor Rendering', 'WebControl Rendering'))) {
        $reason = 'Reference did not resolve to a supported rendering definition'
    }
    if ($reason) {
        $key = "$DiscoverySource|$SourceItemPath|$Reference".ToLowerInvariant()
        if (-not $script:unresolvedRenderingReferenceKeys.ContainsKey($key)) {
            [void]$script:suspiciousRenderingRoots.Add(@{
                root_path = $root; reference = $Reference; source_item_path = $SourceItemPath
                resolved_item_path = $resolvedPath; discovery_source = $DiscoverySource
                database = $Database; language = $Language; reason = $reason
            })
        }
        Register-UnresolvedRenderingReference -Id $Reference -SourceItemPath $SourceItemPath -DiscoverySource $DiscoverySource -Reason $reason
        return $null
    }
    return $root
}

function Initialize-RenderingInventoryRoots {
    if (-not [string]::IsNullOrWhiteSpace($RenderingRootsJson)) {
        if (-not $RenderingRootsJson.Trim().StartsWith('[')) { throw 'RenderingRootsJson must be a JSON string array' }
        $roots = ConvertFrom-Json -InputObject $RenderingRootsJson -ErrorAction Stop
        if ($roots.Count -eq 0) { throw 'At least one rendering root is required' }
        foreach ($root in $roots) {
            if ($root -isnot [string]) { throw 'Rendering roots must be strings' }
            $normalized = $root.Trim().TrimEnd('/')
            if ($normalized -notmatch '^/sitecore/layout/Renderings(?:/|$)' -or
                $normalized.Contains('\') -or $normalized.Contains('//') -or
                @($normalized -split '/' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
                throw "Invalid rendering root: $root"
            }
            $renderingRootPaths[$normalized] = $true
        }
        $script:configuredRenderingRoots = @($renderingRootPaths.Keys | Sort-Object)
    }

    # Find the nearest site's Available Renderings, including when sitePath points at Home.
    $candidate = $SiteRootPath.TrimEnd('/')
    while ($candidate -match '^/sitecore/content/.+') {
        $available = Get-ItemSafe -Path "$($Database):$candidate/Presentation/Available Renderings"
        if ($null -ne $available) {
            $groups = @($available) + @($available.Axes.GetDescendants() | Initialize-Item -ErrorAction Stop)
            foreach ($group in $groups) {
                $references = Get-RenderingFieldValue -Item $group -Name 'Renderings'
                foreach ($reference in @($references -split '\|')) {
                    if ([string]::IsNullOrWhiteSpace($reference)) { continue }
                    $definition = Get-DefinitionItemSafe -Path "$($Database):" -ID $reference
                    if ($null -eq $definition) {
                        Register-UnresolvedRenderingReference -Id $reference -SourceItemPath $group.Paths.FullPath -DiscoverySource 'sxa-available-renderings'
                        continue
                    }
                    $inferredRoot = Get-ValidatedRenderingRoot -Definition $definition -Reference $reference -SourceItemPath $group.Paths.FullPath -DiscoverySource 'sxa-available-renderings'
                    if ([string]::IsNullOrWhiteSpace($inferredRoot)) { continue }
                    $id = $definition.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
                    $availableRenderingItems[$id] = $definition
                    $renderingRootPaths[$inferredRoot] = $true
                }
            }
            break
        }
        $candidate = $candidate.Substring(0, $candidate.LastIndexOf('/'))
    }
}

try {
    $script:observedVariantReferences = @{}
    $script:observedVariantRenderings = @{}
    $script:instanceEvidenceCount = 0
    $script:renderingDefinitionItems = @{}
    $script:instanceEvidenceTemp = [System.IO.Path]::GetTempFileName()
    $script:instanceEvidenceWriter = New-Object System.IO.StreamWriter($script:instanceEvidenceTemp, $false, (New-Object System.Text.UTF8Encoding($false)))
    Initialize-RenderingInventoryRoots

    Write-Output-Line "STEP 1: Discovering all page items (content with layouts)..." "Green"
    Write-Output-Line "" "White"

    # Get site root item
    $siteRoot = Get-ItemSafe -Path "$($Database):$SiteRootPath" -Language $Language

    if ($null -eq $siteRoot) {
        Write-Output-Line "ERROR: Site root not found at path: $SiteRootPath" "Red"
        exit 1
    }

    Write-Output-Line "✓ Site root found: $($siteRoot.Name)" "Green"

    # Content/layout discovery retains the requested language.
    Write-Output-Line "Fetching all descendants via .Axes.GetDescendants() (single API call)..." "Yellow"
    $allDescendantsRaw = $siteRoot.Axes.GetDescendants() | Initialize-Item -ErrorAction Stop
    Write-Output-Line "✓ Retrieved $($allDescendantsRaw.Count) content descendants" "Green"

    $processedPaths = @{}

    $itemCount = 0
    $pageCount = 0

    Write-Output-Line "Processing content items in-memory..." "Yellow"
    Write-Output-Line "" "White"

    # Process site root + all descendants in-memory
    foreach ($currentItem in (@($siteRoot) + @($allDescendantsRaw))) {
    
        # Skip if already processed
        $itemPath = $currentItem.Paths.FullPath
        if ($processedPaths.ContainsKey($itemPath)) {
            continue
        }
        $processedPaths[$itemPath] = $true
    
        # Check if this item has layout (is a page)
        $hasLayout = Test-ItemHasLayout -Item $currentItem
    
        # Store item reference for later analysis
        $allItemsLookup[$itemPath] = $currentItem
    
        # Create minimal item object — fields intentionally omitted to reduce memory usage.
        # content-items.jsonl is not written; full field data not needed downstream.
        $itemObj = @{
            path          = $itemPath
            template_id   = $currentItem.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
            template_name = $currentItem.TemplateName
            has_layout    = $hasLayout
        }
        [void]$allItems.Add($itemObj)
    
        # If this is a page, track it separately for dependency analysis
        if ($hasLayout) {
            [void]$pageItems.Add($itemObj)
            $pageCount++
        
            # Track page template (templates used by items with presentation)
            $pageTemplateId = $currentItem.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
            if (-not $stats.page_templates.ContainsKey($pageTemplateId)) {
                $stats.page_templates[$pageTemplateId] = $currentItem.TemplateName
            }
        
            # Track page template folder path for recursive traversal
            $pageTemplateItem = Get-ItemSafe -Path "master:" -ID $currentItem.TemplateID
            if ($null -ne $pageTemplateItem) {
                $pageTemplateParentPath = Split-Path $pageTemplateItem.Paths.FullPath -Parent
                Add-TemplateRootPath -Path $pageTemplateParentPath

                # Discover layout from template's Standard Values (once per unique template)
                # Layouts are assigned on SVs, not individual pages — only need to check each template once
                if (-not $layoutDiscoveredTemplates.ContainsKey($pageTemplateId)) {
                    $layoutDiscoveredTemplates[$pageTemplateId] = $true
                    $svPath = "master:" + $pageTemplateItem.Paths.FullPath + "/__Standard Values"
                    $svItem = Get-ItemSafe -Path $svPath
                    if ($null -ne $svItem) {
                        $layoutItem = Get-Layout -Item $svItem 2>$null
                        if ($null -ne $layoutItem) {
                            $layoutParentPath = Split-Path $layoutItem.Paths.FullPath -Parent
                            if (-not [string]::IsNullOrWhiteSpace($layoutParentPath) -and -not $layoutRootPaths.ContainsKey($layoutParentPath)) {
                                $layoutRootPaths[$layoutParentPath] = $true
                            }
                        }
                    }
                }
            }
        }
    
        # Check for branch template originator (__Originator field)
        $originatorField = $currentItem.Fields["__Originator"]
        if ($null -ne $originatorField -and -not [string]::IsNullOrWhiteSpace($originatorField.Value)) {
            $originatorId = $originatorField.Value.Trim()
            # Get the originator item (might be a child within branch template structure)
            $originatorItem = Get-ItemSafe -Path "master:" -ID $originatorId
            if ($null -ne $originatorItem) {
                # Traverse UP the tree to find the actual Branch template item.
                # Use -ID for each ancestor lookup to avoid $name path-interpolation issues.
                $branchTemplateItem = $originatorItem
                while ($null -ne $branchTemplateItem -and $branchTemplateItem.TemplateName -ne "Branch" -and $branchTemplateItem.TemplateName -ne "Command Template") {
                    # Move to parent via ID to avoid $ in path being interpolated
                    $parentId = $branchTemplateItem.ParentID.ToString()
                    if ([string]::IsNullOrWhiteSpace($parentId)) {
                        break
                    }
                    $branchTemplateItem = Get-ItemSafe -Path "$($Database):" -ID $parentId
                }
            
                # If we found the Branch template item, track ITS OWN path as the root.
                # Parent-folder grouping (e.g. Branches/Project/MySite) is handled by
                # resolveAncestorOverlaps in the compiler when multiple siblings exist.
                if ($null -ne $branchTemplateItem -and ($branchTemplateItem.TemplateName -eq "Branch" -or $branchTemplateItem.TemplateName -eq "Command Template")) {
                    $branchItemPath = $branchTemplateItem.Paths.FullPath
                    if (-not [string]::IsNullOrWhiteSpace($branchItemPath) -and -not $branchTemplateRootPaths.ContainsKey($branchItemPath)) {
                        $branchTemplateRootPaths[$branchItemPath] = $true
                    }
                }
            }
        }
    
        # Update statistics
        $stats.total_items++
        $itemCount++
    
        # Track template used by this content item
        $templateId = $currentItem.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
        if (-not $stats.content_item_templates.ContainsKey($templateId)) {
            $stats.content_item_templates[$templateId] = $currentItem.TemplateName
        }
    
        # Track depth
        $depth = Get-ItemDepth -Path $itemPath
        if ($depth -gt $stats.max_depth) {
            $stats.max_depth = $depth
        }
    
        if (-not $stats.items_by_depth.ContainsKey($depth)) {
            $stats.items_by_depth[$depth] = 0
        }
        $stats.items_by_depth[$depth]++
    
        # Progress indicator
        if ($itemCount % 50 -eq 0) {
            Write-Output-Line "  Processed $itemCount items... (Pages found: $pageCount)" "Cyan"
        }
    }

    Write-Output-Line "" "White"
    Write-Output-Line "✓ Discovered $($stats.total_items) total content items" "Green"
    Write-Output-Line "✓ Found $pageCount pages (items with layouts)" "Green"
    Write-Output-Line "" "White"

    Write-Output-Line "STEP 2: Analyzing pages to discover all dependencies..." "Green"
    Write-Output-Line "" "White"

    $pageItemsProcessed = 0
    $datasourceItemPaths = @{}  # Track datasource items

    Write-Output-Line "Processing $($pageItems.Count) pages to extract complete dependency tree..." "Yellow"
    Write-Output-Line "" "White"

    foreach ($pageItemData in $pageItems) {
        # Get the cached Sitecore item (avoid re-fetching from database)
        $pageItem = $allItemsLookup[$pageItemData["path"]]
    
        if ($null -eq $pageItem) {
            $script:renderingUsageComplete = $false
            continue
        }
    
        # Extract all renderings on this page
        $renderings = Get-RenderingSafe -Item $pageItem -FinalLayout
    
        # Per-page placeholder rendering counter (flushed after the rendering loop)
        $pagePhCount = @{}

        if ($null -ne $renderings -and $renderings.Count -gt 0) {
            foreach ($rendering in $renderings) {
                # Discover rendering definition item
                if ($null -ne $rendering.ItemID) {
                    $definitionKey = $rendering.ItemID.ToString().ToLowerInvariant()
                    if (-not $script:renderingDefinitionItems.ContainsKey($definitionKey)) {
                        $script:renderingDefinitionItems[$definitionKey] = Get-DefinitionItemSafe -Path "$($Database):" -ID $rendering.ItemID
                    }
                    $renderingItem = $script:renderingDefinitionItems[$definitionKey]
                
                    if ($null -ne $renderingItem) {
                        $renderingParentPath = Get-ValidatedRenderingRoot -Definition $renderingItem -Reference $rendering.ItemID.ToString() -SourceItemPath $pageItem.Paths.FullPath -DiscoverySource 'page-usage'
                        if ([string]::IsNullOrWhiteSpace($renderingParentPath)) {
                            $script:renderingUsageComplete = $false
                            continue
                        }
                        $renderingId = $rendering.ItemID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                        $renderingName = $renderingItem.Name
                        Write-RenderingInstanceEvidence -Page $pageItem -Rendering $rendering -Definition $renderingItem

                        # Track which pages use this rendering (for rendering-page-mapping output)
                        if (-not $renderingPageMapping.ContainsKey($renderingId)) {
                            $renderingPageMapping[$renderingId] = New-Object System.Collections.ArrayList
                        }
                        $rpPagePath = $pageItemData["path"]
                        if (-not $renderingPageMapping[$renderingId].Contains($rpPagePath)) {
                            [void]$renderingPageMapping[$renderingId].Add($rpPagePath)
                        }
                    
                        # Track the rendering's parent folder path for later recursive traversal
                        if (-not [string]::IsNullOrWhiteSpace($renderingParentPath) -and -not $renderingRootPaths.ContainsKey($renderingParentPath)) {
                            $renderingRootPaths[$renderingParentPath] = $true
                        }
                    
                        # Track rendering details
                        if (-not $renderingDetails.ContainsKey($renderingId)) {
                            $detail = Get-RenderingDefinitionDetail -Item $renderingItem
                            $detail['placeholder'] = $rendering.Placeholder
                            $detail['parameters'] = $rendering.Parameters
                            $detail['is_used'] = $true
                            $renderingDetails[$renderingId] = $detail
                            Register-RenderingDependencies -Item $renderingItem -Detail $detail -IsUsed $true

                        }
                    }
                    else {
                        $script:renderingUsageComplete = $false
                        Register-UnresolvedRenderingReference -Id $rendering.ItemID.ToString() -SourceItemPath $pageItem.Paths.FullPath -DiscoverySource 'page-usage'
                        $renderingName = "Unknown"
                    }
                }
            
                # Discover placeholder settings
                if ($null -ne $rendering.Placeholder -and -not [string]::IsNullOrWhiteSpace($rendering.Placeholder)) {
                    $placeholderKey = $rendering.Placeholder
                
                    # Parse hierarchical placeholder (e.g., "/main/sidebar" or "main/sidebar")
                    $placeholderSegments = $placeholderKey -split '/' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
                
                    if (-not $placeholderSettings.ContainsKey($placeholderKey)) {
                        $placeholderSettings[$placeholderKey] = @{
                            placeholder_key    = $placeholderKey
                            segments           = $placeholderSegments
                            depth              = $placeholderSegments.Count
                            used_by_renderings = New-Object System.Collections.ArrayList
                            parent_placeholder = if ($placeholderSegments.Count -gt 1) { 
                                ($placeholderSegments[0..($placeholderSegments.Count - 2)] -join '/')
                            }
                            else { 
                                $null 
                            }
                        }
                    }
                
                    # Track which renderings use this placeholder
                    if (-not $placeholderSettings[$placeholderKey]["used_by_renderings"].Contains($renderingName)) {
                        [void]$placeholderSettings[$placeholderKey]["used_by_renderings"].Add($renderingName)
                    }

                    # ── Dynamic placeholder base name extraction (W39/F77) ──
                    # For each segment: strip XP-style UID suffix to get the base name,
                    # then look up in $psItemsByKey (populated in STEP 0.5).
                    foreach ($seg in $placeholderSegments) {
                        $seg = $seg.Trim()
                        # Primary regex: standard XP format baseName-{GUID}-N
                        $baseName = $seg -replace '-\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}-\d+$', ''
                        # Fallback: strip anything from the first { onward (handles corrupt/truncated GUIDs)
                        if ($baseName -match '\{') {
                            $baseName = ($baseName -split '\{')[0].TrimEnd('-')
                        }
                        if ([string]::IsNullOrWhiteSpace($baseName)) { continue }
                        $isDynamic = $baseName -ne $seg  # UID was stripped → dynamic

                        if (-not $dynamicPlaceholderBases.ContainsKey($baseName)) {
                            $dynamicPlaceholderBases[$baseName] = @{
                                baseName               = $baseName
                                isDynamic              = $isDynamic
                                hasPlaceholderSettings = $psItemsByKey.ContainsKey($baseName)
                                parentRenderings       = @{}  # renderingId → details (deduped)
                                usedInTemplates        = @{}  # template name → $true (deduped)
                                segmentPatterns        = @{}  # raw segment patterns seen
                            }
                        }
                        # Once marked dynamic, stays dynamic
                        if ($isDynamic) {
                            $dynamicPlaceholderBases[$baseName]["isDynamic"] = $true
                            $dynamicPlaceholderBases[$baseName]["segmentPatterns"][$seg] = $true
                        }
                        # Track template this placeholder appears on
                        $pageTemplateName = $pageItemData["template_name"]
                        if ($null -ne $pageTemplateName) {
                            $dynamicPlaceholderBases[$baseName]["usedInTemplates"][$pageTemplateName] = $true
                        }
                    }

                    # Track parent rendering for each placeholder base name
                    # The rendering we're processing RIGHT NOW sits IN this placeholder —
                    # the PARENT rendering is the one that DECLARES this placeholder.
                    # We'll link parent renderings below after all renderings are processed.

                    # Track rendering frequency per placeholder — used by STEP 8.5 SXA partial design inference
                    if ($null -ne $rendering.ItemID) {
                        $phRenderingId = $rendering.ItemID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                        if (-not $placeholderRenderingFrequency.ContainsKey($placeholderKey)) {
                            $placeholderRenderingFrequency[$placeholderKey] = @{}
                        }
                        if (-not $placeholderRenderingFrequency[$placeholderKey].ContainsKey($phRenderingId)) {
                            $placeholderRenderingFrequency[$placeholderKey][$phRenderingId] = 0
                        }
                        $placeholderRenderingFrequency[$placeholderKey][$phRenderingId]++
                    }

                    # Increment per-page counter for this placeholder (zero-cost — used to find representative page)
                    if (-not $pagePhCount.ContainsKey($placeholderKey)) { $pagePhCount[$placeholderKey] = 0 }
                    $pagePhCount[$placeholderKey]++
                }
            
                # Discover datasource items
                if ($null -ne $rendering.Datasource -and -not [string]::IsNullOrWhiteSpace($rendering.Datasource)) {
                    $datasourceValue = $rendering.Datasource.ToString().Trim()
                
                    # Skip queries and tokens
                    if (-not ($datasourceValue -match '^(query:|fast:|search:|\$|{[^0-9a-fA-F])')) {
                        $datasourceItem = $null
                    
                        # Try to resolve datasource item
                        if ($datasourceValue -match '^[{]?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}[}]?$') {
                            $datasourceItem = Get-ItemSafe -Path "master:" -ID $datasourceValue
                        }
                        elseif ($datasourceValue -match '^/sitecore/') {
                            $datasourceItem = Get-ItemSafe -Path "$($Database):$datasourceValue" -Language $Language
                        }
                    
                        if ($null -ne $datasourceItem) {
                            $datasourcePath = $datasourceItem.Paths.FullPath
                        
                            # Track datasource parent folder path for later recursive traversal
                            if (-not $datasourceItemPaths.ContainsKey($datasourcePath)) {
                                $datasourceItemPaths[$datasourcePath] = $true
                            
                                # Create minimal datasource item object — fields omitted to reduce memory usage
                                $dsTemplateId = $datasourceItem.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                                $dsItemObj = @{ path = $datasourcePath; template_id = $dsTemplateId }
                                [void]$datasourceItems.Add($dsItemObj)
                                $stats.datasource_items++
                            
                                # Track datasource folder path for recursive traversal.
                                # Skip paths inside /sitecore/templates/Branches/ — those items
                                # are branch template structure, already captured via $branchTemplateRootPaths.
                                $datasourceParent = Split-Path $datasourcePath -Parent
                                if (-not [string]::IsNullOrWhiteSpace($datasourceParent) -and
                                    -not $datasourceRootPaths.ContainsKey($datasourceParent) -and
                                    $datasourceParent -notmatch '^/sitecore/templates/branches') {
                                    $datasourceRootPaths[$datasourceParent] = $true
                                }
                            }
                        }
                    }
                }
            }
        }
    
        # Update representative page per placeholder (page with the most renderings in that slot)
        $pagePath = $pageItemData["path"]
        foreach ($phk in $pagePhCount.Keys) {
            $cnt = $pagePhCount[$phk]
            if (-not $placeholderMaxPage.ContainsKey($phk) -or $cnt -gt $placeholderMaxPage[$phk]["count"]) {
                $placeholderMaxPage[$phk] = @{ path = $pagePath; count = $cnt }
            }
        }

        $pageItemsProcessed++
    
        # Progress indicator
        if ($pageItemsProcessed % 50 -eq 0) {
            Write-Output-Line "  Analyzed $pageItemsProcessed / $($pageItems.Count) pages... (Renderings: $($renderingDetails.Count), Datasources: $($datasourceItemPaths.Count), Placeholders: $($placeholderSettings.Count))" "Cyan"
        }
    }

    $stats.page_items = $pageItems.Count

    Write-Output-Line "" "White"
    Write-Output-Line "✓ Analyzed $pageItemsProcessed page items" "Green"
    Write-Output-Line "✓ Discovered $($renderingDetails.Count) unique renderings USED on pages" "Green"
    Write-Output-Line "✓ Discovered $($datasourceItemPaths.Count) datasource items" "Green"
    Write-Output-Line "✓ Discovered $($datasourceTemplates.Count) datasource templates" "Green"
    Write-Output-Line "✓ Discovered $($renderingParameterTemplates.Count) rendering parameter templates" "Green"
    Write-Output-Line "✓ Discovered $($placeholderSettings.Count) unique placeholders" "Green"
    Write-Output-Line "" "Green"
    Write-Output-Line "Migration Flags (Special Attention Required):" "Yellow"
    Write-Output-Line "  ⚠ $($stats.renderings_with_component_graphql) renderings with Component GraphQL queries" "Cyan"
    Write-Output-Line "  ⚠ $($stats.renderings_with_resolvers) renderings with Rendering Contents Resolvers" "Cyan"
    Write-Output-Line "" "White"
    Write-Output-Line "Folder Paths Tracked for Recursive Traversal:" "Cyan"
    Write-Output-Line "  - Rendering Folders: $($renderingRootPaths.Count)" "White"
    Write-Output-Line "  - Datasource Folders: $($datasourceRootPaths.Count)" "White"
    Write-Output-Line "  - Branch Template Folders: $($branchTemplateRootPaths.Count)" "White"
    Write-Output-Line "  - Template Folders: $($templateRootPaths.Count)" "White"
    Write-Output-Line "  - Rendering Contents Resolver Folders: $($renderingContentsResolverRootPaths.Count)" "White"
    Write-Output-Line "" "White"

    # ── Link parent renderings to dynamic placeholder bases (W39) ──
    # For each rendering item, check its Placeholders field (Treelist of PS item GUIDs).
    # If a PS item's base key matches a dynamic placeholder base, that rendering is the parent.
    # Build a reverse map: PS item GUID → base name, then scan rendering Placeholders fields.
    $psGuidToBase = @{}
    foreach ($bk in $psItemsByKey.Keys) {
        $psGuidToBase[$psItemsByKey[$bk]["id"]] = $bk
    }
    foreach ($rdId in $renderingDetails.Keys) {
        $rd = $renderingDetails[$rdId]
        $phFieldValue = $rd["placeholders"]
        if ([string]::IsNullOrWhiteSpace($phFieldValue)) { continue }
        $phGuids = $phFieldValue -split '\|'
        foreach ($guid in $phGuids) {
            if ([string]::IsNullOrWhiteSpace($guid)) { continue }
            $cleanGuid = $guid.Replace("{", "").Replace("}", "").Replace("-", "")
            if ($psGuidToBase.ContainsKey($cleanGuid)) {
                $linkedBase = $psGuidToBase[$cleanGuid]
                if ($dynamicPlaceholderBases.ContainsKey($linkedBase)) {
                    $dynamicPlaceholderBases[$linkedBase]["parentRenderings"][$rdId] = @{
                        renderingId   = $rdId
                        renderingName = $rd["name"]
                        renderingPath = $rd["path"]
                        placeholders  = $phFieldValue
                    }
                }
            }
        }
    }
    $dynCount = @($dynamicPlaceholderBases.Values | Where-Object { $_["isDynamic"] }).Count
    Write-Output-Line "✓ Identified $($dynamicPlaceholderBases.Count) placeholder base names ($dynCount dynamic)" "Green"
    Write-Output-Line "" "White"

    Write-Output-Line "STEP 3: Discovering all renderings from tracked folders..." "Green"
    Write-Output-Line "" "White"

    if ($renderingRootPaths.Count -eq 0) {
        Write-Output-Line "⚠ No rendering folder paths discovered (no pages with renderings found)" "Yellow"
    }
    else {
        Write-Output-Line "Found $($renderingRootPaths.Count) unique rendering folder paths to traverse:" "Cyan"
        foreach ($rootPath in $renderingRootPaths.Keys) {
            Write-Output-Line "  - $rootPath" "White"
        }
        Write-Output-Line "" "White"
    
        # Rendering template IDs (common rendering templates)
        $renderingTemplateNames = @(
            "Json Rendering",
            "View Rendering", 
            "Controller Rendering",
            "Method Rendering",
            "Sublayout",
            "XSLT Rendering",
            "Url Rendering",
            "Razor Rendering",
            "WebControl Rendering"
        )
    
        $renderingProcessed = @{}
        $renderingCount = 0
        $renderingsByFolder = @{}  # Track renderings discovered per folder
    
        # Process each rendering folder path with .Axes.GetDescendants() (V3)
        $traversedRenderingRoots = New-Object System.Collections.ArrayList
        foreach ($rootPath in ($renderingRootPaths.Keys | Sort-Object Length, { $_ })) {
            if (@($traversedRenderingRoots | Where-Object { $rootPath.StartsWith($_ + '/', [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { continue }
            [void]$traversedRenderingRoots.Add($rootPath)
            $renderingsRoot = Get-DefinitionItemSafe -Path "$($Database):$rootPath"
        
            if ($null -eq $renderingsRoot) {
                throw "Rendering folder could not be read: $rootPath"
            }
        
            # V3: Single API call per folder instead of BFS queue
            $allRenderingDescendants = @($renderingsRoot) + @($renderingsRoot.Axes.GetDescendants() | Initialize-Item -ErrorAction Stop)
            $folderRenderingCount = 0
        
            foreach ($currentRendering in $allRenderingDescendants) {
            
                $renderingPath = $currentRendering.Paths.FullPath
                if ($renderingProcessed.ContainsKey($renderingPath)) {
                    continue
                }
                $renderingProcessed[$renderingPath] = $true
            
                # Check if this is a rendering item (not a folder)
                if (Test-IsRenderingDefinition -Item $currentRendering -TemplateNames $renderingTemplateNames) {
                    $renderingId = $currentRendering.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                    $isUsed = $renderingDetails.ContainsKey($renderingId)  # Check if discovered from page usage
                
                    $renderingData = Get-RenderingDefinitionDetail -Item $currentRendering
                    if ($isUsed) {
                        $renderingData['placeholder'] = $renderingDetails[$renderingId]['placeholder']
                        $renderingData['parameters'] = $renderingDetails[$renderingId]['parameters']
                    } else {
                        Register-RenderingDependencies -Item $currentRendering -Detail $renderingData -IsUsed $false
                    }
                    $sources = New-Object System.Collections.ArrayList
                    if ($isUsed) { [void]$sources.Add('page-usage') }
                    if ($availableRenderingItems.ContainsKey($renderingId)) { [void]$sources.Add('sxa-available-renderings') }
                    foreach ($configuredRoot in $configuredRenderingRoots) {
                        if ($currentRendering.Paths.FullPath -ieq $configuredRoot -or $currentRendering.Paths.FullPath.StartsWith($configuredRoot + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
                            [void]$sources.Add('configured-root')
                            break
                        }
                    }
                    if ($sources.Count -eq 0) { [void]$sources.Add('dependency-folder') }
                    $renderingData['discovery_sources'] = @($sources)
                    $renderingData['is_used'] = $isUsed
                    $renderingCatalog[$renderingId] = $renderingData

                    [void]$allRenderings.Add($renderingData)
                
                    $renderingCount++
                    $folderRenderingCount++
                    $stats.total_renderings++
                
                    # Track rendering definition templates (View Rendering, Json Rendering, etc.)
                    $templateId = $currentRendering.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                    if (-not $stats.rendering_templates.ContainsKey($templateId)) {
                        $stats.rendering_templates[$templateId] = $currentRendering.TemplateName
                    }
                }
            }
        
            # Store folder rendering count
            $renderingsByFolder[$rootPath] = $folderRenderingCount
        }
    
        Write-Output-Line "✓ Discovered $renderingCount renderings from $($renderingRootPaths.Count) folder paths" "Green"
        Write-Output-Line ""  "White"
        Write-Output-Line "Rendering Discovery Breakdown:" "Cyan"
        Write-Output-Line "  - Renderings USED on pages (STEP 2): $($renderingDetails.Count)" "White"
        Write-Output-Line "  - Total renderings in folders (STEP 3): $renderingCount" "White"
        Write-Output-Line "  - Additional renderings without observed usage: $($renderingCount - $renderingDetails.Count)" "White"
        Write-Output-Line "" "White"
        Write-Output-Line "Renderings by folder:" "Cyan"
        foreach ($folder in ($renderingsByFolder.Keys | Sort-Object)) {
            $count = $renderingsByFolder[$folder]
            Write-Output-Line "  - $folder : $count renderings" "White"
        }
    }

    Write-Output-Line "" "White"

    Write-Output-Line "STEP 3.5: Discovering rendering contents resolvers from tracked folders..." "Green"
    Write-Output-Line "" "White"

    if ($renderingContentsResolverRootPaths.Count -eq 0) {
        Write-Output-Line "⚠ No rendering contents resolver folder paths discovered (no renderings use resolvers)" "Yellow"
    }
    else {
        Write-Output-Line "Found $($renderingContentsResolverRootPaths.Count) unique resolver folder paths to traverse:" "Cyan"
        foreach ($rootPath in $renderingContentsResolverRootPaths.Keys) {
            Write-Output-Line "  - $rootPath" "White"
        }
        Write-Output-Line "" "White"
    
        # Rendering Contents Resolver template names
        $resolverTemplateNames = @(
            "Rendering Contents Resolver"
        )
    
        $resolverProcessed = @{}
        $resolverCount = 0
        $resolversByFolder = @{}  # Track resolvers discovered per folder
    
        # Process each resolver folder path with .Axes.GetDescendants() (V3)
        foreach ($rootPath in $renderingContentsResolverRootPaths.Keys) {
            $resolversRoot = Get-ItemSafe -Path "$($Database):$rootPath" -Language $Language
        
            if ($null -eq $resolversRoot) {
                Write-Output-Line "  ⚠ Resolver folder not found: $rootPath" "Yellow"
                continue
            }
        
            # V3: Single API call per folder instead of BFS queue
            $allResolverDescendants = @($resolversRoot) + @($resolversRoot.Axes.GetDescendants() | Initialize-Item)
            $folderResolverCount = 0
        
            foreach ($currentResolver in $allResolverDescendants) {
            
                $resolverPath = $currentResolver.Paths.FullPath
                if ($resolverProcessed.ContainsKey($resolverPath)) {
                    continue
                }
                $resolverProcessed[$resolverPath] = $true
            
                # Check if this is a resolver item (not a folder)
                if ($resolverTemplateNames -contains $currentResolver.TemplateName) {
                    $resolverId = $currentResolver.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                    $isUsed = $renderingContentsResolvers.ContainsKey($resolverId)  # Check if discovered from rendering usage
                
                    $resolverTypeField = $currentResolver.Fields["Type"]
                    $resolverType = if ($null -ne $resolverTypeField -and -not [string]::IsNullOrWhiteSpace($resolverTypeField.Value)) { $resolverTypeField.Value } else { $null }
                    $resolverData = @{
                        id            = $resolverId
                        name          = $currentResolver.Name
                        path          = $currentResolver.Paths.FullPath
                        template_id   = $currentResolver.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                        template_name = $currentResolver.TemplateName
                        is_used       = $isUsed
                        type          = $resolverType
                    }
                
                    [void]$allRenderingContentsResolvers.Add($resolverData)
                
                    $resolverCount++
                    $folderResolverCount++
                    $stats.total_rendering_contents_resolvers++
                }
            }
        
            # Store folder resolver count
            $resolversByFolder[$rootPath] = $folderResolverCount
        }
    
        Write-Output-Line "✓ Discovered $resolverCount rendering contents resolvers from $($renderingContentsResolverRootPaths.Count) folder paths" "Green"
        Write-Output-Line "" "White"
        Write-Output-Line "Resolver Discovery Breakdown:" "Cyan"
        Write-Output-Line "  - Resolvers USED by renderings: $($renderingContentsResolvers.Count)" "White"
        Write-Output-Line "  - Total resolvers in folders: $resolverCount" "White"
        Write-Output-Line "  - Additional unused resolvers: $($resolverCount - $renderingContentsResolvers.Count)" "White"
        Write-Output-Line "" "White"
        Write-Output-Line "Resolvers by folder:" "Cyan"
        foreach ($folder in ($resolversByFolder.Keys | Sort-Object)) {
            $count = $resolversByFolder[$folder]
            Write-Output-Line "  - $folder : $count resolvers" "White"
        }
    }

    Write-Output-Line "" "White"

    Write-Output-Line "STEP 4: Discovering branch templates from tracked folders..." "Green"
    Write-Output-Line "" "White"

    if ($branchTemplateRootPaths.Count -eq 0) {
        Write-Output-Line "⚠ No branch template folder paths discovered (no items created from branch templates)" "Yellow"
    }
    else {
        Write-Output-Line "Found $($branchTemplateRootPaths.Count) unique branch template folder paths to traverse:" "Cyan"
        foreach ($rootPath in $branchTemplateRootPaths.Keys) {
            Write-Output-Line "  - $rootPath" "White"
        }
        Write-Output-Line "" "White"
    
        # Branch template names (common branch template types)
        $branchTemplateNames = @(
            "Branch",
            "Command Template"
        )
    
        $branchProcessed = @{}
        $branchCount = 0
    
        # Process each branch template folder path with .Axes.GetDescendants() (V3)
        foreach ($rootPath in $branchTemplateRootPaths.Keys) {
            $branchesRoot = Get-ItemSafe -Path "$($Database):$rootPath" -Language $Language
        
            if ($null -eq $branchesRoot) {
                Write-Output-Line "  ⚠ Branch template folder not found: $rootPath" "Yellow"
                continue
            }
        
            # V3: Single API call per folder instead of BFS queue
            $allBranchDescendants = @($branchesRoot) + @($branchesRoot.Axes.GetDescendants() | Initialize-Item)
        
            foreach ($currentBranch in $allBranchDescendants) {
            
                $branchPath = $currentBranch.Paths.FullPath
                if ($branchProcessed.ContainsKey($branchPath)) {
                    continue
                }
                $branchProcessed[$branchPath] = $true
            
                # Check if this is a branch template item
                if ($branchTemplateNames -contains $currentBranch.TemplateName) {
                    $branchId = $currentBranch.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                
                    # Get branch template details
                    $baseTemplateField = $currentBranch.Fields["Branch"]
                    $baseTemplateId = if ($null -ne $baseTemplateField -and -not [string]::IsNullOrWhiteSpace($baseTemplateField.Value)) {
                        $baseTemplateField.Value.Replace("{", "").Replace("}", "").Replace("-", "")
                    }
                    else {
                        $null
                    }
                
                    $branchTemplates[$branchId] = @{
                        id            = $branchId
                        name          = $currentBranch.Name
                        path          = $currentBranch.Paths.FullPath
                        template_name = $currentBranch.TemplateName
                        base_template = $baseTemplateId
                    }
                
                    $branchCount++
                    $stats.total_branch_templates++
                }
            }
        }
    
        Write-Output-Line "✓ Discovered $branchCount branch templates from $($branchTemplateRootPaths.Count) folder paths" "Green"
    }

    Write-Output-Line "" "White"
    Write-Output-Line "STEP 5: Discovering all templates from tracked folders..." "Green"
    Write-Output-Line "" "White"

    if ($templateRootPaths.Count -eq 0) {
        Write-Output-Line "⚠ No template folder paths discovered (no templates found)" "Yellow"
    }
    else {
        Write-Output-Line "Found $($templateRootPaths.Count) unique template folder paths to traverse:" "Cyan"
        foreach ($rootPath in $templateRootPaths.Keys) {
            Write-Output-Line "  - $rootPath" "White"
        }
        Write-Output-Line "" "White"
    
        # Template template names (common template types)
        $templateTemplateNames = @(
            "Template",
            "Template folder"
        )
    
        $templateProcessed = @{}
        $templateFromFoldersCount = 0
    
        # Process each template folder path with .Axes.GetDescendants() (V3)
        foreach ($rootPath in $templateRootPaths.Keys) {
            $templatesRoot = Get-ItemSafe -Path "$($Database):$rootPath" -Language $Language
        
            if ($null -eq $templatesRoot) {
                Write-Output-Line "  ⚠ Template folder not found: $rootPath" "Yellow"
                continue
            }
        
            # V3: Single API call per folder instead of BFS queue
            $allTemplateDescendants = @($templatesRoot) + @($templatesRoot.Axes.GetDescendants() | Initialize-Item)
        
            foreach ($currentTemplate in $allTemplateDescendants) {
            
                $templatePath = $currentTemplate.Paths.FullPath
                if ($templateProcessed.ContainsKey($templatePath)) {
                    continue
                }
                $templateProcessed[$templatePath] = $true
            
                # Check if this is a template item (not a folder)
                if ($currentTemplate.TemplateName -eq "Template") {
                    $templateId = $currentTemplate.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                
                    # Check if this template is actually used by content items, datasources, or rendering parameters
                    $isUsed = $stats.content_item_templates.ContainsKey($templateId) -or `
                        $datasourceTemplates.ContainsKey($templateId) -or `
                        $renderingParameterTemplates.ContainsKey($templateId) -or `
                        $stats.page_templates.ContainsKey($templateId)
                
                    # Track discovered templates from folder traversal
                    if (-not $stats.discovered_templates.ContainsKey($templateId)) {
                        $stats.discovered_templates[$templateId] = @{
                            name    = $currentTemplate.Name
                            is_used = $isUsed
                        }
                    }
                
                    $templateFromFoldersCount++
                }
            }
        }
    
        Write-Output-Line "✓ Discovered $templateFromFoldersCount templates from $($templateRootPaths.Count) folder paths" "Green"
    }

    Write-Output-Line "" "White"
    Write-Output-Line "STEP 6: Analyzing template definitions and inheritance..." "Green"
    Write-Output-Line "" "White"

    # Collect all templates: content item templates, datasource templates, rendering parameter templates
    $allTemplateIds = @{}

    # Add content item templates (from STEP 1)
    foreach ($templateId in $stats.content_item_templates.Keys) {
        if (-not $allTemplateIds.ContainsKey($templateId)) {
            $allTemplateIds[$templateId] = $true
        }
    }

    # Add datasource templates (from STEP 2)
    foreach ($dsTemplateId in $datasourceTemplates.Keys) {
        if (-not $allTemplateIds.ContainsKey($dsTemplateId)) {
            $allTemplateIds[$dsTemplateId] = $true
        }
    }

    # Add rendering parameter templates (from STEP 2)
    foreach ($paramsTemplateId in $renderingParameterTemplates.Keys) {
        if (-not $allTemplateIds.ContainsKey($paramsTemplateId)) {
            $allTemplateIds[$paramsTemplateId] = $true
        }
    }

    # Add discovered templates from folder traversal (from STEP 5)
    foreach ($templateId in $stats.discovered_templates.Keys) {
        if (-not $allTemplateIds.ContainsKey($templateId)) {
            $allTemplateIds[$templateId] = $true
        }
    }

    Write-Output-Line "Analyzing $($allTemplateIds.Count) templates for inheritance and fields..." "Yellow"

    $templateInheritance = @{}

    # Get template items for all discovered templates
    foreach ($templateId in $allTemplateIds.Keys) {
        $templateItem = Get-ItemSafe -Path "master:" -ID $templateId
    
        if ($null -ne $templateItem) {
            # Get base templates
            $baseTemplatesField = $templateItem.Fields["__Base template"]
            $baseTemplates = New-Object System.Collections.ArrayList
        
            if ($null -ne $baseTemplatesField -and -not [string]::IsNullOrWhiteSpace($baseTemplatesField.Value)) {
                # Parse pipe-separated base template IDs
                $baseTemplateIds = $baseTemplatesField.Value -split '\|'
                foreach ($btId in $baseTemplateIds) {
                    if (-not [string]::IsNullOrWhiteSpace($btId)) {
                        $btItem = Get-ItemSafe -Path "master:" -ID $btId
                        if ($null -ne $btItem) {
                            [void]$baseTemplates.Add(@{
                                    id   = $btItem.ID.ToString().Replace("{", "").Replace("}", "").Replace("-", "")
                                    name = $btItem.Name
                                })
                        }
                    }
                }
            }
        
            # Get template fields
            $templateFields = New-Object System.Collections.ArrayList
            $standardValues = Get-ItemSafe -Path "$($templateItem.Paths.FullPath)/__Standard Values"
        
            # Get all sections and fields
            $sections = Get-ChildItemSafe -Path $templateItem.Paths.FullPath | Where-Object { $_.TemplateName -eq "Template section" }
            foreach ($section in $sections) {
                $fields = Get-ChildItemSafe -Path $section.Paths.FullPath | Where-Object { $_.TemplateName -eq "Template field" }
                foreach ($field in $fields) {
                    $fieldInfo = @{
                        id      = $field.ID.ToString().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
                        path    = $field.Paths.FullPath
                        source  = $field.Fields["Source"].Value
                        shared  = $field.Fields["Shared"].Value -eq "1"
                        unversioned = $field.Fields["Unversioned"].Value -eq "1"
                        name    = $field.Name
                        type    = $field.Fields["Type"].Value
                        section = $section.Name
                    }
                
                    # Get standard value if available
                    if ($null -ne $standardValues) {
                        $standardValueField = $standardValues.Fields[$field.Name]
                        if ($null -ne $standardValueField) {
                            $fieldInfo["standard_value"] = $standardValueField.Value
                        }
                    }
                
                    [void]$templateFields.Add($fieldInfo)
                }
            }
        
            # Get template name and usage status from any of our tracking sources
            $templateName = $templateItem.Name
            $isUsed = $false
        
            if ($stats.content_item_templates.ContainsKey($templateId)) {
                $templateName = $stats.content_item_templates[$templateId]
                $isUsed = $true
            }
            elseif ($stats.page_templates.ContainsKey($templateId)) {
                $templateName = $stats.page_templates[$templateId]
                $isUsed = $true
            }
            elseif ($datasourceTemplates.ContainsKey($templateId)) {
                $templateName = $datasourceTemplates[$templateId]
                $isUsed = $true
            }
            elseif ($renderingParameterTemplates.ContainsKey($templateId)) {
                $templateName = $renderingParameterTemplates[$templateId]
                $isUsed = $true
            }
            elseif ($stats.discovered_templates.ContainsKey($templateId)) {
                $templateInfo = $stats.discovered_templates[$templateId]
                if ($templateInfo -is [hashtable]) {
                    $templateName = $templateInfo["name"]
                    $isUsed = $templateInfo["is_used"]
                }
                else {
                    $templateName = $templateInfo
                }
            }
        
            $templateInheritance[$templateId] = @{
                id             = $templateId
                name           = $templateName
                path           = $templateItem.Paths.FullPath
                base_templates = $baseTemplates
                fields         = $templateFields
                is_used        = $isUsed
            }
        }
    }

    Write-Output-Line "✓ Analyzed $($templateInheritance.Count) templates for inheritance and fields" "Green"
    Write-Output-Line "" "White"

    # ==============================================================================
    # STEP 6.5: XP-ONLY TEMPLATE DEPENDENCY AUDIT
    # ==============================================================================
    # Classifies all resolved templates against known XP-only path prefixes.
    # These templates do not exist in XMCloud and will cause "Template ID X did not
    # exist" errors at push time if any serialized item references them.
    #
    # Data sources:
    #   - $templateInheritance: all templates resolved by STEP 6, including System
    #     templates referenced by content items (they are looked up even though they
    #     are excluded from serialization folder traversal)
    #   - $allItems + $datasourceItems: content items, used for reverse mapping
    #   - $branchTemplates: branch template items (scaffold CHILDREN are not
    #     individually tracked here — see branch scaffold scan below)
    #
    # Limitation: branch scaffold items (e.g. $name/Page Components/Event Image 1)
    # are part of the branch template module but are NOT in $allItems. A targeted
    # scan of $branchTemplateRootPaths is performed below to catch these.
    # ==============================================================================

    Write-Output-Line "" "White"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "STEP 6.5: XP-ONLY TEMPLATE DEPENDENCY AUDIT" "Cyan"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"
    Write-Output-Line "Classifying $($templateInheritance.Count) resolved templates against known XP-only paths..." "Yellow"
    Write-Output-Line "" "White"

    # Known XP-only template path prefixes (normalised to lowercase)
    $xpOnlyTemplateRoots = @(
        '/sitecore/templates/system/email/',
        '/sitecore/templates/system/analytics/',
        '/sitecore/templates/system/marketing automation/',
        '/sitecore/templates/system/marketing control panel/',
        '/sitecore/templates/system/xdb/',
        '/sitecore/templates/system/list management/'
    )

    # Build reverse map: templateId -> list of item paths using it
    # Covers content items and datasource items
    $templateToItemsMap = @{}
    foreach ($item in $allItems) {
        $tid = $item["template_id"]
        if (-not [string]::IsNullOrWhiteSpace($tid)) {
            if (-not $templateToItemsMap.ContainsKey($tid)) { $templateToItemsMap[$tid] = New-Object System.Collections.ArrayList }
            [void]$templateToItemsMap[$tid].Add(@{ path = $item["path"]; source = "content" })
        }
    }
    foreach ($item in $datasourceItems) {
        $tid = $item["template_id"]
        if (-not [string]::IsNullOrWhiteSpace($tid)) {
            if (-not $templateToItemsMap.ContainsKey($tid)) { $templateToItemsMap[$tid] = New-Object System.Collections.ArrayList }
            [void]$templateToItemsMap[$tid].Add(@{ path = $item["path"]; source = "datasource" })
        }
    }
    # Source 4: rendering parameter templates — rendering items that declare an XP-only param template
    # is_used:true means the rendering is actively placed on at least one live page (from STEP 2)
    foreach ($entry in $renderingParameterTemplateUsage) {
        $tid = $entry["paramTemplateId"]
        if (-not [string]::IsNullOrWhiteSpace($tid)) {
            if (-not $templateToItemsMap.ContainsKey($tid)) { $templateToItemsMap[$tid] = New-Object System.Collections.ArrayList }
            [void]$templateToItemsMap[$tid].Add(@{ path = $entry["renderingPath"]; source = "rendering-parameter-template"; is_used = $entry["is_used"] })
        }
    }

    # Targeted scan of branch template roots for scaffold item templates
    # Branch scaffold items (under $name/) are serialized with the branch module
    # but are not tracked in $allItems — scan them explicitly here
    $branchScaffoldTemplateIds = @{}  # templateId -> list of scaffold item paths
    foreach ($branchRoot in $branchTemplateRootPaths.Keys) {
        $rootItem = Get-ItemSafe -Path "$($Database):$branchRoot" -Language $Language
        if ($null -eq $rootItem) { continue }
        # V3: Single API call per branch root instead of BFS queue
        $allScaffoldDescendants = @($rootItem) + @($rootItem.Axes.GetDescendants() | Initialize-Item)
        foreach ($scaffoldItem in $allScaffoldDescendants) {
            $scaffoldTid = $scaffoldItem.TemplateID.ToString().Replace("{", "").Replace("}", "").Replace("-", "").ToLower()
            if (-not $branchScaffoldTemplateIds.ContainsKey($scaffoldTid)) {
                $branchScaffoldTemplateIds[$scaffoldTid] = New-Object System.Collections.ArrayList
            }
            [void]$branchScaffoldTemplateIds[$scaffoldTid].Add($scaffoldItem.Paths.FullPath)
            # Also add to main templateToItemsMap for reverse lookup
            if (-not $templateToItemsMap.ContainsKey($scaffoldTid)) { $templateToItemsMap[$scaffoldTid] = New-Object System.Collections.ArrayList }
            [void]$templateToItemsMap[$scaffoldTid].Add(@{ path = $scaffoldItem.Paths.FullPath; source = "branch-scaffold" })
            # Resolve template item if not already in templateInheritance
            if (-not $templateInheritance.ContainsKey($scaffoldTid)) {
                $scaffoldTmplItem = Get-ItemSafe -Path "$($Database):/" -ID ("{" + $scaffoldTid + "}") -Language $Language
                if ($null -ne $scaffoldTmplItem) {
                    $templateInheritance[$scaffoldTid] = @{
                        id    = $scaffoldTid
                        name  = $scaffoldTmplItem.Name
                        path  = $scaffoldTmplItem.Paths.FullPath
                        is_used = $true
                    }
                }
            }
        }
    }
    Write-Output-Line "  Branch scaffold scan: resolved $($branchScaffoldTemplateIds.Count) unique template IDs from branch roots" "White"

    # Classify all templates, flag XP-only ones
    $xpOnlyTemplateIssues = New-Object System.Collections.ArrayList

    foreach ($templateId in @($templateInheritance.Keys)) {
        $tmpl = $templateInheritance[$templateId]
        $templatePath = $tmpl["path"]
        if ([string]::IsNullOrWhiteSpace($templatePath)) { continue }

        $pathLower = $templatePath.ToLower()
        $matchedRoot = $null
        foreach ($root in $xpOnlyTemplateRoots) {
            if ($pathLower.StartsWith($root)) { $matchedRoot = $root; break }
        }
        if ($null -eq $matchedRoot) { continue }

        # Classify by module area
        $classification = if     ($pathLower -like '*/email/*')                  { 'ECM (Email Campaign Manager) — not present in XMCloud' }
                          elseif ($pathLower -like '*/analytics/*')               { 'XP Analytics — not present in XMCloud' }
                          elseif ($pathLower -like '*/marketing automation/*')    { 'XP Marketing Automation — not present in XMCloud' }
                          elseif ($pathLower -like '*/marketing control panel/*') { 'XP Marketing Control Panel — not present in XMCloud' }
                          elseif ($pathLower -like '*/xdb/*')                     { 'xDB — not present in XMCloud' }
                          elseif ($pathLower -like '*/list management/*')          { 'XP List Management — not present in XMCloud' }
                          else                                                     { 'XP-only system template — not present in XMCloud' }

        # Reverse map: which items use this template
        $usingItems = if ($templateToItemsMap.ContainsKey($templateId)) {
            @($templateToItemsMap[$templateId])
        } else { @() }

        # Suggestion algorithm: find templates in $templateInheritance with same leaf name, not XP-only
        $templateLeafName = Split-Path $templatePath -Leaf
        $suggestions = New-Object System.Collections.ArrayList
        foreach ($candidateId in @($templateInheritance.Keys)) {
            if ($candidateId -eq $templateId) { continue }
            $candidate = $templateInheritance[$candidateId]
            $candidatePath = $candidate["path"]
            if ([string]::IsNullOrWhiteSpace($candidatePath)) { continue }
            # Skip XP-only candidates
            $candidatePathLower = $candidatePath.ToLower()
            $candidateIsXp = $false
            foreach ($root in $xpOnlyTemplateRoots) {
                if ($candidatePathLower.StartsWith($root)) { $candidateIsXp = $true; break }
            }
            if ($candidateIsXp) { continue }
            # Name match on leaf segment
            $candidateLeaf = Split-Path $candidatePath -Leaf
            if ($candidateLeaf -ieq $templateLeafName) {
                [void]$suggestions.Add(@{
                    templateId   = $candidateId
                    templatePath = $candidatePath
                    confidence   = 'medium'
                    reasoning    = "Template named '$templateLeafName' exists in serialization scope at a non-XP-only path"
                })
            }
        }

        [void]$xpOnlyTemplateIssues.Add(@{
            templateId           = $templateId
            templatePath         = $templatePath
            classification       = $classification
            usedByItemCount      = $usingItems.Count
            usedByItems          = $usingItems
            suggestedReplacements = @($suggestions)
        })
    }

    $script:xpOnlyTemplateAudit = @{
        issueCount            = $xpOnlyTemplateIssues.Count
        issues                = @($xpOnlyTemplateIssues)
        branchScaffoldScanned = $branchTemplateRootPaths.Count
    }

    if ($xpOnlyTemplateIssues.Count -eq 0) {
        Write-Output-Line "  ✓ No XP-only template dependencies found" "Green"
    } else {
        Write-Output-Line "  ⚠ $($xpOnlyTemplateIssues.Count) XP-only template issue(s) found — these will fail at push time:" "Yellow"
        foreach ($issue in $xpOnlyTemplateIssues) {
            $suggestCount = $issue["suggestedReplacements"].Count
            $usedCount    = $issue["usedByItemCount"]
            Write-Output-Line "    - $($issue['templatePath'])" "Yellow"
            Write-Output-Line "      Classification: $($issue['classification'])" "Gray"
            Write-Output-Line "      Used by $usedCount item(s). Suggestions: $suggestCount" "Gray"
        }
    }
    Write-Output-Line "" "White"
    Write-Output-Line "✓ STEP 6.5 complete" "Green"
    Write-Output-Line "" "White"

    # ── Populate $placeholderSettingItems from STEP 0.5 data (replaces old STEP 7 BFS) ──
    # Only include PS items whose key matches a placeholder base name discovered during the
    # page crawl ($dynamicPlaceholderBases). This keeps results scoped to what the site actually
    # uses, consistent with the discovery script's methodology of walking the site tree first
    # and then expanding only to referenced items.
    $filteredCount = 0
    foreach ($psKey in $psItemsByKey.Keys) {
        if ($dynamicPlaceholderBases.ContainsKey($psKey)) {
            $psData = $psItemsByKey[$psKey]
            $placeholderSettingItems[$psData["id"]] = $psData
            $filteredCount++
        }
    }
    $stats.total_placeholder_settings = $filteredCount
    Write-Output-Line "✓ $filteredCount of $($psItemsByKey.Count) Placeholder Settings items matched site placeholders (from STEP 0.5)" "Green"
    Write-Output-Line "" "White"

    Write-Output-Line "STEP 8: Generating migration manifest and output..." "Green"
    Write-Output-Line "" "White"

    $endTime = Get-Date
    $duration = $endTime - $stats.start_time

    # Convert template inheritance to array using ArrayList
    $templatesArray = New-Object System.Collections.ArrayList
    foreach ($templateId in $templateInheritance.Keys) {
        [void]$templatesArray.Add($templateInheritance[$templateId])
    }

    # Export the complete catalog while keeping the used-rendering collection separate.
    foreach ($renderingId in $renderingDetails.Keys) {
        if (-not $renderingCatalog.ContainsKey($renderingId)) {
            $renderingCatalog[$renderingId] = $renderingDetails[$renderingId].Clone()
        }
    }
    $renderingsDetailedArray = New-Object System.Collections.ArrayList
    $globalThreshold = [math]::Ceiling($pageItems.Count * 0.8)
    foreach ($renderingId in ($renderingCatalog.Keys | Sort-Object)) {
        $detail = $renderingCatalog[$renderingId]
        $frequency = 0
        if ($renderingPageMapping.ContainsKey($renderingId)) { $frequency = $renderingPageMapping[$renderingId].Count }
        $detail['pageFrequency'] = if ($script:renderingUsageComplete) { $frequency } else { $null }
        $detail['isGlobal'] = $script:renderingUsageComplete -and $pageItems.Count -gt 0 -and $frequency -ge $globalThreshold
        $detail['is_used'] = $frequency -gt 0
        $detail['usageStatus'] = if ($frequency -gt 0) { 'used' } elseif ($script:renderingUsageComplete) { 'not-used-in-scanned-scope' } else { 'unknown' }
        [void]$renderingsDetailedArray.Add($detail)
    }

    # Convert placeholder settings to array using ArrayList
    # Match each placeholder path against $psItemsByKey using base name extraction (W39/F77)
    $placeholdersArray = New-Object System.Collections.ArrayList
    foreach ($placeholder in $placeholderSettings.Keys) {
        $phData = $placeholderSettings[$placeholder]
    
        # Extract base names from segments and try to find matching PS item
        $matchingSettingItem = $null
        $phSegments = $placeholder -split '/' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        foreach ($seg in $phSegments) {
            $base = $seg -replace '-\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}-\d+$', ''
            if ($psItemsByKey.ContainsKey($base)) {
                $matchingSettingItem = $psItemsByKey[$base]
                # Prefer the LAST (deepest) segment match — that's the one this placeholder is actually about
            }
        }
        # Also try direct key match (for top-level placeholders like "lockedbottom")
        if ($null -eq $matchingSettingItem -and $psItemsByKey.ContainsKey($placeholder)) {
            $matchingSettingItem = $psItemsByKey[$placeholder]
        }
    
        # Enhance with placeholder settings data if found
        if ($null -ne $matchingSettingItem) {
            $phData["setting_item_id"] = $matchingSettingItem["id"]
            $phData["setting_item_path"] = $matchingSettingItem["path"]
            $phData["allowed_renderings"] = $matchingSettingItem["allowed_renderings"]
            $phData["metadata_placeholder"] = $matchingSettingItem["metadata_placeholder"]
            $phData["is_editable"] = $matchingSettingItem["editable"]
        }
    
        [void]$placeholdersArray.Add($phData)
    }

    # Retain settings explicitly referenced by inventory-only renderings too.
    # These may never occur in the scanned page layouts. Reuse the global settings
    # lookup collected in STEP 0.5 rather than issuing a read for every rendering.
    $psItemsById = @{}
    foreach ($setting in $psItemsByKey.Values) {
        $psItemsById[([string]$setting['id']).Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()] = $setting
    }
    foreach ($definition in $renderingCatalog.Values) {
        foreach ($reference in @(([string]$definition['placeholders']) -split '\|')) {
            if ([string]::IsNullOrWhiteSpace($reference)) { continue }
            $referenceId = $reference.Trim().Replace('{', '').Replace('}', '').Replace('-', '').ToLowerInvariant()
            $setting = $psItemsById[$referenceId]
            if ($null -eq $setting -and $psItemsByKey.ContainsKey($reference.Trim())) { $setting = $psItemsByKey[$reference.Trim()] }
            if ($null -ne $setting) {
                $placeholderSettingItems[$setting['id']] = $setting
            } else {
                Register-UnresolvedRenderingReference -Id $reference -SourceItemPath $definition['path'] -DiscoverySource 'placeholder-settings' -Reason 'Placeholder settings could not be resolved'
            }
        }
    }
    $stats.total_placeholder_settings = $placeholderSettingItems.Count

    # Convert placeholder setting items to array using ArrayList
    $placeholderSettingItemsArray = New-Object System.Collections.ArrayList
    foreach ($settingId in $placeholderSettingItems.Keys) {
        [void]$placeholderSettingItemsArray.Add($placeholderSettingItems[$settingId])
    }

    # Convert branch templates to array using ArrayList
    $branchTemplatesArray = New-Object System.Collections.ArrayList
    foreach ($branchId in $branchTemplates.Keys) {
        [void]$branchTemplatesArray.Add($branchTemplates[$branchId])
    }

    # Convert rendering contents resolvers details to array using ArrayList
    $renderingContentsResolversDetailedArray = New-Object System.Collections.ArrayList
    foreach ($resolverId in $renderingContentsResolvers.Keys) {
        [void]$renderingContentsResolversDetailedArray.Add($renderingContentsResolvers[$resolverId])
    }

    # Convert hashtables to serializable formats for JSON using ArrayList
    $templatesList = New-Object System.Collections.ArrayList
    foreach ($templateId in $stats.content_item_templates.Keys) {
        [void]$templatesList.Add(@{
                id   = $templateId
                name = $stats.content_item_templates[$templateId]
            })
    }

    $itemsByDepthList = New-Object System.Collections.ArrayList
    foreach ($depth in ($stats.items_by_depth.Keys | Sort-Object)) {
        [void]$itemsByDepthList.Add(@{
                depth = $depth
                count = $stats.items_by_depth[$depth]
            })
    }

    # Note: Removed unused $output object that was duplicating memory

    # Display summary
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "DEPENDENCY-DRIVEN DISCOVERY COMPLETE" "Cyan"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"
    Write-Output-Line "Duration: $([math]::Round($duration.TotalMinutes, 2)) minutes" "Yellow"
    Write-Output-Line "" "White"
    Write-Output-Line "Discovery Summary:" "Yellow"
    Write-Output-Line "  - Total Items Crawled: $($stats.total_items)" "White"
    Write-Output-Line "  - Page Items: $($pageItems.Count)" "White"
    Write-Output-Line "  - Datasource Items: $($datasourceItems.Count)" "White"
    Write-Output-Line "" "White"
    Write-Output-Line "Discovered Folders (for recursive traversal):" "Yellow"
    Write-Output-Line "  - Rendering Folders: $($renderingRootPaths.Count)" "White"
    Write-Output-Line "  - Datasource Folders: $($datasourceRootPaths.Count)" "White"
    Write-Output-Line "  - Branch Template Folders: $($branchTemplateRootPaths.Count)" "White"
    Write-Output-Line "  - Template Folders: $($templateRootPaths.Count)" "White"
    Write-Output-Line "  - Rendering Contents Resolver Folders: $($renderingContentsResolverRootPaths.Count)" "White"
    Write-Output-Line "" "White"
    Write-Output-Line "Items Discovered from Folders:" "Yellow"
    Write-Output-Line "  - Renderings (used on pages): $($renderingDetails.Count)" "White"
    Write-Output-Line "  - Renderings (total discovered): $($stats.total_renderings)" "White"
    Write-Output-Line "  - Renderings (without observed usage): $($stats.total_renderings - $renderingDetails.Count)" "Yellow"
    Write-Output-Line "  - Rendering Contents Resolvers (used): $($renderingContentsResolvers.Count)" "White"
    Write-Output-Line "  - Rendering Contents Resolvers (total): $($allRenderingContentsResolvers.Count)" "White"
    Write-Output-Line "  - Branch Templates: $($stats.total_branch_templates)" "White"
    Write-Output-Line "" "White"
    Write-Output-Line "Migration Flags (Special Attention Required):" "Yellow"
    Write-Output-Line "  ⚠ Component GraphQL: $($stats.renderings_with_component_graphql) renderings" "Cyan"
    Write-Output-Line "  ⚠ Rendering Contents Resolvers: $($stats.renderings_with_resolvers) renderings" "Cyan"
    Write-Output-Line "    Note: These items require special migration handling for XM Cloud compatibility" "Gray"
    Write-Output-Line "" "White"
    # Calculate template usage statistics
    $usedTemplatesCount = 0
    $unusedTemplatesCount = 0
    foreach ($templateId in $stats.discovered_templates.Keys) {
        $templateInfo = $stats.discovered_templates[$templateId]
        if ($templateInfo -is [hashtable] -and $templateInfo["is_used"]) {
            $usedTemplatesCount++
        }
        elseif ($templateInfo -is [hashtable] -and -not $templateInfo["is_used"]) {
            $unusedTemplatesCount++
        }
    }

    Write-Output-Line "Template Breakdown:" "Yellow"
    Write-Output-Line "  - Page Templates: $($stats.page_templates.Count) (templates used by items with layouts/presentation)" "White"
    Write-Output-Line "  - Content Item Templates: $($stats.content_item_templates.Count) (all templates used by content items)" "White"
    Write-Output-Line "  - Datasource Templates: $($datasourceTemplates.Count) (templates specified in rendering configs)" "White"
    Write-Output-Line "  - Rendering Parameter Templates: $($renderingParameterTemplates.Count)" "White"
    Write-Output-Line "  - Rendering Definition Templates: $($stats.rendering_templates.Count) (View Rendering, Json Rendering, etc.)" "White"
    Write-Output-Line "  - Templates from Folder Traversal: $($stats.discovered_templates.Count) ($usedTemplatesCount used, $unusedTemplatesCount unused)" "White"
    Write-Output-Line "" "White"
    Write-Output-Line "Placeholder Analysis:" "Yellow"
    Write-Output-Line "  - Unique Placeholders: $($placeholderSettings.Count)" "White"
    Write-Output-Line "  - Placeholder Settings Items: $($stats.total_placeholder_settings)" "White"
    Write-Output-Line "" "White"

    # ==============================================================================
    # DATA QUALITY: DUPLICATE ITEM DETECTION
    # ==============================================================================
    # Detects items that share the same parent + name (non-unique paths).
    # These cause "Non-unique paths cannot be serialized" errors in Sitecore CLI.
    # Uses direct SQL for efficiency rather than recursive SPE traversal.
    # ==============================================================================
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "DATA QUALITY: DUPLICATE ITEM DETECTION" "Cyan"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"
    Write-Output-Line "Scanning for non-unique paths (same parent + name) via SQL..." "Yellow"

    $duplicateItems = @()
    try {
        $sql = @"
SELECT ParentID, Name, COUNT(*) AS Cnt
FROM Items
GROUP BY ParentID, Name
HAVING COUNT(*) > 1
ORDER BY Cnt DESC
"@
        $connStr = [Sitecore.Configuration.Settings]::GetConnectionString($Database)
        $sqlConn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $cmd = New-Object System.Data.SqlClient.SqlCommand($sql, $sqlConn)
        $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($cmd)
        $dt = New-Object System.Data.DataTable
        $sqlConn.Open()
        $adapter.Fill($dt) | Out-Null
        $sqlConn.Close()

        $db = [Sitecore.Configuration.Factory]::GetDatabase($Database)
        $linkDb = [Sitecore.Globals]::LinkDatabase

        foreach ($row in $dt.Rows) {
            $parentId = $row["ParentID"].ToString()
            $name = $row["Name"]
            $cnt = [int]$row["Cnt"]

            $parentItem = $db.GetItem([Sitecore.Data.ID]::Parse($parentId))
            if (-not $parentItem) { continue }

            # Resolve each duplicate item's ID, dates, and incoming link count
            $childItems = $parentItem.Children | Where-Object { $_.Name -eq $name }
            $itemDetails = foreach ($child in $childItems) {
                $linkCount = $linkDb.GetReferrers($child).Count
                [PSCustomObject]@{
                    ID           = $child.ID.ToString()
                    Created      = $child.Fields["__Created"].Value
                    CreatedBy    = $child.Fields["__Created by"].Value
                    Updated      = $child.Fields["__Updated"].Value
                    IncomingLinks = $linkCount
                }
            }

            $duplicateItems += [PSCustomObject]@{
                ParentPath   = $parentItem.Paths.FullPath
                Name         = $name
                Count        = $cnt
                Items        = $itemDetails
                HasLinks     = ($itemDetails | Where-Object { $_.IncomingLinks -gt 0 }).Count -gt 0
            }
        }

        if ($duplicateItems.Count -eq 0) {
            Write-Output-Line "  ✓ No duplicate items detected - all paths are unique" "Green"
        }
        else {
            Write-Output-Line "  ⚠ Found $($duplicateItems.Count) duplicate path group(s):" "Yellow"
            foreach ($dup in $duplicateItems) {
                $linkWarning = if ($dup.HasLinks) { " [HAS INCOMING LINKS - review before deleting]" } else { " [safe to delete older]" }
                Write-Output-Line "    - $($dup.ParentPath)/$($dup.Name) ($($dup.Count) items)$linkWarning" "Yellow"
            }
            Write-Output-Line "" "White"
            Write-Output-Line "  ⚠ These duplicates WILL cause 'Non-unique paths cannot be serialized' errors" "Red"
            Write-Output-Line "    during Sitecore CLI pull/push. Resolve before running serialization." "Red"
        }
    }
    catch {
        Write-Output-Line "  ⚠ Duplicate detection skipped: $($_.Exception.Message)" "Yellow"
    }

    Write-Output-Line "" "White"
    Write-Output-Line ("=" * 80) "Cyan"

    # ==============================================================================
    # STEP 8.5: SXA READINESS ANALYSIS
    # ==============================================================================
    # Examines the site and rendering structure to determine what work is needed
    # to convert this content tree to a fully-structured Headless SXA site.
    #
    # Produces $script:sxaReadiness with three sections:
    #   site_structure           — template of site root, SXA scaffolding presence
    #   module_status            — per rendering folder: registered/partial/unregistered
    #   partial_design_candidates — renderings in locked/shared placeholders across most
    #                               pages, inferred as Partial Design candidates
    # ==============================================================================

    Write-Output-Line "" "White"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "STEP 8.5: SXA READINESS ANALYSIS" "Cyan"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"

    $script:sxaReadiness = @{}

    # ── 1. Site root structure ──────────────────────────────────────────────────
    $sxaSiteRoot          = Get-ItemSafe -Path "$($Database):$SiteRootPath"
    $siteRootTemplateId   = ""
    $siteRootTemplateName = ""
    $siteRootId           = ""

    if ($null -ne $sxaSiteRoot) {
        $siteRootTemplateId   = $sxaSiteRoot.TemplateID.ToString()
        $siteRootTemplateName = $sxaSiteRoot.TemplateName
        $siteRootId           = $sxaSiteRoot.ID.ToString()
    }

    # Known SXA template IDs
    $headlessSiteTemplateId   = "{8E9E653B-E020-401E-B4B8-9B0B2E4A4C91}"
    $headlessTenantTemplateId = "{F49BEED6-989A-4768-9F1F-CA91A6C78823}"

    $isSxaSite   = ($siteRootTemplateId -eq $headlessSiteTemplateId)
    $isSxaTenant = ($siteRootTemplateId -eq $headlessTenantTemplateId)

    # Check for SXA sub-structure under site root
    $hasPresentationFolder  = $null -ne (Get-ItemSafe -Path "$($Database):$SiteRootPath/Presentation")
    $hasPageDesigns         = $null -ne (Get-ItemSafe -Path "$($Database):$SiteRootPath/Presentation/Page Designs")
    $hasPartialDesigns      = $null -ne (Get-ItemSafe -Path "$($Database):$SiteRootPath/Presentation/Partial Designs")
    $hasAvailableRenderings = $null -ne (Get-ItemSafe -Path "$($Database):$SiteRootPath/Presentation/Available Renderings")

    # Check for tenant wrapper immediately above the site root
    $tenantParentPath    = Split-Path $SiteRootPath -Parent
    $tenantParentItem    = if (-not [string]::IsNullOrWhiteSpace($tenantParentPath)) { Get-ItemSafe -Path "$($Database):$tenantParentPath" } else { $null }
    $tenantParentTemplId = if ($null -ne $tenantParentItem) { $tenantParentItem.TemplateID.ToString() } else { "" }
    $hasTenantAbove      = ($tenantParentTemplId -eq $headlessTenantTemplateId)

    Write-Output-Line "  Site root template : $siteRootTemplateName ($siteRootTemplateId)" "White"
    Write-Output-Line "  Is HeadlessSite    : $isSxaSite" "$(if ($isSxaSite) { 'Green' } else { 'Yellow' })"
    Write-Output-Line "  Has tenant above   : $hasTenantAbove" "$(if ($hasTenantAbove) { 'Green' } else { 'Yellow' })"
    Write-Output-Line "  Presentation/      : $hasPresentationFolder" "$(if ($hasPresentationFolder) { 'Green' } else { 'Yellow' })"
    Write-Output-Line "  Page Designs/      : $hasPageDesigns" "$(if ($hasPageDesigns) { 'Green' } else { 'Yellow' })"
    Write-Output-Line "  Partial Designs/   : $hasPartialDesigns" "$(if ($hasPartialDesigns) { 'Green' } else { 'Yellow' })"
    Write-Output-Line "  Avail. Renderings/ : $hasAvailableRenderings" "$(if ($hasAvailableRenderings) { 'Green' } else { 'Yellow' })"
    Write-Output-Line "" "White"

    # ── 2. Module registration status per rendering folder ──────────────────────
    Write-Output-Line "  Checking SXA module registration for $($renderingRootPaths.Count) rendering folder(s)..." "Yellow"
    Write-Output-Line "" "White"

    $moduleStatusList = New-Object System.Collections.ArrayList

    foreach ($renderingFolder in ($renderingRootPaths.Keys | Sort-Object)) {
        # Derive layer and module name from rendering path
        # Expected: /sitecore/layout/Renderings/{Layer}/{ModuleName}
        $segments   = $renderingFolder.Split('/') | Where-Object { $_ }
        $layerIdx   = [Array]::IndexOf($segments, "Renderings")
        $modLayer   = if ($layerIdx -ge 0 -and ($layerIdx + 1) -lt $segments.Count) { $segments[$layerIdx + 1] } else { $null }
        $modName    = if ($layerIdx -ge 0 -and ($layerIdx + 2) -lt $segments.Count) { $segments[$layerIdx + 2] } else { $null }

        $settingsPath = if ($modLayer -and $modName) { "/sitecore/system/Settings/$modLayer/$modName" } else { $null }
        $branchPath   = if ($modLayer -and $modName) { "/sitecore/templates/Branches/$modLayer/$modName" } else { $null }

        $settingsItem = if ($settingsPath) { Get-ItemSafe -Path "$($Database):$settingsPath" } else { $null }
        $branchItem   = if ($branchPath)   { Get-ItemSafe -Path "$($Database):$branchPath"   } else { $null }

        # Check if AddItem (Available Renderings wiring) exists under HeadlessSiteSetupRoot
        $addItemExists = $false
        if ($null -ne $settingsItem) {
            $siteSetupRoot = $settingsItem.Children | Where-Object { $_.TemplateName -eq "HeadlessSiteSetupRoot" } | Select-Object -First 1
            if ($null -ne $siteSetupRoot) {
                $addItemExists = ($siteSetupRoot.Children | Where-Object { $_.TemplateName -eq "AddItem" }).Count -gt 0
            }
        }

        # Count rendering items whose path lives under this folder
        $modRenderingCount = ($renderingDetails.Values | Where-Object {
            $rp = $_["path"]
            $rp.StartsWith($renderingFolder + "/") -or (Split-Path $rp -Parent) -eq $renderingFolder
        }).Count

        $status = if (-not $settingsItem)   { "unregistered" }
                  elseif (-not $addItemExists) { "partial" }
                  else                       { "registered" }

        $statusColor = switch ($status) {
            "registered"   { "Green" }
            "partial"      { "Yellow" }
            "unregistered" { "Red" }
        }
        Write-Output-Line "    [$status] $renderingFolder  (layer=$modLayer, module=$modName, renderings=$modRenderingCount)" $statusColor

        [void]$moduleStatusList.Add(@{
            rendering_folder = $renderingFolder
            layer            = $modLayer
            module_name      = $modName
            settings_path    = $settingsPath
            branch_path      = $branchPath
            settings_exists  = ($null -ne $settingsItem)
            branch_exists    = ($null -ne $branchItem)
            add_item_exists  = $addItemExists
            status           = $status
            rendering_count  = $modRenderingCount
        })
    }

    $modRegistered   = ($moduleStatusList | Where-Object { $_["status"] -eq "registered" }).Count
    $modPartial      = ($moduleStatusList | Where-Object { $_["status"] -eq "partial" }).Count
    $modUnregistered = ($moduleStatusList | Where-Object { $_["status"] -eq "unregistered" }).Count

    Write-Output-Line "" "White"
    Write-Output-Line "  Module summary: $modRegistered registered, $modPartial partial, $modUnregistered unregistered" "Cyan"
    Write-Output-Line "" "White"

    # ── 3. Partial design candidates (rendering frequency per placeholder) ──────
    Write-Output-Line "  Analysing placeholder rendering frequency for Partial Design candidates..." "Yellow"
    Write-Output-Line "" "White"

    # Placeholder name patterns that signal a shared layout slot
    $sharedPlaceholderPatterns = @(
        "lockedtop", "lockedbottom", "lockedleft", "lockedright",
        "header", "footer",
        "headless-header", "headless-footer",
        "jss-header", "jss-footer"
    )

    $partialDesignCandidates = New-Object System.Collections.ArrayList
    $totalPagesCount = $pageItems.Count

    foreach ($phKey in ($placeholderRenderingFrequency.Keys | Sort-Object)) {
        # Normalise: strip leading slash and dynamic GUID segments
        $normKey = $phKey.TrimStart('/') -replace '/[{]?[0-9a-fA-F\-]{32,36}[}]?', ''
        $leafKey = ($normKey -split '/')[-1]

        $isNamedShared = $false
        foreach ($pat in $sharedPlaceholderPatterns) {
            if ($leafKey -imatch $pat) { $isNamedShared = $true; break }
        }

        # Build per-rendering frequency list for this placeholder
        $rfList = New-Object System.Collections.ArrayList
        foreach ($rid in $placeholderRenderingFrequency[$phKey].Keys) {
            $rName  = if ($renderingDetails.ContainsKey($rid)) { $renderingDetails[$rid]["name"] } else { $rid }
            $rCount = $placeholderRenderingFrequency[$phKey][$rid]
            $rPct   = if ($totalPagesCount -gt 0) { [math]::Round(($rCount / $totalPagesCount) * 100, 1) } else { 0 }
            [void]$rfList.Add(@{
                rendering_id   = $rid
                rendering_name = $rName
                page_count     = $rCount
                page_pct       = $rPct
            })
        }
        $sortedRf = $rfList | Sort-Object { $_["page_count"] } -Descending

        $hasHighFreq = ($sortedRf | Where-Object { $_["page_pct"] -ge 80 }) -ne $null

        if ($isNamedShared -or $hasHighFreq) {
            # Representative page: the page with the most renderings in this placeholder (site-relative path)
            $repPageAbs = if ($placeholderMaxPage.ContainsKey($phKey)) { $placeholderMaxPage[$phKey]["path"] } else { $null }
            $repCount   = if ($placeholderMaxPage.ContainsKey($phKey)) { $placeholderMaxPage[$phKey]["count"] } else { 0 }
            $repPage    = if ($repPageAbs -and $repPageAbs.ToLower().StartsWith($SiteRootPath.ToLower())) { $repPageAbs.Substring($SiteRootPath.Length) } else { $repPageAbs }

            [void]$partialDesignCandidates.Add(@{
                placeholder_key          = $phKey
                normalized_key           = $normKey
                is_named_shared_slot     = $isNamedShared
                has_high_freq            = $hasHighFreq
                total_pages              = $totalPagesCount
                representative_page_path = $repPage
                representative_page_rendering_count = $repCount
                renderings               = @($sortedRf)
            })

            $label = if ($isNamedShared) { "[shared slot]" } else { "[high-freq]  " }
            Write-Output-Line "    $label $phKey" "Cyan"
            foreach ($rf in ($sortedRf | Select-Object -First 4)) {
                Write-Output-Line "        $($rf['rendering_name']): $($rf['page_count']) pages ($($rf['page_pct'])%)" "White"
            }
        }
    }

    Write-Output-Line "" "White"
    Write-Output-Line "  $($partialDesignCandidates.Count) partial design candidate slot(s) identified" "Cyan"
    Write-Output-Line "" "White"

    # ── 4. Assemble result ───────────────────────────────────────────────────────
    $script:sxaReadiness = @{
        site_structure = @{
            site_root_path        = $SiteRootPath
            site_root_id          = $siteRootId
            site_root_template    = $siteRootTemplateName
            site_root_template_id = $siteRootTemplateId
            is_headless_site      = $isSxaSite
            is_headless_tenant    = $isSxaTenant
            has_tenant_above      = $hasTenantAbove
            parent_path           = $tenantParentPath
            parent_template_id    = $tenantParentTemplId
            sxa_scaffolding       = @{
                presentation_folder  = $hasPresentationFolder
                page_designs         = $hasPageDesigns
                partial_designs      = $hasPartialDesigns
                available_renderings = $hasAvailableRenderings
            }
            conversion_needed     = (-not $isSxaSite -or -not $hasPresentationFolder)
        }
        module_status = @{
            total        = $moduleStatusList.Count
            registered   = $modRegistered
            partial      = $modPartial
            unregistered = $modUnregistered
            modules      = @($moduleStatusList)
        }
        partial_design_candidates = @{
            total      = $partialDesignCandidates.Count
            candidates = @($partialDesignCandidates)
            note       = "Placeholders matching shared slot names or with renderings on >= 80% of pages"
        }
    }

    Write-Output-Line "✓ STEP 8.5 complete" "Green"
    Write-Output-Line "" "White"

        if (-not $GenerateReports) {
        Write-Output-Line "" "White"
        Write-Output-Line "✓ Discovery completed in statistics-only mode (no files written)" "Green"
        Write-Output-Line "" "White"

            # Return structured object with all output including discovered paths
    [PSCustomObject]@{
        Success      = $true
        InventoryScanComplete = $script:renderingInventoryComplete
        UsageScanComplete = $script:renderingUsageComplete
        UnresolvedRenderingReferences = @($script:unresolvedRenderingReferences)
        SuspiciousRenderingRoots = @($script:suspiciousRenderingRoots)
        Output       = $script:output -join "`n"
        SiteRootPath = $SiteRootPath
        Database     = $Database
        Language     = $Language
        Statistics   = @{
            TotalItems          = $stats.total_items
            PageItems           = $stats.page_items
            DatasourceItems     = $stats.datasource_items
            RenderingsUsed      = $renderingDetails.Count
            AllRenderings       = $allRenderings.Count
            Templates           = $stats.templates_in_use
            PlaceholderSettings = $placeholderSettings.Count
            BranchTemplates     = $branchTemplates.Count
        }
        RootPaths     = @{
            rendering_roots                   = @($renderingRootPaths.Keys)
            branch_template_roots             = @($branchTemplateRootPaths.Keys)
            template_roots                    = @($templateRootPaths.Keys)
            rendering_contents_resolver_roots = @($renderingContentsResolverRootPaths.Keys)
        }
        DuplicateItems       = $duplicateItems
        InstanceCapabilities = $script:instanceCapabilities
        XpOnlyTemplateAudit  = $script:xpOnlyTemplateAudit
        SxaReadiness         = $script:sxaReadiness
    } | ConvertTo-Json -Depth 10
    }

    Write-Output-Line "WRITING OUTPUT FILES" "Cyan"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"

    # Get App_Data path dynamically from Sitecore configuration
    $appDataPath = [Sitecore.Configuration.Settings]::DataFolder
    
    if (-not (Test-Path $appDataPath)) {
        # DataFolder may be relative — resolve against website root
        $webRoot = [System.Web.HttpRuntime]::AppDomainAppPath
        $appDataPath = Join-Path $webRoot "App_Data"
        Write-Output-Line "DataFolder was relative, resolved to: $appDataPath" "Yellow"
    }

    if (-not (Test-Path $appDataPath)) {
        Write-Output-Line "ERROR: App_Data folder not found at: $appDataPath" "Red"
        throw "App_Data folder not found"
    }

    # Create auditreports folder if it doesn't exist
    $auditReportsFolder = Join-Path $appDataPath "auditreports"
    if (-not (Test-Path $auditReportsFolder)) {
        New-Item -Path $auditReportsFolder -ItemType Directory -Force | Out-Null
    }

    # Create timestamped output directory
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $outputDir = Join-Path $auditReportsFolder $timestamp
    
    Write-Output-Line "Creating output directory: $outputDir" "Yellow"
    
    $outputPath = New-Item -Path $outputDir -ItemType Directory -Force
    $script:instanceEvidenceWriter.Close()
    Copy-Item -LiteralPath $script:instanceEvidenceTemp -Destination (Join-Path $outputDir 'rendering-instances.jsonl')
    Get-RenderingVariantEvidence | ConvertTo-Json -Depth 15 | Out-File -FilePath (Join-Path $outputDir 'rendering-variants.json') -Encoding UTF8
    Write-Output-Line "✓ Directory created: $($outputPath.FullName)" "Green"
    Write-Output-Line "" "White"

    # ==============================================================================
    # SERIALIZATION PATH OPTIMIZATION (V2)
    # ==============================================================================
    # Process datasource root paths to separate site-nested from shared data folders
    # This enables proper Sitecore CLI serialization configuration where:
    # - Site root: Single recursive include covers all pages + nested datasources
    # - Shared data: Separate includes for folders outside site root
    
    Write-Output-Line "" "White"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "SERIALIZATION PATH OPTIMIZATION" "Cyan"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"
    
    $siteRootNormalized = $SiteRootPath.TrimEnd('/')
    $siteNestedCount = 0
    $sharedDataFolders = @()
    
    Write-Output-Line "Analyzing datasource folder locations..." "Yellow"
    Write-Output-Line "  Site Root: $siteRootNormalized" "White"
    Write-Output-Line "" "White"
    
    # Separate datasource folders into site-nested vs shared
    foreach ($dsFolder in $datasourceRootPaths.Keys) {
        # Normalize path to forward slashes for comparison
        $dsFolderNormalized = $dsFolder.Replace('\', '/')
        
        if ($dsFolderNormalized.StartsWith($siteRootNormalized, [StringComparison]::OrdinalIgnoreCase)) {
            $siteNestedCount++
        }
        elseif ($siteRootNormalized.StartsWith($dsFolderNormalized, [StringComparison]::OrdinalIgnoreCase)) {
            # Skip: This is an ancestor of site root (too shallow - would pull everything)
            Write-Output-Line "  ⚠ Skipping ancestor path: $dsFolderNormalized (too shallow)" "Yellow"
        }
        else {
            # Add normalized path (forward slashes)
            $sharedDataFolders += $dsFolderNormalized
        }
    }
    
    Write-Output-Line "✓ Datasource Folder Analysis:" "Green"
    Write-Output-Line "  Total Datasource Folders: $($datasourceRootPaths.Count)" "White"
    Write-Output-Line "  Site-Nested (covered by site root): $siteNestedCount" "White"
    Write-Output-Line "  Shared Data (outside site root): $($sharedDataFolders.Count)" "White"
    Write-Output-Line "" "White"
    
    # Build serialization configuration with optimized paths
    $serializationConfig = @{
        site_root          = $siteRootNormalized
        site_root_note     = "Single recursive include covers all pages and datasources nested under site root"
        shared_data_folders = $sharedDataFolders | Sort-Object
        shared_data_note   = "Folders outside site root that contain datasources - include individually"
        includes           = @(
            @{
                path        = $siteRootNormalized
                kind        = "content"
            }
        )
    }
    
    # Add shared data folders as individual includes
    foreach ($sharedFolder in ($sharedDataFolders | Sort-Object)) {
        # Normalize to forward slashes
        $normalizedPath = $sharedFolder.Replace('\', '/')
        
        # Generate namespace from path (e.g., /sitecore/content/Data/Search -> Content.Data.Search)
        $pathParts = $normalizedPath.Split('/') | Where-Object { $_ -and $_ -ne "sitecore" -and $_ -ne "content" }
        $namespace = "Content." + ($pathParts -join ".")
        
        $serializationConfig.includes += @{
            path        = $normalizedPath
            kind        = "content"
        }
    }
    
    # Add template folders
    foreach ($templateFolder in ($templateRootPaths.Keys | Sort-Object)) {        
        $normalizedPath = $templateFolder.Replace('\', '/')
        
        $serializationConfig.includes += @{
            path        = $normalizedPath
            kind        = "template"
        }
    }
    
    # Add rendering folders
    foreach ($renderingFolder in ($renderingRootPaths.Keys | Sort-Object)) {
        $normalizedPath = $renderingFolder.Replace('\', '/')
        
        $serializationConfig.includes += @{
            path        = $normalizedPath
            kind        = "rendering"
        }
    }
    
    # Add layout folders (e.g. /sitecore/layout/Layouts/Project/TG)
    foreach ($layoutFolder in ($layoutRootPaths.Keys | Sort-Object)) {
        $normalizedPath = $layoutFolder.Replace('\', '/')
        
        $serializationConfig.includes += @{
            path        = $normalizedPath
            kind        = "layout"
        }
    }
    
    # Add rendering contents resolver folders
    foreach ($resolverFolder in ($renderingContentsResolverRootPaths.Keys | Sort-Object)) {
        $normalizedPath = $resolverFolder.Replace('\', '/')
        
        $serializationConfig.includes += @{
            path        = $normalizedPath
            kind        = "resolver"
        }
    }
    
    # Add individual branch template items
    foreach ($branchFolder in ($branchTemplateRootPaths.Keys | Sort-Object)) {
        $normalizedPath = $branchFolder.Replace('\', '/')
        
        $serializationConfig.includes += @{
            path        = $normalizedPath
            kind        = "branch"
        }
    }
    
    # Add placeholder settings folders (unique parent folders of discovered items)
    if ($placeholderSettingItems.Count -gt 0) {
        $phParentFolders = @{}
        foreach ($phItem in $placeholderSettingItems.Values) {
            $phItemPath = $phItem.path.Replace('\', '/')
            $parentFolder = $phItemPath.Substring(0, $phItemPath.LastIndexOf('/'))
            if (-not $phParentFolders.ContainsKey($parentFolder)) {
                $phParentFolders[$parentFolder] = $true
            }
        }
        foreach ($phFolder in ($phParentFolders.Keys | Sort-Object)) {
            $serializationConfig.includes += @{
                path        = $phFolder
                kind        = "placeholder"
            }
        }
    }
    
    Write-Output-Line "✓ Generated serialization configuration with $($serializationConfig.includes.Count) includes" "Green"
    Write-Output-Line "" "White"

    # Write each section to separate files
    Write-Output-Line "Writing output files..." "Yellow"

    # 1. Metadata & Statistics (JSON - small, structured)
    $metadataFile = Join-Path $outputDir "metadata-stats.json"
    @{
        audit_metadata = @{
            phase              = "discovery"
            completed_at       = $endTime.ToString("o")
            duration_seconds   = [math]::Round($duration.TotalSeconds, 2)
            site_root_path     = $SiteRootPath
            database           = $Database
            language           = $Language
            output_format      = "hybrid"
            format_description = "JSONL for large collections (items, renderings), JSON for structured data (templates, placeholders)"
        }
        statistics     = @{
            total_items                        = $stats.total_items
            page_items                         = $stats.page_items
            datasource_items                   = $stats.datasource_items
            non_page_non_datasource_items      = $stats.non_page_non_datasource_items
            page_templates                     = $stats.page_templates.Count
            content_item_templates             = $stats.content_item_templates.Count
            rendering_templates                = $stats.rendering_templates.Count
            discovered_templates               = $stats.discovered_templates.Count
            total_renderings                   = $stats.total_renderings
            total_rendering_contents_resolvers = $stats.total_rendering_contents_resolvers
            renderings_with_component_graphql  = $stats.renderings_with_component_graphql
            renderings_with_resolvers          = $stats.renderings_with_resolvers
            total_branch_templates             = $stats.total_branch_templates
            total_placeholders                 = $placeholderSettings.Count
            total_placeholder_settings         = $stats.total_placeholder_settings
            max_depth                          = $stats.max_depth
            templates_list                     = $templatesList
            items_by_depth                     = $itemsByDepthList
        }
        root_paths     = @{
            rendering_roots                   = @($renderingRootPaths.Keys)
            datasource_roots                  = @($datasourceRootPaths.Keys)
            branch_template_roots             = @($branchTemplateRootPaths.Keys)
            template_roots                    = @($templateRootPaths.Keys)
            rendering_contents_resolver_roots = @($renderingContentsResolverRootPaths.Keys)
        }
        output_files   = @{
            metadata                            = "metadata-stats.json"
            serialization_config                = "serialization-config.json"
            items                               = "content-items.jsonl"
            renderings                          = "rendering-usage.jsonl"
            rendering_details                   = "rendering-details.json"
            rendering_page_mapping              = "rendering-page-mapping.json"
            rendering_instances                 = "rendering-instances.jsonl"
            rendering_variants                  = "rendering-variants.json"
            templates                           = "template-definitions.json"
            placeholders                        = "placeholder-usage.json"
            placeholder_settings                = "placeholder-settings.json"
            branch_templates                    = "branch-templates.json"
            rendering_contents_resolvers        = "rendering-resolvers.jsonl"
            rendering_contents_resolver_details = "rendering-resolver-details.json"
            migration_manifest                  = "migration-manifest.json"
            duplicate_items                     = "duplicate-items.json"
            xp_only_template_audit              = "xp-only-template-audit.json"
            sxa_readiness                       = "sxa-readiness.json"
            sxa_conversion_inputs               = "sxa-conversion-inputs.json"
        }
        data_quality   = @{
            duplicate_item_groups = $duplicateItems.Count
            has_duplicates        = ($duplicateItems.Count -gt 0)
            duplicates_with_links = ($duplicateItems | Where-Object { $_.HasLinks }).Count
        }
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $metadataFile -Encoding UTF8
    Write-Output-Line "  ✓ $metadataFile (JSON)" "White"

    # Write duplicate items report
    $duplicateItemsFile = Join-Path $outputDir "duplicate-items.json"
    if ($duplicateItems.Count -gt 0) {
        $duplicateItems | ConvertTo-Json -Depth 5 | Out-File -FilePath $duplicateItemsFile -Encoding UTF8
        Write-Output-Line "  ⚠ $duplicateItemsFile (JSON) - $($duplicateItems.Count) DUPLICATE GROUP(S) REQUIRE ATTENTION" "Yellow"
    } else {
        # ConvertTo-Json emits no bytes for an empty pipeline. The evidence
        # adapter treats this as a required report, so write an explicit JSON
        # empty array instead of a zero-byte file.
        Set-Content -Path $duplicateItemsFile -Value '[]' -Encoding UTF8
        Write-Output-Line "  ✓ $duplicateItemsFile (JSON) - no duplicates" "Green"
    }

    # 2. Serialization Configuration (JSON - optimized paths for Sitecore CLI)
    $serializationConfigFile = Join-Path $outputDir "serialization-config.json"
    $serializationConfig | ConvertTo-Json -Depth 10 | Out-File -FilePath $serializationConfigFile -Encoding UTF8
    Write-Output-Line "  ✓ $serializationConfigFile (JSON) - SERIALIZATION PATHS" "Green"

    # 3. Items (JSONL) — DISABLED: content-items.jsonl not written to reduce memory usage.
    # $allItems only holds minimal {path, template_id} objects now; full field data is not collected.
    # Re-enable by restoring New-ItemObject calls and uncommenting this block.
    # $itemsFile = Join-Path $outputDir "content-items.jsonl"
    # $itemsWriter = New-Object System.IO.StreamWriter($itemsFile, $false, [System.Text.Encoding]::UTF8)
    # $itemsWritten = 0
    # foreach ($item in $allItems) {
    #     $json = $item | ConvertTo-Json -Depth 10 -Compress
    #     $itemsWriter.WriteLine($json)
    #     $itemsWritten++
    #     if ($itemsWritten % 100 -eq 0) {
    #         Write-Output-Line "    Writing items: $itemsWritten / $($allItems.Count)" "Cyan"
    #     }
    # }
    # $itemsWriter.Close()
    # Write-Output-Line "  ✓ $itemsFile (JSONL - $($allItems.Count) items)" "White"
    Write-Output-Line "  ○ content-items.jsonl skipped (disabled to reduce memory usage)" "Gray"

    # 4. Renderings (JSONL - one rendering per line)
    $renderingsFile = Join-Path $outputDir "rendering-usage.jsonl"
    $renderingsWriter = New-Object System.IO.StreamWriter($renderingsFile, $false, [System.Text.Encoding]::UTF8)
    foreach ($rendering in $allRenderings) {
        $json = $rendering | ConvertTo-Json -Depth 10 -Compress
        $renderingsWriter.WriteLine($json)
    }
    $renderingsWriter.Close()
    Write-Output-Line "  ✓ $renderingsFile (JSONL - $($allRenderings.Count) renderings)" "White"

    # 5. Rendering Details (JSON - structured configuration data)
    $renderingDetailsFile = Join-Path $outputDir "rendering-details.json"
    @{ 
        inventory_scope   = if ($configuredRenderingRoots.Count -gt 0) { 'configured-roots-and-dependencies' } else { 'page-and-sxa-dependencies' }
        inventory_scan_complete = $script:renderingInventoryComplete
        unresolved_rendering_references = @($script:unresolvedRenderingReferences)
        suspicious_rendering_roots = @($script:suspiciousRenderingRoots)
        configured_roots  = @($configuredRenderingRoots)
        effective_roots   = @($renderingRootPaths.Keys | Sort-Object)
        usage_scan_complete = $script:renderingUsageComplete
        excluded_content_paths = @()
        site_root         = $SiteRootPath
        language          = $Language
        rendering_details = $renderingsDetailedArray
        total             = $renderingsDetailedArray.Count
        description       = "Detailed rendering configurations including parameters, datasource templates, and locations"
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $renderingDetailsFile -Encoding UTF8
    Write-Output-Line "  ✓ $renderingDetailsFile (JSON)" "White"

    # 5b. Rendering Coverage Plan (JSON - minimal pages for full component coverage)
    $renderingPageMappingFile = Join-Path $outputDir "rendering-page-mapping.json"
    $totalPages = $pageItems.Count
    $globalThreshold = [math]::Ceiling($totalPages * 0.8)

    # Build per-rendering frequency (compact — just counts, no page lists)
    $frequencyArray = @()
    foreach ($rpId in ($renderingPageMapping.Keys | Sort-Object)) {
        $rpPages = @($renderingPageMapping[$rpId])
        $rpName = if ($renderingDetails.ContainsKey($rpId)) { $renderingDetails[$rpId]["name"] } else { $null }
        $rpComponentName = if ($renderingDetails.ContainsKey($rpId)) { $renderingDetails[$rpId]["component_name"] } else { $null }
        $frequencyArray += @{
            rendering_id   = $rpId
            name           = $rpName
            component_name = $rpComponentName
            page_count     = $rpPages.Count
            is_global      = ($rpPages.Count -ge $globalThreshold)
        }
    }

    # Build inverse map: pagePath -> Set of renderingIds on that page
    $pageToRenderings = @{}
    foreach ($rpId in $renderingPageMapping.Keys) {
        foreach ($pPath in $renderingPageMapping[$rpId]) {
            if (-not $pageToRenderings.ContainsKey($pPath)) {
                $pageToRenderings[$pPath] = New-Object System.Collections.Generic.HashSet[string]
            }
            [void]$pageToRenderings[$pPath].Add($rpId)
        }
    }

    # Resolve in an actual content-site context; SPE normally runs under shell.
    $script:discoverySiteContexts = @()
    foreach ($siteName in [Sitecore.Configuration.Factory]::GetSiteNames()) {
        try {
            $context = [Sitecore.Configuration.Factory]::GetSite($siteName)
            if ($context.RootPath -notmatch '^/sitecore/content(?:/|$)') { continue }
            $script:discoverySiteContexts += $context
        } catch { }
    }
    function Get-DiscoverySiteForItem($Item) {
        if ($null -eq $Item) { return $null }
        $path = $Item.Paths.FullPath.TrimEnd('/')
        $matchingSites = @($script:discoverySiteContexts | Where-Object {
            $start = $_.RootPath.TrimEnd('/') + '/' + $_.StartItem.Trim('/')
            $start = $start.TrimEnd('/')
            $path -ieq $start -or $path.StartsWith($start + '/', [System.StringComparison]::OrdinalIgnoreCase)
        } | Sort-Object @{ Expression = { ($_.RootPath.TrimEnd('/') + '/' + $_.StartItem.Trim('/')).Length }; Descending = $true }, Name)
        if ($matchingSites.Count -eq 0) { return $null }
        return $matchingSites[0]
    }
    function Get-RelativeRoute($item) {
        if ($null -eq $item -or $item.Paths.FullPath -match '/Presentation/(Partial Designs|Page Designs)(/|$)') { return $null }
        $switcher = $null
        try {
            $site = Get-DiscoverySiteForItem $item
            if ($null -eq $site) { return $null }
            $switcher = New-Object Sitecore.Sites.SiteContextSwitcher -ArgumentList $site
            $opts = [Sitecore.Links.UrlOptions]::DefaultOptions
            $opts.Site = $site
            $opts.LanguageEmbedding = [Sitecore.Links.LanguageEmbedding]::Never
            $opts.AlwaysIncludeServerUrl = $false
            $opts.SiteResolving = $false
            $url = [Sitecore.Links.LinkManager]::GetItemUrl($item, $opts)
            if ([string]::IsNullOrWhiteSpace($url)) { return $null }
            if ($url -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $url = ([System.Uri]$url).AbsolutePath }
            try { $url = [System.Uri]::UnescapeDataString($url) } catch { }
            if (-not $url.StartsWith('/') -or $url -match '^/sitecore(?:/|$)') { return $null }
            if ($url.Length -gt 1) { $url = $url.TrimEnd('/') }
            return $url.ToLowerInvariant()
        } catch {
            return $null
        } finally {
            if ($null -ne $switcher) { $switcher.Dispose() }
        }
    }

    # Greedy set-cover: pick fewest pages to cover all renderings
    $uncovered = New-Object System.Collections.Generic.HashSet[string]
    foreach ($rpId in $renderingPageMapping.Keys) { [void]$uncovered.Add($rpId) }
    $coveragePlan = @()
    $cumulative = 0

    while ($uncovered.Count -gt 0) {
        $bestPage = $null
        $bestNew = @()
        $bestCount = 0

        foreach ($pPath in $pageToRenderings.Keys) {
            $newIds = @($pageToRenderings[$pPath] | Where-Object { $uncovered.Contains($_) })
            if ($newIds.Count -gt $bestCount) {
                $bestPage = $pPath
                $bestNew = $newIds
                $bestCount = $newIds.Count
            }
        }

        if ($null -eq $bestPage -or $bestCount -eq 0) { break }

        # Resolve names for the new renderings
        $newNames = @()
        foreach ($nId in $bestNew) {
            $nName = if ($renderingDetails.ContainsKey($nId)) { $renderingDetails[$nId]["name"] } else { $nId }
            $newNames += $nName
            [void]$uncovered.Remove($nId)
        }
        $cumulative += $bestCount

        # $bestPage is the page's verbatim content-tree path. Resolve the item and
        # derive the route via LinkManager; emit the item path alongside so the
        # consumer can Get-Item the real (spaced/title-cased) item.
        $itemPath = $bestPage
        $pageItem = $null
        $pageItem = $allItemsLookup[$bestPage]
        $route = Get-RelativeRoute $pageItem

        $coveragePlan += @{
            route               = $route
            itemPath            = $itemPath
            renderings          = @($newNames | Sort-Object)
            cumulativeCoverage  = $cumulative
        }
    }

    $uncoveredNames = @()
    foreach ($uId in $uncovered) {
        $uName = if ($renderingDetails.ContainsKey($uId)) { $renderingDetails[$uId]["name"] } else { $uId }
        $uncoveredNames += $uName
    }

    @{
        description           = "Rendering coverage plan - minimal pages to cover all renderings"
        evidence_schema_version = 2
        usage_scan_complete   = $script:renderingUsageComplete
        excluded_content_paths = @()
        instance_count        = $script:instanceEvidenceCount
        definition_lookup_count = $script:renderingDefinitionItems.Count
        pages                 = @($pageItems | ForEach-Object {
            $path = $_['path']
            $item = $allItemsLookup[$path]
            $route = Get-RelativeRoute $item
            @{
                itemId = $item.ID.ToString(); itemPath = $path; language = $Language; route = $route
                routeIssue = if ($path -match '/Presentation/(Partial Designs|Page Designs)(/|$)') { 'shared-design-requires-page' } elseif ($null -eq $route) { 'route-unresolved' } else { $null }
            }
        })
        site_root             = $SiteRootPath
        total_renderings      = $renderingPageMapping.Count
        total_pages_scanned   = $totalPages
        global_threshold      = $globalThreshold
        coverage_plan         = $coveragePlan
        pages_needed          = $coveragePlan.Count
        renderings_covered    = $cumulative
        renderings_uncovered  = $uncovered.Count
        uncovered_names       = @($uncoveredNames | Sort-Object)
        rendering_frequency   = $frequencyArray
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $renderingPageMappingFile -Encoding UTF8
    Write-Output-Line "  ✓ $renderingPageMappingFile (JSON - $($coveragePlan.Count) pages cover $cumulative/$($renderingPageMapping.Count) renderings)" "White"

    # 6. Templates (JSON - inheritance and field definitions)
    $templatesFile = Join-Path $outputDir "template-definitions.json"
    @{ 
        templates   = $templatesArray
        total       = $templatesArray.Count
        description = "Template definitions with inheritance hierarchy and field structures"
    } | ConvertTo-Json -Depth 15 | Out-File -FilePath $templatesFile -Encoding UTF8
    Write-Output-Line "  ✓ $templatesFile (JSON)" "White"

    # 7. Placeholders (JSON - placeholder hierarchy and usage)
    $placeholdersFile = Join-Path $outputDir "placeholder-usage.json"
    @{ 
        placeholders = $placeholdersArray
        total        = $placeholdersArray.Count
        description  = "Placeholder hierarchy, usage patterns, and rendering assignments"
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $placeholdersFile -Encoding UTF8
    Write-Output-Line "  ✓ $placeholdersFile (JSON)" "White"

    # 8. Placeholder Settings (JSON - component governance rules)
    $placeholderSettingsFile = Join-Path $outputDir "placeholder-settings.json"
    @{ 
        placeholder_settings = $placeholderSettingItemsArray
        total                = $placeholderSettingItemsArray.Count
        description          = "Placeholder Settings items defining allowed renderings and governance rules"
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $placeholderSettingsFile -Encoding UTF8
    Write-Output-Line "  ✓ $placeholderSettingsFile (JSON)" "White"

    # 9. Branch Templates (JSON - content creation templates)
    $branchTemplatesFile = Join-Path $outputDir "branch-templates.json"
    @{ 
        branch_templates = $branchTemplatesArray
        total            = $branchTemplatesArray.Count
        description      = "Branch template definitions for content item creation patterns"
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $branchTemplatesFile -Encoding UTF8
    Write-Output-Line "  ✓ $branchTemplatesFile (JSON)" "White"

    # 10. Rendering Contents Resolvers (JSONL - resolver items)
    $resolversFile = Join-Path $outputDir "rendering-resolvers.jsonl"
    $resolversWriter = New-Object System.IO.StreamWriter($resolversFile, $false, [System.Text.Encoding]::UTF8)
    foreach ($resolver in $allRenderingContentsResolvers) {
        $json = $resolver | ConvertTo-Json -Depth 10 -Compress
        $resolversWriter.WriteLine($json)
    }
    $resolversWriter.Close()
    Write-Output-Line "  ✓ $resolversFile (JSONL - $($allRenderingContentsResolvers.Count) resolvers)" "White"

    # 11. Rendering Contents Resolver Details (JSON - resolver configurations used by renderings)
    $resolverDetailsFile = Join-Path $outputDir "rendering-resolver-details.json"
    @{ 
        resolver_details = $renderingContentsResolversDetailedArray
        total            = $renderingContentsResolversDetailedArray.Count
        description      = "Rendering Contents Resolver configurations used by renderings"
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $resolverDetailsFile -Encoding UTF8
    Write-Output-Line "  ✓ $resolverDetailsFile (JSON)" "White"

    # 12. Migration Manifest (JSON - what needs to be migrated to XM Cloud)
    $migrationManifestFile = Join-Path $outputDir "migration-manifest.json"

    # Convert folder path hashtables to arrays
    $renderingFoldersArray = New-Object System.Collections.ArrayList
    foreach ($path in $renderingRootPaths.Keys) {
        [void]$renderingFoldersArray.Add($path)
    }

    $datasourceFoldersArray = New-Object System.Collections.ArrayList
    foreach ($path in $datasourceRootPaths.Keys) {
        [void]$datasourceFoldersArray.Add($path)
    }

    $branchTemplateFoldersArray = New-Object System.Collections.ArrayList
    foreach ($path in $branchTemplateRootPaths.Keys) {
        [void]$branchTemplateFoldersArray.Add($path)
    }

    $templateFoldersArray = New-Object System.Collections.ArrayList
    foreach ($path in $templateRootPaths.Keys) {
        [void]$templateFoldersArray.Add($path)
    }

    $resolverFoldersArray = New-Object System.Collections.ArrayList
    foreach ($path in $renderingContentsResolverRootPaths.Keys) {
        [void]$resolverFoldersArray.Add($path)
    }

    @{
        migration_manifest      = @{
            description  = "Folder-based migration manifest: traverse these folders recursively to migrate all needed items"
            site_root    = $SiteRootPath
            generated_at = $endTime.ToString("o")
            approach     = "folder_traversal"
            note         = "Use BFS/recursive traversal on these folder paths to discover and migrate all items"
        }
        migration_order         = @{
            description = "Recommended order for migrating items to avoid dependency issues"
            order       = @(
                "1. Templates (discovered by template IDs from items)"
                "2. Placeholder Settings items (discovered from placeholder keys)"
                "3. Rendering folders (recursive traversal of rendering_folders)"
                "4. Content pages (recursive traversal of site_root)"
                "5. Datasource folders (recursive traversal of datasource_folders)"
                "6. Media library items (TBD)"
            )
        }
        folders_to_traverse     = @{
            site_root                           = @{
                description = "Site root path - traverse recursively to get all pages and content"
                path        = $SiteRootPath
                note        = "Contains $($pageItems.Count) pages discovered"
            }
            rendering_folders                   = @{
                description = "Unique folders containing renderings used by pages - traverse recursively"
                paths       = $renderingFoldersArray
                count       = $renderingFoldersArray.Count
                note        = "Discovered $($allRenderings.Count) total renderings from these folders ($($renderingDetails.Count) used on pages, $($allRenderings.Count - $renderingDetails.Count) unused)"
            }
            datasource_folders                  = @{
                description = "Unique folders containing datasource items - traverse recursively"
                paths       = $datasourceFoldersArray
                count       = $datasourceFoldersArray.Count
                note        = "Discovered $($datasourceItems.Count) datasource items from these folders"
            }
            branch_template_folders             = @{
                description = "Unique folders containing branch templates - traverse recursively"
                paths       = $branchTemplateFoldersArray
                count       = $branchTemplateFoldersArray.Count
            }
            template_folders                    = @{
                description = "Unique folders containing templates - traverse recursively"
                paths       = $templateFoldersArray
                count       = $templateFoldersArray.Count
                note        = "Templates discovered from datasource and rendering parameter usage"
            }
            rendering_contents_resolver_folders = @{
                description = "Unique folders containing rendering contents resolvers - traverse recursively"
                paths       = $resolverFoldersArray
                count       = $resolverFoldersArray.Count
                note        = "Discovered $($allRenderingContentsResolvers.Count) total resolvers from these folders ($($renderingContentsResolvers.Count) used by renderings, $($allRenderingContentsResolvers.Count - $renderingContentsResolvers.Count) unused)"
            }
        }
        discovered_templates    = @{
            description                     = "Template IDs discovered from usage - fetch these specific templates and their base templates"
            page_templates                  = @{
                count        = $stats.page_templates.Count
                template_ids = @($stats.page_templates.Keys)
                note         = "Templates used by the $($stats.page_items) items with layouts/presentation - these need presentation components in XM Cloud"
            }
            content_item_templates          = @{
                count = $stats.content_item_templates.Count
                note  = "All unique templates used by the $($stats.total_items) content items crawled (includes page templates, datasource templates, folder templates, etc.)"
            }
            datasource_templates            = @{
                count        = $datasourceTemplates.Count
                template_ids = @($datasourceTemplates.Keys)
                note         = "Templates explicitly configured in rendering 'Datasource Template' fields"
            }
            rendering_parameter_templates   = @{
                count        = $renderingParameterTemplates.Count
                template_ids = @($renderingParameterTemplates.Keys)
                note         = "Templates used for rendering parameters"
            }
            templates_from_folder_traversal = @{
                count = $stats.discovered_templates.Count
                note  = "Additional templates discovered by recursively traversing template folders"
            }
        }
        discovered_placeholders = @{
            description                = "Placeholder keys discovered from pages - search for matching Placeholder Settings items"
            placeholder_keys           = @($placeholderSettings.Keys)
            count                      = $placeholderSettings.Count
            placeholder_settings_found = $placeholderSettingItems.Count
        }
        migration_flags         = @{
            description                                  = "Items requiring special attention during migration to XM Cloud"
            renderings_with_component_graphql            = @{
                count = $stats.renderings_with_component_graphql
                note  = "Renderings using Component GraphQL queries - verify XM Cloud GraphQL compatibility"
            }
            renderings_with_rendering_contents_resolvers = @{
                count                = $stats.renderings_with_resolvers
                resolvers_discovered = $allRenderingContentsResolvers.Count
                note                 = "Renderings using Rendering Contents Resolvers - may need refactoring for XM Cloud"
            }
        }
        xp_only_template_audit  = $script:xpOnlyTemplateAudit
        instance_capabilities   = $script:instanceCapabilities
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $migrationManifestFile -Encoding UTF8
    Write-Output-Line "  ✓ $migrationManifestFile (JSON) - MIGRATION MANIFEST" "Green"

    # Always write XP-only template audit file so downstream agents can download it as a Kajoo artifact
    $xpAuditFile = Join-Path $outputDir "xp-only-template-audit.json"
    $script:xpOnlyTemplateAudit | ConvertTo-Json -Depth 10 | Out-File -FilePath $xpAuditFile -Encoding UTF8
    if ($script:xpOnlyTemplateAudit["issueCount"] -gt 0) {
        Write-Output-Line "  ⚠ $xpAuditFile (JSON) - $($script:xpOnlyTemplateAudit['issueCount']) XP-ONLY TEMPLATE ISSUE(S) REQUIRE REMEDIATION BEFORE PUSH" "Yellow"
    } else {
        Write-Output-Line "  ✓ $xpAuditFile (JSON) - no XP-only template issues" "Green"
    }

    # 14. SXA Readiness (JSON — site structure, module status, partial design candidates)
    $sxaReadinessFile = Join-Path $outputDir "sxa-readiness.json"
    $script:sxaReadiness | ConvertTo-Json -Depth 10 | Out-File -FilePath $sxaReadinessFile -Encoding UTF8
    $conversionNeeded = $script:sxaReadiness["site_structure"]["conversion_needed"] -eq $true
    $unregCount = $script:sxaReadiness["module_status"]["unregistered"]
    if ($conversionNeeded -or $unregCount -gt 0) {
        Write-Output-Line "  ⚠ $sxaReadinessFile (JSON) - conversion needed, $unregCount unregistered module(s)" "Yellow"
    } else {
        Write-Output-Line "  ✓ $sxaReadinessFile (JSON) - site is SXA-ready" "Green"
    }

    # 15. SXA Conversion Inputs (JSON — lightweight extraction for SXA conversion agents)
    $sxaConversionInputsFile = Join-Path $outputDir "sxa-conversion-inputs.json"

    # Build page templates array by joining $stats.page_templates (ID→name) with $templatesArray (has .path)
    $pageTemplatesLookup = @{}
    foreach ($tpl in $templatesArray) {
        $pageTemplatesLookup[$tpl["id"]] = $tpl
    }
    $pageTemplateEntries = @(foreach ($ptId in $stats.page_templates.Keys) {
        $formatted = "{$($ptId.Substring(0,8))-$($ptId.Substring(8,4))-$($ptId.Substring(12,4))-$($ptId.Substring(16,4))-$($ptId.Substring(20))}"
        $match = $pageTemplatesLookup[$ptId]
        @{
            id   = $formatted
            name = $stats.page_templates[$ptId]
            path = if ($match) { $match["path"] } else { $null }
        }
    })

    # Build rendering modules array from $moduleStatusList (unregistered only — these need registration)
    $validSxaLayers = @("Feature", "Foundation", "Project")
    $renderingModuleEntries = @(foreach ($m in $moduleStatusList) {
        if ($m["status"] -ne "registered") {
            $rawLayer = $m["layer"]
            @{
                name           = $m["module_name"]
                layer          = if ($validSxaLayers -contains $rawLayer) { $rawLayer } else { $null }
                path           = $m["rendering_folder"]
                renderingCount = $m["rendering_count"]
                status         = $m["status"]
            }
        }
    })

    # Build placeholder settings from PS items that matched site placeholders (filtered in post-STEP 6.5)
    $placeholderEntries = @(foreach ($ph in $placeholderSettingItemsArray) {
        $phKey = $ph["placeholder_key"]
        $isDyn = $false
        if ($dynamicPlaceholderBases.ContainsKey($phKey)) {
            $isDyn = $dynamicPlaceholderBases[$phKey]["isDynamic"]
        }
        @{
            key               = $phKey
            id                = "{$($ph['id'].Substring(0,8))-$($ph['id'].Substring(8,4))-$($ph['id'].Substring(12,4))-$($ph['id'].Substring(16,4))-$($ph['id'].Substring(20))}"
            path              = $ph["path"]
            isDynamic         = $isDyn
            allowedRenderings = @($ph["allowed_renderings"] | ForEach-Object {
                @{ id = $_["id"]; name = $_["name"]; path = $_["path"] }
            })
        }
    })

    # Build dynamicPlaceholders array from $dynamicPlaceholderBases
    $dynamicPlaceholderEntries = @(foreach ($baseName in $dynamicPlaceholderBases.Keys) {
        $entry = $dynamicPlaceholderBases[$baseName]
        $psMatch = $psItemsByKey[$baseName]
        $parentRenderingsList = @(foreach ($prId in $entry["parentRenderings"].Keys) {
            $pr = $entry["parentRenderings"][$prId]
            @{
                renderingId   = $pr["renderingId"]
                renderingName = $pr["renderingName"]
                renderingPath = $pr["renderingPath"]
                placeholders  = $pr["placeholders"]
            }
        })
        $segPatterns = @($entry["segmentPatterns"].Keys)
        @{
            baseName               = $baseName
            isDynamic              = $entry["isDynamic"]
            hasPlaceholderSettings = $null -ne $psMatch
            placeholderSettingsId  = if ($null -ne $psMatch) { "{$($psMatch['id'].Substring(0,8))-$($psMatch['id'].Substring(8,4))-$($psMatch['id'].Substring(12,4))-$($psMatch['id'].Substring(16,4))-$($psMatch['id'].Substring(20))}" } else { $null }
            placeholderSettingsPath = if ($null -ne $psMatch) { $psMatch["path"] } else { $null }
            parentFolderPath       = if ($null -ne $psMatch) { $psMatch["parent_folder_path"] } else { $null }
            parentRenderings       = $parentRenderingsList
            usedInTemplates        = @($entry["usedInTemplates"].Keys)
            segmentPattern         = if ($segPatterns.Count -gt 0) { $segPatterns[0] } else { $null }
        }
    })

    @{
        description      = "Lightweight extraction of discovery data for SXA conversion agents"
        generatedAt      = (Get-Date -Format "o")
        sourceArtifacts  = @(
            "migration-manifest.json",
            "sxa-readiness.json",
            "placeholder-settings.json",
            "template-definitions.json"
        )
        pageTemplates    = @{
            description = "Page templates discovered in content tree. Used by Site Adoption agent for ChangeTemplate mapping."
            count       = $pageTemplateEntries.Count
            templates   = $pageTemplateEntries
        }
        renderingModules = @{
            description = "Rendering folders not yet registered as SXA modules. Used by Rendering Registration agent."
            count       = $renderingModuleEntries.Count
            modules     = $renderingModuleEntries
        }
        placeholderSettings = @{
            description  = "Placeholder Settings items referenced by site pages. Filtered from global PS tree to only include items whose key matches a placeholder base name found in the site's layout XML. Includes isDynamic flag and rendering IDs in allowedRenderings. Used by Partial Design Setup agent."
            count        = $placeholderEntries.Count
            placeholders = $placeholderEntries
        }
        dynamicPlaceholders = @{
            description = "Placeholder base names discovered from layout XML. isDynamic=true means XP-style UID suffix found. parentRenderings lists renderings whose Placeholders field references this PS item. Used by Dynamic PH Infrastructure agent (W38)."
            count       = $dynamicPlaceholderEntries.Count
            placeholders = $dynamicPlaceholderEntries
        }
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $sxaConversionInputsFile -Encoding UTF8
    Write-Output-Line "  ✓ $sxaConversionInputsFile (JSON) - SXA CONVERSION INPUTS ($($pageTemplateEntries.Count) page templates, $($renderingModuleEntries.Count) rendering modules, $($placeholderEntries.Count) placeholders, $($dynamicPlaceholderEntries.Count) dynamic PH bases)" "Green"

    Write-Output-Line "" "White"
    Write-Output-Line ("=" * 80) "Cyan"
    Write-Output-Line "" "White"
    Write-Output-Line "✓ Dependency-driven discovery completed successfully!" "Green"
    Write-Output-Line "" "White"
    Write-Output-Line "Output Location:" "Yellow"
    Write-Output-Line "  $($outputPath.FullName)" "White"
    Write-Output-Line "" "White"
    Write-Output-Line "Key Files for Migration Planning:" "Yellow"
    Write-Output-Line "  - serialization-config.json: Optimized paths for Sitecore CLI serialization (V2)" "Cyan"
    Write-Output-Line "  - migration-manifest.json: Complete list of items to migrate" "White"
    Write-Output-Line "  - template-definitions.json: Template definitions with inheritance" "White"
    Write-Output-Line "  - rendering-details.json: Rendering configurations
  - rendering-page-mapping.json: Which pages use each rendering (for coverage planning)" "White"
    Write-Output-Line "  - placeholder-settings.json: Placeholder governance rules" "White"
    Write-Output-Line "  - sxa-conversion-inputs.json: Lightweight inputs for SXA conversion agents (page templates, rendering modules, placeholders, dynamic placeholders)" "Green"
    Write-Output-Line "" "White"
    Write-Output-Line "Next Steps:" "Yellow"
    Write-Output-Line "  1. Use serialization-config.json via analysis tool to configure Sitecore CLI" "Cyan"
    Write-Output-Line "  2. Review migration-manifest.json for complete dependency list" "White"
    Write-Output-Line "  3. Follow recommended migration order (templates → placeholders → renderings → content)" "White"
    Write-Output-Line "  4. Validate all template base templates are included" "White"
    Write-Output-Line ""
   
    # Return structured object with all output
    # Note: $script:output is intentionally omitted — all data is in the written files.
    # Joining thousands of log lines into a single string and serializing through SPE
    # adds significant time to session finalization with no benefit.
    $exportFiles = @(Get-ChildItem -Path $outputPath.FullName -File | ForEach-Object {
        [PSCustomObject]@{
            Name         = $_.Name
            RootPath     = 'Data'
            RelativePath = "auditreports/$timestamp/$($_.Name)"
            Size         = $_.Length
        }
    })

    # The exported envelope is validated strictly by run-powershell-script.
    # Keep all collector metadata inside summary; only kind, version, summary,
    # and files are legal top-level export properties.
    [PSCustomObject]@{
        kind    = 'kajoo-export'
        version = 1
        summary = @{
            discoveryEvidenceVersion = 2
            inventoryScanComplete = $script:renderingInventoryComplete
            usageScanComplete = $script:renderingUsageComplete
            unresolvedRenderingReferences = @($script:unresolvedRenderingReferences)
            success    = $true
            scope      = @{
                siteRootPath = $SiteRootPath
                database     = $Database
                language     = $Language
            }
            statistics = @{
                TotalItems          = $stats.total_items
                PageItems           = $stats.page_items
                DatasourceItems     = $stats.datasource_items
                RenderingsUsed      = $renderingDetails.Count
                AllRenderings       = $allRenderings.Count
                Templates           = $stats.templates_in_use
                PlaceholderSettings = $placeholderSettings.Count
                BranchTemplates     = $branchTemplates.Count
            }
            rootPaths = @{
                rendering_roots                   = @($renderingRootPaths.Keys)
                branch_template_roots             = @($branchTemplateRootPaths.Keys)
                template_roots                    = @($templateRootPaths.Keys)
                rendering_contents_resolver_roots = @($renderingContentsResolverRootPaths.Keys)
            }
            instanceCapabilities = $script:instanceCapabilities
            xpOnlyTemplateAudit  = $script:xpOnlyTemplateAudit
            sxaReadiness         = $script:sxaReadiness
            duplicateItemGroups  = $duplicateItems.Count
            totalItems           = $stats.total_items
            pageItems            = $stats.page_items
            renderings           = $allRenderings.Count
            files                = $exportFiles.Count
            outputPath           = $outputPath.FullName
        }
        # Per-file inventory of every artifact actually written under $outputPath.
        # Consumed by the sitecore-analysis-run inngest orchestration's
        # `analysis/stage-files` step to fetch each file via downloadRemoteFile
        # and write it into the sandbox's agent-data tree (Commit 4 of
        # KAJOO-4935 W3.2.a). Enumerating from disk avoids drift between this
        # list and the `output_files` map in metadata-stats.json.
        #
        # `RootPath` is the Sitecore data-root identifier accepted by
        # `PowershellClient.downloadRemoteFile` ('Data' for App_Data); the
        # absolute `auditreports/<timestamp>/...` segment is in `RelativePath`.
        files                = @($exportFiles | ForEach-Object {
            [PSCustomObject]@{
                rootPath = $_.RootPath
                path     = $_.RelativePath
                name     = $_.Name
                size     = $_.Size
            }
        })
    } | ConvertTo-Json -Depth 10

}
catch {
    # Catch any errors and return output collected so far
    Write-Output-Line "" "White"
    Write-Output-Line ("=" * 80) "Red"
    Write-Output-Line "ERROR: Script execution failed" "Red"
    Write-Output-Line ("=" * 80) "Red"
    Write-Output-Line "Error Message: $($_.Exception.Message)" "Red"
    Write-Output-Line "Error Location: $($_.InvocationInfo.ScriptLineNumber):$($_.InvocationInfo.OffsetInLine)" "Red"
    Write-Output-Line "" "White"
    
    [PSCustomObject]@{
        Success      = $false
        Output       = "ERROR: $($_.Exception.Message)"
        SiteRootPath = $SiteRootPath
        Database     = $Database
        Language     = $Language
        Error        = $_.Exception.Message
        ErrorLine    = $_.InvocationInfo.ScriptLineNumber
        ErrorColumn  = $_.InvocationInfo.OffsetInLine
        StackTrace   = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5
}

finally {
    if ($script:instanceEvidenceWriter) { $script:instanceEvidenceWriter.Dispose() }
    if ($script:instanceEvidenceTemp -and [System.IO.File]::Exists($script:instanceEvidenceTemp)) { [System.IO.File]::Delete($script:instanceEvidenceTemp) }
}
