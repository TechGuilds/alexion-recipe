# Prepare or update a migration

Use plain phase titles such as `Setup` and `Discovery`. Do not add numbered prefixes or migration-name suffixes (for example, `— Website migration`). Use numeric `rank` for ordering and artifact/binding IDs for identity, not title decorations. Never adopt an unrelated same-name epic; if find-or-create returns a collision, report it rather than silently linking it or inventing a decorated title.


Use the artifact resolved by SKILL.md. If the current project has none, create it after preflight; otherwise reuse it. Never create a replacement or second migration artifact.


Before any mutation, identify the requested scope, affected records, and all required tools using SKILL.md’s preflight. Include offered connection-creation branches, chat visibility, assignments, verification, and handoff only when in scope. Do not load task templates or connection instructions just to plan. A narrow edit needs neither setup templates nor tools for unrelated unfinished setup.


## Choose the scoped path


- No artifact: follow steps 1–5 in order, stopping before execution for a draft-only request.
- Existing artifact, setup/resume: reuse current content and linked records. Inspect phase/task details only when needed and unavailable. Skip step 1; in steps 2–5 perform only missing or invalidated work. Preserve completed answers, assignments, and successful work.
- Existing artifact, narrow edit: follow Safe scoped edits or Breaking changes below. A rename does not authorize running unfinished setup; report outstanding preparation and continue only when requested.


Missing product details, repositories, or health results are specialist work, not reasons to add a coordinator interview. Never borrow another migration’s phase or tasks.


## 1. Create the draft only when absent


Call create-artifact once with type migration, the current project, name, description, and only the minimal empty content required by the schema. Set addToChatReferences: true with the current chat context.

Creation persists `content.stateFileDir` as `/workspace/.kajoo/<projectId>` when omitted, using the actual current project ID. Preserve an explicitly requested valid directory instead. Verify the returned artifact contains the resolved directory; never store the literal projectId placeholder. A fresh state directory may be empty or absent. The coordinator must inspect the resolved root with the guarded check below and create it recursively when initialization or repair begins; tools do not initialize migration state. Determine whether this is a fresh run by checking for workflow/context files, not by assuming directory existence means initialized state. Treat absent initial files as normal startup, preserve existing files on resume, and surface genuine filesystem failures instead of masking them with blanket error suppression. Older artifacts may omit it and use the same sandbox fallback; when repairing that field explicitly, preserve all other content and do not move files.


### Inspect state before initialization

Inspect state without creating it. Run this before listing the migration directory:

```bash
: "${MIGRATION_STATE_FILE_DIR:?Migration state directory is not configured}"

if [ -d "$MIGRATION_STATE_FILE_DIR" ]; then
  ls -la -- "$MIGRATION_STATE_FILE_DIR"
elif [ -e "$MIGRATION_STATE_FILE_DIR" ]; then
  printf '%s\n' 'Migration state path exists but is not a directory.' >&2
  exit 1
else
  printf '%s\n' 'Migration state has not been initialized yet.'
fi
```

Before reading `workflow.json`, `context.json` or bindings, check that each file exists. Missing initial files are expected. With native filesystem tools, use the equivalent existence/type checks before listing or reading.

When initialization begins, create the directory before writing:

```bash
mkdir -p -- "${MIGRATION_STATE_FILE_DIR:?Migration state directory is not configured}"
```

Stop if creation fails. Preserve existing files on resume. Directory existence alone does not establish workflow readiness. Do not hide failures with blanket `|| true`.


Name: use the explicit requested name; otherwise use `<Site> migration` when the site is established. Use a project name only if it meaningfully names the site, not “hey”, “test”, or “Untitled”. Otherwise use `Website migration`. Preserve proper names, use sentence case, stay within the schema limit (currently 100 characters).


Description: one or two sentences of known intent, without invented scope or platform details. If unknown: “Migration setup for this website. Source and target connections will be configured during Setup.”


Retain the returned ID and content. On an uncertain creation result, resolve whether it succeeded before retrying. Attach/enable the chat reference widget using supported capabilities; if visibility fails, report it and keep the artifact rather than creating another.


## 2. Create the linked Setup phase and all five tasks upfront


For an existing artifact, reuse its linked Setup phase and tasks; create only a missing record. For a fresh artifact, its phase and tasks must also be new. The recipe does not seed phases. On the fresh path, do not call list-epics or list-tasks to check for reusable records, and do not repeat get-artifact/list-artifacts when creation has already returned the ID and content.


