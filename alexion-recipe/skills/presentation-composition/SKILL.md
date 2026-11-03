---
name: presentation-composition
description: Use when an assigned task requires Headless SXA presentation planning, target-data preview, approved presentation application or final target website verification using existing components.
---

# Presentation Composition

Build a virtual presentation proposal, preview it using actual target data, and retain evidence-bound user review. Apply approved target presentation only through the guarded application procedure, then independently verify the target website. Preview operations do not write Sitecore presentation. Local workflow proposals require existing coordinator approval before activation; this skill does not publish or migrate components.

Read the assigned packet and [input contracts](references/input-contracts.md). Reuse current Discovery and content handoffs; request only missing or stale evidence. Never infer mapping instructions from warnings or component names. Source presentation explains the intended appearance; target definitions and defaults constrain the proposed result. Missing effective presentation, expanded SXA dependencies or target content blocks affected work.

Follow [workflow integration](references/workflow-integration.md), [virtual composition](references/composition.md), [preview and review](references/preview.md), [target application](references/application.md), [target website verification](references/verification.md), and the [script interfaces](scripts/README.md). The scripts use Kajoo's Node runtime and the validator and file helpers bundled in `cms-migration`, and the content-mapping contract from `mapped-content-migration`; no runtime dependency installation or Kajoo code checkout is needed. Preserve advertised skill paths and the bundled sibling skills.

The Sitecore specialist owns bounded reads through the selected connector and local composition artifacts. Frontend preview work uses the existing verified app foundation. The tester checks technical/browser evidence; the orchestrator obtains actual user decisions. Neither a ready proposal nor a screenshot creates user approval. Return gaps through the existing seven-field task result; do not change shared workflow or another task's status.

## Operating sequence

1. Confirm exact source/target instance, database, site, language, version, device and page scope. Process one explicit context per input; retain separate artifacts for other contexts.
2. Obtain the complete normalized source/target handoffs and original mapping. Inspect source defaults, effective occurrences, page overrides and inspected design dependencies. A collector reporting `sxaDesignExpansion: false` is incomplete evidence; never flip that flag to satisfy a contract.
3. Propose explicit grouping/default/assignment rules from the observed source intent and target capabilities. Present ambiguities, splits, exclusions and reuse choices to the user. Obtain the existing mapping decision bound to the actual mapping and rule hashes before composing them. Do not guess a target when several are possible.
4. Generate virtual Partial/Page Designs and proposed page/template associations with `compose-presentation.mjs`. Preserve rendering repeats, order within owners, nested relationships and verified local/global datasources. Report all conflicts; no target writes occur.
5. Generate preview payloads and navigation with `prepare-presentation-preview.mjs`. Use target field data and exact target resolver responses; source values and fabricated sample fields cannot fill gaps. Target preview reads still require the selected connector and current scope approval.
6. Review the preview-only app-file installation plan. Apply it only with the exact mutation decision through `install-presentation-preview.mjs`; it changes approved public preview files, not components or Sitecore content. Missing preview foundation returns a prerequisite; use the existing framework-specific preview procedure instead of fabricating readiness.
7. Navigate at least the agreed minimum number of pages and enough pages to cover every required target rendering/variant. Capture actual render checks and screenshots, then obtain the user's page decisions. `review-presentation-preview.mjs` checks current artifacts, evidence and coverage; technical coverage alone is not visual approval.
8. On revision, preserve the old attempt, refresh changed mappings/rules/data and hashes, regenerate into new directories, and obtain new affected approvals. Reconcile any partial preview-file installation using its per-file results and backups; never delete an app subtree to retry.
9. For an assigned target-application task, replay successful preview reviews, collect the exact fresh target state and generate the application dry-run. Resolve every conflict before requesting the separate mutation decision. Back up existing affected items, apply bounded batches through the selected connector, retain actual receipts and reconcile each job before continuing.
10. Run independent target read-back and the application audit. Obtain user confirmation of the applied result; a technical pass does not advance the workflow or establish visual/functional website parity.
11. For final Verification, capture the actual applied target site's Layout Service payloads and browser evidence. Compare target screenshots with the approved source baseline, exercise the agreed functional checks, and cover the required pages/rendering variants. Obtain actual per-page visual decisions and separate final acceptance. Preview files cannot substitute for target evidence.

When dispatched through the recipe workflow, consume generated `packet.presentation` metadata, validate actual outputs with `validate-presentation-outcome.mjs`, and attach the emitted domain/entity evidence to native postflight. Preserve the existing next-work user attestations and phase-continuation gates. The coordinator owns all shared workflow state and approval tasks; specialist/tester technical passes never authorize continuation.

## Handoff

Retain the composition request/plan, target-data provenance, proposed design/association differences, preview manifest, installation reports, coverage, browser evidence and actual user decisions. For target application, also retain the canonical plan, mutation decisions, journal, downloaded backups/receipts and independent target audit. A passing preview review sets `applyAuthorized: false` and does not prove final website parity.
