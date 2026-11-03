# Sitecore Discovery profile

Read the generic [Discovery phase contract](../../../pipeline/discovery.md), [source baseline procedure](../../../procedures/capture-source-baseline.md), [rendering analysis](../../../../../sitecore/references/discovery/rendering-analysis.md), and [layout/usage analysis](../../../../../sitecore/references/discovery/layout-and-usage.md). This profile supplies Sitecore-specific evidence and applicability rules; the CMS hub owns orchestration, approvals and workflow synchronization.

The authoritative Sitecore sequence is [rendering preview flow](../../../../../sitecore/references/discovery/rendering-preview-flow.md):
inventory configured source presentation, referenced definitions and approved
additional rendering roots/variants; synthesize a draft; review included
rendering scope; derive the approved native capture plan; attempt capture;
review source-to-target mapping; then stage and install the reviewed local
preview. Keep the generic CMS workflow and inventory contracts unchanged.

## Entry, scope and resume

- Require Setup's completed audit and explicit continuation into Discovery. Read `context.json` and confirm the exact migration type, source/target sides, selected code/content surfaces, connector IDs, source site name **and** content `RootPath`, database, exact requested languages, repository/revision when code is in scope, and route/device/version scope. Never substitute a repository name for a Sitecore site or content path; never silently default a missing language to `en`.
- Confirm the Discovery plan with the user before remote reads. Target content can remain intentionally unanalyzed when the agreed Discovery scope is source-only; say so in the report, and do not infer target compatibility from source evidence.
- Ask the rendering-root yes/no question; on yes obtain exact full paths under `/sitecore/layout/Renderings`, and on no omit `RenderingRootsJson`. It rejects empty arrays/null. Structural English fallback applies only to definitions, never source content. Variant structure coverage follows the content runbook's explicit limits, including separate Headless Variants reads when needed.
- On resume, inspect manifests and current evidence hashes/counts by branch, site, language and route. Reuse complete current captures; rerun only missing, failed, stale or explicitly requested branches. Keep historical outputs only when their source revision/scope/analyzer version match the current request.

## Parallel source branches

**Content branch — load-bearing for synthesis when content is in scope.** Follow the [native Sitecore content-discovery runbook](../../../../../sitecore/references/discovery/content-analysis.md). That runbook defines bounded SPE capture, attempt-scoped evidence, the eight dependency assessments, serialization planning, report publication/read-back, and the criteria that distinguish successful core Discovery from complete downstream delivery. The worker publishes/read-backs `content-discovery-report` and returns its ID as specified there. `deliverablesReady` is stricter than core Discovery success; use the runbook's conditions and blockers rather than duplicating them here. The profile-level invariant is that synthesis cannot proceed without valid scoped content evidence; target compatibility is not inferred from source-only analysis.

**Code branch — enrichment.** Static source/layout/style analysis runs in parallel
with content inventory. Preserve exact revision, roots, analyzer/runtime version,
file coverage, evidence destinations and unresolved mappings. For XP Headless/JSS,
run the store-free analyzers without waiting for runtime capture. Capture follows
approved rendering scope; it is not a prerequisite for static code analysis and
must not create unplanned mock files. Do not run store-dependent/full-migration
analysis before synthesis has produced its inputs.

Once verified selected-page captures exist, run a bounded usage enrichment over
those explicit files and current static reports. A rendering-coverage plan is
selected to cover rendering+variant requirements, not every source page. Even a
complete selected-page run is not authoritative whole-site route/usage evidence.
Preserve `authoritative:false` and partial/skipped/identity limits as applicable;
absence from a runtime sample never establishes source absence, unused-rendering
exclusions or definitive parent/dependency coverage.

When code analysis reaches a terminal result, idempotently create or update the `code-discovery-report` Kajoo markdown artifact as a concise revision/scope/coverage summary with pointers to retained evidence, and return its artifact ID. Do not inline component paths or analyzer payloads. Artifact publication failure is an explicit code-evidence gap, subject to the generic non-load-bearing code-failure rule; it is never silently treated as complete.

**Capture handoff:** after the content gate and terminal static code result,
synthesize the draft, validate the user's included rendering IDs, and derive the
approved native capture plan. Supply its path/hash and exact source identity to
the Sitecore worker. The frontend worker consumes declared verified successful
files for usage, applicable approved mapping and reviewed local preview delivery;
it does not rerun static discovery, crawl fixture directories or invent routes.
Record captures, failures, warnings and installed files separately. Missing
required content inventory blocks synthesis. Optional runtime failure does not
fail valid core collection; an explicit user deferral with an owner is required
if the requested preview remains undelivered at audit.