1. Retain the real artifact ID from resolution or create-artifact. Use it in every description and link. Never save a placeholder ID or substitute the chat ID.
2. If the phase is missing, use the embedded Setup phase template below to create a project phase named `Setup`. Respect the tool's name length limit. Do not adopt a generic Setup phase or another migration's phase.
3. When a phase was created or its link is missing, link the verified phase ID using update-artifact, preserving the returned artifact content and adding the phase ID to content.phases. Complete this link before beginning the interview.
4. Before dispatching either role, create all five tasks from the templates and task table in step 4, each as `todo`. Provide complete role-based instructions now; unresolved connectors, repositories or predecessor results do not delay creation or make these tasks drafts. Retain actual returned IDs and prerequisite links.
5. As coordinator, initialize the Setup-only workflow and all five bindings before dispatch. Record the artifact ID and state directory without inventing platform configuration. This is orchestration within artifact creation, not a separate project task. Preserve existing records, statuses, confirmed answers and pending runs on resume. Source and target owners perform their own connection and repository interviews.


The create-epic tool may find-or-create by project/name. If its response returns an unrelated pre-existing phase rather than this creation's new phase, do not link or modify it. Report the name collision instead of inventing a numbered prefix or migration-name suffix. This is collision handling, not permission to pre-list project epics.


For a partial retry of this same creation, reuse already successful returned IDs and retry only the failed creation/link. If an outcome is genuinely uncertain or its ID is unavailable, perform a focused recovery lookup instead of creating a duplicate. These recovery rules do not apply to an ordinary successful fresh creation.


## 3. Resolve specialist assignments

The coordinator does not interview for platform or Git connectors. Use any confirmed role type or user intent already available to select the appropriate owner; if the CMS is genuinely unknown, ask only what is needed to choose that owner. Leave connector, repository and site choices to the role task. Missing role configuration is expected at dispatch and does not prevent creating complete task descriptions.


## 4. Setup task definitions and assignment verification


When a task or profile already assigns or suggests an agent (including tester), resolve its actual ID from the available-agent roster and dispatch directly. Do not call list-agents/get-agent or inspect attached skills, tools or connectors to recheck that worker's capabilities. Look up a replacement only when the named agent is missing/deleted, or diagnose an actual execution failure; do not invent a pre-dispatch capability audit.

Skip task creation and assignment when existing tasks are already actionable and suitably assigned. Otherwise use the available-agent roster supplied in system context first. Select by actual ID, name, description, and established capabilities without calling list-agents. If the roster is missing or insufficient, use a workspace-scoped list-agents lookup and complete pagination as needed. Fetch get-agent only for unresolved new/replacement candidate details or an observed execution failure. The same qualified agent may own both roles.

The complete Setup task list is fixed below. These are workflow keys, not database IDs. Each task description must record its workflow key and actual artifact and phase IDs. Use returned task IDs for prerequisites and dispatch; never substitute workflow keys. All five tasks belong to this artifact's Setup phase.

| Workflow key | Task | Rank | Prerequisite | Procedure |
| --- | --- | --- | --- | --- |
| `setup.source` | Set up source platform | 1000 | Coordinator initialized artifact, phase and bindings | [Source setup](../templates/setup-source-platform-task.md), source specialist |
| `setup.target` | Set up target platform | 2000 | Source setup complete | [Target setup](../templates/setup-target-platform-task.md), target specialist |
| `setup.cms` | Complete CMS-specific setup | 3000 | Source and target owner outputs verified | [CMS-specific setup](../templates/setup-cms-task.md), platform specialist / integration owner |
| `setup.audit` | Audit Setup evidence | 4000 | CMS-specific setup complete | [Setup audit](../templates/audit-setup-task.md), independent tester |
| `setup.prepare-discovery` | Prepare Discovery plan | 5000 | Independent audit verified | [Discovery planning](../templates/prepare-discovery-task.md), orchestrator using cms-migration |

Create missing tasks with the explicit numeric `rank` shown in the table and retain their returned IDs. Decide ranks before calling create-task, even when independent creates run in parallel; completion order, creation timestamps and IDs must never decide the visible sequence. On resume, preserve valid ranks and explicit user ordering. For this migration's existing Setup tasks, repair missing, tied or inconsistent ranks through update-task using the bound IDs; preserve statuses, assignments, descriptions, unrelated tasks and phase order. Read back the five ranks and verify CMS-specific setup appears before Audit Setup evidence and the audit before Prepare Discovery plan before reporting the plan ready. Assign actual qualified agents, including the tester. Persist dependencies using supported fields; where task dependencies are expressed only in descriptions, include the actual prerequisite task annotations and enforce the same edges in `workflow.json`. Do not create checkpoint-level tasks.

