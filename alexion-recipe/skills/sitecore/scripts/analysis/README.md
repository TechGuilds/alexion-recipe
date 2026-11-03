# Analysis scripts — extraction manifest

The primary whole-site Sitecore Discovery executable is `xp-discovery-v3.ps1`.
When serialization planning still needs template Standard Values to layout
folder enrichment, the bounded `hotfix-discover-layouts.ps1` operation is
available through `prepare-request.mjs` as `discover-layout-folders`; it is
optional evidence and never replaces the core collector.
It is the recipe-owned dependency-driven collector and must be run through the authenticated
`source-sitecore/run-powershell-script` tool with `GenerateReports=true`.
`discovery-evidence-adapter.mjs` indexes its terminal export, verifies every
required report and preserves file hashes. The bounded SPE samples below are
recovery paths or targeted evidence for areas not covered by that collector;
they do not replace a successful whole-site run.

`assemble-discovery.mjs` remains the deterministic local join/manifest step
for the bounded normalized export contract. Use it when the monolithic
collector cannot run or when a later task needs normalized item/presentation
rows. Never mix files from the two modes without recording their run IDs and
scope fingerprints.

`synthesize-discovery.mjs` is the later draft-only planning join. It consumes
only declared terminal content/code Discovery roots and a verified scope; it
does not execute remote calls, scan a repository, or alter workflow state. It
retains the collector's coverage order and writes a stable rendering inventory,
resolver candidates, candidate phase inputs, unresolved findings and a
hash-bearing synthesis manifest. The coordinator creates the small input file
from known task-result paths and uses a fresh output directory for every
attempt. The script accepts UTF-8 JSON with or without a BOM and the declared
collector field aliases for rendering details, rendering frequency and coverage
plans. That compatibility normalization is bounded and deterministic; a
contradictory or unrecognized schema fails with an evidence gap rather than
being replaced by an ad hoc per-migration script:

Both content layouts are supported without copying or renaming evidence: normalized
assembler reports at the attempt root, or the whole-site adapter's
`discovery-evidence-manifest.json` plus `collector-files/` reports. Whole-site
coverage is read from `rendering-page-mapping.json`'s embedded `coverage_plan`;
the original mapping file and hash remain its provenance. Consumed reports must
match the adapter manifest's hashes and sizes; transient absolute transfer paths
in that manifest are never followed. Normalized output hashes are checked when
listed in its manifest. Preserve readiness, terminal-success and scope checks.

Optional `evidence.contentManifest` and `evidence.contentFilesRoot` select explicit
paths relative to `contentRoot` (`contentFilesRoot: null` selects the attempt root);
optional `evidence.codeSourceReport` and
`evidence.codeCoverageReport` select paths relative to `codeRoot`. Otherwise the
builder recognizes only the two documented layouts: `reports/source.json` or
`source-analysis.json`, and `reports/component-route-coverage.json` or
`component-route-coverage.json`. Multiple candidates require an explicit choice.
Code report hashes/sizes are checked against `manifest.json` when present. A
successful code result without a source report is an error, not empty evidence.
Each branch needs its original returned TASK_RESULT persisted as `task-result.json`
with the workflow key in `workflowKey` and the Kajoo database ID in `taskId`;
legacy results using the workflow key directly in `taskId` also work. The coordinator
may persist an already returned structured result without changing its identity.
For a prose TASK_RESULT, retain the exact text and originating chat/message ID in
an envelope; normalize outcome only from the worker's explicit reported status.
Never infer or fabricate a success result to satisfy the builder.

```json
{
  "version": 1,
  "scope": {
    "scopeId": "verified-discovery-scope",
    "siteRootPath": "/sitecore/content/Tenant/Site",
    "database": "master",
    "language": "en"
  },
  "evidence": {
    "contentRoot": "discovery.content/attempt-1",
    "codeRoot": "discovery.code/attempt-1"
  }
}
```

```sh
node "<actual-installed-sitecore-skill>/scripts/analysis/synthesize-discovery.mjs" \
  --input "${MIGRATION_STATE_FILE_DIR}/evidence/discovery-synthesis-input.json" \
  --output "${MIGRATION_STATE_FILE_DIR}/evidence/discovery.synthesize/attempt-1"
```

