# Native Sitecore scaffolds

Node 20+; no installation needed. From this skill:
```sh
node scripts/scaffold-resolver.mjs --target /absolute/target-app --source /absolute/source-app --dry-run
node scripts/scaffold-resolver.mjs --target /absolute/target-app --source /absolute/source-app --apply
node scripts/scaffold-mock-service.mjs --target /absolute/target-app --source /absolute/source-app --dry-run
```

Default mode is a read-only plan (--plan and --dry-run are aliases). --apply creates missing files, skips identical files, and preserves conflicts. Nonconflicting files may be created while conflicts remain; the operation is not transactional. No database, workflow state or commit is written.

Review JSON actions, before/after SHA-256 hashes and the corresponding golden payloads. Replacing an existing file requires repeatable --overwrite relative/path:beforeHash arguments identifying each approved file. There is no blanket force. Stale hashes and unmatched approvals reject the operation before writing. Each replacement has an exclusive-created relative/path.bak.<old-hash-prefix>.<number> backup with restrictive permissions. Restore the selected backup manually after reviewing subsequent edits. Reports omit contents and environment values.

Supply --source whenever a separate source tree is in scope. Equal/ancestor/descendant overlaps between target and source/assets are rejected. Target children and asset files cannot traverse symlinks; system ancestor aliases are canonicalized before overlap checks. Traversal, absolute output paths and hard-linked existing outputs are rejected. These safeguards are not a sandbox against concurrent filesystem mutations; stop other target writers while applying. No source-tree file is copied.

JSON fields: mode, target, files (path/action/beforeHash/afterHash/optional backup), directories, envKeys, provenance, route and unresolved. Exit 0 means no file conflicts, 2 means conflicts remain, 1 means input/execution failure. Exit 0 never establishes migration/build/browser success. Plans are deterministic for unchanged inputs.

## Mock Layout Service scaffold

`scaffold-mock-service.mjs` uses the same plan/apply, hash-bound overwrite and backup contract above. It accepts an explicit target root, optional source root and route, and optional `--resolver-assets /absolute/resolver-framework` override. The pair skill includes the engine and both asset directories for a self-contained copied-skill invocation.

The generated set is `src/lib/{mock-sitecore-client,sitecore-client,generate-mock-sites,layout-normalizer,normalizing-sitecore-client}.ts`, `src/lib/media/bynder-asset-normalizer.ts`, `src/lib/server/{resolver-adapter.types,resolver-strategy,resolver-registry}.ts`, `src/lib/server/resolver-adapter.stub.ts.template`, `src/lib/server/resolvers/README.md`, `src/components/content-sdk/RawFieldHtml.tsx`, `sitecore.config.ts` and `sitecore.cli.config.ts`. Additional operations are an environment merge, route integration, and creation of the public mock directories. Preview navigation adds public/mock-preview assets and one reviewed mock-only root-layout hook; `--preview-stage DIR --preview-stage-sha256 HASH` installs selected verified layout outputs. The [mock asset manifest](../assets/mock-layout-service/README.md) enumerates each historical template, route candidate and later `.sitecore/sites.json` output.

Run `node scripts/scaffold-mock-service.mjs --target /absolute/target --source /absolute/source --dry-run` from this skill, review the plan, then use `--apply` with only required `--overwrite relative/path:beforeHash` approvals. There are no site/locale/host substitution flags: verify or separately configure the historical defaults under approved scope. Environment merging appends missing keys and preserves existing values/comments; existing-file edits require hash-bound approval. Captured layouts, dictionaries and selected-route provenance must be supplied separately from Discovery.

## Preview-foundation handoff

After the mock scaffold and any `shared-styles-shell` prerequisite are complete, create a task-owned manifest before preview work:

```sh
node scripts/prepare-preview-foundation.mjs \
  --target /absolute/target \
  --fixture /absolute/evidence/selected-layout.json \
  --route /selected-route \
  --layout src/Layout.tsx \
  --prior-result /absolute/evidence/mock-layout-scaffold/task-result.json \
  --prior-result /absolute/evidence/shared-styles-shell/task-result.json \
  --out /absolute/evidence/preview-foundation/input-manifest.json
```

`--fixture`, `--route`, `--layout` and `--out` are required. `--layout` is a slash-separated path relative to `--target`; `--out` must be a new file outside target (and optional `--source`) roots. The script reads only the explicit fixture, layout and prior results. It writes a hash-bound manifest containing the route, fixture placeholder keys, target layout hash and prior-result references. It does not scaffold, copy a fixture, start a server, scan routes, change application code or assert browser parity.

