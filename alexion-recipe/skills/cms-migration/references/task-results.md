# Task result contract

Workers write detailed outputs under evidence/<task-id>/<attempt>/ and persist one complete TASK_RESULT object in the assigned result file: completed evidence is never replaced by a chat summary. Its fields remain:

- taskId: exact workflow task ID.
- outcome: success, failed, blocked, needs-redo or skipped.
- summary: short factual outcome.
- evidence: array of file references with kind, scope, observation and provenance.
- changedFiles: explicit target paths, empty for read-only work.
- checkpoint: restore reference and scope when changes were made.
- unresolved: remaining gaps or hazards that prevent the assigned task's required acceptance criteria, including missing required capabilities. Discovery's distinction between collection acceptance and report limitations is defined in [the Discovery contract](pipeline/discovery.md).

This is an attempt result, not a second current-status store. Each owner sets its actual Kajoo task status and report; only the coordinator projects validated outcomes into shared workflow status. Missing/malformed results are unverified, not success. Validate the task identity and evidence before incorporating it; an agent name is not part of identity.

Workers own their attempt result and its task-owned evidence. A coordinator may validate or reject that result, but must not rewrite its evidence/provenance into a synthetic successful result. Return the task to the worker with the concrete validation failure, or keep it blocked when no safe bounded correction exists.

## Validate every terminal handoff

Before handing off **any** terminal outcome, including a user-approved skip or deferral:

1. Read `assets/contracts/task-result.schema.json` from the resolved `cms-migration` skill root. Persist all seven required fields exactly: `taskId`, `outcome`, `summary`, `evidence`, `changedFiles`, `checkpoint`, `unresolved`. Arrays remain arrays even when empty; `checkpoint` is `null` for read-only work. Do not use a partial object or invent fields/outcomes such as `deferred-by-explicit-scope`.
2. Use only `success`, `failed`, `blocked`, `needs-redo` or `skipped`. An explicit scope decision removing work is `skipped`, with the reason and decision reference in the summary/evidence. A missing required input or capability is `blocked`, not a skip. Record actual partial changes/checkpoints even on unsuccessful attempts; do not erase them to make an envelope look read-only.
3. Read back the saved JSON and run the existing `validate('task-result', result)` export from `scripts/contracts.mjs` against it. This is a library function, not a standalone CLI. Resolve the actual skill/result paths before importing/reading them. Validate each referenced evidence entry against the existing evidence schema as well. Fix schema errors in the owner's file before handoff; do not silently default missing fields in consumers.
4. For a claimed `success`, also run the existing technical postflight below when its coordinator-provided request is available. Schema validity alone does not establish acceptance, current hashes, or completed work. For `failed`, `blocked`, `needs-redo` or `skipped`, preserve that truthful outcome: technical postflight may correctly report it unverified. Do not convert it to success to make the postflight pass, and do not invent a postflight request when none was provided.
5. The coordinator/integration/audit reader validates the schema and exact task/attempt identity **before** accessing fields such as `evidence` or `unresolved`. Reject malformed output with the concrete validator error and return it to its owner for a bounded correction. A structurally valid non-success result is a known outcome to handle under the existing scope/dependency rules, not verified successful evidence. Missing results from canceled/nonterminal runs remain incomplete attempts.

A schema-valid read-only skip can have `evidence: []`, `changedFiles: []`, `checkpoint: null` and `unresolved: []` only when those values are truthful; it still needs the existing explicit scope/skip decision before the coordinator may treat the work as intentionally omitted. Put that decision's reference and downstream limitation in the summary/report. Never fabricate evidence merely to populate an array.

For a task that can change a target repository, the coordinator creates one path-only
`postflight-request.json` beside the attempt before dispatch and gives its path to the
worker. It names the canonical workspace-relative workflow, decisions, reviewed inputs,
selected result path and—only for a modifying task—the target repository root. It is not
a status record and workers do not alter it. The worker writes evidence paths and
provenance input paths relative to the workspace root; `changedFiles` and checkpoint
scope remain relative to the declared target repository root. For example, with
`changedFilesRoot: repos/target-app`, use `src/Layout.tsx`, never
`repos/target-app/src/Layout.tsx`.