For audit consumers, the synthesis manifest's `inputs` paths resolve from the
synthesis input file's directory, while `outputs[].path` resolves from the directory
containing `synthesis-manifest.json`. Keep these bases separate. If a report reference
already starts with `evidence/`, resolve it from the migration directory, not from its
`evidence/` child; never construct `evidence/evidence/` or rewrite a retained manifest
to make an incorrectly resolved audit pass.

The input roots are relative child paths under the input file's directory. Do
not replace missing input with sandbox discovery, remote probes or a repository
search. Report the missing evidence as a bounded synthesis gap instead.

For whole-site core mode, save the terminal transfer manifest and its
downloaded flat files in a fresh attempt directory, then run:

```sh
node /absolute/sitecore/scripts/analysis/discovery-evidence-adapter.mjs --input /absolute/evidence/manifest.json --root /absolute/evidence/collector-files --output /absolute/evidence/discovery-evidence-manifest.json
```

The adapter checks the exact required report names, file sizes and SHA-256
hashes. It accepts the current transfer manifest's flat local file paths and
the collector's remote paths; it never rewrites the report bytes.

## Run a remote golden sample

Use native bash only to compose the request locally, never to execute SPE:

```sh
node "<actual-installed-sitecore-skill>/scripts/prepare-request.mjs" --input /workspace/migration/evidence/request.json
```

Resolve the actual skill directory from the successful skill read first; the angle-bracket path above is a placeholder, not an installed `AGENT` directory. Example input:

```json
{"operation":"discover-site","parameters":{"SitePath":"/sitecore/content/Example","Database":"master","Languages":["en"],"Version":"latest","IncludeFields":["Title"],"MaxItems":10000},"background":true,"destination":"migration/discovery"}
```

Submit the returned arguments to `source-sitecore/run-powershell-script`. The composer prepends `remote-common.ps1`; do not submit an entrypoint alone or dot-source the local skill path remotely. Authentication stays with the connector. Destination is optional: the tool chooses its chat-scoped temporary location and returns it. With background=true, yield to Kajoo's long-running job handling and wait for its automatic resume/result; do not spin on manual status polls. A response containing only a run ID or a `get-tool-results` status of `in_progress` is not terminal evidence. Use `get-tool-results` only for recovery if the automatic result was not delivered or to verify the exact run's status. Do not process a pre-existing export, assemble, or finish the task while it is pending. Retain only files returned by that terminal run in fresh attempt-scoped evidence and record the run ID, request fingerprint, manifest and file hashes. A transport-successful export may still be partial: inspect summary, `errors.jsonl`, and counts.

Retain the downloaded `manifest.json` unchanged. The tool's transfer manifest has `version`, `status: "completed"`, `files` and the original script `summary`; it does not repeat the remote envelope's `kind: "kajoo-export"`. The evidence reader accepts either format and verifies retained file sizes. Do not add fields to make a manifest pass validation; failed transfer status or missing collection summary requires recovery.

After downloading the raw export records and manifests, stage an assembler input beside them. Paths are safe relative file paths under that staging directory; source capture time is explicit so repeated assembly is byte-stable:

```json
{
  "version": 1,
  "source": { "connectorId": "source-sitecore", "identity": "verified-instance", "revision": "optional-source-snapshot", "capturedAt": "2026-09-25T12:00:00Z" },
  "expectations": { "allowEmptyContent": false },
  "scope": { "siteRoot": "/sitecore/content/Tenant/Site", "database": "master", "languages": ["en"], "versions": ["latest"], "devices": ["{DEVICE-ID}"] },
  "exports": {
    "items": { "records": "items.jsonl", "manifest": "items-manifest.json" },
    "renderings": { "records": "renderings.jsonl", "manifest": "renderings-manifest.json" },
    "presentation": { "records": "presentation.jsonl", "manifest": "presentation-manifest.json" },
    "coverage": { "records": "coverage.jsonl", "manifest": "coverage-manifest.json" },
    "serialization": { "manifest": "serialization-manifest.json", "suggestedExclusions": [] },
    "templateClassifications": { "records": "template-classifications.json" },
    "dependencyAudit": { "records": "dependency-audit.json" },
    "dependencies": {
      "targetFlavor": "xmc",
      "items": { "records": "raw/dependencies/dependency-items.jsonl", "manifest": "raw/dependencies/manifest.json" },
      "edges": { "records": "raw/dependencies/dependency-edges.jsonl", "manifest": "raw/dependencies/manifest.json" }
    }
  }
}
```

