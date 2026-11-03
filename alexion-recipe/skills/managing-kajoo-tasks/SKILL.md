---
name: managing-kajoo-tasks
description: Create, execute, and resume Kajoo tasks and epics across chats. Load scoped context, follow dependencies, and save progress and honest lifecycle status.
---

# Manage Kajoo epics and tasks

Use for creating, updating, or executing Kajoo tasks and epics in the current project. Use supported Kajoo tools; discover missing tools and check their schemas before writes. Reuse verified IDs and context, fetch missing details, and preserve unrelated fields.

## Required tools upfront

Tool names below are base names. Kajoo MCP tools may be exposed with the `kajoo__` prefix, for example `kajoo__list-tasks`, `kajoo__update-task`, or `kajoo__create-epic`. Resolve each base name to the matching tool on the Kajoo MCP server and invoke its exact exposed name. Do not treat a tool as missing merely because it is prefixed, or guess a name without checking active tools/discovery.

Check active tool schemas and load only missing tools required for the requested operation before the first write. Reuse verified context and successful results; do not require every tool for every request.

| Operation | Tools to check |
| --- | --- |
| Read/find tasks | `list-tasks`; `get-task` for details not already available |
| Read/find epics | `list-epics`, including supported task/progress details when needed |
| Create | Prefer `bulk-create-tasks` for several linked tasks, or `create-task` for one; `create-epic` for phases; relevant lookup tools to avoid duplicates and verify links |
| Update | Prefer `bulk-update-tasks` for a related batch, or `update-task` for one; `update-epic` for phases; relevant lookup tools for current state and verification |
| Execute a task | `update-task` for start and finish statuses, task lookup tools, and the tools needed to perform and verify the actual work |
| Delete | `delete-task` and/or `delete-epic`; relevant task/epic lookup tools to inspect scope, dependencies, and verify the result |

If a required capability is unavailable, explain what is missing before making changes; do not start task work if its lifecycle updates cannot be saved. Use returned records to verify writes when sufficient; fetch only missing confirmation. Deletion requires explicit authorization for the exact scope and any required tool confirmation. Do not assume deleting an epic deletes its tasks.

## Load context for a specific task

Use the same procedure whether the user starts a task, asks in chat, or another agent
delegates it. A task reference is enough; copied descriptions and previous chat history
are not authoritative.

1. Read the current task with `get-task`, including its description, Technical report,
   status, revision, assignment, `epicId`, `dependsOn`, and `linkedTasks`. Preserve the user's requested
   scope; a request for one task does not authorize executing the rest of its epic.
2. If `epicId` is present, load that epic's description and dependencies through the
   supported epic lookup. Read its shared objective, constraints, and completion
   criteria. A standalone task needs no epic. Resolve conflicting task/epic instructions
   before dependent work; do not silently discard either requirement.
3. Check direct task prerequisites and parent epic prerequisites using current compact
   records. Required prerequisites must be complete before execution. Do not recursively
   load every predecessor description: fetch full reports and linked evidence only when
   their outputs are required for this task. Rank is not a substitute for dependencies.
4. Read the linked artifacts and relevant evidence needed for the current work, then
   load the applicable domain skills. Missing required evidence is a blocker even if
   its producing task says done. Do not guess file paths or results.
5. Use the saved Technical report to recover completed steps, remaining work, decisions,
   and the next action. Verify relevant working files before resuming; do not repeat
   successful work or treat an interrupted chat as proof of completion.

Keep full context for the current task and its parent epic. Upcoming tasks normally
need only names, statuses, dependencies, and assignments. Load their full descriptions
when selecting them for execution, not all at once. Reuse verified reads within the
current run; refresh affected records after changes, before scheduling, and on conflicts.

## Resume a project or epic

