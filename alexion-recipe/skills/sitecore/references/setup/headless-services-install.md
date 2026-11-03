# Installing Sitecore Headless Services (on a live XP instance)

How `sitecore-developer` installs Headless Services (HS) on a live XP instance via the **`install-package`** tool. Operational reference — the install/verify mechanics. The hub supplies verified version-compatible package metadata (`url`, `sha256`, `fileName`) with vendor provenance. The removed capability matrix is not available; missing metadata blocks installation.

## What HS is / when to install
Headless Services adds the **Layout Service** and JSS server components to an XP instance, enabling headless/JSS delivery. Install only when the instance's HS verdict is `not-installed` — get this verdict from [`probe-topology.ps1` + `classify-topology.mjs`](../../scripts/setup/) (`hsInstall` field; see [topology-and-prerequisites.md](topology-and-prerequisites.md)) — and a `recommendedPackage` (url + sha256 + fileName) is available. Sitecore downloads the package server-side via SPE, so the URL must be reachable from the CM's outbound network.

## Anchor checks (post-install verification)
`install-package` accepts anchor arrays it verifies after install. For HS, always pass:
```json
{
  "verifyAssemblies": [
    "Sitecore.LayoutService.dll",
    "Sitecore.JavaScriptServices.AppServices.dll",
    "Sitecore.JavaScriptServices.ViewEngine.dll"
  ],
  "verifyConfigs": [
    "Sitecore\\LayoutService\\Sitecore.LayoutService.config",
    "Sitecore\\JavaScriptServices\\Sitecore.JavaScriptServices.config"
  ],
  "verifyItems": []
}
```
`verifyAssemblies` paths are `bin/`-relative; `verifyConfigs` paths are `App_Config\`-relative (the tool resolves both server-side). No item anchors are needed — HS items are confirmed by the post-install compatibility re-probe instead.

## `install-package` call shape
```jsonc
{
  "packageUrl":      "<recommendedPackage.url>",
  "packageName":     "<recommendedPackage.fileName>",
  "expectedSha256":  "<recommendedPackage.sha256>",
  "installMode":     "Overwrite",
  "mergeMode":       "Merge",
  "skipDownloadIfExists": false,
  "verifyAssemblies": [ /* from anchors above */ ],
  "verifyConfigs":    [ /* from anchors above */ ],
  "verifyItems":      [],
  "database":         "master",
  "recoveryWaitMs":   30000,
  "pollIntervalMs":   10000,
  "pollMaxAttempts":  60,
  "staleStatusTtlHours": 24,
  "dryRun":           false
}
```
`pollMaxAttempts: 60` × 10s ⇒ ≤ ~10 minutes of polling. HS installs typically finish in 2–4 minutes including the AppDomain recycle; 10 minutes covers slow disk / slow first-request paths.

## Async result
`install-package` returns `{ runId }` immediately and runs server-side; retrieve terminal results through `get-tool-results` on the same connector; `cancel-tool-run` requests cancellation; verify resulting state because remote installation may already have side effects.

## Verification
A successful install envelope is **necessary but not sufficient** — always confirm with a **post-install compatibility re-probe**: re-run `probe-topology.ps1` + `classify-topology.mjs` and confirm `hsInstall` is now `installed` (both core DLL anchors present + a live HTTP check of the Layout Service endpoint succeeding — pass `--hs-http-probe-ok` after confirming that separately, e.g. with `frontend-migration/scripts/probe-render.mjs`). `hsInstall: partial-or-misconfigured` means the DLLs landed but the endpoint isn't responding — investigate before declaring success.

## Failure modes
| Scenario | Meaning |
|---|---|
| `expectedSha256` mismatch | install aborts pre-install (`package-sha-mismatch`) |
| anchor file missing post-install | `anchor-missing` — which anchors are surfaced in the envelope |
| install completes but re-probe still `not-installed`/`partial-or-misconfigured` | `post-install-probe-failed` |
| AppDomain never recovers | internal timeout (`install-timeout`) |
| user cancels mid-install | `cancelled` |

Do not retry automatically — surface the failure and let the user/orchestrator decide.

## Hard rules
- Always pass the SHA from `recommendedPackage.sha256` — the only protection against a hijacked download URL; never strip it.
- Never call `install-package` with a `packageUrl` other than `recommendedPackage.url` (the capability matrix is the source of truth).
- Never bypass the post-install re-probe.
- Production instances: `install-package` doesn't auto-install on production — surface the install request for the services team.
