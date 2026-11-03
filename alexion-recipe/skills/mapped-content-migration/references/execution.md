# Content Migration execution runbook

## Availability and ownership

Use the [script inventory](../scripts/README.md) for available operations and [operational boundaries](operational-boundaries.md) for common capability requirements and exclusions. A missing script or capability returns `blocked`; do not generate an ad-hoc replacement, substitute serialization transfer or claim execution from fixture results. Mapped-content workflow integration requires explicit approval through [workflow integration](workflow-integration.md).

The coordinator supplies the assigned task, attempt/result paths, allowed operations, reviewed inputs and scope, selected connector identities/capability evidence, current decision references and prior attempt evidence. It records user decisions and projects validated outcomes into the shared workflow. The specialist executes only that task and owns its attempt evidence. The tester performs independent verification. Task grouping remains the user's review boundary; it is not a reason to recapture the same source for every batch.

Use [task-results](../../cms-migration/references/task-results.md), [executable contracts](../../cms-migration/references/executable-contracts.md), [checkpoints](../../cms-migration/references/checkpoints.md) and the [Sitecore operations convention](../../sitecore/SKILL.md) for their mechanics. Missing approval, backup or result-recording capability blocks the corresponding operation. Do not introduce a second approval format or fabricate a restore reference.

## Entry — establish the assigned boundary

1. Read the task and the exact context, decisions and artifacts named by its packet. Confirm the selected content transfer method is data migration into existing target definitions. Do not search the workspace or repeat Discovery to reconstruct missing scope.
2. Confirm source and target role/connector/instance/database/site identities and exact item roots, languages and version policy. They may refer to one instance; writes must still stay inside the approved target scope. Reuse current Setup capability evidence, requesting only missing or stale checks.
3. Check that Setup, Discovery and mapping/destination approval evidence covers the assigned scope. A conversational claim that mapping was previously approved does not establish a current approval. The coordinator must bind the actual artifacts and revision.
4. Check prior attempt results and the known remote-job record before submitting anything. A pending or unknown job must be reconciled under [recovery](recovery.md).
5. Present the bounded next step and obtain the required read/continuation decision through the coordinator. Local inspection does not authorize remote capture or target writes.

**Before a source snapshot exists**, inspect the actual source scope, mapping, target inventory and destination documents individually against the [input contracts](input-contracts.md). The exported `validateSchema` function supports individual structural checks; it is a library function, not another CLI flag. Do not fabricate an empty source snapshot or hash just to satisfy the full manifest. These checks cannot prove cross-file readiness or authorize capture. Use [source snapshot preparation](source-snapshot.md) to assess existing evidence and generate only the missing reads. Remote capture still requires current approval and verified source connector capability.

Once capture exists, the coordinator supplies `migration-input.json` selecting exact relative artifact files and their SHA-256 values. Run the implemented validator from the writable skill's `scripts/` directory:

```sh
node validate-inputs.mjs --input /workspace/migration-input.json
```

Use the actual packet-provided manifest path; the path above illustrates the sandbox command. Retain stdout/exit status in a fresh assigned evidence file without editing the artifacts. Exit 0 and `valid: true` prove only the checks described by the [validator interface](../scripts/README.md). Synthetic fixtures are for local testing, never production scope or migration approval.

## Media — optional packages before content capture

The coordinator first records the actual `migrate-media` or `skip-media` answer. Follow [media migration](media-migration.md) for exact user-confirmed paths/descendants, verified XP/XM runtime pilot, source package preparation, connector transfer, separate per-package target mutation review and independent binary/metadata verification. With opt-in, complete `content.media-prepare` and `content.media-install` before the original content sequence. Without opt-in, retain the skip evidence and still verify any target media dependencies used by references. Media packages preserve unchanged IDs and stay separate from content transformation and content checkpoints.

## Capture — one reusable source snapshot

**Requires:** approved capture scope, current source read capability and an available capture implementation. **Produces:** immutable source snapshot, capture coverage/provenance and manifest for all assigned batches.

Follow the implemented [preparation and capture procedure](source-snapshot.md). It supports both the legacy snapshot input and a manifest referencing bounded JSONL parts, with separate integrity and coverage validation. Preparation only generates remote requests; the specialist submits them through the approved source connector after coordinator review.

