# Rendering inventory to mock preview

Use this runbook for the Sitecore profile's Discovery preview deliverable. It joins the native scripts; it does not add an MCP tool, change workflow state, approve scope, or migrate code/content. The coordinator owns sequencing and the remote-run ledger; workers return exact attempt paths and receipts.

This flow builds source-derived mock layouts and examples to validate component code and Discovery coverage. For the target-data preview of a proposed Headless SXA presentation composition, use [target-data preview and human review](../../../presentation-composition/references/preview.md) instead. The two are separate deliverables and their outputs are not interchangeable.

## 1. Confirm scope and collect once

Read verified Setup and current decisions: source connector, site/content root, database, language, devices/version scope, migration pair and repository identity. Before source collection, ask whether additional rendering definition paths are required. If **Yes**, request the absolute Sitecore paths and validate them; pass their JSON array string as `RenderingRootsJson` to the whole-site collector. If **No**, omit `RenderingRootsJson`; do not send `null`, an empty string or `[]`. Record the answer and actual paths in scope evidence. A retained explicit answer may be reused on resume; never inject a project's example paths.

`scripts/analysis/xp-discovery-v3.ps1` scans the scoped source content and processes all presentation renderings on each applicable item. Inferred rendering folders and configured roots supplement definition inventory, including unused definitions; they do not widen `SiteRootPath`. Requested content language remains exact. Structural rendering, folder and template lookup can retry English; this does not change content-language scope. Unresolved references are retained as warnings and completeness limitations, not a reason to discard otherwise valid collection. Fatal input, permission or export failures still require recovery.

The collector exports occurrence and variant evidence alongside existing reports. It explicitly reads the site's `Presentation/Rendering Variants`; do not claim every separate Headless Variants tree is enumerated. Observed variant selectors remain evidence. A separate headless variant structure needs a scoped, evidenced targeted read or an explicit limitation; `RenderingRootsJson` adds rendering definitions, not arbitrary variant roots.

Reuse matching terminal evidence through its manifest and hashes. A pending matching job must resume/wait on the same run ID; never submit a second capture because the first has not returned. Keep independent static repository analysis running without waiting for Layout Service. Sitecore rendering IDs and repository implementation candidates are different units: 42 observed rendering IDs and 21 code candidates are not 21 used renderings.

## 2. Synthesize full inventory, then authorize preview selection

Use the manifest adapter and `scripts/analysis/synthesize-discovery.mjs` from declared terminal inputs. Keep every source occurrence, item ID/path, parameters, placeholder, datasource and variant in `rendering-mapping-inventory.json`. This schema-2 file is the source handoff for mapping; a minimal preview plan must not replace it. `rendering-inventory.json` and `coverage-plan.json` remain evidence outputs. Old exports without occurrence evidence cannot certify complete component/variant coverage.

Synthesis's `rendering-capture-plan.json` is always **draft, discovery-only**. A draft is not executable permission. The owning workflow must retain a current explicit `kind: "scope"` decision for the exact source inventory/projection and included source rendering IDs, with actual `userResponse`, `at`, `scopeId` and input file hashes. Validate current bytes and decision binding using the CMS hub's existing decision/evidence rules. Reject revoked, conflicting, stale or narrower decisions; do not invent user approval.

There is no approved-plan CLI. Use the existing native API after that validation:

```js
// entries: current, hash-bound configuration-route evidence, not a URL list.
// includedRenderingIds: explicitly approved source IDs, never repository names.
const approvedPlan = buildRenderingCapturePlan(entries, {
  includedRenderingIds,
  evidenceWarnings,
});
```

Import `buildRenderingCapturePlan` from `scripts/analysis/build-rendering-capture-plan.mjs`. Supply the same normalized entries used by synthesis via `buildConfigurationRoutes` from `scripts/analysis/rendering-configurations.mjs`, with the declared source definitions and exported artifacts. Alternatively project the validated schema-2 mapping inventory's requirements into entries grouped by each occurrence's route/item ID/item path/language, preserving all page-local requirements and occurrences. Keep missing routes and `routeIssue` occurrences in `unplacedRequirements`; keep definition-only requirements distinct. Never guess routes from content paths, promote shared-design paths to pages, or filter using repository component counts. Retain that projection's bytes, source file hash and scope binding beside the new plan. A new projection has its own `sourceDiscoveryFingerprint`; do not copy the draft fingerprint. Write the returned plan to a fresh attempt path and validate its structure. Do not edit `draft`, `scope`, selected pages or fingerprints by hand. An explicitly approved empty ID array selects nothing.