For requests such as "continue" or "go ahead", follow the current conversation when
its intended work is clear. Ordinary requests, inline checklists, and discussion of
potential tasks do not authorize creating or selecting saved tasks. If intent is unclear,
ask whether the user wants to resume a saved Kajoo task/epic or continue other work
before looking up tasks. Existing project tasks alone do not establish that intent.

Once tracked work is confirmed by the request or clear conversation context, resolve
any explicit task/epic reference first. Otherwise inspect compact project epic/task
lists, following pagination as needed;
do not assume the first page is the whole plan. Narrow queries to the requested scope
and fetch full descriptions only for relevant candidates.

- Prefer relevant unfinished work, but do not assume `in-progress` means abandoned.
  Check available run/chat activity before taking it over; `chatId` alone is not proof
  that a worker is active or stopped. If ownership cannot be established, clarify
  before duplicating execution. Status/assignment fields are not execution locks.
- Keep `review` work awaiting its required review and inspect `blocked` work for whether
  its blocker has actually been resolved. Neither status automatically means ready.
- Select ready work within the requested plan using dependencies first, explicit rank
  for ordering, and priority when no clear order exists. Absent dependency links do not
  authorize unrelated work or prove concurrent execution is safe.
- If several unrelated epics or standalone tasks plausibly match "continue", ask one
  focused scope question. If one plan is clearly intended, proceed and briefly tell
  the user what is complete and what you will work on next.
- After completing work, refresh relevant statuses and continue only within the user's
  authorized scope. For an epic request, coordinate its remaining tasks; for a single
  task request, stop at that task. Do not automatically start a dependent epic.
- Independent tasks may run in parallel only when their outputs, files, checkouts, and
  shared resources are isolated. Otherwise serialize them. Do not invent dependencies
  solely to choose among unrelated tasks.

## Durable context and checkpoints

Use existing task and epic fields. Epic descriptions hold shared goals, constraints,
and completion criteria; task descriptions hold scoped instructions, acceptance criteria,
and the final Technical report section. Status and dependency fields remain authoritative.
Do not copy mutable task status, a current-task pointer, or the plan into the project
description or a second execution-state file. Domain evidence files may hold detailed
outputs and verification data, with exact references in the task report.

Save a checkpoint after meaningful milestones and before an intentional pause or handoff,
not after every tool call. Update the existing Technical report with completed work,
remaining work, material decisions, evidence references, blockers, and the next action.
Keep verified results still needed for resumption when updating the report. Another run
must be able to continue from the task and evidence without the original conversation.
An abrupt interruption may prevent a final save, so intermediate checkpoints matter.

## Task lifecycle (required)

1. Resolve the task in the current project and read its scope, acceptance criteria, dependencies, and current status. Do not duplicate an existing task or restart completed work without a requested change.
2. Before direct task work, update its status to `in-progress` and confirm the update succeeded. For delegated work, the owner marks its Kajoo task in-progress when execution starts; the coordinator treats the worker as running only after the real dispatch is accepted. Assignment alone is not execution. If already `in-progress`, verify that it is this run's task rather than another active worker's. If a required dependency or input is missing, set `blocked` instead and explain what must be resolved. If the status update fails, report the problem and do not start execution.
3. Perform the scoped work and record concise progress and verification evidence using supported task fields. Preserve existing details. Assignment or delegation alone is not completion; track delegated work through its result.
4. Whenever work finishes or stops, update the task before the final handoff: `done` only when acceptance criteria are met and verified; `review` when implementation is complete but required review/approval remains; `blocked` when missing input, access, a dependency, or a failure prevents progress; `todo` when intentionally deferred with no active worker and no blocker. Leave `in-progress` only while work is genuinely continuing. Explain unfinished work, blockers, and the next action.
5. Confirm the final update succeeded, then report the actual outcome. If it fails, state that the saved status is stale and give the intended status; never claim it was updated. On resume after interruption, inspect current state and recover unfinished steps without repeating successful work.

## Task ownership and dispatch