For XP MVC, dispatch `sitecore/scripts/spe/get-rendering-source-keys.ps1` once through the Sitecore worker before running `analyze-dotnet.mjs`, retain its status/count/hash and pass its JSON catalog via `--catalog`. This catalog is the input for rendering-to-controller/view/model/resolver joins; do not silently omit it. If the catalog is unavailable after one safe correction/retry, the raw Roslyn scan may still be retained, but `mapping.status=skipped` is an explicit MVC evidence gap and the code branch is not fully covered. Use the retained `analyze-dotnet.mjs`/Roslyn output only when its supported runtime and source evidence are available. Read the MVC analysis reference for deterministic rendering/controller/view/model/resolver interpretation. Native/LSP findings are useful supplemental evidence, not Roslyn-equivalent results; label parser limits, file/line evidence and unresolved bindings. If the source has no C# foundation, classify it as a pure-frontend/misclassified-source case rather than inventing MVC output.

Code failure remains visible but is not load-bearing for synthesis if valid content evidence exists. It leaves requested code coverage incomplete; the code task remains failed until recovered or the user explicitly reduces scope. The workflow lets synthesis wait for a terminal code result through `optionalDependsOn`, then continue after failure. A running or blocked code branch is not terminal and synthesis must wait.

### Code collection acceptance

Use this checklist in the frontend dispatch and its report. It defines the current code-analysis calls and their deliverables. For Headless/JSS, run `analyze-source.mjs`, `analyze-layout.mjs --framework jss`, and `analyze-styles.mjs --source-kind headless` from a writable skill copy with pinned dependencies. For MVC use the semantic producer described above and report unsupported surfaces honestly.

| Deliverable | Required evidence / completion rule |
|---|---|
| Source inventory | Verified root/revision and component-path inventory, exports/imports, package dependencies and actual file coverage. Keep JSX candidates distinct from registered renderings. Inspect omissions and recover missing required source findings with bounded native/LSP tracing. |
| Layouts | Entry points, factory/active mappings, layout source paths, placeholders, structural/route-field and SEO findings. A zero-layout result contradicted by source requires targeted recovery, not an absence claim. Preserve analyzer output alongside supplemental evidence. |
| Styles | Styling system, files/imports, assets and layout import order; record dynamic/runtime limits. Browser parity is later implementation validation. |
| Usage / mock layouts | After approved-plan capture, consume only the coordinator's verified declared successful files and run `frontend-migration/scripts/analyze-usage.mjs --all-routes` over that isolated selected capture root. Retain the route/placeholder/component report and selection limits; selected rendering coverage is not whole-site usage authority. Zero success or pending capture leaves static code collection independent and records a reason/owner. Never promote sample omissions into unused-rendering exclusions. |
| Published summary | Idempotently list/update/create `code-discovery-report` in the current project, then read back its artifact ID, scope and evidence pointer using `get-artifact`. Return that ID in evidence observation and retain publication/read-back evidence locally. A sandbox report alone does not satisfy publication. |

Return `success` when the required rows are satisfied and optional usage is either evidenced or explicitly deferred; preserve partial observations and their owners in the report/summary, not as failed acceptance checks. External package edges are analysis boundaries, not failed local imports. A source JSX count need not equal sampled Layout Service component names. Exact rendering/source joins belong to synthesis and later per-rendering analysis; target implementation mapping, complete graph resolution and browser parity are not unconditional code-collection requirements. For starter initialization, target analysis is not required; adopted-target reconciliation remains a separate conditional procedure below.

An inaccessible required source, unrecovered missing required source finding, unusable analyzer output, or failed summary publication keeps the task unsuccessful. Correct a recoverable tool invocation once; do not hide real failures or change the task's outcome just to make its job green. A report may say **collection complete; runtime enrichment partial**. Required collection gaps remain in `unresolved`; optional sampling, external dependencies and downstream validation remain visible report limitations. Synthesis may proceed after a terminal code failure, but it must retain that evidence gap.

## Adopted-target reconciliation

