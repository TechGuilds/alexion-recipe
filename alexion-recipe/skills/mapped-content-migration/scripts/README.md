# Mapped Content Migration scripts

## Available scripts

This inventory lists executable scripts packaged with the skill. Check the documented interface and actual file before dispatch. If the assigned task needs an unavailable operation, return `blocked` and identify the missing capability; do not create an ad-hoc substitute.

| Script | Availability | Responsibility and boundary |
| --- | --- | --- |
| `prepare-content-workflow.mjs` | Available | Build a scoped mapped-content proposal and logical operation inventory/mappings locally, preserving existing active work. No active workflow/Kajoo/decision mutation. |
| `validate-mapped-outcome.mjs` | Available | Recompute domain outcome from the immutable packet and actual output descriptors before shared task-result/evidence validation. |
| `workflow-provider.mjs` | Library | Hooks registered in the `cms-migration` Sitecore profile: operation catalog, packet metadata and evidence replay for mapped-content tasks. Not run directly. |
| `verify-target.mjs` | Available | Reconstruct canonical expected content and compare whole agreed output scope with provenance-bound readback; emit reports and missing read requests locally. |
| `capture-target.ps1` | Available through approved target SPE | Read exact requested IDs/paths, complete versions, scoped effective fields and observed parents into bounded exported audit parts. Never run locally; no content writes. |
| `prepare-execution.mjs` | Available | Replay and guard one selected batch; emit an execution review, then a reserved target request only after exact mutation approval. Local files/journal only; never submits a job. |
| `record-execution.mjs` | Available | Initialize the persistent journal and record submitted, unknown and validated terminal evidence using hash-guarded immutable transitions. No connector calls. |
| `execute-target.ps1` | Available through approved target SPE | Assembled with its bundled common helper by preparation. Back up, guard, write and read back one approved initial-content or reference-only batch with server claims/journals. Never run locally or independently of the prepared request. |
| `plan-references.mjs` | Available | Replay content provenance and resolve supported reference values against checkpoint identities and fresh observations; emit bounded reference-only review batches and dependency reports locally. |
| `plan-content.mjs` | Available | Compare the mapped plan with supplied target observations; produce differences, evidence gaps and bounded review batches locally. |
| `transform-content.mjs` | Available | Produce mapped content definitions, explicit folder structures, proposed identities and dependency reports locally; no remote execution. |
| `validate-inputs.mjs` | Available | Validate schemas, staged file hashes and documented cross-file relationships. Local, read-only. |
| `prepare-source-snapshot.mjs` | Available | Reuse compatible evidence, assemble bounded snapshot parts and generate requests for gaps. Local file output only; never submits a connector request. |
| `validate-snapshot.mjs` | Available | Verify partition integrity and required source field/version/context coverage against approved scope. Local, read-only. |
| `media-migration.mjs` | Local planner and evidence replay | `--input FILE --output NEW_DIRECTORY`; actions `capture`, `prepare`, `install`, `verify`. Generates exact connector requests; verifies actual packages, reviews and independent media observations. |
| `media-package.ps1` | Selected source/target SPE connector only | Bounded Media Library capture, original-blob `.update` export with actual 100000000-byte cap, guarded sequential installation and readback. Verified XP/XM pilot required; no publishing. |
| `capture-source.ps1` | Available through source SPE | Capture only explicitly requested source items/fields/versions and rendering parameter context. Remote read-only content access; writes bounded export files in Sitecore's Data folder. |

Read [media migration](../references/media-migration.md) for opt-in scope, action-specific inputs, exact output names, package transfer, approvals and live-pilot requirements. Media package bytes travel through connectors, never JSON.

Read [operational boundaries](../references/operational-boundaries.md) for common capability requirements, validation limits and unsupported operations. Use the relevant procedure for exact inputs and approvals: [source capture](../references/source-snapshot.md), [target execution](../references/target-execution.md), [reference resolution](../references/reference-resolution.md), [independent verification](../references/target-verification.md) and [workflow integration](../references/workflow-integration.md).

## Run on Kajoo

