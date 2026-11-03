# Presentation scripts

Use Kajoo's Node runtime and the exact staged skill path. Preserve `cms-migration` for the bundled validator, safe file helpers and existing decision contracts, `mapped-content-migration` for the approved content-mapping contract, and `sitecore` for the navigation asset. No runtime package installation or Kajoo code checkout is required. Sitecore operations use the selected connector; local scripts emit structured SPE requests and never authenticate directly.

| Script | Purpose |
| --- | --- |
| `compose-presentation.mjs` | Validate normalized evidence and produce virtual designs, rendering instances and proposed assignments. |
| `prepare-presentation-preview.mjs` | Replay composition, generate target-data mock layouts, navigation and page/variant coverage. |
| `install-presentation-preview.mjs` | Plan-first, approval-bound public preview file installation into an existing verified app foundation. |
| `review-presentation-preview.mjs` | Replay previews and validate actual browser evidence, human decisions and reviewed coverage. |
| `plan-presentation-application.mjs` | Replay approved reviews; request fresh target evidence, then classify creations, updates, reuse and conflicts in bounded dependency order. |
| `prepare-presentation-write.mjs` | Emit exact mutation review; only a bound approval reserves the journal and emits a connector write request. |
| `record-presentation-execution.mjs` | Initialize the journal and record actual submitted, unknown or terminal job evidence with downloaded backups. |
| `audit-presentation-application.mjs` | Verify successful batches and reused items against an independent fresh target capture. |
| `prepare-presentation-workflow.mjs` | Produce a status-free proposal and operation inventory for existing workflow-plan approval. |
| `validate-presentation-outcome.mjs` | Replay actual operation outputs and emit domain plus CMS entity-result evidence for native postflight. |
| `workflow-provider.mjs` | Library hooks registered in the `cms-migration` Sitecore profile: operation catalog, packet metadata, evidence replay and replay requirements for presentation and verification tasks. Not run directly. |
| `verify-target-website.mjs` | Check actual post-application target payloads, browser coverage, source comparisons and human decisions. |
| `capture-presentation-state.ps1` | Read-only bounded SPE collector, assembled with the common helper into the read envelope. |
| `execute-presentation.ps1` | Approved SPE writer, assembled with the common helper; backup, mutate, read back and export receipts. |

All Node commands accept exactly `--input REQUEST --output NEW_DIRECTORY`. Read [contracts](../references/input-contracts.md), [composition](../references/composition.md), [preview/review](../references/preview.md) and [application](../references/application.md) before execution. Artifacts and requests must remain in the assigned writable task workspace; never edit platform-staged skill resources or fabricate evidence. Exit 0 means the specific technical operation is ready, 2 means reported blockers, and 1 means invalid input/integrity/output. Installation reports distinguish `installed` from plan readiness. SPE scripts take the generated `RequestJson` and `RequestSha256` parameters through the selected connector.

The approved installer changes app public files. The separate approved application writer changes only selected target presentation fields and designs. Both retain backups, drift guards and results. Proposal and verification commands do not activate tasks or change target content. No command migrates code or publishes. The coordinator's existing approved workflow materialization and synchronization activate tasks.

For integrated task execution, read [workflow integration](../references/workflow-integration.md) and use the authoritative operation catalog. Final website inputs use the separate [website contract](../contracts/website.schema.json), referenced from the main definitions; preview and live target evidence have distinct kinds.
