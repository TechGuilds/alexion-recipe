# Prepare and validate source content

## Purpose and boundaries

Prepare one reusable source snapshot from approved scope and existing evidence. This operation performs local file processing and generates requests for missing data. It never submits a connector request, writes target content, changes mappings or grants approval.

Supported input adapters are explicit. Unknown formats are rejected; Discovery reports that only describe templates/renderings cannot supply missing content values. Reuse compatible field values and rendering context before requesting additional reads. Sitecore serialization YAML is not an implemented adapter.

The local preparation, validation and bounded SPE exporter are available. Verify the selected source connector's SPE capability, then run one small approved batch and check its result before a site-wide capture. Headless Services alone does not establish SPE access.

## Input

`prepare-source-input.schema.json` defines a JSON request containing:

- `version: 1` and `scope`: common `scopeId`, explicit instance/database, `sourceStateId`, roots, languages and the exact required items/versions/fields and rendering contexts.
- `evidence`: declared relative paths, exact SHA-256, adapter format, source identity, source-state identity and original capture time.
- Optional limits: `maxPartBytes` (default 4 MiB, maximum 8 MiB), `maxRecordsPerPart` (default 200, maximum 1,000), `maxItemsPerCapture` and `maxContextsPerCapture` (default 50 each, maximum 100 each).

Each required item identifies its source ID, path, template, exact numeric language/version tuples and field IDs/sharing modes. Include `referenceKind` for fields whose references must be captured: `link`, `list`, `media` or `datasource`. Parameter requirements identify the exact source page, device, language/version, rendering UID/definition and parameter template/field IDs. Their owning page/version must also appear in the approved item scope.

Capture now includes verified source `fieldType` metadata. An optional requirement `fieldType` is checked against the actual definition. Native Discovery adaptation can retain a type only when the approved field-name/ID/storage binding also supplies its verified type. Missing legacy type metadata is not invented; transformation requires type evidence or a reviewed exact raw-compatibility decision. Include the hierarchy nodes and captured reference fields required by approved [datasource ownership](ownership.md), even when those nodes are excluded from content output.

The coordinator derives this scope from approved Discovery and mappings. The preparer does not rediscover a site or infer field IDs, defaults or versions from names. Resolve `latest` or all-version policies into explicit observed version tuples before preparation. Required source fields include values read by approved `map` actions and necessary reference/context fields; constants and removed fields do not need value capture unless another rule consumes them.

`sourceStateId` is a coordinator-confirmed evidence cohort, not an automatic Sitecore revision or transaction. Reuse requires an approved basis for source consistency, such as a controlled source freeze or verified unchanged revisions. A matching string, timestamp or file hash alone cannot prove live freshness. If source consistency cannot be established, obtain a refresh decision and recapture the affected scope rather than relabeling old evidence.

## Supported evidence

| Format | Reuse conditions |
| --- | --- |
| `snapshot-json` | Existing version-1 source snapshot, matching instance/database/scope and capture time; the descriptor binds its confirmed source state. Legacy JSON is capped at 16 MiB. |
| `snapshot-manifest` | Partitioned snapshot with matching source state and verified part hashes/counts. Reuses partial as well as complete captures, with coverage recalculated. |
| `capture-jsonl` | Downloaded bounded exporter response, including matching header and terminal completion/counts. Use the actual capture-header timestamp in the evidence descriptor. Successful records from a partial response may be reused; gaps remain visible. |
| `discovery-items-jsonl` | Native `discover-site` item rows with raw fields. Reuse requires explicit field-name-to-ID/storage bindings and verified parent IDs in the approved scope. Ambiguous field names, null/absent values and insufficient identity data remain gaps. These rows do not prove reference extraction or rendering-context coverage. |
| `discovery-summary` | Records that the report was considered; no content values are inferred. Preparation requests the missing data. |

Evidence for a different source identity is rejected. Evidence with a different source-state identity is excluded as stale. Conflicting identity metadata or values in the same confirmed state cause failure; no last-writer-wins merge is performed. Stale/summary artifacts are not read or hash-verified because their values are not reused; provenance records their declared hash and excluded status.

Capture headers must conform to [capture-header.schema.json](../contracts/capture-header.schema.json): version 1 and `valueMode: effective`, matching source/state/request identities and capture time. Terminal records must conform to [capture-completion.schema.json](../contracts/capture-completion.schema.json), with matching request ID, actual counts and consistent partial/limit flags. Unsupported versions, stored-value semantics, malformed completion or data after completion fail preparation. Compatible same-state type metadata may enrich an identical value; conflicting captured types still fail.

## Local preparation

Run from the skill's `scripts/` directory using actual assigned paths:

```sh
node prepare-source-snapshot.mjs --input /workspace/source-preparation.json --output /workspace/new-source-snapshot
```

