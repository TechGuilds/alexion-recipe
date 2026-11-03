# Setup capability requirements

Setup probes capabilities independently, then evaluates them against the selected Sitecore migration type and workflow mode. This prevents one failed invocation from hiding unrelated evidence and keeps migration-specific policy out of the generic CMS workflow.

The machine-readable policy is `../../assets/setup/capability-requirements.json`; Headless Services package compatibility is `../../assets/setup/hs-package-matrix.json`. `../../scripts/setup/evaluate-prerequisites.mjs` is the only classifier. Do not reproduce its decision table in an agent prompt or improvise a different blocker policy.

## Capability model

- `xpheadless2sai`: Headless Services installation/license, Layout Service, SPE script execution/download, Management Services and one authenticated content-read path are required.
- `xpmvc2sai` and `xpmvc2xpheadless`: Layout Service is mock-replaceable and the Headless Services license is not applicable. Installation remains required for a full migration but is optional for discovery-only work. SPE, Management Services and one content-read path remain required.
- `contentRead: either` means Item Service or GraphQL may satisfy the authenticated read gate. A failure in one does not block when the other is ready.
- `needs-site-selection` is a pending input state, not a Layout Service fault. Run site enumeration/selection and then make the authenticated Layout call.
- `probe-unavailable`, canceled, stale, empty or timed-out evidence does not satisfy a required capability.
- SPE-1322 `affected` remains blocking until a separately approved repair and healthy post-probe. Dry-run itself does not authorize mutation.

Unknown migration types fail closed. An unsupported topology/kernel match produces no package recommendation; never install the newest package by assumption. Package URLs and checksums are data owned by the Sitecore profile, not generic migration instructions.

## Configuration preflight and service routing

Use the v1 probe-then-confirm behavior through the current independent procedures and evaluator, not the retired `migration-get-info` tool. Before probing, resolve the selected connector/role and inspect which required setting names are present using available connector metadata. Never print secret values. For REST Layout, check the CM URL and API key; for GraphQL, check its endpoint and a supported authentication configuration (XP can use an API key, Identity Server or SSC credentials; absence of an API key alone does not disable every GraphQL auth path). Check each other service's own required settings independently; missing PowerShell settings do not disable configured XM Cloud REST operations.

- Missing required configuration: record `unreachable` with the missing setting names, `terminal state: not-invoked`, remediation owner and next action to configure/re-probe. Do not pretend a request was sent, install a module by assumption or call the tool repeatedly to rediscover those missing settings. If connector metadata is inaccessible, record that access limitation rather than inventing configuration facts.
- Required authenticated tool not exposed: record `probe-unavailable`, required tool and integration owner. Do not confuse this with missing client configuration. Pending site/language selection remains `needs-site-selection`; do not probe an invented site.
- Probe inputs must come from verified connector/site facts: use the documented `/sitecore/content` read for Item Service readiness, not an invented GUID. Validate the format of any ID before submitting it. Use a bounded read-only SPE existence/enumeration check for optional platform folders rather than a sequence of guessed SXA/presentation paths. A confirmed absent optional folder is an absence finding, not proof that Item Service is broken.
- Configured service: run one focused authenticated probe. `ready` requires a successful expected payload. HTML/error pages, parsing errors, canceled/timed-out calls and an available tool name do not establish readiness. Preserve the diagnosis and use the existing documented bounded recovery; do not switch from failed GraphQL to another GraphQL-dependent call as if it were independent evidence.
- Run `evaluate-prerequisites.mjs` with every observed verdict and the confirmed migration type/mode. Required capability failures stop progression until repaired/re-probed or explicitly changed scope is evaluated again. Optional/mock-replaceable failures stay visible without becoming false global blockers. Do not relax the policy just because another tool happened to run.
- For authenticated content reads, use the evaluator's `use-item-service` or `use-graphql` recommendation only when that alternative is verified `ready`. If neither is ready, content-read readiness is blocked; working SPE can assist diagnosis but does not silently replace this gate. GraphQL readiness does not satisfy required REST Layout readiness. `use-mock-layouts` is only a profile-permitted downstream option and is never claimed as live Layout evidence.

Persist these results and recommendations in the existing Setup prerequisite report/role evidence under the correct connector identity. Tell the user what is missing, whether it blocks their chosen scope, and the usable alternative or required action. Re-probe only the affected capability after configuration/repair; retain compatible successful results. Later workers must consult this report before selecting services and avoid unavailable services until updated, matching evidence shows they are ready.

## Evidence input

The evaluator input records only normalized verdicts plus non-secret topology/site facts. Keep raw/sanitized connector output under the task evidence directory and reference it from `reports/setup-prerequisites.json`. Required evidence includes probe method, connector role, terminal state, verdict, evidence path, remediation owner and next action. Never copy credentials or access tokens into the input, report, context or migration artifact.

Use this shape (values are examples, not defaults):

```json
{
  "migrationType": "xpheadless2sai",
  "workflowMode": "full-migration",
  "capabilities": {
    "topology": { "verdict": "ready", "topology": "xp", "kernelVersion": "10.4.1" },
    "headlessServices": { "installed": "ready", "licensed": "ready" },
    "itemService": { "verdict": "ready" },
    "graphql": { "verdict": "ready" },
    "layoutService": { "verdict": "ready" },
    "managementServices": { "verdict": "ready" },
    "spe": {
      "scriptExecution": "ready",
      "fileDownload": "ready",
      "issue1322": "not-affected"
    },
    "siteSelection": { "verdict": "ready", "site": "example", "language": "en" }
  }
}
```

Normalize evidence as follows:

- `probe-spe-execution.ps1` `status: ready` maps to `spe.scriptExecution: ready`.
- The SPE-1322 dry-run `PreProbe.verdict: healthy` means its symptom probe did not identify #1322; it is not sufficient to mark `spe.fileDownload: ready` or `spe.issue1322: not-affected`. Before recording readiness, verify transfer of one known existing nonsensitive file against byte length and SHA-256 read through SPE, following [spe-1322-patch.md](spe-1322-patch.md). Use file-output mode and task-local sandbox evidence; do not create a probe file on the client. Until verified, record `fileDownload: unknown` and `issue1322: unknown`, with the failed check and next action. Redirects, HTML/error responses and incomplete exports require the same diagnostic flow, even after an earlier healthy result.
- `PreProbe.verdict: vulnerable` or matching server-log evidence of `Settings.get_IndexFolder()` in the SPE download handler maps to `fileDownload: needs-patch` and `issue1322: affected`; an unreachable probe maps to `fileDownload: unreachable` and `issue1322: unknown` unless logs independently confirm #1322. A verified successful file transfer maps to `fileDownload: ready` and `issue1322: not-affected`. If source classification is `unknown-source-ashx` despite verified transfer, record a warning for any future patch; it does not authorize overwrite.
- The explicit REST Layout probe maps success to `layoutService: ready`, typed license failure to `unlicensed`, typed API-key failure to `apikey-invalid`, confirmed 404 to `missing`, and other transport failures to `unreachable`. A ready REST response is final evidence that Headless Services is installed and licensed. `unlicensed` proves installation but not the required license. Static DLL/config signals stay preliminary and never become a final Layout verdict.
- Item Service and GraphQL each map only a successful authenticated response to `ready`.
- `test-management-services` already returns the normalized management verdict.
- Site enumeration never selects a site. Only the user's recorded site/language choice maps `siteSelection` to `ready`.
