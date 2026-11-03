<#
.INJECTED_VARIABLES
  $siteItemPath      [string] - Sitecore path to the site (optional if siteItemId provided)
  $siteItemId        [string] - GUID of site item (optional if siteItemPath provided)
  $language          [string] - Language code (default: "en")
  $hostName          [string] - Hostname pattern (default: "*")
  $installModules    [string] - "true" | "false" — whether to run Phase 4 module installation
  $siteTemplateId    [string] - GUID of the Solution Template (JSS Site branch) for module list
  $templatesLocation [string] - Relative path under /sitecore/templates/ (e.g., "Project/MySite/Pages") for Settings→Templates field
#>

<#
.SYNOPSIS
    Converts an existing XP JSS site to Headless SXA by replicating what New-JSSSite does.

.DESCRIPTION
    This script converts an existing Sitecore XP JSS site into a fully-functional
    Headless SXA site compatible with XM Cloud. It replicates the scaffolding that
    New-JSSSite performs when creating a new site from scratch.

    The conversion process has 7 phases:
      Phase 0: Resolve site + tenant, build $tplMap (foundation → project template lookup)
      Phase 1: ChangeTemplate site item to project-level Headless Site template
      Phase 2: Create skeleton sub-items (Data, Dictionary, Media, Presentation, Settings)
      Phase 3: Wire Settings fields (LayoutPath, EditingTheme, paths, etc.)
      Phase 4: Install modules via Add-SiteModule (optional, controlled by $installModules)
      Phase 5: Wire SiteDefinition fields + create media library
      Phase 6: Upgrade migrated layout items to SXA JSS Layout template

    LOGIC SOURCE:
      - New-JSSSite execution trace: docs/xmc-sxa-conversion-strategy.md lines 950-1100
      - Skeleton structure: docs/conversion/scaffolding-reference.md ("The 6 Skeleton Children")
      - Branch template as source of truth for templates AND field values

    PREREQUISITES:
      - Site MUST be under a Headless Tenant (use xmc-adopt-site-into-tenant first)
      - Tenant must have its Templates field populated (created by xmc-ensure-collection)
      - All SXA SPE functions require tree-walk to tenant via Get-TenantItem

    CRITICAL FINDINGS ADDRESSED:
      F3 (__Sortorder): Branch template items have __Sortorder set (Settings=2000, Data=1400,
          Presentation=1600, Dictionary=1500). These are on BRANCH ITEMS, not template
          definitions. This script copies field values from branch items after creation.

      F13 (Get-Item vs $db.GetItem): SPE's Get-Item applies a property adapter enabling
          dot-notation field access ($item.Modules). Raw $db.GetItem() does NOT have this
          adapter — dot-notation returns $null. All items passed to SXA functions MUST
          be obtained via Get-Item. $db.GetItem() is only safe for direct .Fields[]/
          .Editing/.ChangeTemplate() calls.

.NOTES
    Version: 2.0.0
    Author:  Kajoo Migration Team
    Sources: scaffolding-reference.md, xmc-sxa-conversion-strategy.md, test-results.md
#>

# ═══════════════════════════════════════════════════════════════════════════
# CONSTANTS — Hardcoded Sitecore IDs with documentation
# ═══════════════════════════════════════════════════════════════════════════

# Branch template: The canonical source for skeleton item structure and field values
# Path: /sitecore/templates/Branches/Foundation/JSS Experience Accelerator/Scaffolding/JSS Site
# Purpose: Defines the complete site structure instantiated by New-JSSSite (Home, Data,
#          Dictionary, Media, Presentation, Settings with all sub-items)
$ID_JSS_SITE_BRANCH = "{45CF9F42-B3AC-4412-AAB9-F8441C7E448E}"

# Foundation template: Base template for Headless Site items (project templates inherit from this)
# Path: /sitecore/templates/Foundation/JSS Experience Accelerator/Multisite/Headless Site
# Purpose: Phase 1 uses $tplMap to find project-level copy inheriting from this foundation template
$ID_FOUNDATION_HEADLESS_SITE = "{9ED66404-64C9-4122-90E1-869CB3CEA566}"

# Foundation template: Base Page template for page items
# Path: /sitecore/templates/Foundation/JSS Experience Accelerator/Multisite/Base Page
# Purpose: Home template inheritance check — customer's Home may not inherit this (see test-results.md)
$ID_FOUNDATION_BASE_PAGE = "{47151711-26CA-434E-8132-D3E0B7D26683}"

# Editing Theme: Headless Experience theme used for Pages editor
# Path: /sitecore/content/Starter/Starter/Presentation/Headless Experience/Headless Experience
# Purpose: Settings→EditingTheme field value (required for Pages editor compatibility)
$ID_EDITING_THEME = "{3BCAB9EF-1E4F-4C23-B452-783BB82AA686}"

# Layout: Main layout for headless rendering
# Path: /sitecore/layout/Layouts/Foundation/JSS Experience Accelerator/Presentation/Layout
# Purpose: Settings→LayoutPath field value
$ID_MAIN_LAYOUT = "{96E5F4BA-A2CF-4A4C-A4E7-64DA88226362}"

# Workflow: Default workflow for XM Cloud content
# Path: /sitecore/system/Workflows/XM Cloud Sample Workflow
# Purpose: Settings→DefaultWorkflow field value
$ID_DEFAULT_WORKFLOW = "{6C59AE29-D0A1-4B77-9305-0ABAB21D5FE5}"

# SXA JSS Layout template: The correct template for layout items in XM Cloud Headless SXA
# Path: /sitecore/templates/Foundation/JSS Experience Accelerator/Presentation/SXA JSS Layout
# Purpose: Phase 6 — ChangeTemplate migrated layout items from JSS Layout/Layout to SXA JSS Layout
# Note: XP migrations push layout items with JSS Layout or base Layout template.
#       XM Cloud Headless SXA requires SXA JSS Layout. Phase 6 discovers which
#       layouts this site uses (via page template SVs → Get-Layout) and upgrades them.
$ID_SXA_JSS_LAYOUT_TEMPLATE = "{E4E11508-04A4-4B0B-A263-5201F811C9CD}"

