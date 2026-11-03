# Tests

Developer checks, separate from executing migration tasks on Kajoo. From the skill directory run:

```sh
node --test tests/*.test.mjs
```

Keep the sibling `cms-migration` and `sitecore` skills available for the workflow and instruction checks. Runtime scripts use the bundled validator and need no dependency installation; the isolated CLI test supplies no node_modules or NODE_PATH. The tests do not contact Sitecore. Source and target exporter tests run PowerShell against test doubles: set `PWSH_EXE` if `pwsh` or `powershell.exe` is not on PATH, otherwise those tests are skipped. The harness scripts under `fixtures/` must never be submitted to a real Sitecore instance.

## Fixtures

Everything under `fixtures/` is sample data. `sitecore-mapping.json` illustrates the mapping format; the other files are generated companions. Their instance names, item IDs, field types, data and paths are not project configuration, and `item-plan.json` is not proof that items exist or that a plan is approved. Production inputs must use verified IDs, definitions and approved rules. Maintainer instructions for regenerating fixtures and rebuilding the validator bundle are in the headers of `fixture-factory.mjs` and `build-validator-bundle.mjs`.
