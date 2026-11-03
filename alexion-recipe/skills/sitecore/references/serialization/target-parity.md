# Target content parity

Target parity is a read-only comparison between the approved content scope and
the target after each completed batch and again at phase audit. It is not proved
by a CLI exit code or target item existence alone.

## Required comparison

For every item in the approved batch, retain a result for:

| Check | Required evidence |
| --- | --- |
| Stable ID and path | Exact source/target ID match and expected target path. |
| Template | Template ID and any approved remap reference. |
| Selected fields | Hashes or normalized values for fields declared material by Discovery, plus explicit unavailable fields. |
| Languages/versions | Expected language/version set and a record of missing or extra variants. |
| Dependencies | Parent, template/base-template and item-reference resolution status. |
| Representative pages | Read-only page/layout observations covering content use where Discovery identified a representative route. |

Record `matched`, `mismatched`, `unavailable` or `out-of-scope` for each check.
`unavailable` preserves the evidence gap; it is not a match. A mismatch is a
phase-completion blocker until a scoped correction or scope decision has been
approved.

## Sampling, aggregation and resume

Each completed target batch retains its own target-parity evidence: exact
expected IDs/counts, stable ID/path/template read-back, expected versus
observed language/version coverage, resolved dependency results and its latest
target mutation or no-op reference. That is the complete item-coverage record;
the final audit does not re-query every already-read item merely to duplicate
it.

For terminal reconciliation, first run the recipe-owned
`scripts/serialization/prepare-coverage-audit.mjs` against the **existing**
current inspection report. It emits one immutable `content-coverage-audit-plan.json`:

- expected target-root counts per namespace/include;
- the approved source-to-target path map (identity mapping by default); and
- the inspection hash and complete input manifest.

It does not parse source YAML or rerun capture inspection. A missing or stale
inspection report is a bounded evidence gap, not permission to recreate the
analysis during the audit.

Run `scripts/spe/audit-serialization-coverage.ps1` once through the target
connector with that plan as `auditPlanJson`. It performs target-root count
reconciliation in one remote operation. It does not mutate content. A large
scope remains one logical aggregate audit, not thousands of `get-item` calls.

The tester verifies that all completed batch manifests still cover the approved
scope and are current, then validates the aggregate count observation against
the recorded transfer outcomes. A count, manifest, identity or freshness
mismatch blocks completion and is the only reason to run a scoped item-level
investigation. Reuse batch evidence only when its manifest hash, source and
target identities, approved scope and evidence hashes are unchanged. Otherwise
refresh only the affected batch.

## Terminal audit freshness

After the final read-back, create a new immutable terminal-audit manifest for
the current approved scope. It must reference the duplicate-health result,
current transfer preflight, every batch parity result, dependency-closure
results, each task's latest target mutation or no-op batch evidence, and the
expected-versus-observed language/version matrix, and the aggregate coverage
observation. A parity result that predates a later target mutation for its task
is stale and cannot satisfy the audit. Record any older audit reports it
supersedes; do not relabel an earlier blocked audit as a pass after a later
repair. The phase summary shows this matrix and each check's status so
reviewers can distinguish a verified parity result from an approved
out-of-scope limitation.