# ═══════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    # ─── Debug trace array ─────────────────────────────────────────────────────
    $debug = @()
    $debug += "START: $(Get-Date -Format 'HH:mm:ss') siteItemPath=$siteItemPath siteItemId=$siteItemId"

    # ─── Import SXA functions (REQUIRED for SPE Remoting) ─────────────────────
    $debug += "IMPORTS: loading SXA functions..."
    Import-Function -Name Get-TenantItem
    Import-Function -Name Get-SiteItem
    Import-Function -Name Get-SettingsItem
    Import-Function -Name Get-TenantTemplate
    Import-Function -Name Set-TenantTemplate
    Import-Function -Name Get-ItemByIdSafe
    Import-Function -Name Get-DataItem
    Import-Function -Name Get-ProjectTemplateBasedOnBaseTemplate
    Import-Function -Name Add-SiteModule
    Import-Function -Name Add-SiteMediaLibrary
    Import-Function -Name Get-SiteMediaItem
    Import-Function -Name Test-ItemIsSiteDefinition
    Import-Function -Name Invoke-PostSetupStep
    $debug += "IMPORTS: done"

    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $phases = @()

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 0: Resolve site + tenant
    # ═══════════════════════════════════════════════════════════════════════════
    $site = $null
    if ($siteItemId -and $siteItemId -ne "") {
        # IMPORTANT: Use Get-Item (not $db.GetItem) so $site gets SPE's property adapter.
        # $db.GetItem() returns a raw Sitecore.Data.Items.Item where dot-notation field
        # access ($item.FieldName) returns $null.  SXA functions like Add-SiteModule rely
        # on dot-notation (e.g. $SiteItem.Modules.Split) and will throw
        # "null-valued expression" on raw items.
        $site = Get-Item -Path "master:" -ID $siteItemId
        if (-not $site) { throw "Site item not found for ID: $siteItemId" }
    } elseif ($siteItemPath -and $siteItemPath -ne "") {
        $site = Get-Item -Path "master:$siteItemPath" -ErrorAction SilentlyContinue
        if (-not $site) { throw "Site item not found at path: $siteItemPath" }
    } else {
        throw "Provide either siteItemPath or siteItemId."
    }

    # Derive siteName from the item name — callers no longer pass this
    $siteName = $site.Name
    $debug += "P0: derived siteName='$siteName' from item '$($site.Paths.FullPath)'"

    # Resolve tenant via ancestor tree-walk (HARD REQUIREMENT)
    # The site MUST be physically under a Headless Tenant.  All SXA SPE functions
    # (Add-SiteModule, Add-SiteMediaLibrary, Get-ValidSiteSetupDefinition, etc.)
    # internally call Get-TenantItem via the same tree-walk. If the site is not
    # under a tenant, those calls return $null and crash with cryptic null-ref errors.
    $tenant = Get-TenantItem $site
    if (-not $tenant) {
        throw "PREREQUISITE FAILED: Site '$($site.Paths.FullPath)' is not under a Headless Tenant. Use xmc-adopt-site-into-tenant to move the site under a tenant created by xmc-ensure-collection before running xmc-convert-to-headless-site."
    }

    $debug += "P0: tenant resolved: $($tenant.Name) template=$($tenant.TemplateName) ID=$($tenant.ID)"

    # Resolve tenant templates root from tenant's Templates field
    $tenantTemplatesRootID = $tenant.Fields['Templates'].Value
    if (-not $tenantTemplatesRootID) {
        throw "Tenant '$($tenant.Name)' has no Templates field set. Was it created by xmc-ensure-collection? Tenant ID: $($tenant.ID)"
    }
    $tenantTemplatesRoot = Get-Item -Path "master:" -ID $tenantTemplatesRootID
    if (-not $tenantTemplatesRoot) {
        throw "Tenant templates root not found for ID: $tenantTemplatesRootID"
    }
    $debug += "P0: tenantTemplatesRoot=$($tenantTemplatesRoot.Paths.FullPath) ($tenantTemplatesRootID)"

    $tenantTemplates = Get-TenantTemplate $tenantTemplatesRoot
    $ttCount = if ($tenantTemplates) { @($tenantTemplates).Count } else { 0 }
    if ($ttCount -eq 0) {
        throw "Get-TenantTemplate returned 0 templates from $($tenantTemplatesRoot.Paths.FullPath). Tenant may not be properly scaffolded."
    }
    $debug += "P0: tenantTemplates count=$ttCount"
    foreach ($tt in @($tenantTemplates)) {
        $debug += "P0: tenantTpl=$($tt.Name) ($($tt.ID))"
    }

    # Build project template lookup map: foundation base template ID → project template
    $tplMap = @{}
    foreach ($tt in @($tenantTemplates)) {
        $bases = $tt.Fields['__Base template'].Value
        if ($bases) {
            foreach ($baseId in $bases.Split('|')) {
                $cleanId = $baseId.Trim()
                if ($cleanId -and -not $tplMap.ContainsKey($cleanId)) {
                    $tplMap[$cleanId] = $tt
                }
            }
        }
    }
    $debug += "P0: tplMap has $($tplMap.Count) entries"
    foreach ($k in $tplMap.Keys) {
        $debug += "P0: tplMap[$k] = $($tplMap[$k].Name) ($($tplMap[$k].ID))"
    }

    # Helper: resolve foundation template ID → project-level template (errors if not found)
    function Resolve-ProjectTemplate {
        param([string]$FoundationId, [string]$Label)
        if ($tplMap.ContainsKey($FoundationId)) { return $tplMap[$FoundationId] }
        throw "No project-level template found for foundation $Label ($FoundationId). Check tenant templates at $($tenantTemplatesRoot.Paths.FullPath)."
    }

    $phases += "Phase0:OK tenant=$($tenant.Name) at $($tenant.Paths.FullPath) templates=$ttCount tplMap=$($tplMap.Count)"

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 1: ChangeTemplate → Project-level Headless Site
    # ═══════════════════════════════════════════════════════════════════════════
    $debug += "P1: starting ChangeTemplate check"

    # Resolve project-level Headless Site (no foundation fallback)
    # Uses $ID_FOUNDATION_HEADLESS_SITE constant defined at top of script
    $projectHS = Resolve-ProjectTemplate -FoundationId $ID_FOUNDATION_HEADLESS_SITE -Label "Headless Site"
    $projectHSIdObj = [Sitecore.Data.ID]::Parse($projectHS.ID.ToString())
    $debug += "P1: project HS=$($projectHS.Name) ($($projectHS.ID))"
    $debug += "P1: site template=$($site.TemplateName) ($($site.TemplateID))"

    $currentTemplate = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($site, $db)
    $alreadyProjectHS = $false
    if ($currentTemplate) {
        $alreadyProjectHS = $currentTemplate.InheritsFrom($projectHSIdObj)
        $debug += "P1: InheritsFrom project HS=$alreadyProjectHS"
    } else {
        $debug += "P1: WARN GetTemplate returned null for $($site.TemplateName)"
    }

    if ($alreadyProjectHS) {
        $phases += "Phase1:SKIP template already project Headless Site"
    } else {
        $debug += "P1: calling ChangeTemplate to project $($projectHS.Name)"
        $site.ChangeTemplate($projectHS)
        # Re-fetch after template change — use Get-Item to preserve SPE property adapter
        $site = Get-Item -Path "master:" -ID $site.ID
        $debug += "P1: re-fetched site template=$($site.TemplateName) ($($site.TemplateID))"
        $phases += "Phase1:OK ChangeTemplate to project $($projectHS.Name) ($($projectHS.ID))"
    }

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 2: Create skeleton sub-items
    # ═══════════════════════════════════════════════════════════════════════════
    #
    # Design principles:
    #   1. Branch template is SOURCE OF TRUTH for item structure, templates, and field values
    #   2. Explicit creation (not dynamic iteration) for clarity and debuggability
    #   3. Use $tplMap lookup for automatic template selection (project vs foundation)
    #   4. Copy field values from branch items (fixes F3: __Sortorder not on templates)
    #   5. Skip Home — already exists with customer content
    #
    # Branch structure (from $ID_JSS_SITE_BRANCH):
    #   $name [Headless Site]
    #     ├── Home [Base Page]        ← SKIP: customer content preserved
    #     ├── Data [JSS Data]         ← Create with branch field values
    #     ├── Dictionary [Dictionary Domain]
    #     ├── Media [MediaVirtualFolder]
    #     ├── Presentation [Presentation]
    #     │   ├── Page Designs [Page Designs]     ← Project template
    #     │   └── Partial Designs [Partial Designs] ← Project template
    #     └── Settings [JSS Settings]             ← Project template
    #         └── Site Grouping [Site Grouping Folder]
    #             └── $name [Site Definition]     ← Use $siteName
    # ═══════════════════════════════════════════════════════════════════════════

    # Helper: Idempotent item creation with $tplMap lookup and field copying
    # Parameters:
    #   $Parent    - Parent Sitecore item
    #   $BranchKey - Key in $branchItems lookup (e.g., "Data", "Presentation/Page Designs")
    #   $NameOverride - Optional: use this name instead of branch item name (for $name → $siteName)
    #   $RequireProjectTemplate - If $true, throws error if no project template found in $tplMap
    #                             Required for Settings, Page Designs, Partial Designs (have enriched fields)
    #
    # This function:
    #   1. Looks up template and field values from branch
    #   2. Checks $tplMap for project template override (if foundation ID has project copy)
    #   3. Creates or ensures item idempotently (exists with correct template → skip,
    #      wrong template → ChangeTemplate, missing → create)
    #   4. Copies field values from branch item after creation (fixes F3: __Sortorder)
    function Ensure-SkeletonItem {
        param(
            [Sitecore.Data.Items.Item]$Parent,
            [string]$BranchKey,
            [string]$NameOverride = $null,
            [switch]$RequireProjectTemplate = $false
        )

        # Look up branch item info
        $branchInfo = Get-BranchTemplate $BranchKey
        $foundationTemplateId = $branchInfo.TemplateID

        # Check $tplMap for project template override
        $useTemplateId = $foundationTemplateId
        $useTemplatePath = $branchInfo.TemplatePath
        if ($tplMap.ContainsKey($foundationTemplateId)) {
            $projectTpl = $tplMap[$foundationTemplateId]
            $useTemplateId = $projectTpl.ID.ToString()
            $useTemplatePath = $projectTpl.Paths.FullPath
            $debug += "P2: $BranchKey → project template $($projectTpl.Name) ($useTemplateId)"
        } elseif ($RequireProjectTemplate) {
            # Critical items MUST use project templates (have enriched fields from Layer 2)
            throw "No project-level template found for '$BranchKey' (foundation $foundationTemplateId). Check tenant templates at $($tenantTemplatesRoot.Paths.FullPath)."
        } else {
            $debug += "P2: $BranchKey → foundation template $($branchInfo.TemplateName) ($useTemplateId)"
        }

        # Determine item name
        $itemName = if ($NameOverride) { $NameOverride } else { $BranchKey.Split('/')[-1] }

        $templateIdObj = [Sitecore.Data.ID]::Parse($useTemplateId)

        # Check: exists with correct template (template inheritance match)
        $existing = $Parent.Children | Where-Object {
            if ($_.Name -ne $itemName) { return $false }
            $t = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($_, $_.Database)
            return ($t -and $t.InheritsFrom($templateIdObj))
        } | Select-Object -First 1

        # Fallback: if GetTemplate fails for all children, match by name + TemplateID
        if (-not $existing) {
            $existing = $Parent.Children | Where-Object {
                $_.Name -eq $itemName -and $_.TemplateID.ToString() -eq $useTemplateId
            } | Select-Object -First 1
        }

        $resultItem = $null
        $action = "none"

        if ($existing) {
            $resultItem = $existing
            $action = "exists"
        } else {
            # Check: exists with WRONG template (needs ChangeTemplate)
            $wrongTemplate = $Parent.Children | Where-Object { $_.Name -eq $itemName } | Select-Object -First 1
            if ($wrongTemplate) {
                $targetTemplate = $db.GetItem($templateIdObj)
                if ($targetTemplate) {
                    $wrongTemplate.ChangeTemplate([Sitecore.Data.Items.TemplateItem]$targetTemplate)
                }
                $resultItem = $wrongTemplate
                $action = "ChangeTemplate"
            } else {
                # Create new item
                $resultItem = New-Item -Parent $Parent -Name $itemName -ItemType $useTemplatePath
                $action = "created"
            }
        }

        # Copy field values from branch item ONLY for newly created items (fixes F3: __Sortorder)
        # Don't apply to existing items — preserves user customizations on subsequent runs
        if ($action -eq "created" -and $resultItem -and $branchInfo.FieldValues.Count -gt 0) {
            $fieldsApplied = @()
            $resultItem.Editing.BeginEdit()
            foreach ($fieldName in $branchInfo.FieldValues.Keys) {
                $fieldValue = $branchInfo.FieldValues[$fieldName]
                $resultItem.Fields[$fieldName].Value = $fieldValue
                $fieldsApplied += "$fieldName=$fieldValue"
            }
            $resultItem.Editing.EndEdit() > $null
            if ($fieldsApplied.Count -gt 0) {
                $debug += "P2: $itemName fields applied: $($fieldsApplied -join ', ')"
            }
        }

        $debug += "P2: Ensure-SkeletonItem $BranchKey → $action $($resultItem.Name) ($($resultItem.ID))"

        return $resultItem
    }

    $debug += "P2: creating skeleton items under $($site.Paths.FullPath)"
    $debug += "P2: site children before: $(@($site.Children).Count) items: $(($site.Children | ForEach-Object { $_.Name }) -join ', ')"

    # ─── Read the JSS Site branch template as the source of truth ─────────────
    # Uses $ID_JSS_SITE_BRANCH constant defined at top of script
    $jssSiteBranch = $db.GetItem($ID_JSS_SITE_BRANCH)
    if (-not $jssSiteBranch) { throw "JSS Site branch template $ID_JSS_SITE_BRANCH not found. Is JSS SXA installed?" }
    $branchSiteRoot = $jssSiteBranch.Children | Select-Object -First 1
    if (-not $branchSiteRoot) { throw "JSS Site branch template has no children." }

    # ─── Build comprehensive branch lookup ────────────────────────────────────
    # Captures: TemplateID, TemplatePath, TemplateName, FieldValues, BranchPath
    # Field values include __Sortorder and other values set on branch items, NOT templates (F3)
    $branchItems = @{}

    # System fields to exclude — auto-generated by Sitecore, should not be copied
    $SYSTEM_FIELDS_TO_SKIP = @(
        "__Created",
        "__Created by",
        "__Updated",
        "__Updated by",
        "__Owner",
        "__Revision",
        "__Lock",
        "__Security",
        "__Originator",
        "__Source",
        "__Source Item"
    )

    function Add-BranchItem($item, [string]$prefix) {
        $key = if ($prefix) { "$prefix/$($item.Name)" } else { $item.Name }

        # Capture field values from branch item (excluding system fields)
        $fieldValues = @{}
        foreach ($field in $item.Fields) {
            $fieldName = $field.Name
            # Skip system fields that are auto-generated
            if ($SYSTEM_FIELDS_TO_SKIP -contains $fieldName) { continue }
            # Skip fields with empty values
            $val = $item.Fields[$fieldName].Value
            if ($val -and $val.Trim()) {
                $fieldValues[$fieldName] = $val
            }
        }

        $branchItems[$key] = @{
            TemplateID   = $item.TemplateID.ToString()
            TemplatePath = $item.Template.InnerItem.Paths.FullPath
            TemplateName = $item.TemplateName
            FieldValues  = $fieldValues
            BranchPath   = $item.Paths.FullPath
        }
        foreach ($child in $item.Children) {
            Add-BranchItem $child $key
        }
    }
    foreach ($child in $branchSiteRoot.Children) { Add-BranchItem $child "" }
    $debug += "P2: branch template '$($jssSiteBranch.Name)' has $($branchItems.Count) skeleton items"
    foreach ($bk in $branchItems.Keys | Sort-Object) {
        $bv = $branchItems[$bk]
        $fieldCount = $bv.FieldValues.Count
        $sortOrder = if ($bv.FieldValues["__Sortorder"]) { " sortorder=$($bv.FieldValues['__Sortorder'])" } else { "" }
        $debug += "P2: branch[$bk] = $($bv.TemplateName) ($($bv.TemplateID)) fields=$fieldCount$sortOrder"
    }

    # ─── Helper: Get branch template info for a given key ──────────────────────
    function Get-BranchTemplate([string]$Key) {
        if (-not $branchItems.ContainsKey($Key)) {
            throw "Branch template does not contain expected item '$Key'. Branch has: $($branchItems.Keys -join ', ')"
        }
        return $branchItems[$Key]
    }

    # ═══════════════════════════════════════════════════════════════════════════
    # CREATE SKELETON ITEMS EXPLICITLY
    # The branch structure is stable — explicit creation is clearer than iteration
    # ═══════════════════════════════════════════════════════════════════════════

    # ─── Site root children (skip Home — already exists with customer content) ─
    $dataItem = Ensure-SkeletonItem -Parent $site -BranchKey "Data"
    $dictionaryItem = Ensure-SkeletonItem -Parent $site -BranchKey "Dictionary"
    $mediaItem = Ensure-SkeletonItem -Parent $site -BranchKey "Media"
    $presentationItem = Ensure-SkeletonItem -Parent $site -BranchKey "Presentation"
    # Settings MUST use project template (has enriched fields from Layer 2: _Editing Theme, etc.)
    $settingsItem = Ensure-SkeletonItem -Parent $site -BranchKey "Settings" -RequireProjectTemplate

    # ─── Presentation sub-items ───────────────────────────────────────────────
    # Page Designs and Partial Designs MUST use project templates (have tenant-specific fields)
    $pageDesignsItem = Ensure-SkeletonItem -Parent $presentationItem -BranchKey "Presentation/Page Designs" -RequireProjectTemplate
    $partialDesignsItem = Ensure-SkeletonItem -Parent $presentationItem -BranchKey "Presentation/Partial Designs" -RequireProjectTemplate

    # ─── Settings sub-items ───────────────────────────────────────────────────
    $siteGroupingItem = Ensure-SkeletonItem -Parent $settingsItem -BranchKey "Settings/Site Grouping"

    # SiteDefinition: branch has '$name' placeholder, we use $siteName
    $siteDefBranchKey = $branchItems.Keys | Where-Object { $_ -like 'Settings/Site Grouping/*' } | Select-Object -First 1
    if (-not $siteDefBranchKey) { throw "Branch template missing SiteDefinition item under Settings/Site Grouping/" }
    $siteDefItem = Ensure-SkeletonItem -Parent $siteGroupingItem -BranchKey $siteDefBranchKey -NameOverride $siteName

    $debug += "P2: skeleton items created/ensured — Data=$($dataItem.ID) Dict=$($dictionaryItem.ID) Media=$($mediaItem.ID) Pres=$($presentationItem.ID) Settings=$($settingsItem.ID)"
    $debug += "P2: sub-items — PageDesigns=$($pageDesignsItem.ID) PartialDesigns=$($partialDesignsItem.ID) SiteGrouping=$($siteGroupingItem.ID) SiteDef=$($siteDefItem.ID)"

    # ─── Link remaining skeleton items to tenant (project-level) templates ────
    $debug += "P2: calling Set-TenantTemplate with $(@($tenantTemplates).Count) templates"
    Set-TenantTemplate -Root $site -TenantTemplates $tenantTemplates
    $debug += "P2: Set-TenantTemplate done"

    # ─── Check Home template inheritance ──────────────────────────────────────
    # Re-fetch Home after Set-TenantTemplate so we see the current template
    # Uses $ID_FOUNDATION_BASE_PAGE constant — customer's Home may not inherit this (see test-results.md)
    $homeWarning = ""
    $foundationBasePageId = [Sitecore.Data.ID]::Parse($ID_FOUNDATION_BASE_PAGE)
    $homeItem = $site.Children | Where-Object { $_.Name -eq "Home" } | Select-Object -First 1
    if ($homeItem) { $homeItem = $db.GetItem($homeItem.ID) }

    if ($homeItem) {
        $homeTemplate = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($homeItem.TemplateID, $db)
        $debug += "P2: Home template=$($homeItem.TemplateName) ($($homeItem.TemplateID))"
        if ($homeTemplate) {
            if (-not $homeTemplate.InheritsFrom($foundationBasePageId)) {
                $homeWarning = "Home template '$($homeItem.TemplateName)' ($($homeItem.TemplateID)) does not inherit Foundation Base Page $ID_FOUNDATION_BASE_PAGE. Module insert-option actions targeting Base Page may not apply to Home."
            }
        } else {
            $homeWarning = "TemplateManager.GetTemplate returned null for Home template $($homeItem.TemplateID). Home template '$($homeItem.TemplateName)' likely does not inherit Foundation Base Page $ID_FOUNDATION_BASE_PAGE."
        }
    } else {
        $homeWarning = "No Home child item found under site root."
    }

    $phases += "Phase2:OK skeleton=9items homeWarning=$homeWarning"

    # Re-fetch items after Set-TenantTemplate may have changed templates
    # Use Get-Item for $site (passed to SXA functions) — see Phase 0 comment.
    # $settingsItem and $siteDefItem only use .Fields[]/Editing — raw is OK.
    $debug += "P2: re-fetching items after Set-TenantTemplate"
    $site = Get-Item -Path "master:" -ID $site.ID
    $settingsItem = $db.GetItem($settingsItem.ID)
    $siteDefItem = $db.GetItem($siteDefItem.ID)
    $debug += "P2: re-fetched — site=$($site.TemplateName) settings=$($settingsItem.TemplateName) siteDef=$($siteDefItem.TemplateName)"

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 3: Wire Settings fields
    # ═══════════════════════════════════════════════════════════════════════════
    $debug += "P3: resolving settings item"
    $resolvedSettings = Get-SettingsItem $site
    $debug += "P3: Get-SettingsItem returned=$(if($resolvedSettings){$resolvedSettings.Name + ' ' + $resolvedSettings.ID}else{'NULL — using fallback'})"
    if (-not $resolvedSettings) {
        $resolvedSettings = $settingsItem
    }

    $resolvedSettings.Editing.BeginEdit()

    # System references (same for all sites)
    $layoutItem = Get-ItemByIdSafe $ID_MAIN_LAYOUT
    if ($layoutItem) {
        $resolvedSettings.Fields["LayoutPath"].Value = $layoutItem.ID.ToString()
    }
    $resolvedSettings.Fields["EditingTheme"].Value = $ID_EDITING_THEME
    $resolvedSettings.Fields["ServerSideRenderingEngine"].Value = "http"
    $resolvedSettings.Fields["LayoutServiceConfiguration"].Value = "sxa-jss"
    $resolvedSettings.Fields["DatasourceStrategy"].Value = "sxa"
    $resolvedSettings.Fields["ImportDatabase"].Value = "master"

    # Tenant references
    if ($tenant.Fields["RenderingsFolder"] -and $tenant.Fields["RenderingsFolder"].Value) {
        $resolvedSettings.Fields["RenderingsPath"].Value = $tenant.Fields["RenderingsFolder"].Value
    }
    if ($tenant.Fields["PlaceholderSettingsFolder"] -and $tenant.Fields["PlaceholderSettingsFolder"].Value) {
        $resolvedSettings.Fields["PlaceholdersPath"].Value = $tenant.Fields["PlaceholderSettingsFolder"].Value
    }
    # Templates location — use templatesLocation if provided, else fall back to tenant's Templates field
    if ($templatesLocation -and $templatesLocation.Trim()) {
        # Resolve relative path to full Sitecore path
        $templatesPath = "master:/sitecore/templates/$($templatesLocation.TrimStart('/'))"
        $templatesItem = Get-Item -Path $templatesPath -ErrorAction SilentlyContinue
        if ($templatesItem) {
            $resolvedSettings.Fields["Templates"].Value = $templatesItem.ID.ToString()
            $debug += "P3: Set Settings→Templates to $templatesPath ($($templatesItem.ID))"
        } else {
            $debug += "P3: WARNING — templatesLocation '$templatesLocation' not found, falling back to tenant Templates"
            if ($tenant.Fields["Templates"] -and $tenant.Fields["Templates"].Value) {
                $resolvedSettings.Fields["Templates"].Value = $tenant.Fields["Templates"].Value
            }
        }
    } elseif ($tenant.Fields["Templates"] -and $tenant.Fields["Templates"].Value) {
        $resolvedSettings.Fields["Templates"].Value = $tenant.Fields["Templates"].Value
    }

    # Site item references
    $dataRef = Get-DataItem $site
    if ($dataRef) {
        $resolvedSettings.Fields["AppDatasourcesPath"].Value = $dataRef.ID.ToString()
    }
    $dictItem = $site.Children | Where-Object { $_.Name -eq "Dictionary" } | Select-Object -First 1
    if ($dictItem) {
        $resolvedSettings.Fields["DictionaryPath"].Value = $dictItem.ID.ToString()
        $resolvedSettings.Fields["DictionaryDomain"].Value = $dictItem.ID.ToString()
    }

    # AppTemplate — use project-level Headless Site template (resolved in Phase 1)
    $resolvedSettings.Fields["AppTemplate"].Value = $projectHS.ID.ToString()

    # DefaultWorkflow
    $resolvedSettings.Fields["DefaultWorkflow"].Value = $ID_DEFAULT_WORKFLOW

    # Parameters
    $resolvedSettings.Fields["Name"].Value = $siteName
    $resolvedSettings.Fields["FilesystemPath"].Value = "/dist/$siteName"

    # Languages
    $langItem = Get-ChildItem -Path "/sitecore/system/Languages" | Where-Object { $_.Name -eq $language } | Select-Object -First 1
    if ($langItem) {
        $resolvedSettings.Fields["SupportedLanguages"].Value = $langItem.ID.ToString()
    }

    $resolvedSettings.Editing.EndEdit() > $null
    $debug += "P3: settings edit committed"
    $phases += "Phase3:OK settings wired"

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 4: Install modules via Add-SiteModule (optional)
    # ═══════════════════════════════════════════════════════════════════════════
    $modulesInstalled = 0
    $moduleErrors = @()
    $debug += "P4: installModules=$installModules siteTemplateId=$siteTemplateId"
    if ($installModules -eq "true") {

        # ── PRE-CHECK: Dump the state that Add-SiteModule depends on ──────────
        # Add-SiteModule internally calls Get-SettingsItem, Get-ThemeItem,
        # Get-ItemByIdSafe for EditingTheme, Get-SortedSetupItemsCollection.
        # If any of these fail on a bare skeleton, the module install silently
        # fails (Add-SiteModule swallows errors in its catch block).

        $debug += "P4-PRE: checking Add-SiteModule prerequisites..."

        # 1. Get-SettingsItem — does it find the site's Settings?
        $preSettings = Get-SettingsItem $site
        if ($preSettings) {
            $debug += "P4-PRE: Get-SettingsItem=$($preSettings.Paths.FullPath) template=$($preSettings.TemplateName) ID=$($preSettings.ID)"
            $debug += "P4-PRE: EditingTheme field='$($preSettings.Fields[""EditingTheme""].Value)'"
            $debug += "P4-PRE: SiteTheme field='$($preSettings.Fields[""SiteTheme""].Value)'"
        } else {
            $debug += "P4-PRE: *** Get-SettingsItem returned NULL — Add-SiteModule will fail silently ***"
            $moduleErrors += "Get-SettingsItem returned null"
        }

        # 2. Get-ThemeItem — does the site have a resolvable theme?
        Import-Function -Name Get-ThemeItem
        $preTheme = $null
        try {
            $preTheme = Get-ThemeItem $site
            $debug += "P4-PRE: Get-ThemeItem=$(if($preTheme){$preTheme.Paths.FullPath + ' (' + $preTheme.ID + ')'}else{'NULL (no site theme set — expected for fresh site)'})"
        } catch {
            $debug += "P4-PRE: Get-ThemeItem THREW: $($_.Exception.Message)"
        }

        # 3. EditingTheme — does the ID in Settings resolve to a real item?
        if ($preSettings) {
            $editingThemeId = $preSettings.Fields["EditingTheme"].Value
            if ($editingThemeId) {
                $editingThemeItem = Get-ItemByIdSafe $editingThemeId
                $debug += "P4-PRE: EditingTheme item=$(if($editingThemeItem){$editingThemeItem.Paths.FullPath}else{'NULL — ID in field does not resolve'})"
            } else {
                $debug += "P4-PRE: EditingTheme field is EMPTY on Settings"
            }
        }

        # 4. Count site descendants BEFORE module install
        $preSiteChildren = @(Get-ChildItem -Path $site.Paths.Path -Recurse)
        $debug += "P4-PRE: site descendants BEFORE=$($preSiteChildren.Count)"

        # 5. List immediate children of key skeleton folders
        foreach ($folderName in @("Presentation","Settings","Data")) {
            $folder = $site.Children | Where-Object { $_.Name -eq $folderName } | Select-Object -First 1
            if ($folder) {
                $folderChildren = @($folder.Children)
                $debug += "P4-PRE: $folderName/ has $($folderChildren.Count) children: $(($folderChildren | ForEach-Object { $_.Name }) -join ', ')"
            } else {
                $debug += "P4-PRE: $folderName/ NOT FOUND under site"
            }
        }

        # ── Resolve the canonical module list from the specified Solution Template (by ID) ──
        $cleanSiteTemplateId = $siteTemplateId -replace '[{}]', ''
        $solutionTemplateItem = Get-Item -Path "master:" -ID $cleanSiteTemplateId
        if (-not $solutionTemplateItem -or -not $solutionTemplateItem.Name) {
            throw "PHASE4 FAILED: Solution template not found for ID $siteTemplateId (ghost item or missing)"
        }
        $debug += "P4: solutionTemplate=$($solutionTemplateItem.Name) ($($solutionTemplateItem.ID)) path=$($solutionTemplateItem.Paths.FullPath)"
        $siteModulesField = $solutionTemplateItem.Fields['Site Modules'].Value
        $debug += "P4: siteModulesField=$siteModulesField"

        if ($siteModulesField) {
            $moduleIds = @($siteModulesField.Split("|") | ForEach-Object { $_.Trim() -replace '[{}]', '' } | Where-Object { $_ -ne '' })
            $modulesToInstall = @()
            $skippedModules = @()
            foreach ($mid in $moduleIds) {
                $modItem = Get-Item -Path "master:" -ID $mid
                if (-not $modItem -or -not $modItem.Name) {
                    $debug += "P4: *** SKIP moduleId=$mid — resolved to null/ghost ***"
                    $skippedModules += $mid
                    continue
                }
                if (-not $modItem.HasChildren) {
                    $debug += "P4: *** SKIP module=$($modItem.Name) ($mid) — has NO children (no setup actions) ***"
                    $skippedModules += "$($modItem.Name) ($mid)"
                    continue
                }
                $modulesToInstall += $modItem
                $debug += "P4: module=$($modItem.Name) ($($modItem.ID)) template=$($modItem.TemplateName) childCount=$($modItem.Children.Count)"
            }
            if ($skippedModules.Count -gt 0) {
                $moduleErrors += "Skipped $($skippedModules.Count) modules: $($skippedModules -join '; ')"
            }
        } else {
            $modulesToInstall = @()
            $debug += "P4: *** WARN Site Modules field is EMPTY on solution template $siteTemplateId ***"
            $moduleErrors += "Site Modules field is empty"
        }

        $modCount = @($modulesToInstall).Count
        $debug += "P4: modulesToInstall=$modCount"

        if ($modCount -gt 0) {
            # ── Call Add-SiteModule ────────────────────────────────────────────
            # IMPORTANT: Add-SiteModule has an internal try/catch that SWALLOWS
            # errors (Write-Log + Close-Window, no re-throw). We wrap in our own
            # try/catch for any terminating errors that escape, and then verify
            # results via post-checks below.
            $debug += "P4: calling Add-SiteModule with $modCount modules..."
            $addSiteModuleError = $null
            try {
                Add-SiteModule -Site $site -DefinitionItems $modulesToInstall
                $debug += "P4: Add-SiteModule returned (no terminating error)"
            } catch {
                $addSiteModuleError = $_.Exception.Message
                $debug += "P4: *** Add-SiteModule THREW: $addSiteModuleError ***"
                $debug += "P4: *** StackTrace: $($_.ScriptStackTrace) ***"
                $moduleErrors += "Add-SiteModule threw: $addSiteModuleError"
            }

            # ── POST-CHECK: Verify what Add-SiteModule actually created ────────
            $postSiteChildren = @(Get-ChildItem -Path $site.Paths.Path -Recurse)
            $newItemCount = $postSiteChildren.Count - $preSiteChildren.Count
            $debug += "P4-POST: site descendants AFTER=$($postSiteChildren.Count) (NEW=$newItemCount)"

            # Check key expected items
            $presFolder = $site.Children | Where-Object { $_.Name -eq "Presentation" } | Select-Object -First 1
            if ($presFolder) {
                $presChildren = @(Get-ChildItem -Path $presFolder.Paths.Path -Recurse)
                $debug += "P4-POST: Presentation/ now has $($presChildren.Count) descendants"
                foreach ($pc in $presChildren) {
                    $debug += "P4-POST:   $($pc.Paths.FullPath) [$($pc.TemplateName)]"
                }

                # Specifically check Available Renderings (created by Presentation Settings module)
                $avRenderings = $presChildren | Where-Object { $_.TemplateName -eq "Available Renderings" }
                $debug += "P4-POST: Available Renderings items=$(@($avRenderings).Count)"
            } else {
                $debug += "P4-POST: *** Presentation folder NOT FOUND after module install ***"
            }

            $settFolder = $site.Children | Where-Object { $_.Name -eq "Settings" } | Select-Object -First 1
            if ($settFolder) {
                $settChildren = @(Get-ChildItem -Path $settFolder.Paths.Path -Recurse)
                $debug += "P4-POST: Settings/ now has $($settChildren.Count) descendants"
            }

            $dataFolder = $site.Children | Where-Object { $_.Name -eq "Data" } | Select-Object -First 1
            if ($dataFolder) {
                $dataChildren = @(Get-ChildItem -Path $dataFolder.Paths.Path -Recurse)
                $debug += "P4-POST: Data/ now has $($dataChildren.Count) descendants"
            }

            # Check Modules field on site (Add-SiteModule is supposed to update it)
            $site = Get-Item -Path "master:" -ID $site.ID
            $postModulesField = $site.Fields["Modules"].Value
            $debug += "P4-POST: site Modules field='$postModulesField'"

            if ($newItemCount -eq 0 -and -not $addSiteModuleError) {
                $debug += "P4-POST: *** WARNING: Add-SiteModule returned OK but created ZERO new items ***"
                $moduleErrors += "Add-SiteModule created 0 new items (silent failure)"
            }

            $modulesInstalled = $modCount

            # ── Post-setup steps ──────────────────────────────────────────────
            $debug += "P4: calling Invoke-PostSetupStep..."
            try {
                $postModel = New-Object Sitecore.XA.JSS.Foundation.Scaffolding.Models.CreateNewJSSSiteModel
                $postModel.SiteName        = $siteName
                $postModel.SiteLocation    = $site.Parent
                $postModel.DefinitionItems = New-Object System.Collections.ArrayList(,@($modulesToInstall))
                $postModel.Language        = $language
                $postModel.HostName        = $hostName

                Invoke-PostSetupStep -DefinitionItems $modulesToInstall -Model $postModel
                $debug += "P4: Invoke-PostSetupStep done"
            } catch {
                $debug += "P4: *** Invoke-PostSetupStep THREW: $($_.Exception.Message) ***"
                $moduleErrors += "Invoke-PostSetupStep threw: $($_.Exception.Message)"
            }
        }

        # ── Set SiteTemplate + Modules fields on the site ──
        $site = Get-Item -Path "master:" -ID $site.ID  # re-fetch with SPE wrapper
        $site.Editing.BeginEdit()
        $site.Fields["SiteTemplate"].Value = $solutionTemplateItem.ID.ToString()
        $moduleIdList = ($modulesToInstall | ForEach-Object { $_.ID.ToString() }) -join '|'
        $site.Fields["Modules"].Value = $moduleIdList
        $site.Editing.EndEdit() > $null
        $debug += "P4: SiteTemplate set to $($solutionTemplateItem.ID)"
        $debug += "P4: Modules field set with $(@($modulesToInstall).Count) IDs"

        if ($moduleErrors.Count -gt 0) {
            $phases += "Phase4:WARN modules=$modulesInstalled errors=$($moduleErrors.Count): $($moduleErrors -join ' | ')"
        } else {
            $phases += "Phase4:OK modules=$modulesInstalled newItems=$newItemCount solutionTemplate=$($solutionTemplateItem.Name)"
        }
    } else {
        $phases += "Phase4:SKIP installModules=false"
    }

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 5: Wire SiteDefinition + media library
    # ═══════════════════════════════════════════════════════════════════════════

    # ─── Media Library ────────────────────────────────────────────────────────
    $mediaLibCreated = $false
    try {
        $siteMediaLibrary = Add-SiteMediaLibrary $site
        if ($siteMediaLibrary) {
            $site.Editing.BeginEdit()
            $site.Fields["SiteMediaLibrary"].Value = $siteMediaLibrary.ID.ToString()
            $site.Editing.EndEdit() > $null

            $siteMediaItem = Get-SiteMediaItem $site
            if ($siteMediaItem) {
                $additionalIds = @($siteMediaLibrary.ID.ToString())
                if ($tenant.Fields["SharedMediaLibrary"] -and $tenant.Fields["SharedMediaLibrary"].Value) {
                    $additionalIds += $tenant.Fields["SharedMediaLibrary"].Value
                }
                $siteMediaItem.Editing.BeginEdit()
                $siteMediaItem.Fields["AdditionalChildren"].Value = $additionalIds -join "|"
                $siteMediaItem.Editing.EndEdit() > $null
            }
            $mediaLibCreated = $true
        }
    } catch {
        # Media library creation is non-fatal — log and continue
        $phases += "Phase5:WARN media library error: $($_.Exception.Message)"
    }

    # ─── SiteDefinition ──────────────────────────────────────────────────────
    # Re-fetch after Phase 4 module installation may have modified items
    $siteDefItem = $db.GetItem($siteDefItem.ID)
    if (-not $siteDefItem) {
        # Try to find it from Settings
        $siteDefItem = Get-ChildItem -Recurse -Path ($settingsItem.Paths.FullPath) |
            Where-Object { (Test-ItemIsSiteDefinition $_) -eq $true } | Select-Object -First 1
    }

    if ($siteDefItem) {
        $siteDefItem.Editing.BeginEdit()

        $siteDefItem.Fields["HostName"].Value       = $hostName
        $siteDefItem.Fields["VirtualFolder"].Value   = "/"
        $siteDefItem.Fields["RenderingHost"].Value   = "Default"
        $siteDefItem.Fields["Environment"].Value     = "*"
        $siteDefItem.Fields["Language"].Value        = $language
        $siteDefItem.Fields["Database"].Value        = "master"
        $siteDefItem.Fields["POS"].Value             = "$language=$siteName"

        if ([string]::IsNullOrWhiteSpace($siteDefItem.Fields["SiteName"].Value) -or $siteDefItem.Fields["SiteName"].Value -eq '$$name') {
            $siteDefItem.Fields["SiteName"].Value = $siteName
        }

        # Find Home for StartItem — by name convention (MySite-safe, not template-based)
        $homeForStartItem = $site.Children | Where-Object { $_.Name -eq "Home" } | Select-Object -First 1
        if ($homeForStartItem) {
            $siteDefItem.Fields["StartItem"].Value = $homeForStartItem.ID.ToString()
        }

        # ThumbnailsRootPath from media library
        if ($mediaLibCreated -and $siteMediaLibrary) {
            $siteDefItem.Fields["ThumbnailsRootPath"].Value = $siteMediaLibrary.ID.ToString()
        }

        $siteDefItem.Editing.EndEdit() > $null
    }

    # ─── Site-level fields ────────────────────────────────────────────────────
    $site = Get-Item -Path "master:" -ID $site.ID
    $site.Editing.BeginEdit()
    $site.Fields["Name"].Value = $siteName
    $site.Editing.EndEdit() > $null

    $debug += "P5: done"
    $phases += "Phase5:OK siteDef=$($siteDefItem.ID) mediaLib=$mediaLibCreated"

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE 6: Upgrade migrated layout items to SXA JSS Layout template
    # ═══════════════════════════════════════════════════════════════════════════
    # Layout items pushed from XP have JSS Layout or base Layout template.
    # XM Cloud Headless SXA requires SXA JSS Layout template.
    #
    # DISCOVERY METHOD: Same approach as diag-layout-discovery.ps1 / xp-discovery:
    #   site content items → unique page template IDs → template __Standard Values
    #   → Get-Layout → layout definition item → ChangeTemplate if needed.
    # This is site-scoped: only layouts actually referenced by this site's pages.
    #
    # WHY: SXA JSS Layout inherits from base Layout — it's a strict superset.
    # ChangeTemplate is safe: no field loss, no orphaned data.
    # ═══════════════════════════════════════════════════════════════════════════
    $debug += "P6: starting layout template upgrade"
    $layoutsUpgraded = 0
    $layoutsSkipped = 0
    $layoutsChecked = 0

    $sxaJssLayoutTemplate = Get-Item -Path "master:" -ID ($ID_SXA_JSS_LAYOUT_TEMPLATE -replace '[{}]', '') -ErrorAction SilentlyContinue
    if (-not $sxaJssLayoutTemplate) {
        $debug += "P6: *** SXA JSS Layout template not found ($ID_SXA_JSS_LAYOUT_TEMPLATE) — SKIP ***"
        $phases += "Phase6:SKIP SXA JSS Layout template not found"
    } else {
        $debug += "P6: SXA JSS Layout template=$($sxaJssLayoutTemplate.Paths.FullPath) ($($sxaJssLayoutTemplate.ID))"

        # Step 1: Collect unique page template IDs from site content items.
        # .Axes.GetDescendants() is a single cache hit — appropriate for <10K items.
        # Same pattern as diag-layout-discovery.ps1 and xp-discovery scripts.
        $pageTemplateIds = @{}  # templateId string → $true (dedup)
        $allSiteItems = $site.Axes.GetDescendants()
        $debug += "P6: scanning $($allSiteItems.Count) site items for unique page templates"

        foreach ($contentItem in $allSiteItems) {
            $layoutField = New-Object Sitecore.Data.Fields.LayoutField($contentItem)
            if (-not [string]::IsNullOrWhiteSpace($layoutField.Value)) {
                $tid = $contentItem.TemplateID.ToString()
                if (-not $pageTemplateIds.ContainsKey($tid)) {
                    $pageTemplateIds[$tid] = $true
                }
            }
        }
        $debug += "P6: found $($pageTemplateIds.Count) unique page template(s) with layouts"

        # Step 2: For each page template, resolve SV → Get-Layout → layout item.
        # Dedup layout items by ID (multiple templates may share the same layout).
        $layoutItemMap = @{}  # layoutItemId → layout item (dedup)
        foreach ($tid in $pageTemplateIds.Keys) {
            $templateItem = Get-Item -Path "master:" -ID $tid -ErrorAction SilentlyContinue
            if (-not $templateItem) { continue }

            $svPath = "master:" + $templateItem.Paths.FullPath + "/__Standard Values"
            $svItem = Get-Item -Path $svPath -ErrorAction SilentlyContinue
            if (-not $svItem) { continue }

            $layoutItem = Get-Layout -Item $svItem 2>$null
            if ($layoutItem -and -not $layoutItemMap.ContainsKey($layoutItem.ID.ToString())) {
                $layoutItemMap[$layoutItem.ID.ToString()] = $layoutItem
                $debug += "P6: discovered layout '$($layoutItem.Name)' ($($layoutItem.ID)) at $($layoutItem.Paths.FullPath) via template $($templateItem.Name)"
            }
        }
        $debug += "P6: found $($layoutItemMap.Count) unique layout item(s) to check"

        # Step 3: ChangeTemplate on each layout item if needed.
        $sxaJssLayoutIdObj = [Sitecore.Data.ID]::Parse($ID_SXA_JSS_LAYOUT_TEMPLATE)

        foreach ($layoutItem in $layoutItemMap.Values) {
            $layoutsChecked++

            # Check if already SXA JSS Layout (via direct TemplateID match OR template inheritance)
            # InheritsFrom doesn't match self — must check TemplateID equality first
            $alreadySxaJss = ($layoutItem.TemplateID.ToString() -eq $ID_SXA_JSS_LAYOUT_TEMPLATE)
            if (-not $alreadySxaJss) {
                $currentTemplate = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($layoutItem, $db)
                if ($currentTemplate) {
                    $alreadySxaJss = $currentTemplate.InheritsFrom($sxaJssLayoutIdObj)
                }
            }

            if ($alreadySxaJss) {
                $layoutsSkipped++
                $debug += "P6: SKIP $($layoutItem.Name) ($($layoutItem.ID)) — already SXA JSS Layout"
            } else {
                $layoutItem.ChangeTemplate([Sitecore.Data.Items.TemplateItem]$sxaJssLayoutTemplate)
                $layoutsUpgraded++
                $debug += "P6: UPGRADED $($layoutItem.Name) ($($layoutItem.ID)) from $($layoutItem.TemplateName) to SXA JSS Layout"
            }
        }

        $debug += "P6: done — checked=$layoutsChecked upgraded=$layoutsUpgraded skipped=$layoutsSkipped"
        $phases += "Phase6:OK checked=$layoutsChecked upgraded=$layoutsUpgraded skipped=$layoutsSkipped"
    }

    # ═══════════════════════════════════════════════════════════════════════════
    # RESULT
    # ═══════════════════════════════════════════════════════════════════════════
    [PSCustomObject]@{
        Status           = "ok"
        SiteId           = $site.ID.ToString()
        SitePath         = $site.Paths.FullPath
        SiteName         = $siteName
        TenantId         = $tenant.ID.ToString()
        TenantPath       = $tenant.Paths.FullPath
        SiteDefId        = if ($siteDefItem) { $siteDefItem.ID.ToString() } else { "" }
        SiteTemplate     = $siteTemplateId
        HomeWarning      = $homeWarning
        ModulesInstalled = $modulesInstalled
        ModuleErrors     = $moduleErrors
        MediaLibCreated  = $mediaLibCreated
        LayoutsUpgraded  = $layoutsUpgraded
        Phases           = $phases
        Debug            = $debug
    } | ConvertTo-Json -Depth 3

} catch {
    [PSCustomObject]@{
        Status     = "error"
        Error      = $_.Exception.Message
        StackTrace = $_.ScriptStackTrace
        Line       = $_.InvocationInfo.ScriptLineNumber
        Phases     = $phases
        Debug      = $debug
    } | ConvertTo-Json -Depth 3
}
