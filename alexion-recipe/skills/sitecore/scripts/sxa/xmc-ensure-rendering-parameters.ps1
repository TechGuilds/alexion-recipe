<#
.SYNOPSIS
  Ensures all Json Renderings in one or more module folders are SXA-ready:
  Step 1 (RP templates) + Step 2 (dynamic PH wildcard siblings).

  ⚠ SYNC NOTE: The per-rendering RP fix (Step 1), dynamic PH logic (Step 2),
  and Component Name space stripping (Step 3) are duplicated in
  xmc-register-rendering-folders.ps1 (inline RP fix section).
  If you change the algorithm here, update it there too — and vice versa.

.INJECTED_VARIABLES
  $renderingFolderIdsJson [string] - JSON array of rendering folder GUIDs
  $renderingModulesJson  [string] - JSON array of {layer,modulePath} objects
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    Import-Function -Name "Add-FolderStructure"

    # ─── Constants ────────────────────────────────────────────────────────────
    $BRP = "{4247AAD4-EBDE-4994-998F-E067A51B1FE4}"  # BaseRenderingParameters
    $DPH = "{5C74E985-E055-43FF-B28C-DB6C6A6450A2}"  # IDynamicPlaceholder
    $PSV = "{44A022DB-56D3-419A-B43B-E27E4D8E9C41}"  # _PerSiteStandardValues
    $RID = "{3DB3EB10-F8D0-4CC9-BE26-18CE7B139EC8}"  # IRenderingId
    $requiredBases = @($BRP, $DPH, $PSV, $RID)

    $jsonRenderingTemplateId = "{04646A89-996F-4EE7-878A-FFDBF1F0EF0D}"
    $otherPropsFieldId       = "{E829C217-5E94-4306-9C48-2634B094FDC2}"
    $placeholdersFieldId     = "{069A8361-B1CD-437C-8C32-A3BE78941446}"

    # ─── Helper: resolve a folder item and derive layer + modulePath ──────────
    function Resolve-RenderingFolder {
        param(
            [string]$FolderId,
            [string]$FolderLayer,
            [string]$FolderModulePath
        )
        $prefix = "/sitecore/layout/Renderings/"
        $folder = $null
        $rLayer = ""
        $rModPath = ""

        if ($FolderId -and $FolderId -ne "") {
            $folder = Get-Item -Path "master:" -ID $FolderId -ErrorAction SilentlyContinue
            if (-not $folder) { throw "Rendering folder not found for ID: $FolderId" }
            $fullPath = $folder.Paths.FullPath
            if (-not $fullPath.StartsWith($prefix)) {
                throw "Rendering folder '$fullPath' is not under $prefix"
            }
            $remainder = $fullPath.Substring($prefix.Length)
            $parts = $remainder -split "/", 2
            $rLayer   = $parts[0]
            $rModPath = if ($parts.Length -gt 1) { $parts[1] } else { $parts[0] }
        } else {
            $rLayer   = $FolderLayer
            $rModPath = $FolderModulePath
            if (-not $rModPath -or $rModPath -eq "") {
                throw "Provide either renderingFolderId or (layer + modulePath)."
            }
            $folderPath = "master:${prefix}${rLayer}/${rModPath}"
            $folder = Get-Item -Path $folderPath -ErrorAction SilentlyContinue
            if (-not $folder) {
                throw "Rendering folder not found at '${prefix}${rLayer}/${rModPath}'"
            }
        }
        return @{ Folder = $folder; Layer = $rLayer; ModulePath = $rModPath }
    }

    # ─── Build list of folders to process ─────────────────────────────────────
    # Each entry: @{ Folder = <item>; Layer = <string>; ModulePath = <string> }
    $folderEntries = [System.Collections.ArrayList]@()
    $seenFolderIds = @{}

    # 1) Folder IDs
    if ($renderingFolderIdsJson -and $renderingFolderIdsJson -ne "" -and $renderingFolderIdsJson -ne "[]") {
        $bulkIds = $renderingFolderIdsJson | ConvertFrom-Json
        foreach ($bid in $bulkIds) {
            $entry = Resolve-RenderingFolder -FolderId $bid -FolderLayer "" -FolderModulePath ""
            $fid = $entry.Folder.ID.ToString()
            if (-not $seenFolderIds.ContainsKey($fid)) {
                $seenFolderIds[$fid] = $true
                $folderEntries.Add($entry) | Out-Null
            }
        }
    }

    # 2) Layer+modulePath pairs
    if ($renderingModulesJson -and $renderingModulesJson -ne "" -and $renderingModulesJson -ne "[]") {
        $bulkMods = $renderingModulesJson | ConvertFrom-Json
        foreach ($mod in $bulkMods) {
            $entry = Resolve-RenderingFolder -FolderId "" -FolderLayer $mod.layer -FolderModulePath $mod.modulePath
            $fid = $entry.Folder.ID.ToString()
            if (-not $seenFolderIds.ContainsKey($fid)) {
                $seenFolderIds[$fid] = $true
                $folderEntries.Add($entry) | Out-Null
            }
        }
    }

    if ($folderEntries.Count -eq 0) {
        throw "No rendering folders resolved. Provide renderingFolderId, (layer + modulePath), renderingFolderIds, or renderingModules."
    }

    # ─── Process each folder ──────────────────────────────────────────────────
    $folderResults = [System.Collections.ArrayList]@()

    foreach ($fe in $folderEntries) {
        $curFolder  = $fe.Folder
        $curLayer   = $fe.Layer
        $curModPath = $fe.ModulePath

        # Collect Json Renderings in this folder
        $renderings = @(Get-ChildItem -Path $curFolder.Paths.FullPath -Recurse |
            Where-Object { $_.TemplateID.ToString() -eq $jsonRenderingTemplateId })

        if ($renderings.Count -eq 0) {
            $folderResults.Add([PSCustomObject]@{
                FolderPath        = $curFolder.Paths.FullPath
                Layer             = $curLayer
                ModulePath        = $curModPath
                RenderingsScanned = 0
                Skipped           = "No Json Rendering items found"
            }) | Out-Null
            continue
        }

        # Ensure RP template folder exists for this module
        $rpFolderPath = "/sitecore/templates/$curLayer/$curModPath/Rendering Parameters"
        $rpFolder = Add-FolderStructure $rpFolderPath "System/Templates/Template Folder"

        $rpCreated   = [System.Collections.ArrayList]@()
        $rpUpdated   = [System.Collections.ArrayList]@()
        $rpAlreadyOk = [System.Collections.ArrayList]@()
        $dpCreated   = [System.Collections.ArrayList]@()
        $dpAlreadyOk = [System.Collections.ArrayList]@()
        $errors      = [System.Collections.ArrayList]@()

        foreach ($rendering in $renderings) {
            $renderingName = $rendering.Name
            try {
                # ══════════════════════════════════════════════════════════════
                # STEP 1: Ensure RP template with magic bases
                # ══════════════════════════════════════════════════════════════
                $rpFieldValue = $rendering["Parameters Template"]

                if (-not $rpFieldValue -or $rpFieldValue -eq "") {
                    # No RP template → CREATE
                    $rpTemplateName = "$renderingName Parameters"
                    $existingRp = Get-Item -Path "master:$rpFolderPath/$rpTemplateName" -ErrorAction SilentlyContinue
                    $rpTemplate = if ($existingRp) { $existingRp } else {
                        New-Item -Path "master:$rpFolderPath" -Name $rpTemplateName -ItemType "System/Templates/Template"
                    }
                    $rpTemplate."__Base template" = ($requiredBases -join "|")
                    $rendering."Parameters Template" = $rpTemplate.ID.ToString()

                    $rpCreated.Add([PSCustomObject]@{
                        RenderingName  = $renderingName
                        RenderingId    = $rendering.ID.ToString()
                        RpTemplateName = $rpTemplateName
                        RpTemplateId   = $rpTemplate.ID.ToString()
                    }) | Out-Null
                } else {
                    # Existing RP template → CHECK bases
                    $rpTemplate = Get-Item -Path "master:" -ID $rpFieldValue -ErrorAction SilentlyContinue
                    if (-not $rpTemplate) {
                        $errors.Add([PSCustomObject]@{
                            RenderingName = $renderingName
                            Step  = "RP"
                            Error = "Parameters Template points to missing item: $rpFieldValue"
                        }) | Out-Null
                        continue
                    }

                    $currentBases = @()
                    $basesVal = $rpTemplate."__Base template"
                    if ($basesVal -and $basesVal -ne "") {
                        $currentBases = @($basesVal.Split("|") | Where-Object { $_ -ne "" })
                    }
                    $missingBases = @($requiredBases | Where-Object { $currentBases -notcontains $_ })

                    if ($missingBases.Count -eq 0) {
                        $rpAlreadyOk.Add([PSCustomObject]@{
                            RenderingName = $renderingName
                            RenderingId   = $rendering.ID.ToString()
                            RpTemplateId  = $rpTemplate.ID.ToString()
                        }) | Out-Null
                    } else {
                        $newBases = @($currentBases) + @($missingBases)
                        $rpTemplate."__Base template" = ($newBases -join "|")
                        $rpUpdated.Add([PSCustomObject]@{
                            RenderingName = $renderingName
                            RenderingId   = $rendering.ID.ToString()
                            RpTemplateId  = $rpTemplate.ID.ToString()
                            AddedBases    = $missingBases
                        }) | Out-Null
                    }
                }

                # ══════════════════════════════════════════════════════════════
                # STEP 2: Dynamic placeholder infrastructure
                # ══════════════════════════════════════════════════════════════
                # Read the Placeholders (Layout Service Placeholders) field
                $phFieldValue = $rendering.Fields[$placeholdersFieldId].Value
                if (-not $phFieldValue -or $phFieldValue -eq "") { continue }

                # Parse pipe-delimited PS item GUIDs
                $psGuids = @($phFieldValue.Split("|") | Where-Object { $_ -ne "" })
                if ($psGuids.Count -eq 0) { continue }

                $wildcardIds    = [System.Collections.ArrayList]@()
                $needsFieldUpdate = $false

                foreach ($psGuid in $psGuids) {
                    $psItem = Get-Item -Path "master:" -ID $psGuid -ErrorAction SilentlyContinue
                    if (-not $psItem) {
                        $errors.Add([PSCustomObject]@{
                            RenderingName = $renderingName
                            Step  = "DynPH"
                            Error = "Placeholder Settings item not found: $psGuid"
                        }) | Out-Null
                        continue
                    }

                    # Skip items that are already wildcards (created by previous runs)
                    if ($psItem.Name -match '-wildcard$') { continue }

                    $baseName = $psItem["Placeholder Key"]
                    if (-not $baseName -or $baseName -eq "") {
                        # Fall back to item name as the key
                        $baseName = $psItem.Name
                    }

                    # Check if a wildcard sibling already exists
                    $parentPath    = $psItem.Parent.Paths.FullPath
                    $wildcardName  = "$baseName-wildcard"
                    $wildcardPath  = "master:$parentPath/$wildcardName"
                    $existingWc    = Get-Item -Path $wildcardPath -ErrorAction SilentlyContinue

                    if ($existingWc) {
                        # Already exists — just collect its ID
                        $wildcardIds.Add($existingWc.ID.ToString()) | Out-Null
                        $dpAlreadyOk.Add([PSCustomObject]@{
                            RenderingName = $renderingName
                            BaseName      = $baseName
                            WildcardId    = $existingWc.ID.ToString()
                        }) | Out-Null
                    } else {
                        # Create wildcard sibling from same template as the source PS item
                        $wcItem = New-Item -Path "master:$parentPath" -Name $wildcardName -ItemType $psItem.TemplateID.ToString()

                        # Set the Placeholder Key to {baseName}-{*}
                        $wcItem."Placeholder Key" = "$baseName-{*}"

                        # Copy Allowed Controls from the source PS item
                        $allowedControls = $psItem["Allowed Controls"]
                        if ($allowedControls -and $allowedControls -ne "") {
                            $wcItem."Allowed Controls" = $allowedControls
                        }

                        $wildcardIds.Add($wcItem.ID.ToString()) | Out-Null
                        $dpCreated.Add([PSCustomObject]@{
                            RenderingName   = $renderingName
                            BaseName        = $baseName
                            WildcardName    = $wildcardName
                            WildcardKey     = "$baseName-{*}"
                            WildcardId      = $wcItem.ID.ToString()
                            WildcardPath    = $wcItem.Paths.FullPath
                            SourcePsId      = $psGuid
                        }) | Out-Null
                    }
                }

                # Update the Placeholders field: keep originals + add wildcard IDs
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

                # Set OtherProperties flag: IsRenderingsWithDynamicPlaceholders=true
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
                    # else: flag already present, skip
                }

            } catch {
                $errors.Add([PSCustomObject]@{
                    RenderingName = $renderingName
                    Step  = "unknown"
                    Error = $_.Exception.Message
                }) | Out-Null
            }
        }

        # ═══ COMPONENT NAME SPACE STRIPPING (Step 3) ═════════════════════════
        # ⚠ SYNC: This logic is duplicated in xmc-register-rendering-folders.ps1.
        # Strips whitespace from "Component Name" so componentName matches component map keys.
        $cnUpdated   = [System.Collections.ArrayList]@()
        $cnAlreadyOk = [System.Collections.ArrayList]@()

        foreach ($rendering in $renderings) {
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

        $folderResults.Add([PSCustomObject]@{
            FolderPath        = $curFolder.Paths.FullPath
            Layer             = $curLayer
            ModulePath        = $curModPath
            RenderingsScanned = $renderings.Count
            RpCreated         = @($rpCreated)
            RpUpdated         = @($rpUpdated)
            RpAlreadyOk       = @($rpAlreadyOk)
            DpCreated         = @($dpCreated)
            DpAlreadyOk       = @($dpAlreadyOk)
            CnUpdated         = @($cnUpdated)
            CnAlreadyOk       = @($cnAlreadyOk)
            Errors            = @($errors)
        }) | Out-Null
    }

    # ─── Aggregate stats ──────────────────────────────────────────────────────
    $totalRenderings = ($folderResults | Measure-Object -Property RenderingsScanned -Sum).Sum
    $totalRpCreated  = ($folderResults | ForEach-Object { $_.RpCreated.Count } | Measure-Object -Sum).Sum
    $totalRpUpdated  = ($folderResults | ForEach-Object { $_.RpUpdated.Count } | Measure-Object -Sum).Sum
    $totalDpCreated  = ($folderResults | ForEach-Object { $_.DpCreated.Count } | Measure-Object -Sum).Sum
    $totalCnUpdated  = ($folderResults | ForEach-Object { $_.CnUpdated.Count } | Measure-Object -Sum).Sum
    $totalErrors     = ($folderResults | ForEach-Object { $_.Errors.Count } | Measure-Object -Sum).Sum

    [PSCustomObject]@{
        Status             = "ok"
        FoldersProcessed   = $folderResults.Count
        TotalRenderings    = $totalRenderings
        TotalRpCreated     = $totalRpCreated
        TotalRpUpdated     = $totalRpUpdated
        TotalDpCreated     = $totalDpCreated
        TotalCnUpdated     = $totalCnUpdated
        TotalErrors        = $totalErrors
        Folders            = @($folderResults)
    } | ConvertTo-Json -Depth 7

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 3
}
