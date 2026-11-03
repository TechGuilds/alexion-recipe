# Source-to-target mapping and unused examples

These portable Node scripts prepare local evidence. They do not build a mapping UI,
scan a target instance, mutate Sitecore, implement components, or publish an app.
Credentials belong to connectors and must never be included in JSON inputs.

## Inputs and flow

1. Give the mapping experience the source `rendering-mapping-inventory.json` from
   discovery. It contains all rendering definitions, configurations, variants,
   usage, placeholders, dependencies and occurrences. Preserve `unknown` usage;
   absence from an incomplete scan is not proof a rendering is unused.
2. Obtain target definitions with the target connector's existing read operations.
   Supply an explicit target identity and inventory; an empty target is an explicit
   successful inventory with `renderings:[]`, not a failed lookup.
3. Normalize that inventory with `create-target-inventory.mjs`. Review source and
   target side by side, then supply explicit mapping decisions. No name-based match
   is accepted automatically.
4. Run `build-component-migration-plan.mjs`. Missing or unapproved decisions remain
   `mapping-required`. A confirmed boolean alone does not grant user approval.
5. If unused definitions/variants were selected for migration, explicitly select
   their requirement keys for `capture/build-component-examples.mjs`. No fixtures
   are generated merely because an unused definition exists.

The source file can be used as-is by the UI developer. The target normalizer accepts
`targetInstance`, optional `siteName`, and `renderings` containing `renderingId`,
`componentName`, `path`, optional `datasourceTemplateId`, and field, parameter and
placeholder name arrays. The target connector/adapter is responsible for supplying
that read-only inventory; these scripts do not guess target roots or certify that
an agent-selected scope covers the whole target.

## Native commands

Pass absolute paths and actual SHA256 hashes of the exact input bytes. All output
directories must be fresh; input files remain immutable.

```sh
node scripts/mapping/create-target-inventory.mjs --input /evidence/target-input.json --input-sha256 <sha256> --output-dir /evidence/target-normalized
node scripts/mapping/build-component-migration-plan.mjs --source /evidence/rendering-mapping-inventory.json --source-sha256 <sha256> --target /evidence/target-normalized/target-rendering-inventory.json --target-sha256 <sha256> --manifest /evidence/component-mappings.json --manifest-sha256 <sha256> --decisions /evidence/decisions.json --decisions-sha256 <sha256> --output-dir /evidence/mapping-plan
```

The mapping manifest binds the source inventory's fingerprint and the normalized
`targetInventoryFingerprint`. Each decision identifies a source rendering and,
optionally, a source configuration. `reuse-target` requires the exact inventoried
target ID/name; `implement-missing` carries no target reuse rules. Missing mappings
remain visible. An explicit disregard decision records the exclusion rather than
claiming implementation or verification.

Approval uses existing v3 keyed decisions: `kind:"mapping"`,
`scopeId:"component-mappings"`, `choice:"approve"`, rationale, actual `userResponse`,
valid `at`, and `inputs:[{path,sha256}]` for the exact source, target and mapping
manifest files. When a coverage report is supplied, bind that file too. Stale or
conflicting decisions do not authorize a current plan. Retain the decisions file
and all referenced bytes; filesystem consumers re-read that file and rebuild the
plan to reject stale or revoked approval. Whole-manifest approval cannot carry a
narrower `entityId` or `taskId`; a generated plan is not a substitute for user approval.

Optional `--coverage <file> --coverage-sha256 <hash>` preserves capture results in
the migration plan. Mapping a component does not upgrade its capture, implementation
or visual-verification status. Unused definitions and unused variants stay visible
in the plan even when there is no page example.

## Transformations and examples

The native mapped-rendering helper applies reviewed field, rendering parameter,
placeholder and datasource rules to derived rendering objects. Source data is not
changed. For a captured page, run `apply-component-mappings.mjs --params <file>`
with `mappingPlanFile`, `mappingPlanSha256`, `layoutFile`, `layoutSha256`, exact
source `route`, and a fresh `outputDir`. It revalidates all reviewed inputs and
current decisions, then writes `mapped-layout.json` and `mapping-result.json`.
Stable rendering/configuration identity and a matching page-local occurrence are
required; a component name alone cannot authorize reuse. Unmapped components remain
in the copy with warnings. Cross-container reparenting needs an explicit target
composition and is rejected by this helper. Collisions are errors, and an explicit target variant replaces source
variant selectors consistently. This prepares mappings for later migration code;
it does not automatically rewrite or deploy captured page baselines.

Run the explicit example builder after mapping approval:

```sh
node scripts/capture/build-component-examples.mjs --params /evidence/example-params.json
```

```json
{
  "sourceInventoryFile": "/evidence/rendering-mapping-inventory.json",
  "sourceInventorySha256": "<exact source file SHA256>",
  "mappingPlanFile": "/evidence/mapping-plan/component-migration-plan.json",
  "mappingPlanSha256": "<exact plan file SHA256>",
  "selectedRequirementKeys": ["<unused definition or variant requirement key>"],
  "fixtures": [{
    "requirementKey": "<same requirement key>",
    "fields": {"Title": {"value": "Representative sample"}},
    "placeholder": "main",
    "unresolvedDependencies": []
  }],
  "outputDir": "/evidence/selected-examples"
}
```

The builder verifies current plan provenance before writing `component-examples.json`
and selected layout files. No selection means no implicit expansion to all definitions.

Synthetic examples have deterministic routes under `__migration_examples`, retain
source IDs/configurations, and are labelled `synthetic:true` and
`visualValidation:"pending"`. Their states are:

- `fixture-required`: representative data is missing.
- `dependency-required`: the fixture declares unresolved runtime dependencies.
- `layout-ready`: the supplied synthetic data can be used for a preview attempt.

None of these proves that a component is implemented, matches the source visually,
or has passed human verification. A reused target component can be shown with its
approved mappings; a missing implementation remains a preview/implementation task.
Only deliver selected derived examples to the app during the later scaffold and
preview integration step. Do not mix synthetic examples into real capture coverage.

The mapping UI, live target discovery automation, generic schema updates, navigation,
workflow/agent instructions and recipe publication are separate numbered work items.
