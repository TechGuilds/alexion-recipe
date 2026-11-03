---
name: cms-migration
description: Use when planning, executing, validating or resuming a CMS migration with multiple phases and user handoffs.
---

# CMS migration

For progress updates and final responses, follow [chat communication and task results](references/task-results.md#chat-communication). Start each task with a short user-friendly opening, give meaningful progress updates, and populate bash descriptions when the purpose is known. Keep detailed technical evidence in files and explain migration outcomes in chat.

Keep reusable recipe instructions, templates, examples, scripts and tests free of client
names and identifying repository names, domains, URLs or project IDs. Use neutral
placeholders and synthetic fixtures. Actual client configuration belongs only in the
current project's artifact, sandbox state and scoped evidence; never copy it back into
the shared recipe or shared skill examples.

Use the shared workflow contract for phases, tasks, dependencies and optional agent hints. This skill adds migration scope, evidence and approval rules; it does not implement a scheduling engine.

[Native filesystem CLIs](scripts/README.md) implement workflow proposals, evidence validation, coverage, next-work recommendations and context validation. `${MIGRATION_STATE_FILE_DIR}/context.json` holds the non-secret migration facts every agent reads first; see the [context file](references/context-file.md). Which item to dispatch next, and why some wait, follows [work ordering](references/work-ordering.md). Follow the [executable contracts](references/executable-contracts.md) for staged inputs, scoped reads and current decision fingerprints. Remote work requires available connector primitives. Repository clone, checkpoint commits and pushes follow [git operations](references/git-operations.md).

## Start and resume

Resolve `MIGRATION_STATE_FILE_DIR` from the sandbox command environment. It follows the current artifact's `content.stateFileDir`, with `/workspace/.kajoo/<projectId>` as the default when omitted. Before inspecting state, follow migration-artifact's guarded inspection procedure: verify the directory and individual files before listing or reading them.

A missing state directory means initialization is required; it is not an inspection failure. The coordinator owns initial workflow/binding creation. Assigned workers must report missing required state to the coordinator and preserve existing project records. Tools do not initialize migration state automatically.

Quote shell paths. For native file tools and JSON, resolve the variable first and use the actual path; never save the literal variable expression. The [context file](references/context-file.md) explains compatibility roots and workspace-relative tool destinations.

Resolve skill files from the loaded skill's actual root, not the current shell directory or a guessed mount path. Within this skill, the profile Setup procedure is `references/profiles/<profile-id>/pipeline/setup.md` and generic Discovery is `references/pipeline/discovery.md`; neither is under a top-level `pipeline/` directory. Use the active profile's recorded ID. For another skill, load that named skill and resolve its referenced file from its own root rather than constructing `../` paths between skills. Check the exact file exists before reading it; if a reference is missing, inspect only the containing directory once and report the mismatch instead of trying guessed paths in failing commands. Preserve canonical source references; do not copy files to make a guessed path work.

Before constructing an evidence inspection/audit helper, follow [JSON evidence shape checks](references/context-file.md#inspect-json-evidence-before-composing-helpers). Reuse the observed shape within the attempt instead of repeatedly dumping or rediscovering the same file.


Read [workflow state](references/workflow-state.md), [workspace setup](references/workspace-setup.md) and existing scope before acting. Keep progress in one workflow JSON, detailed results in evidence files, and durable lessons only in platform memory. Treat the active workspace's approved workflow, migration artifact and current evidence as its state; never infer approval from undocumented or stale records.

The migration-artifact skill owns initial artifact creation and the five-task Setup phase. Enter this skill for `setup.cms` only after both owners’ isolated source/target role configurations, task results and reports are verified, reusing their actual IDs, selected repositories, references and evidence. Keep the profile's detailed Setup procedures, but do not create another Setup phase or repeat completed preparation. Discovery is materialized by [Discovery planning](references/prepare-discovery.md) within `setup.prepare-discovery` after the artifact-owned audit. [Discovery entry](references/start-discovery.md) starts that existing plan only after explicit execution continuation. The recipe pre-seeds no phases.

Evidence reuse is the default for every phase. Before dispatching a worker or
probe, resolve the task's existing evidence and its scope, connector/revision
and input fingerprints. Reuse a compatible current result by reference rather
than repeating the same discovery, source analysis, connector probe or target
read. Re-run work only when the prior evidence is missing, stale, incompatible
with the requested scope, incomplete, or cannot answer a new mutation-safety
question. A later phase consuming Discovery evidence never turns that need into
another Discovery task.

Use the platform's current Memory instructions and native read/write/edit tools only for reusable lessons. Migration state belongs in the artifact and execution evidence, not in a parallel memory ledger. Reuse applicable lesson entries; never create a memory record per task, component, attempt or approval.

## Domain profile boundary

This hub is platform-neutral. The active domain skill owns supported source/target pairs,
phase procedures, and any platform-specific phase catalog. Load that skill before selecting a
profile phase; do not add vendor names, connector assumptions, or platform operations here.

The domain profile's workflow remains the execution authority, while the recipe UI workflow is
only its user-visible phase projection. Setup and Discovery may be stable for a migration family;
later phases must be selected from domain evidence and synchronized into the Kajoo project plan.

## Coordination

The coordinator alone writes shared workflow progress. Workers receive a stable task ID, scoped inputs, output path and acceptance criteria, then return one [task result](references/task-results.md). Reassign missing or repurposed agents without changing IDs or resetting completed work.

For a mapped implementation task, the coordinator runs `next-work.mjs` once and
uses `prepare-task-packet.mjs` to produce one immutable selected-task handoff
before dispatch. The packet has only that task's mapped entities, declared
current evidence references, target/attempt roots and acceptance checks. It is
not another state store. Dispatch from the packet; do not re-read global task
lists, schemas, skill source or unrelated reports to reconstruct the work item.
Once the packet validates, its generated inputs, ordering and summary are
authoritative: do not hand-edit it, re-sort it to imitate a tool result or
rebuild it from the same unchanged state. A validation failure returns its
named input or rule violation as the only bounded recovery work.
The active domain profile declares the admissible evidence references. A missing,
stale or contradictory declared reference is a bounded blocker, not permission
to rediscover broad source, route or platform facts.

For a modifying task, the coordinator supplies the task-owned postflight-request path
with the dispatch. The worker writes its attempt result, runs the prescribed
`validate-task-attempt.mjs` preflight once, and repairs only its own malformed evidence
before returning a successful result. Evidence paths are workspace-relative; changed-file
and checkpoint paths are relative to the request's declared target root. The coordinator
reruns the same independent postflight after the worker returns. `unresolved` is reserved
for acceptance blockers, never ordinary observations or later-task scope boundaries.

Use fresh bounded developer tasks for individual components/adapters. Workers ask task-local questions; the coordinator asks workspace, scope, loop and phase-continuation questions. Follow the dependent-question rules in [decisions and approvals](references/decisions-and-approvals.md): resolve prerequisites before asking dependent questions, and batch only independent choices. Do not turn an unverified worker success into done.

At each phase boundary: reconcile inventory and evidence and report verified/pending/skipped/failed work. Setup then prepares the visible Discovery plan and asks for explicit execution continuation. Discovery first completes its evidence audit, proposes the evidence-applicable later workflow and gets a separate `workflow-plan` approval before that plan is synchronized. After synchronization, ask separately whether to start the named next phase now, pause or resume in a new chat; a new chat is not approval to run it. Final acceptance is an explicit user decision.

## Evidence and recovery

Before any terminal worker handoff, follow [task-result validation](references/task-results.md#validate-every-terminal-handoff), including skips and blocked outcomes. Before publishing a report artifact, follow [bounded summary publication](references/procedures/migration-report.md#publish-a-bounded-summary); detailed evidence stays in task files.

Use [coverage audit](references/procedures/coverage-audit.md), [visual parity](references/procedures/visual-parity.md), [interaction parity](references/procedures/interaction-parity.md), [data contracts](references/procedures/snapshot-data-contract.md) and [migration report](references/procedures/migration-report.md).

Preserve source safety and [checkpoint scope](references/checkpoints.md). Remote writes need explicit authorization and appropriate remote backups. HTTP readiness, a schema pass or a successful job alone never proves migration fidelity.

## Hard phase handoff

The phase table is an execution catalog, not permission to auto-advance. After Setup verification passes, execute `setup.prepare-discovery` to create the visible plan, persist its summary, and ask whether to start Discovery, pause or resume in a new chat. At Discovery completion, persist the audit, propose and obtain approval for the full evidence-led later workflow, then synchronize the approved plan. Workflow-plan approval alone is not permission to execute it: ask whether to start the named next phase, pause or resume in a new chat, and record that scoped `phase-continuation` decision first. No approval/continue placeholder task is used for either conversational gate.

## Setup completion and blocker classification

Setup is complete only when every required check is terminal with independently verified evidence, `setup-prerequisites.status` is `complete`, the Setup summary and phase-boundary record are persisted, and any required initialization assertion has succeeded. Classify issues as `setup-blocking`, `phase-deferred`, `warning`, or `verified`.

Any `setup-blocking` item, or any required check that is pending, failed, canceled, timed out, or missing independently verified evidence, keeps Setup incomplete/blocked. A heuristic topology/license mismatch is unresolved evidence until independent capability probes confirm an actual incompatibility; it is not by itself a `setup-blocking` result. Do not mark Discovery runnable or offer `continue to Discovery`; present the blocker list and offer only resolve/retry Setup, pause, or resume in a new chat. A worker cancellation or timeout is not a pass.

A tool argument-binding, parameter-schema, serialization, or known invocation-shape error is an execution-contract defect, not a platform capability result. Preserve it, then make one automatic correction to the same bounded probe without changing scope or mutation intent. If that retry reaches a terminal failure, classify from its evidence; never loop or ask the user to authorize a safe corrective invocation retry.

## Discovery-defined later phases

Use a two-tier workflow template. Setup and Discovery are stable phases shared by the migration family. Read the active domain profile's phase-catalog asset as non-exhaustive golden examples; findings may justify additional phases. Reconcile source/target evidence and resolve gaps that change phase selection during Discovery, while retaining the profile's optional-enrichment and later-validation rules. After audit, ask task granularity per applicable workstream using the profile's migration units, and present the complete phases/tasks/dependencies in structured tables or bullets for approval. Keep the draft outside the active workflow and Kajoo project plan until approval. Then synchronize only applicable phases/tasks and evidence-derived dependencies. A phase is not active until its applicability decision and approved user-visible plan records are synchronized.

## Migration artifact boundary

Read `references/migration-artifact-contract.md` before collecting or recording migration metadata. The artifact is the durable migration description and plan; sandbox files remain execution state and evidence. Use only the existing artifact fields and never put workflow status, probe payloads, approvals, credentials or raw errors into it.

At CMS Setup entry, retrieve the existing project-scoped migration artifact and its verified
Setup bindings; missing preparation returns to migration-artifact. Store its ID in `context.json`
and preserve the explicitly linked phase IDs in `content.phases`; do not proceed with a sandbox-only metadata record. After each ordered Setup
checkpoint, retrieve the artifact, merge only verified supported `source`/`target`/`repos`/
`references` facts, and keep that epic-ID list synchronized with the Kajoo project plan. The
workflow, evidence, decisions and reports remain the execution authority; task IDs/statuses and
epic objects do not belong in the artifact.
