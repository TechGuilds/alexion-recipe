<#
.INJECTED_VARIABLES
  $siteItemPath        [string] - Sitecore path of site to adopt (optional if siteItemId provided)
  $siteItemId          [string] - GUID of site item (optional if siteItemPath provided)
  $tenantPath          [string] - Sitecore path to the Headless Tenant
  $pageTemplateIds     [string] - Pipe-delimited template IDs whose roots need tenant Page inheritance
  $updatePathReferences [string] - "true" | "false" — whether to SQL REPLACE path refs after move
#>
$ErrorActionPreference = "Stop"
Set-Location "master:/sitecore"

try {
    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $debug = @()
    $phases = @()

    $debug += "START: $(Get-Date -Format 'HH:mm:ss') siteItemPath=$siteItemPath siteItemId=$siteItemId tenantPath=$tenantPath"

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE A: Resolve items + Move site under tenant
    # ═══════════════════════════════════════════════════════════════════════════

    # ── Resolve site item ──
    $site = $null
    if ($siteItemId -and $siteItemId -ne "") {
        $site = $db.GetItem($siteItemId)
        if (-not $site) { throw "Site item not found for ID: $siteItemId" }
    } elseif ($siteItemPath -and $siteItemPath -ne "") {
        $site = Get-Item -Path "master:$siteItemPath" -ErrorAction SilentlyContinue
        if (-not $site) { throw "Site item not found at path: $siteItemPath" }
    } else {
        throw "Provide either siteItemPath or siteItemId."
    }

    # ── Resolve tenant item ──
    $tenant = Get-Item -Path "master:$tenantPath" -ErrorAction SilentlyContinue
    if (-not $tenant) { throw "Tenant not found at path: $tenantPath" }

    # Validate tenant is actually a Headless Tenant
    $tenantTemplateName = $tenant.TemplateName
    if ($tenantTemplateName -ne "Headless Tenant") {
        throw "Item at '$tenantPath' is template '$tenantTemplateName', not 'Headless Tenant'. Use xmc-ensure-collection to create a proper tenant."
    }
    $debug += "PA: tenant=$($tenant.Name) ($($tenant.ID)) template=$tenantTemplateName"

    # ── Invalidate stale path caches (WI-021 / SXA-003-D) ──
    # Content push restores ParentID in the Items table but does NOT invalidate
    # Sitecore's in-memory path caches. This can cause Paths.FullPath to return
    # a stale path from a prior adoption, making Move-Item fail with an error
    # referencing a path that no longer exists.
    $cachedPath = $site.Paths.FullPath
    $db.Caches.ItemPathsCache.InvalidateCache($site)
    $db.Caches.PathCache.RemoveMappingsContaining($site.ID)
    $db.Caches.ItemCache.RemoveItem($site.ID)
    $site = $db.GetItem($site.ID)  # re-fetch with fresh cache
    $freshPath = $site.Paths.FullPath
    if ($cachedPath -ne $freshPath) {
        $debug += "PA: CACHE-FIX stale path detected — was '$cachedPath', now '$freshPath'"
    }

    # ── Move if not already under tenant ──
    $originalPath = $site.Paths.FullPath
    $moved = $false
    $pathRefsUpdated = [ordered]@{ Shared = 0; Versioned = 0; Unversioned = 0 }

    if ($site.Parent.ID -eq $tenant.ID) {
        $debug += "PA: site already under tenant — skipping move"
    } else {
        $debug += "PA: moving $($site.Paths.FullPath) under $($tenant.Paths.FullPath)"
        $site.MoveTo($tenant)
        $site = $db.GetItem($site.ID)  # re-fetch at new location
        $moved = $true
        $debug += "PA: moved to $($site.Paths.FullPath)"

        # ── Update path references (SQL REPLACE) ──
        if ($updatePathReferences -eq "true") {
            $connStr = [Sitecore.Configuration.Settings]::GetConnectionString("master")

            function Invoke-PathReplace {
                param([string]$TableName, [string]$ConnStr, [string]$OldPath, [string]$NewPath)
                $conn = New-Object System.Data.SqlClient.SqlConnection($ConnStr)
                $cmd  = $conn.CreateCommand()
                $cmd.CommandTimeout = 600
                $cmd.CommandText = "UPDATE $TableName SET Value = REPLACE(Value, @oldPath, @newPath) WHERE Value LIKE @pattern"
                [void]$cmd.Parameters.AddWithValue("@oldPath", $OldPath)
                [void]$cmd.Parameters.AddWithValue("@newPath", $NewPath)
                [void]$cmd.Parameters.AddWithValue("@pattern", "%" + $OldPath + "%")
                $conn.Open()
                $affected = $cmd.ExecuteNonQuery()
                $conn.Close()
                $conn.Dispose()
                return $affected
            }

            function Invoke-PathReplaceEndOfValue {
                param([string]$TableName, [string]$ConnStr, [string]$OldPath, [string]$NewPath)
                $conn = New-Object System.Data.SqlClient.SqlConnection($ConnStr)
                $cmd  = $conn.CreateCommand()
                $cmd.CommandTimeout = 600
                $cmd.CommandText = @"
UPDATE $TableName
SET    Value = LEFT(Value, LEN(Value + 'X') - 1 - LEN(@oldPath + 'X') + 1) + @newPath
WHERE  RIGHT(Value, LEN(@oldPath + 'X') - 1) = @oldPath
"@
                [void]$cmd.Parameters.AddWithValue("@oldPath", $OldPath)
                [void]$cmd.Parameters.AddWithValue("@newPath", $NewPath)
                $conn.Open()
                $affected = $cmd.ExecuteNonQuery()
                $conn.Close()
                $conn.Dispose()
                return $affected
            }

            $delimiters = @("/", '"', "|", "'", "&", "<", " ")

            foreach ($delim in $delimiters) {
                $oldToken = $originalPath + $delim
                $newToken = $site.Paths.FullPath + $delim
                $pathRefsUpdated.Shared      += Invoke-PathReplace "SharedFields"      $connStr $oldToken $newToken
                $pathRefsUpdated.Versioned   += Invoke-PathReplace "VersionedFields"   $connStr $oldToken $newToken
                $pathRefsUpdated.Unversioned += Invoke-PathReplace "UnversionedFields" $connStr $oldToken $newToken
            }

            $pathRefsUpdated.Shared      += Invoke-PathReplaceEndOfValue "SharedFields"      $connStr $originalPath $site.Paths.FullPath
            $pathRefsUpdated.Versioned   += Invoke-PathReplaceEndOfValue "VersionedFields"   $connStr $originalPath $site.Paths.FullPath
            $pathRefsUpdated.Unversioned += Invoke-PathReplaceEndOfValue "UnversionedFields" $connStr $originalPath $site.Paths.FullPath

            $totalRefs = $pathRefsUpdated.Shared + $pathRefsUpdated.Versioned + $pathRefsUpdated.Unversioned
            $debug += "PA: pathRefsUpdated total=$totalRefs (S=$($pathRefsUpdated.Shared) V=$($pathRefsUpdated.Versioned) U=$($pathRefsUpdated.Unversioned))"
        }
    }

    $phases += "PhaseA:OK moved=$moved originalPath=$originalPath newPath=$($site.Paths.FullPath) pathRefs=$($pathRefsUpdated.Shared + $pathRefsUpdated.Versioned + $pathRefsUpdated.Unversioned)"

    # ═══════════════════════════════════════════════════════════════════════════
    # PHASE B: Patch page template __Base template to inherit tenant Page
    # ═══════════════════════════════════════════════════════════════════════════

    $templatesPatched = @()
    $templatesSkipped = @()
    $templatesFailed  = @()
    $templatesInherited = @()
    $rootsDiscovered = @()

    # ── Resolve the tenant's Page template ──
    $tenantTemplatesRootID = $tenant.Fields['Templates'].Value
    if (-not $tenantTemplatesRootID) {
        throw "Tenant '$($tenant.Name)' has no Templates field set. Was it created by xmc-ensure-collection?"
    }
    $tenantTemplatesRoot = $db.GetItem($tenantTemplatesRootID)
    if (-not $tenantTemplatesRoot) {
        throw "Tenant template root not found for ID $tenantTemplatesRootID"
    }

    # Find the tenant's Page template (inherits Foundation Base Page {47151711})
    $foundationBasePageId = [Sitecore.Data.ID]::Parse("{47151711-26CA-434E-8132-D3E0B7D26683}")
    $tenantPageTemplate = $null
    foreach ($tt in Get-ChildItem -Path $tenantTemplatesRoot.Paths.FullPath) {
        $tplObj = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($tt.TemplateID, $db)
        if ($tplObj -and $tplObj.InheritsFrom($foundationBasePageId)) {
            $tenantPageTemplate = $tt
            break
        }
    }

    if (-not $tenantPageTemplate) {
        $tenantPageTemplate = Get-ChildItem -Path $tenantTemplatesRoot.Paths.FullPath | Where-Object { $_.Name -eq "Page" } | Select-Object -First 1
    }

    if (-not $tenantPageTemplate) {
        $phases += "PhaseB:SKIP no tenant Page template found — page template patching skipped"
        $debug += "PB: WARN could not find tenant Page template under $($tenantTemplatesRoot.Paths.FullPath)"
    } else {
        $tenantPageTemplateId = $tenantPageTemplate.ID
        $debug += "PB: tenant Page template=$($tenantPageTemplate.Name) ($tenantPageTemplateId) at $($tenantPageTemplate.Paths.FullPath)"

        if ($pageTemplateIds -and $pageTemplateIds -ne "") {
            $ids = @($pageTemplateIds.Split("|") | ForEach-Object { $_.Trim() -replace '[{}]', '' } | Where-Object { $_ -ne '' })
            $debug += "PB: received $($ids.Count) page template IDs — walking inheritance to find roots"

            # ── Helper: walk __Base template chain to find the highest project-level ancestor ──
            # Returns the root template item (the one to patch) or $null if already inherits tenant Page.
            $standardTemplateId = [Sitecore.Data.ID]::Parse("{1930BBEB-7805-471A-A3BE-4858AC7CF696}")
            $visited = @{}  # cache: templateId -> root item (or "skip" or "system")

            function Find-ProjectRoot {
                param([Sitecore.Data.Items.Item]$TemplateItem, $Db, $TenantPageId, $StandardId, $FoundationBasePageId)

                $id = $TemplateItem.ID.ToString()
                if ($visited.ContainsKey($id)) { return $visited[$id] }

                # Prevent infinite loops
                $visited[$id] = $null

                # Already inherits tenant Page? Nothing to do.
                $tplObj = [Sitecore.Data.Managers.TemplateManager]::GetTemplate($TemplateItem.ID, $Db)
                if ($tplObj -and $tplObj.InheritsFrom($TenantPageId)) {
                    $visited[$id] = "skip"
                    return "skip"
                }

                # Is this a project template? (under /sitecore/templates/Project/)
                $isProject = $TemplateItem.Paths.FullPath -like "/sitecore/templates/Project/*"

                # Walk up: parse __Base template field for direct parents
                $baseField = $TemplateItem.Fields['__Base template'].Value
                if (-not $baseField) {
                    # No bases — if it's a project template, it IS the root
                    if ($isProject) { $visited[$id] = $TemplateItem; return $TemplateItem }
                    $visited[$id] = "system"
                    return "system"
                }

                $baseIds = @($baseField.Split("|") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

                # Walk each parent looking for the highest project-level ancestor
                $highestProjectAncestor = $null
                foreach ($baseId in $baseIds) {
                    $parentItem = $Db.GetItem($baseId)
                    if (-not $parentItem) { continue }
                    $parentSitecoreId = [Sitecore.Data.ID]::Parse($baseId)

                    # Skip Standard Template and Foundation Base Page (system templates)
                    if ($parentSitecoreId -eq $StandardId) { continue }
                    if ($parentSitecoreId -eq $FoundationBasePageId) { continue }

                    # Skip non-project templates (Foundation/Feature/System)
                    if ($parentItem.Paths.FullPath -notlike "/sitecore/templates/Project/*") { continue }

                    $parentRoot = Find-ProjectRoot -TemplateItem $parentItem -Db $Db -TenantPageId $TenantPageId -StandardId $StandardId -FoundationBasePageId $FoundationBasePageId
                    if ($parentRoot -eq "skip") {
                        # Parent already inherits tenant Page — this template is covered
                        $visited[$id] = "skip"
                        return "skip"
                    }
                    if ($parentRoot -ne $null -and $parentRoot -ne "system") {
                        $highestProjectAncestor = $parentRoot
                    }
                }

                if ($highestProjectAncestor) {
                    $visited[$id] = $highestProjectAncestor
                    return $highestProjectAncestor
                }

                # No project parent found — this template IS the root (if it's a project template)
                if ($isProject) {
                    $visited[$id] = $TemplateItem
                    return $TemplateItem
                }

                $visited[$id] = "system"
                return "system"
            }

            # ── Step 1: For each passed template, find its root ──
            $rootMap = @{}  # rootId -> root item
            foreach ($ptId in $ids) {
                try {
                    $ptItem = Get-Item -Path "master:" -ID $ptId -ErrorAction SilentlyContinue
                    if (-not $ptItem) {
                        $templatesFailed += "$ptId (not found)"
                        $debug += "PB: FAIL $ptId — item not found"
                        continue
                    }

                    $root = Find-ProjectRoot -TemplateItem $ptItem -Db $db -TenantPageId $tenantPageTemplateId -StandardId $standardTemplateId -FoundationBasePageId $foundationBasePageId

                    # Trace: what did Find-ProjectRoot return?
                    if ($root -and $root -ne "skip" -and $root -ne "system" -and $root -ne $null) {
                        $rootName = if ($root.Name) { $root.Name } else { "?" }
                        $rootGuid = if ($root.ID) { $root.ID.Guid.ToString("N").ToUpper() } else { "?" }
                        $debug += "PB: TRACE $($ptItem.Name) ($ptId) -> root=$rootName ($rootGuid)"
                    }

                    if ($root -eq "skip") {
                        $templatesSkipped += "$($ptItem.Name) ($ptId)"
                        $debug += "PB: SKIP $($ptItem.Name) ($ptId) — already inherits tenant Page"
                    } elseif ($root -ne $null -and $root -ne "system") {
                        $rootIdStr = $root.ID.Guid.ToString("N").ToUpper()
                        if (-not $rootMap.ContainsKey($rootIdStr)) {
                            $rootMap[$rootIdStr] = $root
                        }
                        if ($rootIdStr -ne ($ptItem.ID.Guid.ToString("N").ToUpper())) {
                            $templatesInherited += "$($ptItem.Name) ($ptId) via $($root.Name) ($rootIdStr)"
                            $debug += "PB: INHERIT $($ptItem.Name) ($ptId) — root is $($root.Name) ($rootIdStr)"
                        }
                    } else {
                        $debug += "PB: WARN $($ptItem.Name) ($ptId) — no project root found, skipping"
                    }
                } catch {
                    $templatesFailed += "$ptId ($($_.Exception.Message))"
                    $debug += "PB: ERROR resolving $ptId — $($_.Exception.Message)"
                }
            }

            $rootsDiscovered = @($rootMap.Keys)
            $debug += "PB: discovered $($rootsDiscovered.Count) unique root(s) to patch"

            # ── Step 2: Patch only the discovered roots ──
            foreach ($rootId in $rootsDiscovered) {
                try {
                    $rootItem = $rootMap[$rootId]

                    $baseField = $rootItem.Fields['__Base template'].Value
                    if ($baseField) {
                        $newBaseField = $baseField + "|" + $tenantPageTemplateId.ToString()
                    } else {
                        $newBaseField = $tenantPageTemplateId.ToString()
                    }

                    $rootItem.Editing.BeginEdit()
                    $rootItem.Fields['__Base template'].Value = $newBaseField
                    $rootItem.Editing.EndEdit() > $null

                    $templatesPatched += "$($rootItem.Name) ($rootId)"
                    $debug += "PB: PATCHED $($rootItem.Name) ($rootId) — added tenant Page $tenantPageTemplateId to __Base template"
                } catch {
                    $templatesFailed += "$rootId ($($_.Exception.Message))"
                    $debug += "PB: ERROR patching $rootId — $($_.Exception.Message)"
                }
            }
        } else {
            $debug += "PB: no pageTemplateIds provided — skipping template patching"
        }

        $phases += "PhaseB:OK roots=$($rootsDiscovered.Count) patched=$($templatesPatched.Count) inherited=$($templatesInherited.Count) skipped=$($templatesSkipped.Count) failed=$($templatesFailed.Count) tenantPage=$($tenantPageTemplate.Name)"
    }

    # ═══════════════════════════════════════════════════════════════════════════
    # Result
    # ═══════════════════════════════════════════════════════════════════════════
    [PSCustomObject]@{
        Status            = "ok"
        SiteId            = $site.ID.ToString()
        SitePath          = $site.Paths.FullPath
        OriginalPath      = $originalPath
        TenantId          = $tenant.ID.ToString()
        TenantPath        = $tenant.Paths.FullPath
        Moved             = $moved
        PathRefsUpdated   = $pathRefsUpdated
        TenantPageTemplate = if ($tenantPageTemplate) { "$($tenantPageTemplate.Name) ($($tenantPageTemplate.ID))" } else { "not found" }
        TemplatesPatched  = $templatesPatched
        TemplatesInherited = $templatesInherited
        TemplatesSkipped  = $templatesSkipped
        TemplatesFailed   = $templatesFailed
        RootsDiscovered   = @($rootsDiscovered | ForEach-Object { if ($rootMap.ContainsKey($_)) { "$($rootMap[$_].Name) ($_)" } else { $_ } })
        Phases            = $phases
        Debug             = $debug
    } | ConvertTo-Json -Depth 3

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = $debug
    } | ConvertTo-Json -Depth 3
}
