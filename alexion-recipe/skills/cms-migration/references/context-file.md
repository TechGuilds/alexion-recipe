# Migration context file

`${MIGRATION_STATE_FILE_DIR}/context.json` holds non-secret execution facts that agents need to resume safely: migration type and mode, source/target identities, connector roles, repository identities, sandbox roots, and the ID of the durable migration artifact. It sits beside `workflow.json`, `inventory.json`, `decisions.json`, `evidence/` and `reports/` (see [workflow state](workflow-state.md)). Preview configuration remains at `/workspace/.kajoo/launch.json`. The active migration profile defines platform-specific context values; this file is an execution pointer, not a second durable artifact schema.

Sandbox commands receive `MIGRATION_STATE_FILE_DIR` from the current project's Migration Artifact `content.stateFileDir`; omitted values default to `/workspace/.kajoo/<projectId>`. Resolve the artifact before reading or creating state. Use the injected value on every command, rather than caching it across artifact updates. Changing the field selects a different directory and never moves files or searches the old location. If no context exists in the selected directory, follow the normal Setup procedure there.

Shell commands expand the variable; quote paths, for example `--input "${MIGRATION_STATE_FILE_DIR}/context.json"`. Native read/write tools and JSON files do not expand shell variables: resolve the value through a sandbox command, then pass or save the actual path. Keep `roots.migration` for compatibility, setting it to the resolved value when creating context; it does not select where state is read or written.

Every agent reads it first. Never guess a root, connector, site or language, and never re-ask the user for something already recorded here.

## Where things live

| What | Where |
| --- | --- |
| Migration files (context, workflow, inventory, decisions, evidence, reports) | `${MIGRATION_STATE_FILE_DIR}/` (`roots.migration`) |
| Source checkout, read-only | `/workspace/repos/<source-repo>` (`roots.source`) |
| Target repository, writable | `/workspace/repos/<target-repo>` (`roots.target`) |
| Target application inside it | The selected application root inside `<target-repo>`, or the repository root itself (`roots.app`) |
| An uploaded source archive | `/mnt/uploads/<chatId>/<file>`, read-only. Extract it with `scripts/extract-archive.mjs` into `/workspace/repos/<name>` |
| Platform transfer working directory, when applicable | `roots.serialization`, as defined by the active profile |
| Preview configuration | `/workspace/.kajoo/launch.json` (see the dev-server skill) |
| Agent-created migration scratch and prepared requests | `${MIGRATION_STATE_FILE_DIR}/tmp/<task-id>/<attempt>/` (or a fresh run directory); never shared `/workspace/.kajoo/tmp/` |
| Runtime-managed per-chat tool output | `/workspace/tmp/chats/<chatId>/`. Ephemeral: never the only copy of evidence |
| Cross-session lessons | `/workspace/memories/` (platform memory; not migration state) |

Create migration-specific temporary scripts, inputs and prepared requests beneath the resolved project migration directory, normally `/workspace/.kajoo/<projectId>/tmp/`. Keep separate task/attempt or fresh-run subdirectories to avoid collisions. Runtime-managed tool outputs, shared preview configuration and application/repository files retain their documented locations. Temporary files are not durable evidence: save required results under `evidence/` or `reports/` before completion.

A migration spans many chats, so anything a later task or chat needs belongs under `MIGRATION_STATE_FILE_DIR`. For remote PowerShell runs that produce evidence, ask for files in the evidence directory directly. Derive the workspace-relative destination by removing the `/workspace/` prefix from the resolved directory and appending `/evidence/<task-id>/<attempt>`. Pass that actual string as `output.destination` with `output.mode: "files"`; never pass a literal environment-variable expression. Each run gets its own subdirectory. Otherwise copy the result out of `tool-results/` before the chat ends.

## Resolve evidence paths from their declared base

A stored path is not automatically relative to the evidence directory. Read the
owning descriptor or script contract before joining it. Resolve the reference once
against that declared base; do not prepend `evidence/` just because the file is evidence.
For example, a migration-relative reference `evidence/discovery.synthesize/attempt-3/synthesis-manifest.json`
resolves from `${MIGRATION_STATE_FILE_DIR}`, not `${MIGRATION_STATE_FILE_DIR}/evidence`.
Joining the latter produces the invalid `evidence/evidence/` prefix.

Keep distinct bases for workspace-relative postflight references, staged-input-relative
script inputs, migration-relative report references, and manifest-relative outputs.
A synthesis manifest's output paths resolve from the directory containing that manifest;
its input paths retain the synthesis input directory as their base. Verify each resolved
file exists and is within its allowed scope before hashing or reading it. A missing
file is a bounded path-resolution failure: correct the consumer's base, never search for
a different attempt, strip prefixes heuristically, rewrite producer evidence or fabricate
successful audit results. Reuse the shipped scoped validators when applicable.

## Inspect JSON evidence before composing helpers

