# Capture source baseline

Record confirmed site, routes, languages, versions, devices/personalization where relevant, source revision and capture time. Separate full inventory from representative rendering samples.

Capture source HTML/screenshots and meaningful interaction states with an available browser; capture layout/data responses through the authenticated source connector. Preserve source entity IDs, relationships and composition order. Platform-rendered payloads, static item records and reconstructed output have different semantics; label them.

Store large exports as files with manifest and scope metadata. Track pagination, requested/succeeded/failed counts and missing routes. Do not call a sample complete-site coverage. Never reuse a stale baseline after scope or source changes without noting it.

Output: evidence files plus an inventory reference. No workflow writes from capture scripts. Use the active platform profile's capture and normalization procedures. Verify instance compatibility, manifests and completeness; local fixtures do not prove remote success.