The output parent must exist and the output directory must not exist. Preparation never overwrites a prior attempt. It reads one bounded legacy JSON document or streamed JSONL input, spools selected values to task-local files and writes bounded parts. The spool is removed after successful publication. An interrupted/failed output directory is not a valid snapshot merely because it contains files; use the saved result and validation before reuse, and use a new directory for another attempt.

Outputs:

| File | Meaning |
| --- | --- |
| `source-snapshot.json` | Manifest referencing immutable JSONL parts with hashes, byte/record counts, source identity/state and provenance. `capturedAt` reflects reused capture evidence; `preparedAt` records local assembly time. When no evidence was reusable the incomplete empty manifest uses preparation time. |
| `part-*.jsonl` | Item and rendering-context records. A part never exceeds the configured byte or record limit. |
| `coverage.json` | Requested/captured items/contexts, missing field/version/context requirements, readiness and generated capture-request descriptors. It is evidence, not approval or workflow state. |
| `requests/capture-*.json` | Source-connector argument envelopes containing the bundled script, structured `Request` parameters, background execution and file-output mode. Created only for gaps. |

Exit 0 means required snapshot coverage is ready for review. Exit 2 means preparation succeeded but missing data requires capture. Exit 1 means an input, integrity, conflict, limit or filesystem failure. `valid` and `ready` have distinct meanings; no exit code authorizes transformation or target writes.

Capture requests select missing fields and exact numeric versions. Shared fields are requested once and unversioned fields once per language. Metadata-only reads can be requested when values are already available but version/identity evidence is missing. Requests do not traverse descendants. A single item/context record larger than the configured part limit is rejected explicitly; the implementation does not silently truncate it or split a field value across records.

## Source capture and resume

1. Present the gap report and exact generated requests to the coordinator for current source-read approval. Retain the approved envelope hashes, source connector identity and request IDs in the assigned attempt evidence.
2. Submit only the reviewed envelope through the source connector's supported `run-powershell-script` interface. If it supports file-based prepared requests, use the verified workspace-relative path and matching hash. Do not execute SPE in the local sandbox or invent an endpoint/parameter convention.
3. Record submission/run IDs before another invocation. Await the terminal result. Recover that same run if delivery is interrupted; never resubmit a pending or unknown request. Follow [recovery](recovery.md).
4. Download the terminal `kajoo-export` files unchanged. Hash the downloaded `capture.jsonl`, read its header timestamp, record terminal job evidence, and add it as `capture-jsonl` evidence to a new preparation request. The report's display alias does not independently verify the physical server identity; retain connector identity and item checks.
5. Include original compatible evidence or the prior partitioned snapshot. Prepare into a fresh output directory. Reuse captured values, recalculate gaps and submit only newly approved remaining requests.
6. After coverage validation and user review, supply the manifest descriptor and confirmed source-state evidence to Content Migration. All batches reuse that reviewed snapshot unless source/scope changes invalidate it.

The exporter reads effective Sitecore field values, preserving explicit empty strings, field IDs and actual sharing modes. It verifies exact item/path/template/language/version and optional parent identity. It reads selected final-layout occurrences only for requested parameter context; it does not flatten SXA designs or assign presentation. Local/query datasource strings that cannot be verified as the requested GUID remain capture errors and require explicit Discovery resolution.

Reference extraction supports GUID lists/datasource fields and XML link/image fields with `id`/`mediaid` attributes. It preserves raw values and reference ordering. Rich-text HTML links, path/query references and other formats are not reference adapters here; identify them as required gaps/dependencies rather than claiming complete reference extraction. No media binaries are transferred. The capture uses real source field-ID lookup; test-fixture name inference is never used against Sitecore.

The response is bounded by `maxResponseBytes`. Oversized records or accumulated output produce partial evidence and leave requirements unfulfilled. Reduce the approved batch or review the allowed record limit; do not loop automatically or mark truncated output complete.

## Coverage validation

Create a `validate-snapshot-input.schema.json` request containing `version: 1`, the exact approved `scope`, and a relative `snapshot: { path, sha256 }` descriptor. Then run:

```sh
node validate-snapshot.mjs --input /workspace/snapshot-validation.json
```

This verifies the manifest/part hashes, sizes, counts, unique identities, scope/source-state match and required metadata/field/version/reference/context coverage. Exit 0 requires `valid: true` and `ready: true`; otherwise exit 1. It performs no writes or remote calls. Coverage proves presence of the declared requirements, not source freshness, completeness of upstream Discovery, target compatibility or migration approval.

`validate-inputs.mjs` also accepts a partitioned manifest as `migrationInput.sourceSnapshot` and checks semantic input relationships without loading all content values at once. It retains identity/version/context indexes proportional to record count; this is bounded content buffering, not constant total memory. Legacy source JSON and other JSON inputs have a 16 MiB read limit. Full readiness requires the separate coverage check and current coordinator decisions.
