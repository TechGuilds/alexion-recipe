# Content discovery through native evidence files

This is read-only discovery on the selected source Sitecore connector. The
default whole-site path is the recipe-owned
`scripts/analysis/xp-discovery-v3.ps1`, the recipe-owned dependency-driven
collector. Read its native bytes, pass verified
`SiteRootPath`, `Database`, `Language` and `GenerateReports=true` to
`source-sitecore/run-powershell-script`, and wait for the terminal export.
Run `scripts/analysis/discovery-evidence-adapter.mjs` against that fresh
terminal export to verify all required reports and retain their hashes. Do not
call a removed backend or fabricate missing rows.

For rendering inventory and requested preview, follow the authoritative
[rendering preview flow](rendering-preview-flow.md). Inventory configured source
presentation across the agreed content scope, then rendering definitions and
variants; this inventory has no route-count cap. Static source analysis runs in
parallel and does not require an early runtime capture.

The bounded `discover-site`, `inspect-renderings`,
`inspect-presentation`, `inspect-dependencies` and
`analyze-rendering-coverage` SPE samples remain recovery/targeted paths
through [request composition](../../scripts/analysis/README.md). Use them when
the monolithic collector cannot run or when a downstream task explicitly needs
normalized item/presentation rows that the whole-site collector intentionally
did not emit. Download terminal manifests/files unchanged, run
`scripts/analysis/assemble-discovery.mjs` locally, and never merge evidence
from different runs without recording both run IDs and scope fingerprints.

## Failed execution or report transfer