When the migration scope is full and `context.setup.initMode` is `adopted`, reconcile the adopted target application before synthesis. Run the same bounded source inventory/layout/style analyzers against the target revision, compare stable component/export/file identities and explicit mappings, and write `bootstrap-reconciliation.json` containing source identity, target identity/revision, already-equivalent work, partial implementations, conflicts, missing source/target evidence and analyzer limits. This step is read-only and must not mark work complete from display-name similarity alone. If target identity or required evidence is unavailable, stop and correct Setup context. For starter initialization or non-full scope, record this procedure as not applicable. Synthesis consumes the reconciliation so later phases do not duplicate existing target work.

## Source baseline and enrichment

Capture baseline layouts for the agreed route/language/device scope from actual source Layout Service responses; use [baseline capture](../../../../../sitecore/references/discovery/baseline-capture.md) and its raw manifests/hashes. Preserve failed routes and partial counts. Keep raw responses immutable, normalize with explicit mappings only, and deliver files into the target application's local mock service only within the approved local workspace scope; Discovery does not write to the target Sitecore instance.

Synthesis stays draft-only. After the coordinator validates the user's current
scope decision, call native `buildRenderingCapturePlan(entries,
{ includedRenderingIds })` with the approved IDs and retained configuration-route
entries; preserve the approved artifact/hash separately. Do not flip the draft
flag, recompute fingerprints manually, invent a CLI, or restore removed tools.
Use native `prepare-capture-request.mjs` and the approved selected pages only.
Omitted `maxUrls` or `0` attempts all selected pages; a positive cap counts global
attempts including failures and retries. No extra homepage or sitemap is implicit.
Retain declared bounded recovery chains, processor warnings and unavailable routes.

When Discovery preview is requested, capture and reviewed local delivery are
required attempts in this phase. Use the source mapping inventory plus an
explicitly read target rendering inventory, including successful empty-target
evidence when applicable; an unread target is not empty. Review current
hash-bound keyed mapping decisions before native plan/apply produces derived
copies. Unused definitions/variants remain mapping-only until explicitly selected
for approved synthetic fixtures; synthetic output never counts as real capture.
Prepare selected navigation with explicit plan/result/mapped/example hashes and
install the reviewed stage through its manifest-hash-bound interface. Raw source
evidence remains unchanged. If delivery cannot complete, require an explicit
deferral with a named owner before audit closes with that missing deliverable;
otherwise audit reports requested preview not delivered. Optional capture errors
do not retroactively fail the valid core content gate or draft synthesis.

For MVC, use the recipe-owned `capture-mock-layouts.ps1` serializer contract,
`capture-mock-dictionary.ps1` for relevant dictionary-domain evidence, and
`export-richtext-structures.ps1` for scoped rendering/datasource rich text.
Retain actual locales, source hashes and partial export findings. A missing
capability is a visible gap, not permission to invent REST/GraphQL equivalence.

For MVC-to-XMC work, inspect synthesis coverage for explicit `pending-verification` or unresolved component mappings. Present only those evidence-backed ambiguities to the user as a finite review list, with the relevant source rendering, controller/view evidence and candidate mapping (if one exists). Record the user's include/exclude/scope decision and its evidence in Discovery; no answer or a failed optional capture leaves the mapping unresolved. Never turn a guessed mapping into a complete result. Dictionary enrichment is applicable only when the MVC evidence identifies translation helper usage; retain locale and phrase counts, and report missing locales or failed exports as partial enrichment rather than blocking synthesis or claiming dictionary coverage.

## Synthesis and Sitecore-specific checks

The coordinator joins code and content by stable Sitecore item/rendering IDs, repository symbols/paths and explicit mappings—not display names alone. Preserve repeated rendering occurrences, page IDs/routes, nested placeholder chains, datasource/template references, presentation inheritance and SXA design relationships. Record unmatched renderings, dynamic datasources, personalization, missing definitions, cycles and unresolved joins rather than guessing.

Use the generated discovery manifest as the canonical count source. Separate catalog rows/folders, distinct rendering definitions, renderings used in the agreed site, source React candidates, raw XML entries, SPE shared/final occurrence records and sampled runtime component names. Shared and final views can contain the same UID; adding both is not a unique runtime count, and a resolved final view is not a list of XML deltas. If summaries disagree, reconcile source files, scope and fingerprints and regenerate the summary before audit. Preserve the coverage producer's ranked route order and uncovered-rendering list.

### Canonical local synthesis

