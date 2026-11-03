# Reference resolution

## Available boundary and evidence

Use this separate local planner after initial content identities exist. It replays the original content plan, validates the selected checkpoint and resolves only supported captured reference tokens into existing target items. Execution uses the [same guarded writer and recorder](target-execution.md), exact review/mutation approval, full existing-item backups, fresh drift checks and durable receipts. There is no second executor, workflow or approval store.

The coordinator supplies the approved mapping/destination revision, original content planner input and artifacts, an immutable checkpoint file selected from the journal head, and fresh target observations. Use the actual checkpoint file named by the journal head when planning, with its exact SHA-256; do not select a mutable head document as the checkpoint or fabricate successful identities. Subsequent batches may use that same checkpoint only when its hash is a verified ancestor of the current journal. Checkpoints establish identity existence and initial-field evidence from confirmed initial operations or explicit verified reuse. Failed, skipped, partial or uncertain identities cannot supply successful dependencies. Reference update receipts preserve this provenance rather than replacing initial-content evidence.

Observe every reference owner by exact ID/path/template, complete existing versions and all scoped reference field tuples. Observe each referenced target identity as required by the planner. Follow the [target observation contract](dry-run.md); no target observation exporter for this planner format is packaged. Collect bounded observations through a verified target read capability, with one confirmed target-state cohort. A cohort label alone proves no freshness.

Optional approved `destinationPlan.existingReferenceTargets` entries have exactly `{sourceItemId,targetItemId,targetPath,templateId}`. These read-only existing media/content bindings must match exact target inventory metadata and fresh `existingTargetState` observations, using the target-state schema with `rootPath: /sitecore`. They can select an existing item outside the migration content root without authorizing writes to it. They never transfer media binaries or outside-scope content. Missing media/content remains a dependency; do not broaden scope to satisfy it.

## Request and command

Create a request conforming to [reference-plan-input.schema.json](../contracts/reference-plan-input.schema.json):

```json
{
  "version": 1,
  "contentPlanInput": { "path": "content/plan-input.json", "sha256": "<exact SHA-256>" },
  "checkpoint": { "path": "journal/checkpoint-000010-<hash prefix>.json", "sha256": "<exact SHA-256>" },
  "targetState": { "path": "reference-target-state.json", "sha256": "<exact SHA-256>" },
  "existingTargetState": { "path": "existing-reference-target-state.json", "sha256": "<exact SHA-256>" },
  "maxItemsPerBatch": 50,
  "maxBatchBytes": 1048576
}
```

The paths and placeholder hashes illustrate the shape; use exact coordinator-supplied files. `contentPlanInput`, `checkpoint` and `targetState` are required descriptors. `existingTargetState` is optional when no approved existing-reference bindings require it. Each descriptor uses a clean selecting-document-relative path and lowercase SHA-256 of the exact bytes. Preserve the original content input and its complete provenance chain. `maxItemsPerBatch` is optional, 1–100 (default 50); `maxBatchBytes` is optional, 1 KiB–4 MiB (default 1 MiB).

From the skill's scripts directory:

```sh
node plan-references.mjs --input /workspace/reference-plan-input.json --output /workspace/new-reference-plan
```

The output parent must exist and the directory must be new. Exit 0 means ready for review. Exit 2 means gaps/conflicts were reported and all mutation batches are withheld. Exit 1 means input/hash/schema/output/filesystem failure; incomplete output is not valid evidence. The planner never contacts Sitecore, submits a job, records approval or advances workflow. `executionAvailable: false` describes that local planning boundary; the separate guarded writer is available.

## Supported rewriting and blocking gaps

Supported forms are captured single GUID values, ordered GUID lists, internal link XML and image/file XML with approved ID attributes. Preserve all other XML attributes, list order and duplicates, sharing, languages/versions, output roles and local occurrence context. Empty and external links remain unchanged when supported by their captured type. Never replace arbitrary GUID-shaped text. Rich-text HTML, query references and path/URL rewriting are unsupported and block required resolution. Rendering/layout/datasource presentation assignments remain outside this operation.

Use approved `referenceRules` for split outputs and the same page-local ownership/occurrence evidence as transformation. Global outputs remain shared. Missing or ambiguous bindings, incompatible/unsupported values, missing owner versions, stale observations and failed/partial dependencies block the proposal; no batches are emitted even when some fields resolve. Circular content links do not impose creation dependencies once their identities exist. Do not strip missing links, guess a split, create a target item/version or convert a field format.

## Review outputs and execution

| File | Review purpose |
| --- | --- |
| `reference-report.json` | Provenance, resolution outcomes and missing/ambiguous/unsupported dependency gaps. |
| `dry-run.json` | Exact owner identities, scoped reference before/after values, referenced-item guards/bindings and classifications. |
| `batch-plan.json` | Hash-bound, item/byte-bounded reference-only updates and owner preconditions. |
| `target-read-requirements.json` | Exact missing observations to collect; this is not a connector request or approval. |

Review the complete report and differences before mutation. A ready reference report or successful initial batch is not reference mutation approval. Use `prepare-execution.mjs` with `operationKind: references`; its `planInput` selects this reference input, `batchPlan` and `dryRun` select these outputs, `targetState` selects fresh owner/dependency observations, and `existingTargetState` selects fresh external-target observations when used. Retain the normal task, batch, structural language and capability evidence. Preparation replays the reference planner and verifies the selected checkpoint against the current durable journal, current identity status and referenced-target guards.

Follow every [target execution step](target-execution.md): prepare the unapproved review, obtain the existing coordinator mutation decision bound to that exact review, prepare once with approval, dispatch the reserved envelope through the selected target SPE connector and record submitted/unknown/terminal events with the existing recorder. The writer backs up existing owners, checks drift immediately and updates only existing supported reference tuples; it creates no items or versions. An unknown request blocks further requests. Refresh drifted evidence and regenerate the proposal/review rather than editing hashes or reusing stale approval.

Retain terminal receipts and reference read-back with initial-content provenance. Per-operation read-back does not establish independent final parity; that independent content audit is available through [target verification](target-verification.md), while mapped-content workflow integration requires explicit workflow-plan approval through `mapped-content-migration/references/workflow-integration.md`. Return honest gaps through the existing seven-field task result, then hand verified IDs and evidence to the coordinator for Presentation Composition.