The assigned owner reads the current task and completes its scoped work, verification,
outputs, final Technical report and actual Kajoo lifecycle status. The coordinator
schedules/reviews; it does not rewrite an owner's report or finish a successful task on
its behalf. A rejected result returns to the same owner for a bounded correction.
Coordination does not permit manufacturing or changing the task's technical outcome.

Dispatch with `Work on <kajoo-task taskId="ACTUAL_ID" name="ACTUAL_NAME" />.` using
verified values. The owner calls `get-task` first, reads its scope/dependencies and
linked artifacts, then loads the required domain procedure. Do not paste the task
body, tool inventory, skill contents, acceptance checklist, configuration snapshot or
repeated boilerplate into `run-agent`. Add only genuinely new task-local facts or an
exact input/packet/postflight reference absent from the task. Required execution packets
and approval gates remain required; reference their saved paths rather than copying
their contents. If a durable instruction is missing, fix the pending task description
before dispatch; do not change a running owner's scope through a hidden long prompt.

Parallel owners write separate task/attempt outputs and their own task records. They
must not replace the same artifact, file or checkout concurrently. Declare an integration
owner that waits for all required outputs before combining shared configuration. If
isolation cannot be established, serialize the conflicting work. Fetch current records
before writes and preserve unrelated fields; this is not a substitute for isolation.

## Technical report and output

Keep one `## Technical report` section at the end of the existing task `description`.
Create it from the task template; for an existing task without one, append it once.
Use the supported `update-task` description field, never a new DTO/API field. Before
updating, read the latest task and preserve all requirements, acceptance criteria and
other sections above the report exactly. Replace only this final section, not the whole
task with a summary, and never continually append duplicate reports. Preserve unrelated
fields and another active worker's work.

Write a readable Markdown report with the attempt identity and outcome, verified
configuration or changes, checks and material limitations, blockers/next owner, and
references to the structured result and supporting evidence. Never include secrets or
raw bulk logs. Replace the current report for a new attempt, retaining prior attempt
files in the domain's evidence folder. Task status remains the lifecycle authority and
domain evidence remains the validation authority; a report alone does not prove success.

Save and read back the description with the honest final lifecycle status before the
handoff. If persistence fails, report it rather than claiming a saved handoff. Coordinators
fetch this section to locate evidence and preserve it during status-only updates. Final
chat gives only a short user-facing outcome, material blocker/next action and task link;
detailed findings stay in the task's final Technical report section.

## When to create records

- Create a task when the user requests tracking or when an agreed piece of work needs its own owner, status, verification, or follow-up. Keep each task focused on one independently verifiable outcome; split work only when parts need separate tracking or handoffs.
- Create an epic when an agreed larger outcome needs several related tasks coordinated together. Give it a clear shared goal; a standalone task does not require an epic. Reuse a suitable existing epic rather than creating another for the same outcome.
- Check relevant existing records before creating anything. Extend or resume matching work instead of duplicating it. Do not create records for every tool call, small execution step, quick question, or speculative idea unless the user asks to track it.

## Create and update

- Create only needed records with clear names, concise scope, and verifiable acceptance criteria. Use `draft` for unready tasks and `todo` for ready tasks unless execution is starting immediately.
- Link tasks to the correct project epic and assign real agent IDs when requested. Reuse existing records; narrow lookups rather than listing everything repeatedly.
- For epics, record the shared outcome and related tasks. Prefer derived status; do not force an epic to `done` while required tasks remain incomplete. Preserve explicit overrides unless a change is requested. Epic overrides support `todo`, `in-progress`, and `done`, not task-only statuses such as `blocked`.
- A metadata-only edit or read-only status request does not start task execution. Do not change execution status merely because a task was viewed or renamed. Do not delete tasks or epics without explicit authorization.

## Linked tasks and atomic batches

