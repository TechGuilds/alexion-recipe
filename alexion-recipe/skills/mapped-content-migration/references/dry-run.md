# Content dry-run and batch planning

## Purpose and prerequisites

Use the implemented local planner after reviewing a ready [transformation](transformation.md). It compares supplied target observations with the exact mapped plan, reports differences and produces bounded initial-content batches. It performs no remote reads or writes, records no approval and does not advance workflow.

Require the original transformation request and all its selected inputs, a ready item plan, its proposed identity map and transformation report, and current bounded target observations collected through the selected target connector's verified read capabilities. The target observations must represent one coordinator-confirmed target state. `targetStateId` is a cohort label, not a Sitecore transaction token or automatic freshness guarantee. Refresh or reconcile stale evidence through the coordinator before review.

The read mechanism must establish explicit ID/path existence, identities, complete version lists and requested effective field values. This recipe currently has no target exporter producing this format. If the selected connector cannot supply verified observations, return `blocked` with that dependency. Do not use the source exporter against the target, infer content values from Discovery summaries, or invent a connector API.

## Target observation contract

The [target-state schema](../contracts/target-state.schema.json) defines:

- `version`, migration `scopeId`, target `instanceId`/`database`, `rootPath`, timestamp with timezone, `targetStateId`, `valueMode: effective` and explicit `queries`.
- Each query has `lookup: id` or `lookup: path`, the exact `value` and `exists`. An absent result has no `item`. A successful lookup includes item ID, template ID, path, `versionsComplete: true`, all observed target language/version tuples, and field observations.
- A field observation specifies field ID, sharing mode and language/version selectors, plus `present`. A present value has a string `value`, including `""`. An explicitly absent value has `present: false` and no `value`. Omission of the entire field observation means a coverage gap. Capture missing versions explicitly; a field from a nonexistent version cannot claim a present value.

For every proposed content item and structural folder, supply both planned-ID and destination-path lookups. Include path lookups for existing parents not supplied by the plan. The same existing item returned by several lookups must carry identical identity, complete versions and requested field observations; property/field ordering may differ. Reuse one collected item observation across those lookups. Contradictory results are errors.

For existing outputs, observe every initial scalar field tuple the plan proposes, including absent values where applicable. Additional target fields are preserved and are not scheduled for deletion. Deferred reference fields are excluded from initial writes and need a later reference-specific comparison. The initial before-state fingerprint covers the supplied observation scope, not every unobserved value or template definition. Target definitions and connector capabilities must also remain current and must be rechecked before execution.

Each target-state JSON file is capped at 16 MiB. Collect only the required bounded scope. A missing lookup is never treated as nonexistence, and absence from target Discovery inventory does not authorize creation.

## Planner request and command

Create a request conforming to [plan-input.schema.json](../contracts/plan-input.schema.json). Required SHA-256 descriptors select `transformInput`, `itemPlan`, `identityMap`, `transformReport` and `targetState`. Each descriptor uses a clean relative path below the selecting document. Optional `maxItemsPerBatch` is 1–100 (default 50); `maxBatchBytes` is 1 KiB–4 MiB (default 1 MiB).

The transformation report must bind the exact output plan and proposed identity map through `itemPlanSha256` and `identityMapSha256`. Reports generated before these properties were available must be regenerated locally from their reviewed inputs. Do not add hashes by hand to bless an unrelated plan.

From the skill's scripts directory, use the actual assigned paths:

```sh
node plan-content.mjs --input /workspace/plan-input.json --output /workspace/new-dry-run
```

The output parent must exist and the output directory must be new. Exit 0 means a conflict-free local proposal is ready for review. Exit 2 means evidence gaps or conflicts were reported and every mutation batch was withheld. Exit 1 means input/hash/schema/output-size/filesystem failure; incomplete files cannot be treated as a successful dry-run. The planner never submits a job.

## Comparison rules

