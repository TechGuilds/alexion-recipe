# Native source capture and immutable baseline normalization

PowerShell entrypoints execute in authenticated source SPE. The local request composer prepends scripts/remote-common.ps1; export-layouts.ps1 reuses its Start-KajooExport, Write-KajooRecord, Add-KajooError and Complete-KajooExport helpers. Never upload an API key value, embed one in a script or run SPE locally.

| File | Contract |
| --- | --- |
| export-layouts.ps1 | Actual REST Layout Service bytes plus route statuses, hashes and completion summary (headless/content baseline) |
| fetch-layouts.mjs | Approved-plan capture with exact selected pages and fresh attempt receipts; legacy bounded capture: sitemap first, GraphQL fallback, homepage first, cached hierarchical `index.json` output; API key comes from the source connector environment |
| export-dictionary.ps1 | Sibling source dictionary export; see its explicit roots/domain parameters |
| export-richtext.ps1 | Sibling scoped original HTML export; no script execution |
| capture-mock-layouts.ps1 | License-free MVC mock-layout capture using the source CM serializer and route bundles |
| capture-mock-dictionary.ps1 | MVC dictionary-domain/key capture for mock i18n; captures all source locales when no language filter is supplied |
| export-richtext-structures.ps1 | Rendering/datasource-centered rich-text structure export |
| normalize-baseline.mjs | Local, explicit raw-file to mock-output mapping; byte-preserving, no inferred rewrites |
| build-mock-dictionary.mjs | Local: a complete `dictionary.jsonl` to `<site>/<language>.json` flat maps; duplicate precedence is an explicit flag |

## Layout capture parameters

### Approved discovery-plan capture (headless and MVC)

Use the approved `rendering-capture-plan.json` produced from discovery scope.
A synthesis draft is not approval: these scripts reject `draft:true`, a missing
plan, an invalid fingerprint, unsafe routes or mismatched source identities.
Scope approval and deriving an approved plan remain workflow responsibilities;
never change the draft flag manually to bypass review.

1. Prepare a new attempt with `prepare-capture-request.mjs`:

```sh
node scripts/capture/prepare-capture-request.mjs --params /evidence/prepare.json --output /evidence/capture-request.json
```

Example preparation parameters (all paths absolute):

```json
{
  "mode": "headless",
  "capturePlanFile": "/evidence/rendering-capture-plan.json",
  "layoutServiceUrl": "https://source-cm.example.com",
  "siteName": "source-site",
  "outputDir": "/evidence/attempt-1/mock-layouts",
  "captureResultFile": "/evidence/attempt-1-result.json"
}
```

2. For headless, attach the source connector to Bash and run:

```sh
node scripts/capture/fetch-layouts.mjs --params /evidence/capture-request.json
```

Plan mode requests the selected pages only. It does not use a sitemap, GraphQL
crawl, extra homepage or cached outputs. Omitted `maxUrls` or `0` captures all
selected pages; a positive value caps total page attempts, including failures,
not pages per group. The cap also applies across declared recovery attempts.
Every attempt uses a new/empty output directory and writes a result manifest
with source IDs/paths, failures and SHA256 hashes. Existing outputs are never
counted as successful new captures. Copy verified outputs into the app's
`public/mock-layouts/<route>/index.json` only at the deployment/scaffold stage;
these helpers do not mutate the app or publish content.

For MVC, set `mode:"mvc"`, supply `sitePath` to the source invocation and use the
prepared `routePlan`, `selection` and `capturePlanFingerprint` as injected SPE
parameters with `capture-mock-layouts.ps1`. Execute through the existing source
PowerShell request transport. Preserve its immutable manifest and raw bundles;
extract those bundles into a separate raw directory with safe archive handling.
Then use `assemble-mvc-captures.mjs --params <assembly-params.json>` with
`capturePlanFile`, `rawRoot`, `manifestFiles`, `outputDir` and `resultFile`.
The native assembler preserves nested renderings and emits the same verified
layout/result contract. It does not require the old backend assembly tool.

3. Process only explicitly declared result manifests:

