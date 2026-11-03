# Input and output contracts

## Status and boundary

These contracts define the documents consumed and produced by mapping-based Content Migration. Read the [skill](../SKILL.md), [execution runbook](execution.md), [recovery rules](recovery.md) and [script inventory](../scripts/README.md) for operation gates and available capabilities. Setup, Discovery and Mapping must supply the required information in these shapes or through a validated adapter. Existing discovery reports must not be relabeled as complete content snapshots without checking their contents and coverage.

All companion documents carry `version: 1` and a common `scopeId`. The raw mapping has no version field; `mappingRevision` is supplied by the input manifest. Unsupported versions and unknown properties fail structural validation. Keep credentials with connectors rather than in these documents; successful validation does not prove that arbitrary content values are free of secrets.

## Documents and ownership

| File | Producer | Consumer and purpose |
| --- | --- | --- |
| `migration-input.json` | Content Migration coordinator | Selects the exact artifacts by relative path and SHA-256. Carries scope and mapping revision. |
| `sitecore-mapping.json` | Mapping phase | Describes template/field, rendering and placeholder correspondence using the mapping interface. |
| `source-snapshot.json` | Source preparation/capture | Legacy snapshot or a manifest referencing bounded JSONL parts. Reuses verified values and captures gaps for the approved source state; reused across migration batches. |
| `target-inventory.json` | Target Discovery adapter | Verified effective target fields, templates, rendering/placeholder definitions and known destination items. Contains evidence, not invented defaults. |
| `destination-plan.json` | Mapping and Destination Planning | Specifies output roles, item locations, identity, sharing, explicit folders, collisions and reference selection for splits; branch rules remain non-executable. |
| `item-plan.json` (optional for input validation) | Transformer | Target item definitions, proposed actions and relationships. Input hashes bind it to the exact files used. It is a plan, not an execution result. |
| `identity-map.json` (optional for input validation) | Executor/checkpoint owner | Stable source/output/context to target ID/path bindings. It records identity, not proof of a successful write or approval. |

Approval records remain in the coordinator-managed decisions mechanism described by the [shared task and evidence contracts](../../cms-migration/references/executable-contracts.md). Before target writes, approval must bind the reviewed plan hash, scope, target identity and selected batches. If that mechanism or the required record is unavailable, execution is blocked. `valid: true` from this validator means its implemented structural and cross-file checks passed; it does not mean source capture is complete, mapping is approved, the target is fresh, or a plan is executable.

## Mapping semantics

- Resolve fields by `sfid`/`tfid`, not display names. Every non-removed target field must have a single declaring template and belong to exactly one mapped target item template, including through a base template. A base template is field ownership evidence, not a separate content item to create.
- `map`, `set` and `remove` are the supported field actions. General conversion expressions are not defined by the format; reject unknown actions. Operations outside this contract require an explicitly supported version rather than executable free text.
- Several source types using one target template normally produce separate target items. Version 1 does not consolidate distinct source content items; target identity/path collisions block.
- One source type can describe several target items through distinct `target[]` entries and destination rules. Version 1 allows one output role per source/target template pair. Repeated outputs of the same target template are unsupported by this contract and must be reported rather than inferred.
- Mapping warnings are displayed as descriptive notes. They cannot define paths, relationships, parameter conversions or approvals.
- Renderings/placeholders are validated as mapping evidence only. Applying presentation belongs to Presentation Composition.

## Source snapshot

For large scopes, use `snapshot-manifest.schema.json`: it references hashed JSONL parts containing `snapshot-record.schema.json` item/context records. Each part declares actual byte and record counts. Defaults are 4 MiB and 200 records; configurable hard ceilings are 8 MiB and 1,000 records. A single record must fit the selected byte limit. `preparedAt`, original capture provenance and `sourceStateId` distinguish local assembly from source freshness. The `complete` flag must agree with coverage, not just file integrity. Read [source preparation](source-snapshot.md) for adapters, approvals, request generation and resume.

