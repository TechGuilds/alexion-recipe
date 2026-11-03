# Tester checks

The tester is read-only: inspect source/target artifacts and actual behavior, return a task result with mismatches, and leave shared workflow writes to the coordinator.

## Setup

Run `scripts/validate-context.mjs` on `${MIGRATION_STATE_FILE_DIR}/context.json`. Setup is not verified unless it reports `valid` and `complete`. Compare the recorded connector IDs, site, language, roots and repositories with the actual connectors and sandbox, not with earlier chat.

Before reading evidence or writing an audit helper, follow [evidence path bases](context-file.md#resolve-evidence-paths-from-their-declared-base). Resolve each stored reference once from its documented base. In particular, a migration-relative `evidence/...` path is joined to the migration directory, never its `evidence/` child. Check the resolved input files before starting the audit; do not repair a missing path by changing recorded evidence. Then follow [JSON evidence shape checks](context-file.md#inspect-json-evidence-before-composing-helpers) before writing a combined audit helper: validate task-result contracts first and inspect the actual types of schema-free role/probe fields. Report malformed owner output for correction rather than assuming every result has successful evidence or every `checks` value supports `.map()`.

## Coverage

Follow procedures/coverage-audit.md. Reconcile expected entity IDs against task results and target existence. Empty inventories, sampled route data and unavailable producers are explicit gaps.

## Component and adapter checks

Read the source baseline/data contract and current target changes. Run relevant local checks, then visual and interaction procedures in a browser. Record exact routes, state, viewport and evidence. For adapters compare actual source/target fields and confirm the adapter executed; logs/HTTP 200 alone are insufficient.

## Content and profile-specific relationships

Use the active profile's read-only procedures to verify content IDs, fields, schemas, languages, profile-specific relationships and representative behavior against approved scope. Never remediate through the tester.

## Result

Return success only for checks actually executed and passed. Failed means observed mismatch; blocked means required evidence or capability unavailable. Preserve error details and propose bounded redo inputs. A user acceptance may acknowledge a gap but never changes an unexecuted check into passed.