The planner covers **rendering ID + variant ID**, using as few representative source pages as its bounded search can establish. Different text, images, datasources, placement, order and non-variant parameters do not add preview targets; their full evidence remains available for mapping. Different variants do add targets. All alternative page identities remain available. `minimumProven: false` means minimum count is not proven; report it honestly. Missing resolvable pages remain gaps. Unused definitions/variants remain mapping-only, not extra capture pages.

This scope decision permits only the requested bounded preview work. Workflow-plan approval, phase-continuation and code/content write approvals remain separate existing gates.

## 3. Capture selected pages once

Use `scripts/capture/prepare-capture-request.mjs --params <absolute-input.json> --output <fresh-request.json>`. Inputs include `mode: "headless"` or `"mvc"`, the approved `capturePlanFile` and a fresh `outputDir`; keep the result manifest outside the raw capture tree. Read the [capture contract](../../scripts/capture/README.md) for exact parameter schemas and commands.

In plan mode, omitted or zero `maxUrls` means all **selected** pages, not all source pages. A positive value is a global attempted-page budget, including failed attempts and declared recovery attempts; it is never per group. For a smoke test, `maxUrls: 1` captures at most one page overall and leaves remaining targets pending. For all selected pages use their count or omit the cap, with a separately agreed recovery budget. Discovery enumeration itself has no 25-page preview limit. Plan mode adds no homepage, sitemap enumeration or cached directory files. Legacy direct/sitemap mode retains its old default; use it only for an explicitly scoped diagnostic, not this flow.

- **Headless:** pass the prepared request to `scripts/capture/fetch-layouts.mjs --params <request.json>`. Resolve source authentication from the connector's scoped credentials; secrets stay out of JSON/evidence. Layout Service returns full page JSON, not a rendering definition report.
- **MVC:** submit the native `capture-mock-layouts` operation through `scripts/prepare-request.mjs` and the authenticated source SPE connector. Pass verified `sitePath`, `siteName`, `language` and the prepared `selection: "discovery-plan"`, `capturePlanFingerprint`, exact `routePlan` and budget. The preparer does not carry `sitePath` for you. Local output paths are not remote Sitecore paths. Retain the exact terminal export, manifest, hashes and raw bundles; use `scripts/capture/assemble-mvc-captures.mjs` to create common captures. Preserve nested placeholders and source identities.

Record request, run ID, pending/terminal status and output paths. A timeout or lost response is not permission to resubmit. Apply the generic bounded-retry policy; return pending/failed evidence and the next owner when connectivity prevents completion.

## 4. Report differences and recover within budget

Run `scripts/capture/process-capture-results.mjs --params <absolute-input.json>` with the current plan, **all** lineage `captureResultFiles`, the current source `mappingInventoryFile` and exact `mappingInventorySha256`, and a fresh report `outputDir`. The mapping inventory proves page-local rendering UIDs when runtime JSON lacks rendering IDs. Retain `maxUrls`/overall budget and explicit `maxAlternativePages`/`maxAlternativesPerRequirement` limits. Reporting performs no network calls.

`rendering-coverage-report.json` preserves attempts and diagnostic differences. HTTP/transport failures are capture failures; configuration differences are warnings with expected/observed evidence, not proof of failed implementation. Unattempted targets remain pending. A source master presentation differing from published web delivery can explain missing placeholders/components; show the difference rather than hiding it or changing the delivery database silently. Do not infer content defects without evidence.

If produced, `next-capture-request.json` proposes bounded alternative pages. The coordinator checks pending jobs and remaining budget, supplies the same endpoint/site credentials and fresh paths, and dispatches that request once. Preserve its `capturePages`, `totalMaxUrls`, previous receipts and mapping proof; do not reset the total budget. Re-run reporting with every receipt. Exhausted alternatives remain visible gaps, not synthetic successes.

## 5. Mapping and explicitly selected unused examples

Give the mapping developer `rendering-mapping-inventory.json` and its exact source identity/hash. It contains summarized renderings plus exhaustive configurations/occurrences, templates, placeholders, variants and completeness. `rendering-capture-plan.json` selects examples; it is not the mapping catalog. See [mapping scripts](../../scripts/mapping/README.md).

