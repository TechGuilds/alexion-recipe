---
name: migration-artifact
description: Create, prepare, update, resume, or delete the current project migration artifact. Reuse its single artifact and coordinate platform setup.
---

# Migration artifact

## Supporting file paths

This workspace skill is mounted at `/mnt/skills/workspace/migration-artifact/`. Resolve links from the file containing them and preserve this full root. For example, the source template is `/mnt/skills/workspace/migration-artifact/templates/setup-source-platform-task.md`. The scope segment `workspace` is required; do not infer a different root from the skill name.

Use the actual UTC clock for recording timestamps. If an earlier answer's time is unavailable, record its original time as unknown; never invent or backdate it. A currently authorized test-driver choice is a current choice, not historical human confirmation. Missing required approval evidence must be resolved explicitly, not synthesized from a checkout or successful probe. Connector tool responses contain `[REDACTED]` placeholders; never echo credentials or write those placeholders back into connector settings.

## Role setup worker entry

For an assigned `setup.audit`, read only the audit task template and applicable acceptance rules, preserving the tester's read-only role. Do not enter artifact creation or readiness orchestration.

For an assigned `setup.cms`, fetch the actual task and read its CMS-specific task template plus the integration section of the role completion contract. Load the active CMS profile’s Setup procedure and finish this integration task yourself, including combined artifact/context/Setup-decision persistence, read-back, evidence, final Technical report and lifecycle. Do not run artifact creation/preparation, re-dispatch this same task or enter the coordinator’s phase-handoff procedure. Reuse both completed role outputs; return missing input to its owner rather than rebuilding it.

When assigned `setup.source` or `setup.target`, read the actual Kajoo task first, then its matching template and [role completion contract](references/role-setup-contract.md). Complete the role’s connector, repositories, site/language, platform/version, architecture/SDK/tech stack and references. Save/read back isolated role configuration and result files plus the task’s final Technical report, and set done/blocked yourself. Update and read back only the assigned artifact role before completing the task; preserve the opposite role. Do not write shared context/workflow/decisions or enter coordinator initialization. Complete source setup before starting target setup; keep each role’s outputs separate. The CMS setup owner reuses both persisted artifact roles and builds combined sandbox context after they finish.

The coordinator creates the artifact, five Setup tasks and initial workflow/bindings directly. Source and target owners each use this skill to select or create their platform/Git connections, select repositories and acquire checkouts, then load CMS-specific skills to validate/troubleshoot health and complete platform configuration. Owners save and read back their artifact roles plus task-owned evidence; `setup.cms` reuses those saved roles for combined context/Setup decisions and owns cross-role compatibility and approved initialization. Reuse confirmed choices and terminal evidence. Missing required role facts block that role; failed combined persistence blocks CMS setup.

Git operations use Bash with the user-selected Git connection passed as `gitCredentials`. For an already selected connection, confirm that it is enabled for the executing agent before dispatch; when the owner selects or creates one during its task, verify enablement before the first authenticated Git command. `No enabled Git connection found` is an agent configuration problem, not evidence that a repository is inaccessible; the Git command has not run. Report the missing attachment to the coordinator, retain confirmed choices/evidence and do not request a different repository or perform anonymous retries to infer private repository visibility. Resume only after the selected connection is available to the executing agent.


Each project can have only one migration artifact. Continue working on the existing artifact; create one only if the current project has none. Do not ask the user to select an artifact or choose between creating and resuming. Keep artifact/task initialization platform-independent and use only choices supported by the active artifact schema. Role specialists own connection selection, Git repositories/checkouts and CMS-specific platform configuration.

This skill owns the complete Setup phase: Set up source platform, Set up target platform, Complete CMS-specific setup, Audit Setup evidence, and Prepare Discovery plan. Create and link the phase and tasks by returned IDs; the recipe does not pre-seed Setup or Discovery. Role configuration comes first; active platform skills supply its focused procedures, and the CMS profile supplies cross-role procedures for the third task and the tester's audit. Keep all five tasks in the same sandbox workflow and phase bindings. Never adopt an unrelated phase by its name.

Create all five Setup tasks upfront as `todo`, before interviewing for source/target connections. Their scope is fixed; unresolved configuration and unmet prerequisites do not make them drafts. Descriptions reference source/target roles in the linked artifact rather than copying connector IDs, display names or repository selections. Resolve current values at dispatch, verify the prerequisite evidence, and record the exact identities/revisions used in attempt evidence. Update descriptions only when scope changes, not when artifact configuration changes. Preserve existing statuses and evidence on resume; a draft-only operation stops before execution but still creates these fixed tasks as todo.


