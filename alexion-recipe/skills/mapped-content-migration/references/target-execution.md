# Approved target execution and durable outcomes

## Available boundary

The guarded writer applies one selected initial-content or reference-only batch using existing target templates and explicit target IDs. Local preparation produces a review, then an approved target SPE request. A separate recorder persists dispatch and validated terminal evidence in an immutable local journal. Neither local command submits a connector job or changes shared workflow.

The target script performs immediate identity, definition and before-state checks, backs up existing items before updates, applies supported scalar fields and contiguous exact numeric versions, and performs per-operation read-back. It retains server-side request claims, a root lock and flushed operation journals. For reference-only batches it updates supported existing reference field tuples without creating items or versions. These operation checks do not replace the independent final parity audit or Presentation Composition.

Work excluded from mapped Content Migration (see [operational boundaries](operational-boundaries.md#supported-and-excluded-work)) and automatic rollback are outside this writer. Unsupported fields/storage, missing or noncontiguous version requirements, uncertain prior effects and absent prerequisites block the assigned operation. Confirm compatibility through the selected platform's verified capabilities and run one explicitly approved small operation before wider execution.

The planner's `executionAvailable: false` means the planner itself never executes. It does not disable this separate guarded writer. A ready planner report still supplies no mutation permission or execution capability.

## Required evidence

The coordinator supplies the task, `contentMigrationMode: mapped-content`, exact approved dry-run/batch artifacts, one selected batch ID, fresh target observations, target capabilities and the persistent journal directory. Target observations remain externally supplied through a verified read mechanism; no target observation exporter for this planner format is packaged here.

When source and target use the same instance and database, their content scope roots must be disjoint. The writer blocks overlapping roots; use reviewed source and destination scopes that protect the source site.

Require proof of the exact target connector, instance, database, content root and identity marker; supported SPE reads and writes; full existing-item backup; tested scoped restore capability; export-file download; a confirmed exclusive write window; and durable local/server journals. Capability evidence must be current and unexpired and describe actual request, backup and journal limits. A capability flag or mock result without its verified evidence is insufficient. Credentials stay with connectors.

Target template evidence must include all transitive base-template IDs and effective inherited fields, with their declaring templates, types and storage. The writer compares that evidence with the live definitions. Preserve the server journal on shared persistent storage across eligible executor nodes, or pin execution/recovery to the verified node; `journalContinuityVerified` confirms this prerequisite.

Review backup and restore capability before authorization. The writer may serialize existing target items solely to produce recoverable backups; source serialization is never a transfer mechanism. A backup file, Git checkpoint, request reservation or proposed target ID is not proof of a successful write or restore. Restore is a separately reviewed operation using the confirmed capability; this writer does not implement automatic recovery mutations.

## Initialize the journal

Use a persistent task/migration evidence location, not an ephemeral shell directory. The journal's parent must exist and its directory must be new. An initialization event has this shape, using actual assigned identities:

```json
{
  "version": 1,
  "action": "initialize",
  "scope": {
    "scopeId": "approved-migration-scope",
    "targetInstanceId": "verified-target-instance",
    "database": "master",
    "rootPath": "/sitecore/content/TargetSite",
    "connectorId": "selected-target-connector"
  }
}
```

From the skill's scripts directory:

```sh
node record-execution.mjs --input /workspace/initialize-execution.json --state-dir /workspace/migration-journal
```

Retain the returned checkpoint hash. The journal uses immutable checkpoint files, a hash-bound head, compare-and-swap transitions and an exclusive transition lock. Preserve it, the selected receipts and server journals together. A missing or interrupted journal is a recovery blocker; do not initialize another journal to evade a pending request.

## Prepare the review

The versioned execution input selects the exact `planInput`, `batchPlan`, `dryRun`, fresh `targetState` and `capabilities` descriptors, plus the assigned `taskId`, one `batchId` and explicit `structuralLanguage` within the agreed scope. Descriptors use clean relative paths and SHA-256 hashes. Do not supply approval on the first preparation.

For reference execution, set `operationKind: references`; `planInput` selects the [reference planner input](reference-resolution.md), and `batchPlan`/`dryRun` select its outputs. Supply fresh `targetState` and, when external bindings are used, fresh `existingTargetState`. Preparation replays reference planning, checks the selected immutable checkpoint against the current durable journal and rechecks referenced-item identity guards. The same review, mutation approval, backup, reservation and recorder steps below apply; reference batches never create items or versions.

```sh
node prepare-execution.mjs --input /workspace/execution-input.json --output /workspace/new-execution-review --state-dir /workspace/migration-journal
```

Preparation replays the canonical planner, checks its exact batch plan, verifies current target guards and definitions, reconciles prior confirmed results and requires dependencies to be satisfied. It writes `execution-review.json`. Without approval, `reviewReady: true`, `approvalRequired: true` and exit 2 mean review evidence exists; no mutation envelope or operation reservation is issued.

Present that exact review and hash, the selected target scope/batch, scalar or reference changes, version scope, backups, dependencies, known successes and remaining reference work. Obtain the existing coordinator decision with `kind: mutation`, `choice: approve`, matching task/scope, actual user response/timestamp and input binding to the exact review hash. Do not invent a new approval format or treat the earlier mapping/workflow approval as this decision.

## Prepare the authorized request

Create a new execution input referencing the same selected artifacts and add `review` and `approval` descriptors. Rerun preparation into a fresh output directory with the same persistent journal. The reconstructed review must match the approved bytes; changed capability, target evidence, journal, batch or writer returns for review.

An authorized preparation reserves the exact request durably before returning `target-request.json`. The envelope contains the bundled writer/common helper, structured `Request`, background execution and file output. Its complete serialized size must fit the verified connector limit. Use the returned request/review hashes, request ID, connector ID and latest checkpoint hash as attempt evidence. A reservation followed by a size/output failure remains blocked for reconciliation; it is not permission to generate a replacement request.

Exit 0 means an authorized request is available or the selected operations are already verified complete; inspect `requiresDispatch`, `alreadyCompleted` and counts. Exit 1 means failure. Already-completed operations must not be dispatched again. Preparation never contacts Sitecore.

## Dispatch and record job state

Submit the exact reviewed envelope once through the selected target connector's supported `run-powershell-script` operation. Never run `execute-target.ps1` locally or reconstruct its body manually. Retain the request fingerprint and job ID as soon as submission returns, then record a versioned event:

```json
{
  "version": 1,
  "action": "submitted",
  "checkpointSha256": "<current checkpoint SHA-256>",
  "requestId": "<reserved request ID>",
  "connectorId": "<selected target connector>",
  "jobId": "<actual connector job ID>"
}
```

Run the recorder with the assigned event file and the same journal:

```sh
node record-execution.mjs --input /workspace/submitted-event.json --state-dir /workspace/migration-journal
```

Wait for automatic terminal delivery. If submission/result delivery is uncertain, record `action: unknown` with the current checkpoint hash, request ID and connector ID; include the known job ID when available. Recover that same job or persistent server claim. A reserved, submitted or unknown request blocks another mutation. Do not resubmit, clear locks, delete checkpoints or reserve a new request to make progress while effects remain uncertain.

## Ingest terminal evidence

Download the unchanged terminal receipt, journal and all backup files exposed by the export through the verified file-download mechanism. Verify and retain their hashes and sizes alongside connector job provenance and the exact approved review. The recorder checks backup descriptors; it does not download files or prove that an operator retained them. A terminal event contains the same request/connector/job/checkpoint identities, confirms `terminal: true`, and adds relative `review` and `receipt` SHA-256 descriptors:

```json
{
  "version": 1,
  "action": "terminal",
  "terminal": true,
  "checkpointSha256": "<current checkpoint SHA-256>",
  "requestId": "<reserved request ID>",
  "connectorId": "<selected target connector>",
  "jobId": "<actual connector job ID>",
  "review": { "path": "review/execution-review.json", "sha256": "<review SHA-256>" },
  "receipt": { "path": "downloaded/execution-receipt.json", "sha256": "<receipt SHA-256>" }
}
```

```sh
node record-execution.mjs --input /workspace/terminal-event.json --state-dir /workspace/migration-journal
```

Receipt ingestion validates the known request/job, exact review and actual per-operation post-state before promoting identity bindings. Initial-content checkpoint identities establish existence and initial-field evidence. Reference update receipts preserve that provenance and record reference outcomes; they never manufacture an initial-content success for failed or partial identities. Record success, failed, skipped and uncertain outcomes separately. A terminal job, declared ID or successful aggregate count is insufficient. Partial effects and valid successful operations remain visible when other operations fail; never rewrite the outcome to pass a task gate.

The recorder accepts exactly `--input EVENT --state-dir DIRECTORY`. Exit 0 means its documented local event transition passed, not that the migration is complete; exit 1 means failure. Use the newly returned checkpoint hash for the next event. Stale hashes, scope/job mismatches and conflicting active requests fail rather than overwriting history.

## Resume and handoff

Reuse verified terminal results and their after-state guards through fresh preparation. Failed or skipped operations need current target inspection and a new scoped review/approval before another request; do not replay the original batch automatically. Unknown effects need reconciliation first. A crashed local transition lock or server root lock requires evidence-led recovery, never automatic deletion or rollback.

Save the shared seven-field task result and operation evidence under the assigned attempt. Keep remote IDs out of repository `changedFiles`; a remote item backup is separate from a Git checkpoint. The coordinator owns workflow and approval records. Hand verified target bindings, receipts, backups/journals and unresolved dependencies to later reference resolution and independent final verification. An executed initial batch does not establish complete content, presentation or website parity.
