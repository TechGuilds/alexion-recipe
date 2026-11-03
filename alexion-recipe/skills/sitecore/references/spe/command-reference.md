# SPE command reference (index)

Quick-lookup index of the SPE cmdlets you'll reach for. **149 cmdlets** ship across 7 categories; this lists the high-frequency ones. For full parameter syntax/variants, consult the bundled docs at `apps/sitecore-mcp-server/src/tools/powershell/documentation/<category>/<command>.md` (native `read` — no agent here is granted a docs-lookup tool). Pair with `best-practices.md` (how to write correctly) and `query-templates.md` (query patterns).

## Item & template
`Get-Item` (**most important** — SPE-wrapped, has the property adapter), `Get-ChildItem`, `New-Item`, `Remove-Item`, `Copy-Item`, `Move-Item`, `Rename-Item`; `Get-ItemField`, `Get-ItemTemplate`, `Set-ItemTemplate`, `Add-BaseTemplate`/`Remove-BaseTemplate`/`Test-BaseTemplate`; `Get-ItemReference`/`Get-ItemReferrer`/`Update-ItemReferrer`; `Get-Database`. Versions/languages: `Add-ItemVersion`, `Remove-ItemVersion`, `Get-ItemClone`/`New-ItemClone`.

## Presentation
`Get-Layout`, `Set-Layout`, `Get-Rendering` (`-FinalLayout`), `Add-Rendering`, `Set-Rendering`, `Remove-Rendering`, `Get-Placeholder`. (SXA-specific functions like `Add-SiteModule`, `Get-PageDesignsItem` are `Import-Function`ed — see `spe-script-library` / the SXA scripts.)

## Publishing
`Publish-Item`, `Get-ItemPublishingState`. (For the recipe, prefer the `xmc-publish` REST tool for XM Cloud publishing.)

## Security
`Get-User`/`New-User`/`Set-User`, `Get-Role`/`New-Role`, `Add-RoleMember`, `Get-ItemAcl`/`Add-ItemAcl` (used by Setup for the SPE-remoting role/user prereqs).

## Packaging
`Export-Package`, `Import-Package`, `Install-Package`, `New-Package` (the `install-package` tool wraps these for HS install).

## Indexing / search
`Find-Item` (indexed search — `-Criteria`, `-FacetOn`; returns `SearchResultItem`, always `| Initialize-Item`), `Initialize-Item`, `Get-SearchIndex`, `Initialize-SearchIndex`.

## Session / misc
`Import-Function` (load an SXA/JSS SXA function before calling it), `Get-ScriptSession`, `Receive-Job`, `Show-Result`. Utility: `ConvertTo-Json` (only for nested output — flat objects auto-serialize).

## Usage
1. Scan for the right cmdlet. 2. `read` the full doc when you need exact params/variants. 3. Verify signatures via `best-practices.md` gotchas (Get-Item vs `$db.GetItem()`, `New-Item -Path`=parent, no `param()`).
