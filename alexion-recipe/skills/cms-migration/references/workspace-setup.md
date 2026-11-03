# Workspace setup and safety

Read `${MIGRATION_STATE_FILE_DIR}/context.json` for the sandbox roots, connectors, source/target identities and repositories; do not infer them. Record only the scope fields defined by the active profile, following the [context file](context-file.md) rules. Native files describe configuration; they do not change application connectors or provision infrastructure.

Create migration scratch files and prepared requests under `${MIGRATION_STATE_FILE_DIR}/tmp/`, with a separate task/attempt or fresh-run directory; never use shared `/workspace/.kajoo/tmp/`. The default migration directory is `/workspace/.kajoo/<projectId>`; honor the current artifact's resolved override. Keep runtime-managed outputs, preview configuration and repository/application files in their documented locations. Retain required evidence in the project migration directory rather than only in temporary files.

Read existing source/target code before choosing adoption or initialization; the active profile defines supported target preparation modes. Clone, commit and push follow [git operations](git-operations.md): authenticated commands use `gitCredentials`, tokens never appear in URLs or files, and pushes need a scoped approval. Source is read-only by default. Explicitly scope any approved source remediation and target overwrite to the exact instance/repository/branch/path. Reconfirm if that identity changes.

Use application UI or available authenticated configuration tools for connections. Missing capability means a reported setup blocker, never direct database access from a recipe agent. Work on local fixtures without connectors when testing draft skills; do not claim remote verification.

The source/target platform pair is fixed once work items exist. Changing either invalidates the generated inventory and tasks, so it is a new Setup decision: do not flip it by editing context.json. Reuse the workspace only after the user confirms a fresh Discovery.
