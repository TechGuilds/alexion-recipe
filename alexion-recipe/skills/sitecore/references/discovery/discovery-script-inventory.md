# Discovery executable inventory

This inventory maps the source discovery executables to their current recipe
destinations and separates collection from orchestration and optional enrichment.
It is a
coverage ledger, not a request to restore the removed Sitecore SDK or backend
tools.

Follow [rendering preview flow](rendering-preview-flow.md) for the current
inventory → draft synthesis → approved included-rendering scope → capture →
mapping → reviewed local preview sequence. Historical runner behavior in this
ledger describes provenance, not permission to capture unplanned routes.

## Core Discovery collector

| Source executable | Role in Discovery | Recipe destination | Status |
| --- | --- | --- | --- |
| `apps/sitecore-mcp-server/src/tools/analysis/ps/xp-discovery-v3.ps1` | Full XP site audit. Probes capabilities, walks the site with `.Axes.GetDescendants()`, analyzes page presentation, discovers used and unused renderings, datasource and parameter templates, resolver definitions, branch templates, template inheritance/fields, placeholder settings, XP-only dependencies, duplicate paths, serialization paths and SXA readiness. | `skills/sitecore/scripts/analysis/xp-discovery-v3.ps1` | Enhanced with explicit rendering roots, instances/variants, structural-definition language fallback, unresolved-reference diagnostics and complete mapping dependency metadata. The strict `kajoo-export` transport envelope remains unchanged. |

The collector must be run with `SiteRootPath`, verified `Database` and
`Language`, and `GenerateReports=true`. Its terminal export is the authoritative
Sitecore Discovery capture. The current recipe adapter records the original
files and hashes rather than fabricating normalized item/presentation rows; the
collector intentionally does not write `content-items.jsonl`.

The source inventory covers all configured presentation in the agreed content
scope before collecting referenced definitions and optional user-selected roots;
no capture limit truncates it. Ask the rendering-root yes/no question and obtain
exact full definition paths under `/sitecore/layout/Renderings` on yes. Pass
`RenderingRootsJson` only for those nonempty selected roots; omit it on no.
The exact parameter name and execution-request bytes are evidence. Structural
English fallback is limited to definitions, never source content. The collector
scans `/Presentation/Rendering Variants` and observed selectors; separate
`/Presentation/Headless Variants` structures need a targeted read or an explicit
coverage limitation, not a claim that rendering-root enumeration covered them.

## Runtime and staging support

These were application runtime modules, not remote scripts. Their behavior is
now supplied by the existing PowerShell connector, file-output manifest and
sandbox evidence tools; they must not be copied into a Sitecore skill as
TypeScript application code.

| Source module | Responsibility | Current recipe equivalent |
| --- | --- | --- |
| `apps/sitecore-mcp-server/src/tools/analysis/modes.ts` | Select `full-site-discovery-v3` and map scope to script variables. | Sitecore Discovery reference + `xp-discovery-v3.ps1` injected-variable contract. |
| `apps/sitecore-mcp-server/src/tools/analysis/analysis-run.ts`, `analysis-modes-info.ts`, `analysis-modes-list.ts`, `index.ts`, `types.ts` | Runtime catalog, request dispatch, mode metadata and result typing around the collector. | Current agent guidance, `source-sitecore/run-powershell-script`, `discovery-evidence-adapter.mjs` and task-result contract; no separate MCP wrapper is restored. |
| `apps/sitecore-mcp-server/src/tools/analysis/script-loader.ts` | Load the bundled PowerShell file and prepare variables. | Skill file read followed by `source-sitecore/run-powershell-script`; connector credentials never enter the script. |
| `apps/sitecore-mcp-server/src/libs/inngest/functions/utils/sitecore-analysis-run.ts` | Start/poll/receive one long-running SPE session. | Existing background PowerShell tool and automatic result resumption. |
| `apps/sitecore-mcp-server/src/libs/inngest/functions/utils/sitecore-analysis-run-orchestration.ts` | Resume-safe long-running orchestration and cleanup. | Current tool job lifecycle; the agent records run ID and terminal result. |
| `apps/sitecore-mcp-server/src/libs/inngest/functions/utils/stage-analysis-files.ts` | Download every returned file into scoped sandbox evidence. | Explicit `kajoo-export` file manifest plus terminal file transfer and adapter manifest. |

