# Rendering catalog analysis

Use [rendering preview flow](rendering-preview-flow.md) for inventory, selection,
native capture-plan approval, mapping and preview ordering. Inventory configured
source presentation first; include referenced definitions plus the user's exact
additional rendering roots. No runtime route cap limits the definition inventory.

Read source rendering items under the scoped layout/rendering roots using `inspect-renderings` through [request composition](../../scripts/analysis/README.md). Pass exact ItemPaths and opt into Recurse only for approved roots. It preserves raw configuration values and absent fields; it does not guess template/resolver joins or mark definitions as used.

Capture item ID/path/template, rendering type, component name, Controller/Action or view Path, datasource template/location, parameters template, rendering contents resolver and caching settings. Preserve raw IDs and names; normalization for code registration is a separate explicit map with collision detection.

Join repository files using item configuration, not a name similarity guess. For JSS inspect exports and registration; for MVC use [source inspection](../mvc/scan-razor-source.md). Distinguish missing source, unresolved path, unsupported WebForms and truly unused renderings.

Output the catalog and per-rendering evidence, with scoped roots, pagination/completion, missing fields and unresolved joins. Rendering definitions are not usage evidence: join [layout and usage](layout-and-usage.md) before the hub classifies coverage or excludes anything.

The collector scans the site's `/Presentation/Rendering Variants` and preserves
observed variant selectors/configurations from presentation. It does not claim
complete `/Presentation/Headless Variants` coverage: separate Headless Variants
structures require an evidenced targeted read or an explicit limitation.
`RenderingRootsJson` enumerates definitions under `/sitecore/layout/Renderings`,
not variant folders. Structural-definition English fallback must not become
source-content language fallback.

Retain every observed rendering occurrence, configuration and variant separately
from the rendering+variant capture requirement identity. Unused definitions and
unused variants remain in the source mapping inventory. They have no real
captured page by default: select them explicitly for an approved synthetic fixture
only when requested, following [mapping contracts](../../scripts/mapping/README.md).
An unknown or partial usage result is not an unused classification.