`prepare-source-input.schema.json` declares exact item/field/version/context requirements and available evidence. The local preparer emits a snapshot manifest, coverage report and bounded requests for gaps without contacting Sitecore. `validate-snapshot-input.schema.json` binds that snapshot to the approved scope for coverage verification. Both complete and partial snapshots can be reused; partial coverage cannot satisfy capture completion.

The older single-document snapshot remains supported as an evidence input and by input validation, with a 16 MiB read limit. Only a partitioned manifest carries the confirmed source-state and coverage metadata needed by the coverage command. Content readers use incremental parts and retain identity/version/context indexes rather than all field values. Index memory still grows with record count.

Values remain raw strings, including empty strings and Sitecore XML field values. Each item carries exact captured language/version tuples. A shared field has no language/version selector; an unversioned field has language only; a versioned field has both. Field arrays must not duplicate the same field/scope tuple. Source capture must distinguish inherited/effective values and explicit empty values; absence is not interpreted as an empty string.

`rootPaths` includes all captured source content and shared-data roots. `parentId` can refer to a parent outside this bounded snapshot; it is not an instruction to create that parent. `references` preserves referenced source IDs and list order, including unresolved dependencies. The reference resolver must report missing targets or bind them through approved external-reference decisions, never silently discard them.

`renderingInstances` carries the selected page/device/language/version/occurrence context and parameter values. It supplies the context needed when a mapping moves a rendering parameter into a datasource field. It does not replace the complete presentation evidence collected by Discovery. When two rendering occurrences share a datasource but supply conflicting values, transformation requires an explicitly approved occurrence-specific output rule; otherwise report a conflict. Never silently overwrite the shared datasource.

The validator checks document shapes and selected relationships. It does not establish full required-field coverage, value/type conversion correctness, reference completeness, capture coverage or target freshness. Those are acceptance requirements for the corresponding capture, transformation, planning and execution operations.

## Target evidence

`templates[].fields` contains effective own and inherited fields, their declaring IDs, types and sharing mode. `baseTemplateIds` contains transitive ancestry. Folder templates and branch-definition metadata can be listed explicitly with `kind: folder` or `kind: branch`. Content Migration uses existing content/folder templates; the presence of branch metadata does not enable branch expansion. `items` is a bounded inventory of existing destinations, not a whole-instance scan or proof of full target absence. Planning requires current evidence for each proposed create/update/reuse decision.

## Destination and identity rules

Every mapped source/target template pair has one explicit rule. Stable `outputKey` values identify roles such as `page`, `banner-data` or `brand-data`; they are not runtime-generated names.

| Identity | Required context | Intended use |
| --- | --- | --- |
| `source-item` | Source item ID and output key | Shared/global item or a primary page. Multiple consumers reuse the same binding. |
| `source-item-and-page` | Source item ID, output key and consuming source page ID | A page-local copy. |
| `rendering-instance` | Source item/parameter occurrence ID, output key, source page ID, occurrence UID, device, language and version | Explicit occurrence-specific data when parameter differences require it. Different scoped occurrences cannot silently merge. |

Executable local datasource plans require a `{targetPagePath}/...` pattern and approved explicit folder rules where parent folders must be created. The contract also accepts a branch rule for validation, but the transformer blocks it with `branch-unsupported`. Global outputs cannot depend on a consuming page. Parameter rules use `kind: parameters`, rendering-instance scope and identity, and have no item/folder path: rendering parameters are values, not ordinary datasource items. This contract does not define a separate parameter-output artifact. Retain the snapshot parameter context and approved mappings for Presentation Composition; do not insert parameter records into `item-plan.items`.

Item patterns support only `{targetPagePath}`, `{sourceName}` and `{outputKey}`. The validator checks pattern syntax using sample token substitutions; it does not compute actual item destinations. Transformation must sanitize source names, derive parents, expand actual paths and check collisions within `targetRootPath`. No expressions, environment substitutions or arbitrary code are allowed. Folder rules list ordered segment names and existing folder-template IDs. Branch rules name an existing branch definition but do not describe its child topology. They are not executable: the transformer returns `branch-unsupported` before target writes. Return the rule for mapping/destination review; do not silently convert it into folder rules. To proceed, obtain approval for explicit content/folder definitions and regenerate the plan.