- Reuse a completed or partial capture only when source identity, database, requested roots/items, language/version policy and confirmed source-state evidence still match the approved task. Recalculate coverage and fetch only missing/stale values. Otherwise request a bounded refresh decision. Never silently combine captures from different source states.
- Capture actual field values, IDs, parents, templates, references and agreed languages/versions once. Capture full required fields and explicit empty values; missing data is not empty content. Preserve raw values and field sharing semantics.
- Include the source rendering-instance context needed by approved parameter-to-datasource mappings. Preserve page, UID, device, language/version, datasource and parameter-template identity without assigning target presentation.
- Reconcile requested, captured, excluded and failed items/versions. Preserve external dependencies and missing references. A failed or incomplete required capture blocks affected transformation; do not declare discovery summaries to be full field snapshots.
- Retain immutable source evidence separately from transformed plans and target read-back. Let the user review capture coverage before the next step; do not re-run capture merely because the approved task group changes.

## Transform — deterministic local item definitions

**Requires:** validated snapshot, target definitions, approved mapping/destination revision and an available transformer. **Produces:** `item-plan.json` with exact input hashes, output identities, target templates/paths, scoped fields, relationships and issues. No Sitecore writes.

Follow the implemented [local transformation procedure](transformation.md) and its exact request/CLI contract. A ready plan is local review evidence; it does not establish current target state or permission to apply it.

- Apply only supported `map`, `set` and `remove` actions by field ID. A base template declares inherited fields; write those fields on the mapped item, not a newly created base-template item. Report incompatible field types, sharing or language/version conversions that lack an explicit rule.
- One source item may produce several output roles. Preserve individual source items when their template types map to one target type. Version 1 does not consolidate distinct content items or replicate the same target template into several roles. Report unsupported cases to the mapping owner; do not infer missing rules.
- Expand only the supported destination tokens. Resolve parents, sanitize names, check the target root and detect resolved path/ID collisions. Missing explicit folder definitions block the affected outputs. A `branchId` destination returns `branch-unsupported`; branch-generated child topology is not available to the transformer. Do not invent a content tree or create definitions.
- Keep page-local identities tied to their consuming pages. Global identities are reused across consumers. Conflicting occurrence parameters on a shared datasource require an approved split/output rule or a reported conflict.
- Parameter rules do not create content items. Retain their source snapshot context and approved mappings for Presentation Composition; `item-plan.items` has no parameter-output representation. A parameter-to-datasource mapping needs the captured rendering context; never read a nonexistent parameter-template content item or guess from template names.
- Preserve the source snapshot and persist a fresh plan. Repeated transformation with identical inputs must give consistent target identities and values. Present issues and the proposed tree for review.

## Dry-run — classify changes and plan batches

**Requires:** transformed plan, sufficient current bounded target evidence and an available comparison/batch planner. **Produces:** target comparison, before-state fingerprints, dry-run differences, dependency-ordered batches and review evidence.

Follow the implemented [dry-run procedure](dry-run.md). It requires verified supplied target observations; a remote target exporter for this format is not packaged. Review-only batches are not executable permission.

- Classify each output as create, update, reuse, exclude or conflict. Existence alone does not prove equivalence; absence from a partial inventory does not prove nonexistence. Collect only the target evidence needed to settle the exact planned writes.
- Show item paths, templates, changed fields, local/global datasources, explicit folder creation and unresolved dependencies. `reuse` means verified compatibility, not permission to update. Name collisions block; automatic renaming, deletion, merge or overwrite is not defined.
- Order item creation by required parent dependencies. Use approved explicit folder/item rules for the hierarchy; branch expansion and automatic branch-child reuse are unsupported. Reference edges are resolved in a second pass so circular links do not prevent item creation.
- Produce bounded batches without changing the approved scope. Target-sensitive before-state and input hashes belong to the review. Unresolved reference targets must be resolved or explicitly handled through the approved scope; do not silently preserve invalid source IDs or strip links.
- Ask the coordinator to present the dry-run and record current mutation approval against the exact plan hash, target instance/database/root and selected batches. Mapping approval, phase continuation, a passing validator and an old approval are not substitutes. Any material change requires a refreshed plan/review.

## Execute — apply approved item batches

Follow the implemented [target execution and journal procedure](target-execution.md). It first emits an unapproved review, then requires the existing coordinator mutation decision for the exact review before reserving a request. Use the supported recorder for initialization, submitted/unknown and terminal transitions; never create a parallel checkpoint store.

**Requires:** available writer; verified target capability; current plan/batch approval; unchanged before-state; recoverable remote item backup. **Produces:** terminal job evidence, per-item results and checkpointed identity bindings.