## Application-side Discovery runners reviewed

These release files were executable tool/orchestration implementations, not
portable scripts to paste into a sandbox. Their contracts are represented by
the current owning skills and native recipe executables below.

| Source runner | Discovery responsibility | Current recipe contract |
| --- | --- | --- |
| `apps/kajoo-mcp-server/src/tools/sitecore/fetch-and-deploy-headless-mock-layouts.ts` and its Inngest runner | Historical route enumeration, Layout Service capture and mock-layout delivery. | Approved-plan `prepare-capture-request.mjs` + `fetch-layouts.mjs`, explicit `process-capture-results.mjs`, then reviewed preview staging/installation; `export-layouts.ps1` remains a separately scoped normalized baseline. |
| `apps/kajoo-mcp-server/src/tools/sitecore/fetch-and-deploy-mvc-mock-layouts.ts` and `fetch-and-deploy-mvc-mock-dictionary.ts` | MVC layout/dictionary capture and delivery. | `sitecore/scripts/capture/capture-mock-layouts.ps1` and `capture-mock-dictionary.ps1` retain the source serializer/domain behavior; normalized `export-layouts.ps1`/`export-dictionary.ps1` remain available for the generic baseline contract. |
| `apps/kajoo-mcp-server/src/tools/sitecore/sitecore-export-richtext.ts` and its batch/finalize runners | Scoped rich-text evidence export. | `sitecore/scripts/capture/export-richtext.ps1`, optional and non-blocking. |
| `apps/kajoo-mcp-server/src/tools/migrations/migration-analyze-components.ts`, `migration-analyze-component-usage.ts`, `migration-analyze-layout.ts`, `migration-analyze-styles.ts` | Store-free and usage/layout/style source analysis. | `frontend-migration/scripts/analyze-source.mjs`, `analyze-usage.mjs`, `analyze-layout.mjs`, `analyze-styles.mjs` and `layouts/*.mjs`, dispatched by `frontend-developer`. |
| `apps/kajoo-mcp-server/src/tools/sandboxes/sandbox-analyze-sitecore-dotnet.ts` and its runner | Roslyn MVC source analysis and derived joins. | `sitecore/scripts/analysis/analyze-dotnet.mjs`, with `get-rendering-source-keys.ps1` catalog prerequisite. |

## Optional or non-core scripts

These are intentionally not part of the required whole-site collector. They
are retained as separate optional paths so a failed enrichment does not erase a
successful core Discovery result.

| Source script | Classification | Recipe handling |
| --- | --- | --- |
| `apps/sitecore-mcp-server/src/scripts/hotfix-discover-layouts.ps1` | Layout-template/serialization include enrichment, not the site-wide dependency collector. | `sitecore/scripts/analysis/hotfix-discover-layouts.ps1`, exposed as the `discover-layout-folders` prepared operation; the core collector's `serialization-config.json` and template/presentation reports remain preferred. Do not make it a Discovery gate by default. |
| `apps/sitecore-mcp-server/src/scripts/hotfix-check-layout-templates.ps1` | Setup/readiness check. | Setup skill/scripts, not Discovery. |
| `apps/sitecore-mcp-server/src/scripts/hotfix-upgrade-layout-templates.ps1` | Target mutation/remediation. | Explicit approved Setup remediation, never automatic Discovery. |
| `apps/kajoo-mcp-server/src/scripts/capture-mock-layouts.ps1` | Runtime/mock-layout enrichment for MVC visual verification, using the source serializer and route bundles. | `skills/sitecore/scripts/capture/capture-mock-layouts.ps1`; optional bounded capture after core collection. |
| `apps/kajoo-mcp-server/src/scripts/capture-mock-dictionary.ps1` | MVC dictionary-domain/key enrichment for mock i18n. | `skills/sitecore/scripts/capture/capture-mock-dictionary.ps1`; optional and non-blocking. |
| `apps/kajoo-mcp-server/src/scripts/export-richtext-structures.ps1` | Rendering/datasource-centered rich-text structure enrichment. | `skills/sitecore/scripts/capture/export-richtext-structures.ps1`; optional and non-blocking. |
| `apps/kajoo-mcp-server/src/scripts/get-rendering-source-keys.ps1` | MVC rendering catalog used to join Roslyn controllers/views/models and derive resolver/source-key evidence. | `sitecore/scripts/spe/get-rendering-source-keys.ps1`; run once before MVC `analyze-dotnet.mjs` when MVC code discovery is in scope and pass its JSON catalog via `--catalog`. A missing/failed catalog leaves raw Roslyn evidence but mapping/resolver coverage is explicitly skipped. |

