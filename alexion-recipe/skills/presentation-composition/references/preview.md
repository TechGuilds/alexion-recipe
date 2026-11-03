# Target-data preview and human review

Use the existing framework-specific preview foundation. This procedure does not scaffold components or make a JSS app behave like Content SDK automatically. The target app must already load structured mock Layout Service payloads and include the mock-only `/mock-preview/navigation.js` hook. The recipe's existing scaffold can establish that foundation under its own review/backup rules. Missing framework integration is a prerequisite, not a passing preview.

This preview uses the approved composition plan and actual migrated target content. It is separate from the Discovery preview in [rendering inventory to mock preview](../../sitecore/references/discovery/rendering-preview-flow.md), which builds source-derived layouts and examples for component validation. Do not reuse those layouts or examples as target data or as review evidence here.

## Prepare layouts and coverage

`previewInput` supplies `version: 1`, `scopeId`, hash-bound `compositionInput` and `compositionPlan`, and the agreed `minimumPages`.

```sh
node prepare-presentation-preview.mjs --input /workspace/preview-input.json --output /workspace/new-preview
```

The script replays composition before accepting the saved plan. It writes a `preview-manifest.json`, target-read requirements, and, only for a ready scope, `public/mock-layouts/<route>/index.json` plus the shipped `public/mock-preview/navigation.js` and a route index. Nested placeholders retain their parent instances. Pages/datasources/resolver results come from current target evidence. There is no source-value or mock-field fallback.

Required coverage is the union of the explicit approved rendering/variant requirements and all proposed occurrences. Supply the complete in-scope list from Discovery/mapping, including combinations absent from selected pages. Deterministic greedy selection recommends pages covering requirements and then fills the agreed minimum. It does not claim a mathematically smallest set. Missing coverage or insufficient pages blocks readiness; do not silently lower the user's minimum or invent a synthetic example.

The navigation tree includes valid prepared pages. Each installation is one explicit site/language/version/device context; use separate app preview attempts for other contexts rather than overwriting contexts silently. The current mock loader's route-file convention maps `/` to `home/index.json`, so conflicting `/home` output is rejected. Preview files intentionally contain migrated target content: use the assigned private preview environment.

This manifest has `kind: virtual-presentation-preview`. It is not a Sitecore capture and must not be relabelled to pass the legacy captured-layout installer.

## Install preview files

Supply `installInput`: `version`, `scopeId`, `taskId`, `previewInput`, `previewManifest`, absolute `targetRoot` and `foundationEvidence`. The foundation descriptor selects a task-owned report with:

- `version: 1`, scope, actual target root, verified `ready: true`, `mockEnabled: true`, `routeContract: single-context`, matching site/language and `framework: content-sdk` or `jss`.
- `loader` and `layout` relative path/SHA-256 descriptors for actual reviewed app files. Layout includes the navigation hook. The owning preview-foundation task must establish correct runtime mock mode, routing and field integration; a marker string alone cannot prove it.
- A relative `evidence` descriptor selecting that task's actual technical check report. Preserve original proof, do not author a successful report merely to pass this input.

```sh
node install-presentation-preview.mjs --input /workspace/preview-install-input.json --output /workspace/new-install-plan
```

The default run emits `preview-install-review.json` and a report with `installed: false`; it changes no app files. Present exact creates/replacements/reuse and before/after hashes. Record the existing `kind: mutation`, `choice: approve` decision with the same task/scope, actual user response/time and `inputs` containing the exact review descriptor. Supply both `review` and `approval` in a new installation input and rerun into a fresh output directory.

Only verified public preview assets from the canonical manifest can be installed. Existing replacements receive exclusive numbered backups. Before-state drift, symlinks/hardlinks, overlap with evidence or foundation changes block writes. Serialize installation through the app-local lock. The per-file report retains partial outcomes if interrupted; inspect files/backups before replanning. Do not clear an uncertain lock or replay a stale review blindly. This is a bounded local file installation, not an atomic app transaction or a Sitecore presentation write.

## Browse, review and retain approval

Use the supported preview server/browser tools to open actual target-component routes. Inspect failures and compare with source evidence. Navigation or HTTP availability alone does not establish appearance. Review at least the agreed minimum pages and enough pages to cover all rendering/variant requirements; alternatives are allowed when they satisfy the same coverage.

For each reviewed page retain a browser evidence JSON with `scopeId`, `pageId`, `route`, current `previewManifestSha256`, `status: rendered`, actual nonempty `checks: [{name,passed}]`, `errors: []`, and a relative `screenshot: {path,sha256}` pointing to the actual PNG/JPEG. Preserve real screenshots and tool results; do not replace unavailable browser evidence with generated images or a successful CLI result.

The orchestrator obtains the user's current per-page `verification` decision: `entityId` is the target page ID, `choice` is `verified`, `not-verified` or `pause`, and actual response/time plus inputs bind both the preview manifest and that page's browser evidence. Grouped interviews are allowed while retaining individual decisions. Preserve corrections and exclusions explicitly.

`reviewInput` supplies `version: 1`, `scopeId`, the exact review `taskId`, preview request/manifest descriptors, browser evidence descriptors and decision descriptors. Each human decision must name that task:

```sh
node review-presentation-preview.mjs --input /workspace/preview-review-input.json --output /workspace/new-review
```

The validator replays current composition/layouts, verifies stage bytes/screenshots/decisions, and checks reviewed-page count and coverage. It emits `preview-review.json`. A passing report still has `applyAuthorized: false` and `workflowAdvanced: false`. Target application requires separate current-state checks, backup, dry-run and mutation approval. Final target-site visual/functional verification remains separate.