Read this skill in Kajoo to stage its resources. Use the exact advertised skill path, preserving workspace/agent scope; do not assume a checkout of Kajoo's code repository. The platform's Node runtime executes these local scripts; Sitecore operations still use the selected connector. The recipe bundles its Ajv 8.17.1 validator dependency and notices in the shared `cms-migration/scripts/lib/vendor/`, so runtime use needs no `npm install`, package manifest, network dependency download or global Ajv installation. Do not modify the read-only staged skill directory or target app dependencies.

Keep the bundled sibling `cms-migration` and `sitecore` skills available at the platform-advertised layout for workflow procedures. If required resources or a supported Node runtime are missing, report the platform prerequisite instead of substituting an unrelated repository. Local evidence belongs in the assigned writable task workspace.

Run from this directory with the actual coordinator-provided input path. The following is a sandbox path example, not a default location:

```sh
node validate-inputs.mjs --input /workspace/migration-input.json
```

To try the scripts on the bundled sample data:

```sh
node validate-inputs.mjs --input ../tests/fixtures/migration-input.json
node validate-inputs.mjs --input ../tests/fixtures/migration-input-partitioned.json
node validate-snapshot.mjs --input ../tests/fixtures/snapshot-validation.json
```

Do not use `tests/fixtures` as evidence for a real migration. Their mapping, source and target records are examples; real inputs must come from approved scope and verified instance evidence.

## Implemented CLI contract

| Property | Contract |
| --- | --- |
| Arguments | Exactly `--input <manifest.json>`. No apply, dry-run, output or connector flags. |
| Input manifest | Version 1 with `scopeId`, `mappingRevision`, and required mapping/sourceSnapshot/targetInventory/destinationPlan artifact descriptors. Optional itemPlan/identityMap descriptors enable their checks. |
| Artifact descriptors | Clean manifest-relative `path` plus lowercase SHA-256 of exact bytes. Paths stay below the manifest directory; linked artifact files and traversal are rejected. |
| Output | JSON on stdout: `valid`, `errors`, and `summary` after semantic validation. Error entries contain `code`, `path`, `message`. Schema/input errors may omit `summary`. |
| Exit status | 0: implemented checks passed. 1: usage, file/hash, schema or cross-file error. Missing runtime dependencies may prevent startup and must be corrected as an environment failure. |
| Side effects | Reads declared artifacts and bundled schemas only; no file output, connector call, target write, approval or workflow mutation. Tests use temporary directories and remove their own test data. |

`sourceSnapshot` can select a legacy source JSON or a partitioned manifest. All JSON inputs are capped at 16 MiB. Partitioned source content is streamed, with individual part/record limits and metadata indexes proportional to item/context count. File integrity and semantic checks remain separate from full coverage validation.

## Target execution commands

```sh
node record-execution.mjs --input /workspace/initialize-execution.json --state-dir /workspace/migration-journal
node prepare-execution.mjs --input /workspace/execution-input.json --output /workspace/new-execution-review --state-dir /workspace/migration-journal
node record-execution.mjs --input /workspace/terminal-event.json --state-dir /workspace/migration-journal
```

Use actual assigned paths. Preparation accepts exactly `--input REQUEST --output NEW_DIRECTORY --state-dir JOURNAL_DIRECTORY`. Exit 2 means a review is ready and exact mutation approval is required; exit 0 means an authorized envelope is available or the selected operations are already complete; exit 1 means failure. It never submits a connector request. Authorized preparation reserves durable state before handing off the assembled target envelope.

The recorder accepts exactly `--input EVENT --state-dir JOURNAL_DIRECTORY`. Supported event actions are `initialize`, `submitted`, `unknown` and `terminal`. Exit 0 means the local event transition passed; exit 1 means failure. Preserve each returned checkpoint hash for the next transition. Read the [full execution procedure](../references/target-execution.md) for actual input/event shapes, dispatch, receipt ingestion, unknown-job recovery and capability boundaries.

## Reference planning command

```sh
node plan-references.mjs --input /workspace/reference-plan-input.json --output /workspace/new-reference-plan
```

Accepts exactly `--input REQUEST --output NEW_DIRECTORY`. The [reference resolution procedure](../references/reference-resolution.md) defines the exact hash-bound request, immutable checkpoint and fresh owner/dependency observations. Exit 0 means ready for review, 2 means gaps/conflicts with every batch withheld, and 1 means failure. Outputs are `batch-plan.json`, `dry-run.json`, `target-read-requirements.json` and `reference-report.json`. Planning never contacts Sitecore or authorizes writes; reference execution uses the existing preparation/writer/recorder with `operationKind: references`.

