# Approved datasource ownership

Direct page/rendering ownership remains the default: a page owns its own split outputs, and captured rendering occurrences identify directly consumed datasources. A global source-item output is produced once across its consumers. Hierarchy alone does not authorize copying a descendant beneath a target page.

For nested or reference-linked page-local items, Mapping may supply `destinationPlan.ownershipRules`. These rules are part of the approved destination revision and its hash, not a separate approval store. Each source item can have only one rule:

| `via` | Required source evidence | Behavior |
| --- | --- | --- |
| `source-ancestor` | `sourceItemId`, `ancestorItemId`, and the complete captured parent-ID chain between them | Resolve the named ancestor's consuming pages through direct rendering evidence or another explicit ownership rule. |
| `source-reference` | `sourceItemId`, `ownerItemId`, `fieldId`, and a supported captured reference from that owner's exact field to the source item | Resolve the owner's consuming pages. Raw GUID-looking text alone is insufficient proof. |
| `explicit-pages` | `sourceItemId` and nonempty `pageIds` naming captured, included source pages with supported target-page destinations | Use exactly those approved consuming pages. These are source page IDs, not target IDs. |

For example, the following illustrative rule assigns a nested slide to the consuming pages of its captured ancestor datasource:

```json
{
  "sourceItemId": "{00000000-0000-4000-8000-000000000077}",
  "via": "source-ancestor",
  "ancestorItemId": "{00000000-0000-4000-8000-000000000011}"
}
```

Replace example IDs using Discovery evidence. The ancestor must actually be an ancestor in the captured parent chain; matching paths/names are not proof. Multiple consumers yield one output per page only when the destination uses page-local scope and source-item-and-page identity. Existing global outputs retain their global sharing.

The source scope must capture all hierarchy nodes and reference fields needed to prove the rule, even when their content is not otherwise transferred. Metadata-only hierarchy records may have no field values; structural-only source items still need an explicit exclusion or supported mapping. Missing ancestors, references or pages return bounded evidence/mapping gaps. The transformer does not broaden Discovery or infer rules from folder names.

Cycles, repeated rules, missing proof, excluded consuming pages and disagreement between an explicit rule and direct rendering ownership block readiness. A rule cannot silently remove a directly observed consumer. If that scope must change, review the Discovery/presentation scope and mappings first. Approved named pages can establish ownership where direct evidence is absent, but cannot contradict evidence that is present.

These rules determine item identity and destination planning; they do not assign presentation. A globally shared target owner that references different page-local children still requires an approved split or another unambiguous reference rule. Ownership rules cannot make a global reference vary silently by page. Branch expansion remains unavailable without child-topology evidence.
