# Local content transformation

## Inputs and execution

The coordinator assigns the transformation and supplies reviewed mapping/destination revisions, current target definitions and a complete prepared source snapshot. Transformation is local and does not contact Sitecore, change shared workflow, create target items or authorize later writes.

Create a request conforming to [transform-input.schema.json](../contracts/transform-input.schema.json):

```json
{
  "version": 1,
  "migrationInput": { "path": "migration-input.json", "sha256": "<SHA-256 of manifest bytes>" },
  "snapshotValidation": { "path": "snapshot-validation.json", "sha256": "<SHA-256 of validation request bytes>" }
}
```

Replace the illustrative hashes with actual lowercase SHA-256 values. All paths are relative to the selecting document and must stay below its directory without links or traversal. The migration manifest selects mapping, sourceSnapshot, targetInventory and destinationPlan, plus an optional previous identityMap. It must not select a previous itemPlan. The snapshot-validation request selects the same prepared source manifest and exact approved capture scope; see [source preparation](source-snapshot.md). Raw legacy snapshots must first pass through preparation so provenance and source-state identity are explicit.

From the skill's scripts directory, use the assigned paths:

```sh
node transform-content.mjs --input /workspace/transform-input.json --output /workspace/new-transformation
```

The output parent directory must exist; the destination must be new. Exit 0 means the local plan has no reported errors and is ready for review. Exit 2 means review artifacts were generated with blocking issues. Exit 1 means input, integrity, size, output validation or filesystem failure; incomplete output is not successful evidence. No flag submits a remote operation.

Before processing values the script verifies artifact hashes, schemas, cross-document relationships, source-state identity and required field/version/context coverage. It rechecks declared inputs before saving. Source records are streamed; only metadata indexes and the bounded generated plan retain data. Each generated JSON artifact is limited to 16 MiB. A larger transformation needs a smaller approved scope and a new prepared snapshot; do not silently drop items or concatenate snapshot parts.

## Transformation rules

- Apply `map`, `set` and `remove` by field ID. A source field cannot be both mapped and removed; mapping it to several distinct target fields is supported. Preserve raw strings, including empty values, and exact shared/unversioned/versioned storage. Missing values or sharing conversions are errors. Constants expand over captured versions using target storage.
- Mapped values need verified `fieldType` metadata matching the target type or an exact approved `destinationPlan.fieldCompatibility` decision. Each decision names source/target template and field IDs, verified `sourceType`/`targetType`, `decision: raw-compatible` and a review reason. It never converts a value or grants approval by itself. Missing metadata, changed types and unsupported conversions block. Existing untyped evidence may use a reviewed compatibility decision without recapturing content solely to add type metadata.
- Inherited fields belong on their mapped concrete item. They do not create base-template items. Distinct source items remain distinct even when their types map to one target type. Multiple writes to the same output field are conflicts.
- Resolve only `{sourceName}`, `{outputKey}` and `{targetPagePath}`. Unsafe source-name characters become hyphens; empty names and resolved collisions block. The transformer does not invent destination rules or add numeric suffixes.
- A page needs one unambiguous source-item page destination. A page's own split datasource can use that page; other page-local datasources require direct rendering evidence or explicit approved [ownership rules](ownership.md) with captured ancestor/reference proof or named source pages. Global source-item outputs are generated once across all consumers. Missing or conflicting ownership evidence blocks readiness.
- Parameter-derived content requires full page, occurrence UID, device, language and version context. A UID alone is not an item identity. Rules targeting parameters are listed as deferred to Presentation Composition, with the captured consuming occurrence; they never create parameter-template content items. Paths that collide across contexts need an approved mapping change.
- Folder rules generate ordered structural folder definitions with existing target folder-template IDs. Their segments must exactly supply the destination parent. Every parent requires an existing target item, planned content item or explicit structural folder. Missing parent templates are not guessed. Branch IDs alone do not describe child topology: branch expansion currently blocks with `branch-unsupported`.
- Stable UUIDv8 identities derive from migration scope, source and target instance, target database/root and logical source/output/context identity. They remain stable across mapping revisions for unchanged roles. Prior identity bindings are retained; a changed destination or conflicting target identity blocks. Planned IDs prove no target item was created.

## Output and downstream boundaries

| Artifact | Meaning |
| --- | --- |
| `item-plan.json` | Exact four input hashes, proposed content items, language/versions, parent paths, transformed fields, relationships, folder structures and issues. |
| `proposed-identity-map.json` | Proposed bindings for outputs without item conflicts. This is planning evidence, never a verified execution checkpoint. A non-ready report blocks the whole plan even if some bindings are present. |
| `transform-report.json` | Request/manifest/coverage and output plan/identity-map hashes, readiness, exclusions, deferred parameter mappings, reference dependencies and issues. |

The CLI returns the report plus SHA-256 descriptors for the item plan and proposed identity map. Identical inputs produce identical plan bytes, identities and report content; no timestamps or random IDs are added.

Plan actions are intentions. Supplied target identity evidence can suggest reuse/update, detect incompatible paths/templates and preserve existing IDs. Absence from an inventory does not establish nonexistence; `create` is a proposal. An existing item does not prove field equality or make `reuse` safe. Current target comparison, before-state fingerprints and batch ordering use the implemented [dry-run planner](dry-run.md) with verified supplied target evidence. Approval remains a coordinator decision.

References retain raw source values, reference kind and ordered source IDs in the dependency report. An approved reference rule selects an output role when a referenced item splits. Require one unambiguous output identity or an approved `destinationPlan.existingReferenceTargets` binding matching inventoried target content/media metadata. Missing/excluded targets, unbound external media and ambiguous splits block readiness. Planned relationships do not rewrite link XML or list GUIDs. The [reference resolver](reference-resolution.md) verifies actual target identities and rewrites supported formats for separately approved updates. Never apply raw source references as though they were target IDs.

Known target reference types (such as General Link, Image and Multilist) with nonempty mapped values require captured reference evidence. A nonempty constant for these fields also blocks because the current mapping format supplies no approved target-reference binding. Empty values remain explicit empty values. This check cannot prove reference completeness inside arbitrary text or unsupported custom field types; those need explicit Mapping/Discovery evidence.

Known reference kinds must also fit the target format: Image/File use media XML, General Link uses link XML, and list/single-reference fields use matching ordered GUID tokens with the required cardinality. Only conservative self-closing XML forms with valid characters/entities are accepted. A raw-compatible single/list mapping may preserve a one-GUID value when separately approved by type compatibility; no XML or list conversion is inferred. Incorrect kinds, malformed XML and mismatched reference IDs block even when a compatibility decision exists. Unsupported formats require another implemented adapter or conversion before readiness can be claimed.

Conflicts and missing parents are returned for review. This transformer cannot copy media binaries, expand branch definitions, assign presentation, provision SXA, compare current field values, write target items or publish. Review the plan through the coordinator before any continuation.

## Recovery

Keep the original source and outputs immutable. Retry a local failure into a fresh directory with the same declared input hashes. Mapping changes require a new manifest/revision and review; retain verified prior identity bindings rather than allocating replacement items blindly. Interrupted files do not authorize continuation. See [recovery](recovery.md) for target drift and remote-job safeguards.
