# Phase 4 — SXA Conversion

For no-code migration into an existing Headless SXA site, use [Presentation Composition](presentation-composition.md) instead. This conversion procedure applies only to separately approved provisioning/conversion scope; presentation differences or a blank target alone do not authorize it.

This Sitecore profile provisions a migrated site as Headless SXA. It applies
only when the approved workflow contains evidence-backed SXA work. The approved
workflow decides task grouping; this procedure defines the internal ordering,
evidence and gates for each selected milestone. Load
`sitecore/references/sxa/provisioning.md` for the exact target operations. Do
not replace its scripts with GraphQL, ad-hoc SPE, or a local Bash substitute.

## Step 0 — Entry, resume and parameter gate

1. Confirm Discovery and all workflow dependencies selected for this phase are
   complete and current. Read the current workflow, decisions, task evidence,
   target identity and post-content target paths before dispatching work.
2. Reconcile any existing target SXA state with read-only evidence. The tester
   may verify an already-provisioned site using the target collection/site
   listing plus the read-only module, partial-design and template checks in the
   Sitecore procedure. A true verified result may satisfy the approved task;
   missing or inconclusive evidence means run the ordinary procedure, not
   assumed completion.
3. Read `sxa-conversion-inputs.json` and retained Discovery evidence for the
   source site, current target site path/ID, `renderingsPrefix`, page-template
   IDs, presentation inventory, languages and any known design/placeholder
   hazards. Use this evidence only to identify the candidate target site and
   scope for the next step; do not infer a tenant name, path, prefix or ID.
4. For an SXA entry task, complete one bounded **read-only target
   reconnaissance before requesting a tenant name, rendering prefix, or any
   target mutation**. List the target collections and sites and, when the
   retained evidence identifies a candidate site, its registered modules.
   Reconcile those results with the retained target identity and Discovery
   inputs, then report only concrete tenant-collision, site-adoption and
   module-prefix facts. If the candidate site or target identity cannot be
   established, return blocked rather than derive it from a source path. Do
   not enumerate unrelated target content or repeat source Discovery here.
5. Collect one explicit **decision bundle** from that reconnaissance before the
   first target write. It must include every known tenant-name,
   collision/adoption scope, source-repair and migration-scope choice that can
   change the first mutation. A recon result is not mutation approval.
   `tenantName` is always an explicit user choice; never derive it from the
   source path or repository. Ask only for values that remain unknown.
6. Required inputs are a supported target connector, target flavor, target site
   identity or a scoped site-adoption plan, tenant name, and `renderingsPrefix`.
   A missing required input is a hard blocker for the step that needs it. It is
   never an invitation to guess a path, prefix, ID or tenant.

Record the resulting scope and evidence fingerprints before the first target
write. A safe invocation-shape failure may be corrected and retried once after
reading its terminal error; an invocation failure is not evidence that the
target platform lacks the capability.

## Ordered milestones and acceptance

The coordinator may make these separate approved project tasks or group nearby
milestones into one reviewed deliverable. It must preserve the dependencies and
all gates below. Tenant setup and rendering registration are the only operations
that may run in parallel.

| Order | Milestone and required result | Failure policy and gate |
| --- | --- | --- |
| A1 | **Tenant Setup:** ensure the requested headless collection/tenant and read back its exact ID and content path. | A missing target connector, rejected tenant choice or failed collection operation is hard-blocking for adoption. |
| A2 | **Rendering Registration:** register the approved rendering folders, run rendering-parameter repair sequentially for every registered module, then list modules and retain every registration result. | A complete failure is hard-blocking. A `partial` result must surface affected modules and ask the user whether to repair, reduce scope or continue with a recorded limitation; never silently report registration complete. |
| B | **Site Adoption:** move/adopt the exact approved site, update references and page-template inheritance, and re-read the resulting target ID/path. | Adoption failure or identity/path mismatch is hard-blocking. Present the move, changed references and backup/read-back scope in a compact table. Obtain adoption approval before mutation and user confirmation after read-back before conversion. |
| C | **Site Conversion:** convert only the adopted site to the confirmed Headless SXA flavor, apply approved modules, and retain the conversion/module results. Read back the target `Presentation/Available Renderings` materialization for every applied or previously-present module. | The site must already be under the tenant. A failed conversion, missing module result, post-setup error, missing target materialization, or `ModuleErrors > 0` leaves the milestone incomplete; surface it for repair or stop. A Modules-field definition ID alone is not materialization proof. Verify the shared-data safety result is item-cache-only and has no Link DB rebuild. Obtain confirmation before presentation work. |
| D1 | **Presentation Setup — analysis and partial-design plan:** run the canonical discovery script against the agreed template scope and preserve its full plan, counts, compatibility classifications, unresolved page overrides and deterministic names. Present a table of composition, affected templates/pages, exclusions and proposed human-friendly names. | No target mutation occurs before the partial-design plan approval. A partial/full-pattern disagreement, missing template coverage or unresolved PD-incompatible page is a scoped decision or `needs-redo`, never a fabricated common pattern. |
| D2 | **Presentation Setup — Page-design plan and mapping:** create/read Partial Designs using the approved `nameMapping`, then present the Page Design composition, TemplatesMapping, page-level overrides and excluded anomalies. After approval, create designs, assign mappings and read them back. | The confirmed partial-design names must be the names used by page-design composition. A mapping that cannot be applied, verified, or connected to the expected design is `needs-redo`, not a warning. |
| E1 | **Presentation migration dry-run:** make a scoped backup plan/fetch before mutation, then run the canonical migration script with `mode=dry-run` and `scope=both`. Preserve per-template/page strip, preserve, skipped and failed counts with the full signature evidence. The page forecast must simulate the preceding SV strip and report `SimulatedInheritedSvRenderings`, so inherited merged-layout copies are not counted again as page mutations. | No target mutation occurs before the dry-run approval. A missing backup, missing TemplatesMapping, nonterminal job, unexplained skipped item, unsafe signature mismatch, or unexplained dry-run/execute count divergence blocks execution until resolved or explicitly excluded. |
| E2 | **Presentation migration execute and verification:** after explicit approval, execute the same reviewed scope with `scope=both`, re-read assignments and affected presentation, then show executed/no-change/skipped/failed counts. | A terminal failure, unknown target state or read-back mismatch stops this milestone. After the user reviews the result, offer **Verified**, **Roll back**, or **Report issues**. Roll back uses only the scoped backup; a restore failure stays visible and stops further migration. Report issues returns `needs-redo` with the exact evidence and user concerns. |
| F | **Coverage audit and phase report:** the tester independently checks the approved scope and current target state. | An observed mismatch or missing required verification blocks phase completion unless the user records a deliberate scoped reduction. |

