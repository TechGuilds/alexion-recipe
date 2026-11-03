# Frontend scripts: implementation status

The analyzers and HTTP probe below are implemented native scripts. Follow each contract and verify external runtime/connector prerequisites separately.

| Resource | Status and current procedure |
| --- | --- |
| `analyze-styles.mjs` and `styles/` | Implemented extraction; follow [style analysis](../references/style-analysis.md). |
| `plan-style-foundation.mjs` | Read-only conversion of retained source/target style-analysis reports into a bounded shared-style handoff; follow [style migration policy](../references/styles.md). |
| `analyze-layout.mjs` and `layouts/` | Portable JSS/Content SDK analysis; golden parity and CLI tests pass. See commands below. |
| `analyze-usage.mjs` | Read-only route/placeholder/component frequency over captured Sitecore `**/index.json` layouts; authoritative only for a complete uncapped capture. |
| `analyze-source.mjs` | Native read-only JS/TS component/import/export inventory; see [source analysis](../references/source-analysis.md). |
| `probe-render.mjs` | Local HTTP(S) status/body-marker checks with timeout and body limits; see [render validation](../references/render-validation.md). |

## Local layout and source analyzers

Use Node 20+ and copy the skill into a writable task directory if the installed skill is read-only. From that copy's `scripts` directory:

```sh
npm ci --prefix ./layouts --workspaces=false --ignore-scripts
node analyze-layout.mjs --root /absolute/source --framework jss --output /absolute/reports/layout.json
node analyze-layout.mjs --root /absolute/target --framework content-sdk --layouts /absolute/mock-layouts --output /absolute/reports/target-layout.json
node analyze-usage.mjs --layouts /absolute/mock-layouts --all-routes --output /absolute/reports/component-route-coverage.json
node analyze-source.mjs --root /absolute/source --revision 0f107ac46 --output /absolute/reports/source.json
node --test layouts/core.test.mjs analyze-layout.test.mjs tests/analyze-source.test.mjs
```

Both CLIs require a root and fresh output outside all input trees. Defaults are 1,000 matched files per tree and 2,097,152 bytes per file, adjustable with `--max-files` and `--max-file-bytes`. They skip symlinks and generated/dependency directories, sort traversal, normalize paths to `./`, preserve source, and exclusively create reports with mode 0600. Exit 0 includes partial evidence; inspect `complete` and saved `scan.omissions`. Fatal input/output errors exit 1 with JSON stderr. Help does not load parser dependencies. Scan caps limit files read, not directory enumeration or report size.

`layouts/core.mjs` exports `await analyzeFiles(files, {framework, rootPath})` where files contain `{path, content, size?}` and framework is `jss` or `content-sdk`. It returns direct normalized analysis plus `parseWarnings: [{file, code, message, line?, column?}]`, with no wrapper object. Pure analyzer methods derive from revision `03e00d4c9`; golden fixture JSON is unchanged. No runtime services, SDKs or component-map scanners are imported. Content SDK parser recovery retains available evidence and reports errors; JSS uses strict parsing. Text-based SEO signals can survive malformed syntax.

Source JSON contains `scope`, per-file `imports`/`exports`/`jsxElements`, JSX component candidates, module `edges`, package dependency declarations, `parseWarnings`, `limitations`, `graphComplete` and `scan`. Coordinates are one-based. `scope.revision` is caller-supplied. Resolved edges are file candidates under the scanned root; external package strings are not validated against installed packages. `graphComplete` describes the supported static inventory only. Use LSP or manual tracing for semantic references, re-export symbol binding, runtime selection and unresolved edges. See the source reference for limitations.

## Render probe contract

Render probe: `node probe-render.mjs --url http://127.0.0.1:3000/example --marker expected-component --reject-marker 'Application error' --timeout-ms 5000`. Accepts credential-free loopback HTTP(S), one URL per invocation, repeated positive/negative markers, optional `--status` and `--max-bytes`. Returns JSON to stdout; exits 0 for passed HTTP checks, 2 for failed checks and 1 for invalid invocation. It does not run builds or start processes, follow redirects, save artifacts or provide browser parity. Run builds and preserve stdout as evidence separately; see [render validation](../references/render-validation.md).

## Validation boundaries

Focused tests exist for source/layout/style analysis and for the [probe](../tests/probe-render.test.mjs), including copied-skill and timeout/body-marker scenarios. Run relevant tests when implementation changes. Script success does not establish target SDK compatibility, actual remote capture or browser parity. No script writes workflow or memory state.

Installed skill directories remain read-only. Copy the style analyzer and its full local dependency tree into a writable task directory before installing parser dependencies when necessary. Keep reports outside scanned/application roots and return paths to the existing coordinator.

## Shared style foundation plan

When a shared styles/shell task follows Discovery, use the retained style reports to
create its bounded handoff before inspecting application files:

```sh
node plan-style-foundation.mjs \
  --source-analysis "$STYLE_SOURCE_REPORT" \
  --source-root "$SOURCE_ROOT" \
  --target-root "$TARGET_ROOT" \
  --target-analysis "$STYLE_TARGET_REPORT" \
  --output "$EVIDENCE_DIR/style-foundation-plan.json"
```

Omit `--target-analysis` when no current target report exists; do not launch a new
repository-wide scan solely to populate that optional input. The script reads only
saved reports, creates one new JSON file outside both application roots, and never
copies files, installs packages, starts a server, or writes workflow state. Its
static import order is a candidate list: confirm the real layout cascade before
changing target entrypoints. See [style migration policy](../references/styles.md).
