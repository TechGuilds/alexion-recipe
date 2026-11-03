# Workflow integration and task handoffs

Use the existing coordinator workflow, Kajoo task lifecycle, decisions and seven-field task result. The [operation catalog](../assets/workflow-operations.json) is authoritative for task IDs, owners, input/output roles, procedures and entry points. These are logical operation entities, not CMS items or content counts.

| Phase | Task | Owner |
| --- | --- | --- |
| Presentation Composition | Compose virtual presentation | Sitecore developer |
| Presentation Composition | Generate target-data mock layouts for preview | Frontend developer |
| Presentation Composition | Navigate preview pages and review rendering coverage | Tester |
| Presentation Composition | Apply Target Presentation | Sitecore developer |
| Presentation Composition | Verify applied target presentation | Independent tester |
| Presentation Composition | Review presentation composition outcome | Orchestrator |
| Verification | Verify target website appearance and functionality | Tester |
| Verification | Review final migration outcome | Orchestrator |

## Plan the work

Run `prepare-presentation-workflow.mjs --input REQUEST --output NEW_DIRECTORY` locally. Its strict `workflowInput` selects the scope, current planning task, hash-bound active workflow/inventory/task mappings, existing approved mapping decision, current evidence and `prerequisiteTaskIds`. Include the existing content phase's final approved handoff as a prerequisite. The proposal can be prepared before that work finishes; execution remains dependent on it. Setup, Discovery, mapping/destination planning, target content/reference verification and preview foundation remain their existing owners' work. Missing normalized source presentation, target definitions or content identities are bounded handoff gaps; do not repeat broad Discovery or invent them.

The builder preserves existing tasks and inventory and adds status-free Presentation Composition and Verification phases. Exact structural resume retains IDs; conflicting manual phases or active code/SXA conversion/resolver work require explicit reconciliation. A blank Headless SXA site requires verified site/component/template readiness, not an automatic tenant conversion or source-code migration. The content transfer mechanism remains whichever was explicitly approved; this procedure does not select or replace it.

Present the complete proposal and acceptance criteria for the existing `workflow-plan` approval. Validate it with `validate-workflow-plan.mjs`, materialize with `materialize-approved-workflow.mjs`, then let the coordinator synchronize existing Kajoo phases/tasks and read back dependencies/status/bindings. Validate that projection with `validate-workflow-sync.mjs`. Proposal creation and loading the skill never activate tasks or write shared workflow state. Ask separately for the existing `phase-continuation` decision before starting the next phase.

## Dispatch one operation

The coordinator supplies `presentationInputs: [{role,path,sha256}]` to the existing `prepare-task-packet.mjs`, using exactly the input roles in the catalog. Each descriptor must also be in the current packet `inputs`. The producer derives `packet.presentation`; never hand-edit its entry points, procedure, roles or entity identity. Preserve the packet's exact scope/task/target/attempt roots and input hashes. `presentationInputs` cannot be combined with mapped-content operation roles. Content-transfer decisions may remain historical context but do not select presentation commands.

For completed canonical tasks in the active phase, supply `priorTaskAttempts` referencing each immutable native postflight request. The producer reruns its actual task evidence against current workflow and decisions, then uses the existing next-work user-attestation gate. Stage packet requests at the same workspace boundary used by prior postflight paths. Different operations can consume different inputs; never fabricate a validation object to advance past a previous task. A failed check returns only its named bounded repair work.

Owners load this skill and the catalog-selected procedure. Sitecore reads and writes use the selected connectors; the generated request combines shipped script bytes and exact parameters. Frontend work installs approved public mock layouts into an existing verified app; it does not convert components or scaffold an unknown application. Navigation uses the generated mock-layout navigation tree and covers at least the agreed page count and every required rendering/variant. The tester retains actual browser evidence and the orchestrator obtains actual user responses. Pause, rejection, missing coverage or stale evidence blocks affected work.

Target application requires an additional exact mutation approval after the dry-run. Reuse the [application journal and recovery procedure](application.md); do not add another execution-state store. Input/output `checkpoint` roles refer to immutable files in the actual journal, never `head.json`. Unknown jobs remain blocked until reconciled. An empty mutation plan requires no fabricated batch, approval or receipt; verify its unchanged journal and independent target state. A successful applied result includes the actual journal history and fresh application audit. The separately assigned tester audits independently afterward.

## Validate completion

Run `validate-presentation-outcome.mjs --input REQUEST --output NEW_DIRECTORY` with `outcomeInput` containing the packet path/hash and actual output role/path/hash descriptors. Require its `valid: true` report before shared postflight. It replays canonical operations and verifies actual installation, journal/audit and website evidence as applicable; a ready plan cannot substitute for execution. The CLI emits the domain report and standard CMS entity-result files. Use the exact emitted artifact descriptors.

Attach the domain report with `evidence.kind: presentation-operation`, and each logical entity result with `evidence.kind: entity-result` and its exact entity ID. Shared `validate-evidence.mjs` reruns domain validation rather than trusting claimed checks. Pass `integration-report.json`'s `requiredEvidenceKindsByTask[taskId]` into the task's existing `validate-task-attempt.mjs` request. The worker persists its complete task result and technical report; the coordinator independently checks postflight before updating shared progress.

Obtain the existing evidence-bound user verification for each completed operation before the next dispatch. Technical success does not create a user attestation. `presentation.approve` and `verification.approve` remain orchestrator-owned and require an output `phaseDecision` of existing kind `phase-continuation`, choice `approve`, bound to the exact current packet inputs. The decision is an output, avoiding a circular hash dependency. These gates cannot be skipped or accepted from a passing screenshot/audit. The orchestrator delegates technical replay/postflight to the tester, which has sandbox tools, then reads back those checks and records only the actual user's decision.

Final Verification follows [target website verification](verification.md). It uses actual post-application target payloads and browser evidence plus an approved source screenshot baseline. A preview pass, content count or successful SPE job does not prove unchanged appearance or functionality. Record capture limitations, selected routes and any missing target evidence explicitly; never substitute preview or other non-target evidence. Publishing and media binary transfer remain separate work.
