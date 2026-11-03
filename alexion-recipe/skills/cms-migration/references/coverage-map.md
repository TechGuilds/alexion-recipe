# Coverage map

Map stable inventory entity IDs to task IDs and observed routes. Retain nested placeholder ancestry, source layout IDs, datasource/template dependencies and language/version scope. Names are labels, never join keys.

Choose a renderable ordering: layout/styles first, hosts before the items they contain, then page-aware coverage (home and high-coverage routes first). `scripts/next-work.mjs` computes this from the inventory and workflow; see [work ordering](work-ordering.md). It is a recommendation, not another persistent cursor or engine.

Keep full requested inventory separate from a sample capture. Mark requested/collected/failed routes and uncertain joins. A capped sample cannot prove an unused component. Reconcile new discoveries without duplicating stable tasks or silently dropping old in-scope entities.

Read [coverage audit](procedures/coverage-audit.md) for verification. The implemented [coverage CLI](../scripts/coverage-report.mjs) reports counts and gaps using [current input-bound decisions](executable-contracts.md); it never creates authorization or writes memory.