## Dry-run planning command

```sh
node plan-content.mjs --input /workspace/plan-input.json --output /workspace/new-dry-run
```

Accepts exactly `--input REQUEST --output NEW_DIRECTORY`. The [dry-run procedure](../references/dry-run.md) defines required hash-bound artifacts, explicit target observations, classification and preconditions. Exit 0 means ready for review, 2 means gaps/conflicts and no batches, and 1 means failure. Outputs are `dry-run.json`, `batch-plan.json` and `target-read-requirements.json`. `planContent(inputPath, outputPath)` is exported by [plan-content.mjs](plan-content.mjs). No remote target reader or writer is supplied by this command.

## Transformation command

```sh
node transform-content.mjs --input /workspace/transform-input.json --output /workspace/new-transformation
```

Accepts exactly `--input REQUEST --output NEW_DIRECTORY`. The [transformation procedure](../references/transformation.md) defines the hash-bound request, required prepared snapshot coverage, supported behavior, output files and limitations. Exit 0 means ready for local review, 2 means a conflict-bearing plan/report was saved, and 1 means failure. It never contacts Sitecore, compares current target field values or authorizes writes. The library export is `transformContent(inputPath, outputPath)` in [transform-content.mjs](transform-content.mjs). Each generated JSON file is capped at 16 MiB.

## Source preparation commands

```sh
node prepare-source-snapshot.mjs --input /workspace/source-preparation.json --output /workspace/new-source-snapshot
node validate-snapshot.mjs --input /workspace/snapshot-validation.json
```

These are example paths; use actual assigned artifacts. Preparation accepts exactly `--input REQUEST --output NEW_DIRECTORY`. It validates `prepare-source-input.schema.json`, reuses declared evidence, and writes bounded JSONL parts, their manifest, a coverage report and request envelopes for gaps. It never contacts Sitecore. Exit 0 means ready coverage, 2 means successful preparation with gaps, and 1 means failure. The parent directory must exist; existing output directories are rejected. Interrupted outputs are not silently overwritten or treated as successful results.

Coverage validation accepts exactly `--input REQUEST` conforming to `validate-snapshot-input.schema.json`. It verifies the descriptor hash, manifest/parts, matching scope/source state and required item/field/version/reference/context coverage. It prints JSON and exits 0 only when both `valid` and `ready` are true; otherwise 1. It writes no files and performs no remote reads. Neither command supplies user approval or proves live source freshness.

Generated request envelopes contain the bundled `capture-source.ps1`, structured `parameters.Request`, `background: true` and file output mode. Submit the exact reviewed envelope through the supported source connector after approval, then retain/download its terminal `kajoo-export` files. There is no local PowerShell invocation for a real capture. The [capture request schema](../contracts/capture-request.schema.json) defines version, request ID, exact scope and byte limit. Requests contain no credentials. The response has header/data/error/completion JSONL rows with request identity and counts; partial responses leave coverage gaps.

The exporter verifies exact numeric versions, field IDs/storage and requested rendering occurrences. It captures effective values and supported reference forms without traversing descendants. Unsupported local/query datasource resolution and unsupported reference formats require explicit Discovery input or another implemented adapter. It does not assign target presentation, fetch media binaries, change content or publish.

An empty error array does not establish complete capture coverage, value/type conversion correctness, target freshness or execution approval. These require separate acceptance evidence. A conflict-bearing `item-plan` can be structurally valid; it cannot be executed until conflicts and required issues are resolved and execution prerequisites are met.

## Library contract

`validateSchema(name, value)` returns structural errors for the named bundled definition, including `mapping`, `sourceSnapshot`, `snapshotManifest`, `snapshotRecord`, `captureScope`, `prepareSourceInput`, `captureRequest`, `captureHeader`, `captureCompletion`, `validateSnapshotInput`, `transformInput`, `planInput`, `referencePlanInput`, `targetState`, `batchPlan`, `targetInventory`, `destinationPlan`, `itemPlan`, `identityMap`, `migrationInput`. It does not read artifact files or establish cross-file readiness. This permits individual checks before a source snapshot exists.

