---
name: mapped-content-migration
description: Use when an assigned Sitecore Content Migration task must map source content into existing target templates, split items, relocate local or global datasources, resolve migrated content references, or prepare and verify explicitly approved media packages without component code migration.
---

# Mapped Content Migration

## Availability

Supports opt-in [media package migration](references/media-migration.md), local input validation, source snapshot preparation, deterministic transformation, dry-run planning, guarded execution, reference resolution and independent content verification. Consult the [script inventory](scripts/README.md) for available commands and [operational boundaries](references/operational-boundaries.md) for common prerequisites and exclusions. The writer's per-operation read-back is not the final audit. If the assigned task requires an unavailable operation, return `blocked`; do not invent a script or substitute serialization push.

Use this skill only for an explicitly assigned task. Its explicit workflow proposal is integrated only after existing workflow-plan approval, validation, materialization, Kajoo synchronization and phase-continuation approval; see [workflow integration](references/workflow-integration.md). Loading it does not authorize a phase transition, remote read, target mutation or publishing.

Require `contentMigrationMode: mapped-content` in the task packet and follow [content transfer method precedence](references/content-transfer-method.md). Missing or contradictory method evidence blocks assignment; native serialization is never a fallback.

## Entry and ownership

Read the assigned task/attempt, declared migration context, current decisions and named evidence. Require explicit source/target instance, connector, database and approved item/language/version scope. Source and target may share an instance; keep their roles and paths distinct.

The orchestrator owns task selection, approval records, dependencies and shared workflow projection. The Sitecore specialist owns script execution and its result/evidence. The tester independently checks target outcomes. Follow the existing [task-result contract](../cms-migration/references/task-results.md) and [checkpoint rules](../cms-migration/references/checkpoints.md); identity maps and batch records are evidence, not alternative workflow or approval stores.

## Procedure

For a new approved Content Migration workstream, begin with [workflow integration](references/workflow-integration.md). The proposal builder preserves existing active work and Discovery inventory; only the existing approved/materialized/synchronized workflow and separate continuation gate authorize task dispatch.

1. Before any media work, require the coordinator's explicit `migrate-media` or `skip-media` scope decision. Approved media tasks follow [media migration](references/media-migration.md) before content capture; source scope approval and separate exact target mutation review remain required.
2. Read [input contracts](references/input-contracts.md) and the [execution runbook](references/execution.md). Before capture, inspect the supplied scope and mapping evidence; never fabricate a snapshot just to run the validator.
3. Follow [source snapshot preparation](references/source-snapshot.md): reuse matching evidence, report gaps and generate requests for only missing/stale data. Obtain current approval before remote capture. Validate partition integrity and required coverage. `valid: true` from input validation is not proof of complete capture, mapping approval or write readiness.
4. Use the [local transformation procedure](references/transformation.md) for mapped item definitions and proposed identities. Use [dry-run planning](references/dry-run.md) for target comparison and bounded review batches. Follow only the assigned operations: capture, transform, dry-run, approval, execute, resolve references and verify. Check availability before each operation. Present each user-visible result and wait for its recorded continuation/review decision.
5. Perform SPE operations only through the selected role's supported Sitecore connector, never a local shell. Credentials remain with connectors. Use local scripts for deterministic file processing.
6. Follow [target execution](references/target-execution.md) for review preparation, the existing mutation decision, one reserved request and receipt/checkpoint recording. Apply only the reviewed plan/batches with current approval, fresh target checks and recoverable remote backups. Preserve local/global identity, inherited fields, parameter context and reference ordering.
7. For reference work, follow [reference resolution](references/reference-resolution.md): bind the original content input and immutable current checkpoint, collect fresh owner/dependency observations, review the separate proposal and use the same guarded writer/recorder. Missing, ambiguous or partial dependencies block all batches; never create items or versions in this pass.
8. On failure, interruption, drift or mapping changes, follow [recovery](references/recovery.md) before another mutation. Never resubmit a job whose terminal state is unknown.
9. For an explicitly assigned independent content audit, follow [target verification](references/target-verification.md): reconstruct the canonical expected content, obtain exact read-scope/hash approval, collect fresh readback only through the target connector and preserve every gap. No journal/workflow updates, remediation or publishing are allowed.
10. Save/read back the complete task result and evidence. Hand verified target identities and remaining gaps to the orchestrator for Presentation Composition.

## Boundaries

Consume approved mappings; return ambiguities to their owner. Do not author missing mappings, infer destinations from warnings, copy template/rendering definitions, assign presentation, convert components, provision SXA or publish. Missing media or reference targets are dependencies to resolve through approved scope, not permission to copy unplanned content.