```sh
node scripts/capture/process-capture-results.mjs --params /evidence/report-params.json
```

```json
{
  "capturePlanFile": "/evidence/rendering-capture-plan.json",
  "captureResultFiles": ["/evidence/attempt-1-result.json"],
  "outputDir": "/evidence/report-1",
  "maxAlternativePages": 5,
  "maxAlternativesPerRequirement": 1
}
```

The report verifies each file hash, route and stable rendering/variant identity.
A component name alone is not proof. Headless responses often omit rendering
IDs: provide `mappingInventoryFile` (the source `rendering-mapping-inventory.json`)
and its exact byte `mappingInventorySha256` in report parameters to prove identity
through page-local instance UIDs. The processor checks the inventory hash and
matches source item, route, language, rendering and variant; stale occurrences
cannot verify another page. Keep that same inventory/hash for subsequent reports. Captured page metadata cannot substitute
for the item ID in the actual response. Missing identity evidence stays
unverified. Placement/datasource/nonvariant parameter differences are warnings
when source comparison evidence exists; otherwise consistency is explicitly
`not-evaluated`. Unused definitions remain mapping-only, without synthesized
page examples in this step.

The processor writes `rendering-coverage-report.json` and, when eligible,
`next-capture-request.json`. Recovery prepares a bounded request; it does not
start network work, poll or create a background job. Merge that request with the
endpoint/site and a fresh output directory, prepare it, then capture explicitly.
Declare every earlier result manifest when processing recovery and retain the
original `totalMaxUrls` budget. Set `maxAlternativePages:0` to disable alternatives.
Never conceal failed or inaccessible pages when another page covers the rendering.

`normalize-baseline.mjs` remains the separate byte-preserving REST baseline
normalizer. Its raw export/mapping contract is unchanged; it does not select
preview pages or claim rendering coverage.

### Legacy code-side route-layout capture



When code Discovery explicitly needs route fixtures and no verified route list is
already available, run the Node helper once in the foreground through Bash with
`mcpCredentials.source` set to the selected source connector:

```sh
node scripts/capture/fetch-layouts.mjs --params /evidence/layout-fetch-params.json
```

The Bash tool resolves that connector and injects `SOURCE_SITECORE_GRAPHQL_API_KEY`;
the helper itself performs the Layout Service and GraphQL HTTP requests. The
GraphQL fallback is therefore not a separate `graphql-query` MCP invocation and
must not be replaced with one request per route. Keep the command foreground and
preserve its original exit status when printing diagnostics (`rc=$?; echo
"Exit: $rc"; exit "$rc"`).

The parameter JSON contains only `layoutServiceUrl`, `siteName`, `outputDir`
and optional `sitemapUrl`, `graphqlUrl`, `language`, `routes`, `startIndex` and
`maxUrls` (`25` by default; `0` explicitly means all discovered routes). The helper reads `SOURCE_SITECORE_GRAPHQL_API_KEY` from the
connector-injected environment, rejects credential fields, writes the
homepage-first hierarchical mock-layout tree, reuses existing route files and
returns per-route counts/errors. `totalUrls`/`discoveredUrlCount` describe the
uncapped discovered scope; `attemptedUrls` describes the selected run and
`maxUrlsApplied` identifies a capped sample and `skippedCount` identifies
routes outside a resumed `startIndex` that were not already cached. A completed
run that captures one or more layouts exits zero even when individual routes
fail; its `Result.errors` and counts remain the authoritative partial-evidence
record. A non-zero exit means no layout was captured or the helper reached a
terminal discovery/authentication/invocation failure. Preserve the `Result`
JSON and do not treat missing routes as unused renderings. This helper is distinct from the whole-site
collector and from `export-layouts.ps1`: it does not replace either content
evidence path.