Persist the original returned branch TASK_RESULT as `task-result.json` at each declared attempt root before dispatch, preserving the database `taskId` and the separate `workflowKey`. Do not infer success or fabricate a result from file presence. Whole-site content uses `discovery-evidence-manifest.json`, reports under `collector-files/` and coverage embedded in `rendering-page-mapping.json`; normalized recovery uses the assembler's root-level files. The builder supports both directly and verifies consumed hashes/sizes; do not stage renamed copies or rerun remote collection for a layout mismatch. Declare non-default relative report locations using the input fields documented in the Sitecore analysis README. Retain the actual code report paths (`source-analysis.json` or `reports/source.json`, and the corresponding coverage report); never silently discard successful code evidence because a filename differs. Correct a local input/layout defect and retry the specific synthesis task with a fresh output directory, preserving completed content/code tasks and original evidence.

After `discovery.content` has valid core evidence and `discovery.code` is terminal, the coordinator writes the small, path-only `discovery-synthesis-input.json` beside the retained evidence. It names the verified scope and the two attempt roots, then dispatches the Sitecore worker to run `sitecore/scripts/analysis/synthesize-discovery.mjs` once into a fresh `discovery.synthesize/attempt-<N>` directory. The script reads only the declared files, joins rendering records by stable Sitecore IDs, retains the collector's existing route order, and writes a rendering inventory, coverage-plan view, resolver candidates, candidate phase inputs, unresolved findings and a hash-bearing manifest.

The canonical synthesis script accepts the documented collector variants (including a UTF-8 BOM and the current rendering/coverage field aliases) before joining them. It must not be replaced with a project-specific join when that bounded normalization or validation fails: return the exact evidence-schema gap so the recipe can be repaired or the evidence recollected.

This is a local, draft-only operation. It does not query Sitecore, inspect a repository, create workflow tasks or phases, update the Migration Artifact, or authorize later work. Its phase inputs are limited to evidence-backed Code Migration, Content Migration, SXA Conversion and Resolver Adapters candidates. An absent candidate is not a negative finding, and the candidate list is not a fixed workflow. If a material applicability question remains, report it as an unresolved finding; the coordinator may request one separately bounded follow-up only when it could change the proposed workflow.

For any proposed Code Migration scope containing rendering work, include one `preview-foundation` task assigned to frontend-developer and make it an explicit dependency of all render-dependent tasks. This applies to new and adopted apps, including equivalent existing foundations: reuse them and verify current readiness rather than omit the task. Use [preview readiness](preview-readiness.md) for its task description and acceptance. Plan conditional shared-style and remaining integration prerequisites from retained evidence. Requested Discovery capture and reviewed local delivery already belong to this phase; server/browser readiness remains separate unless explicitly requested in Discovery. Do not require future implementation proof to propose the task or defer the requested delivery silently to it.

For code work, the primary migration units are in-scope Sitecore rendering IDs and their used routes, with shared styles/layout/framework work represented separately where useful. Internal React modules support those units. Use the retained style-analysis report, source layout/import evidence and target-baseline evidence to plan one `shared-styles-shell` prerequisite only when shared source entrypoints/import order, common style partials, shell behavior, fonts/icons/assets, build transforms or runtime dependencies are needed by more than one included rendering or the selected validation route and the target lacks an evidence-equivalent foundation. Record the exact report paths/hashes, source and target revisions, selected strategy and owned paths/capabilities. Do not create it merely because CSS exists: component-local styles remain with the corresponding rendering task. If the existing evidence cannot establish equivalence, record a bounded foundation-analysis question instead of letting the first rendering task discover and mutate broad shared concerns. Report unmatched rendering/source joins without inventing a one-to-one mapping; exact React matching and detailed adapter implementation can be tasks in Code Migration. Before asking granularity, show the rendering-based scope and known uncertainty, then offer individual rendering tasks, feature/route batches or milestones. A raw AST candidate count must never determine that question's task count.

After the joined inventory and route plan are written, idempotently create or update the `discovery-synthesis-report` Kajoo markdown artifact. It summarizes included/excluded/unresolved/not-collected counts, the actual route plan, code-to-content matches and evidence pointers; it never replaces the machine evidence or stores raw records. Record its artifact ID for the audit. If publication fails, retain the completed machine synthesis, report the missing summary as a non-blocking deliverable gap, and do not fabricate an artifact ID.

