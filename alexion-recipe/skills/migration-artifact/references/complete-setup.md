# Complete Setup and hand off

## Continue the same Setup

Resolve the artifact and its linked Setup phase/task bindings using returned IDs or verified stored bindings, never a phase name alone. Preserve existing statuses, successful evidence and pending runs. Never reset completed tasks or link unrelated phases during ordinary recovery.

Once source and target satisfy the [role completion contract](role-setup-contract.md), including each saved/read-back artifact role, matching role files and owner-completed task reports/statuses, dispatch the owner of `setup.cms` using its [task template](../templates/setup-cms-task.md). The active CMS profile supplies detailed procedures within the same phase; generic readiness evidence is input, not work to repeat.

After CMS-specific setup succeeds, dispatch the independent tester for `setup.audit` using the [audit template](../templates/audit-setup-task.md). Required access, scope, terminal evidence, context completeness and applicable initialization must pass. The tester owns its task evidence, Technical report, final lifecycle status and the three declared Setup audit reports; it saves and reads back them itself. The coordinator reviews the result and projects status, without publishing the tester’s files or completing its task. Audit success completes verification, not the whole five-task Setup phase; the tester never creates Discovery.

## Prepare the next visible phase

After `setup.audit` is verified done, execute `setup.prepare-discovery` using the [planning task template](../templates/prepare-discovery-task.md) and [CMS Discovery planning](../../cms-migration/references/prepare-discovery.md). The orchestrator creates or reconciles the Discovery phase and applicable tasks before asking for execution continuation. Keep returned IDs in bindings and `content.phases`, preserving all existing links. Ready task descriptions use todo; missing task-specific inputs use draft with a precise owner and next action. Do not dispatch work or require a new execution decision just to display this initial plan.

Mark Setup complete only when the audit and planning task both succeed and the Discovery plan is visible and read back. A planning-only failure keeps that task incomplete and does not invalidate the successful audit; retry only missing writes with the same IDs.

## Explicit execution continuation

Present one concise, user-facing Setup summary: what is ready, any material limitations
or unresolved inputs, and the next decision. Use a small Source/Target table with confirmed
site, repository/branch and relevant platform/stack facts, then state the audit outcome
and whether the Discovery plan is ready. Include only applicable verified facts; label
unresolved or explicitly deferred configuration without claiming it is ready. Omit internal
IDs, hashes, bindings, ranks and evidence-file inventories. Do not repeat worker reports.
Keep full audit and configuration evidence in their existing saved records. Follow
[chat communication](../../cms-migration/references/task-results.md#chat-communication);
this presentation rule changes no completion, approval or continuation requirement.

Present the completed Setup summary, visible Discovery plan and draft-task input gaps. Ask whether to start in this chat, continue in a new chat or pause. Record the scoped `phase-continuation` response against current evidence and plan in `decisions.json` and `reports/phase-boundary-setup.json`.

Pause or no response preserves the visible Discovery phase and tasks without starting them. A new-chat choice records a handoff but dispatches nothing now. A continue choice authorizes only the scoped ready Discovery work, not later migration phases or target writes. Use [CMS Discovery entry](../../cms-migration/references/start-discovery.md) to start the existing plan, never recreate it. Draft tasks remain blocked until their actual missing inputs are resolved.

On resume, do not duplicate records or re-offer an already current continuation decision. Later workflow expansion retains the CMS migration proposal/approval gates.
