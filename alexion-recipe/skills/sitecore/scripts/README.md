# Sitecore operation scripts (remote `.ps1` via `run-powershell-script`; local `.mjs` via Bash)

Ready-to-run SPE `.ps1` scripts for Sitecore operations are organized by domain
and run through the generic Sitecore PowerShell tool. Local `.mjs` processors
and capture helpers run in the sandbox through Bash; when they need
authenticated access, attach the correct connector to that Bash call rather
than moving credentials into a script.

## How to run one
1. **Read** the script (native `read`).
2. **Run** it via `run-powershell-script` on the correct connector — `source-sitecore` (read/inspect the XP source, setup) or `target-sitecore` (provision/write the SitecoreAI target) — passing the script body as `script` and the params as `parameters`.
3. Each param in the script's **`.INJECTED_VARIABLES`** header is injected as a `$variable` of the same name — pass exactly those (don't `param()`-pass or string-interpolate).
4. It's a **background job**. Yield to Kajoo's long-running job handling and wait for its automatic resume/result; do not spin on manual status polls. If the automatic result was not delivered, use `get-tool-results` to recover the exact run. A run ID or `in_progress` is pending, not success. Never continue using prior output files while the job is pending. Process only the terminal result and files returned by that run (scripts `ConvertTo-Json` their output).

## Folders
| Folder | Ops | Backed reference |
|---|---|---|
| `setup/` | `ensure-sitecore-api-key`, `get-sitecore-api-key` | `references/setup/api-key.md` |
| `sxa/` | the 17 `xmc-*` provisioning scripts (tenant/site/renderings/presentation) | `references/sxa/provisioning.md` |
| `spe/` | `get-item`, `delete-item`, `sitecore-move-item`, `scan-path-references`, `sitecore-clear-caches`, `get-rendering-source-keys`, `detect-duplicate-items`, `remediate-duplicate-items` | `references/spe/*.md`, `references/serialization/error-recovery.md`, `references/serialization/health-check.md` |
| `analysis/` | dependency-driven `xp-discovery-v3.ps1` collector, `discovery-evidence-adapter.mjs`, bounded recovery collectors and local normalization | discovery / `references/discovery/content-analysis.md`, `references/discovery/discovery-script-inventory.md`, `references/sxa/*` |


## Execution boundary

Use connector-backed GraphQL, SPE execution, job results/cancellation,
item/layout operations, package/SPE patch installation and XMC REST
collection/site/publishing operations only after verifying their runtime
availability. Native context/evidence files and the dispatch references define
the task boundary.

Executable contracts and prerequisites: [analysis](analysis/README.md),
[capture](capture/README.md), [serialization](serialization/README.md). The
composable remote analysis/capture samples require `remote-common.ps1`: run
local `prepare-request.mjs` to compose the tool arguments, then submit through
the source connector. Standalone setup/SXA/SPE scripts retain their
injected-variable convention. The serialization directory includes local
inspection/planning processors plus an authenticated CLI wrapper that receives
only per-command role environment variables from foreground Bash.

SPE accepts script and structured parameters; background defaults true. A bounded foreground call may still return a runId, requiring explicit same-connector polling. output.mode=files saves ordinary output.json, while a kajoo-export manifest declares streamed remote files. Inspect the resolved destination/manifestPath/fileCount and retain durable evidence outside temporary output. Credentials stay with connectors.
