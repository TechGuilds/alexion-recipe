# Virtual composition procedure

Read the [input contracts](input-contracts.md) and named task evidence. Confirm actual target components and verified content are available. If source design/default/override evidence is incomplete, return the precise gap to its owner rather than launching broad discovery.

From the platform-advertised skill `scripts/` directory:

```sh
node compose-presentation.mjs --input /workspace/composition-input.json --output /workspace/new-composition
```

Use actual task paths; the command illustrates the interface. Outputs go to a new directory:

- `composition-plan.json`: hash-bound virtual Partial/Page Designs, page rendering instances, default removals, exclusions with reasons, proposed associations, source default/override provenance, verified content bindings and conflicts.
- `composition-report.json`: technical readiness and issues. `targetWrites: false` and `userApprovalRequired: true` remain explicit.

The effective source occurrences are translated through the actual mapping. Target template defaults are preserved or replaced only by the approved policy. Local/global identities, repeat occurrences, nested placeholders, ordering within each owner and parameter values remain explicit. Grouping and Page Design partial order follow the approved rules; present the resulting order for review. No component count or template name determines a missing mapping.

Reusing a design requires matching content and nested relationships. Equivalent existing Partial Design UIDs are retained. A mismatch blocks reuse rather than overwriting the target. New design keys and generated rendering UIDs are proposals; they do not prove target existence or grant write permission.

Exit 0 means a technically ready virtual proposal. Exit 2 preserves semantic conflicts and blocks preview installation; exit 1 means invalid input, fingerprint, path, schema or output failure. No exit status means visual acceptance. Keep the original attempt, revise approved inputs, and regenerate into another directory when the user requests changes.

All source/target capture, mapping decisions and item identities remain outside target presentation mutation. This procedure cannot create designs, assign Page Designs, change `__Renderings`/`__Final Renderings`, publish or advance workflow.