`items`, `renderings` and `presentation` accept either a single pair (shown above) or a non-empty array of `{records, manifest}` pairs for bounded batches. Original record/manifest bytes are verified and hashed; identical overlapping identities are deduplicated and conflicting ones are rejected. `collectionCoverage` reconciles inventory `hasPresentation` flags against every item/language/version/device tuple. A 25-route runtime sample cannot satisfy site-wide presentation collection. Retain rendering catalog folders, but do not count known folder templates as rendering definitions.

The assembler can run without `coverage`, `serialization`, `templateClassifications`, `dependencies` or `dependencyAudit` to diagnose gaps; this is not full Discovery acceptance. `synthesisReady` checks scoped core collection. `discoveryReady` checks the whole-site core evidence gate and may remain true when a fully reconciled, non-truncated supplemental dependency traversal has unresolved references; those edges, dependent assessments, and missing graph paths remain partial findings. It is false for missing original inventory/catalog identities, scope/seed drift, a bounded frontier, missing/unvalidated non-empty serialization includes, or unassessed dependency areas. A partial serialization plan can satisfy core Discovery only alongside that reconciled, non-truncated supplemental gap; it never counts as a complete deliverable. `deliverablesReady` is stricter: it requires complete dependency closure, derived SXA facts, reviewed dependency assessments and serialization includes covering captured dependency paths. A partial assessed section is different from an unassessed one; never relabel either as complete. Follow [content analysis](../../references/discovery/content-analysis.md) for the eight dependency sections, classification evidence, serialization **planning** (not authenticated transfer), semantic review and required artifact publication/read-back. Assessed compatibility risks are findings, not failed collection. Optional runtime capture/route enrichment stays separate. The flags are structural checks, not proof that arbitrary evidence matches the claimed assessment.

Set `allowEmptyContent: true` only after the exact query/root/language scope establishes a valid zero-result capture; it cannot waive missing tuples in a nonempty inventory. Missing or failed exports are not empty scope. Run `node assemble-discovery.mjs --input /absolute/staging/input.json --output /absolute/new-evidence-directory`. Never reuse an output directory.

Tool defaults (`master`, `en`, `latest`, and `10000`) are not approved migration scope. Read verified Setup/context and pass the verified scope explicitly: selected site, database, languages, version and devices. Use `MaxItems` only as an operational cap. Reaching a cap marks the result partial, never complete. Item identities retain database-scoped ID/path/template and actual language/version. JSONL is streamed to a unique Sitecore Data folder; output is a small `kajoo-export` manifest with exact file sizes. No content items are written.

- `discover-site`: required SitePath, optional IncludeFields allow-list. Root-inclusive inventory. For `Version: latest`, recursive enumeration uses Sitecore `Axes.GetDescendants()` plus `Initialize-Item` and validates each returned item's requested language and nonzero version; numeric and `*` versions retain exact path-based reads. This avoids a child-list request for every visited item without accepting fallback rows. Template IDs are references, not expanded template definitions. Follow referenced templates and settings separately under approved scope.
- `inspect-renderings`: required ItemPaths, optional Recurse (false). Raw controller/action/view, component/resolver/template references, placeholder and cache configuration; absent fields explicit. Resolve path/ID references separately; no fuzzy code matching.
- `inspect-presentation`: required ItemPaths and Devices IDs. Raw shared/final XML and ordered SPE shared/final occurrences including repeat UIDs. Design references remain explicit with `expanded: false`; successful extraction is not a tool error. The assembler reports separate SXA completeness until dependencies are inspected. It does not prove Layout Service/resolver or personalization behavior.
- `inspect-dependencies`: required typed Seeds, Database, Languages, Version and Devices; optional MaxItems. Reads template/base/field/standard-value dependencies, branch ancestors/scaffolds, literal datasource references, resolver catalogs, layouts, placeholders and SXA design/module references. Retains standard fields in snapshots but does not traverse their editor/publishing metadata references (including canonical `Page Editor Buttons`, `Property Editor`, and `Preview publishing targets` fields). Writes raw node/edge JSONL and a pending frontier when capped. Dynamic expressions remain findings. If a reference is absent only in the requested language/version, it performs an existence-only lookup in the same database and records `available-outside-scope`; it does not snapshot or traverse that item, and the processor keeps it as an explicit scope gap. Optional probes distinguish verified absence from failed reads. No content writes or automatic compatibility decisions.
- `analyze-rendering-coverage`: required SitePath, stable RenderingIds, explicit Devices, Database, Languages and Version; optional parallel RenderingNames. Reads SPE-resolved **final presentation**, including inherited/shared presentation, rather than item referrers. Produces frequency, greedy route coverage, uncovered and scope metadata through the same manifest-backed export contract. Plans are separate per language/device (and per actual version for `Version: "*"`); repeated occurrences count once per page. `MaxItems` bounds visited item/language/version identities, not catalog size. A partial manifest cannot establish that an uncovered rendering is unused. Routes come from LinkManager, not guessed content paths. This is static presentation coverage; SXA design expansion and authenticated runtime capture remain separate evidence.

