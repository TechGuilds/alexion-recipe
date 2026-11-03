# Frontend golden scripts

- `analyze-source.mjs`, `analyze-layout.mjs` and `analyze-usage.mjs` own native read-only input validation and report output. `analyze-styles.mjs` owns style scanning; `plan-style-foundation.mjs` converts retained style reports into a bounded handoff without scanning application roots; `layouts/` and `styles/` own pure analyzers/detectors and domain evidence overlays. Do not import Kajoo runtime packages or add per-operation MCP wrappers.
- Keep source read-only, output paths explicit, reports exclusive-created, and incomplete input visible. Never write workflow or memory records from an analyzer.
- Parser dependencies belong in `styles/package.json` with its lockfile, not the migrated application. Install from that directory with `npm ci --workspaces=false --ignore-scripts`.
- Documentation work changes Markdown only; do not run broad executable test loops. Layout/source/style analyzers and the HTTP probe are implemented; follow [contracts](README.md). For implementation changes, run the relevant tests. Fixtures capture the old analyzer outputs; changes to expected evidence require an explained behavior change, not automatic snapshot replacement.
- Keep `../references/style-analysis.md` aligned with the executable contract. Validate a copied skill outside the monorepo so implicit workspace dependencies do not conceal missing packaging.