## Code-discovery and layout-analysis sources

### Headless code-discovery order and completeness gate

Static source/layout/style analysis proceeds in parallel with content inventory.
It does not wait for runtime capture. The current recipe replaces the historical
sitemap-first prerequisite with the approved rendering/variant capture sequence
in [rendering preview flow](rendering-preview-flow.md). Usage analysis consumes
only the explicitly retained successful capture files after plan approval;
capped, skipped, partial or identity-unverified evidence retains its limitations
and cannot prove a rendering unused. The supported capture helper is
`sitecore/scripts/capture/fetch-layouts.mjs`. Retain its exact selected-page
result manifest, attempts, successes, failures, skipped routes and hashes.
Omitted `maxUrls` or `0` attempts all selected pages; positive values cap total
attempts across failures and declared recovery. Existing outputs cannot count
as new requests. Explicit matching capture results may be retained in the
processor's report set; neither worker should issue one GraphQL layout request
per route or create a fresh capture from stale directories.

These source modules are code-discovery inputs or analyzers rather than remote Sitecore content collectors. The current recipe keeps their behavior under the frontend-migration skill and the Sitecore pair guidance; they are not duplicated in the content collector.

| Source module or template | Discovery responsibility | Current recipe reference |
| --- | --- | --- |
| `packages/kajoo-sitecore/src/code/analysis/discovery-paths.ts`, `sitecore-component-analysis-reporting.service.ts`, `sitecore-component-analyzer.ts`, `sitecore-component-map-parser.service.ts` | Source file paths, component candidates and report shaping. | `frontend-migration/references/source-analysis.md`; `frontend-migration/scripts/analysis-files.mjs` and `analyze-layout.mjs`. |
| `packages/kajoo-sitecore/src/code/analysis/sitecore-layout-analyzer.ts`, `content-sdk-layout-analyzer.ts`, `layout-analyzer-with-scanner.interface.ts`, `sitecore-layout-json-analyzer.service.ts` | Layout/component-map parsing and layout JSON evidence. | `frontend-migration/scripts/layouts/` and `analyze-layout.mjs`. |
| `packages/kajoo-sitecore/src/code/analysis/jss-component-map-scanner.ts`, `content-sdk-component-map-scanner.ts`, detector modules under `code/analysis/detectors/` | JSS/Content SDK registration and source-signal detectors. | `frontend-migration/scripts/layouts/jss.mjs`, `content-sdk.mjs`, and `references/source-analysis.md`. |
| `packages/kajoo-sitecore/src/code/analysis/mvc-component-analysis.ts`, `mvc-component-analyzer.ts`, `mvc-component-usage-reporting.service.ts`, `mvc-discovery-artifacts.builder.ts`, `roslyn-analyzer.service.ts` | MVC/Razor semantic analysis and usage artifacts. | `sitecore/references/mvc/analysis.md`, `scan-razor-source.md`, and `sitecore/scripts/analysis/analyze-dotnet.mjs`. |
| `packages/kajoo-sitecore/src/code/migrations/xpheadless2sai/component-discovery-strategy.ts` and `xpmvc2sai/component-discovery-strategy.ts` | Migration-type-specific component discovery policy. | Pair-skill guidance; the coordinator invokes the frontend Discovery task and does not treat React count as rendering count. |
| `packages/kajoo-sitecore/src/code/migrations/xpheadless2sai/services/layout-fetcher-execution.service.ts`, `layout-fetcher-scaffolding.service.ts`, and `templates/fetch-layouts.template.txt` | Historical authenticated route-layout fetch/scaffold support. | `sitecore/scripts/capture/fetch-layouts.mjs` now consumes the approved selected-page request; the source connector supplies `SOURCE_SITECORE_GRAPHQL_API_KEY`. Legacy route enumeration remains a separately scoped diagnostic path. The whole-site collector and `export-layouts.ps1` remain separate content/bounded capture paths. |
| Current code-discovery executables | Portable source/layout/usage/style analysis, authenticated bounded layout capture and local verification. | `frontend-migration/scripts/analyze-source.mjs`, `analyze-usage.mjs`, `analyze-layout.mjs`, `analyze-styles.mjs`, `layouts/*.mjs`, `probe-render.mjs`; `sitecore/scripts/capture/fetch-layouts.mjs`; `sitecore/scripts/analysis/analyze-dotnet.mjs` for MVC semantic results. |

