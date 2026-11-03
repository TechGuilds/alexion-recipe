# Mapped-content workflow integration

## Scoped availability

Content Migration has an explicit local workflow proposal, deterministic operation dispatch and domain outcome validation. This integrates the mapped-content operations only. Existing Setup, Discovery, source/target capabilities, approved mapping and destination evidence remain prerequisites supplied by their owners. Broad Mapping UI, Discovery and Presentation implementation are outside this integration. Confirm live-instance compatibility using the selected connectors and the [operational boundaries](operational-boundaries.md).

Use the existing coordinator workflow and decisions as the authorities. Complete [content-transfer selection and compatibility review](content-transfer-method.md#select-the-content-transfer-method) before proposing exactly one content-transfer phase. The proposal builder never mutates active workflow files, Kajoo tasks, decisions or remote content. Keep native serialization dispatch and its golden example available for explicitly selected `native-serialization`; never substitute it for `mapped-content`.

## Prepare the proposal

Supply version 1 `workflow-input.json` containing `scopeId`, hash-bound `activeWorkflow`, `inventory`, `mappings`, `modeDecision`, `mappingDecision` and `mediaDecision` artifact descriptors, the current `planningTaskId` and an `evidence` descriptor array. Reuse actual reviewed evidence; do not reconstruct source scope or fabricate approved mappings.

```sh
node prepare-content-workflow.mjs --input /workspace/workflow-input.json --output /workspace/new-content-workflow
```

The new output directory receives `workflow-proposal.json`, `inventory.json`, `task-mappings.json` and `integration-report.json`. The proposal preserves existing active work and Discovery inventory. It adds logical `mapped-content:<step>` operation entities and mappings to the existing inventory/mappings. These entities are workflow operations, not CMS items or content counts. Existing manual presentation work is preserved; this builder adds no new code, SXA, resolver or presentation work and claims no implementation of those workstreams.

Before proposing tasks, ask whether to migrate media and record the actual existing scope decision (`migrate-media` or `skip-media`) with planning task/scope, timestamp, user response and bound evidence. Missing media choice blocks proposal generation. For opt-in, confirm exact paths/descendants with the user and follow [media migration](media-migration.md).

The immutable [operation asset](../assets/workflow-operations.json) defines the task and role/entry-point contracts. `migrate-media` selects ten tasks: the two media tasks below followed by the original eight. `skip-media` retains the original eight plus explicit skip evidence; target media dependencies still need verification. Read this asset when preparing task instructions; it is the authority for IDs, owners, roles, entry points and procedures. The table below is a reading aid. If it differs from the asset, stop and reconcile the documentation; never invent a different packet contract.

| Task | Owner | Operation |
| --- | --- | --- |
| `content.media-prepare` (opt-in) | Sitecore developer | Prepare media migration packages. |
| `content.media-install` (opt-in) | Sitecore developer | Install and verify media migration packages, including independent tester readback. |
| `content.capture` | Sitecore developer | Prepare and validate the source snapshot. |
| `content.transform` | Sitecore developer | Transform mapped content. |
| `content.plan` | Sitecore developer | Compare target evidence and plan bounded batches. |
| `content.execute` | Sitecore developer | Apply approved content batches through the guarded writer/recorder. |
| `content.reference-plan` | Sitecore developer | Plan reference updates. |
| `content.reference-execute` | Sitecore developer | Apply approved reference batches through the same writer/recorder. |
| `content.audit` | Independent tester | Audit the whole agreed target content scope. |
| `content.approve` | Orchestrator | Obtain outcome review and handoff through the existing phase gate. |

Present the proposal for the existing `workflow-plan` approval, then run `validate-workflow-plan.mjs`/`validateWorkflowPlan` before `materialize-approved-workflow.mjs`. Only the coordinator promotes the materialized workflow and synchronizes Kajoo, reads back bindings/status/dependencies and validates synchronization. Preserve existing active statuses and task identities. Require a separate existing `phase-continuation` decision before dispatch. Proposal generation, plan approval and technical completion never imply continuation.

## Packet dispatch and task boundaries

Use supported `prepare-task-packet.mjs` input with `mappedContentInputs: [{role,path,sha256}]`, selecting the exact role files required by the operation asset. It derives `packet.mappedContent` from that immutable asset, the current mapped-content operation entities and explicit content transfer method decision. This routing is available only for the `mapped-content` method. Never hand-edit command fields, entry points, roles or generated packet bindings. Dispatch the assigned owner through the existing coordinator flow; use the packet's declared procedures and inputs.

For every completed mapped task in the active phase, supply `priorTaskAttempts: [{path,sha256}]` selecting its immutable native postflight request. The producer reruns existing `validate-task-attempt.mjs` against each prior task's own immutable inputs, the current workflow and actual decisions, then passes those task-scoped native reports to the existing frontier. The next task may select different inputs without invalidating an earlier task's evidence; never fabricate validation objects or substitute the next task's inputs for prior task inputs.

The API is `prepareTaskPacket(input, {base})`, where `base` selects the workspace boundary. Stage a CLI packet request at the SAME workspace boundary used by each prior postflight's `workflowPath` and input paths; include a state-directory prefix in relative paths when needed. The immutable postflight request file's hash persists while mutable workflow and decisions are reread at runtime. Moving the request to another boundary or pinning old mutable workflow/decision bytes is not a recovery procedure.

Use immutable checkpoint files in their actual journal directory, not mutable `head.json` descriptors; runtime operations check the actual journal head. Preserve current target capability, exact scope/read request approval and separate mutation approval/backup/restore requirements where applicable. A read-only audit does not acquire write prerequisites. Workers own their task-scoped outputs; the coordinator owns shared workflow projection and decisions.

After each terminal task outcome, preserve the existing `next-work.mjs` user-attestation frontier before the next dispatch. Technical success cannot create a user attestation. The final `content.approve` task requires the existing evidence-bound `phase-continuation` gate and cannot be skipped, automatically accepted or replaced by a passing audit. Presentation/visual verification remains separate. Media binary parity is established only by the opt-in media tasks and their independent readback, never by the content audit.

For `content.approve`, the orchestrator retains task and human-decision ownership. It delegates technical replay and final domain/shared postflight validation to the tester, which has sandbox execution tools. The tester reconfirms the exact current audit before user review; after the orchestrator records the actual phase decision, the tester checks the final packet and outputs. The orchestrator reads back those checks before completing its task. The tester cannot supply a user response or approve the migration. Any changed checkpoint, mismatch or unresolved issue returns to audit/review rather than accepting an old report.

Pass `integration-report.json`'s `requiredEvidenceKindsByTask[taskId]` to the existing `validate-task-attempt.mjs` request as `requiredEvidenceKinds`. This makes missing domain evidence a failed postflight rather than an optional worker check. Retained Discovery entities and their mappings remain intact; logical operation counts never replace source-to-target coverage from the content audit.

## Domain outcome before shared task evidence

Create version 1 `mapped-outcome-input.json` with a hash-bound `packet` file descriptor and actual `outputs: [{role,path,sha256}]` descriptors matching the immutable operation asset.

```sh
node validate-mapped-outcome.mjs --input /workspace/mapped-outcome-input.json --output /workspace/new-mapped-outcome
```

The local validator returns the domain report. Require `valid: true` before recording the existing seven-field task result; attach the report using `evidence.kind: mapped-content-operation`. The shared CMS evidence validator dynamically reruns the domain validator from the report's packet and outputs. A fabricated report, spoofed passed checks, CLI exit code or worker narrative cannot establish completion.

For valid outcomes the CLI also emits the existing CMS `entity-result` evidence for each logical operation entity in the packet. Attach those files with `evidence.kind: entity-result` and the exact `evidence.entityId`; these supply technical per-entity coverage to the native frontier. They do not record human verification. The coordinator must separately obtain the existing evidence-bound user verification decision, run normal evidence validation and use its actual `entityAttestations` before the next dispatch. Never manufacture a `validation` object or user attestation from a technical pass.

For canonical ready execution plans with `batches: []`, there is no supported batch or execution review to select. The operation asset requires only the unchanged `checkpoint` output; `executionReview` and `executionReceipt` outputs are optional. Domain postflight must prove the unchanged checkpoint and canonical zero batches before completing without writes. The execution input may omit `batchId` for that empty case. Do NOT call `prepareExecution` with a fake batch ID, approval or receipt.

Nonempty plans still require actual execution reviews. Newly mutated outcomes require actual bound receipts and current journal evidence. Already executed nonempty plans may complete with a fresh supported no-op review and verified current journal/resume evidence; never fabricate receipts to fill an optional role. A historical execution output checkpoint may be a verified ancestor after later reference writes; the independent final audit still requires the CURRENT actual journal head. Never count a proposal as executed work or advance from partial/unknown outcomes. Preserve the original target writer/recorder safety and recovery gates.

Persist task-owned domain reports and the complete shared task result under the assigned attempt. Follow [execution handoff](execution.md#handoff--record-task-results-and-downstream-identities) and existing coordinator postflight/verification decisions. This integration does not publish a recipe, create Kajoo work merely by loading the skill, perform remote migration or prove live project compatibility.