Failures are recorded with item scope and sanitized messages. A fatal script failure is not a successful capture. The composer disposes writers on either success or failure. Source Data exports are temporary remote artifacts; retention/cleanup is an operator concern, not implicit content deletion.

### Prepare presentation batches from inventory

Use `prepare-presentation-batches.mjs` rather than hand-copying hundreds of page paths into tool arguments. It verifies the retained inventory manifests, selects presentation-bearing identities, and writes exact `run-powershell-script` request JSON files plus a hash-bearing `batch-manifest.json` into a fresh directory. Input file paths are relative to the input JSON:

```json
{"version":1,"inventory":{"records":"raw/items.jsonl","manifest":"raw/manifest.json"},"scope":{"siteRoot":"/sitecore/content/Example","database":"master","languages":["en"],"versions":["latest"],"devices":["{VERIFIED-DEVICE-GUID}"]},"batchSize":200}
```

Run `node scripts/analysis/prepare-presentation-batches.mjs --input /absolute/input.json --output "${MIGRATION_STATE_FILE_DIR}/tmp/presentation-<fresh-run-id>"`. Resolve `MIGRATION_STATE_FILE_DIR` from the current project artifact (default `/workspace/.kajoo/<projectId>`); do not create a shared `.kajoo/tmp` directory. For each generated request file, call the selected source PowerShell tool with its workspace-relative `preparedRequestPath` (for example, `.kajoo/<projectId>/tmp/presentation-<fresh-run-id>/presentation-0001.json`) and `expectedSha256` set to the matching batch entry's `sha256` value from `batch-manifest.json`; the tool verifies and parses the exact file before starting the normal PowerShell job. Do not copy or retype the script/parameters. The helper itself does not execute or poll remote jobs. Keep the batch manifest with the returned exports. Batches isolate language/version scope; `*` is expanded into inventoried actual versions so non-page siblings cannot consume the item cap or become unexpected presentation rows. Partial inventory, conflicting latest versions and ambiguous path-to-ID mappings stop preparation for recovery. A verified non-page inventory produces zero requests, not fabricated remote results; retain its inventory proof and the separately documented empty-presentation evidence contract.

### Collect and process dependency evidence

Prepare one exact request with `prepare-dependency-request.mjs --input /absolute/input.json --output /absolute/new-request-directory`. Use fresh request and raw-output directories per run; matching scope alone is insufficient to reuse an export as evidence for a new run:

```json
{"version":1,"inventory":{"records":"raw/items.jsonl","manifest":"raw/items-manifest.json"},"renderings":{"records":"raw/renderings.jsonl","manifest":"raw/renderings-manifest.json"},"scope":{"siteRoot":"/sitecore/content/Example","database":"master","languages":["en"],"versions":["latest"],"devices":["{VERIFIED-DEVICE-GUID}"]},"maxItems":20000}
```

It validates original counts/scope, selects the site subtree and nonrecursive parent, retains the rendering catalog's declared roots, and adds optional Presentation plus bounded Placeholder Settings probes. Module/template/resolver dependency roots are followed by the remote collector. The request manifest records expected item identities and hashes. Submit `dependencies-request.json` unchanged; retain the returned `dependency-items.jsonl`, `dependency-edges.jsonl`, manifest and any errors/pending frontier. Confirm the paired files and manifest are returned by this request's terminal run; a prior manifest may correctly say `completed` but still belong to an older job. Bind the run ID and request fingerprint to the capture record. If the job is `in_progress`, do not run the processor or assembler against those paths, report its counts/errors, or mark the task complete. A cap is incomplete collection, not an empty dependency list. Resolve and retry missing scope; do not label a partial capture complete.