These modules are not content-discovery scripts: they must not replace the whole-site xp-discovery-v3 collector, and the content worker must not issue repeated GraphQL layout queries when a retained capture manifest already exists.

## Executable file checklist

The following is the complete set of source executable files/templates that
participated in Discovery or its optional evidence paths. Package TypeScript
analyzers and orchestration modules are listed above because they are libraries,
not scripts copied into a sandbox.

| Source executable/template | Discovery role | Current recipe location |
| --- | --- | --- |
| `apps/sitecore-mcp-server/src/tools/analysis/ps/xp-discovery-v3.ps1` | Required whole-site content/dependency collector. | `sitecore/scripts/analysis/xp-discovery-v3.ps1` |
| `apps/sitecore-mcp-server/src/scripts/hotfix-discover-layouts.ps1` | Optional layout-template discovery/hotfix evidence. | `sitecore/scripts/analysis/hotfix-discover-layouts.ps1`; prepared operation `discover-layout-folders`, not a default gate. |
| `apps/sitecore-mcp-server/src/scripts/hotfix-check-layout-templates.ps1` | Setup/readiness probe, not Discovery output. | `sitecore/scripts/setup/` guidance. |
| `apps/sitecore-mcp-server/src/scripts/hotfix-upgrade-layout-templates.ps1` | Explicit approved mutation, not an automatic Discovery action. | No automatic equivalent; use only an approved Sitecore remediation script. |
| `apps/kajoo-mcp-server/src/scripts/capture-mock-layouts.ps1` | Optional bounded visual/mock-layout capture. | `sitecore/scripts/capture/capture-mock-layouts.ps1`; `prepare-request.mjs` operation `capture-mock-layouts`. |
| `apps/kajoo-mcp-server/src/scripts/capture-mock-dictionary.ps1` | Optional MVC dictionary enrichment. | `sitecore/scripts/capture/capture-mock-dictionary.ps1`; `prepare-request.mjs` operation `capture-mock-dictionary`. |
| `apps/kajoo-mcp-server/src/scripts/export-richtext-structures.ps1` | Optional rich-text structure enrichment. | `sitecore/scripts/capture/export-richtext-structures.ps1`; `prepare-request.mjs` operation `export-richtext-structures`. |
| `apps/kajoo-mcp-server/src/scripts/get-rendering-source-keys.ps1` | MVC rendering source-key catalog prerequisite for derived Roslyn joins. | `sitecore/scripts/spe/get-rendering-source-keys.ps1`, dispatched through `source-sitecore/run-powershell-script`; pass the returned catalog to `analyze-dotnet.mjs --catalog`. |
| `packages/kajoo-sitecore/src/code/migrations/xpheadless2sai/templates/fetch-layouts.template.txt` (run as `fetch-layouts.ts`) | Code-side authenticated route-layout capture and mock fixture generation. | `sitecore/scripts/capture/fetch-layouts.mjs`. |

### Exact source-file ledger

The grouped tables above describe ownership; this ledger is the file-level
checklist used when reviewing a recipe update. A `reference` entry is an
application runner/library whose behavior is represented by a recipe script or
skill contract, not a file that should be copied into a sandbox.