After creating the five records, initialize only Setup in the active workflow. Read the active CMS profile workflow template and project only its `setup` phase into `${MIGRATION_STATE_FILE_DIR}/workflow.json`; Discovery remains a template, not active work. Preserve an existing workflow and its statuses on resume. Write `reports/kajoo-workflow-bindings.json` with every workflow key mapped to its returned Kajoo phase/task ID. Keep `content.phases` equal to the included phase IDs, preserving already linked migration phases. Never include unrelated project phases. At orchestration time, context may be partial: record the verified artifact ID and state root, not invented site, language or mode. Full CMS context completeness is required at the CMS task/audit, not before dispatch.


For source and target descriptions, copy the matching template from `## Goal` through the final Technical report verbatim. Replace only the actual artifact/prerequisite annotations; preserve the explicit migration-artifact and CMS-specific sections. Do not summarize, rename headings or add Scope, Confirmed context, Execution checklist, Acceptance criteria or Dependencies and lifecycle sections. Keep workflow keys, phase membership, assignments and ranks in structured records/bindings. On an existing task, preserve its current Technical report when repairing the description.

Use these templates during step 2, before platform selections are complete. Source and target tasks refer to the corresponding role in the linked artifact, never an embedded selected connector ID, type, display name or repository list. The CMS task consumes the same artifact and readiness evidence; the audit resolves current facts and checks the identities actually used. Keep actual artifact/phase/prerequisite task IDs as stable links. Store assignments in the task's assignment field instead of duplicating them in prose. Verify existing assignments without rewriting task descriptions when configuration changes. Create only a genuinely missing record; never select tasks from another migration.

Dispatch using the concise task-reference contract in `managing-kajoo-tasks`. Owners read their current task and resolve linked artifact, prerequisite reports and exact evidence references themselves. Add only genuinely new task-local context or an input reference absent from the task. Do not repeat concrete configuration snapshots, task instructions, skill lists or evidence checklists in the launch prompt. Owners record resolved identities/revisions in attempt evidence and handle their own lifecycle/report; a changed identity needs the existing scoped-change rules. A material scope change belongs in the pending task description before dispatch.


If an agent is unavailable, leave the affected task unassigned/blocked, record its capability gap and preserve the initialized records. Do not dispatch an unsuitable agent.


## 5. Run assigned specialists

After the artifact, phase, five assigned task records and Setup-only workflow bindings are created and read back, dispatch the source and target owners using their task references. No connector selections or separate preparation task must complete first. Track pending runs and avoid duplicate dispatch. Complete source setup before dispatching target setup. A blocked source keeps target waiting; never run both role interviews together. Each owner handles selection, acquisition, CMS checks, role evidence, Technical report and final Kajoo status. A draft-only request ends before execution.

If subagent execution or required run tracking is unavailable, explain the missing capability and ask the user to enable it or explicitly choose to work on the same task in place. Do not silently perform specialist work as the orchestrator. Reuse successful orchestration; once enabled, dispatch the assigned agent. For an explicit in-place choice, check all scoped execution tools and follow the same task status, acceptance, and evidence rules.

Reuse verified completed tasks and current pending runs. For each unfinished role with no pending run, dispatch its task reference and track the returned run ID. Do not dispatch target while source is incomplete or blocked. Review owner results and project their verified statuses into workflow; verify their saved artifact role and evidence; do not persist their role configuration or mark their Kajoo task done for them. Return a failed/malformed result to that same owner with only the concrete correction. Never advance integration until both current role outputs pass.

After both role tasks satisfy the [role completion contract](role-setup-contract.md), read [Complete Setup](complete-setup.md) and dispatch the CMS-specific task owner to verify the saved artifact roles and persist combined context/Setup decisions. A confirmed absent target repository remains an explicit role deferral, never permission to skip required full-migration initialization. Independent audit follows that integration; reuse successful work on resume.




## Existing plans

For a migration created with an older plan, preserve its existing task IDs, completed preparation evidence and active runs. Do not add the retired preparation task to new plans. Reconcile an existing plan only through an explicit scoped repair after active owners finish or are safely stopped; preserve history and unaffected results.

## Safe scoped edits