Process only those terminal exports with `process-dependencies.mjs --input /absolute/input.json --output /absolute/new-assessment-directory`. All evidence paths are relative to the input file:

```json
{"version":1,"targetFlavor":"xmc","scope":{"siteRoot":"/sitecore/content/Example","database":"master","languages":["en"],"version":"latest","devices":["{VERIFIED-DEVICE-GUID}"]},"expectations":{"inventory":{"records":"raw/items.jsonl","manifest":"raw/items-manifest.json"},"renderings":{"records":"raw/renderings.jsonl","manifest":"raw/renderings-manifest.json"}},"exports":{"items":{"records":"raw/dependencies/dependency-items.jsonl","manifest":"raw/dependencies/manifest.json"},"edges":{"records":"raw/dependencies/dependency-edges.jsonl","manifest":"raw/dependencies/manifest.json"}}}
```

The processor writes a dependency index with raw fields, typed edges, language/version-specific consumers, cycles, collisions and findings. It emits `serialization-items.json` only when the same run's expected inventory/catalog identities and seed scope reconcile, traversal is not truncated, and paths have no collisions. The file remains available with `status: partial` when supplemental references are unresolved; its source hashes bind it to the exact dependency export/index. Retain both files as Discovery evidence. During Discovery workflow planning, compile the proposed transfer-task roots against a complete same-run `dependency-index.json`, retain the hash-bound `task-scope-manifest.json` and exact `scope-items.json` with the approved plan, then pass that stored item list to the module builder in Content Migration. A task title or partial path list is not a transfer scope, and a transfer task never reconstructs one. `serializationReady: false` still means dependency closure is incomplete; partial path planning never upgrades it to complete. The `compatibility-review-input.json` supplies observed dependencies and XMC baseline categories for assessment, not automatic exclusions; select the actual target flavor (`xmc`, `xp-headless` or `xp-mvc`). Review classifications and the eight dependency sections using this evidence plus resolved presentation. The processor deliberately does **not** manufacture a completed `dependency-audit.json` or declare whole Discovery complete. A path-only serialization ambiguity remains visible alongside both IDs; do not silently choose one or delete either item.

Pass the original node/edge export pairs as `exports.dependencies` in the assembler input. The assembler reruns dependency validation against its own inventory/catalog and exact scope into a fresh `dependencies/` output folder; it does not trust a separately edited graph or completion label. It derives `sxa-conversion-inputs.json` from the native final presentation and that validated graph: page-template usage, scoped placeholder frequencies, dynamic base keys and parent declarations, module registration probes, and design relationships. These are auditable conversion inputs and heuristic candidates, not runtime design expansion, approved exclusions or provisioned target state. Supply one explicit version selection (`latest`, `*`, or a number) per assembly.

| File | Inputs | Output and failure contract |
| --- | --- | --- |
| xp-discovery-v3.ps1 | Verified source site root, database, language and GenerateReports=true | Whole-site dependency-driven report set; all required report files plus explicit terminal export envelope; missing report/failed terminal run is incomplete |
| discovery-evidence-adapter.mjs | Terminal xp-discovery-v3 export and downloaded report directory | Hash-verified whole-site core manifest; never fabricates normalized item/presentation rows |
| discover-site.ps1 | Source site content root, database, languages/versions and export scope | Root-inclusive item identity/template references, requested fields and presentation flags; requested/visited counts and partial errors (normalized recovery mode) |
| inspect-renderings.ps1 | Source rendering roots/IDs | Exact item IDs, type, controller/action/view, datasource/parameter templates, resolver and caching settings; unresolved fields explicit |
| inspect-presentation.ps1 | Source pages, language/version/device scope | Raw XML and SPE-resolved shared/final occurrence views with UIDs, datasources and parameters; direct SXA references only, no design expansion/cycle audit |
| analyze-rendering-coverage.ps1 | Source site root, rendering IDs/names, database/language/version/device scope | Manifest-backed resolved-final rendering frequency, scoped greedy route plans, uncovered definitions and page counts |
| inspect-dependencies.ps1 | Explicit typed roots/references and database/language/version/device scope | Bounded dependency nodes, reference edges, raw field metadata and pending frontier; no target compatibility judgment |
| prepare-dependency-request.mjs | Verified inventory/catalog manifests and explicit scope | Exact PowerShell request and expected identity/hash manifest |
| process-dependencies.mjs | Paired dependency export plus original inventory/catalog expectations | Scoped graph index, compatibility review input, and unambiguous typed serialization input; partial reads stay explicitly incomplete findings, not process exit failures |
| derive-sxa-inputs.mjs | Native final presentation, validated dependency graph and explicit scope/completeness | Pure derivation of placeholder, page-template, module-readiness and design facts; no target operations or automatic assessment approvals |
| assemble-discovery.mjs | Downloaded raw records/manifests plus optional serialization/classification evidence | Normalized evidence, canonical shared/final counts, retained coverage ranking, output hashes, scoped completeness and synthesis readiness |
| analyze-dotnet.mjs | Explicit read-only root, revision label, runtime/executable, optional rendering JSON/JSONL catalog, fresh output JSON | Real retained Roslyn output under `result`, rendering/controller/view/model candidates under `mapping`, resolver inventory under `result.contentResolvers`, scope/ambiguity/dynamic diagnostics |

