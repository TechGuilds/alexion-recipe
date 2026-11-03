<#
.INJECTED_VARIABLES
  $sitePath    [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
  $modulesJson [string] - JSON array of { modulePath, layer } objects
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    # ─── Load built-in SXA/JSS SPE functions ─────────────────────────────────
    Import-Function -Name "Get-Action"
    Import-Function -Name "Invoke-SiteAction"
    Import-Function -Name "Get-SettingsItem"
    Import-Function -Name "Get-ThemeItem"
    Import-Function -Name "Get-ItemByIdSafe"
    Import-Function -Name "Invoke-PostSetupStep"

    $SitePath    = $sitePath
    $ModulesJson = $modulesJson

    # ─── Validate site ───────────────────────────────────────────────────────
    if (-not (Test-Path "master:$SitePath")) {
        throw "Site not found at $SitePath"
    }
    $siteItem = Get-Item -Path "master:$SitePath"

    # ─── Resolve site theme + editing theme (needed by Invoke-SiteAction) ────
    $defaultDeviceID = "{FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3}"
    $defaultDevice = Get-Item -Path "master:" -ID $defaultDeviceID -ErrorAction SilentlyContinue
    $siteTheme = $null
    try { $siteTheme = Get-ThemeItem $siteItem $defaultDevice } catch {}
    $settingsItem = Get-SettingsItem $siteItem
    $editingTheme = $null
    if ($settingsItem) {
        try {
            $etId = $settingsItem.Fields["EditingTheme"].Value
            if ($etId) { $editingTheme = Get-ItemByIdSafe $etId }
        } catch {}
    }

    # Read existing Modules field for idempotency checks
    $existingModuleIds = @()
    if ($siteItem.Fields["Modules"].Value) {
        $existingModuleIds = @($siteItem.Fields["Modules"].Value.Split("|") |
            ForEach-Object { $_.Trim() -replace '[{}]', '' } |
            Where-Object { $_ -ne '' })
    }

    # Parse the modules JSON array
    $modules = $ModulesJson | ConvertFrom-Json

    $results  = @()
    $allAppliedDefinitionItems = @()
    $postSetup = [PSCustomObject]@{
        Status = "not-required"
        Error  = ""
    }

    foreach ($mod in $modules) {
        $modPath  = $mod.modulePath
        $modLayer = $mod.layer
        $modName  = Split-Path $modPath -Leaf

        try {
            # ─── Resolve the module's Settings folder ────────────────────────
            $settingsFolderPath = "/sitecore/system/Settings/$modLayer/$modPath"
            if (-not (Test-Path "master:$settingsFolderPath")) {
                $results += [PSCustomObject]@{
                    Module = $modName
                    Path   = $modPath
                    Layer  = $modLayer
                    Action = "error"
                    Reason = "Settings folder not found: $settingsFolderPath"
                }
                continue
            }

            $settingsFolder = Get-Item -Path "master:$settingsFolderPath"

            # ─── Resolve HeadlessSiteSetupRoot (the actual definition item) ──
            # Add-SiteModule expects definition items (HeadlessSiteSetupRoot),
            # not their parent Folder. Use .Children (Get-ChildItem doesn't
            # enumerate children of Settings items reliably via SPE Remoting).
            $siteSetupRoot = $settingsFolder.Children |
                Where-Object { $_.TemplateName -eq "HeadlessSiteSetupRoot" } |
                Select-Object -First 1

            if (-not $siteSetupRoot) {
                $results += [PSCustomObject]@{
                    Module = $modName
                    Path   = $modPath
                    Layer  = $modLayer
                    Action = "error"
                    Reason = "HeadlessSiteSetupRoot not found under $settingsFolderPath — was the module registered?"
                }
                continue
            }

            $definitionId = $siteSetupRoot.ID.ToString() -replace '[{}]', ''

            # Resolve the concrete Available Renderings item name(s) from the
            # module's own AddItem branch actions.  The target name is often
            # prefixed with the site name (for example "ExampleSite Media"), so the
            # bare module leaf is not a reliable post-setup assertion.
            $actions = @($siteSetupRoot | Get-Action)
            $expectedAvailableRenderingNames = @(
                $actions |
                    Where-Object { $_.TemplateName -eq "AddItem" } |
                    ForEach-Object {
                        $branchId = $_.Fields["Template"].Value
                        if ($branchId) {
                            $branch = Get-Item -Path "master:" -ID $branchId -ErrorAction SilentlyContinue
                            if ($branch) {
                                @($branch.Children |
                                    Where-Object { $_.TemplateName -eq "Available Renderings" } |
                                    ForEach-Object { $_.Name })
                            }
                        }
                    } |
                    Where-Object { $_ } |
                    Select-Object -Unique
            )

            # ─── Idempotency: check site Modules field ──────────────────────
            # Add-SiteModule's Update-FeatureField appends the definition item
            # ID to the site's Modules field. If already present, skip.
            if ($existingModuleIds -contains $definitionId) {
                $results += [PSCustomObject]@{
                    Module = $modName
                    Path   = $modPath
                    Layer  = $modLayer
                    Action = "skipped"
                    Reason = "Already in site Modules field ($definitionId)"
                    ExpectedAvailableRenderingNames = $expectedAvailableRenderingNames
                }
                continue
            }

            # ─── Apply via Get-Action + Invoke-SiteAction (New-JSSSite pattern) ──
            # We call these directly instead of Add-SiteModule because
            # Get-SortedSetupItemsCollection requires List[Item] which
            # fails with PS arrays in SPE Remoting.
            foreach ($actionItem in $actions) {
                Invoke-SiteAction $siteItem $actionItem -SiteTheme $siteTheme -EditingTheme $editingTheme $siteItem.Language.Name
            }

            # Update Modules field (matching Add-SiteModule's Update-FeatureField)
            $currentModules = $siteItem.Fields["Modules"].Value
            if ($currentModules) {
                $siteItem.Editing.BeginEdit()
                $siteItem.Fields["Modules"].Value = $currentModules + "|" + $siteSetupRoot.ID.ToString()
                $siteItem.Editing.EndEdit() > $null
            } else {
                $siteItem.Editing.BeginEdit()
                $siteItem.Fields["Modules"].Value = $siteSetupRoot.ID.ToString()
                $siteItem.Editing.EndEdit() > $null
            }

            $allAppliedDefinitionItems += $siteSetupRoot
            $results += [PSCustomObject]@{
                Module = $modName
                Path   = $modPath
                Layer  = $modLayer
                Action = "applied"
                Reason = ""
                ExpectedAvailableRenderingNames = $expectedAvailableRenderingNames
            }

            # Re-fetch site item to pick up Modules field update
            $siteItem = $siteItem.Database.GetItem($siteItem.ID)
        } catch {
            $results += [PSCustomObject]@{
                Module = $modName
                Path   = $modPath
                Layer  = $modLayer
                Action = "error"
                Reason = $_.Exception.Message
            }
        }
    }

    # ─── Post-setup steps (per New-JSSSite pattern) ──────────────────────────
    if ($allAppliedDefinitionItems.Count -gt 0) {
        try {
            $postModel = New-Object Sitecore.XA.JSS.Foundation.Scaffolding.Models.CreateNewJSSSiteModel
            $postModel.SiteName        = $siteItem.Name
            $postModel.SiteLocation    = $siteItem.Parent
            $postModel.DefinitionItems = New-Object System.Collections.ArrayList(,@($allAppliedDefinitionItems))
            $postModel.Language        = "en"
            Invoke-PostSetupStep -DefinitionItems $allAppliedDefinitionItems -Model $postModel
            $postSetup = [PSCustomObject]@{
                Status = "completed"
                Error  = ""
            }
        } catch {
            $postSetup = [PSCustomObject]@{
                Status = "failed"
                Error  = $_.Exception.Message
            }
        }
    }

    # A module ID in the site's Modules field proves only that the setup action
    # was requested. Verify the target-side editor materialization separately so
    # a swallowed post-setup error cannot be reported as a successful conversion.
    $availableRenderingsPath = "$SitePath/Presentation/Available Renderings"
    $availableRenderingsRoot = Get-Item -Path "master:$availableRenderingsPath" -ErrorAction SilentlyContinue
    $availableRenderingNames = if ($availableRenderingsRoot) {
        @($availableRenderingsRoot.Children | ForEach-Object { $_.Name })
    } else {
        @()
    }
    $moduleMaterialization = @($results | Where-Object { $_.Action -ne "error" } | ForEach-Object {
        $expectedNames = @($_.ExpectedAvailableRenderingNames)
        $matchedNames = @($expectedNames | Where-Object { $availableRenderingNames -contains $_ })
        # Not every legitimate module installs an Available Renderings action.
        # Report those explicitly as not applicable; any module that does define
        # one must materialize the exact branch child name on the target.
        $isApplicable = $expectedNames.Count -gt 0
        $isPresent = $isApplicable -and $availableRenderingsRoot -and (
            $matchedNames.Count -eq $expectedNames.Count
        )
        [PSCustomObject]@{
            Module = $_.Module
            Path = $_.Path
            ExpectedNames = $expectedNames
            MatchedNames = $matchedNames
            Status = if (-not $isApplicable) { "not-applicable" } elseif ($isPresent) { "present" } else { "missing" }
            Reason = if (-not $isApplicable) {
                "Module defines no Available Renderings AddItem action."
            } elseif ($isPresent) { "" } elseif (-not $availableRenderingsRoot) {
                "Available Renderings folder not found at $availableRenderingsPath"
            } else {
                "Available Renderings item(s) not found for module '$($_.Module)': $($expectedNames -join ', ')"
            }
        }
    })

    # ─── Summary ─────────────────────────────────────────────────────────────
    $applied = @($results | Where-Object { $_.Action -eq "applied" }).Count
    $skipped = @($results | Where-Object { $_.Action -eq "skipped" }).Count
    $actionErrors = @($results | Where-Object { $_.Action -eq "error" }).Count
    $materializationErrors = @($moduleMaterialization | Where-Object { $_.Status -eq "missing" }).Count
    $errors = $actionErrors + $materializationErrors + $(if ($postSetup.Status -eq "failed") { 1 } else { 0 })

    [PSCustomObject]@{
        Status   = if ($errors -eq 0) { "ok" } else { "partial" }
        SitePath = $SitePath
        Applied  = $applied
        Skipped  = $skipped
        Failed   = $errors
        Total    = $results.Count
        Results  = $results
        PostSetup = $postSetup
        AvailableRenderingsPath = $availableRenderingsPath
        ModuleMaterialization = $moduleMaterialization
    } | ConvertTo-Json -Depth 6

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
