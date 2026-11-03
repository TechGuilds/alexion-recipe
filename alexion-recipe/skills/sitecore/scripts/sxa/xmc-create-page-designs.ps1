<#
.INJECTED_VARIABLES
  $sitePath        [string] - Full Sitecore path to the site (e.g. "/sitecore/content/tenant/site")
  $pageDesignsJson [string] - JSON array of page design specs:
    [{ "name": "Content Page", "partialDesignNames": ["Header","Footer"], "templateIds": ["{guid1}"] },
     { "name": "Standalone", "partialDesignNames": ["Header"], "templateIds": [] }]
    Each entry: name (required), partialDesignNames (required array), templateIds (required array, empty = no mapping).
#>
$ErrorActionPreference = "Stop"

$globalDebug = [System.Collections.ArrayList]::new()

try {
    Set-Location "master:/sitecore"

    # ── Constants ──
    $pageDesignTplId = "{1105B8F8-1E00-426B-BF1F-C840742D827B}"   # Page Design template
    [void]$globalDebug.Add("ErrorActionPreference=$ErrorActionPreference")

    # ── Parse input array ──
    $specs = $pageDesignsJson | ConvertFrom-Json
    if (-not $specs -or $specs.Count -eq 0) {
        throw "pageDesignsJson is empty or invalid"
    }
    $specs = @($specs)
    [void]$globalDebug.Add("Received $($specs.Count) page design spec(s)")

    # ── Validate site exists ──
    $site = Get-Item -Path "master:$sitePath" -ErrorAction SilentlyContinue
    if (-not $site) {
        throw "Site not found at $sitePath"
    }
    [void]$globalDebug.Add("Site found: $($site.Name)")

    # ── Validate Page Designs folder exists ──
    $pageDesignFolder = Get-Item -Path "master:$sitePath/Presentation/Page Designs" -ErrorAction SilentlyContinue
    if (-not $pageDesignFolder) {
        throw "Page Designs folder not found at $sitePath/Presentation/Page Designs"
    }

    # ── Validate Partial Designs folder exists ──
    $partialDesignFolder = Get-Item -Path "master:$sitePath/Presentation/Partial Designs" -ErrorAction SilentlyContinue
    if (-not $partialDesignFolder) {
        throw "Partial Designs folder not found at $sitePath/Presentation/Partial Designs"
    }

    # ── Pre-validation: detect duplicate templateIds across entries ──
    # Normalize GUIDs: ensure braces, uppercase, standard format
    $allTemplateIds = [System.Collections.ArrayList]::new()
    $duplicateTemplateIds = [System.Collections.ArrayList]::new()
    foreach ($spec in $specs) {
        $tids = @($spec.templateIds)
        for ($ti = 0; $ti -lt $tids.Count; $ti++) {
            $tid = $tids[$ti]
            if ([string]::IsNullOrWhiteSpace($tid)) { continue }
            $tid = $tid.Trim().ToUpperInvariant() -replace '[{}]', ''
            if ($tid.Length -eq 32 -and $tid -notmatch '-') {
                $tid = $tid.Substring(0,8) + '-' + $tid.Substring(8,4) + '-' + $tid.Substring(12,4) + '-' + $tid.Substring(16,4) + '-' + $tid.Substring(20,12)
            }
            $tid = "{$tid}"
            $tids[$ti] = $tid
            if ($allTemplateIds -contains $tid) {
                if ($duplicateTemplateIds -notcontains $tid) {
                    [void]$duplicateTemplateIds.Add($tid)
                }
            } else {
                [void]$allTemplateIds.Add($tid)
            }
        }
        $spec.templateIds = $tids
    }
    if ($duplicateTemplateIds.Count -gt 0) {
        throw "Duplicate templateIds found across page design entries: $($duplicateTemplateIds -join ', '). Each template can only be mapped to one Page Design."
    }
    [void]$globalDebug.Add("Pre-validation passed: $($allTemplateIds.Count) unique template IDs, 0 duplicates")

    # ── Pre-validation: verify all referenced PD names exist ──
    $allPdNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($spec in $specs) {
        foreach ($pdName in @($spec.partialDesignNames)) {
            [void]$allPdNames.Add($pdName)
        }
    }
    $missingPds = [System.Collections.ArrayList]::new()
    foreach ($pdName in $allPdNames) {
        $pdPath = if ($pdName.StartsWith("/")) {
            "master:$sitePath/Presentation/Partial Designs$pdName"
        } else {
            "master:$sitePath/Presentation/Partial Designs/$pdName"
        }
        $pdItem = Get-Item -Path $pdPath -ErrorAction SilentlyContinue
        # If not found, try sanitized item name (PD may have been created with ProposeValidItemName)
        if (-not $pdItem) {
            $sanitizedPdn = [Sitecore.Data.Items.ItemUtil]::ProposeValidItemName($pdName)
            if ($sanitizedPdn -ne $pdName) {
                $pdPath2 = "master:$sitePath/Presentation/Partial Designs/$sanitizedPdn"
                $pdItem = Get-Item -Path $pdPath2 -ErrorAction SilentlyContinue
            }
        }
        if (-not $pdItem) {
            [void]$missingPds.Add($pdName)
        }
    }
    if ($missingPds.Count -gt 0) {
        throw "Partial Design(s) not found: $($missingPds -join ', '). Create them first with xmc-create-partial-designs."
    }
    [void]$globalDebug.Add("Pre-validation passed: all $($allPdNames.Count) referenced Partial Design names exist")

    # ── Results tracking ──
    $results = [System.Collections.ArrayList]::new()
    $errors = [System.Collections.ArrayList]::new()
    $totalCreated = 0
    $totalAlreadyExisted = 0
    $totalFailed = 0

    # ── Collect all template→Page Design mappings for atomic write at end ──
    $templateMappings = @{}   # templateId → pageDesignGuid

    # ──────────────────────────────────────────────────────────────────────────
    # Main loop: create each Page Design sequentially
    # ──────────────────────────────────────────────────────────────────────────
    foreach ($spec in $specs) {
        $pdName = $spec.name
        $debugLines = [System.Collections.ArrayList]::new()

        try {
            # ── Validate item name (F70/F102: use sanitized name, set display name if different) ──
            $itemName = [Sitecore.Data.Items.ItemUtil]::ProposeValidItemName($pdName)
            if ($itemName -ne $pdName) {
                [void]$debugLines.Add("Sanitized item name: '$pdName' -> '$itemName' (display name preserved)")
            }

            # ── Idempotency: check if Page Design already exists (try both sanitized and original name) ──
            $existingPD = Get-Item -Path "master:$sitePath/Presentation/Page Designs/$itemName" -ErrorAction SilentlyContinue
            if (-not $existingPD -and $itemName -ne $pdName) {
                $existingPD = Get-Item -Path "master:$sitePath/Presentation/Page Designs/$pdName" -ErrorAction SilentlyContinue
            }
            $created = $false

            if ($existingPD) {
                [void]$debugLines.Add("Page Design '$itemName' already exists — will update PartialDesigns field")
                $pageDesign = $existingPD
            } else {
                $pageDesign = New-Item -Path "master:$sitePath/Presentation/Page Designs/$itemName" -ItemType $pageDesignTplId -Language "en"
                if (-not $pageDesign) {
                    throw "Failed to create Page Design at $sitePath/Presentation/Page Designs/$itemName"
                }
                $created = $true
                [void]$debugLines.Add("Created Page Design '$itemName'")
                # Set display name if it differs from item name
                if ($itemName -ne $pdName) {
                    $pageDesign.Editing.BeginEdit()
                    $pageDesign.Fields["__Display name"].Value = $pdName
                    $pageDesign.Editing.EndEdit() | Out-Null
                    [void]$debugLines.Add("Set display name to '$pdName'")
                }
            }

            # ── Wire PartialDesigns field ──
            $partialDesignGuids = @()
            $pdNames = @($spec.partialDesignNames)

            foreach ($pdn in $pdNames) {
                $pdPath = if ($pdn.StartsWith("/")) {
                    "master:$sitePath/Presentation/Partial Designs$pdn"
                } else {
                    "master:$sitePath/Presentation/Partial Designs/$pdn"
                }
                $pdItem = Get-Item -Path $pdPath -ErrorAction SilentlyContinue
                # If not found, try sanitized item name (PD may have been created with ProposeValidItemName)
                if (-not $pdItem) {
                    $sanitizedPdn = [Sitecore.Data.Items.ItemUtil]::ProposeValidItemName($pdn)
                    if ($sanitizedPdn -ne $pdn) {
                        $pdPath2 = "master:$sitePath/Presentation/Partial Designs/$sanitizedPdn"
                        $pdItem = Get-Item -Path $pdPath2 -ErrorAction SilentlyContinue
                        if ($pdItem) {
                            [void]$debugLines.Add("Resolved PD '$pdn' via sanitized name '$sanitizedPdn'")
                        }
                    }
                }
                if ($pdItem) {
                    $partialDesignGuids += $pdItem.ID.ToString()
                    [void]$debugLines.Add("Resolved PD '$pdn' → $($pdItem.ID)")
                } else {
                    # Shouldn't happen — we pre-validated — but handle gracefully
                    [void]$debugLines.Add("WARNING: PD '$pdn' not found (passed pre-validation but missing now)")
                }
            }

            # Write PartialDesigns field using BeginEdit/EndEdit
            # CRITICAL: Use -join, NOT [System.String]::Join (ArrayList bug)
            $joinedIds = $partialDesignGuids -join '|'
            $pageDesign.Editing.BeginEdit()
            $pageDesign.Fields["PartialDesigns"].Value = $joinedIds
            $pageDesign.Editing.EndEdit()
            [void]$debugLines.Add("Wired $($partialDesignGuids.Count) Partial Design(s)")

            # ── Collect template mappings for this Page Design ──
            $templateGuids = @($spec.templateIds)
            $mappedCount = 0
            foreach ($tplId in $templateGuids) {
                if (-not [string]::IsNullOrWhiteSpace($tplId)) {
                    $templateMappings[$tplId] = $pageDesign.ID.ToString()
                    $mappedCount++
                }
            }
            [void]$debugLines.Add("Queued $mappedCount template mapping(s) for atomic write")

            # ── Record success ──
            $action = if ($created) { "created" } else { "already_exists" }
            if ($created) { $totalCreated++ } else { $totalAlreadyExisted++ }

            [void]$results.Add([PSCustomObject]@{
                name                = $pdName
                itemName            = $itemName
                id                  = $pageDesign.ID.ToString()
                path                = $pageDesign.Paths.FullPath
                action              = $action
                partialDesignsWired = $partialDesignGuids.Count
                templatesMapped     = $mappedCount
                debug               = @($debugLines)
            })
        }
        catch {
            $totalFailed++
            [void]$errors.Add([PSCustomObject]@{
                name    = $pdName
                error   = "CreateFailed"
                message = $_.Exception.Message
            })
            [void]$globalDebug.Add("ERROR processing '$pdName': $($_.Exception.Message)")
        }
    }

    # ──────────────────────────────────────────────────────────────────────────
    # Atomic TemplatesMapping write — single write after ALL Page Designs created (F96 fix)
    # ──────────────────────────────────────────────────────────────────────────
    $totalTemplatesMapped = 0
    $templatesMappingString = ""

    if ($templateMappings.Count -gt 0) {
        [void]$globalDebug.Add("Writing TemplatesMapping atomically: $($templateMappings.Count) entries")

        # Sort entries by template name for consistent, readable UI ordering
        $sortedEntries = @($templateMappings.GetEnumerator() | ForEach-Object {
            $tplItem = Get-Item -Path "master:" -ID $_.Key -ErrorAction SilentlyContinue
            $tplName = if ($tplItem) { $tplItem.Name } else { $_.Key }
            [PSCustomObject]@{ Key = $_.Key; Value = $_.Value; Name = $tplName }
        } | Sort-Object -Property Name)

        # Build UrlString map from scratch (clean write — does not preserve stale entries)
        $map = [Sitecore.Text.UrlString]::new()
        foreach ($entry in $sortedEntries) {
            $map[$entry.Key] = $entry.Value
            $totalTemplatesMapped++
        }

        # Write atomically via property setter (single operation)
        $templatesMappingString = $map.toString()
        $pageDesignFolder.TemplatesMapping = $templatesMappingString
        [void]$globalDebug.Add("TemplatesMapping written: $totalTemplatesMapped entries")
    } else {
        [void]$globalDebug.Add("No template mappings to write")
    }

    # ── Final output ──
    $status = if ($totalFailed -eq 0) { "success" } elseif ($totalCreated -gt 0 -or $totalAlreadyExisted -gt 0) { "partial" } else { "error" }

    [PSCustomObject]@{
        Status              = $status
        TotalRequested      = $specs.Count
        TotalCreated        = $totalCreated
        TotalAlreadyExisted = $totalAlreadyExisted
        TotalFailed         = $totalFailed
        TemplatesMapped     = $totalTemplatesMapped
        TemplatesMapping    = $templatesMappingString
        PageDesigns         = @($results)
        Errors              = @($errors)
        Debug               = @($globalDebug)
    } | ConvertTo-Json -Depth 6
}
catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = @($globalDebug)
    } | ConvertTo-Json -Depth 6
}
