# Local mock preview navigation

`prepare-preview-navigation.mjs` reads explicitly approved local evidence and prepares a
fresh deployment tree. It makes no network requests, edits no app, and never scans
capture directories. Copy the skill's `scripts/` and `assets/` together to run it
outside this repository; only native Node modules are required.

```sh
node scripts/preview/prepare-preview-navigation.mjs --params /evidence/preview-params.json
```

The params file uses explicit absolute paths and SHA256 digests of the exact file
bytes. `captureResultFiles` is the authoritative set for this refresh, including
every manifest referenced by a recovery chain. A previous stage is never an input.

```json
{
  "capturePlanFile": "/evidence/approved-capture-plan.json",
  "capturePlanSha256": "<exact file SHA256>",
  "captureResultFiles": [
    { "path": "/evidence/capture-result.json", "sha256": "<exact file SHA256>" }
  ],
  "outputDir": "/evidence/preview-stage-new"
}
```

The approved, non-draft rendering and variant plan must pass its own fingerprint
validation. Every result must match that fingerprint and `discovery-plan` selection.
Only successful outcomes with approved route identities, matching route file paths,
current file hashes, and matching captured item IDs can become links. Failed,
skipped, unattempted, and undeclared files are excluded. An approved alternative
requires a declared, complete, acyclic recovery chain with an earlier selected-page
attempt. No homepage, route limit, sitemap, or unused-definition selection is implicit.

Output is limited to:

- `public/mock-preview/navigation.js`: exact bytes from the canonical asset
  `assets/mock-preview/navigation.template.txt`.
- `public/mock-preview/routes.json`: `{ "routes": ["/selected/path"] }`; path
  segments are URL encoded, preserving case. `/` is included only if captured.
- `public/mock-layouts/<route>/index.json`: byte-preserved validated selected layouts;
  a captured `/` uses `home/index.json`, following the capture helper convention.
- `deployment-manifest.json`: schema version 1, kind `mock-preview-deployment`, with
  `files: [{path, sha256}]`, complete input file hashes in `inputs`, plan/result
  provenance, route availability, and capture/example distinctions. Output file
  paths are relative to this stage. Evidence file paths are absolute.

`preparePreviewNavigation(options)` returns the same manifest as the CLI writes.
The destination must be new or empty, must not traverse symbolic links, and must
not contain input files. Prepare every refresh in a new directory. An error during
input validation produces no output. A filesystem failure during writing can leave
a partial stage; discard that stage and use another fresh directory.

## Explicit mapped and synthetic layouts

Optional `mappedLayoutFiles` and `componentExamplesFiles` arrays use the same
`[{path, sha256}]` references. Neither input is discovered automatically.

`mappedLayoutFiles` points to `mapping-result.json` files produced by
`mapping/apply-component-mappings.mjs`. Each result must reference the exact raw
capture already declared above and a current approved mapping plan. The helper
rebuilds the mapping plan from current keyed approval evidence, recomputes the
mapped layout, and compares the staged bytes' JSON content with that result. One
explicit mapped result replaces the preview copy of its source route. Raw captures
remain unchanged.

`componentExamplesFiles` points to `component-examples.json` files produced by
`capture/build-component-examples.mjs`. The helper verifies the manifest hash,
source inventory hash, mapping plan, current approval evidence, and eligibility of
explicit unused definitions. It rebuilds ready example layouts and verifies the
generated file bytes against their embedded layouts. Only `layout-ready` examples
become links; examples needing fixtures or dependencies are listed in
`excludedExamples`. Synthetic rows in `captures` retain `synthetic: true`, their
requirement key, and `visualValidation: "pending"`. They do not add capture outcomes
or establish real source capture or visual validation. Real rendering/variant
coverage remains the separate rendering coverage report.

## Deployment and removal

Review `deployment-manifest.json` and its file hashes before copying the stage
through the pair scaffold's reviewed write interface:
`scaffold-mock-service.mjs --target APP --preview-stage STAGE
--preview-stage-sha256 <exact deployment-manifest.json hash> --dry-run`.
Review that plan before `--apply` and provide each required before-hash overwrite
approval. The installer also validates current source provenance and route bindings. Keep the single marked root
layout script hook gated by `USE_MOCK_LAYOUT_SERVICE === 'true'`; navigation itself
is a static asset and appears only when that hook loads it. The client requests
only the same-origin `/mock-preview/routes.json`, uses native links to app routes,
renders labels through `textContent`, rejects malformed/unsafe paths, and handles
unavailable indexes without breaking the page.

A new index omits stale extras regardless of files in earlier capture/stage/app
directories. Deployment does not automatically delete old app files. If cleanup is
needed, review the previous deployment manifest, verify each current file still
matches its preview-owned hash, and explicitly approve individual removals. Do not
delete a directory recursively or remove raw captures. To uninstall navigation,
remove `public/mock-preview` and its one marked root layout script hook after that
same ownership review.

```sh
node --test tests/preview-navigation.test.mjs
```
