# SPE item-operation scripts (`run-powershell-script`)

Item-level SPE ops relocated from the former `powershell-get-item` / `powershell-delete-item` / `sitecore-move-item` / `scan-path-references` / `sitecore-clear-caches` / `get-rendering-source-keys` MCP tools. Run via `run-powershell-script` on the correct connector (`source-sitecore` to inspect the XP source; `target-sitecore` to inspect/mutate the target), params from each script's `.INJECTED_VARIABLES` header, poll `get-tool-results`.

| Script | Purpose | Referenced by |
|---|---|---|
| `get-item.ps1` | read an item by ID/path (SPE; bypasses cache) | `references/serialization/error-recovery.md` (duplicate diagnosis by **ID**), `references/spe/*` |
| `delete-item.ps1` | delete an item by ID (HITL-confirmed) | `error-recovery.md` §6b (target `NonUniquePathException`) |
| `sitecore-move-item.ps1` | move an item in the tree | SXA adoption / cleanup |
| `scan-path-references.ps1` | find references to a path (before move/delete) | adoption path-reference fixes |
| `sitecore-clear-caches.ps1` | clear item caches | shared-data safety / post-write refresh |
| `get-rendering-source-keys.ps1` | read a rendering's datasource/source keys | discovery / presentation analysis |
| `audit-serialization-coverage.ps1` | read-only aggregate target-root count reconciliation | Content Migration terminal audit |
| `detect-duplicate-items.ps1` | find duplicate items (same parent + name) with created/link detail; `mode: "count"` for the verify-clean probe | `references/serialization/health-check.md` (pre-pull health check) |
| `remediate-duplicate-items.ps1` | execute one approved DELETE/RENAME batch (**max 5** actions) | `references/serialization/health-check.md` |

> Prefer the REST `get-item` tool for a simple lookup; use these SPE scripts when SPE is the available/needed transport (verified from the current connector capability catalog) or for the specific ops above. For duplicate diagnosis, **always query by ID, never path**.