Apply explicitly requested artifact name/description or platform displayName corrections or additive, non-conflicting references without a separate impact-confirmation gate. Preserve IDs, links, unrelated content, and completed statuses. Reassigning an unstarted task is safe only after verifying the replacement agent's capabilities. Do not rename every related record merely because the artifact was renamed.


## Breaking changes


Changing a platform, connection identity/endpoint, repository or branch, or scope underlying completed work may invalidate evidence and downstream tasks.


1. Identify the affected role, tasks, dependent work, and any active runs.
2. Explain what will change, what will be preserved, and what must be revalidated. Confirm the impact before clearing configuration or resetting completed work; reuse an explicit approval that already covers that exact impact.
3. Do not race an active specialist. Wait or obtain authorized cancellation through a supported tool; do not silently dispatch a replacement.
4. Apply only the confirmed change. Use [Connection resolution](resolve-platform-mcp-connection.md) for connector replacement. Repoint this artifact rather than rewriting a shared connection.
5. Retain prior evidence as historical and clearly superseded. Reopen only affected tasks, record why, and revalidate dependent work. Do not delete migration history or blindly reset all phases.
6. Use the latest complete artifact content for replacement-style updates. On a conflict, refresh and reconcile rather than retrying a stale overwrite.


Report changed fields, preserved work, and remaining verification. Resume source before target where dependencies require it; leave unaffected completed tasks alone.




## Embedded Setup phase template


Name for new creation: `Setup` (within the tool's length limit).


A fresh migration requires a new phase. Use the actual artifact ID from resolution or create-artifact; never save placeholder IDs. On resume, preserve this migration's existing phase instead of creating a duplicate.


### Filling resource references


Replace every annotation placeholder with the actual resource ID and name from tool results or verified context before saving. Use double-quoted attributes; escape &, ", <, and > in names as &amp;, &quot;, &lt;, and &gt;. Example annotations in this template are wrapped in backticks so placeholders display literally. When generating the final description, replace placeholders with verified values and remove the surrounding backticks so the annotations render. Keep final annotations inline, not in code blocks, and do not add projectId or chatId attributes. If an ID or name is unknown, use ordinary text instead of an incomplete tag; never save placeholder values. Keep actual IDs in structured tool fields. There is no agent annotation; keep agent assignments as ordinary text/IDs.


### Description


Prepare `<kajoo-artifact artifactId="<migration ID>" name="<migration name>" />` and complete source and target platform setup.
Project: <project ID>.


### Scope


The coordinator creates the artifact, five assigned Setup tasks and initial workflow bindings. Each source/target owner uses migration-artifact to select/create platform and Git connectors, select repositories and clone them, then CMS-specific skills to validate/troubleshoot health and complete site, host, platform/version and stack configuration. The CMS-specific task performs the active profile's cross-role scope, compatibility, remaining prerequisite, safety and application initialization work; the tester audits the complete Setup evidence.


### Acceptance criteria


- The artifact, five task IDs and Setup-only workflow bindings are initialized and read back.
- Source and target setup tasks are complete with saved and read-back artifact role configuration (including applicable site and stack facts), verified repositories or scoped deferrals, references and synchronized sandbox state.
- CMS-specific setup, the independent audit and the visible Discovery planning task are complete with all applicable profile gates satisfied; a readiness deferral cannot waive required full-migration initialization.
- No required setup blocker remains.


### Execution and status


Source setup follows coordinator initialization; verified source completion precedes target setup; both verified owner outputs precede CMS-specific setup; independent audit follows CMS-specific setup; Discovery planning follows the audit and completes Setup without starting Discovery.
When recording the created source and target tasks, use `<kajoo-task taskId="<task ID>" name="<task name>" />` with each task’s actual ID and name. Do not add references before the tasks exist.
Use derived phase status where supported. Do not mark Setup done merely because artifact/task creation is complete. Do not begin discovery from this phase without the next explicit workflow instruction.



When presenting the execution fallback, put “Enable subagents (Recommended)” first and “Work on this task in place” second. Recommend the assigned specialist and wait for the user’s choice before in-place execution.


For linked task creation, follow managing-kajoo-tasks' atomic batch contract. Prefer
`bulk-create-tasks` with temporary keys and explicit `dependsOn` rather than parallel
single-task creation followed by guessed links. Create the phase first so its real ID
is available. Use returned task IDs/revisions for any required description-link batch.
Keep task dependencies in the application records; project the same ordering into the
sandbox workflow via existing bindings, preserving ranks and approval gates.