The preview task consumes only that manifest and the declared acceptance criteria: compare fixture keys to the explicit layout, make a scoped correction when needed, then run the existing build/type check, `frontend-migration/scripts/probe-render.mjs` on the one fixture-backed route, and supported browser evidence. Probe a missing route only when missing-route behavior is an explicit acceptance criterion. If browser evidence is unavailable, report it as not run; do not substitute an ad-hoc capture harness or claim visual parity from HTTP readiness.

## Route integration

Without --route, the three supported route candidates are inspected without proposing a patch. Supply a relative --route to request integration. Supported shape: an async named function, awaited params destructuring containing locale/site/path, followed by mutable let page = await client.method(...); then one if (!page) { guard. Additional statements, comments, template literals, different scopes, unsupported type signatures or partial integrations require manual review.

Supported routes get a combined import plus live-only enrichment proposal, before the guard. Applying it requires its own hash-bound overwrite approval and backup. Unsupported/import-only routes remain unchanged and unresolved. Arbitrary TS/JS AST rewriting is not claimed. Exact generated integration is recognized on repeat runs.

## Adapter samples

--component 'Corporate Navigation=corporateNavigation' writes src/lib/server/resolvers/corporateNavigation.resolver.ts. Repeat for more adapters. Match names have whitespace removed; identifiers are validated. Normalized name/identifier collisions (including case) within the supplied batch fail before writes. Check existing application adapters for semantic collisions during integration. Existing outputs obey the conflict policy. Stubs retain TODO enrichment and correct the type import to ../resolver-adapter.types. They remain explicitly unresolved until implemented. No existing IDs or registrations are implicitly rewritten.

## Packaging and validation

The [manifest](../assets/resolver-framework/manifest.json) pins nine bundled
payloads using canonical UTF-8/LF SHA-256 values. Standard Git
LF/CRLF checkout conversion therefore does not create a false mismatch, while
any other content mutation still fails before writes. Output bytes and target
before/after hashes remain exact bytes from the supplied asset. Shared payloads
and scaffold-engine.mjs have one authority in this skill's
assets/resolver-framework. The mock scaffold adds five original payloads plus two preview navigation assets from this skill's
assets/mock-layout-service. Copy the whole pair skill for standalone use; the
optional --resolver-assets /absolute/resolver-framework override still accepts
an explicitly supplied directory. No authoring checkout or monorepo runtime
package is required.

Resolver-only setup reports missing mock-sitecore-client.ts and sitecore.config.ts dependencies. Generated code requires Content SDK/Next APIs, React/server-only where applicable and webpack require.context discovery of *.resolver.ts. Turbopack is not supported by this registry. Verify target SDK versions, aliases, RawFieldHtml component-map exclusion and bundler. The native layer never imports retired SDK packages or services.

Focused tests from this skill: `node --test tests/scaffold-resolver.test.mjs tests/scaffold-mock-service.test.mjs tests/prepare-preview-foundation.test.mjs`. They use real temporary directories and child processes, including copied-skill runs. The generic HTTP probe tests remain in `frontend-migration/tests/probe-render.test.mjs`.

## Field access analysis

```sh
node scripts/analyze-field-access.mjs --root /absolute/source-app/src --output /absolute/evidence/field-access.json
```

Static, read-only detection of Sitecore field access (`fields.X`, `fields['X']`, `props.fields.X`, `props.fields['X']`, dot or optional-chained), GraphQL-wrapping (`.jsonValue`/`.jss`) and field type (`value`/`src`/`files`/`editable`/`href`/`text`), plus DAM asset access (`.asset`/`.files`) and explicit blind-spot flags for patterns it cannot resolve (`getFieldValue(...)` calls, `fields` destructuring, dynamic field names). See [data-flow-to-props.md](../references/data-flow-to-props.md) for how to read the report and [resolver-adapter.md](../references/resolver-adapter.md) Step 1.2 for where it feeds in.

Node 20+; install once with `npm ci --workspaces=false --ignore-scripts` from `scripts/field-access/`. It detects four field-access shapes with GraphQL/type inference and adds `OptionalMemberExpression` handling (`fields?.heading`) alongside ordinary member access. Focused tests: `node --test scripts/field-access/core.test.mjs` (30 cases) and `node --test tests/analyze-field-access.test.mjs` (6 CLI cases).