`validateDocuments(documents, binding?)` validates required parsed mapping, sourceSnapshot, targetInventory and destinationPlan documents, plus optional itemPlan/identityMap. If supplied, `binding` must already conform to the `migrationInput` schema. The function also checks scope/revision and plan input hashes against that binding. It does not prove that in-memory values came from those file bytes; use `validateInputFile` for staged file integrity.

`validateInputFile(inputPath)` reads the versioned manifest and its declared artifacts, verifies their exact hashes, then performs structural and cross-file validation. Its returned object has the CLI report shape. All three exports are in [validate-inputs.mjs](validate-inputs.mjs).

`prepareSourceSnapshot(inputPath, outputPath)` in [prepare-source-snapshot.mjs](prepare-source-snapshot.mjs) implements the local preparation command. `validateSnapshotFile(snapshotPath, scope)` in [validate-snapshot.mjs](validate-snapshot.mjs) performs coverage checks for a confirmed partitioned snapshot. Legacy snapshots must first be adapted by preparation to bind source-state/coverage metadata.

`openSnapshot(path)` in [lib/snapshot.mjs](lib/snapshot.mjs) returns the header and a repeatable async `records()` iterator; callers must consume the iterator to completion to verify all parts. `snapshotIndex(snapshot)` stores identity/version/context metadata without content values. These are the bounded source reader interfaces for subsequent consumers; do not concatenate every part into one giant content object.

The [input reference](../references/input-contracts.md) defines field/storage, inherited-template ownership, local/global identity and parameter-value semantics. [Execution](../references/execution.md) defines operation gates and task results. [Recovery](../references/recovery.md) defines failed/unknown job, drift, resume and restore behavior.

## Execution capability requirements

An operation can be dispatched only when its supported implementation, real arguments, required connector capabilities, input/output schemas and failure behavior are documented and available. Keep local transformation separate from remote execution. Do not infer flags from another script or treat a runbook requirement as an executable command.

Remote operations retain selected connector/instance/database scope, script/request provenance, job ID and terminal result. Credentials remain with the selected connector. Before writes require the exact approved plan/batch, current target before-state and appropriate remote backups. A local Git checkpoint cannot restore remote content. Unknown terminal state requires reconciliation of the same job before retry.

Identity, operation checkpoints, target backups and result artifacts must be durable and bound to the actual inputs and operations. Shared workflow and coordinator decisions remain the authorities for task state and approvals. Missing approval, backup, recovery or result-recording capability blocks operations that require it; validation cannot manufacture those guarantees.


## Independent target content audit

Follow [target verification](../references/target-verification.md) for the complete input, read capability, approval, transfer and provenance contract. The local CLI takes exactly `--input <verification-input.json> --output <new-directory>` and emits `verification-report.json`, `expected-content.json`, `target-read-requirements.json` and `readback-requests.json`. Optional `maxQueriesPerRequest` is selected in the input, not a CLI flag. Exit 0 means ready content parity; exit 2 retains gaps/mismatches/unresolved checks; exit 1 means malformed input or integrity failure.

`verify-target.mjs` does not contact a connector or update journals/workflow. Missing observations produce only bounded exact-ID/path read envelopes. After the coordinator approves their exact scope and hash through existing read/continuation decisions, dispatch `capture-target.ps1` only through the selected target connector. The collector exports read-only audit parts through terminal `kajoo-export`; select actual transferred file descriptors in a new verification input. Never run the collector locally or turn writer receipts into readback parts. No mutation, remediation, publishing, visual/presentation checks, media binary capture or unrelated tree enumeration is included.


## Scoped content workflow and outcome validation

Follow [workflow integration](../references/workflow-integration.md). `prepare-content-workflow.mjs --input <workflow-input.json> --output <new-directory>` emits `workflow-proposal.json`, `inventory.json`, `task-mappings.json` and `integration-report.json` without changing active files, decisions or Kajoo. `validate-mapped-outcome.mjs --input <mapped-outcome-input.json> --output <new-directory>` validates the operation packet and actual outputs before the existing seven-field task result. These are local commands; neither authorizes remote work or user acceptance.
