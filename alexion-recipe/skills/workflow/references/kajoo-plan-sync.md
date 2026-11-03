# Kajoo workflow-to-plan synchronization

Use plain phase titles such as `Setup` and `Discovery`. Do not add numbered prefixes or migration-name suffixes (for example, `— Website migration`). Use numeric `rank` for ordering and artifact/binding IDs for identity, not title decorations. Never adopt an unrelated same-name epic; if find-or-create returns a collision, report it rather than silently linking it or inventing a decorated title.

The native migration workflow and Kajoo project plan represent the same execution plan in different systems. `workflow.json` is the coordinator's machine-readable execution authority; Kajoo project epics/tasks are the user-visible MongoDB-backed projection. They must be synchronized, not treated as independent plans.

This recipe does not seed phases. The migration-artifact skill creates and links the five-task Setup phase using returned IDs. After the independent audit, `setup.prepare-discovery` uses CMS migration to create the visible Discovery plan; explicit continuation authorizes only its execution. Synchronize only records explicitly bound to this migration artifact. Do not adopt unrelated project epics/tasks by name or create a competing Setup phase. On resume, recover missing bindings only from verified records belonging to this same artifact and preserve completed work. Keep Setup in the active workflow and bindings after handoff so `content.phases` exactly matches the migration's bound epic IDs.

For unstarted Discovery tasks, preserve the planning classification in `reports/discovery-plan.json`: actionable procedures are Kajoo todo/workflow pending; missing task-specific inputs are Kajoo draft/workflow blocked. Do not overwrite that draft with generic blocked synchronization, auto-promote it on phase continuation, or interpret workflow reachability as execution approval. Promote it only after its actual missing inputs are resolved. Ordinary failed or blocked executions still use the status mapping below.

Persist `${MIGRATION_STATE_FILE_DIR}/reports/kajoo-workflow-bindings.json` with the project ID, workflow phase/task IDs, corresponding Kajoo epic/task IDs, and the last reconciliation time. The workflow ID is the stable identity; never match only by display name after a rename. Re-read the binding and current project plan before every reconciliation.

Owners save/read back their Kajoo task lifecycle and final Technical report. For a validated owner result, the coordinator projects that outcome into the bound workflow without finishing or rewriting the owner’s task. If a correction is required, return it to the same owner. For coordinator-owned tasks and direct coordinator status transitions, update the bound Kajoo task in the same turn and read it back:

| Workflow status | Kajoo task status |
| --- | --- |
| pending | todo |
| running | in-progress |
| done | done |
| blocked | blocked |
| failed | blocked, with failure evidence |
| skipped | done only with an explicit skip decision and `workflow:skipped` tag/rationale |

The Kajoo epic status is a projection. Update its ordering, dependencies, description and status override when the phase changes. Epic status supports `todo`, `in-progress` and `done`; blocked/failure detail remains visible through task `blocked` status and epic progress `blockedCount`.

Discovery's candidate phases and tasks remain a status-free proposal until the user approves the complete workflow plan. Do not create or mutate later-phase epics/tasks or add their IDs to Migration Artifact `content.phases` before that approval. Hash the proposal plus every current Discovery evidence file and validate the recorded `workflow-plan` decision with `cms-migration/scripts/validate-workflow-plan.mjs`. After approval, run `cms-migration/scripts/materialize-approved-workflow.mjs` once with the proposal, current active workflow and completed planning-task ID; promote its returned workflow to active `workflow.json`. Then create each approved epic first, then its tasks, then dependencies; write and read back the bindings before dispatching any work. Validate proposal structure, active workflow, bindings and Migration Artifact epic IDs with `cms-migration/scripts/validate-workflow-sync.mjs`; a mismatch blocks dispatch. Do not mutate or re-read the proposal as a second workflow state after promotion. Then request a separate `phase-continuation` decision before executing a next-phase task. When tasks are added, removed, renamed or re-scoped after approval, reconcile both `workflow.json` and the corresponding Kajoo records. Remove an epic/task only after an explicit applicability or scope decision; use the native delete operation so the user-visible plan reflects the change. Never silently leave orphaned Kajoo tasks or keep a deleted workflow task bound to an active plan.

After every workflow edit and before a phase handoff, verify: every live workflow phase has one bound Kajoo epic; every live workflow task has one bound Kajoo task; statuses match the mapping; dependencies point to records in the same project; removed records are deleted or explicitly retained as history; and the sync report was read back. A partial reconciliation is a blocker for starting the affected task/phase.
