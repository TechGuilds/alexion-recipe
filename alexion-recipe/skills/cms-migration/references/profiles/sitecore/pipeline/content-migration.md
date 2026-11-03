# Phase 3 — Content Migration

## Content-transfer selection

Before proposing this phase, the orchestrator follows [content-transfer selection](../../../../../mapped-content-migration/references/content-transfer-method.md#select-the-content-transfer-method). Full/discovery-only workflow scope is separate from mapped/native content transfer. Mapping-required scopes use mapped-content. A no-mapping answer requires a specialist's evidence-bound source/target compatibility check and explicit user confirmation before native serialization. Missing evidence or required transformation blocks native selection. The two catalog entries describe alternative implementations of one Content Migration phase; do not schedule both.

## Optional media packages for mapped content

Before media work, the coordinator records the actual evidence-bound `scope` decision (`migrate-media` or `skip-media`) with planning task, scope, timestamp and user response. For mapped opt-in, user-confirm exact Media Library paths and descendant selection, then follow [media migration](../../../../../mapped-content-migration/references/media-migration.md). Schedule `content.media-prepare` — **Prepare media migration packages** — and `content.media-install` — **Install and verify media migration packages** — before the original eight content tasks. Skip preserves eight tasks and decision evidence; target media references still require verification.

The `.update` adapter requires verified XP/XM live package/export-scope/original-binary/restore proof, a hard actual archive cap of 100000000 bytes, connector file transport, separate exact target mutation review and independent final readback. SitecoreAI requires another adapter. Unchanged media IDs feed current approved destination bindings without entering content transformation or replacing its checkpoint. This does not publish or establish website parity.

## Content transfer method precedence

Require `contentMigrationMode: mapped-content` or `contentMigrationMode: native-serialization` in the assigned packet, bound to the current coordinator decision. Missing or contradictory method evidence is `blocked`. This method guard takes precedence over the native procedure below. For `mapped-content`, follow `mapped-content-migration/SKILL.md` and its available capture, transformation and dry-run procedures. Never substitute native serialization transfer or aggregate count audits. Explicitly assigned mapped target execution uses `mapped-content-migration/references/target-execution.md` with exact review, existing mutation approval, verified capabilities/backups and durable receipt checkpoints. Reference planning follows `mapped-content-migration/references/reference-resolution.md`, binding the immutable current checkpoint and fresh observations; reference-only writes use the same preparation/writer/recorder with `operationKind: references` and exact approval. Missing or ambiguous dependencies block all batches. An explicitly assigned independent content audit follows `mapped-content-migration/references/target-verification.md`, requiring canonical whole-output comparison and fresh bounded provenance-bound target readback. Read scope/hash approval uses existing coordinator decisions; no mutation approval or write/backup capability is required for reads. Mapped-content workflow integration requires explicit workflow-plan approval through `mapped-content-migration/references/workflow-integration.md`. Use the scoped [workflow integration procedure](../../../../../mapped-content-migration/references/workflow-integration.md) for a reviewed proposal; this dispatch guard alone never installs tasks or advances phases.

For approved mapped-content workflow integration, follow `mapped-content-migration/references/workflow-integration.md`: preserve active work and Discovery inventory, add logical operations only, approve/validate/materialize/synchronize the proposal and require separate phase-continuation. Use supported `mappedContentInputs` to derive `packet.mappedContent`; validate actual operation outputs with `validate-mapped-outcome.mjs` and `evidence.kind: mapped-content-operation` before shared postflight. Preserve next-work user attestations and the final `content.approve` gate.

For either content transfer method, pass the current approved scope decision as `contentMigrationDecision` to the supported `prepare-task-packet.mjs` producer. It derives `contentMigrationMode` from the decision choice and verifies declared scope/task/input bindings. Do not hand-edit the packet.

The remaining procedure applies only to `native-serialization`.

This Sitecore procedure transfers the approved Discovery scope through source
serialization capture and dependency-ordered target application. It starts only
after Setup and Discovery are complete, the phase is active in the approved
workflow, and the source and target content connectors are both selected.
Delegate each remote or serialization work item to `sitecore-developer`.

## Deterministic task entry

The coordinator creates one phase-level shared capture foundation before it
dispatches target transfer work. Its packet is the only initial source
of scope: it references the current Discovery `serialization-scope.json` and
its manifest, all approved namespace/task grouping, target-adoption evidence,
connector roles, decisions and compatible prior-attempt manifests. It may
additionally reference an approved exact item binding for a deliberately narrow
operation. Begin by validating those references locally,
then execute only the packet's declared bounded stage range. Do **not**
enumerate a source root, summarize arbitrary sandbox files, inspect unrelated
configuration or create helper scripts to infer a missing scope. Return
`blocked` with the missing/stale reference when the packet is insufficient.

For the normal first preparation attempt, a single worker run executes stages 1–4 as one bounded non-mutating group for all approved transfer tasks. It
produces the shared capture manifest, prepared CLI project manifest,
transfer-preflight and global batch plan. Each later transfer packet references
those exact hashes and only selects its already-assigned batches. Stage 5 needs
its explicit target mutation decision, and stage 6 begins only after all
approved target transfer evidence is current:

1. **Scope and capability preflight** — validate the approved canonical
   Discovery scope and manifest hashes, prepare one phase CLI project, and perform the
   source CLI probe. Do not compile or revise task roots here.
2. **Source health** — reuse Discovery's duplicate report when it matches the
   full approved scope. Only when it is absent or stale, run one bounded
   duplicate detector; never replace this fallback with source-tree enumeration.
3. **Source capture** — configure and pull the full recorded serialization
   scope once. The pull authenticates within its wrapper invocation.
4. **Local transfer preflight** — run Sitecore CLI `ser validate` against the
   prepared capture, then inspect the shared capture, validate all task
   ownership and dependency closure, prepare any separately approved remap
   preview, and create one global `plan-batches.mjs` result. Sitecore CLI validation is authoritative for Sitecore-generated serialization syntax;
   local inspection retains compatible parser warnings as evidence.
5. **Target transfer** — after its explicit scoped mutation decision only,
   locally validate the prepared inputs, dry-run, push the assigned
   dependency-ordered batch or batches, then read them back.
6. **Audit** — run fresh tester evidence only after every approved transfer
task has current read-back evidence. Reuse those current batch manifests for
complete item coverage, then execute the Sitecore aggregate target-count probe
once; do not reopen source capture, rediscover the scope or issue serial remote
item reads.

Use automatic terminal delivery for a long-running connector job. Query a job
status only to recover a missing automatic result or inspect the single known
job after an interrupted attempt; never poll completed jobs as normal progress
or start a duplicate request while its terminal result is pending.

## Ordered work

These are execution checkpoints, not a requirement to create one user-visible
task per row. A normal approved workflow first creates one **Prepare shared
validated transfer** foundation for checkpoints 1–4, then creates the
user-chosen namespace, site-section or milestone target-transfer tasks and an
audit task. The user-approved task boundary stays stable: it controls review,
approval and target mutation order, not whether the source is recaptured. Do
not create a standalone scope-reconstruction task: Content Migration reuses the
approved Discovery configuration and validates it locally.

| Order | Work item | Acceptance evidence | Gate |
| --- | --- | --- | --- |
| 1 | **Conditional target adoption evidence** | Reuse current read-only target records for exact IDs, templates, fields, languages and versions in the approved scope; collect a bounded probe only when absent, stale or insufficient for the intended target mutation. | Existing items are not treated as migrated merely because they exist. |
| 2 | **Shared serialization project and capability gate** | One fresh CLI project/config manifest for the full approved scope, verified connector identities and source CLI/version/plugin probe. | Missing source pull or target push capability blocks the corresponding transfer. |
| 3 | **Approved Discovery scope and decisions** | Current canonical `serialization-scope.json`/manifest, all transfer-task grouping, explicit approved exclusions/external prerequisites, target flavor and template remap decisions. | Missing/stale scope, unapproved exclusion/external prerequisite or unresolved target flavor blocks the shared foundation. There is no automatic exclusion. |
| 4 | **Conditional duplicate health, shared source pull and local validation** | Reuse matching current duplicate health; otherwise one bounded detector. Capture the full exact approved scope once, run Sitecore CLI validation, then validate YAML/module ownership, count comparisons, structural dependency closure and approved remap preview. | Duplicate identity, authentication failure, failed Sitecore CLI validation, unsafe task ownership/dependency closure, unapproved structural external dependency/remap or unexplained material count loss blocks every target transfer. |
| 5 | **Dry-run, sequential target push and read-back** | For the selected task only, locally validate the shared capture, dry-run its exact namespace batch, obtain explicit mutation approval, push and retain read-back evidence. | Execute batches sequentially; a non-no-op batch never advances without current approval. |
| 6 | **Tester audit** | Fresh aggregate target-count evidence bound to every current batch read-back. Batch manifests retain the required material-field, language/version, dependency and representative-page evidence. | Any observed mismatch blocks phase completion unless the user explicitly changes the approved scope and records the gap. |

## Execution rules

1. Keep the shared source capture, transformed local copy and target read-back
   evidence in distinct directories. Resume only from a manifest whose input
   hashes, connector identities, exact namespaces and approvals still match.
2. Before source pull, validate the approved canonical Discovery scope's current
hashes, includes, exclusions and task namespace grouping. Task grouping is a
   delivery/review boundary, not a reason to omit a recorded namespace. A
   missing or stale configuration is a Discovery planning failure: return to
   Discovery planning to correct the approved scope before any source or target command;
   do not construct a new task plan in this phase. For an explicitly exact-item
   task, also validate its bound item list and hashes.
3. Configure modules from the full recorded canonical include plan once, capture source
   YAML once, run Sitecore CLI `ser validate` without connector credentials, then
   run `validate-transfer-plan.mjs` against the captured YAML/modules. The CLI
   validation is authoritative for Sitecore-generated serialization syntax; local
   parser warnings are retained rather than treated as malformed source. This
   preflight binds the complete reviewed task plan to the actual capture. Repeat
   the shared foundation only after a material approved scope, remap or
   task-boundary change; it never contacts either Sitecore instance.
4. Only parent, item-template and base-template relationships form structural
   ordering edges. Soft references must not form ordering edges. GUID-shaped references in ordinary serialized field values are
   soft references: retain and report them for target parity and scoped follow-up,
   but do not use them as ordering edges, require an external-prerequisite
   decision, enlarge the approved scope, or block a transfer preflight solely on
   their presence.
5. Use the Sitecore-native procedure for project preparation and authenticated
   transfer. Source pull attaches only the source connector. Local validation
   needs no connector. Target dry-run and push attach only the target connector.
   Connector secrets never enter command arguments, parameter files, reports,
   decisions or artifacts.
6. Use `plan-batches.mjs` only to form ordered internal execution batches from
   the validated capture. Keep the user-approved task boundary stable while
   executing those internal batches sequentially; a timeout or partial batch
   resumes only its unresolved exact namespaces after target inspection.
7. Inspect partial remote effects before every retry. Preserve successful batch
   evidence and re-run only the unresolved batch; do not replay a completed
   namespace to make the report look uniform.
8. A failed duplicate, template, authentication, timeout, namespace or item
   result must retain the raw sanitized evidence and its classification. Do not
   turn an empty result into a successful no-op, and do not fabricate item
   mappings from a failed capture.
9. For target flavor `xmc`, review compatibility candidates through the
   Sitecore exclusion procedure. Candidate paths are not exclusions until a
   user-approved decision records their evidence, descendants and consumers.

## User review

At each mutation boundary, show a compact table with batch namespace(s),
requested/pulled/pushed/already-present/skipped/failed counts, preview outcome,
affected templates or exclusions, and unresolved IDs. Ask only for the scoped
decision needed next: remap/exclusion, mutation approval, recovery choice, or
scope revision. A no-op batch is recorded as a no-op; it does not become an
unobserved successful push.

When a task result is staged for generic evidence validation, require only the
applicable, vendor-neutral evidence kinds for that task. The scope/preflight
task requires `source-health` and `transfer-preflight`; each completed target
transfer task requires `dependency-closure`, `language-version-parity` and
`target-parity`; the final audit additionally requires `terminal-audit`. The
terminal audit is a fresh, immutable manifest for the current approved scope.
It identifies the source-health report, current preflight, every target-parity
result, the latest target mutation or no-op batch evidence for every task, and
any superseded audit reports. Reject a narrative-only audit or one that predates
the latest target mutation. Never select an earlier blocked report as a final
result after remediation.

## Exit

The tester compares target content to the approved scope using stable IDs,
templates, selected fields, languages/versions, dependency references and
representative pages. Retain every mismatch and unresolved item in the phase
result. The phase can complete only when the current terminal audit reports no
mismatch against the approved scope; otherwise it remains blocked or awaits a
scoped user decision. Present a final table showing source duplicate-health,
per-task expected versus observed language/version coverage, dependency
closure, target parity, and any approved out-of-scope findings.
