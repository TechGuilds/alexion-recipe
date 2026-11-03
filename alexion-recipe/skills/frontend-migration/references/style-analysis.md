# Analyze source or target styles

Use the bundled golden script through native `bash`; use native `read` for its JSON evidence. It replaces the styles MCP analysis operation. It does not initialize a sandbox, query connectors, modify source, install application dependencies, or write task/memory records.

## Run

Resolve the actual skill directory from the loaded skill, and resolve the source or target application root from workspace configuration. Do not scan the entire workspace or infer a target app name. If the skill is installed as a read-only projection, copy its scripts and complete styles dependency tree to a writable task directory and set `FRONTEND_SKILL` to that copy. Install the script's own pinned parser dependencies there, not in the application or read-only projection:

```bash
(cd "$FRONTEND_SKILL/scripts/styles" && npm ci --workspaces=false --ignore-scripts --no-audit --no-fund)
node "$FRONTEND_SKILL/scripts/analyze-styles.mjs" \
  --root "$SOURCE_ROOT" \
  --source-kind headless \
  --output "$EVIDENCE_DIR/styles-source.json"
```

`FRONTEND_SKILL`, `SOURCE_ROOT`, and `EVIDENCE_DIR` are resolved paths, not literal placeholders. Choose a new report filename outside the scanned root for each run. Existing reports are never overwritten or pruned. Output parents must be real directories (use canonical paths, not symlink aliases). Keep evidence outside the target code tree too. The script creates missing output directories.

| Option | Contract |
| --- | --- |
| `--root` | Required existing source/target application directory; read-only. |
| `--output` | Required new JSON file outside the input tree. |
| `--source-kind` | `generic` (default), `headless` (JSX cross-cutting findings), or `mvc` (Roslyn overlay). |
| `--mvc-analysis` | MVC only: staged raw Roslyn JSON with `result.styleReferences`. Read the actual discovery output path; do not guess it. Missing argument yields partial evidence, not a complete MVC analysis. |
| `--max-files` | Positive integer, default 1000. Caps matching files considered, in deterministic traversal order. |
| `--max-file-bytes` | Positive integer, default 2097152. Per-input-file read limit, also applied to the optional Roslyn artifact. Raise explicitly for a larger verified artifact. |

For MVC source, run Roslyn discovery first, then use `--source-kind mvc --mvc-analysis "$MVC_RAW_JSON"`. The script merges filesystem detector findings with the already-staged bundle/Razor evidence; it does not infer C# structure. For the migrated React target use its own root and `--source-kind headless`, even when the source was MVC. Never overlay source MVC evidence onto target verification.

## Read and interpret

Stdout is one small JSON result with `success`, `destination`, `complete`, file counts, primary system/confidence and `crossCutting` counts. Read `destination` for the full report. For large reports use native bounded reads or select the required JSON fields with a local script; do not paste the entire report into chat.

The report preserves detector data: `primarySystem`, `confidence`, `secondarySystems`, `evidence`, `detectionResults`, `dependencies`, `configFiles`, `cssFiles`, and `cssImports[]` (`type`, `path`, `file`, `line`, `raw`). MVC adds `mvc.bundleConfigs`, `razorLinkTags`, `stylesRender`, `sectionStyles`. Headless/MVC findings may add `externalStylesheets`, `serverInjectedBodyClasses`, `dynamicStyleAttributes`. Counts appear under `crossCutting` in stdout; full arrays live at the report's top level. Paths from the file scan are root-relative; Roslyn evidence paths retain their producer's coordinates.

Check `scan.complete` before treating zero findings as absence. File caps, skipped symlinks, oversized/unreadable inputs, parse failures, or missing MVC evidence make a report partial. Inspect `scan.omissions`, narrow the root or raise the relevant limit and rerun to a new filename. Preserve references to both reports and describe remaining gaps. A partial report can enrich discovery but cannot establish exhaustive coverage or migration parity. Malformed explicit MVC input, missing roots, invalid arguments and unsafe/existing output paths fail with exit 1 and a JSON error on stderr.

`scan.complete` means all matching inputs within this configured scope were read
without reported failures; it does not mean every styling construct is understood.
These are static detection heuristics, not proof of runtime styling. The preserved
import detectors cover static JS/JSX/TS/TSX imports and Sass/framework directives;
they do not provide a general CSS/LESS import graph, dynamic imports, or CommonJS
`require` analysis. Use targeted LSP/source review for those gaps. Headless
link/body/style extraction is best-effort; computed links or deeply nested
expressions can also require review. `externallyCoupledPartials` is not
automatically populated: record inspected findings separately, not as fabricated
scanner output. Check CSS cascade order in the actual layout: `@Styles.Render`/link
order controls bundle insertion; `bundleConfigs[].includes` controls order inside
each bundle. Declaration order alone does not prove page order.

Return the actual evidence destination and a concise summary to the orchestrator. No per-file memory entries, duplicated markdown report store, or automatic phase completion. Migration changes follow `styles.md` and the relevant pair skill; render/interaction verification is still required.