SPE runs remotely through source-sitecore/run-powershell-script with structured parameters, not local PowerShell. Local .NET analysis must specify its parser/runtime dependencies and cannot assume Roslyn or LSP equivalence. No credentials enter scripts.

Extraction provenance: the recipe-owned xp-discovery-v3.ps1 is the
auditable copy of 03e00d4c9
apps/sitecore-mcp-server/src/tools/analysis/ps/xp-discovery-v3.ps1. The
removed application wrapper is not restored. Preserve field reconciliation,
exact joins, repeated rendering occurrences and partial-scan diagnostics.

SPE fixture acceptance covers root-inclusive scope, partial limits/access failures, repeated rendering occurrences, shared XML, manifests and non-English values. The Node assembler has fixture tests for joins, completeness and provenance. Real Sitecore/SPE version compatibility, standard-value resolution and design expansion require instance-backed verification; do not claim those from test doubles. See `tests/remote-scripts.test.ps1`. Samples declare their narrower guarantees above.

`tests/rendering-coverage.test.ps1` exercises the actual coverage producer with SPE/LinkManager doubles: inherited/repeated usage, unrelated links, language/device/version separation and incomplete captures. `tests/presentation-batches.test.mjs` verifies deterministic request generation, scoped caps, punctuation and inventory rejection before remote execution.

`tests/dependencies.test.ps1` exercises the dependency collector with SPE doubles, including cycles, unused module/resolver catalogs, duplicate-path IDs, device provenance, version fallback, optional absence, access failures and bounded recovery. `tests/dependency-request.test.mjs` and `tests/dependency-evidence.test.mjs` cover manifest-to-request preparation, scope reconciliation, graph analysis and exact serialization inputs. These do not replace live connector verification.

## Local .NET analysis

`analyze-dotnet.mjs` is implemented and tested against the real retained `deps/roslyn-analyzer` through Docker. It uses Node built-ins only. It does not discover a deleted SDK binary, compile the application, invoke an MCP wrapper, or substitute another source parser. The retained program takes a **positional source directory**; the old `--path/--json` README example is not its executable contract.

Build/deliver the analyzer separately using the pinned Dockerfile and NuGet lock in `sitecore/tests/dotnet.Dockerfile` and `dotnet.packages.lock.json`. Exact commands, supported native/.NET/Docker configurations, catalog schema and limits are in [local Razor/.NET analysis](../../references/mvc/scan-razor-source.md). Host .NET is unnecessary for Docker mode. Example after building and inspecting the immutable image ID:

```sh
node /absolute/sitecore/scripts/analysis/analyze-dotnet.mjs \
  --root /absolute/source --revision BASELINE \
  --runtime docker --executable /usr/local/bin/docker \
  --image sha256:REPLACE_WITH_BUILT_IMAGE_ID \
  --assembly /app/roslyn-analyzer.dll \
  --catalog /absolute/evidence/renderings.jsonl \
  --output /absolute/evidence/dotnet-analysis.json
```

Source is read into an excluded/capped snapshot, then mounted read-only for Docker. Output is exclusively created outside input source, with one JSON summary on stdout. Missing catalog explicitly skips mapping; malformed or declared-partial catalogs fail. Successful partial evidence exits 0; fatal runtime/input/output errors exit 1. Inspect `scan`, `mapping.diagnostics`, per-rendering diagnostics and `engine` limitations. `complete` covers the supported scan/join contract, not application compilation or exhaustive syntax/runtime validation. Captured layouts remain a separate downstream reconciliation input.

