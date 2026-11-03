# Layout and usage inventory

Follow [rendering preview flow](rendering-preview-flow.md): source presentation
inventory precedes draft synthesis, included-rendering review and capture. Static
source analysis runs independently; runtime capture is not a prerequisite for it.

Enumerate pages under the verified source site root across the requested languages, versions and devices. Read both shared and final presentation and record inheritance; do not treat an empty final layout as no presentation.

For each occurrence record page ID/path, language/version/device, layout ID, rendering ID and UID, placeholder key, datasource, parameters, order and provenance (local, standard values, page design or partial design). Expand SXA design references with cycle detection. Keep raw presentation alongside the resolved view.

Join occurrences by rendering ID to the catalog. Count definitions and occurrences separately; one rendering can occur repeatedly on a page. Keep orphan references, dynamic datasource queries, personalization conditions and unresolved design references visible.

Cross-check representative source Layout Service captures. Static presentation XML cannot prove runtime resolver data or personalized behavior. Use `inspect-presentation` with explicit ItemPaths, Database, Languages, Version and Devices through [request composition](../../scripts/analysis/README.md). It retains shared/final XML and ordered SPE-resolved occurrences. SXA design references are retained but not flattened: successful extraction remains successful, while the separate design-dependency assessment stays incomplete until inspected and checked for cycles. Do not call that sample a complete presentation audit.

Return page-to-rendering mappings, usage totals, unvisited scope and representative routes for baseline capture. The hub owns exclusion decisions and task creation.

The native capture planner selects pages to cover included rendering+variant
requirements. Preserve placements, datasources, parameters and dependency facts
for comparison even though nonvariant parameter differences do not create new
capture requirements. Planner warnings and optimization bounds are findings,
not proof of runtime coverage or of a mathematically minimal plan. The result
processor verifies actual captured identities and hashes; name similarity or a
successful HTTP response does not prove the expected rendering was present.
Partial or capped captures cannot establish source absence or unused status.