Use prepare-request.mjs with operation `export-layouts` for a Layout Service
batch, or `capture-mock-layouts`, `capture-mock-dictionary` and
`export-richtext-structures` for the corresponding MVC/runtime evidence paths.
The operation names select shipped scripts; parameters still contain no
credentials. Example parameters contain no credentials:
```json
{
  "operation": "export-layouts",
  "background": true,
  "parameters": {
    "ApprovedOrigin": "https://source-cm.example.com",
    "APIKeyItemPath": "/sitecore/system/Settings/Services/API Keys/capture",
    "Database": "web",
    "Version": "latest",
    "Mode": "delivery",
    "Device": "site-default",
    "TimeoutSeconds": 30,
    "MaxResponseBytes": 67108864,
    "MaxItems": 100,
    "Routes": [
      { "item": "/", "site": "source-site", "language": "en" },
      { "item": "/about", "site": "source-site", "language": "fr-CA" }
    ]
  }
}

```

ApprovedOrigin must exactly match the reserved, nonsecret $KajooSourceOrigin injected by the connector from powershellServerUrl.origin. The connector must reject user-parameter collisions with that reserved name; do not include KajooSourceOrigin in parameters. Missing or mismatched trusted origin fails closed. HttpContext is neither required nor used: SPEStartScriptSession runs asynchronously even when background=false. Both background selections use the same injected trust anchor.

No origin is inferred from content, forwarded headers or redirects. Only HTTPS is supported except HTTP on same-source loopback. Alternate CD origins, credentials in URLs and non-origin URL paths/queries/fragments fail explicitly. The remote entrypoint relies on the connector's reserved-variable injection/collision rejection; supplying an ordinary caller-controlled variable is not an equivalent trust boundary.

APIKeyItemPath must identify a source master item strictly beneath /sitecore/system/Settings/Services/API Keys. The script verifies the returned item path and uses its nonempty GUID ID as sc_apikey, entirely on the server. The key is never returned in request metadata, errors or exported files. It does not accept APIKey/Password/AccessToken values. Item read permission and Headless Services/API-key authorization must already exist.

The actual request is GET /sitecore/api/layout/render/jss with item, sc_site, sc_lang and a source-resolved sc_apikey query value, following historical 03e00d4c9 sitecore-layout-service.ts. No generic MVC/item response is fabricated. No source content is mutated.

Mode=delivery, Device=site-default and Version=latest are the only supported selections. Each route must contain exactly item/site/language; per-route overrides are rejected. A named site must resolve through SiteContextFactory and its configured database must equal Database. No sc_database/sc_device/sc_version override is invented. site-default means the site's ordinary delivery device selection, not a forced device ID. latest means the current version selected by the delivery endpoint, not a requested historical item version. Editing, preview, custom devices and database/version overrides require a separately verified capability.

## Transport and export evidence

HttpClient uses normal TLS validation, no redirects, cookies, inherited credentials or proxy. It never forwards the key to another origin. TimeoutSeconds bounds the network request/body (default 30, allowed 1..120). Optional MaxResponseBytes is a per-response resource guard, defaulting to 64 MiB; callers may select any positive safe integer through 9007199254740991. There is no fixed 128 MiB ceiling and no task-wide byte quota or maxTotalBytes dependency. Routes are explicit (1..10000); MaxItems caps attempted unique routes. Duplicate/limited routes retain failure records rather than disappearing.

A unique source Data/kajoo/skills/layouts-<guid> directory holds exclusively created flat files:

- layout-000001.json etc.: exact UTF-8 response bytes, never ConvertTo-Json output. Valid JSON with null/invalid route structure may remain as failed evidence.
- layouts.jsonl: one row per input with item/site/language, effective scope, origin/endpoint without query, HTTP status, success/error, rawFile, byte count and SHA-256 when a complete raw file is retained.
- capture-summary.jsonl: one layout-capture version 1 row with total/succeeded/failed/partial.
- errors.jsonl: shared-helper diagnostics for failures, with static error codes only.

Redirects, non-200 statuses, HTML, malformed JSON, null routes, invalid layout structures, timeouts, size limits and duplicates are failures. Incomplete/unsafe bodies are deleted before export; response bodies, reason phrases, redirect destinations and exception details are never logged. Literal/JSON-escaped echoes of the source key are rejected before export, with a retained stream tail protecting chunk boundaries. Fields, UIDs, numeric values, duplicate rendering occurrences and placeholder order are never normalized on the source.

