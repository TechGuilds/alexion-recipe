# Decisions and approvals

Keep concise keyed decisions in decisions.json: stable id, kind, scope, choice, rationale, evidence references and the user response/time where applicable. Kinds include scope, mapping, overwrite, mutation, verification, workflow-plan and phase-continuation. Do not store an append-only task transcript.

For a code-migration entity that requires visual attestation, technical success and human visual attestation are independent facts. After the user actually reviews the rendered evidence, record one `verification` decision keyed by `taskId` + `entityId`, with choice `verified`, `not-verified` or `pause`, the user's response/time and hashes of the selected task-result file plus that task attempt's evidence files in `inputs`. The evidence validator reports this separately as `attested`, `not-verified`, `paused`, `unattested`, `stale` or `ambiguous`; it does not turn technical success into an attestation. A changed attempt/evidence hash invalidates the prior decision. Keep one current keyed decision per entity/task; do not treat a continue/skip response as verification.

Approval comes from an explicit user response scoped to the proposed action and current inputs. A developer's success, timestamp, previous chat summary or imported technical completion is not approval. Changing target identity, overwrite scope, mappings or reviewed content invalidates the corresponding approval.

For a content transfer, record separate decisions for scope/exclusions, mapping
or remap, and each target mutation batch. The result must bind the decision to
the current input/plan manifest hash and exact entity or namespace list. A
target audit mismatch remains an observed mismatch until the approved scope or
target state changes; a user acknowledgement alone does not convert it to a
passing check.

The coordinator asks phase/workspace/loop questions. A worker asks bounded implementation questions. User verification and next-action choice are separate: not verified does not mean redo, and continue does not mean verified. Phase continuation is a recorded conversational boundary decision, not a project task. Ask when intent is unclear. Required safety approvals and boundary decisions cannot be inferred or skipped merely to satisfy a dependency.

### User question dependencies

Coordinators and workers must batch questions only if every question remains relevant and its options remain valid regardless of the other answers. Otherwise ask the prerequisite question alone, wait for the answer, fetch any newly relevant facts or candidates, then ask the next question through `kajoo/ask-user-input`. Do not include speculative "If you choose..." follow-ups in the same request. Reuse confirmed answers; independent preferences may still be asked together.

For example:
- Confirm a connection before discovering its repositories, then confirm a repository before fetching its branches.
- Confirm a site before fetching its available languages and asking which to use.
- Confirm full-migration/discovery-only workflow scope before its dependent scope questions; ask Discovery-only surfaces only when Discovery-only was selected. Content transfer method selection is a separate profile-owned decision after sufficient Discovery evidence.
- Confirm the destination repository/app and proposed initialization action before requesting approval for that exact mutation or push. If the destination or action changes, obtain the applicable approval for the new scope.

### Implementation verification frontier

After a worker returns a `TASK_RESULT`, the coordinator must follow this order:
`TASK_RESULT` → validate raw evidence with `validate-evidence.mjs` → `kajoo/ask-user-input` with a structured rendering table → persist one hash-bound verification decision per mapped entity → run `next-work.mjs` → dispatch the next worker with `kajoo/run-agent`. A completed technical task is not permission to advance. The table must show the task ID, rendering/entity ID, route or preview evidence, technical checks and unresolved items, with `Verified`, `Needs rework` and `Pause` choices. A grouped prompt is allowed, but every mapped rendering still needs its own current decision. `next-work.mjs` must return `waiting` when any decision is missing, stale, paused, not verified or ambiguous; only current verified decisions unlock the next task. Do not update the next task to `in-progress` or invoke its worker before that gate passes.

After Discovery, first present the complete evidence-applicable phase/task/dependency proposal and ask for `workflow-plan` approval. It includes the structural shape of already-active work as well as proposed later work, but contains no runtime status. Record approval or requested revision against the Discovery scope, proposal hash and exact current evidence fingerprints. Run `validate-workflow-plan.mjs`; an empty, stale, conflicting or non-approved decision is invalid. A rejected or revised proposal is not written to the active workflow, Kajoo project epics/tasks or Migration Artifact. After approval, run `materialize-approved-workflow.mjs` with the approved proposal, current active workflow and completed planning-task ID, then promote its returned active workflow before synchronizing project-plan records and the artifact's existing phase-ID list. Run `validate-workflow-sync.mjs` against the approved proposal, active workflow, read-back bindings and artifact epic IDs; it validates plan structure independently of runtime status. Do not later use the proposal as a second status store; it remains only to verify the user's approval. Only then request a separate `phase-continuation` decision before executing any next-phase task. Approval of the plan is not execution approval, and neither decision is represented by a synthetic task.
