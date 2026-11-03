# Operational capabilities and boundaries

The [script inventory](../scripts/README.md) is the command reference. This document is the common capability and limitation reference; individual runbooks define exact inputs, approvals and recovery procedures.

## Required evidence

- Supply completed Setup and Discovery evidence, approved mappings and destination rules, and an explicit content-transfer decision bound to the current scope.
- Confirm source and target Sitecore/SPE compatibility through the selected connectors before a full run, and start with a bounded pilot.
- Supply verified target observations for dry-run and reference planning through a confirmed adapter. The independent audit collector has a separate provenance-bound format and cannot be substituted for these observations.
- Obtain required read approvals before remote capture. Independent target audits require read capability and a stable read window; they do not require write, backup or restore capability.
- Before target mutation, require current capabilities, recoverable item backups, verified external scoped restore capability, an exclusive write window and exact mutation approval. The recipe does not implement automatic restore.
- Retain user review and evidence-bound continuation decisions. Technical success, script availability and generated proposals do not authorize target writes or workflow advancement.

## Supported and excluded work

Mapped transformation uses existing target templates and approved explicit folder structures. Global datasources remain shared unless an approved rule requires separate outputs. Reference planning supports the documented GUID/list/link/image/file forms and uses the same guarded writer as initial content creation.

Optional media binary transfer is supported only by the separately approved [media package procedure](media-migration.md), with verified XP/XM live pilot, exact decimal 100 MB archive cap, original-blob proof and independent target verification. SitecoreAI requires a different adapter. Media transfer does not enter content transformation or authorize remapping. Branch expansion, unsupported field/reference conversions, presentation assignment, component code migration and publishing remain excluded from mapped Content Migration. Return unsupported required work as a blocker; do not invent scripts or fall back to native serialization.

The writer's per-operation read-back is separate from the independent whole-scope content audit. Content parity does not establish presentation, visual, functional or media binary parity. Unrelated target items are not enumerated by that audit.
