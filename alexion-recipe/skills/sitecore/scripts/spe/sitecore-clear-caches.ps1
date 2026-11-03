<#
.INJECTED_VARIABLES
  $database             [string] - Database name (default: "master")
  $clearItemCaches      [string] - "true" | "false" — clear item, data, path, standard-values caches
  $rebuildLinkDatabase  [string] - "true" | "false" — rebuild the link database (slow)
  $rebuildSearchIndex   [string] - "true" | "false" — rebuild a search index
  $searchIndexName      [string] - Index name to rebuild (e.g. "sitecore_master_index"). Required if rebuildSearchIndex is "true"
#>
$ErrorActionPreference = "Stop"

try {
    $dbName = if ($database -and $database -ne "") { $database } else { "master" }
    $db = [Sitecore.Configuration.Factory]::GetDatabase($dbName)
    if (-not $db) { throw "Database '$dbName' not found." }

    $debug = @()
    $cleared = @()

    # ─── Item Caches ──────────────────────────────────────────────────────────
    if ($clearItemCaches -eq "true") {
        $caches = $db.Caches
        if (-not $caches) { throw "Could not access caches for database '$dbName'." }

        # ItemCache
        if ($caches.ItemCache) {
            $caches.ItemCache.Clear()
            $cleared += "ItemCache"
            $debug += "Cleared ItemCache"
        }

        # DataCache
        if ($caches.DataCache) {
            $caches.DataCache.Clear()
            $cleared += "DataCache"
            $debug += "Cleared DataCache"
        }

        # StandardValuesCache
        if ($caches.StandardValuesCache) {
            $caches.StandardValuesCache.Clear()
            $cleared += "StandardValuesCache"
            $debug += "Cleared StandardValuesCache"
        }

        # PathCache
        if ($caches.PathCache) {
            $caches.PathCache.Clear()
            $cleared += "PathCache"
            $debug += "Cleared PathCache"
        }

        # PrefetchCache — may not exist on all Sitecore versions
        try {
            if ($caches.PrefetchCache) {
                $caches.PrefetchCache.Clear()
                $cleared += "PrefetchCache"
                $debug += "Cleared PrefetchCache"
            }
        } catch {
            $debug += "PrefetchCache not available on this version: $($_.Exception.Message)"
        }
    }

    # ─── Link Database Rebuild ────────────────────────────────────────────────
    $linkDbRebuilt = $false
    if ($rebuildLinkDatabase -eq "true") {
        $debug += "Starting link database rebuild for '$dbName'..."
        [Sitecore.Globals]::LinkDatabase.Rebuild($db)
        $linkDbRebuilt = $true
        $debug += "Link database rebuild complete."
    }

    # ─── Search Index Rebuild ─────────────────────────────────────────────────
    $searchIndexRebuilt = $false
    if ($rebuildSearchIndex -eq "true") {
        if (-not $searchIndexName -or $searchIndexName -eq "") {
            throw "searchIndexName is required when rebuildSearchIndex is true."
        }

        $index = [Sitecore.ContentSearch.ContentSearchManager]::GetIndex($searchIndexName)
        if (-not $index) { throw "Search index '$searchIndexName' not found." }

        $debug += "Starting search index rebuild for '$searchIndexName'..."
        $index.Rebuild()
        $searchIndexRebuilt = $true
        $debug += "Search index rebuild complete."
    }

    $result = [PSCustomObject]@{
        Status             = "success"
        Database           = $dbName
        CachesCleared      = $cleared
        LinkDbRebuilt      = $linkDbRebuilt
        SearchIndexRebuilt = $searchIndexRebuilt
        SearchIndexName    = if ($searchIndexRebuilt) { $searchIndexName } else { $null }
        Debug              = $debug
    }
    $result | ConvertTo-Json -Depth 5

} catch {
    [PSCustomObject]@{
        Status = "error"
        Error  = $_.Exception.Message
        Debug  = $debug
    } | ConvertTo-Json -Depth 5
}
