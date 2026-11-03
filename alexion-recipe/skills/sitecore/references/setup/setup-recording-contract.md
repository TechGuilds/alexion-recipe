# Setup recording contract

This Sitecore-specific reference defines where Setup facts are stored and how capability findings affect the current Setup gates.

## Durable records

For every Setup checkpoint, persist:

- the project-scoped migration artifact via `create-artifact`/`update-artifact`: verified Sitecore platform/site/repository facts, with `phases` containing only the database IDs of the included project epics;
- `context.json`: non-secret migration identity, source/target connector roles, selected site/language, repository/branch, roots, mode and initialization mode/time.
- `evidence/setup.cms/<attempt>/`: sanitized probe output and terminal job results, including connector role, site/scope, timestamps and provenance. Reference existing `setup.source`/`setup.target` readiness evidence rather than duplicating it.
- `reports/setup-prerequisites.json`: one entry per applicable capability with the probe method, verdict, evidence path, remediation owner, next action, `blocking`, terminal state and probe time. Include Headless Services, SPE execution/download including SPE-1322, Layout/API readiness, applicable management/GraphQL access, target readiness and repository/app safety checks. Use `probe-unavailable` when a required authenticated connector probe is not exposed; include its required tool and integration owner rather than calling the source misconfigured.
- `decisions.json`: scoped repair approvals, overwrite/safety acknowledgements, target choices and the explicit phase-continuation response.
- `reports/setup-summary.md`: verified, pending, blocked, deferred and unresolved findings, plus the initialization result.
- `reports/setup-completion-assertion.json`: machine-readable assertion that all required checks are terminal, evidence-backed, context is valid/complete and initialization succeeded.
- `workflow.json`: task status only (`setup.source`, `setup.target`, `setup.cms`, `setup.audit`); do not duplicate evidence or decisions here. The internal S1–S11 checkpoints run within `setup.cms` and must not be expanded into one product task per checkpoint. The coordinator completes `setup.prepare-discovery` after a passing audit before the artifact-owned Setup phase is complete.
- `reports/phase-boundary-setup.json`: the final Setup boundary, risks, exact next-phase scope and, after the coordinator asks, whether the user chose pause, continue in the same chat or continue in a new chat. This conversational decision does not keep a project task open.

## Surface Setup results and route later work

Persist the normalized input verdicts alongside the evaluator output in `reports/setup-prerequisites.json`, preserving its capability entries, blockers and `recommendations`. For each non-ready service include missing-setting names or the observed failure, the actual probe/`not-invoked` state, evidence references and the configure/repair/re-probe action. Record the verified alternative selected by the evaluator; do not replace the failed service's verdict with the alternative's success. Before ending Setup, give the user a short summary of what works, what is unavailable, whether that blocks the confirmed scope, and the next action. A blocked Setup task must not advance Discovery merely because an unrelated service is ready.

At later task entry, reuse this same report and the role-owned evidence, checking connector identity, selected site/scope and whether configuration has changed. Follow its usable-service recommendations only for supported operations. If an operation specifically requires an unavailable service, return to its recorded remediation rather than retrying blindly or fabricating a fallback. Refresh the affected evidence after a connector change or repair and reevaluate before continuing. Keep capability state in these existing records, not new project-description fields or a second status store.

## Artifact facts and gate equivalence

For the existing migration-artifact fields only, record verified Sitecore facts: source/target platform identity and version, rendering architecture and SDK/version when known, the confirmed role's site identity (`name`, `rootPath`, `startItem`, `hostName`), connector IDs, repository names, selected checkout `branchName` and `sandboxDir`, and credential-free supporting references. The selected working branch belongs in the implementation repository's `branchName`, not a supporting Git reference. Distinguish unknown/inapplicable fields and declared versus resolved versions in evidence. Each sequential role owner saves/read-backs its assigned artifact role and separate role-configuration file before finishing its task, preserving the opposite role and unrelated content. After both outputs pass, the CMS setup owner verifies the already persisted roles, validates/persists combined context and Setup decisions, reads them back and finishes its own integration task. Never leave known selected target-site details only in an audit report. Preserve the opposite role and `content.phases`/`stateFileDir`. Keep phase links synchronized after plan changes. Never add task statuses, probe payloads, approvals or raw evidence to artifact content.

The migration-artifact field categories and update lifecycle are defined by the generic [artifact boundary](../../../cms-migration/references/migration-artifact-contract.md); this section owns the Sitecore-specific fact selection above.

The output of `scripts/setup/evaluate-prerequisites.mjs` is the authoritative Setup gate evaluation. It applies `assets/setup/capability-requirements.json` to the selected migration type/mode so Headless Services, SPE-1322, Layout/API, Management Services and authenticated content access are gated only when applicable. A warning, heuristic topology/license mismatch, optional/mock-replaceable capability or phase-deferred finding is not a blocker by itself; it remains visible as unresolved evidence while independent capability probes run. `needs-site-selection` is pending user selection, not a failed Layout probe. `probe-unavailable` identifies a connector integration gap and is never reported as a Sitecore configuration diagnosis. Missing, stale, canceled or timed-out evidence is `setup-blocking` only when the evaluator marks that capability required, as is a confirmed required-capability failure or unresolved source identity.

For SPE-1322, classify healthy pre-probe + dry-run + `kajoo-patched` + `WouldWrite=true` as patched-but-drifted. Any repair must have a dry-run, recorded live SHA, matching `expectedCurrentSha256`, backup, scoped apply and healthy post-probe. Persist all of those references in the attempt evidence and prerequisite entry.

Never store credentials or secrets in these records. Never reset or wipe Sitecore to satisfy a Setup gate.
