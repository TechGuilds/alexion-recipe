# Phase 5 — Resolver Adapters

This phase replaces only evidence-proven source rendering-contents resolvers or
controller data-shaping gaps with target TypeScript adapters. It is applicable
only when Discovery records an included data-shape gap. It runs after the
approved Code Migration, Content Migration and SXA/presentation work that the
adapter's target route needs. A source inventory proving that there are no
included resolver/data-shape gaps is a successful no-work outcome; record that
scope decision and do not create no-op adapters.

The coordinator owns `workflow.json`, mappings, decisions and task status. A
worker owns one bounded adapter contract and writes only its task attempt
evidence. Do not introduce a separate adapter ledger or infer current work from
chat history.

## 1. Entry, resume and prerequisite gate

Before dispatching or resuming an adapter task, read the approved workflow,
current inventory/mappings, Discovery synthesis/report evidence, prior task
results, current target files and decisions. Confirm all of the following:

| Required fact | Evidence | If missing or stale |
| --- | --- | --- |
| Current phase entry | Explicit `phase-continuation` decision for Resolver Adapters | Wait; plan approval alone is not execution approval. |
| Source contract | Included stable rendering ID(s), resolver/controller source reference, consumer routes and source layout capture | Recover a bounded source read or record the precise blocked gap. Never guess a resolver's shape. |
| Code foundation | Approved Code Migration task evidence for the target component, route and current target revision | Stop the dependent adapter task; do not use an unverified component as a host. |
| Content/presentation foundation | Current Content and SXA evidence proves the target datasource/site/route used for validation exists | Stop and direct the coordinator to the missing phase/task. |
| Target identity | Exactly one explicit target site name in current SXA target read-back evidence, or one result from a bounded authenticated target-site enumeration | Ask the user to choose when zero, several or conflicting names exist. A source `siteName`, repository name or app name is never a target-site value. |

Inspect active/running jobs before retrying. Reuse current evidence only when its
input hashes, source revision, target route and target files still match. A
correctable invocation/input error gets one safe correction and retry with the
same scope. A source, target or tool capability failure is reported as such; it
is not silently reclassified as an empty resolver inventory.

## 2. Framework and live-debug gate

At Resolver Adapters phase entry, run the native resolver scaffold in read-only
mode once:

```sh
node scripts/scaffold-resolver.mjs --target <roots.app> --source <roots.source> --dry-run
```

Store the terminal JSON as the **phase-level framework-plan result**. It binds
the source and target roots, scaffold provenance, deterministic actions, current
before/after hashes, conflicts, unresolved dependencies and route-integration
result. Review and, when separately approved, apply its hash-bound plan before
dispatching adapter work. Applying the plan is a scoped target-code mutation:
it requires an exact hash-bound overwrite decision for any replacement and
preserves registrations/custom files. Do not hand-edit the resolver strategy,
registry, client or types to make one adapter work. If the target cannot support
the framework/bundler contract, return a scoped framework prerequisite task
rather than changing an adapter task's scope.

Reuse the phase-level framework-plan result for every adapter task. It remains
current until its source or target root, scaffold provenance, a framework file
listed by the plan, or route integration changes. An adapter implementation file
alone is not a reason to refresh it. If the result is missing, stale, conflicted
or unresolved, or an adapter reports missing or broken framework wiring, stop
only the affected adapter and create or refresh the phase-level framework plan;
do not have an adapter worker rediscover it.

Resolver validation requires `live-debug` for the whole attempt. Configure the
supported mode through `sitecore/references/dev-mode.md`, collect all missing
non-secret settings in one prompt, then restart the preview with the
`dev-server` procedure. Confirm a fixed-port running preview, a clean
baseline-error snapshot, one real target page request and the
`[resolver-debug]` marker stream. Retry a failed preview start once after
diagnosing a correctable input/configuration problem; otherwise stop the
affected task. A ready server, HTTP 200 or raw Edge layout is not enrichment
proof.

## 3. Contract inventory and task selection

Build the adapter inventory from the retained Discovery resolver/controller
evidence and the approved entity-to-task mapping. The unit is one distinct
source data contract, not a React filename or a display-name guess. For every
candidate retain:

- stable source rendering ID and consuming target component;
- source resolver/controller type and source path; routes, language and a
  resolver-expanded source-layout sample;
- the target raw-Edge sample, consumer field-access report and field-level
  delta; and
- category (`pass-through`, `rollup`, `contextual` or `data-assembly`) plus a
  reasoned complexity assessment.

Order independent contracts high → medium → low complexity so a complete
pipeline is proven before simple work. Do not merge different source shapes into
one task merely because their component names are similar. A user-approved
batch remains a single workflow task but retains one current entity-result
artifact for every mapped rendering/contract.

## 4. Per-adapter execution and verification frontier

Dispatch one fresh frontend-developer for the current contract with its stable
task/entity IDs, source C# path/type, consumer files, route/sample paths,
confirmed target site, source/target layout delta, field-access report, current
framework plan, target root and exact acceptance checks. The worker follows
`sitecore-headless-to-xmc/references/resolver-adapter.md` and may edit only the
assigned adapter file after framework work is separately approved.

For each non-pass-through adapter, technical success requires all of these:

| Check | Required evidence |
| --- | --- |
| Source-to-target contract | A field-shape table comparing the captured resolver-expanded source layout with raw target Edge layout. |
| Query reality | Schema introspection and every focused adapter query succeeded before implementation; no constructed endpoint/secret transport. |
| Adapter matching | Current `[resolver-debug] match` and `changedFields=yes` lines after a real page request. |
| Visible enrichment | A target render marker whose value is absent from the raw target layout and present only after enrichment. |
| Safe implementation | Defensive empty/error behavior, scoped cache key and no hardcoded source/target IDs or paths. |
| Reproducibility | Current task/entity result, changed-file scope and recoverable checkpoint/reference. |

For a pass-through contract, return `skipped` only with both layout samples
showing that every consumer field already exists and an explicit rationale. A
clean compile, page HTTP status, debug marker alone, or a direct raw-layout
reread cannot pass the adapter.

After each worker result, the coordinator validates raw evidence with
`validate-evidence.mjs`, presents a compact review table, obtains and records a
hash-bound `Verified`/`Needs rework`/`Pause` decision for every mapped contract,
then runs `next-work.mjs`. Do not mark another adapter task in progress or
dispatch its worker until every mapping in the just-completed task has current
verified evidence and a matching user decision. This applies equally to a
single adapter and a grouped task.

On retry or redo, inspect the previous adapter file, target preview output and
checkpoint scope first. A user-approved restore must name the exact checkpoint
and changed paths; read back the restoration, invalidate only evidence that
depends on the restored paths, and dispatch a fresh task-scoped worker. Never
overwrite an adapter, widen a query, repair framework wiring or rerun a target
mutation under an earlier approval.

## 5. Completion and final acceptance input

At phase close, reconcile every included resolver/data-shape contract to exactly
one approved mapping and current entity result. Report complete, explicitly
skipped, failed, blocked and unresolved contracts grouped by category and
complexity, including source rendering IDs, target components, validation routes,
field counts, target-site provenance, checkpoint references and rejected/absent
attestations. The tester independently checks representative source-expanded
versus target-enriched payloads and rendered output; source or raw Edge payloads
alone are not enough.

The phase completes only when all approved tasks satisfy their evidence and
verification gates, or the user records a scoped reduced-acceptance decision
listing every exclusion. Hand the verified/limited coverage and unresolved
target limitations to final migration acceptance; do not describe untested
adapter behavior as equivalent.