Before returning a terminal successful TASK_RESULT, the worker runs
`validate-task-attempt.mjs` once against that request and the explicit workspace root.
If it fails, correct only its own result/evidence in the same attempt and rerun it before
returning. The coordinator independently reruns the same validator after the terminal
worker return. Do not hand-build a second `validate-evidence` envelope, recalculate
hashes manually, or relocate evidence into a scratch directory.

`unresolved` contains only gaps that prevent this assigned task from meeting an acceptance
criterion: a failed or missing required check, required artifact, capability or safe
scope fact. Put informative observations—expected pre-implementation console messages,
tooling provenance, wording differences and explicitly out-of-scope later work—in the
summary or evidence observation instead. Never move a real acceptance gap merely to pass
validation. For Discovery collection, preserve optional enrichment gaps, sampled coverage
and deferred implementation checks in the referenced report, and summarize them in
`summary`/evidence `observation`; they are not unresolved collection acceptance failures.
The same distinction applies to each evidence entry's `unresolved` and `checks`. A
successful collection is not a claim of complete semantic/runtime coverage. Required
missing findings remain unresolved and cannot be moved into a report solely to pass
validation. The coordinator must review all report limitations before synthesis/audit.

For executable staged results use ../assets/contracts/task-result.schema.json and evidence.schema.json; exact fields are in executable-contracts.md. The local validator requires scopeId, SHA-256 artifact/input provenance, explicit checks and unresolved arrays. Put connector/browser details in referenced artifacts, not undeclared top-level fields. checkpoint is null for read-only work or { reference, scope: [changedPath, ...] }.

When one approved task covers several inventory entities, include `entityId` on an evidence entry only when its artifact is a structured per-entity result (`kind: "entity-result"`, validated by `entity-result.schema.json`). That artifact binds the exact task/entity, outcome, summary, changed files, checkpoint, checks, decisions and unresolved items. Its identity must match the evidence envelope; its changed files/checkpoint must be contained in the task result. Screenshots, logs or aggregate reports remain supporting evidence and cannot independently prove one member of a batch. Each mapped entity needs its own current, hash-valid entity result with successful outcome, passing checks and no unresolved items; task-level success without evidence for every mapped entity is incomplete. If only some entities pass, report the task as failed/blocked and preserve the passing entity-bound evidence so coverage can distinguish verified items from the unfinished remainder. `verifiedEntityMappings` is derived from selected attempt evidence, not maintained as another persistent status file; workflow task status remains the only current task-status authority.

A canceled, empty or nonterminal worker invocation has no `TASK_RESULT`. Store its bounded logs and any task-owned observations as an incomplete attempt, keep the workflow task blocked and inspect declared changed paths/current hashes before recovery. It may not supply technical completion, a checkpoint, entity results or human-verification input. Resume/re-dispatch only the same task after that inspection; an uncertain or out-of-scope partial change requires a scoped user decision rather than an automatic commit or next-task dispatch.

For remote work include connector role/ID, job ID, terminal state, success/failure counts and affected item IDs; no credentials. For code collection include analyzer commands/results, source revision/file hashes and actual scope/coverage. For implementation tasks also include the applicable baseline/target route, browser evidence and checkpoint/commit hashes. Reference bulky logs rather than inlining them.

Human visual attestation is a separate `verification` decision in `decisions.json`, keyed by task and entity, and is not written by the worker or folded into technical task status. Its hashes bind the exact selected task-result JSON and that attempt's evidence files. `validate-evidence.mjs` reports `entityAttestations` independently, including the current `inputFingerprint` and one matching fingerprint per entity; missing or paused attestations do not falsify passing technical checks, but remain outstanding in the Code Migration exit audit. Changing the selected attempt or any evidence makes an old attestation stale.

The coordinator must not dispatch another implementation task until the current
task's evidence has been validated, a structured user review has produced one
current decision for every mapped entity, and `next-work.mjs` confirms the
verification frontier. Technical `done` and human `verified` remain separate
facts; a missing or stale decision leaves the frontier waiting rather than
silently advancing.

