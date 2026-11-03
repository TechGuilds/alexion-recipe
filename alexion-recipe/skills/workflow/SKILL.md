---
name: workflow
description: Use when coordinating or resuming tasks across phases with sequential or parallel dependencies.
---

# Workflow

Use one small JSON file, chosen by the domain skill. Read and update it with native file tools. This is a coordination convention, not a scheduler or memory journal.

Read [state-contract](references/state-contract.md) before creating a plan and [parallel-and-sequential](references/parallel-and-sequential.md) before dispatching workers.

## Execution

1. Read existing progress; create a plan only when absent. Confirm the intended outcome and scope.
2. Pick the earliest unfinished phase. Required `dependsOn` prerequisites must be done or explicitly skipped. A task with `optionalDependsOn` waits for those tasks to become done, skipped or failed; failure permits only the enrichment-tolerant dependent to continue, while the failed task and phase remain incomplete.
3. Resolve optional agent hints against currently available roles. A deleted or repurposed agent does not invalidate the task.
4. The coordinator is the only writer of shared progress. Mark selected tasks running; give workers separate output paths.
5. Check actual outputs using the domain's acceptance rules. Record one concise result reference and update status.
6. At a user gate, wait for an explicit answer. Technical success is not user approval.
7. On resume, inspect running jobs and artifacts before retrying. Preserve completed work; invalidate downstream evidence when its inputs change.

Use native edits for ordinary updates. Run `node /mnt/skills/workspace/workflow/scripts/validate.mjs <workflow.json>` before dispatch and after edits; fix structural errors first. Read this skill first to stage its resources. Exit 0 means structurally valid, not complete or approved; inspect `valid`, `errors`, `currentPhase`, `runnable`, per-phase counts and `complete` in the JSON result. See [validator](scripts/README.md) and [example](assets/example.json). Memory stores durable lessons, not workflow tasks.

## Mandatory phase-boundary gate

A phase completion is never permission to begin the next phase. When the current phase completes, reconcile evidence and persist a phase-boundary record containing the phase ID, verified/done work, pending/failed/blocked items, unresolved risks and exact next-phase scope. Setup asks whether to enter Discovery. Discovery first prepares a complete evidence-based next-workflow draft, asks for task granularity per applicable workstream, and gets explicit `workflow-plan` approval before synchronizing future epics/tasks. After synchronization, ask separately whether to `continue` to the named phase, `pause`, or `resume in a new chat`; record that `phase-continuation` choice. Neither conversational gate is a project task; leave next-phase work pending until the user explicitly chooses to continue.

## Setup completion and blocker gate

Setup is complete only when the domain-specific acceptance contract is satisfied: every required check is terminal with verified evidence, `setup-prerequisites.status` is `complete`, the Setup summary and phase-boundary record are persisted, and required initialization assertions succeeded. If any check is pending, failed, blocked, canceled, timed out, or missing verified evidence, keep Setup incomplete/blocked and do not offer `continue to Discovery`.

## Discovery-defined later phases

Use a two-tier workflow template. Setup and Discovery are stable phases shared by the migration family. Later phases are derived from findings; domain-specific golden examples are non-exhaustive. Evidence must justify scope, while detailed implementation validation may be an explicit first task. Resolve uncertainties that would change phase selection before presenting the complete plan for approval. Derive dependencies from findings and create/synchronize tasks only after approval. Ask task granularity per applicable workstream using its migration units; do not assume one task per raw inventory entity. When a user-selected batch maps several entities to one workflow task, map each entity to that task and dispatch/audit the batch as one unit.

## Kajoo project-plan synchronization

Read `references/kajoo-plan-sync.md` before creating or editing workflow phases/tasks. Recipe creation already seeds predefined phases as Kajoo epics and starter tasks; reconcile against those records rather than duplicating them. Every workflow status transition, phase/task addition, rename, or removal must be reflected in the bound Kajoo project plan and read back before execution continues. A missing or stale binding blocks the affected work.
