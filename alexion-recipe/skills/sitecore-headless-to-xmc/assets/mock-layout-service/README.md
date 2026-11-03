# Mock layout service golden samples

Status: implemented native scaffold. The five original mock payloads and nine resolver-owned shared payloads retain recorded historical provenance. Preview navigation adds two public assets; the mock client now preserves exact captured route casing and suffixes. Each changed/new entry carries v3 provenance in the manifest. manifest.json records SHA-256 hashes verified before planning/writing.

From this skill, run `node scripts/scaffold-mock-service.mjs --target /absolute/app --dry-run`. Default mode is plan. --apply creates missing files; existing differences require repeatable --overwrite relative/path:beforeHash approvals from the plan and receive unique numbered backups. Environment merging appends only missing keys; existing values, IDs, comments and newline style are preserved. Even additive edits to an existing environment file require approval. Reports expose key names/hashes, never environment values.

Shared assets and the native scaffold engine belong to this pair skill's sibling `assets/resolver-framework` directory. Copy the whole pair skill into a writable task directory for a self-contained invocation; `--resolver-assets /absolute/supplied/resolver-framework` remains available for an explicitly supplied engine/asset directory. There are no authoring-checkout, git, database, retired SDK or monorepo runtime dependencies. See the [native CLI contract](../../scripts/README.md).

## Historical provenance and generated files

Audited commit `03e00d4c9`, under `packages/kajoo-sitecore/src/code/migrations/xpheadless2sai/`: `services/nextjs-client-scaffold.service.ts`, `services/resolver-framework.service.ts`, and `templates/index.ts`. Recover historical content with `git show 03e00d4c9:<path>`; these are provenance coordinates, not current executable dependencies.

The following is the complete extraction manifest. Template names are relative to the historical templates directory; shared files exist only in resolver assets.

| Target application path | Historical template |
| --- | --- |
| `src/lib/mock-sitecore-client.ts` | `mock-sitecore-client.template.txt` |
| `src/lib/sitecore-client.ts` | `sitecore-client.template.txt` |
| `src/lib/generate-mock-sites.ts` | `generate-mock-sites.template.txt` |
| `sitecore.config.ts` | `sitecore.config.template.txt` |
| `sitecore.cli.config.ts` | `sitecore.cli.config.template.txt` |
| `src/lib/layout-normalizer.ts` | `layout-normalizer.template.txt` |
| `src/lib/normalizing-sitecore-client.ts` | `normalizing-sitecore-client.template.txt` |
| `src/lib/media/bynder-asset-normalizer.ts` | `bynder-asset-normalizer.template.txt` |
| `src/lib/server/resolver-adapter.types.ts` | `resolver-adapter.types.template.txt` |
| `src/lib/server/resolver-strategy.ts` | `resolver-strategy.template.txt` |
| `src/lib/server/resolver-registry.ts` | `resolver-registry.template.txt` |
| `src/lib/server/resolver-adapter.stub.ts.template` | `resolver-adapter-stub.template.txt` |
| `src/lib/server/resolvers/README.md` | `resolver-folder-readme.template.txt` |
| `src/components/content-sdk/RawFieldHtml.tsx` | `raw-field-html.template.txt` |

The service also merged `.env.local`, ensured `public/mock-layouts/` and `public/mock-dictionary/`, and patched the first matching route: `src/app/[site]/[locale]/[[...path]]/page.tsx`, `src/app/[[...path]]/page.tsx`, or `src/app/[...path]/page.tsx`. The actual generator is under `src/lib/`, despite the old wrapper mentioning `scripts/generate-mock-sites.ts`. Later CLI execution generates `.sitecore/sites.json`; scaffold setup itself does not generate site data, captured layouts or dictionaries.

## Substitutions and integration contract

Historical setup copied constant template strings; the native scaffold also verifies and copies those payloads without arbitrary template-token substitution. The target root determines output paths. Site/locale/host customization remains a separately reviewed application change, not an available scaffold flag.

