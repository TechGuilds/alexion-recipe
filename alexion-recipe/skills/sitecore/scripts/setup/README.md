# Sitecore setup scripts (run via `run-powershell-script`)

Ready-to-run SPE scripts for setup operations. Each is the **relocated single source of truth** for an operation the former dedicated MCP tool used to run — you run it through the generic Sitecore PowerShell tool instead.

## How to run one
1. **Read** the script (native `read`).
2. **Run** it via `run-powershell-script` on the correct connector — usually `source-sitecore` for setup — passing the script body as `script` and named values as `parameters`. Each parameter key in the script's `.INJECTED_VARIABLES` header is injected as a `$variable` of the same name (do not `param()`-pass or string-interpolate).
3. The default background job resumes the chat with its terminal result. Use `get-tool-results` only if
   the terminal result was not delivered or a bounded foreground call explicitly returned a run ID.
   Scripts must emit a structured JSON object (and `ConvertTo-Json` their output).

## Index
| Script | Op | Backed reference |
| --- | --- | --- |
| `ensure-sitecore-api-key.ps1` | Create/repair the source API Key item (`New-Item -ForceId` so the GUID matches the connector header) | `../../references/setup/api-key.md` |
| `get-sitecore-api-key.ps1` | Read an API Key item by GUID (bypasses SPE cache) | `../../references/setup/api-key.md` |
| `probe-topology.ps1` + `classify-topology.mjs` | Probe a connected source (remote, `run-powershell-script`) and classify topology (XP/XM), role (CM/CD/Standalone/.../XMCloud) and Headless Services install state (local, no SPE round-trip) | `../../references/setup/topology-and-prerequisites.md` |
| `probe-sites.ps1` + `filter-sites.mjs` | Enumerate a connected source's sites (remote) and strip Sitecore's own system/chrome sites down to real candidates (local) — fallback for when the user doesn't know their site path | `../../references/setup/site-enumeration.md` |
| `probe-spe-execution.ps1` | Verify one harmless authenticated SPE read and emit a small structured result | `../../references/setup/capability-requirements.md` |
| `evaluate-prerequisites.mjs` | Apply migration-type and workflow-mode requirements to normalized independent probe results | `../../references/setup/capability-requirements.md` |

## Setup capability procedures

