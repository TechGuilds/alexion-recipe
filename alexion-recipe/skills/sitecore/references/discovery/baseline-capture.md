# Source baseline capture

Follow the authoritative [rendering preview flow](rendering-preview-flow.md).
Accept verified source identity, site, exact language, delivery database, device
and mode from Setup and the retained presentation inventory. Store raw evidence
outside the source checkout and installed skills. Static code analysis runs in
parallel; do not collect sitemap or homepage extras to seed mock files.

## Approved rendering and variant capture

1. Synthesis always writes a discovery-only draft. After the coordinator validates
   the user's included rendering scope through the current keyed scope decision,
   call native `buildRenderingCapturePlan(entries, { includedRenderingIds })` from
   `scripts/analysis/build-rendering-capture-plan.mjs` with those exact IDs and the
   current retained configuration-route entries. Retain a separate approved plan
   and its byte hash. Do not flip `draft`, manually recompute its fingerprint,
   invent a CLI for this module, or treat synthesis as scope approval.
2. Read [capture contracts](../../scripts/capture/README.md). Prepare a fresh
   attempt with `prepare-capture-request.mjs`, passing the approved plan file and
   verified source identity. Headless uses `fetch-layouts.mjs` with the selected
   source connector attached; its environment supplies credentials. MVC uses the
   prepared route plan with `capture-mock-layouts.ps1` through authenticated source
   SPE and `assemble-mvc-captures.mjs` for the retained serializer bundles.
   Preserve terminal remote job/request provenance and immutable raw bundles.
   Do not substitute Headless REST for the MVC serializer contract.
3. Omitted `maxUrls` or `0` means all selected pages. A positive `maxUrls` is one
   global attempt cap, including failures and retries across declared recovery
   attempts. It is not a per-group success limit. Plan mode has no implicit
   sitemap, extra homepage, existing-output reuse or unrelated routes. Use fresh
   output directories and preserve requested/attempted/succeeded/failed/skipped
   counts and per-page identity/status. A fatal validation or capability error
   before requests means zero executions; retain that diagnostic explicitly.
4. Run `process-capture-results.mjs` over the explicit result-manifest set and
   approved plan. Supply the exact mapping inventory file/hash when page-local
   instance UIDs are needed to prove Headless rendering identities. The processor
   verifies actual routes, item/rendering/variant IDs and file bytes; a component
   name or success response alone is insufficient. Retain placement/datasource/
   parameter warnings and `not-evaluated` comparisons as findings, not proof.
5. Recovery is explicit and bounded: correct one recognizable invocation defect
   or retry one terminal transient failure when safe; select only the processor's
   declared uncovered requirements/alternative pages within the remaining global
   budget. Retain every predecessor result and recovery selection. Never loop
   broad queries, fabricate a merged raw manifest or silently change the plan.
6. Attempt [reviewed local delivery](baseline-delivery.md) during requested
   Discovery preview after successful capture and applicable mapping review.
   Attach raw, processed and delivered evidence separately to synthesis/audit.
   Capture does not write the target app or target Sitecore instance.

Partial capture never establishes whole-site absence, unused renderings, source
parity or visual validation. Failed, skipped, unattempted and unverified routes
remain gaps; no empty payload, target data or invented fixture repairs a capture.
Unused definitions and unused variants remain mapping-only until explicitly
selected for approved synthetic examples, which never count as captured source.

## Core collection versus requested preview delivery

Actual capture and reviewed local delivery are required attempts when the user
requests Discovery mock preview. `not-requested`, `not-attempted`, `pending`,
`failed`, `partial`, `captured` and `delivered` are distinct. Optional runtime
errors do not block otherwise valid core content collection or draft synthesis.
They also do not establish that a requested preview was delivered. Audit must
retain the failed/unexecuted step and an explicit user deferral with an owner
before accepting closure with that deliverable gap. Do not silently move it to
Code Migration or call an unattempted capability unavailable.

## Separate bounded evidence operations

The normalized `export-layouts.ps1`, `export-dictionary.ps1` and
`export-richtext.ps1` remain supported for an explicitly scoped baseline or
diagnostic request. Compose executable remote bodies through
`prepare-request.mjs` and the authenticated source connector; retain terminal
manifests, raw bytes and hashes. `normalize-baseline.mjs` accepts explicit
raw-file/output mappings without rewriting raw responses. A focused
`sitecore-get-layout` with `source:"rest"` can diagnose an XP route; a schema
question can use `graphql-query`. These do not replace the approved-plan flow
or authorize broad unplanned capture.

MVC dictionary-domain capture uses `capture-mock-dictionary.ps1`; scoped
rendering/datasource rich-text structures use `export-richtext-structures.ps1`.
Export dictionary keys, domain, exact language, duplicate precedence and failed
locales when translation helpers are relevant. Preserve original rich text and
media/link references in evidence. Dictionary/rich-text/browser enrichment is
separate from rendering capture and does not manufacture missing page identity.