## Presentation safety contract

`xmc-discover-presentation-patterns.ps1`,
`xmc-create-partial-designs.ps1`, and
`xmc-migrate-to-page-designs.ps1` share the rendering-signature contract:
rendering definition ID + normalized datasource + normalized parameters. Keep
the executable bodies unchanged and use their reported normalization/version
values as evidence.

- Preserve the analysis plan as an evidence artifact before any Partial Design
  write. It must distinguish template defaults, page-level overrides,
  PD-compatible composition, PD-incompatible items, skipped/ghost surfaces,
  and editor-review exclusions. Full final-layout inspection is authoritative;
  a referrer search or display-name count does not establish composition.
- Before E2, inspect the dry-run for datasource or parameter mismatches. A
  rendering that does not signature-match remains preserved. If a mismatch
  would leave a duplicated or otherwise unsafe composition, return
  `needs-redo` with the affected IDs and evidence; do not invent a patch
  script or silently strip it.
- Default-language scope is the standard SXA execution path, matching the
  canonical presentation scripts. Inspect `__Renderings` and
  `__Final Renderings` for non-default language/version-specific layout deltas.
  Record each observed non-default delta as a non-blocking deferred finding with
  its language/version and affected scope. Do not block E1/E2 or request a
  language-scope decision solely because such a delta exists. It becomes
  in-scope only when the approved workflow or the user explicitly selects
  multilingual presentation migration. A default-language result verifies only
  its approved default-language scope; the final report must list deferred
  non-default variants separately.
- Page-specific content and a reviewed exception are valid preserve outcomes.
  Do not force them into a Partial Design merely to increase strip counts.

## Evidence and human interaction

For every milestone, retain the terminal connector result, exact target
IDs/paths, script name/hash, input scope, mutation approval, changed item IDs,
read-back and unresolved findings in the assigned evidence directory. Create a
concise user-facing planning or audit artifact for D1, D2, E1 and F with
tables and explicit ✅ verified, ⚠ deferred, and ❌ failed/mismatched status.
Workers return one task result; the coordinator alone updates shared workflow
state and records approval decisions.

An approval record authorizes only the operation, target IDs/paths, and scope
shown in its prompt. Do not replace the approved repair method with a different
one without a new explicit execution approval. Start a fresh worker context for
each workflow task; reuse a worker continuation only for a retry or remediation
of that same task.

A `partial` task result must ask the user whether to repair, reduce scope or
continue with the limitation recorded. A `failed` result must stop the affected
path and surface the terminal evidence. A timeout or canceled job may have
partially mutated the target: inspect current target state before retrying and
do not replay a successful write merely to make results uniform.

## Exit audit

The independent tester receives the approved scope, expected tenant/site IDs,
registered modules, approved Partial/Page Design composition, TemplatesMapping,
backup/restore decision and all current evidence. It verifies, read-only:

1. target collection/site identity and adopted path;
2. every expected rendering module and parameter repair result;
3. Partial Designs, Page Designs and TemplatesMapping assignments by stable ID;
4. preserved versus stripped presentation for representative templates/pages,
   including documented datasource/parameter and language/version exceptions;
5. content reachability and representative rendered-page checks where the
   available target capability supports them.

The final report separates verified, preserved by design, user-approved
exceptions, deferred checks, failed checks and unavailable checks. Do not call
SXA conversion complete from a job success, a static count, or a prior target
timestamp. Once the audit passes, complete the active SXA task/phase and ask
the user conversationally whether to continue to the next approved phase,
pause, or use a new chat; do not create a synthetic continuation task.
