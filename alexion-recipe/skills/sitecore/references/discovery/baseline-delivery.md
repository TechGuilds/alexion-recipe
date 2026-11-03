# Delivering the captured baseline to the target app

Follow [rendering preview flow](rendering-preview-flow.md) after
[baseline capture](baseline-capture.md). Capture, approved mapping, local staging,
app installation and browser verification are separate evidence boundaries.
Requested Discovery preview requires the capture and reviewed local delivery
attempt during Discovery; a missing deliverable needs an explicit deferral and
owner. Optional runtime failure does not erase valid core content evidence.
The app must exist first; use `roots.app` and verified target context from
[target app initialization](../setup/target-app-init.md).

## Mapping and explicit examples

Use [mapping contracts](../../scripts/mapping/README.md). Supply the source
`rendering-mapping-inventory.json` and an explicitly read target rendering
inventory. Validate each Sitecore-specific artifact's own schema through
[artifact contracts](../../assets/contracts/README.md): source mapping inventory
uses schema version 2; target rendering inventory and applicable mapping/preview
outputs use `schemaVersion:1`. The generic CMS inventory remains a separate
contract. A successful empty target (`renderings:[]`) is distinct from a
failed or unavailable read. Normalize with `create-target-inventory.mjs`; never
infer name-based reuse or fill a read failure with an empty inventory.

Review mappings against the current source and target inventory fingerprints.
Record a keyed `mapping` approval for `scopeId:"component-mappings"`, binding
the exact current source, target, mapping manifest and any supplied coverage
file hashes. Build the native migration plan only from that reviewed decision.
`apply-component-mappings.mjs` revalidates it and produces a derived layout copy;
raw captured layouts stay immutable. A changed/revoked decision invalidates its
dependent derived files. Mapping does not prove capture or implementation.

Unused definitions and unused variants stay mapping-only unless explicitly
selected for `build-component-examples.mjs` with approved mappings and supplied
representative fixture data. Keep `fixture-required`, `dependency-required` and
`layout-ready` separate. Synthetic examples retain `synthetic:true` and pending
visual validation; they never count as real captures or proven implementations.

## Hash-bound local preview stage

Use [preview contracts](../../scripts/preview/README.md) and run
`prepare-preview-navigation.mjs` into a fresh directory. Supply the approved plan
and exact SHA256 references in `captureResultFiles`, including recovery-chain
manifests. Declare optional `mappedLayoutFiles` and `componentExamplesFiles`
explicitly; neither a prior stage nor a directory scan is an input. Review
`deployment-manifest.json`, its inputs and file hashes before installation.
Only validated successful selected routes and ready approved examples become
navigation links. Failed/skipped/unattempted routes stay unavailable.

The mock client reads `<roots.app>/public/mock-layouts/<route>/index.json`.
Preserve exact route case and suffixes, including `.json` and `/index` when they
are part of the route. The root route maps to `home/index.json`. Do not lowercase,
slugify or add site/language path folders. Each preview tree contains one
language; a new language needs an explicitly separate tree/deployment choice.
Do not serve evidence manifests or raw rich-text exports under `public/`.

For a verified SitecoreAI / XM Cloud Content SDK target, use the existing pair
scaffold's reviewed plan/apply interface:
`scaffold-mock-service.mjs --target APP --preview-stage STAGE
--preview-stage-sha256 HASH --dry-run`. The hash is the exact reviewed deployment
manifest bytes. Review the complete plan, provide required before-hash overwrite
approvals, then apply within the already authorized local scope. The installer
validates stage provenance, mappings, route bindings and current source bytes.
This scaffold is SitecoreAI-specific. JSS targets require their own verified
target loader and reviewed integration; do not assume the scaffold supports JSS.

The preview stage installs `public/mock-preview/navigation.js`, its routes index
and selected mock layouts. Keep its one marked root-layout script hook gated by
`USE_MOCK_LAYOUT_SERVICE === 'true'`. Navigation uses same-origin native links
and never crawls the filesystem or a stale route index. Both `public/mock-preview`
assets and that single marked hook are removable after an ownership/hash review.
Refreshing the index omits stale extras but does not automatically prune app
files. Review prior deployment hashes and approve each preview-owned removal;
never recursively delete customer content or raw evidence.

Verify installed paths/hashes against the deployment manifest and retain
requested, captured, mapped, staged, delivered and unavailable counts separately.
Browser route acceptance remains a separate check under
[preview readiness](../../../cms-migration/references/profiles/sitecore/pipeline/preview-readiness.md).
A stage, copy, HTTP 200 or index entry alone is not visual validation.

## Dictionary and publishing

For normalized dictionary evidence, run `build-mock-dictionary.mjs` with the exact
app site name. Review duplicate-key precedence (`first`/`last`) as a mapping
decision and preserve failed locales. Copy only manifest-listed
`<site>/<language>.json` files to `public/mock-dictionary/`, verify their hashes
and check an actual translated string when browser validation is requested.
Keep original layout/rich-text evidence outside the app.

Files under `public/` are customer content served by the app. Local delivery does
not authorize committing, pushing or publishing that content. Confirm acceptance
before a later push, or keep the preview content out of that commit.
