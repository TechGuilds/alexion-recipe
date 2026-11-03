# Executable data contracts

JSON Schema draft 2020-12. All documents reject unknown fields. The CLIs load these same schemas using scripts/contracts.mjs, which implements only their used keywords, not a general schema engine. External validators may resolve the local relative schema references.

inventory.schema.json: stable entity ID, kind, source identity/path, code/content joins, parent/route references, scope facts and uncertainty; no live task status.
evidence.schema.json: kind, artifact path, source/target role, scopeId, optional stable entityId for per-entity proof inside a grouped task, producer/version/SHA-256/input hashes, observation, checks and unresolved gaps.
entity-result.schema.json: structured per-entity result artifact. Only evidence entries with kind `entity-result` can establish an entity's success inside a grouped task; the artifact binds task/entity identity, outcome, summary, changed files, checkpoint, checks, decisions and unresolved items.
task-result.schema.json: taskId, outcome, summary, evidence entries, changedFiles, nullable checkpoint and unresolved fields.

workflow.schema.json: native version-1 phases/tasks, id/title/status/dependsOn/optional agent only. profile.schema.json defines kind-to-phase/anchor/prefix rules. mapping.schema.json keeps entity/task joins separate. decision.schema.json describes scoped decision facts; explicit response/time/current artifact matching is checked semantically for user verification, while exact current input matching is checked for approvals. Seven *-input.schema.json files define complete staged envelopes. context.schema.json defines the `context.json` document. See ../../references/executable-contracts.md for examples, semantic validation and output contracts.
