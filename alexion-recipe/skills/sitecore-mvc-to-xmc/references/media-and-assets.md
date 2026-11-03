# Media and asset migration

Inventory media referenced by image/link fields, rich text, Razor URLs, CSS url(), bundles and scripts. Preserve source item IDs/paths and distinguish Sitecore media from repository assets and external providers.

For each reference record source URL, target mapping, language/version if relevant, alt text, dimensions, crop/query parameters and cache behavior. Do not derive a public URL from an item name; preserve a verified delivery URL or an explicit route/media mapping.

Delegate content transfer and publishing to sitecore. Copy repository assets only into the target tree, preserving case-sensitive paths and licenses. Do not rewrite the source baseline. Keep authenticated/private media private.

Validate representative target responses, MIME types, broken links, image layout and responsive variants. Compare rich-text embedded assets as well as top-level fields. Missing binaries, provider credentials or unsupported transforms stay in the evidence gap list, with an owner; changing a URL string alone does not complete migration.