`existingItem` is `create-only`, `reuse` or `update`. It is intent, not evidence: existence, template compatibility, before-state values and approval are rechecked by the planner/executor. Version 1 uses `collision: block`; there is no automatic rename, overwrite or item merge.

Optional `destinationPlan.existingReferenceTargets` contains approved `{sourceItemId,targetItemId,targetPath,templateId}` bindings for read-only existing media/content targets. Each must match exact target inventory metadata and fresh `existingTargetState` observations with `rootPath: /sitecore`. They authorize reference selection only, never binaries or outside-scope content transfer. See [reference resolution](reference-resolution.md).

`referenceRules` selects the output role of a referenced source item when it splits. Its source template/field identify the referencing field; its `targetOutputKey` selects the referenced item's output. The resolver must verify this role on each actual referenced item and report ambiguities. Exclusions identify source item IDs and require reasons; field exclusions remain `action: remove` in the mapping.

## Output handoff

Destination plans may include exact `fieldCompatibility` decisions and [ownership rules](ownership.md). Compatibility records approve raw value preservation for named field/type pairs; they never implement conversions. Ownership records select one ancestor, reference owner or named set of source pages per source item. Source capture includes optional `fieldType` metadata, required by transformation unless a valid compatibility decision supplies the reviewed type basis. Contradictory map/remove actions are invalid.

After transformation, the [dry-run planner](dry-run.md) compares the selected item plan against explicit target lookup/field/version observations. Its separate batch-plan contract adds before-state preconditions and ordered operations without changing the item-plan contract or supplying execution approval. Missing evidence is reported for bounded collection; it is never inferred from absent Discovery records.

The implemented [local transformer](transformation.md) consumes a hash-bound transformation request and complete prepared source coverage. Generated plans include captured `versions`, explicit `parentPath` and structural folder definitions in `structures`. These additions are optional for older contract consumers. Folder structures use existing target folder templates; branch rules stay blocked (see [operational boundaries](operational-boundaries.md#supported-and-excluded-work)).

The `item-plan` binds exact input file hashes. Each output item records a stable identity, existing target template, create/update/reuse/exclude/conflict classification, scoped fields and relationships to target identities. The contract describes output values; it does not include target before-images, executable batch definitions or backup records. Those must be supplied by a supported execution mechanism before writes. Empty `items` is structurally valid but does not prove that an empty/excluded scope is justified. Error issues or conflicts prevent execution even when the contract is structurally valid.

One source item may have several identity-map entries with different output roles. Two distinct entries cannot silently claim the same target ID/path. Execution requires separate records for identity bindings and actual write results; a preallocated target ID does not prove existence. Changed mapping revisions require explicit reconciliation rather than throwing away old identities and recreating items. Presentation Composition requires verified identity bindings and their read-back evidence; it must not infer datasource identities from names.

## Local validation

On Kajoo, read the skill to stage its resources and use its exact advertised `scripts/` path. The validator dependency is bundled, so no package installation or Kajoo code checkout is required. Use the platform Node runtime with the actual task-provided input path:

```sh
node validate-inputs.mjs --input ../tests/fixtures/migration-input.json
node validate-inputs.mjs --input ../tests/fixtures/migration-input-partitioned.json
node validate-snapshot.mjs --input ../tests/fixtures/snapshot-validation.json
```

The CLI reads only the manifest and named relative artifacts, checks SHA-256, rejects traversal and linked artifact files, validates schemas and cross-file identities, and prints JSON to stdout. It never writes files, calls Sitecore, changes a mapping or supplies approval. Exit 0 means those checks passed; exit 1 means input/contract errors. `--apply` and unknown flags are rejected. Absolute paths are accepted for the manifest itself; artifact paths must remain below its directory.

Companion fixtures demonstrate a Product Page split, inherited fields, global banner data, page-local folder rules, rendering parameter context, proposed items and identity bindings. All companion evidence is synthetic; field types, IDs and values are illustrative. The mapping fixture demonstrates format and relationships, not project-specific mapping decisions. Maintainers regenerate them with `tests/fixture-factory.mjs`; normal validation and tests never rewrite inputs.