Environment behavior: append missing `USE_MOCK_LAYOUT_SERVICE=true`, `MOCK_LAYOUT_DATA_PATH=/mock-layouts`, `MOCK_DICTIONARY_DATA_PATH=/mock-dictionary`, `MOCK_LAYOUT_DEBUG=false` and an empty `SITECORE_EDGE_CONTEXT_ID`. Existing values, unrelated keys and comments are preserved. The historical trailing-space debug-key defect is not reproduced. If mock mode is already false, enabling it requires a separately reviewed change.

The site generator reads `NEXT_PUBLIC_DEFAULT_SITE_NAME`, falls back to `mock-site`, and historically hardcodes English and wildcard host. Future site/locale/host inputs must come from verified workspace scope, not this fallback. Mock config uses `mock-disconnected-mode` when no context ID exists and disables redirects/personalization in mock mode; this is not live parity.

The route patch imports `applyResolverStrategy`, enriches a fetched page only in live mode before not-found handling, and passes `locale`, `site`, `routePath` and `resolverDebug` (from `RESOLVER_DEBUG`). Check those bindings and mutable page data in the actual route; historical textual matching could produce an import-only partial patch. No match or partial integration must be reported as unresolved.

Resolver framework semantics and raw field script execution belong to the CMS pair skill. The flat `content-sdk/RawFieldHtml.tsx` location historically relied on the component-map exclusion; verify that contract before adopting it.

## Safety and evidence

Historical services overwrote infrastructure. The native script instead exposes a reviewable plan, preserves edits by default, reports conflicts and uses unique backups for explicitly approved replacements. It has no database or sandbox context side effects.

JSON contains provenance, file actions/hashes, environment key names, route outcome and unresolved validation. Scaffold execution does not generate fixtures or sites.json and does not establish build/browser compatibility. Historical site/locale/host fallbacks and webpack registry discovery remain explicit integration constraints. See [render validation](../../../frontend-migration/references/render-validation.md).

The scaffold also does not implement or guarantee an orange fallback for not-yet-migrated renderings. That behavior must be verified in the actual target SDK/runtime for the chosen route; if absent, track a separate Sitecore preview-foundation change through the supported extension point. Never treat a missing route/fixture or runtime error as an unmigrated-rendering placeholder.


## Verified preview stage and navigation

Prepare a fresh stage with the Sitecore skill's
`scripts/preview/prepare-preview-navigation.mjs`. It accepts only explicitly declared,
hash-bound capture results and optional approved mapped or synthetic manifests.
Then review the stage manifest and install it with:

```sh
node scripts/scaffold-mock-service.mjs --target /absolute/app \
  --preview-stage /absolute/evidence/preview-stage \
  --preview-stage-sha256 <exact-deployment-manifest-SHA256> --dry-run
```

After reviewing the plan, use `--apply`, adding each required
`--overwrite relative/path:beforeHash`. The stage and app must not overlap.
The installer checks current input hashes, capture-plan/result identities, route
index consistency and shipped navigation bytes before writing. The explicit stage
manifest hash prevents changes between review and installation. A valid empty index
is supported; no extra homepage or sitemap capture occurs.

The scaffold adds `public/mock-preview/navigation.js`,
`public/mock-preview/routes.json`, and proposes one marked root-layout script hook,
gated by `USE_MOCK_LAYOUT_SERVICE === 'true'`. Existing root-layout edits require
the same before-hash approval and backups as other replacements. The default roots
are `src/app/layout.tsx` or `app/layout.tsx`; `--layout <relative-root-layout>` selects
another reviewed server layout. Unsupported/client/ambiguous layouts remain
unresolved without a partial patch. This does not remap source placeholders or
implement missing components.

Only current stage routes appear in the tree. Old app fixtures are not deleted;
review prior deployment ownership and hashes before removing them. To uninstall,
remove `public/mock-preview` and its marked root-layout hook after ownership review.
Raw captures remain evidence outside the app. Synthetic examples remain explicitly
synthetic and pending human validation. Builds and real browser parity still need
verification in the actual target SDK/app.

This Content SDK scaffold is shared by XP Headless-to-SitecoreAI and
MVC-to-SitecoreAI. The static navigation/stage format can also support an existing
XP Headless/JSS preview, but this command does not install or certify a JSS runtime;
do not copy Content SDK infrastructure into that target. Integrate its assets and
mock-only hook through the target's verified JSS layout/loading mechanism.