On a failed PowerShell call, inspect its terminal result before retrying. If reports were generated but export/download failed, follow [the Sitecore download diagnosis and recovery procedure](../setup/spe-1322-patch.md#diagnose-failed-powershell-downloads), including read-only log inspection and approval before client repairs. Preserve the original collector run and remote report paths. Recover the existing export first; do not switch collection modes, launch duplicate collectors, or rerun Discovery simply to work around a broken transfer endpoint. If recovery is blocked, save the exact cause, evidence and next action in the task report and leave the task blocked.

## Collection modes and acceptance

The coordinator states `collectionMode` in every `discovery.content` task scope. Use exactly one fresh mode per Discovery attempt; a worker must not choose normalized mode on its own merely because it yields more granular records:

1. **Whole-site core mode (default):** run the recipe-owned
   scripts/analysis/xp-discovery-v3.ps1 once with the verified scope and
   GenerateReports=true, then run scripts/analysis/discovery-evidence-adapter.mjs.
   A terminal successful export containing every required report in
   discovery-script-inventory.md is the Sitecore core Discovery gate. It
   preserves the collector folder-traversal contract, including the complete
   item count, page/rendering/dependency analysis, templates, branches,
   placeholders, resolvers, duplicate audit, serialization paths, XP-only
   audit and SXA readiness. It is valid for synthesis even though the
   whole-site collector deliberately does not emit content-items.jsonl or
   normalized presentation rows. The adapter must expose the missing
   normalized rows as a documented contract limitation, not silently claim
   that they exist.
2. **Normalized recovery mode:** use the bounded collectors and
   assemble-discovery.mjs only when the current whole-site collector has a
   terminal failure, its returned report set remains missing/corrupt after
   its one bounded recovery, or an explicitly named downstream task needs
   normalized rows. The coordinator must put that trigger—run ID/report
   defect or downstream task ID—in the task scope, and the resulting evidence
   must retain it. The normalized mode has the stricter manifest/frontier
   checks below.

In whole-site core mode, missing/corrupt required reports, a failed terminal
collector, scope mismatch, or an incomplete export blocks the task. Optional
runtime layout, dictionary and rich-text enrichment remains non-blocking and
must be reported separately. Do not run both modes in parallel for the same
scope or merge their counts. A successful whole-site export ends content
collection; do not start normalized collection afterward unless an approved
later task has its own scoped normalized-row requirement.

## Resolve scope

Read the hub's context file for source connector, site name, content root, database and languages. Verify the content root against the source site's RootPath using connector-backed SPE. A site name or repository name is not a content path; never guess an SXA tenant path. Use the requested language exactly, with no silent en fallback.

Ask the user a yes/no rendering-root question: should the definition catalog
include rendering folders in addition to definitions referenced by source
presentation? If yes, ask for full paths under `/sitecore/layout/Renderings` and
pass those exact paths as the JSON-array string `RenderingRootsJson`. If no,
omit `RenderingRootsJson` entirely; the collector rejects `[]` and `null`.
Keep parameter names exactly cased: `SiteRootPath`, `Database`, `Language`,
`GenerateReports`, `RenderingRootsJson`. Record the selected scope and retain
the execution request unchanged. The structural English fallback applies only
to definition items; source content stays in the exact requested language.
Rendering roots do not select `/Presentation/Headless Variants`; retain observed
variant selectors and record that separate structures need a targeted read.

## Gather and save

The numbered normalized-export procedure below applies only to normalized
recovery mode. In whole-site core mode, follow this shorter procedure instead:

1. Read the native xp-discovery-v3.ps1 file and verified scope.
2. Submit one background source-sitecore/run-powershell-script request with
   GenerateReports=true and record its run ID/request fingerprint.
3. Wait for that exact run to reach a terminal state; do not process stale
   manifests or launch duplicate retries while it is pending.
4. Retain every returned report under a fresh attempt-scoped directory and run
   discovery-evidence-adapter.mjs.
5. Run `scripts/serialization/compile-serialization-scope.mjs` once against
   that attempt's `serialization-config.json`, writing to a fresh sibling
   `serialization-scope/` directory. Retain its two hash-bound outputs. The
   collector's folder includes are the canonical transfer semantics; do not
   replace them with an inferred flat item list.
6. Require its discoveryReady and synthesisReady flags, publish a bounded summary
   using the `cms-migration` skill, `references/procedures/migration-report.md#publish-a-bounded-summary` (resolve from that skill's root), and carry optional enrichment gaps and later-work findings
   separately.

Retain `discovery-evidence-manifest.json` at the attempt root and the verified
collector reports under `collector-files/`. The synthesis builder reads this
layout directly, including `coverage_plan` inside `rendering-page-mapping.json`;
do not invent a separate normalized manifest/coverage file or recollect content
solely for synthesis filenames. Persist the original task result at the attempt
root as `task-result.json` with `workflowKey: "discovery.content"` and the actual Kajoo task ID for the local join.

1. Inventory the agreed root, database, languages and version scope. For the common `latest` case, the `discover-site` collector uses Sitecore `Axes.GetDescendants()` plus `Initialize-Item`, avoiding a child-list request for every visited item. It starts from a root fetched in the exact requested language/version and verifies every descendant's language and nonzero version before recording it. Explicit numeric and all-version scopes retain path-based exact reads so they do not inherit the root's version. Save requested/visited counts, page boundaries, access failures, item IDs/paths/template IDs and export provenance. Treat any changed count, scope, fallback or error profile as evidence to investigate; do not hide it as a speed optimization.
2. Follow [rendering analysis](rendering-analysis.md) for exact rendering definitions/resolvers and [layout and usage](layout-and-usage.md) for page occurrences, inheritance, nested placeholders, datasources and SXA presentation relationships. Run `inspect-presentation` over the inventoried presentation-bearing pages in explicit bounded batches for the agreed languages/devices; preserve each batch's terminal manifest and reconcile requested versus visited identities. A hand-parsed shared/final XML export is supplemental evidence and cannot replace the script's SPE-resolved occurrence records. Inspect rendering roots once and reuse the result; separate folders from actual rendering items using template/field evidence. Preserve IDs and repeated occurrences; join only on stable IDs.
3. After rendering definitions are known, run `analyze-rendering-coverage` with the exact SitePath, stable RenderingIds/RenderingNames and the same explicit Database, Languages, Version and Devices. It reads resolved final presentation and writes manifest-backed `coverage.jsonl` with separate language/device plans; item referrers are not rendering usage. A failed or partial coverage export limits routes but does not erase valid occurrences or prove uncovered renderings unused. Preserve scope fields when using its routes for captures.
4. Save raw connector output unchanged under a fresh, attempt-scoped evidence directory. Keep the generic `remote-runs.jsonl` ledger beside the branch evidence and append each request fingerprint/run ID/status as it changes. Submit with `background: true` and file output. Treat the result as pending until the same run has a terminal `completed`, `failed`, or `canceled` status and its returned files are available. With a background run ID, yield to Kajoo's long-running job handling and wait for its automatic resume/result; do not spin on manual status polls. Use `get-tool-results` only as a recovery path if the automatic result was not delivered or to verify the exact run's status. The presence of a prior `raw/` directory, a completed manifest, a zero exit code from local processing, or a populated assembler output does not prove that the current remote run completed. If the tool returns a run ID or `in_progress`, do not proceed to processing, assembly, or task completion while it remains pending, and never submit the same request again. Do not substitute files from another run or attempt. Accept an export only from the terminal result for the submitted request; retain its run ID, request fingerprint, returned manifest and file hashes with the evidence. If the result never becomes terminal, report the job as pending/blocked with its run ID and last status—do not convert an older export into a “fresh retry.” Inspect every returned manifest/file, copy needed files to durable evidence, and record failed transfers. Nothing seeds workflow state automatically.
5. Complete the dependency assessments below and stage an assembler input JSON beside those files with source identity/revision, exact site/database/language/version/device scope and relative paths to the raw records/manifests. Each of `items`, `renderings`, and `presentation` accepts one pair or an array of batch pairs; preserve original manifests instead of fabricating a merged connector manifest. Include the dependency audit, serialization plan, reviewed template classifications and evidence-backed suggested exclusions. Run `node scripts/analysis/assemble-discovery.mjs --input <absolute-input> --output <absolute-new-directory>`. The output directory must not already exist.
6. Require the assembler outputs: `rendering-usage.jsonl`, `rendering-details.json`, `rendering-page-mapping.json`, `sxa-conversion-inputs.json`, `xp-only-template-audit.json`, `serialization-config.json`, `coverage-plan.json`, `discovery-manifest.json`, and `content-discovery-report.md`. Each links its source evidence and records complete, partial or unavailable scope. An unavailable structured result is an auditable limitation, not an empty placeholder or proof of absence.
7. Compile the evidence-derived serialization scope with
   `scripts/serialization/compile-serialization-scope.mjs`. It consumes the
   collector's existing `serialization-config.json`, preserves recursive versus
   exact include semantics, folds covered same-kind descendants, and records
   its input hash. `build-modules.mjs` later builds module configs from this
   scope; it does not discover dependencies. The inspection/batch processors
   need already-staged YAML/module inputs. None execute authenticated transfer;
   no YAML pull is required to finish Discovery.
8. Read back `discovery-manifest.json`; require `discoveryReady: true` and `synthesisReady: true`, verify every listed output/hash, and carry findings into synthesis and audit. `deliverablesReady: false` is allowed only for the explicitly reported supplemental dependency/serialization gaps described below; it is not equivalent to full downstream delivery. These structural checks do not prove semantic completeness. Do not duplicate raw payloads into memory or Migration Artifact.
9. Follow the bounded summary publication guidance in the `cms-migration` skill at `references/procedures/migration-report.md#publish-a-bounded-summary` (resolve from that skill's root) to idempotently list/update/create the `content-discovery-report` Kajoo markdown artifact in the current project. Include a concise table of collected scope, findings, deferred enrichment and follow-up owners, with the sandbox evidence pointer. Read it back through `get-artifact` and retain the artifact ID and publication evidence in the task result. A sandbox markdown file alone is not publication. Do not upload raw JSON/JSONL evidence or store it in Migration Artifact.

Use the assembler's manifest counts in both the artifact and task result, including their units and source fingerprint. A correction replaces the current summary idempotently and identifies the superseded evidence; never maintain competing hand-counted totals. The assembler's `sxa-conversion-inputs.json` derives scoped page-template usage, placeholder/dynamic-key relationships, module-registration evidence and design references/cycles from native presentation and the dependency graph. These are conversion inputs and candidate heuristics, not a converted or runtime-flattened design graph. Empty direct references do not prove there is no SXA work: follow source site/template/design relationships and the target's SXA requirements when classifying later phases. Full graph conversion and authenticated serialization transfer remain later work; collect enough evidence here to describe their scope and dependencies.

## Site-wide collection and dependency assessments

Runtime capture is downstream of presentation inventory and approved rendering
scope. Inventory all agreed presentation-bearing item/language/version identities,
then inspect every selected device. In normalized recovery mode, prepare exact
bounded requests with `scripts/analysis/prepare-presentation-batches.mjs` using
the retained inventory and scope, as documented in the analysis README (200
paths by default; reduce on a size/timeout error). Write requests under a fresh
`${MIGRATION_STATE_FILE_DIR}/tmp/presentation-<fresh-run-id>/` path scoped to
the current project (default `/workspace/.kajoo/<projectId>`). Resolve the
environment variable before submitting each workspace-relative
`preparedRequestPath` (remove `/workspace/` from the resolved absolute path), with
its exact `expectedSha256` from `batch-manifest.json`, and reconcile
`collectionCoverage.missing` against the inventory. Recover only missing tuples;
do not stop after a sample. Non-page items are not unvisited pages. Check
inherited/standard-value presentation when identifying pages. Resume only from
scope/revision-matching evidence; correct a safe invocation/schema defect once
before returning failure. A missing staged script requires re-reading the skill
to sync supporting files, not substituting an ad hoc assembler.

When Discovery requests a mock preview, derive the approved rendering/variant
capture plan after synthesis and scope review, then make the actual capture and
reviewed local delivery attempt described in [baseline capture](baseline-capture.md).
Do not capture sitemap/homepage extras or create mock files to seed analysis.
Retain requested, attempted, succeeded, failed and skipped counts, current input
hashes and terminal run evidence. `not-attempted` is not `unavailable`. Preserve
optional runtime failures separately from the successful core collection gate;
requested preview still needs an explicit deferral with an owner if it cannot
be delivered. Partial runtime evidence never proves a source rendering unused.

Normalized dependency discovery is optional enrichment beyond the core collector's
serialization plan. Run `prepare-dependency-request.mjs` and its composed
`inspect-dependencies` request only when the agreed Discovery scope needs the
additional graph assessments or an already-approved later transfer task needs
an exact item binding. Do not launch it automatically just to approve the
standard workflow. When it is requested, use a new request and raw-output
directory for every remote run; never point the processor at a pre-existing
dependency export merely because its scope appears to match. Process paired
node/edge exports only after the *same submitted run* reaches a terminal state
and returns those files. Bind the run ID and request fingerprint to the
retained capture record; the returned manifest, item stream and edge stream
must all belong to that run. If the run is `in_progress`, do not process or
assemble from those paths, publish its counts/errors, or report task completion:
resume/wait on that exact run, or report pending/blocked with its run ID and
last status. A manifest from an earlier run can legitimately say `completed`,
but is not evidence that the current run completed. See the [request and
processing contracts](../../scripts/analysis/README.md#collect-and-process-dependency-evidence).
This enrichment retains template fields, inheritance, branch scaffolds, external
datasource references, resolver/module catalogs, layout/placeholder and design
relationships instead of leaving their collection to ad hoc queries. Use
existing exact-ID reads only for explicit recovery or evidence not covered by
the collector. Query/dynamic datasource values remain findings, not guessed
paths. Sitecore's all-zero GUID is an empty reference, not an item ID: preserve
it as an `empty` edge and never look it up or count it as a collection error.
For failed/missing references, retain relation, consumer, language, error
category/type and a bounded exception message; redact credential-bearing URLs.

When the normalized graph is requested, use its scoped dependency index to
perform the assessments below alongside the resolved presentation/coverage
evidence. The compatibility review input is not a completed assessment; it
keeps target-policy suggestions distinct from confirmed incompatibilities.
Always recover missing original inventory/catalog identities, scope/seed
mismatches, and bounded frontiers before accepting an exact binding. A failed or
absent supplemental referenced item remains a documented partial finding; it
does not invalidate an otherwise successful core Discovery or its standard
serialization plan. Keep its error details, affected consumer/relation,
downstream consequence and recovery owner explicit; never report the graph or
dependent exact-item assessment as complete because of this rule. Its exact
typed serialization input is only local planning; no authenticated transfer or
target write occurs here. Preserve both IDs for path collisions and describe
their planning/transfer implications rather than silently removing source items.

| Assessment key | Required discovery evidence (not implementation) |
|---|---|
| `templates` | Content, datasource, parameter and branch-scaffold templates; paths, fields/sections, base-template closure and standard values/presentation dependencies. Preserve reverse references to consuming items/renderings. Equivalent to the collector's template definitions and inheritance graph. |
| `datasources` | Literal datasource IDs/paths, rendering datasource templates/locations, local/shared folders including references outside the site root. Record query/dynamic values and consumers as unresolved strategy work; do not assert their expansion. |
| `layoutsPlaceholders` | Referenced layout definitions, occurrence order/UIDs, placeholder chains and dynamic base keys, representative pages, placeholder settings/allowed renderings, rules/personalization and layout inheritance. Walk applicable settings once and reuse. Preserve raw rules where evaluation requires runtime. |
| `branches` | Referenced branch roots and descendants, scaffold templates and their dependencies even outside discovered template folders. Record verified absence when there are no applicable branches. |
| `resolvers` | Rendering-to-resolver IDs, resolver definition/configuration fields, type/assembly/query/datasource behavior where recorded. Keep used and unused definitions distinct. Adapter implementation and runtime equivalence are later work. |
| `sxa` | Site/template/design relationships; page/partial/base design reference closure and cycles; rendering modules/registrations, placeholder coverage, page-template usage and repeated/global rendering candidates. Record target-driven SXA work even for a non-SXA source. Discovery gathers conversion inputs/readiness, not completed conversion. |
| `compatibility` | Target-specific XP template audit over the captured dependency graph, including branches/base templates; exact path/ID, reason, consuming item IDs/counts and possible alternatives. Zero confirmed incompatibilities is valid after review; a keyword search alone is not this audit. |
| `duplicates` | Same-parent/name/path collisions with distinct IDs and applicable reference hazards; use the inventory/dependency records, not a destructive cleanup. Preserve scope and evidence when no duplicates are found. |

Store these assessments in `dependency-audit.json`: `{ "version": 1, "sections": { "templates": { "status": "complete", "evidence": ["raw/templates.jsonl", "raw/templates-manifest.json"], "findings": [] } } }`, with one entry for **every row** above. Paths are relative to the assembler input directory. Each `evidence` list must contain the relevant raw export and manifest or retained connector response, not just an unrelated file. `complete` means the assessment was performed over the agreed scope, **not** that all migration risks were resolved. `not-applicable` requires a reason and applicability evidence. `partial`/`failed`/`unavailable` mean collection remains incomplete; preserve observed findings, scope and a recoverable next action. Findings carry affected IDs/paths, evidence and later-work owner. Do not label an unperformed assessment complete to pass the gate. The assembler hashes the referenced evidence and retains this audit as a downstream index; no new database or Migration Artifact schema is introduced.

## Serialization and compatibility output

When normalized dependency enrichment was requested, pass its retained node/edge
exports to the assembler's `exports.dependencies` with the selected
`targetFlavor`; see the analysis README for the input shape. The assembler
revalidates them against the same inventory/catalog, writes the graph under
`dependencies/`, and derives additional SXA/placeholder facts from native final
occurrences. Review those derived facts for the `layoutsPlaceholders` and `sxa`
assessment sections; a direct design-reference list alone is not equivalent
coverage. Module-registration gaps and conversion candidates are later-work
findings, while an unperformed or partial optional probe remains a collection
limitation. Do not replace original captures with edited complete labels.

The core collector's `serialization-config.json` is the standard Content
Migration scope source: it records the observed include namespaces and proposed
exclusions needed to configure source serialization without another whole-site
scan. Retain it with its collector hash and do not reconstruct a broader path
list from another attempt, inventory, or hand-selected sources. If an approved
transfer task genuinely needs exact `SingleItem` ownership, use a current
normalized `serialization-items.json` and its complete dependency index for
that task only. It is emitted only when its dependency run has reconciled
inventory/catalog/seeds, completed bounded traversal and has no path collisions.
Retain the exact task binding beside that task's approval; do not make it a
prerequisite for normal workflow planning. Pass a stored exact item list to
`scripts/serialization/build-modules.mjs --input <scope-items.json>
--output-root <fresh-modules-dir>` only for that exact-item task. It emits exact
`SingleItem` includes, not descendant scopes or automatic exclusions. Exit 2
means outputs plus duplicate/OOTB warnings: inspect them, not immediate tool
failure. Do not silently drop warned paths or generate unsupported `Ignored`
rules.

For the standard plan, retain the core collector's `serialization-config.json`
and its hash as the serialization manifest. Config creation is local planning, not
a content pull/push; it does not require an exact module build during Discovery.
For an approved exact-item task, retain the generated modules and
`build-modules.json` in that task's evidence. Its version-1 plan records
`status`, `modules` (`name`, actual relative `configPath`, `includePaths` read
from each module), exact item/template counts and `missingReferences`, and
copies `serialization-items.json.source.dependencyManifestSha256` to
`sourceDependencyManifestSha256`. The assembler verifies that binding before
accepting an exact-item plan. If an exact module build is unavailable, retain an
explicitly labeled proposed include plan and report the task's missing
deliverable for recovery; do not call nonexistent files generated. Use
`inspect-items`/`plan-batches` only when their captured YAML prerequisites
exist. For a verified empty scope, record the empty plan rather than calling the
non-empty module builder.

Supply `exports.templateClassifications.records` with an object shaped as `{ "version": 1, "classifications": [{ "templateId": "{ID}", "templatePath": "/sitecore/templates/...", "classification": "review-required", "reason": "Observed target-sensitive dependency", "evidence": ["raw/templates.jsonl"], "usedByItems": ["{CONTENT-ID}"], "suggestedReplacements": [] }] }`. Include all audited template IDs, including reachable base/datasource/parameter/branch templates, not just content template IDs. Unknown compatibility may be a documented finding after the dependency was inspected. Suggestions are separate from approved exclusions and must not remove source data. For XMC, review the baseline areas in the exclusions reference alongside actual graph findings; for XP Headless do not import XMC exclusions. Report baseline suggestions separately from confirmed site dependencies and use unknown counts rather than invented zero counts.

## Exclusions and validation

For XMC targets, inspect [XP exclusions](../serialization/xp-to-xmc-exclusions.md) against the captured dependency tree. Record suggestedExclusions with path, reason, affected items and evidence; suggestions are not approved exclusions. An empty list is valid when supported by evidence. For XP Headless, do not apply XMC exclusions by default.

Verify every requested root/language was visited, reconcile catalog IDs to occurrences, explain zero counts, and account for missing/unmatched items. Wrong site/config is not a transient error; stop and correct context. Missing pages or unresolved presentation/design branches mean partial discovery, not a completed inventory. A valid empty query requires explicit query/scope evidence; an empty file, missing file or failed export is not a valid zero-result capture.

Return `success` after the selected collection mode reaches its gate. In whole-site core mode, require a terminal xp-discovery-v3 export, every required report from discovery-script-inventory.md, a matching discovery-evidence-adapter manifest with `discoveryReady: true` and `synthesisReady: true`, and publication/read-back of the content report. This mode intentionally does not require normalized content-items/presentation rows or a second bounded collector. In normalized recovery mode, require the stricter inventory, frontier, dependency, serialization-plan and assessment checks described above. `deliverablesReady` remains stricter than phase success and still requires complete dependency closure, derived SXA facts and authenticated delivery readiness. Optional runtime layout captures, dictionary/verification enrichments, uncovered unused renderings, migration compatibility risks and deferred adapter/conversion implementation remain documented findings without failing successful collection. Missing/corrupt core exports, missing scope identity, scope drift, a failed terminal run, or an unassessed required report remain blockers.

Required exports absent/corrupt, missing page batches, unperformed dependency assessments, missing/unvalidated serialization planning or failed summary publication keep the task unsuccessful; first attempt bounded recovery when safe. Authenticated YAML transfer and target implementation are later work; supplemental dependency misses and compatibility findings remain explicitly classified evidence, not fabricated blockers or successful checks. Preserve the difference between successful core Discovery and complete downstream delivery in both task result and report. Return the hub's task-result object with actual file references, totals, report artifact ID and separately categorized collection gaps versus later-work findings. The hub alone creates/reconciles work items and advances phases.

Only required assigned-stage gaps belong in task/evidence `unresolved` or failed acceptance checks. Keep optional capture limitations and assessed later-work risks visible in the report/summary with owners; do not copy the assembler's entire findings array into the task's failure fields. An inventoried non-page content scope can validly have zero presentation records when all flags and successful scoped export manifests establish that absence; do not manufacture pages or fail merely for having none.
