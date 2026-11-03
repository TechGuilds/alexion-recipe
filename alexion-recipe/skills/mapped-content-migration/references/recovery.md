# Recovery and resume

## Current boundary

Use the [operational boundaries](operational-boundaries.md) and [script inventory](../scripts/README.md) for supported capabilities. Recovery uses the existing [target execution](target-execution.md) journal for initial writes and separately planned [reference updates](reference-resolution.md). A verified external scoped restore capability is required before writes; automatic restore is unavailable. Return unavailable recovery operations as `blocked`, preserving partial effects; do not construct an ad-hoc restore script or substitute serialization push.

Use the [checkpoint rules](../../cms-migration/references/checkpoints.md), [task-result contract](../../cms-migration/references/task-results.md) and coordinator-owned decisions/workflow mechanisms. Verify that the assigned execution mechanism supports scoped backups, durable operation records and restore. Missing remote restore capability blocks target writes; report it before mutation.

For local transformation, follow [transformation recovery](transformation.md). Retain immutable outputs, use a fresh attempt directory and preserve prior verified identities. Proposed bindings are not successful-write checkpoints.

For local planning, follow [dry-run recovery](dry-run.md). New target observations require a confirmed state cohort and fresh output directory. Review artifacts and fingerprints cannot substitute for backup or execution approval.

Before another target operation, reconcile the same persistent local journal, known request/job and server journal/backup evidence through [target execution](target-execution.md). Reserved, submitted or unknown requests block resubmission. Do not clear journal/root locks or initialize a new state directory to evade uncertain effects.

## Inspect before resuming

Read the same task/attempt, current decisions and declared prior evidence. Compare source and target instance/connector/database/root identities, input file hashes, mapping revision, output plan, batch selection, approvals, remote jobs, backup references and target read-back. Preserve historical evidence; resume into a fresh attempt whose provenance points to the selected prior attempt. For source capture, follow [snapshot resume](source-snapshot.md): verify matching source-state evidence and reuse previous parts or downloaded capture records in a new preparation request. Do not silently replace the source snapshot, selected result or identity map.

Identity bindings, source captures, terminal jobs and target read-back have different meanings. A target ID in an identity map may have been allocated before a write; it is not existence evidence. A failed task can contain some successfully written items. Inspect each affected output before deciding what is safe to repeat. Reuse verified completed work with matching inputs instead of redoing the whole migration.

## Failure and drift decisions

| Observed state | Required next action |
| --- | --- |
| Artifact missing, malformed or SHA-256 differs | Stop dependent work. Return the exact artifact error to its owner. Do not recalculate hashes merely to accept changed data. |
| Required source fields/versions are absent | Return the bounded capture gap. Reuse complete capture parts only through an explicit, provenance-preserving capture plan; do not invent values or silently mix source revisions. |
| Mapping revision or destination rules changed | Preserve previous identity/write evidence. Reconcile proposed outputs with existing target IDs, regenerate affected transformation/dry-run, and obtain current approval. Never regenerate IDs and blindly recreate already migrated items. |
| Target data/configuration changed since review | Compare reviewed before-state, migration-written after-state and current state. Treat an external edit as a conflict; do not overwrite or restore over it automatically. Replan/review the affected scope. |
| Known job is still pending | Wait for that same job through the documented connector mechanism. Keep its request fingerprint and run ID; no duplicate submission. |
| Job submitted but terminal response is lost or unknown | Recover the terminal result for the same job/same run ID. Inspect affected target items if result recovery is inconclusive. Do not resubmit while effects remain unknown. Mark the task blocked with evidence if safe reconciliation is unavailable. |
| Connector definitively rejected before creating a job | Correct only the known invocation problem. Retry only after recording proof no job/write started and confirming current input/approval/backup bindings. |
| Terminal batch failure with partial writes | Record per-item success/failure and remote effects. Read back the assigned output IDs; preserve verified successes. Replan only failed/uncertain outputs, rechecking drift, approval and backups before another write. |
| Item exists at a planned path under a different ID/template | Block the affected output as a collision. Ask the coordinator to resolve approved reuse/update/destination choices; do not rename, merge or overwrite automatically. |
| A referenced target item is missing or a split is ambiguous | Stop affected reference updates. Return the dependency/output-role decision to Mapping or Content Migration. Do not clear fields, guess IDs or expand scope. |
| Source/target names changed but verified IDs still match | Inspect current identity/path evidence and destination intent. Reuse the stable binding only after the plan accounts for the current path; names alone do not establish equivalence. |
| Entire scope explicitly removed by a new user decision | Record a truthful `skipped` result with decision and downstream limitation. Failed writes remain recorded; scope removal does not erase their effects. |

An unknown job state and a confirmed terminal failure are not interchangeable. A retry is a new remote operation and needs the same scope/plan/approval/backup gates as the original. Do not poll completed jobs as normal progress, treat an elapsed timeout as failure proof, or invent a job ID from an item ID.

## Scoped restore

A Git checkpoint cannot restore remote Sitecore items. A local evidence snapshot is not a remote backup unless it contains the full necessary item/field/version state and has an available verified restore mechanism.

1. Identify exactly which existing items were updated and which content items and explicit folders were actually created by this migration attempt. Do not infer branch-generated descendants; branch expansion is unsupported. Record affected references and any later dependent work. Never delete a whole destination subtree just because the migration wrote part of it.
2. Read current target state and compare the reviewed before-state, written after-state and current state. If an item was externally edited after migration, surface the conflict before restoring it. The same applies to new external references to a created item.
3. Present the restore scope and impacts to the user through the coordinator. Require explicit scoped restore approval; migration execution approval does not authorize rollback. Make a current-state safety backup before restoration.
4. Restore only the approved item/field/language/version scope using the supported remote restore mechanism. Removal of created items also requires its explicit approved scope and ownership/reference checks; an identity-map entry alone cannot authorize deletion.
5. Read back restored items and affected references. Record restored, unchanged, conflicted and failed items separately. A partial restore failure remains visible and stops dependent mutation until resolved.
6. Preserve the original plan, backups and attempt results. Record restore evidence rather than editing the old result into success. The coordinator invalidates only results/approvals undone by recovery and reviews dependent tasks; unaffected verified work can remain complete.

## Result and continuation

Return the complete task-result envelope on failure, block or recovery, including actual partial effects, evidence and required gaps. Keep remote item changes in mutation/read-back evidence, not filesystem `changedFiles`. A successful recovery is not proof that the migration itself succeeded. Resume the relevant operation only after its prerequisites and current user decisions are re-established.

For references, preserve the immutable planning checkpoint and all reference receipts. Regenerate the reference proposal against the current journal checkpoint and refreshed owner/dependency observations after drift or partial outcomes; do not edit an old checkpoint to bless a dependency. Identity checkpoints retain existence/initial-field evidence, while reference receipts retain its provenance. Unknown requests block further mutation through the same journal.

Do not create parallel current-status or approval stores. The coordinator projects validated attempts into workflow status; the executor's identity/checkpoint records remain provenance-bound evidence of item operations.