For XMC targets, record evidence-backed XP-only/SXA/platform exclusions as proposals; do not carry XP exclusions into XP Headless migrations by default. Include serialization inputs, item/template dependencies and unsupported constructs that affect content transfer. For each route, keep coverage status and whether it came from full enumeration or sample. Derive likely next phases only after this reconciliation.

Tester audit verifies agreed source sides/surfaces, site/root/language, repository revision, route scope, full-versus-sampled coverage, duplicate or unresolved IDs, serialization/SXA evidence, source baseline usability and the specific failure/deferred counts. Report included, excluded, unresolved, not-collected and sampled counts separately, with evidence paths and the actual route plan. Missing requested content evidence blocks synthesis/Discovery. Missing code evidence may still permit synthesis, but prevents Discovery from being called fully covered until repaired or explicitly reduced from scope.

Discovery requires serialization planning/configuration, included namespaces and evidence-backed exclusion suggestions; an authenticated YAML pull/push is later content work unless explicitly requested here. Optional capture failures, complete React matching and target implementation parity are not unconditional Discovery blockers. Evaluate SXA and resolver signals enough to plan their work: investigate missing information that changes whether a workstream is needed, while assigning strategy/detail validation to that workstream. `synthesisReady` and structural workflow validation are not an audit verdict.

## Content-transfer planning handoff

For the normal Content Migration proposal, compile the core collector's
current, hash-bound `serialization-config.json` once with
`sitecore/scripts/serialization/compile-serialization-scope.mjs`. The resulting
`serialization-scope.json` and `serialization-scope-manifest.json`, supported
namespace list and `xp-only-template-audit.json` are the planning handoff.
Group the generated namespaces into the user-approved Content Migration tasks,
retain their evidence pointers and explicit exclusion proposals, and make the
later transfer task consume that recorded plan rather than rediscovering the
source tree or deciding whether a folder path is recursive.

Do not automatically run normalized dependency enrichment, exact-item scope
compilation or a second whole-site collector merely to show or approve the
workflow. Those operations add a distinct, stricter evidence contract and are
not prerequisites for core Discovery or its standard serialization plan. The
canonical serialization-scope compilation is different: it is a local
normalization of the existing collector output, requires no connector call and
is required before the workflow is approved.
Report any optional normalized evidence already available, but do not turn its
absence or a recoverable limitation into a Discovery blocker.

An exact item binding is justified only when a user-approved transfer task needs
an exact non-namespace scope that the recorded plan cannot represent safely—for
example, a deliberately narrow repair or remap. In that case, perform the
bounded binding as planning for that user-approved transfer task, reuse matching
Discovery evidence first, and retain the resulting hashes, item list and
decisions with that task. It must neither create duplicate tasks nor revise the
approved workflow silently. If the narrow binding is not ready, block only that
task and preserve the normal Content Migration plan.

## Later-phase examples

Read the Sitecore `phase-catalog.json` as non-exhaustive examples. Evaluate source features AND target migration requirements: an XMC/SXA target may need site/module/placeholder/rendering registration even if the source has no SXA page designs. Source resolver definitions, enriched layout fields or integration consumers (for example search) can justify a resolver/integration workstream whose first task validates the target strategy. Full adapter proof is not required to propose that work. Follow unresolved design/template/resolver references with bounded source reads when they could change applicability. If required reads are unavailable, expose the specific planning uncertainty and scope decision instead of silently dropping the phase.

Also consider findings outside the catalog, such as search/integrations, routing/redirects, localization or deployment/acceptance, only when evidence and scope justify distinct deliverables. The example task lists do not prescribe granularity or ordering. Present a candidate applicability table with evidence and deferred checks, then the complete included phase/task/dependency proposal at the user's selected grouping. Obtain `workflow-plan` approval before synchronization, and a separate phase-continuation decision before dispatch. No Discovery approval/continue project task is created.

For an existing Headless SXA no-code scope, use the separate [Presentation Composition workflow](presentation-composition.md) and [Verification](verification.md) catalog entries after the approved content handoff. The synthesis candidate list describes its own output capability; it does not require scheduling Code Migration, SXA Conversion or Resolver Adapters. Reuse its evidence and request only missing normalized source/target presentation, content identity or preview-foundation handoffs from their owners. Do not reconstruct source code or rerun broad Discovery to populate a presentation packet.
