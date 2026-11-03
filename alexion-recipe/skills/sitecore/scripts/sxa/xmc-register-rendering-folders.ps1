<#
.SYNOPSIS
  Registers rendering folders as thin SXA modules and optionally ensures all
  Json Renderings are SXA-ready (RP templates + dynamic PH wildcards).

  ⚠ SYNC NOTE: The per-rendering RP fix (Step 1) and dynamic PH logic (Step 2)
  are duplicated in xmc-ensure-rendering-parameters.ps1.
  If you change the algorithm here, update it there too — and vice versa.

.INJECTED_VARIABLES
  $modulesJson              [string] - JSON array of [{modulePath, layer}]
  $renderingsPrefix         [string] - Prefix for Available Renderings name (e.g. "MySite")
  $ensureRenderingParameters [string] - "true" or "false" — run RP + dynamic PH fix inline per module
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    Import-Function -Name "Add-HeadlessModule"
    Import-Function -Name "Get-ModuleStartLocation"
    Import-Function -Name "Add-FolderStructure"

    $Prefix = $renderingsPrefix
    $doRpFix = ($ensureRenderingParameters -eq "true")

    # ─── Constants ────────────────────────────────────────────────────────────
    $jsonRenderingTemplateId     = "{04646A89-996F-4EE7-878A-FFDBF1F0EF0D}"
    $availRenderingsTemplateId   = "{76DA0A8D-FC7E-42B2-AF1E-205B49E43F98}"
    $baseBranchId                = "{099D9AE8-2FE5-4E38-8FD4-F2058FA24485}"
    $addItemLocationConstant     = "{3F14C1B6-5A2D-44CA-A8EF-DFE3CBD574E4}"

    # Magic base template GUIDs for RP fix
    $BRP = "{4247AAD4-EBDE-4994-998F-E067A51B1FE4}"  # BaseRenderingParameters
    $DPH = "{5C74E985-E055-43FF-B28C-DB6C6A6450A2}"  # IDynamicPlaceholder
    $PSV = "{44A022DB-56D3-419A-B43B-E27E4D8E9C41}"  # _PerSiteStandardValues
    $RID = "{3DB3EB10-F8D0-4CC9-BE26-18CE7B139EC8}"  # IRenderingId
    $requiredBases = @($BRP, $DPH, $PSV, $RID)

    # Field IDs for dynamic placeholder infrastructure (Step 2)
    $otherPropsFieldId   = "{E829C217-5E94-4306-9C48-2634B094FDC2}"
    $placeholdersFieldId = "{069A8361-B1CD-437C-8C32-A3BE78941446}"

    # ─── Parse and sort modules ───────────────────────────────────────────────
    $modules = $modulesJson | ConvertFrom-Json
    # Sort by depth (ascending) — parents register before children for determinism
    $modules = @($modules | Sort-Object { ($_.modulePath -split "/").Count })

    # Cache roots per layer (shared across modules in same layer)
    $rootsCache = @{}

    $results = [System.Collections.ArrayList]@()

    foreach ($mod in $modules) {
        $ModPath = $mod.modulePath
        $Layer   = $mod.layer
        $ModName = Split-Path $ModPath -Leaf

        $moduleResult = [ordered]@{
            ModulePath              = $ModPath
            Layer                   = $Layer
            ModuleName              = $ModName
            Registration            = $null
            RenderingParametersFix  = $null
            DynamicPlaceholdersFix  = $null
        }

        # Hold renderingItems in scope for RP fix
        $renderingItems = $null

        # ═══ REGISTRATION ═════════════════════════════════════════════════════
        try {
            # ── Pre-checks ────────────────────────────────────────────────────
            if ($Layer -notin @("Feature", "Project", "Foundation")) {
                throw "Invalid layer '$Layer'. Must be Feature, Project, or Foundation."
            }

            $renderingsFolderPath = "/sitecore/layout/Renderings/$Layer/$ModPath"
            if (-not (Test-Path "master:$renderingsFolderPath")) {
                throw "Renderings folder not found: $renderingsFolderPath"
            }

            $renderingItems = @(Get-ChildItem -Path "master:$renderingsFolderPath" -Recurse |
                Where-Object { $_.TemplateID.ToString() -eq $jsonRenderingTemplateId })
            if ($renderingItems.Count -eq 0) {
                throw "No Json Rendering items found under $renderingsFolderPath"
            }

            $renderingIds         = @($renderingItems | ForEach-Object { $_.ID.ToString() })
            $renderingsFieldValue = $renderingIds -join "|"

            # ── Step 1: Add-HeadlessModule (with idempotency pre-check) ───────
            $settingsFolderPath = "/sitecore/system/Settings/$Layer/$ModPath"
            $skippedAddModule   = $false
            $existingSiteSetup  = $null

            if (Test-Path "master:$settingsFolderPath") {
                $existingSiteSetup = Get-ChildItem -Path "master:$settingsFolderPath" -Recurse |
                    Where-Object { $_.TemplateName -eq "HeadlessSiteSetupRoot" } |
                    Select-Object -First 1
            }

            if ($existingSiteSetup) {
                $skippedAddModule = $true
            } else {
                # Get or cache roots for this layer
                if (-not $rootsCache.ContainsKey($Layer)) {
                    $availableContainers = Get-ModuleStartLocation
                    $selectedContainers  = [System.Collections.ArrayList]@($availableContainers.Values)
                    if (-not $selectedContainers.Contains("/sitecore/system/Settings/{0}")) {
                        $selectedContainers.Add("/sitecore/system/Settings/{0}") | Out-Null
                    }
                    $roots = $selectedContainers |
                        Where-Object   { $_ } |
                        ForEach-Object { $_ -f $Layer } |
                        Where-Object   { $_ -and (Test-Path "master:$_") } |
                        ForEach-Object { Get-Item -Path "master:$_" }
                    $rootsCache[$Layer] = $roots
                }
                $roots = $rootsCache[$Layer]

                $settingsPath = "/sitecore/system/Settings/$Layer"
                if (-not ($roots | Where-Object { $_.Paths.Path -eq $settingsPath })) {
                    throw "Required settings root not found at '$settingsPath'."
                }

                $model = New-Object "Sitecore.XA.Foundation.Scaffolding.Models.NewModuleModel"
                $Tail = Split-Path $ModPath -Parent
                if (-not $Tail) { $Tail = "" }
                # Leading slash required for nested paths (WI-024/SXA-006b fix)
                $model.Tail                  = if ($Tail) { "/$Tail" } else { "" }
                $model.Roots                 = $roots
                $model.Name                  = $ModName
                $model.SetupItemTemplatesIds = @(
                    "{F036B5E0-37FB-4537-9D36-EF84E5BD41B7}",  # HeadlessTenantSetupRoot
                    "{BED31D6F-D968-45A9-B54E-12D7F977D861}"   # HeadlessSiteSetupRoot
                )

                Add-HeadlessModule $model
            }

            # ── Step 2: Copy Available Renderings branch (idempotent) ─────────
            $branchFolderPath = "/sitecore/templates/Branches/$Layer/$ModPath"
            if (-not (Test-Path "master:$branchFolderPath")) {
                throw "Branches folder not found: $branchFolderPath — Add-HeadlessModule must have failed."
            }

            $branchFolder = Get-Item -Path "master:$branchFolderPath"
            $branchName   = "Available Headless $ModName Renderings"
            $availBranch  = Get-ChildItem -Path $branchFolder.Paths.Path |
                                Where-Object { $_.Name -eq $branchName } |
                                Select-Object -First 1

            $branchCreated = $false
            if ($availBranch -eq $null) {
                $baseBranch = Get-Item -Path "master:" -ID $baseBranchId
                if ($baseBranch -eq $null) {
                    throw "Empty Available Renderings base branch not found (ID: $baseBranchId)."
                }
                $availBranch                   = $baseBranch.CopyTo($branchFolder, $branchName) | Wrap-Item
                $availBranch."__Display Name"  = ""
                $branchCreated                 = $true
            }

            # ── Step 3: Set Renderings field on branch child (always sync) ────
            $nameChild = $availBranch.Children | Select-Object -First 1 | Wrap-Item
            if ($nameChild -eq $null) {
                throw "Branch '$branchName' has no child item."
            }
            if ($nameChild.TemplateID.ToString() -ne $availRenderingsTemplateId) {
                $availRenderingsTemplate = Get-Item -Path "master:" -ID $availRenderingsTemplateId
                if ($availRenderingsTemplate -eq $null) {
                    throw "Available Renderings template not found."
                }
                $nameChild.ChangeTemplate($availRenderingsTemplate)
            }
            $nameChild."Renderings" = $renderingsFieldValue

            # ── Step 4: Create AddItem under HeadlessSiteSetupRoot ────────────
            if ($existingSiteSetup) {
                $siteSetupRoot = $existingSiteSetup | Wrap-Item
            } else {
                $siteSetupRoot = Get-ChildItem -Path "master:$settingsFolderPath" -Recurse |
                    Where-Object { $_.TemplateName -eq "HeadlessSiteSetupRoot" } |
                    Select-Object -First 1 | Wrap-Item
            }
            if ($siteSetupRoot -eq $null) {
                throw "HeadlessSiteSetupRoot not found under $settingsFolderPath"
            }

            $existingAddItem = Get-ChildItem -Path $siteSetupRoot.Paths.Path |
                Where-Object {
                    $_.TemplateName -eq "AddItem" -and
                    $_["Location"] -eq $addItemLocationConstant
                } |
                Select-Object -First 1 | Wrap-Item

            $addItemCreated = $false
            if ($existingAddItem -eq $null) {
                $addItem = New-Item -ItemType "Foundation/JSS Experience Accelerator/Scaffolding/Actions/Site/AddItem" -Path $siteSetupRoot.Paths.Path -Name "Add Available Renderings" | Wrap-Item
                $addItem."Location" = $addItemLocationConstant
                $addItem.Editing.BeginEdit()
                $addItem.Fields["Template"].Value = $availBranch.ID.ToString()
                $addItem.Editing.EndEdit()
                $addItem.__Name = "$Prefix $ModName"
                $addItemCreated = $true
            } else {
                if ($existingAddItem.Fields["Template"].Value -ne $availBranch.ID.ToString()) {
                    $existingAddItem.Editing.BeginEdit()
                    $existingAddItem.Fields["Template"].Value = $availBranch.ID.ToString()
                    $existingAddItem.Editing.EndEdit()
                }
                $expectedName = "$Prefix $ModName"
                if ($existingAddItem.__Name -ne $expectedName) {
                    $existingAddItem.__Name = $expectedName
                }
            }

            $moduleResult.Registration = [ordered]@{
                Status               = "ok"
                SkippedAddModule     = $skippedAddModule
                RenderingsRegistered = $renderingIds.Count
                BranchCreated        = $branchCreated
                AddItemCreated       = $addItemCreated
                BranchPath           = $availBranch.Paths.FullPath
                BranchId             = $availBranch.ID.ToString()
                RenderingIds         = $renderingIds
            }
        } catch {
            $moduleResult.Registration = [ordered]@{
                Status = "error"
                Error  = $_.Exception.Message
            }
            # Continue to next module — don't abort batch
            $results.Add([PSCustomObject]$moduleResult) | Out-Null
            continue
        }

        # ═══ RENDERING PARAMETERS FIX (optional) ═════════════════════════════
        if ($doRpFix -and $renderingItems) {
            try {
                $rpFolderPath = "/sitecore/templates/$Layer/$ModPath/Rendering Parameters"
                $rpFolder     = Add-FolderStructure $rpFolderPath "System/Templates/Template Folder"

                $rpCreated   = [System.Collections.ArrayList]@()
                $rpUpdated   = [System.Collections.ArrayList]@()
                $rpAlreadyOk = [System.Collections.ArrayList]@()
                $rpErrors    = [System.Collections.ArrayList]@()

                foreach ($rendering in $renderingItems) {
                    $renderingName = $rendering.Name
                    try {
                        $rpFieldValue = $rendering["Parameters Template"]

                        if (-not $rpFieldValue -or $rpFieldValue -eq "") {
                            # No RP template → CREATE
                            $rpTemplateName = "$renderingName Parameters"
                            $rpTemplatePath = "$rpFolderPath/$rpTemplateName"
                            $existingRp = Get-Item -Path "master:$rpTemplatePath" -ErrorAction SilentlyContinue
                            if ($existingRp) {
                                $rpTemplate = $existingRp
                            } else {
                                $rpTemplate = New-Item -Path "master:$rpFolderPath" -Name $rpTemplateName -ItemType "System/Templates/Template"
                            }
                            $rpTemplate."__Base template" = ($requiredBases -join "|")
                            $rendering."Parameters Template" = $rpTemplate.ID.ToString()
                            $rpCreated.Add(@{ Name = $renderingName; Id = $rpTemplate.ID.ToString() }) | Out-Null
                        } else {
                            # Existing RP template → CHECK bases
                            $rpTemplate = Get-Item -Path "master:" -ID $rpFieldValue
                            if (-not $rpTemplate) {
                                $rpErrors.Add(@{ Name = $renderingName; Error = "RP template $rpFieldValue not found" }) | Out-Null
                                continue
                            }
                            $currentBases = @()
                            $basesValue = $rpTemplate."__Base template"
                            if ($basesValue -and $basesValue -ne "") {
                                $currentBases = @($basesValue.Split("|") | Where-Object { $_ -ne "" })
                            }
                            $missingBases = @($requiredBases | Where-Object { $currentBases -notcontains $_ })
                            if ($missingBases.Count -eq 0) {
                                $rpAlreadyOk.Add(@{ Name = $renderingName; Id = $rpTemplate.ID.ToString() }) | Out-Null
                            } else {
                                $newBases = @($currentBases) + @($missingBases)
                                $rpTemplate."__Base template" = ($newBases -join "|")
                                $rpUpdated.Add(@{ Name = $renderingName; Id = $rpTemplate.ID.ToString(); Added = $missingBases }) | Out-Null
                            }
                        }
                    } catch {
                        $rpErrors.Add(@{ Name = $renderingName; Error = $_.Exception.Message }) | Out-Null
                    }
                }

                $moduleResult.RenderingParametersFix = [ordered]@{
                    Status    = "ok"
                    Created   = $rpCreated.Count
                    Updated   = $rpUpdated.Count
                    AlreadyOk = $rpAlreadyOk.Count
                    Errors    = $rpErrors.Count
                    ErrorDetails = @($rpErrors)
                }
            } catch {
                $moduleResult.RenderingParametersFix = [ordered]@{
                    Status = "error"
                    Error  = $_.Exception.Message
                }
            }

            # ═══ DYNAMIC PLACEHOLDERS FIX (Step 2 — runs after RP fix) ════════
            # ⚠ SYNC: This logic is duplicated in xmc-ensure-rendering-parameters.ps1
            try {
                $dpCreated   = [System.Collections.ArrayList]@()
                $dpAlreadyOk = [System.Collections.ArrayList]@()
                $dpErrors    = [System.Collections.ArrayList]@()

                foreach ($rendering in $renderingItems) {
                    $renderingName = $rendering.Name
                    try {
                        $phFieldValue = $rendering.Fields[$placeholdersFieldId].Value
                        if (-not $phFieldValue -or $phFieldValue -eq "") { continue }

                        $psGuids = @($phFieldValue.Split("|") | Where-Object { $_ -ne "" })
                        if ($psGuids.Count -eq 0) { continue }

                        $wildcardIds      = [System.Collections.ArrayList]@()
                        $needsFieldUpdate = $false

                        foreach ($psGuid in $psGuids) {
                            $psItem = Get-Item -Path "master:" -ID $psGuid -ErrorAction SilentlyContinue
                            if (-not $psItem) {
                                $dpErrors.Add(@{ Name = $renderingName; Error = "PS item not found: $psGuid" }) | Out-Null
                                continue
                            }

                            # Skip items that are already wildcards (created by previous runs)
                            if ($psItem.Name -match '-wildcard$') { continue }

                            $baseName = $psItem["Placeholder Key"]
                            if (-not $baseName -or $baseName -eq "") { $baseName = $psItem.Name }

                            $parentPath   = $psItem.Parent.Paths.FullPath
                            $wildcardName = "$baseName-wildcard"
                            $wildcardPath = "master:$parentPath/$wildcardName"
                            $existingWc   = Get-Item -Path $wildcardPath -ErrorAction SilentlyContinue

                            if ($existingWc) {
                                $wildcardIds.Add($existingWc.ID.ToString()) | Out-Null
                                $dpAlreadyOk.Add(@{ Name = $renderingName; BaseName = $baseName; WildcardId = $existingWc.ID.ToString() }) | Out-Null
                            } else {
                                $wcItem = New-Item -Path "master:$parentPath" -Name $wildcardName -ItemType $psItem.TemplateID.ToString()
                                $wcItem."Placeholder Key" = "$baseName-{*}"
                                $allowedControls = $psItem["Allowed Controls"]
                                if ($allowedControls -and $allowedControls -ne "") {
                                    $wcItem."Allowed Controls" = $allowedControls
                                }
                                $wildcardIds.Add($wcItem.ID.ToString()) | Out-Null
                                $dpCreated.Add(@{ Name = $renderingName; BaseName = $baseName; WildcardName = $wildcardName; WildcardId = $wcItem.ID.ToString() }) | Out-Null
                            }
                        }

                        # Update Placeholders field: keep originals + add wildcard IDs
                        if ($wildcardIds.Count -gt 0) {
                            $existingIds = @($phFieldValue.Split("|") | Where-Object { $_ -ne "" })
                            $newIds = [System.Collections.ArrayList]@($existingIds)
                            foreach ($wid in $wildcardIds) {
                                if ($newIds -notcontains $wid) {
                                    $newIds.Add($wid) | Out-Null
                                    $needsFieldUpdate = $true
                                }
                            }
                            if ($needsFieldUpdate) {
                                $db = Get-Database -Name "master"
                                $rawRendering = $db.GetItem($rendering.ID)
                                $rawRendering.Editing.BeginEdit()
                                $rawRendering.Fields[$placeholdersFieldId].Value = ($newIds -join "|")
                                $rawRendering.Editing.EndEdit()
                            }
                        }

                        # Set OtherProperties flag
                        if ($wildcardIds.Count -gt 0) {
                            $db = Get-Database -Name "master"
                            $rawRendering = $db.GetItem($rendering.ID)
                            $otherProps = $rawRendering.Fields[$otherPropsFieldId].Value
                            $dynFlag = "IsRenderingsWithDynamicPlaceholders=true"
                            if (-not $otherProps -or $otherProps -eq "") {
                                $rawRendering.Editing.BeginEdit()
                                $rawRendering.Fields[$otherPropsFieldId].Value = $dynFlag
                                $rawRendering.Editing.EndEdit()
                            } elseif ($otherProps -notmatch "IsRenderingsWithDynamicPlaceholders") {
                                $rawRendering.Editing.BeginEdit()
                                $rawRendering.Fields[$otherPropsFieldId].Value = "$otherProps`n$dynFlag"
                                $rawRendering.Editing.EndEdit()
                            }
                        }
                    } catch {
                        $dpErrors.Add(@{ Name = $renderingName; Error = $_.Exception.Message }) | Out-Null
                    }
                }

                $moduleResult.DynamicPlaceholdersFix = [ordered]@{
                    Status    = "ok"
                    Created   = $dpCreated.Count
                    AlreadyOk = $dpAlreadyOk.Count
                    Errors    = $dpErrors.Count
                    ErrorDetails = @($dpErrors)
                }
            } catch {
                $moduleResult.DynamicPlaceholdersFix = [ordered]@{
                    Status = "error"
                    Error  = $_.Exception.Message
                }
            }
        }

        # ═══ COMPONENT NAME SPACE STRIPPING (Step 3) ═════════════════════════
        # Strips whitespace from the "Component Name" field on each rendering.
        # The Content SDK uses componentName for component map lookup — spaces cause
        # silent mismatches (e.g. "Corporate Navigation" vs "CorporateNavigation").
        if ($renderingItems) {
            try {
                $cnUpdated   = [System.Collections.ArrayList]@()
                $cnAlreadyOk = [System.Collections.ArrayList]@()

                foreach ($rendering in $renderingItems) {
                    $componentName = $rendering["Component Name"]
                    if (-not $componentName -or $componentName -eq "") {
                        continue
                    }
                    if ($componentName -match '\s') {
                        $cleaned = $componentName -replace '\s+', ''
                        $rendering.Editing.BeginEdit()
                        $rendering["Component Name"] = $cleaned
                        $rendering.Editing.EndEdit()
                        $cnUpdated.Add(@{ Name = $rendering.Name; Original = $componentName; Cleaned = $cleaned }) | Out-Null
                    } else {
                        $cnAlreadyOk.Add(@{ Name = $rendering.Name; ComponentName = $componentName }) | Out-Null
                    }
                }

                $moduleResult.ComponentNameFix = [ordered]@{
                    Status    = "ok"
                    Updated   = $cnUpdated.Count
                    AlreadyOk = $cnAlreadyOk.Count
                    Details   = @($cnUpdated)
                }
            } catch {
                $moduleResult.ComponentNameFix = [ordered]@{
                    Status = "error"
                    Error  = $_.Exception.Message
                }
            }
        }

        $results.Add([PSCustomObject]$moduleResult) | Out-Null
    }

    # ─── Summary ──────────────────────────────────────────────────────────────
    $registered      = @($results | Where-Object { $_.Registration.Status -eq "ok" }).Count
    $failed          = @($results | Where-Object { $_.Registration.Status -eq "error" }).Count
    $totalRenderings = ($results |
        Where-Object { $_.Registration.Status -eq "ok" } |
        ForEach-Object { $_.Registration.RenderingsRegistered } |
        Measure-Object -Sum).Sum

    [PSCustomObject]@{
        Status           = if ($failed -eq 0) { "ok" } elseif ($registered -gt 0) { "partial" } else { "error" }
        TotalModules     = $modules.Count
        Registered       = $registered
        Failed           = $failed
        TotalRenderings  = $totalRenderings
        RenderingsPrefix = $Prefix
        Modules          = @($results)
    } | ConvertTo-Json -Depth 6

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