Tests: `node --test sitecore/tests/dotnet.test.mjs`; real integration: `ROSLYN_SOURCE_ROOT=/absolute/repo/deps/roslyn-analyzer node --test sitecore/tests/dotnet-docker.test.mjs`. The Docker test builds in a temporary copied context with locked restore and runs actual C#/Razor fixtures. It fails rather than silently skips when its source/runtime prerequisite is missing.


## Enhanced rendering evidence (v3 port, item 1)

The recipe collector now accepts optional `RenderingRootsJson`, a JSON string
array of absolute folders under `/sitecore/layout/Renderings`. Omit the variable
for automatic page/SXA dependency discovery; do not send null, an empty array,
content paths or variant folders. Supplied roots supplement inferred roots,
include unused definitions and do not change `SiteRootPath`. No project-specific
roots are injected. The Discovery agent asks whether extra paths are required,
requests them only when the answer is Yes, and omits `RenderingRootsJson` when
the answer is No. Retain a prior explicit answer on resume. See the
[rendering preview flow](../../references/discovery/rendering-preview-flow.md).

The enhanced terminal envelope remains `kind: kajoo-export`, `version: 1` with
only `summary` and `files` beside those two keys. `summary.discoveryEvidenceVersion`
is 2. In addition to the existing reports, it exports `rendering-instances.jsonl`
and `rendering-variants.json`. An empty occurrence stream is valid when no
occurrences were found. Metadata records configured/effective roots, usage and
inventory completeness, and unresolved references. Content scanning keeps the
requested language; structural rendering/template lookup retries English when
needed. Invalid configured roots remain input errors. Individual unresolved
rendering/template references are logged and retained, while the scan continues;
this does not suppress fatal script/export errors or certify complete discovery.

The adapter requires and validates the two added reports for enhanced exports,
records their hashes, and exposes `renderingEvidence`. Reference warnings do not
invalidate a successful terminal export; completeness remains separate from
transport success. Existing exports retain the original required report contract
and explicit limitations, without inventing occurrence or variant evidence.

Synthesis consumes added evidence only when its manifest declares it and its hash
matches. It preserves `rendering-inventory.json` and `coverage-plan.json`, and adds:

- `rendering-mapping-inventory.json`: schema 2 rendering summaries, exhaustive
  configuration/occurrence evidence, shared templates/placeholders/variants,
  completeness and warnings. Source-file evidence is not implementation proof.
- `rendering-capture-plan.json`: rendering-ID + variant-ID selection, candidate
  alternatives, unresolved targets and bounded minimum-search information.

The portable modules are `rendering-evidence.mjs`, `rendering-configurations.mjs`,
`build-rendering-capture-plan.mjs` and `build-rendering-mapping-inventory.mjs`.
They are native-Node functions invoked by synthesis, not replacement MCP tools or
independent workflow writers. Capture ignores datasource, placeholder placement,
ordering and non-variant parameters; mapping retains those facts. Unused
renderings/variants stay mapping-only. Missing evidence stays unknown.

Synthesis writes **draft, discovery-only** capture plans. It does not infer user
scope approval, perform a capture, create examples, change workflow/tasks, or
install preview files. A caller can explicitly provide included rendering IDs to
the planner once approval has been validated by its owning workflow; an explicit
empty set selects none. `minimumProven: false` means the search budget was reached,
not that coverage failed. Old exports without occurrences cannot establish full
rendering/variant capture coverage. The
[rendering preview flow](../../references/discovery/rendering-preview-flow.md)
documents approved selection, capture/reporting, mapping and preview delivery;
these remain separate from draft synthesis.

Focused local checks (no Sitecore connection required):

```sh
node --test skills/sitecore/tests/discovery-evidence-adapter.test.mjs skills/sitecore/tests/discovery-synthesis.test.mjs skills/sitecore/tests/rendering-evidence.test.mjs skills/sitecore/tests/rendering-capture-plan.test.mjs skills/sitecore/tests/rendering-mapping-inventory.test.mjs
pwsh -NoProfile -File skills/sitecore/tests/rendering-inventory.test.ps1 -SourcePath skills/sitecore/scripts/analysis/xp-discovery-v3.ps1
```

Run these paths from the recipe root. A live SPE run is still required to validate
instance-specific permissions, field values and language availability.