Target discovery is a separate scoped connector read. Confirm target identity and actual rendering/template/placeholder paths; import retained results with `scripts/mapping/create-target-inventory.mjs`. A successful empty inventory is valid for an empty target. Failed/partial lookup is not evidence of an empty target; the importer does not perform an automatic whole-target scan or prove variant/usage completeness. No names-only match grants reuse approval.

The separately implemented mapping experience supplies reviewed `reuse-target`, `implement-missing` or `disregard` decisions. `scripts/mapping/build-component-migration-plan.mjs` requires exact current source, target, mapping-manifest and decisions hashes; optional coverage evidence must be bound too. A whole-manifest `kind: "mapping"` approval needs its actual user response/time and matching inputs, without narrower task/entity scope. A `confirmed` boolean is insufficient. Unapproved mappings stay `mapping-required`; filesystem consumers re-read current approval and rebuild the plan.

`scripts/mapping/apply-component-mappings.mjs` derives `mapped-layout.json` and `mapping-result.json`; raw captures remain immutable. Map source `header/main/footer` to target `headless-header/headless-main/headless-footer` through reviewed `placeholderMap` rules in that derived copy. Preserve nested/dynamic relationships; unsupported cross-container moves require an explicit target composition, not blind string replacement or edits to scaffold placeholder names.

Unused definitions/variants are flagged for mapping decisions only. After explicit migration selection and current approved mapping, run `scripts/capture/build-component-examples.mjs` with selected requirement keys and explicit fixture/dependency evidence. No automatic examples for every unused definition. `fixture-required`, `dependency-required` and `layout-ready` describe preparation states; `synthetic: true` and pending visual validation remain visible. Neither a fixture nor a mapping proves implementation or visual approval.

## 6. Stage and deliver preview files

Run `scripts/preview/prepare-preview-navigation.mjs --params <absolute-input.json>` with the current plan file/hash, all explicit capture-result manifests and their hashes, including every recovery predecessor even when all its pages failed, optional current mapping-result paths/hashes and selected component-example manifests/hashes. It verifies the full lineage, identities and current approvals, selects successful outcomes, then stages a fresh tree:

- `public/mock-layouts/<exact-route>/index.json`, with `home/index.json` for the root route;
- `public/mock-preview/routes.json` and removable `navigation.js`;
- `deployment-manifest.json`, binding the exact input files and staged bytes.

Preserve route case and suffix identity and use one language per preview tree. No directory crawl, added sitemap pages or automatic stale-file cleanup. Old app files are preserved but excluded from the refreshed navigation index; report extras rather than deleting them implicitly.

For a compatible SitecoreAI scaffold, pass the stage and exact deployment-manifest SHA256 to the shared `sitecore-headless-to-xmc/scripts/scaffold-mock-service.mjs` using `--preview-stage` and `--preview-stage-sha256`. First use `--dry-run`, review the declared files, then use the existing `--apply`/per-file overwrite-before-hash procedure. Follow [preview readiness](../../../cms-migration/references/profiles/sitecore/pipeline/preview-readiness.md). Installation uses the task's confirmed app root and current evidence, not a repo-wide search. Retain the dry-run/apply receipts. Existing environment values are preserved; enabling mock mode is explicit. An unsupported root layout or disabled loader remains a reported gap.

Navigation links select the captured app routes; the loader reads their mock JSON. A registered implementation renders normally; missing-component boxes require the app's supported fallback and reachable placeholder tree. Assets alone do not prove the loader, nested components or browser preview works. Shared SitecoreAI scaffolding supports either source flavor; XP/JSS needs its evidenced loader integration, not an assumed Content SDK installation.

## 7. Close Discovery honestly

When preview capture/delivery is requested, attempt it and report the actual selection, attempted/succeeded/failed/unattempted counts, warnings, delivered routes/files, hashes and remaining owner. Do not silently skip it as optional enrichment and report the preview delivered. If blocked or deliberately deferred, record that explicit scope/defer decision, reason, evidence and owner before closing the requested deliverable. Valid inventory collection can remain successful with partial preview evidence; the overall requested preview is still incomplete until delivered or explicitly deferred.

Do not start code/content migration, a development server or target writes merely to close Discovery. Follow the existing audit, workflow-plan approval, synchronization and phase-continuation gates. Later preview-foundation/testing work verifies the running app and visual behavior. Schema validation is not scope approval, implementation proof or browser evidence.
