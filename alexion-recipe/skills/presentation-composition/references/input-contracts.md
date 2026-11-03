# Input contracts and evidence

`contracts/definitions.schema.json` is the strict version-1 authority for normalized evidence and request documents. The companion TypeScript interfaces document CLI request shapes. Do not alter the original `mapped-content-migration/contracts/sitecore-mapping.ts` or its mapping format.

All request descriptors are `{path,sha256}` relative to the selecting document. Hash exact bytes, use clean relative paths, and retain immutable artifacts. Linked or escaping inputs are rejected. JSON inputs/outputs are capped at 16 MiB; reduce scope rather than truncate. Preview output has a 64 MiB aggregate limit. These are local evidence contracts, not authentication or authorization mechanisms.

## Composition request

Supply `version: 1`, `scopeId`, and descriptors named `source`, `target`, `mapping`, `rules`, `identities`, `targetData`, `mappingApproval`.

| Document | Required information |
| --- | --- |
| `source` | Instance/database/site, captured state ID, language/version/device, hashed evidence, template defaults, inspected `partialDesigns` with occurrence UIDs, effective page occurrences, override UIDs and complete expanded SXA evidence. |
| `target` | Matching target identity/context/state, existing templates and their own Standard Values defaults, layouts, actual rendering/component names, datasource template compatibility, effective parameter fields, exact placeholders/allowed owners, and existing Partial/Page Design definitions. |
| `mapping` | Original approved template/field, rendering and placeholder mappings. Text warnings remain descriptive only. |
| `rules` | Page bindings/routes, target layout/design choices, explicit preserve/replace defaults policy, reviewed default removals, Partial Design membership, occurrence-specific choices/exclusions/output roles and complete required rendering/variant coverage. |
| `identities` | Verified content handoff with source/output/page/occurrence identity, actual target IDs, scope and hashed verification evidence. Proposed transformation IDs are not verified bindings. |
| `targetData` | Actual target-derived field data for the exact site/language/version/device/state; capture/expiry times and hashed read evidence; target item IDs/templates/paths/names and structured Layout Service fields. Exact resolver output is separate. |
| `mappingApproval` | Existing `kind: mapping`, `choice: approve` decision for this scope, actual user response/time, and `inputs` binding at least the current mapping and rules. Other declared inputs must also belong to this request. |

Use explicit page rules when source templates split into several target templates. Rendering mapping groups with several targets need an approved occurrence choice. Many source rendering definitions mapping to one component preserve individual occurrences. Dynamic placeholder keys require exact resolved mappings or reviewed occurrence overrides; no suffix/UID rewriting is guessed.

## Source normalization

Discovery remains the owner of source capture. The composer does not parse raw Sitecore presentation XML deltas or pretend that raw inspector output is a complete effective presentation. Preserve the original files under each document's hashed `evidence` descriptors. Normalize only fields actually established by the scoped reads: actual UIDs, IDs, order, resolved datasource IDs, parameter field-ID values, parent UIDs, and origin/owner identities.

`source.pages[].effective` is the observed effective presentation after defaults, overrides and source design dependencies. `effectiveComplete`, `defaultEvidenceComplete` and `sxaExpanded` must describe verified reads. Template defaults and override UIDs remain provenance; the composer does not reapply them and accidentally duplicate removed/replaced occurrences. Missing SXA dependency expansion requires further scoped inspection by its owner. The existing `inspect-presentation.ps1` deliberately reports its expansion limitation and cannot alone satisfy this handoff.

The input is one site/language/item-version/device context; use separate requests and previews for additional contexts. Language/version conversion is not inferred. Target template defaults must have `standardValuesOnly: true` and must exclude effective Page/Partial Design expansion to prevent double composition.

## Target field and resolver data

`targetData.format` is `target-layout-fields`. Item `fields` must be structured target Layout Service/GraphQL JSON field values, not source values or invented placeholder strings. Retain the actual capture behind `evidence`. Field projection is allowed only when the target definition explicitly declares `dataMode: fields` and `dataSource: page`, `datasource` or `none`. Inspect each component's real contract; a custom resolver is not equivalent to copying datasource fields.

For `dataMode: resolver`, `resolverData` must match target page ID, proposed rendering UID, rendering ID, datasource ID and `parametersSha256`. The hash uses sorted-key canonical parameter JSON without whitespace. A missing exact result produces a target-read requirement and blocks preview. Obtain it only through a confirmed read mechanism/adapter. If the connector cannot supply the required resolver data before target presentation exists, report the missing capability; do not attach presentation temporarily or fabricate a response.

Parameter mappings use captured source parameter-template IDs/field IDs and actual target parameter definitions. String values are mapped without inferred conversion; constants/removals require the original approved mapping. An explicit occurrence parameter override must name a declared target field. Reference-bearing parameter types require an exact value in the field's captured `allowedValues`; no source GUID rewriting is inferred. Refresh target choice/reference evidence or obtain an explicit compatible mapping rather than preserving an invalid source ID. Parameter-to-datasource mappings need an independently migrated target value plus actual field-ID/name and template/base-template metadata; composition never writes or fabricates that content.

Content identities must select one matching output. Page-local identity can include source page/UID; global bindings omit them. Use `outputKey` for splits. `datasourceSourceId` explicitly selects a different captured source identity when the datasource was generated from a page/occurrence split. Missing or ambiguous bindings, missing current target items or incompatible templates block composition.

## Design planning

Rules declare proposed keys/names; `reuseId` must identify an inventoried compatible target design. Source design IDs are not copied as target design IDs. Shared Partial Designs must have consistent target rendering content across consumers; differing local datasource IDs or parameters require a reviewed separate-design choice. Nested parent and child occurrences must belong to the same presentation owner. Proposed template associations cannot disagree for the same target template. Page-specific association proposals remain separate and require the eventual target executor's capability checks.

Supplied normalized evidence is not itself proof that a live collector was executed. Verify its capture provenance through the owning Discovery/content task before assignment. The scripts validate shapes, fingerprints and documented semantics; they do not authenticate remote providers.
