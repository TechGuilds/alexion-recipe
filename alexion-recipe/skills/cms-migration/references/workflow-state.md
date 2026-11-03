# Migration state

Migration files live in `${MIGRATION_STATE_FILE_DIR}/`, and the paths below are relative to that directory. Resolve it from the sandbox command environment as described in the [context file](context-file.md). Preview configuration remains at `/workspace/.kajoo/launch.json`. Anything that must survive the chat goes here: `/workspace/tmp/chats/<chatId>/` is per-chat scratch, so copy or write evidence into `evidence/` instead of leaving it in tool-results:

- migration/workflow.json — the only task-status authority.
- migration/context.json — non-secret migration facts: type, mode, sandbox roots, connector roles, site, language and repositories. Every agent reads it first; see [context file](context-file.md).
- migration/inventory.json — discovered entity facts and stable IDs.
- migration/decisions.json — concise scope choices, mappings and explicit approvals.
- migration/evidence/<task-id>/<attempt>/ — result, logs, screenshots and provenance.
- migration/reports/ — discovery, coverage and final summaries.

Use the recipe workflow skill's version-1 contract. The active migration profile supplies the workflow template. Create only when absent; do not overwrite progress with a new template on resume. Load `/mnt/skills/workspace/workflow/SKILL.md` to stage its validator. Workflow and dev-server are recipe workspace skills attached to the agents.

Coordinator is the single writer. Native read/edit/write updates ordinary tasks; workers only produce separate evidence. Running jobs must be inspected before retry after interruption. Missing optional agent hints do not reset task state.

Tasks use stable IDs and dependencies; done/skipped satisfy edges, but required safety and approval tasks cannot be skipped to bypass a gate. Keep one current task record, not append-only component journals. Detailed attempt evidence may be retained separately.

When inputs, scope or code change, review affected tasks and approvals. Reopen stale downstream work rather than keeping a success flag with outdated evidence.

After re-discovery, rerun build-work-items with the current workflow. It never deletes tasks: a task whose entity was removed or excluded comes back in `orphanedTasks`, and while it is pending it still blocks its anchor so the change cannot be missed. Resolve each one deliberately. Either record a scope decision that excludes the entity (without a taskId) and mark the task skipped, or restore the entity. A done orphan is kept as history. Do not delete the task or edit the anchor's `dependsOn` to hide it.

The UI workflow is a tested projection of the approved plan, not a second execution-state store. Discovery evidence and the user's approved plan determine which later phases exist and their dependencies; do not assume Code Migration precedes Content Migration or that either must exist. Only the native workflow file and current verified evidence establish progress; UI task status cannot bypass user gates.