Task `linkedTasks` stores directional references to related active tasks in the same
project. These provide supporting context, never execution prerequisites. Explain their
relevance in the description and load their reports/evidence only when useful. Reciprocal
links are allowed; self-links and duplicates are rejected. Use `dependsOn` when output is
required before execution. Bulk creation accepts temporary keys in either field; updates
require real task IDs. Deletion cleans both reference fields.

Task `dependsOn` stores real prerequisite task IDs from the same project. A prerequisite
must be done before its dependent starts. Rank controls display order, not dependency
order. The application task links are authoritative. When creating a plan, persist its
approved prerequisites in `dependsOn`. If older records lack links, verify the intended
prerequisites from their saved instructions and the approved plan before updating them
with revision checks; absence of links is not proof of independence. Never silently
replace explicit existing dependencies.

For several related tasks, use `bulk-create-tasks`: one project
and up to 100 tasks with unique request-local `key` values. `dependsOn` can reference
existing task IDs or keys in that same batch, including forward references. Returned
`keys` maps these keys to real IDs; temporary keys are never persisted in task links.
Use explicit ranks and actual epic/agent IDs. Do not put temporary keys in Kajoo task
annotations. If descriptions require links between newly created tasks, bulk-create
first, use the returned IDs, then bulk-update only those descriptions using their
returned revisions. Keep existing task requirements intact.

`bulk-update-tasks` requires the project's ID and `{id, expectedRevision, changes}`
for each task. Read revisions from returned records or `get-task`/`list-tasks`;
older tasks are revision 0. Single `update-task` also requires `expectedRevision`.
The first write at a revision succeeds; later writes at that revision return a
conflict. A stale revision or invalid member fails the entire batch. Reread the
affected tasks and merge intended changes before retrying. Independent tasks can
be updated in parallel.

There are no task mutation retry keys or saved response receipts. After an uncertain
create result, inspect the project tasks and reuse verified records before retrying;
repeating creation can create duplicates. Batches are atomic and project-scoped;
they cannot move tasks between projects.
Use single-task operations for unrelated owner work; do not batch a running worker's
status/report updates with another owner's outputs. If bulk tools are unavailable,
use scoped single calls in dependency order and confirm their results instead of firing
parallel writes to the same records.

## Plan order

- Persist the intended display order with an explicit numeric `rank` for each epic and each task in an ordered plan. Task ranks order tasks within their phase; dependencies and task descriptions do not determine display order.
- Decide ranks before creating records, including parallel creates. For a new ordered set, use distinct ranks spaced by 1000 (1000, 2000, 3000, ...). Never rely on creation timestamps, returned IDs, call order or numbered titles to establish the sequence.
- When adding to an existing phase or plan, inspect the relevant siblings and place the new record relative to their existing order. Preserve valid ranks and user-defined ordering; do not reset unrelated records or recreate tasks to repair order.
- On resume, reuse the same IDs and existing valid ranks. Repair missing, duplicate or inconsistent ranks only within the ordered set being prepared, respecting explicit user ordering. Read back the ranks and confirm the intended sequence before reporting the plan ready. A rank-only repair does not change task status or authorize execution.

## Markdown references

Use `<kajoo-task taskId="TASK_ID" name="TASK_NAME" />` and `<kajoo-epic epicId="EPIC_ID" name="EPIC_NAME" />` in user-facing descriptions and summaries. These examples are escaped with backticks: replace placeholders with verified IDs/names and remove backticks in actual output. Escape &, ", <, and > in names as &amp;, &quot;, &lt;, and &gt;. Do not add projectId or chatId attributes. If an ID or name is unknown, use ordinary text.

For an explicitly authorized multi-task deletion in one project, use `bulk-delete-tasks` with each selected task's ID and current expectedRevision. It deletes all selected tasks or none, removes incoming prerequisite links, advances affected surviving tasks' revisions, and retains chats. The response contains only deletedIds/deletedCount. After an uncertain outcome or revision conflict, reread and verify the remaining deletion scope before retrying. Never include unrelated tasks or interpret phase deletion as task-deletion authorization.
