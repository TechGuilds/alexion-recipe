# Independent target content verification

## Available boundary

An explicitly assigned specialist or independent tester can run the local content audit and collect bounded target read-back through the approved target connector. This verifies the whole agreed content output scope, not a sample. Verify live Sitecore/SPE compatibility through the selected connector, as described in [operational boundaries](operational-boundaries.md). Mapped-content workflow integration requires explicit workflow-plan approval through [workflow integration](workflow-integration.md). Content parity does not establish visual, presentation, functional or media binary parity.

The audit writes fresh task-owned evidence only. It never updates a journal, checkpoint, shared workflow or approval record, creates mutation batches, publishes or remediates content. The coordinator owns existing read/continuation decisions and downstream handoff.

## Input and local command

Supply a version 1 `verification-input.json` with `contentPlanInput`, `checkpoint` and `capabilities` artifact descriptors, `structuralLanguage`, a unique audit-cohort `readbackId`, and a `readbacks` array of actual downloaded file descriptors. Each descriptor selects a manifest-relative file and its exact SHA-256. Optional `maxQueriesPerRequest` is an integer from 1 through 100. Initially `readbacks` may be empty. Select the current immutable checkpoint file in its actual journal directory alongside `head.json`, not a copied or stale checkpoint and never the mutable head itself. The verifier checks the actual current head at both start and end. Receipts cannot replace the original content input or fresh target reads.

```sh
node verify-target.mjs --input /workspace/verification-input.json --output /workspace/new-verification
```

The output directory must be new. The command emits `verification-report.json`, `expected-content.json`, `target-read-requirements.json` and `readback-requests.json`. Exit 0 means ready content parity for the agreed scope; exit 2 preserves gaps, mismatches or unresolved checks; exit 1 means malformed input or integrity failure. No exit status authorizes mutation or phase completion. User confirmation remains required even when the local report passes.

The verifier reconstructs the canonical transformation from original source and mapping artifacts, rather than trusting writer receipts as expected content. It compares every planned output ID, template, path, observed parent ID, effective field value, actual `fieldType` and storage mode, agreed and preserved versions, references, folders, local/global identity and verified reuse. Checkpoint history is reported separately from parity, with a separate checkpoint-history hash. The expected-content hash includes the checkpoint as provenance while expected values are reconstructed from original source/mapping. Any journal transition invalidates prior captures: regenerate read requests against the current checkpoint and collect fresh readback; do not reuse captures after later journal changes. Reused baseline outputs require the initial planner's approved reuse and exact unchanged field values and version sets. Per-output statuses remain `success`, `reused`, `failed` and `unverified`; exclusions have a separate summary count. Pending, partial, latest-failed or unmapped captured-source outcomes prevent ready status. Explicit scope exclusions are reported separately from failed, missing and unverified outputs.

## Read-only capability and approval

The supplied capability proof binds the scope, instance, database, root, connector and instance marker. Require `speRead`, `fileDownload`, `stableReadWindow: true`, current `verifiedAt`/`expiresAt` and supporting `evidence`. `maxCaptureBytes` is 4096 through 8388608; `maxRequestBytes` is 1024 through 8388608. Each readback file is capped by the capability limit, at most 8 MiB; combined unique capture files are capped at 64 MiB per audit. Expected-content and report files retain the existing 16 MiB bound. Multiple bounded parts are supported. A `verification-size` finding requires reducing the approved audit scope before another audit; reuse the streamed original source snapshot without recapture. These are read capabilities: write access, backups, restore capability and an exclusive write window are not prerequisites for this read-only audit. A stable read window is still required to compare one coherent target state.

Missing observations generate only bounded exact-ID/path read requests locally. The coordinator must approve the exact read request scope and request hash using the existing read/continuation decision mechanism before dispatch. Use only the selected TARGET connector, even when source and target share an instance. Never run `capture-target.ps1` locally, dispatch it through the source connector or automatically submit generated envelopes.

Submit each approved envelope once through `target-sitecore/run-powershell-script`. Preserve its job ID and terminal result; recover the same job if delivery is lost. Retrieve remote export files through the terminal `kajoo-export` transfer, then create a new verification input selecting the actual readback file descriptors. A failed or absent transfer remains an evidence gap; do not fabricate readback parts from writer receipts or substitute an older supplied target state.

## Collector provenance and complete coverage

The read-only SPE collector exports bounded parts with no truncation and preserves item/field/version errors. Each capture binds `requestSha256`, `expectedSha256`, `collectorSha256`, and `targetStateId` matching the request/input `readbackId` cohort and exact target scope. It reads complete current version lists, selected scoped effective fields and observed parent IDs; a requested parent ID or path alone does not prove the observed parent. The approved envelope passes `RequestJson` and `RequestSha256`; its request contains `readbackId`. Every part and terminal completion must match the exact approved request and expected model. Mixed cohorts, stale scope, altered collector or missing parts cannot pass.

Earlier supplied target-state observations lack this audit provenance and cannot establish independent parity. Writer operation read-back and successful receipts remain checkpoint evidence; neither can be relabeled as collector output. No unrelated tree enumeration is allowed to fill gaps. Read only the exact content, structural and reference identities selected by the verifier; media binaries, presentation/visual verification and unrelated tree enumeration are excluded.

Persist the complete report and actual readback evidence under the assigned attempt, then follow [task results and handoff](execution.md#handoff--record-task-results-and-downstream-identities). Return every unresolved check honestly. A complete content report is review evidence; the coordinator records continuation and controls shared workflow.