## Chat communication

Write for the person managing the migration. Concise does not mean silent. Coordinators
and workers must start each new task with one short, user-friendly sentence explaining
what they will do, before the first tool call. For example: "I'll check your existing
website and help you choose its code repository." On resume, acknowledge the answer
only when it changes or clarifies the next action; do not repeat the opening.

Give a brief update at meaningful milestones or when the approach changes. During
active work lasting more than about a minute without visible progress, explain what
you are currently checking or waiting for, even if there is no result yet. Never
invent progress, poll only to produce an update, or repeat unchanged messages. Before
asking for user input, briefly explain why the choice is needed unless the preceding
update already explains it. Do not replace the structured question with prose.

Use one or two plain-language sentences per update. Group related work; do not narrate
every tool call, skill load, file read/write, validation or task-status change. Keep
routine bookkeeping out of chat, while explaining its user-relevant outcome. Avoid
repeated summaries and routine recovery narration unless the failure affects the
outcome, timing, scope or a user action.

For every bash call whose purpose is known from the task, user request or available
context, populate its `description` with a short, user-friendly action label. Start
with a verb and aim for fewer than 80 characters, such as "Check your website connection",
"Download your website's code", "Check the selected site settings" or "Prepare your site
for preview". Describe the actual action without promising success. Do not put commands,
script names, paths, IDs or technical reasoning in the label. Do not read or analyze
an unfamiliar script just to describe it; if its purpose is unknown, omit the description
or leave it empty so the UI uses its generic fallback. Labels complement progress
messages; they do not replace the task opening, meaningful updates or final summary.

Use recognizable site, repository and branch names when relevant. Keep connector/task
IDs, full commit hashes, checkpoint codes, schema field names and evidence inventories
in the saved result/report unless needed to explain a blocker or requested by the user.
Do not paste diagnostic logs or lists of untouched files into normal chat. Never expose
credentials. Use small tables for configuration or decisions when they help; avoid
ASCII banners, repeated checklists and invented progress percentages.

Workers save the complete TASK_RESULT at the assigned result path (or a task-owned
result path when none was assigned), retaining all required evidence/provenance, checks,
changed files, checkpoint and unresolved items. Follow `managing-kajoo-tasks` to save and
read back the final `## Technical report` section of the actual Kajoo task
`description`, preserving all requirements above it. Include the exact workflow task ID, attempt, outcome, result path, role
handoff path where applicable, verified findings and material limitations. The task
report is a readable index to evidence, not a replacement structured state store.

The final chat response contains only a short user-facing outcome, material blockers or
required next action and a Kajoo task link. Do not include a technical checklist, raw
TASK_RESULT, hashes, file inventory, coordinator instructions or handoff paths in chat.
For example: "Source setup is complete. The selected site and repository configuration
are saved." followed by the actual task link. Save report/result references in the task
instead of requiring the coordinator to recover them from a verbose final message.

The coordinator fetches the assigned task's final `## Technical report` description section, reads the exact referenced
structured result and role handoff, then validates task identity, attempt and evidence
before projecting workflow state or dispatching dependent work. The owner completes its own Kajoo lifecycle and output persistence; the coordinator does not finish the owner’s task or publish its files. Neither a friendly summary, a task report nor job success
proves completion. Keep failed/blocked outcomes and material limitations visible. If a
report or result cannot be saved/read, return an incomplete handoff under the existing
recovery rules; never invent a reference or claim completion. Brevity never removes
required approval scope, alternatives or verification information. Detailed results are
available from the task description’s final Technical report section and evidence files when requested.

Prefer "The Discovery plan is ready" over "Bindings and ranks read back consistently."
At a phase boundary, summarize the outcome and next decision once; do not repeat each
worker's report or reopen choices already confirmed.

Worker final summaries are normally 2–4 sentences and at most 100 words, including the task link. Do not turn the saved result's schema or
role configuration into a chat checklist. Keep material blockers visible and refer to
the saved report for the supporting detail. Coordinators perform administrative steps
silently even when a workflow enumerates those steps; a procedural checklist is not a
script for user-facing narration.
