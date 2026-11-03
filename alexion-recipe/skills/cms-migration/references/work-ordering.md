# Work ordering and hosting

Two different things can make one work item wait for another. Keep them apart.

- **Ordering dependency** (`dependsOn` in the workflow): a prerequisite in the workflow contract, such as shared styles, an approval or a phase anchor. It is all-of, and it is met when the prerequisite is done or explicitly skipped. The workflow validator enforces it.
- **Optional enrichment dependency** (`optionalDependsOn` in the workflow): an analysis that must reach a terminal attempt before dependent synthesis runs, but whose `failed` result does not block that tolerant task. `done`/`skipped` also satisfy it; `pending`/`running`/`blocked` do not. The failed task remains failed and keeps its phase incomplete. Use only when the domain profile explicitly defines the result as enrichment, never to hide a required check.
- **Hosting** (`parentIds` in the inventory): the item lives inside a parent that renders it. The item's own code does not need the parent, but the item cannot be seen, and so cannot honestly be verified in its real context, until some parent renders. Hosting is advisory. `next-work.mjs` evaluates it; the validator does not.

## Reachable items

An item is reachable when it has no parent, or when **any one** of its in-scope parents is `done`. Any-of is deliberate: the item needs one place where it can be seen, not every place it could appear. A shared component is therefore not held back by its slowest parent.

When a user-approved task groups several inventory entities, the task is reachable only when every entity in the group is reachable. `next-work.mjs` recommends that batch once and lists all its entity IDs. Its result/evidence and audit must cover the whole group, not just the first member.

A parent that is failed, blocked, skipped or not in scope never makes an item reachable. Counting a skipped parent as satisfied would hide that the item can no longer be verified in context.

## When nothing is reachable

`next-work.mjs` reports each waiting item with a reason:

| Reason | Meaning | What to do |
| --- | --- | --- |
| `dependency` | An ordering dependency is not finished. | Finish or approve it. |
| `waiting-for-host` | A parent is pending or running. | Let it finish. The parent is recommended first. |
| `host-failed` | Every parent that could host it failed or is blocked. | Redo or repair the parent, following the phase's Continue/Redo/Skip/Stop choice. |
| `host-skipped` / `host-out-of-scope` | The parents will not render. | Ask the user: include and migrate a host, skip or exclude the item, or proceed without a host. |

Nothing here is a permanent block, and the tool never decides for the user. A failed, skipped or excluded host needs a human decision.

## Proceeding without a host

The user may approve an item to proceed without a rendered host. Record it as a `verification` decision for that entity and task (see [decisions and approvals](decisions-and-approvals.md)) with the reason, then pass the entity ID in `proceedWithoutHost`. The item is recommended with `verification: isolated-only`.

Implement it and verify it in isolation, for example at a page root with mock data, and state the isolated scope in the evidence observation. Do not claim parent-context parity. The decision is the record of the reduced check. When a host later reaches `done`, the audit re-checks these items in context.

## Ranking

Among reachable items, `next-work.mjs` orders by facts already in the inventory, so the order is explainable and stable:

1. items that appear on at least one route, before items that appear on none
2. items that unlock the most waiting children
3. items placed on the most routes
4. fewer `uncertainty` entries
5. fewer `joins`
6. entity ID

Each recommendation carries its rank keys. The result is a recommendation for the coordinator, not a directive. A user-selected item still needs a reachable host or the decision above.

```
node scripts/next-work.mjs --input staged.json [--limit 5] [--out new-report.json]
```

Input `{ inventory, workflow, mappings, proceedWithoutHost? }`. Stdout is a summary with `status`, `primary` and `nextTaskIds`; the full report needs `--out` to a new file. Status is `has-pending`, `waiting`, `blocked`, `all-complete` or `none-in-phase`. The script never writes workflow state or dispatches work: the coordinator marks a task running as usual.
