# Audit Setup evidence

## Description

Workflow task: `setup.audit`. Link the actual migration artifact, Setup phase and prerequisite task IDs when creating this task as todo. Resolve current role configuration from that artifact and verification inputs from completed prerequisite evidence at dispatch. Keep the independent tester assignment in the task's structured field. Use the task reference conventions from the source setup template; never save placeholders or delay task creation until evidence exists.

## Prerequisites and scope

The source setup, target setup and CMS-specific tasks must have verified completion evidence. The tester independently checks that evidence against the current artifact, connectors, sandbox paths and active profile's Setup acceptance rules. Do not create phases, re-run broad preparation, initialize applications or infer user approvals.

## Required checks

- Read back the current artifact and compare both roles with each task's `role-configuration.json`, terminal evidence and CMS-owner-persisted context/decisions. Verify all applicable confirmed site, platform/version, rendering/SDK, repository and reference facts are persisted in supported artifact fields, with execution-only facts in sandbox state. A known selected target site cannot exist only in a report. Missing required role facts, failed artifact read-back or state mismatches block the audit; return the precise gap to the owning role or CMS integration owner without rewriting unrelated work. Optional unknowns, inapplicable values and authorized deferrals need explicit evidence and owners, not invented values.

- The phase and all five task IDs belong to this migration and project; `content.phases`, active workflow and Kajoo bindings agree. No unrelated phase was adopted by name.
- Both platform roles and applicable repository checkouts, selected branches/revisions and reference decisions have verified readiness evidence.
- Confirm the distinction between each remote default branch and the selected working branch, and check the actual selection evidence. Missing required confirmation remains a gap, not a historical approval to invent. Check recording timestamps against the actual clock; unknown original answer times remain explicitly unknown.
- The CMS task's explicit scope, site/language and platform-specific prerequisite evidence satisfy the active profile. Reuse current evidence; recheck only an identified gap.
- Run the existing context validator and profile gate evaluator. Full migration cannot pass with a required target repository/application merely deferred; discovery-only exclusions require recorded scope evidence.
- Verify applicable application initialization/adoption and scoped mutation approvals. Do not demand initialization for a surface the user explicitly excluded.
- Inspect rendering-host configuration using only allowlisted non-secret fields (host name, path, Node version, enabled flag). Never print the entire `xmcloud.build.json`, `jssDeploymentSecret` values or environment-file values. Verify toolchain availability through `NVM_DIR` and the initialized nvm command, not an assumed home directory; select a required Node version per command without changing the shared default.
- Own the Setup summary, completion assertion and phase-boundary reports. Write them in this task’s evidence directory and persist/read back `reports/setup-summary.md`, `reports/setup-completion-assertion.json` and `reports/phase-boundary-setup.json` yourself as the sole assigned audit-report writer. Include verified/pending/blocked/deferred findings, evidence and exact proposed Discovery scope, including honest blocked/interrupted exits. Do not edit combined context, workflow or Setup choices. After this audit finishes, the coordinator may append only its later phase-continuation decision to the boundary report, preserving your audit findings.

## Lifecycle and handoff

Mark in-progress before checking. Mark blocked with precise findings if any required gate fails; do not mark prior tasks complete on their behalf. Mark done only when all applicable checks pass. Completing this audit verifies Setup evidence but does not complete the phase. The orchestrator must next complete `setup.prepare-discovery`, which creates the visible Discovery plan without starting it. This planning task may remain todo during the audit; its absence of completion is not an audit failure. Return the report to the orchestrator; the user's phase-continuation decision remains separate and does not keep the audit task open. Do not create or start Discovery.

## Technical report

Not recorded yet. During execution, replace this final section with the current attempt’s
outcome, verified configuration or changes, checks and material limitations, blockers/next
action, and structured result/evidence references. Preserve all task requirements above
this heading. Follow `managing-kajoo-tasks` for report updates; keep chat summaries short.