| Release file | Kind | Current recipe location or reference |
| --- | --- | --- |
| `apps/sitecore-mcp-server/src/tools/analysis/ps/xp-discovery-v3.ps1` | remote PowerShell collector | `skills/sitecore/scripts/analysis/xp-discovery-v3.ps1` |
| `apps/sitecore-mcp-server/src/scripts/hotfix-discover-layouts.ps1` | remote PowerShell optional layout-folder enrichment | `skills/sitecore/scripts/analysis/hotfix-discover-layouts.ps1`; core collector reports are preferred |
| `apps/kajoo-mcp-server/src/scripts/capture-mock-layouts.ps1` | remote PowerShell MVC serializer capture | `skills/sitecore/scripts/capture/capture-mock-layouts.ps1` |
| `apps/kajoo-mcp-server/src/scripts/capture-mock-dictionary.ps1` | remote PowerShell MVC dictionary capture | `skills/sitecore/scripts/capture/capture-mock-dictionary.ps1` |
| `apps/kajoo-mcp-server/src/scripts/export-richtext-structures.ps1` | remote PowerShell rich-text structure export | `skills/sitecore/scripts/capture/export-richtext-structures.ps1` |
| `apps/kajoo-mcp-server/src/scripts/get-rendering-source-keys.ps1` | remote PowerShell MVC source-key catalog | `skills/sitecore/scripts/spe/get-rendering-source-keys.ps1` |
| `packages/kajoo-sitecore/src/code/migrations/xpheadless2sai/templates/fetch-layouts.template.txt` | generated TypeScript/Node capture template | `skills/sitecore/scripts/capture/fetch-layouts.mjs` |
| `apps/kajoo-mcp-server/src/tools/migrations/migration-analyze-components.ts` | application analyzer | `skills/frontend-migration/scripts/analyze-source.mjs`; scope and evidence contract in `references/source-analysis.md` |
| `apps/kajoo-mcp-server/src/tools/migrations/migration-analyze-component-usage.ts` | application usage analyzer | `skills/sitecore/scripts/capture/fetch-layouts.mjs` + `skills/frontend-migration/scripts/analyze-usage.mjs`; any positive capture may produce sample usage, while only a complete uncapped capture is authoritative |
| `apps/kajoo-mcp-server/src/tools/migrations/migration-analyze-layout.ts` | application layout analyzer | `skills/frontend-migration/scripts/analyze-layout.mjs` and `scripts/layouts/` |
| `apps/kajoo-mcp-server/src/tools/migrations/migration-analyze-styles.ts` | application style analyzer | `skills/frontend-migration/scripts/analyze-styles.mjs` and `scripts/styles/` |
| `apps/kajoo-mcp-server/src/tools/sandboxes/sandbox-analyze-sitecore-dotnet.ts` | sandbox Roslyn runner | `skills/sitecore/scripts/analysis/analyze-dotnet.mjs`; source-key catalog passed with `--catalog` |
| `apps/kajoo-mcp-server/src/tools/sitecore/sitecore-export-richtext.ts` and its batch/finalize/scheduler runners | Optional background rich-text structure evidence export and staged-file finalization | `sitecore/scripts/capture/export-richtext-structures.ps1` plus the capture manifest/readback contract; no application runner is copied into the sandbox |
| `apps/kajoo-mcp-server/src/tools/sitecore/fetch-and-deploy-headless-mock-layouts.ts` and its Inngest runner | Authenticated headless route-layout capture and local mock-layout delivery | `sitecore/scripts/capture/fetch-layouts.mjs` for code-side route evidence, `export-layouts.ps1`/`normalize-baseline.mjs` for the explicit baseline path, and `references/discovery/baseline-delivery.md` for delivery |
| `apps/kajoo-mcp-server/src/tools/sitecore/fetch-and-deploy-mvc-mock-layouts.ts` and `fetch-and-deploy-mvc-mock-dictionary.ts` | MVC serializer-backed layout/dictionary capture and local mock delivery | `sitecore/scripts/capture/capture-mock-layouts.ps1`, `capture-mock-dictionary.ps1`, and `build-mock-dictionary.mjs`; local delivery is explicit and manifest-verified |
| `apps/kajoo-mcp-server/src/tools/migrations/migration-get-analysis-report.ts` | Readback of persisted source analysis reports | Current frontend analysis scripts write sandbox reports; the agent publishes and reads `code-discovery-report` with the artifact tools, so no MCP wrapper is copied |
| `apps/sitecore-mcp-server/src/tools/analysis/analysis-run.ts` | application collector runner | `sitecore/scripts/analysis/README.md` + `source-sitecore/run-powershell-script` terminal-result contract |
| `apps/sitecore-mcp-server/src/libs/inngest/functions/utils/sitecore-analysis-run.ts` | long-running job worker | connector background-job behavior; no sandbox copy |
| `apps/sitecore-mcp-server/src/libs/inngest/functions/utils/stage-analysis-files.ts` | file staging worker | `discovery-evidence-adapter.mjs` manifest/hash contract; no sandbox copy |