## Resolve the project migration


This step is read-only. Check/load lookup tools before use. Reuse a migration artifact already verified as belonging to the current project; otherwise list migration artifacts scoped to that project, completing pagination as needed. Fetch content only when needed and unavailable. Never use an artifact from another project.


If an artifact exists, continue with its ID and content. If none exists, create one after preflight without a create-versus-resume question. For explicit deletion, use the deletion procedure when present; if absent, report that there is nothing to delete and stop. A failed lookup or incomplete result is not proof of absence.


## Check sandbox state before startup or resume

Before inspecting sandbox state during migration startup or resume:

1. Resolve the current project's migration artifact and its state directory.
2. Check whether that directory exists before listing it. Follow the guarded inspection example in [Prepare or update](references/prepare-artifact.md#inspect-state-before-initialization). A missing directory is expected before initialization.
3. Check whether workflow, context and binding files exist before reading them. Existing artifact/task records do not prove sandbox state exists.
4. When initializing or repairing workflow state, create the directory recursively first. Preserve existing files and reconstruct missing state from verified project records.

Do not run an unconditional `ls` or read against an unverified state path. Report genuine filesystem failures. Metadata-only artifact edits do not require sandbox inspection.


## Plan and check tools before changing anything


1. Detect intent from the current request and relevant context. Apply Resolve the project migration above using read-only tools. Reuse it if present; return CREATE only if none exists, except for deletion requests. Check/load the required lookup tools before using them. Resolution itself must not write.
2. Read [Prepare or update](references/prepare-artifact.md) for creation, updates, or resume; read [Delete artifact](references/delete-artifact.md) only for explicit deletion. Determine the requested scope, required steps, and tools for the entire operation, including verification and requested handoff. For updates/deletion, use read-only inspection to identify affected records and dependencies. Do not load task templates or connection instructions just to build this tool plan; use the embedded phase template only when executing that step.
3. Check the active tools and their schemas against that plan. Reuse available tools; search and load only missing tools through dynamic discovery. Check all required capabilities of your own active tools before the first write, not one step at a time. This is not a worker-configuration inspection gate for an assigned or suggested agent. A tool name in this document is not proof that the tool is available.
4. Include tools for branches the workflow will offer: an unresolved connector interview offering “Create a new connection” needs the supported creation/authentication capabilities upfront. Check role type/schema support and chat-reference attachment/visibility capabilities upfront when included in the operation. For a confirmed existing connector or a narrow rename, do not require unrelated creation, deletion, or handoff tools.
5. For unavailable subagent execution, offer enablement or explicit in-place execution as defined in Setup task scope and subagent handoff. Resolve that choice before writes when already known. For other required capabilities that remain unavailable, tell the user before making changes: “To complete <operation>, I need <missing tools/capabilities> for <steps>. Please enable them; no changes have been made.” Do not create a draft, change a task status, modify links/connections, or start deletion while dependencies are missing. Do not return a technical error as a substitute for explaining what must be enabled. Do not silently reduce the scope; a narrower operation requires the user's choice and a new preflight.
6. Once the full scoped plan is supported and required approvals are satisfied, execute it in order. This preflight is not an extra checklist-approval question. Load files only at the execution point listed below. If the user changes scope, check the newly required tools before any further writes.


Availability checks do not guarantee future network/authentication success. If an unexpected execution failure occurs after preflight, preserve successful work, report the exact remaining work, and resume only unfinished steps after recovery; never claim completion or undo work automatically.


## Required tools


Select from this inventory for the planned operation. Checking/loading a tool does not mean invoking it.


| Planned work | Tools/capabilities to check upfront |
| --- | --- |
| Resolve migration | list-artifacts scoped to the current project and/or get-artifact as needed; reuse verified context |
| Create and initialize | create-artifact, update-artifact, create-epic, create-task, update-task; assignment tools below; supported chat-reference attachment and visibility capabilities |
| Narrow artifact edit | get-artifact when current content is not already available, update-artifact; ask-user-input only for ambiguity or impact confirmation |
| Resume/repair setup | Tools needed for the actual missing steps; list-epics/list-tasks/get-task only for unavailable linked-record details; create-epic/create-task for missing records; update-artifact/update-task/update-epic for planned changes |
| Select platform connections | list-connectors/get-connector as needed, ask-user-input; isolated role output and active schema exposing allowed IPlatform.type values |
| Offer/create a connection | create-connector and supported secure configuration/authentication capabilities; update-connector only if that flow requires an authorized change |
| Assign specialists | Reuse system-context roster; list-agents only when missing or insufficient; get-agent only for unresolved new/replacement candidate details or an observed execution failure; create-task/update-task for planned assignments |
| Execute setup handoff | run-agent, get-tool-results, and task/artifact verification tools; resume-agent-run only when resuming an existing paused run |
| Delete artifact only | delete-artifact, supported read-only lookup/verification tools, and ask-user-input when scope confirmation is needed |
| Delete with approved cleanup | Above plus ownership/dependency lookup tools, delete-task/delete-epic for included resources, update-artifact for phase detachment, supported reference-removal or run-cancellation capabilities only when required by the approved scope |


Do not require every tool in the inventory for every request. Do not substitute list-skills or user questions for missing lookup capabilities. Do not repeat successful searches or reload active tools. A fresh artifact has no existing phase/tasks to list; use returned creation IDs directly.


## Load files only when needed


Reading a linked file is conditional, not a startup checklist. Do not recursively follow every link or batch-read references/templates for future steps. Read each required file fully once when its trigger is reached, then execute that step before loading the next step's files.


| Trigger | File to read |
| --- | --- |
| Create, update, or resume; plan and preflight the requested scope | [Prepare or update](references/prepare-artifact.md) |
| Explicit deletion selected; plan and preflight deletion | [Delete artifact](references/delete-artifact.md) |
| Ready to resolve a source/target platform connection | [Connection resolution](references/resolve-platform-mcp-connection.md) |
| Setup phase is linked; create the fixed todo tasks before dispatch | [Source setup task template](templates/setup-source-platform-task.md) and [Target setup task template](templates/setup-target-platform-task.md) |
| Prepare the remaining Setup tasks | [CMS-specific setup template](templates/setup-cms-task.md) and [Setup audit template](templates/audit-setup-task.md) and [Discovery planning template](templates/prepare-discovery-task.md) |
| Both readiness tasks are verified; execute CMS setup, audit, or phase handoff | [Complete Setup](references/complete-setup.md) |


On the fresh path, create the artifact after preflight, then use the Setup phase template embedded in the preparation procedure. Create/link the phase before reading the task templates. Read all five templates when creating the todo tasks upfront; role owners read connection instructions when selecting their connections. Do not wait for role selection to create task descriptions. A rename or deletion needs no setup templates.


Reuse file content already available in this run. Re-read only when it has actually changed, the previous read was incomplete/failed, or needed content is no longer available. If content was cleared, reload only the file needed for the current step and immediately use it; do not restart the whole reading sequence.


## Platform interview contract


"Platform" means `IPlatform.type`, the type discriminator for the source or target object. Product variants, editions, versions, and deployment details are separate specialist-owned fields, not platform-type choices.


Use the active migration artifact tool/schema as the source of truth. Read the allowed `type` values from its enum, const, or discriminated-union branches for the relevant role. Reuse schema information already available; use supported dynamic discovery or schema capabilities only if needed. Do not maintain a fixed vendor list, derive types from product-variant enums, or invent options from general knowledge. If the schema does not expose the allowed types, report the missing schema capability instead of guessing.


Each role owner runs [Connection resolution](references/resolve-platform-mcp-connection.md) for its assigned role inside `setup.source` or `setup.target`. Resolve `type`, `connectorId` and `displayName` from confirmed choices, the active schema and supported secure creation flows. Do not interview for the other role. Select/create Git connections and acquire repositories using the matching role task template. This skill owns selection/acquisition; the CMS-specific skill owns connector health, troubleshooting and remaining platform details. Save selections and all verified details in the task-owned role output and assigned artifact role under the role completion contract. Source saves its role first, then target preserves it while saving its own role.

Reuse confirmed answers. Missing required credentials or capabilities block only this role. Never collect secrets in chat, invent schema fields or interpret a saved connector as proof of health.


## Setup task scope and subagent handoff

Source and target setup must each leave a complete verified artifact role and matching task-owned evidence, not merely a working connector/checkout. Follow the role completion contract and matching template, record explicit unknown/inapplicable/deferred values, and save/read back the role result and final Technical report before setting the honest task status. Source starts after coordinator initialization; target depends on verified source completion. Do not run their interviews together. The CMS setup owner then verifies both persisted artifact roles against their role files and persists/read-backs combined context and performs cross-role setup; do not advance integration with either required role incomplete.

After creating and verifying the artifact, phase, five assigned tasks and bindings, dispatch source with its task reference, then target only after verified source completion under `managing-kajoo-tasks`. The owner fetches the task and linked inputs, resolves missing connection/repository choices, and follows its focused CMS procedure. Add only necessary context absent from the task. Do not duplicate instructions, configuration or acceptance checklists in launch prompts. A draft-only request ends before execution.

Use the available roster without speculative worker capability audits; diagnose an observed missing Git credential attachment before retrying. The coordinator owns initial bindings and global workflow projection; role owners own task files/reports/statuses; role owners persist their assigned artifact role; CMS setup alone combines sandbox context/Setup decisions; tester owns audit reports. Keep role outputs isolated and source/target execution sequential. Apply the five-task plan to new migrations; preserve existing task IDs, preparation history and active runs unless an explicit scoped plan repair is authorized.

Check subagent execution availability upfront. If run-agent or required run tracking is disabled or unavailable, explain the missing capability and ask the user to enable subagent execution or explicitly choose to work on the same scoped task in place. Do not silently switch to in-place execution. Preserve initialized records and completed work. If this gap is known before writes, resolve the execution choice during preflight; if discovered at handoff, retain the prepared tasks. After enablement, resume the assigned specialist; after an explicit in-place choice, preflight the scoped task tools and execute that same task with its status and evidence rules.



## Shared rules

- Supporting references are URL-only: `{type: "url", description, url}` with an HTTP(S) URL. A related repository is a web link here; implementation repository connectors, branch names and checkout roots belong in `repos`. Rendering architecture is `mvc` or `headless`; SDK type is `jss` or `content-sdk`; omit sdk if neither applies or it is unknown. Do not write `capabilities` to either artifact role; keep health/capability findings in task-owned evidence and sandbox execution state.


- Optional `content.stateFileDir` selects the sandbox migration state directory, a clean absolute path under `/workspace/`. Sandbox commands expose it as `MIGRATION_STATE_FILE_DIR`, defaulting to `/workspace/.kajoo/<projectId>` when omitted. Preserve it during unrelated artifact updates. Changing it does not move existing state files; execution uses only the newly selected directory.


- A newly created migration gets its own new Setup phase and new tasks. Do not search for or reuse another migration's phase/tasks. Use the IDs returned by creation directly; never invent IDs, use placeholders in saved records, or re-list records to rediscover an ID already returned. Reuse applies only to existing migrations and partial retries of this same creation.


- Reuse tool results and known IDs. A task update does not invalidate an unchanged artifact. Re-read when data is missing, stale, changed by a specialist, or a conflict occurs.
- Preserve unrelated fields and links. If content updates replace the whole object, merge the change into the latest known complete content; never send an incomplete replacement.
- Use ask-user-input for meaningful choices; obey its option limits. No extra checklist-approval gate.
- Keep status and evidence truthful. Creating tasks or linking connectors is not successful platform setup.
- Source and target owners select/create their own connections and complete their role configuration using the matching template.
- Readiness task completion does not complete Setup. Required CMS-specific checks and the independent audit must pass before `setup.prepare-discovery` creates the visible Discovery plan. Setup completes after planning is verified; only an explicit phase-continuation choice permits Discovery execution.
- Assign actual agent IDs; assignment alone does not execute a task. When the requested workflow includes setup, complete source setup before dispatching target setup. A draft-only request ends before execution.
- Never store credentials in artifacts, task descriptions, or references.


Fill templates at their execution step with verified values; omit unknown optional facts rather than inventing them. Keep resource IDs in task details, not in user-facing names.



## Specialist roster

When a task or profile already assigns or suggests an agent (including tester), resolve its actual ID from the available-agent roster and dispatch directly. Do not call list-agents/get-agent or inspect attached skills, tools or connectors to recheck that worker's capabilities. Look up a replacement only when the named agent is missing/deleted, or diagnose an actual execution failure; do not invent a pre-dispatch capability audit.

Use the available-agent roster supplied in system context first (typically `<available_agents>` with IDs, names, and descriptions). When it identifies a suitable specialist, reuse its actual ID without calling list-agents. If the roster is missing, incomplete, or insufficient to establish suitability, use a workspace-scoped list-agents lookup; fetch get-agent only for an unresolved new/replacement candidate or an observed execution failure. Do not interpret a missing roster as an empty workspace or proof that subagent execution is enabled.

When presenting the execution fallback, put “Enable subagents (Recommended)” first and “Work on this task in place” second. Recommend the assigned specialist and wait for the user’s choice before in-place execution.