After resolving and checking the exact input file, parse it and identify its producer/schema before accessing nested values. For TASK_RESULT and other schema-owned files, run the existing contract validator first; missing required `evidence`/`unresolved` fields are malformed output to return to the owner, not empty arrays to invent. Use [terminal handoff validation](task-results.md#validate-every-terminal-handoff).

For role configuration, probe output and other evidence without a declared shape, inspect a bounded structural summary once: top-level keys, required field names, and whether each relevant value is an array, object, scalar or null. Reuse that observation to write the helper. Do not assume a field named `checks` is an array: role/probe checks may be a keyed object, while task evidence checks follow the evidence schema. Use `Array.isArray(value)` before array operations; use `Object.entries(value)` only when the producer/inspection establishes a keyed object. An unexpected type is a producer/consumer mismatch to investigate, not a reason to coerce it until a check passes.

Check that an array has an element before previewing `[0]`, and that a preview is a string before slicing it. Empty arrays, missing optional values and malformed required fields have different meanings. Do not guess alternate keys such as `routes || plan || selectedRoutes` without checking the actual producer contract. Keep previews short and omit raw content/credentials; do not print complete evidence files simply to discover their shape.

Resolve all helper inputs before execution and combine the relevant bounded shape checks in one inspection where possible. If input identity, schema or required shape does not match, report the exact path/field and expected/observed type, preserve the source evidence, and correct the consuming helper or return malformed producer output to its owner. Do not rewrite another task's evidence, add silent defaults, or rerun a remote collector to repair a local inspection mistake.

## Who writes it

The `setup.cms` owner is the sole writer of combined Setup `context.json` and Setup decisions while integration runs. Source/target owners run sequentially and save/read back their assigned artifact role plus task/attempt role files before completing their task reports/statuses. Each preserves the opposite role and unrelated content. After both finish, the integration owner validates their selected results against the saved artifact roles, populates supported context/decision fields, validates and reads back the combined state before finishing CMS setup. Unsupported context fields remain in artifact/evidence. Apply the selected platform profile’s artifact-to-context field mapping; keep unsupported role fields in the artifact and evidence. Outside this serialized integration task, the coordinator owns shared workflow/scheduling state and serializes any later context/decision changes under the applicable phase/task scope. Changing migration type, source site/language or target repository needs a scoped decision and invalidates affected inventory/tasks/approvals; never silently adopt conflicting newer state.

## Creating and validating it

1. If the file is absent, create `${MIGRATION_STATE_FILE_DIR}/` and seed it from the context template supplied by the active migration profile. Set `roots.migration` to the resolved environment value; the template deliberately omits it. Never overwrite an existing file.
2. Fill it from what the user confirms and what the connectors report. `kajoo/list-connectors` and `kajoo/get-connector` give the IDs, names and types. Choose `roots.source` and `roots.target` under `/workspace/repos/` (see [git operations](git-operations.md) for cloning).
3. Validate after every write: `node /mnt/skills/workspace/cms-migration/scripts/validate-context.mjs --input "${MIGRATION_STATE_FILE_DIR}/context.json"`.

The validator is read-only. `valid: false` means a structural problem, a credential, or an unsafe root, and must be fixed before anything else. `valid: true` with `complete: false` lists `missingFields` that Setup still has to fill for the chosen mode. Setup does not exit until `complete` is true.

**Never record a secret.** The file is durable and every agent reads it. Store connector IDs, names and types only. Repository URLs must not contain credentials, and the validator refuses URL userinfo, credential query parameters, tokens, JWTs, private keys and credential-like field names anywhere in the file. Credentials stay in the connectors.

## Fields

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `artifactId` | The 24-character ID of the Kajoo migration artifact created for this project. Do not invent it; retrieve it before updates. |
| `scopeId` | Stable ID of the migrated scope. Inventory, decisions and evidence carry the same value. |
| `updatedAt` | ISO time of the last change. |
| `migration.type` | The migration type identifier defined by the active profile. |
| `migration.mode` | Explicitly confirmed `full-migration` or `discovery-only`; Setup must not assume a mode when absent. |
| `migration.discovery` | For `discovery-only`: `sides` (`source`, `target`) and `surfaces` (`content`, `code`) to analyse. Full migration covers both. |
| `roots.migration` | Resolved `MIGRATION_STATE_FILE_DIR`, recorded for compatibility. The environment variable selects the directory. It must not sit inside a repository the migration commits to. |
| `roots.source` | Read-only source checkout, under `/workspace/repos/`. |
| `roots.target` | Writable target **repository**, under `/workspace/repos/`. Git, checkpoints and pushes work here. |
| `roots.app` | The application root inside the target repository, or the repository root for a single-application repository. Local fixtures, environment files, installation and preview commands belong here. If an existing sandbox keeps the app elsewhere, record its actual path. |
| `roots.serialization` | Optional platform transfer workspace, when required by the active profile. |
| `connectors.sourceContent`, `targetContent`, `sourceCode`, `targetCode` | `{ id, name, type }` of the connector filling that role. Content roles are the CMS instances; code roles are the git connectors (`source-git`, `target-git`). |
| `source.site` | Source content-space identity and scope fields required by the active profile. |
| `source.code` | `mode` is `connector` (with `repoName` and the `sourceCode` connector), `git-url` (credential-free `gitUrl`) or `upload` (`upload.archivePath`, `filename`, `sizeBytes`, `uploadedAt`, `sha256`, `extractedTo`), plus `branch` and `revision`. |
| `target.appName` | Name of the target application, when applicable. |
| `target.sdkVersion` | Target platform or application SDK version, when applicable; read from the target's authoritative version source. |
| `target.code` | Explicitly selected `repoName` and `branch`. Never infer a branch from a platform or connector default. Commit identity and pushes: [git operations](git-operations.md). |
| `setup.initMode`, `setup.initializedAt` | How and when the target was prepared, using the modes defined by the active profile. |

Use the connector IDs from `list-connectors`, not names, when matching a role to a connector. A role is what the connector does in this migration, and a connector can be renamed.

## Resuming an existing workspace

For an existing workspace, retrieve its current Migration Artifact, connector records, active workflow, and sandbox execution files. Verify scope and connector identities against current records and user-confirmed decisions. Never copy credentials, endpoint secrets, or platform-owned `recipe:*` and `sandbox:*` fields into this file. If required current state is missing or inconsistent, report the gap and ask for a current decision; do not infer it from unrelated files.