| Classification | Required evidence and result |
| --- | --- |
| Create | Both target ID and path explicitly absent; required parent exists or is planned; destination policy allows creation. |
| Update | ID/path/template match the planned identity, policy permits update, and scoped scalar values or required versions differ. Only changed scalar tuples and missing versions are proposed. |
| Reuse | Existing identity/template and all required initial scalar values/versions match, or a compatible structural folder already exists. This proves only the observed initial content; pending references still require resolution. A strict `reuse` destination blocks when values/versions differ or references remain unverified. |
| Exclude | A source item was excluded by the approved destination plan with a reason; retained separately because it has no target write. |
| Conflict | Missing evidence, identity/template/path mismatch, create-only collision, failed reuse, missing parent, duplicate output, unsupported branch expansion or unresolved plan issue. |

The planner does not adopt a different existing target ID or silently rename an item. Return those decisions for mapping/destination review and regenerate the transformation. It does not merge content, delete fields or versions, expand branches, copy media or assign presentation. Branch-dependent transformations remain blocked upstream.

Reference fields retain their kind, raw source values and ordered source IDs in separate dependency evidence. They never enter initial scalar batch fields. Reference edges do not determine item creation order, so circular content links can be resolved after identities exist. A ready initial plan with `referencesPending: true` is not a completed migration; the separate [reference planner](reference-resolution.md) must collect before-state, compute actual target reference values and obtain the applicable approval before updates.

## Review artifacts and batches

| File | Contents |
| --- | --- |
| `dry-run.json` | Exact artifact hashes and target identity/state, per-output classifications, field before/after values, versions to create, parent IDs, before-state fingerprints, exclusions, pending references, deferred parameter mappings, issues and evidence gaps. |
| `batch-plan.json` | Hash-bound review-only batches, item/byte bounds, all-output preconditions and parent operation dependencies. It has its own public [schema](../contracts/batch-plan.schema.json). |
| `target-read-requirements.json` | Missing ID/path lookups or exact field tuples to collect. This is a read specification, not an executable request or authorization. |

Batches list parents before children and include only create/update operations. Existing compatible folders and unchanged content remain in the review evidence and precondition list. **Every applicable precondition must be rechecked before execution, including reused planned parents that have no write operation.** A child depends on a parent operation only when that parent is created or updated. Each operation also carries its target identity, parent ID and before-state fingerprint. The selected batch and required dependency closure must be reviewed together.

Bounds apply to serialized batch JSON payloads; the guarded executor additionally bounds its complete connector/script envelope. A single operation exceeding the limit blocks the proposal; it is never truncated or split silently. Every generated JSON artifact is limited to 16 MiB. Source parts remain bounded and are read through the existing snapshot reader.

The planner checks hashes and required source coverage and rechecks input integrity before saving. Fingerprints bind the selected target state, lookup identities, complete captured version lists and supplied field observations. They are drift guards, not remote backups. The executor must re-read the required evidence and definitions, use the same fingerprint semantics and reconcile any drift before writes.

## Approval and recovery

Present the complete dry-run and exact batch-plan hash through the coordinator. Obtain approval for the target instance/database/root, selected batches and dependency closure. A mapping approval, passing validator, ready report or proposed identity map is not mutation approval. Target writes use the separate [guarded execution procedure](target-execution.md), requiring verified execution capability, current before-state, recoverable remote backups, an exclusive write window and durable outcomes. The planner's `executionAvailable: false` describes its own boundary; it is not a claim that the separate writer is unavailable.

When more evidence is required, collect only the reported gaps using the approved read mechanism, reconcile them into one confirmed target-state cohort and rerun into a fresh directory. Do not silently combine stale states or overwrite the old evidence. Mapping/input/target changes invalidate the corresponding review and require a new dry-run. See [recovery](recovery.md); pending or unknown remote jobs must be reconciled before any resubmission. Local planning never creates such jobs.
