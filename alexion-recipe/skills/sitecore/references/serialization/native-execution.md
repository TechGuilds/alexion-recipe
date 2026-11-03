# Native serialization execution

Sitecore serialization uses the local Sitecore CLI for project preparation,
capture and transfer. Remote Sitecore reads and SPE work remain connector
operations. Local transfer commands run only through a **foreground Bash** call
that explicitly attaches the matching connector role.

## Capability and credential boundary

Before mutation, run the local wrapper's `probe` operation from the prepared
project root. It establishes the installed CLI version, `ser` command
availability and configured plugin compatibility without emitting credentials.
Pull and push authenticate within their wrapper invocation; do not make a
standalone `login` call in the normal procedure:

- source pull: Bash call has `mcpCredentials.source` only;
- local validation: local validation does not require connector credentials;
- target dry-run and push: Bash call has `mcpCredentials.target` only.

The wrapper reads only role-namespaced environment variables injected for that
single command. It never accepts credentials in arguments, JSON input,
parameter files, saved output, evidence or decision records. Do not use a
credentialed background Bash command. A source connector never authorizes a
target push.

## Project preparation

Use `scripts/serialization/prepare-cli-project.mjs` with a validated generated
module root, a new project root, and a new output directory. It copies module
configuration into `modules/`, writes a pinned `sitecore.json`, and emits a
hash manifest. It never edits the source modules or capture root. The project
is phase-scoped evidence: reuse it for the shared capture and all approved
target batches while its manifest and scope remain current. Create a new one
only when those inputs differ.

## Procedure

1. Validate the coordinator's current task packet before any command. It must
   identify the exact compiled scope input, applicable Discovery evidence,
   target-adoption evidence, selected source/target roles, decisions, bounded
   stage range and terminal checkpoint. Reuse compatible referenced evidence; a missing or stale
   input blocks the task and is not permission for exploratory source queries.
2. Verify the source and target identities, selected database/languages, exact
   namespaces and current approvals.
3. For the shared phase capture, prepare one CLI project; run `probe`, then
   run `pull` once for the full exact planned namespace selectors. Pull and
   push authenticate within their wrapper invocation. Preserve the sanitized
   terminal report and capture manifest.
4. Run local `ser validate` once without connector credentials, then local
   inspection, transfer preflight and global batch planning once. The CLI result
   is authoritative for Sitecore-generated serialization syntax; retain any
   compatible local parser warnings as evidence. Apply template changes only to
   a separate target copy after a reviewed remap decision.
5. Each target task references the shared capture and receives only its
   assigned exact namespaces. Run local validation without connector
   credentials, then execute an exact-namespace `push --what-if` dry-run.
6. Obtain the current scoped mutation decision. Push one planned batch at a
   time, wait for its terminal result, and read back the affected target scope.
7. Run the target-parity procedure and the tester audit before reporting phase
   completion.

## Result contract

Store the operation, role, connector identity without secrets, project/module
manifest hashes, exact namespaces, requested/pulled/pushed/already-present/
skipped/failed counts, exit status, elapsed time, sanitized output, approval
reference and read-back result. Use the error-recovery procedure for failure;
inspect partial remote effects before retrying.