- Follow the selected connector's documented operation and parameter contract. SPE executes remotely through the correct role's connector. Local scripts process files; they do not authenticate to Sitecore through invented endpoints or credential files. Missing write capability blocks the batch.
- Revalidate the exact inputs and target identities immediately before writes. Compare target before-state with the reviewed dry-run. Drift returns the affected scope for replanning and approval.
- Preserve existing target values/versions in an appropriate remote backup before updates. Track the actual planned content and explicit folder creations for scoped recovery; do not infer branch-generated descendants. Confirm restore capability before writing; a Git checkpoint cannot substitute for an item backup.
- Submit each assigned batch once and retain the request fingerprint, connector identity, job ID, approval/backup references and terminal response. These are attempt evidence, not another workflow-status store. Use automatic terminal delivery; recover the same known job if delivery is lost. Never repeat a pending or unknown write.
- Checkpoint source/output/context-to-target identity bindings and actual per-item outcomes durably as results arrive. A preallocated target ID is not proof of successful creation. Independent batch/task boundaries remain as approved; do not advance dependent work from partial success.
- Preserve success, failed, skipped and reused counts separately. Partial writes remain visible even if the task cannot complete. Present the batch outcome for user review before continuing.

## Resolve - update references after item identities exist

Follow [reference resolution](reference-resolution.md) for the exact input, dependency, supported-format and recovery rules. It requires the original content planner input, immutable current checkpoint and fresh owner/dependency observations. Missing, ambiguous or partial dependencies block all mutation batches. Preserve ordered references and explicit split-output selection; use approved existing media/content dependencies rather than initiating an unplanned transfer.

The local `plan-references.mjs` proposal feeds the same guarded writer and recorder using `operationKind: references`. Obtain exact review/mutation approval before writes; this pass creates no items or versions. Rendering-instance datasource assignments and presentation fields belong to Presentation Composition.

## Verify - independently compare the whole agreed content scope

Follow [target verification](target-verification.md) for canonical reconstruction from original source/mapping inputs, exact read-request approval, bounded fresh target capture, comparison rules and retained evidence. Supply the original content input, current immutable checkpoint and read-only capability proof; writer receipts cannot substitute for independent observations.

Check every agreed output, including fields, versions, references, explicit folders, local/global sharing and verified identities. One-to-many output counts can differ from source counts. Preserve success, failed, skipped, reused, excluded and unresolved evidence separately; an assigned ID or aggregate count is not proof of success. Required differences prevent completion. Present the independent report for human confirmation; this audit does not establish visual, functional, presentation or media binary parity and does not advance shared workflow.

## Handoff — record task results and downstream identities

Persist the seven-field result specified by [task-results.md](../../cms-migration/references/task-results.md): `taskId`, `outcome`, `summary`, `evidence`, `changedFiles`, `checkpoint`, `unresolved`. Outcomes remain `success`, `failed`, `blocked`, `needs-redo` or `skipped`. Missing required input/script/capability/approval is `blocked`; executed checks or writes that failed remain truthful `failed`/`needs-redo` results with their partial effects.

Use the existing schema/library validation and the coordinator-provided postflight described there. Do not fabricate a request or change a truthful non-success result to satisfy postflight. Keep detailed artifacts under the assigned `evidence/<task-id>/<attempt>/` location, read back the saved result, and update the task's Technical report through the existing task-management procedure.

`changedFiles` lists actual changed target repository files. Do not put remote item IDs or Sitecore paths into `changedFiles`. When there are no target repository changes use `changedFiles: []` and `checkpoint: null`; remote writes still require explicit remote backup/restore and mutation evidence. Do not overload a Git checkpoint with invented remote scope. Capture-created evidence files are linked under `evidence`, not presented as application edits.

Remote evidence includes connector role/ID, instance/database/site, scope, exact script/request provenance, job ID and terminal status, approved plan/batch hashes, backup/restore references, affected item IDs and per-item outcomes. Preserve partial effects on every outcome. A missing remote-backup/result adapter is a required dependency, not permission to make a successful envelope appear read-only.

The handoff provides the immutable source manifest, approved mapping/destination revisions, selected plan and batch evidence, verified identity map, reference results, verification coverage and unresolved gaps. Presentation Composition uses verified IDs and the separate source presentation evidence; it must not infer datasources from names. Only the coordinator projects validated results into shared workflow status and records the next user continuation.
