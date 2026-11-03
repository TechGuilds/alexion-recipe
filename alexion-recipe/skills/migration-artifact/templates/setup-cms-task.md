# Complete CMS-specific setup

## Description

Workflow task: `setup.cms`. Link the actual migration artifact, Setup phase and prerequisite task IDs when creating this task as todo. Resolve source/target connectors and repositories from the linked artifact, and readiness evidence from its completed prerequisite tasks at dispatch. Keep assignment in the task's structured field. Render references using the Kajoo annotations described in the source setup template; never save placeholder IDs or wait for connector selections before creating this task.

## Scope and prerequisites

Both source and target tasks must satisfy the [role completion contract](../references/role-setup-contract.md). As this task’s integration owner, fetch their current Technical reports and read the selected TASK_RESULT/role-configuration files. Require verified current owner outputs; both artifact roles must already be saved and verified by their owners; combined sandbox context may still be partial at entry. Reuse selected checkouts, refs/revisions and decisions without re-interviewing or repeating successful probes. Missing/stale/contradictory role evidence returns to its owner and blocks integration, not the other completed role.

The migration-artifact skill continues to own the same Setup phase and task IDs. Load `cms-migration` and the active domain profile; run its existing Setup checkpoint procedure within this task. Do not create another artifact, Setup phase or checkpoint tasks.

## Required work

- Confirm migration type, full migration or discovery-only scope, and applicable source/target surfaces. Never invent scope or promote a prior connector choice into a site/language decision.
- Own integration: fetch the latest artifact and verify the roles already persisted by the role owners against their selected evidence. Reuse those values; return missing or conflicting role persistence to its owner instead of silently filling it here. Preserve unrelated fields and phase/state-file links. Persist combined context and actual role-choice provenance in Setup decisions, validate and read back those files. Reject conflicting newer choices rather than overwriting them. Keep unsupported execution-only values in evidence/state and secrets out of all records.
- Reuse the selected source/target sites, languages, platform/architecture/SDK facts and repository evidence from role setup. Perform only remaining cross-role compatibility and capability checks, bounded approved remediation and target repository/application safety checks. Missing required role configuration returns to that same role task; do not silently compensate after it was marked done or repeat successful interviews/probes.
- Reuse source/target checkouts and revisions. If a readiness task recorded no target repository, resolve required repository/application preparation here for full migration. An explicit discovery-only scope may make target initialization inapplicable; record the scope-backed reason.
- Obtain the required scoped user choices before adopting or initializing the target application. Delegate implementation to the appropriate specialist and retain terminal evidence. Readiness alone never authorizes application changes or a push.
- Complete this task’s artifact/context/Setup-decision writes and evidence, save/read back its final Technical report and honest Kajoo status yourself. The coordinator alone projects the result into the global workflow/bindings. Record checkpoints in task evidence/reports, not as additional project tasks. No other task writes combined Setup state while integration is running.

## Acceptance and lifecycle

Mark in-progress at execution start and blocked on missing required inputs or evidence. Mark done only when the active profile's required Setup checks pass, context validates as complete, and applicable initialization/adoption is verified or explicitly inapplicable for the selected scope. Preserve optional/deferred findings with their owners. Supply evidence and remaining risks to the independent audit. Do not create or start Discovery.

## Technical report

Not recorded yet. During execution, replace this final section with the current attempt’s
outcome, verified configuration or changes, checks and material limitations, blockers/next
action, and structured result/evidence references. Preserve all task requirements above
this heading. Follow `managing-kajoo-tasks` for report updates; keep chat summaries short.
