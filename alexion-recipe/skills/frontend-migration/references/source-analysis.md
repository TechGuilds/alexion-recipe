# Source analysis with native tools

## Establish scope

Read the assigned inventory/work item and source baseline. Record source root and revision, target root and revision when target analysis is assigned, component/rendering identity, route, site, language, version and device where available. A filesystem component and a CMS rendering are distinct identities; keep an explicit mapping with its evidence. Missing CMS usage data is unknown coverage, not an unused component. During source Discovery, proposed target mappings and unresolved semantic joins are handoff findings, not mandatory implementation proof; use the active profile's collection acceptance criteria.

Use native reads and bounded searches from the application root. For example, list candidates with `rg --files src` and search those files with `rg -n 'import |require\(|dynamic\(|<script|<link' src`. Adapt directories and patterns to actual source; exclude generated output, dependencies and vendor bundles. Save scope, exclusions and inaccessible files. Searches locate candidates; they do not prove an exhaustive dependency graph.

## Trace one representative route

1. Read the route entry, shell/layout and nested component imports. Resolve aliases from project config and follow barrel re-exports. Use LSP definitions/references for symbols; distinguish a resolved edge from a guessed string match.
2. Record each component's export, source path/line, props/data origin, conditional branches, slots and repeated instances. Preserve DOM order, wrapper classes and IDs needed by CSS or scripts.
3. Trace styles, fonts, images and SVGs; run the existing [style analysis](style-analysis.md) where appropriate. Read layout import/link order separately from detector declaration order.
4. Trace event handlers, global initialization, plugins, browser APIs, timers, observers and cleanup. Check deferred/dynamic imports and route changes; annotate unresolved computed imports.
5. For Razor/controller source, consume staged semantic analysis through the MVC pair skill. LSP/search is not a replacement for Roslyn or resolved CMS data. For headless source, use captured layout and registration evidence from the pair skill to relate source components to actual page instances.

## Evidence contract

Write a bounded workspace report (Markdown or the existing inventory format) containing: scope/revisions; files examined with coordinates; route-to-layout-to-component edges; dependencies and versions; props/data contracts; assets/style order; client behavior; proposed target mappings; and unresolved edges. Cite the staged artifact path and JSON pointer for captured data. Label findings as observed, inferred or unknown and identify the next check for each inference.

Keep totals distinct: source components, registered renderings, observed page instances and migrated components are different counts. Record scan limits, omitted roots, parse failures and unobserved routes. An absence claim needs complete evidence for its stated scope.

Return the report path and proposed dependencies to the coordinator. Native IO owns local analysis state; it does not authorize changing remote content or maintaining a second workflow store.

## Executable static inventory

Install the pinned parser dependencies in a writable copy of `scripts/layouts` using `npm ci --workspaces=false --ignore-scripts`. Run `node scripts/analyze-source.mjs --root /absolute/source --revision <baseline-label> --output /absolute/reports/source.json`. The revision is caller-supplied, not independently verified. Use `--max-files` (default 1000) and `--max-file-bytes` (default 2097152) to bound reads. Reports must be fresh files outside the input root; input and destination symlinks are not followed during traversal/writes. The root itself is canonicalized. No source or application configuration is executed or written.

The report records JS/JSX/TS/TSX and module variants, JSON package dependencies, imports, exports, re-exports, literal dynamic imports, `require`, TypeScript import-equals, JSX element occurrences and JSX component candidates with one-based coordinates. Relative imports, extension/index candidates, and local `tsconfig.json`/`jsconfig.json` `paths`/`baseUrl` are resolved against files actually read. Nested config uses the closest containing directory. Each edge labels its static evidence and resolution method; JSX candidates are not proof of React runtime registration. Module edges through barrels are retained; symbol-level barrel binding needs separate tracing.

`scan.complete` covers input/parsing coverage; `graphComplete` additionally excludes unresolved/computed edges and declared config-inheritance limitations. A successful process may produce partial evidence. Inspect `scan.omissions`, `parseWarnings`, `limitations`, and edges with `unresolved`/`computed` status. Empty input is reported as an empty inventory. Excluded directories are listed in `scope`; caps bound file reads but still enumerate the input tree to count omitted matches.

Limits: strict JSON parsing flags JSONC/trailing commas, including tsconfig files; `extends`/project references, bundler aliases, package exports, installed versions, non-JS assets, symbol binding, computed imports and runtime component factories are not resolved. Bare module strings are classified external, not verified installed. Export/component discovery is syntactic; HOCs without local JSX and `React.createElement` components need manual/LSP review. LSP is an optional supplement and is not needed to run the CLI. Do not treat static completeness as CMS usage or render parity.

For layout evidence, `scripts/analyze-layout.mjs --root /absolute/source --framework jss --output /absolute/reports/layout.json` supports JSS and `content-sdk`. Optional `--layouts /absolute/mock-layouts` aggregates captured `**/index.json` routes by source layout ID, including nested routes and preserved `layoutFilePath`. Unknown IDs and invalid layout JSON remain partial. The portable core preserves the captured original evidence, including historical heuristics such as JSS factory-referenced layout selection and Content SDK component-map registration assumptions. Validate those assumptions against the representative route above.
