# Migration artifact boundary

The migration artifact is the durable, user-visible description and plan for the migration. Use the existing artifact interface; do not extend its DTO or create a parallel metadata schema. Store only supported durable facts in its existing `source`, `target`, `repos`, `references`, `stateFileDir` and `phases` fields.

The artifact is not an execution journal. Keep execution-only state in `${MIGRATION_STATE_FILE_DIR}/`: `context.json` (execution roots, the artifact ID, and the execution pointer), `workflow.json` (task status/dependencies), `evidence/` (raw or sanitized observations), `decisions.json` (approvals and scoped choices), and `reports/` (prerequisite matrix, summaries, completion assertions and phase boundaries). The sandbox must not become a second durable migration-configuration schema.

## Setup lifecycle

1. After `kajoo/get-workspace` identifies the current project, resolve its existing migration artifact and the explicitly linked Setup phase/task bindings created by migration-artifact. That skill alone owns initial `create-artifact`, phase/task creation and chat attachment. If preparation is absent, return to that skill rather than creating another plan. Never collect every project epic or adopt phases by display name. Preserve `content.phases` as the database IDs of only this migration's included project epics.
2. Write the returned 24-character artifact ID to `context.json` as `artifactId`, validate the context, and use that ID for every later read/update. A failed create or update is `setup-blocking`; do not silently fall back to an untracked sandbox-only metadata record.
3. Before each update, call `kajoo/get-artifact` for the ID, merge only newly verified facts into the existing `content`, and call `kajoo/update-artifact` with the complete replacement `content`. Never overwrite facts with `null`, empty guesses or unverified probe output.
4. During Setup, merge only confirmed durable facts allowed by the active profile and the existing artifact fields. After the independent audit, `setup.prepare-discovery` creates the initial visible Discovery plan through cms-migration and adds its returned phase ID before execution continuation. Keep `phases` synchronized to the database IDs of project epics included in the migration; when later planning adds or removes an applicable phase, reconcile the same ID list after the project plan is updated. Do not put task IDs, task status or epic objects in artifact content.
5. Read the artifact first whenever a later agent needs durable migration metadata. Read `context.json`, `workflow.json`, evidence and decisions for execution state. Never infer an absent artifact fact from chat history or an unverified probe.

## What never belongs in the artifact

Keep probe payloads, terminal job records, credentials, approvals, raw errors, workflow/task status, retry counters, unresolved blockers and phase-boundary decisions in the sandbox records described above. A reference may point to durable evidence, but it must not copy secrets or raw logs into the artifact.

The artifact content is intentionally narrower than workspace metadata. Migration mode, discovery sides/surfaces, safety acknowledgements and completion predicates remain in `context.json`, `decisions.json`, `workflow.json` and `reports/`; they are not new artifact fields.