Before calling the tools below, read [configuration preflight and routing](../../references/setup/capability-requirements.md#configuration-preflight-and-service-routing). Check configuration presence first; do not invoke a known-unconfigured service simply to produce a failing tool call. Record missing-setting names and a next action, then evaluate the selected migration's requirements. Independent configured services must still be assessed.

Run each procedure independently. Do not combine them into a fabricated PowerShell aggregate: an invocation failure must not hide the result of another capability check.

| Capability | Required procedure | Valid result and next action |
| --- | --- | --- |
| Topology and preliminary HS install signal | Run `probe-topology.ps1`, then `classify-topology.mjs`. | Record the classifier result as preliminary evidence only. It does not prove or diagnose Layout Service readiness. |
| Source site and language | Run `probe-sites.ps1`, then `filter-sites.mjs`; ask the user to choose from the valid envelope. | Before a site exists, site-dependent Layout readiness is `needs-site-selection`, not a configuration failure. |
| Item Service authenticated read | Call `get-item` for `/sitecore/content` in `master`. | A returned item proves the connector's Item Service read path. Preserve only sanitized identity/status evidence. |
| SPE execution | Run `probe-spe-execution.ps1` through `run-powershell-script`. | `status: ready` is the independent script-execution result. Do not let a later download-path result erase it. |
| SPE download path and SPE-1322 | Call `install-spe-1322-patch` with `dryRun: true`; retain its terminal pre-probe and classification. `download-file` remains available for scoped read-only evidence where a known safe path is required. | This tests the connected SPE download path; it needs no package URL and must not download or install a package. An absence-of-symptom `PreProbe` is not a verified download. Follow the recovery reference and verify an existing safe file before recording download readiness; source classification matters separately for any proposed overwrite. A vulnerable pre-probe is blocking until separately approved repair and re-probe. |
| GraphQL authenticated access | Only after confirming an endpoint and a supported authentication configuration, call `graphql-query` on the source connector with `{ __typename }`. | Only a successful GraphQL JSON result establishes readiness. HTML, transport errors or failed authentication remain unavailable with diagnostics; record a verified Item Service alternative when allowed instead of repeating GraphQL-based Layout calls. |
| Layout Service | Only when the REST CM URL and API key exist and the user has selected a site/language, call `sitecore-get-layout` with route `/`, the selected site/language and `source: "rest"`. Otherwise record missing configuration or pending site selection without calling it. | Before selection this is `needs-site-selection`. Preserve the structured `unlicensed` or `apikey-invalid` verdict when returned. Do not substitute GraphQL success or static config/DLL inspection for the authenticated REST Layout Service response. |
| Management Services | Call `test-management-services` on each connector where the selected migration type requires it. | Use the returned `ready`, `unauthorized`, `missing`, `unreachable` or `probe-unavailable` verdict. The tool owns OAuth and never exposes credentials. |

After independent probes finish, write a normalized input document and run:

```sh
node scripts/setup/evaluate-prerequisites.mjs --input setup-capabilities.json
```

The evaluator reads `assets/setup/capability-requirements.json` and `assets/setup/hs-package-matrix.json`. Its `status`, blockers, applicability and recommendations are the gate input; the agent must not promote warnings or optional/mock-replaceable capabilities into blockers. Preserve the evaluator output as `reports/setup-prerequisites.json` together with evidence paths and remediation ownership.

For a PowerShell argument-binding, parameter-schema, serialization, or known invocation-shape error, preserve the first terminal evidence and make one corrected retry immediately. Do not ask the user to approve that non-mutating retry; do not repeat it after the retry fails.

Run the pair like `capture/export-layouts.ps1` + `capture/normalize-baseline.mjs`: submit `probe-topology.ps1` (no parameters; use the default background job so the runtime waits for completion and resumes the agent) through `run-powershell-script`, save its terminal JSON result to a file, then run:
```sh
node scripts/setup/classify-topology.mjs --input probe-result.json [--hs-http-probe-ok]
```
`--hs-http-probe-ok` requires a separate live HTTP check of the Layout Service endpoint (e.g. `frontend-migration/scripts/probe-render.mjs`); omit it to default to `false`, which only affects the `installed` vs `partial-or-misconfigured` distinction. **Sitecore 9.0+ sources only** — see the script's `.INJECTED_VARIABLES` header for why. Historical extraction provenance: `b988214b4^:packages/kajoo-sitecore/src/topology/{topology-probe-script,topology-classifier,types}.ts` and `apps/sitecore-mcp-server/src/tools/topology/get-topology.ts`. Tests: `node --test tests/topology-classify.test.mjs` (the probe itself has no automated test — like `get-sitecore-api-key.ps1`, it needs instance-backed verification; do not claim Sitecore/SPE compatibility from test doubles).

`probe-sites.ps1` + `filter-sites.mjs` follow the same remote-probe/local-filter split. Present the returned `list` to the user for confirmation — it discovers candidates, it never auto-selects one. See [site-enumeration.md](../../references/setup/site-enumeration.md) for the full contract. Historical extraction provenance: `b988214b4^:packages/kajoo-sitecore/src/sites/{sites-classifier,enumerate-sites,enumerate-sites-script,types}.ts`. Tests: `node --test tests/sites-filter.test.mjs`.

> Headless Services install and the SPE-1322 patch are **not** scripts here — they stay as dedicated tools (`install-package`, `install-spe-1322-patch`) because of their multi-step polling / SHA-guarded / backup logic. `install-spe-1322-patch` with `dryRun: true` is also the safe prerequisite probe; it does not write. See `../../references/setup/headless-services-install.md` and `../../references/setup/spe-1322-patch.md`.