Each remote `.ps1` in this ledger is either present under the owning skill or
explicitly classified as a setup/remediation asset. Each application `.ts`
analyzer/runner is named so it cannot silently disappear when a tool is
removed; its replacement is referenced by the agent/profile that invokes it.

### Reviewed but outside the Discovery executable set

The release branch also contains templates used after Discovery to build the
local mock Layout Service (for example `layout-normalizer.template.txt`,
`normalizing-sitecore-client.template.txt`, and
`bynder-asset-normalizer.template.txt`). They transform or serve retained
layout evidence during reviewed local preview delivery and later code work; they do not collect source
evidence and are therefore owned by the frontend mock-layout assets rather
than the Discovery capture inventory. Likewise, package-install, SPE-1322,
layout-template check/upgrade, and serialization-remediation scripts are
Setup or remediation assets. They are intentionally not dispatched as
Discovery collectors, and their exclusion is recorded here so it cannot be
mistaken for an omitted migration script.

The package's install/package/cleanup and SPE-1322 patch scripts are Setup or
remediation assets, not Discovery scripts, and are intentionally not included
in this checklist. Current JavaScript/ESM scripts are the portable equivalents
of the library-backed analysis steps; they are referenced from the owning skill
instead of being hidden behind a new MCP tool.

The source Discovery script directories contain no separate `.js`/`.mjs`
remote collector; the code-side executable was the TypeScript template listed
above. The current recipe's ESM analyzers and capture helper are therefore
explicitly named here rather than implying that an unlisted source JavaScript
file was omitted.

## Boundary

The code-discovery and layout-analysis sources above are consumed by the
frontend-migration and pair skills. They are intentionally separate from the
Sitecore content collector and do not add remote GraphQL calls to it.

## Required output inventory

With `GenerateReports=true`, the collector writes these artifacts under the
remote Sitecore `Data/auditreports/<timestamp>/` directory and returns them in
its export manifest:

`metadata-stats.json`, `serialization-config.json`, `rendering-usage.jsonl`,
`rendering-details.json`, `rendering-page-mapping.json`,
`template-definitions.json`, `placeholder-usage.json`,
`placeholder-settings.json`, `branch-templates.json`,
`rendering-resolvers.jsonl`, `rendering-resolver-details.json`,
`migration-manifest.json`, `duplicate-items.json`,
`xp-only-template-audit.json`, `sxa-readiness.json`, and
`sxa-conversion-inputs.json`.

An absent, empty, or failed required file is an evidence gap. Optional layout,
dictionary and rich-text captures are reported separately with requested,
attempted, succeeded, failed and skipped counts. No credential, raw payload or
secret is copied into the Migration Artifact.


## Enhanced local evidence builders

The current collector adds `rendering-instances.jsonl` and
`rendering-variants.json`; see scripts/analysis/README.md for enhanced versus
legacy acceptance and completeness. Native local modules:

- `skills/sitecore/scripts/analysis/rendering-evidence.mjs`
- `skills/sitecore/scripts/analysis/rendering-configurations.mjs`
- `skills/sitecore/scripts/analysis/build-rendering-capture-plan.mjs`
- `skills/sitecore/scripts/analysis/build-rendering-mapping-inventory.mjs`

Synthesis references declared hashes and writes these derived outputs to its fresh
draft evidence directory. No backend package import, new MCP wrapper, active
workflow update or live capture is involved. Draft selection is not scope approval.