Complete-KajooExport returns kajoo-export version 1 with Data root paths, unique flat names, sizes and summary.partial. A returned manifest is not automatically success: inspect partial, every route status and transfer completion. Submit through the source connector with background=true and output.mode=files; Kajoo waits for the job, transfers the export to the sandbox and supplies terminal results. Manual result retrieval is for recovery/status only. Retain the resolved raw directory unchanged. Interrupted transfers or missing files are not a complete baseline. Source Data files remain subject to normal source retention policy.

## Local normalization

Node 20+ and built-ins only. No monorepo installation or server credentials needed:
```sh
node scripts/capture/normalize-baseline.mjs --raw-root /evidence/raw --mapping /evidence/layout-mapping.json --output /evidence/derived-new
```

The mapping is explicit and covers every captured route once. To be read by the mock layout service, each output must be `<route>/index.json` (lowercase, `home` for the root); see [baseline delivery](../../references/discovery/baseline-delivery.md), which also covers delivery into the app and the dictionary converter:
```json
{
  "version": 1,
  "routes": [
    { "source": "layout-000001.json", "output": "home/index.json" },
    { "source": "layout-000002.json", "output": "about-us/index.json" }
  ]
}

```

Only source/output file-path mapping is implemented. No inferred site renaming, fallback, URL substitution, component normalization or field transformations occur. Output bytes equal source bytes, preserving resolver fields/wrappers, UIDs, large integers and order exactly.

The default preflight requires a complete capture summary, matching record counts, no failure flags or duplicate identities, explicit one-to-one mapping, valid Layout Service route/context/fields/placeholders, matching source hashes/sizes, safe paths and available files. Partial captures return JSON success=false with exit 2 and no output. For optional Discovery enrichment, `--allow-partial` permits delivery of all successful routes in an otherwise consistent partial capture. Map every successful route exactly once. Failed routes stay in `failedRoutes`, with requested/delivered/failed counts and `partial: true`; raw metadata is never rewritten to look complete. Zero successes, corrupt successful payloads, bad counts or incomplete mappings still fail. Invalid inputs/path conflicts return exit 1. Exit 0 proves the listed files were normalized, not full route coverage or visual/live parity.

Output must be a new directory disjoint from raw and mapping inputs; existing output is never reused or overwritten. Traversal, symlinks in raw members, linked roots, duplicate/case-colliding output names and reserved manifest.json are rejected. Source files are read only. Optional --max-bytes is a per-file resource guard, defaulting to 128 MiB; any positive safe integer is accepted, with no fixed 256 MiB ceiling or task-wide byte quota. Validation buffers one file at a time and JSON parsing/string decoding may require several times its size; a higher configured limit does not guarantee sufficient memory or remove runtime buffer/string limits. Metadata has separate limits. Capture also buffers a complete file for JSON validation after streaming, so select its per-file guard to suit source-server memory.

manifest.json records source/output hashes, byte counts, source request identity and mapping/index/summary hashes. Changed inputs during apply fail; a crash or concurrent mutation may leave an incomplete output without a success manifest. Freeze inputs and stop concurrent writers during normalization. File safeguards are not a hostile-filesystem sandbox.

## Focused tests

```sh
node --test tests/baseline-normalize.test.mjs
docker run --rm --platform linux/amd64 -v "$PWD:/skill:ro" mcr.microsoft.com/powershell:7.4-debian-12 pwsh -NoLogo -NoProfile -File /skill/tests/layout-capture.test.ps1
```

Run from the sitecore skill for the Docker mount shown. The container suite uses an actual loopback HTTP server and current HttpClient plus source-only test doubles for Sitecore settings/MapPath, site configuration and API-key item lookup, with an injected trusted origin and null HttpContext. It verifies missing/mismatched origin rejection, higher safe-integer per-file limits and the HTTP failure contract, not connector collision enforcement or a real Sitecore/SPE end-to-end deployment, resolver execution, licensing or key authorization. Actual source runtime compatibility and resolver fidelity still need source-server validation. See [Layout Service reference](../../references/headless/layout-service.md).
