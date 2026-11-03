---
name: sitecore
description: Sitecore platform knowledge and Sitecore-specific operations for migration agents — XP MVC and XP Headless (JSS) sources, SitecoreAI / XM Cloud (XMC) targets, SXA, content model, GraphQL/Edge, SPE, native content serialization (pull/push) when native-serialization is the selected content transfer method, SXA provisioning, and setup (Headless Services, SPE-1322, API keys). Make sure to load this skill whenever you need to understand how any Sitecore subsystem works OR run a Sitecore operation — even when the task looks obvious. Source→target transforms live in the pair skills; the migration workflow lives in the `cms-migration` hub. For mapped content migration or existing Headless SXA presentation work, use `mapped-content-migration` or `presentation-composition`; this skill supplies platform knowledge and operations.
---

# Sitecore Platform Knowledge & Operations

Reference library for how Sitecore works — and how to run Sitecore-specific operations — across every flavor the migration handles. It covers **Sitecore knowledge** (what subsystems are and how they behave) and **Sitecore operations** (SPE, content serialization, SXA provisioning, setup). It does **not** contain source→target *transforms* (those are the pair skills) or the vendor-agnostic *process* (the `cms-migration` hub).

**How to use:** identify the flavor in play, then open the one reference that matches your task from the dispatch table. Read references on demand — do not preload them all.

---

## Flavor detection

Determine which Sitecore flavor is in play before reaching for a reference. Detect from repository / connector signatures:

| Flavor | Token | Detect by |
| --- | --- | --- |
| Sitecore XP, MVC source | `xp-mvc` | `*.cshtml` Razor views; `Controllers/` with `SitecoreController`/`Controller`; Glass Mapper usage (`Glass.Mapper.*`, `[SitecoreType]`); `.csproj` referencing `Sitecore.Mvc.*` |
| Sitecore XP, Headless (JSS) source | `xp-headless` | `@sitecore-jss/*` in `package.json`; JSS rendering `*.tsx`/`*.jsx`; a Layout Service endpoint; `sitecore/definitions` or `scjssconfig.json` |
| SitecoreAI / XM Cloud target | `xmc` | An XMC target — Next.js App Router + Sitecore Content SDK, Experience Edge (Edge GraphQL), Pages editor |

Source is `xp-mvc` or `xp-headless`; target is `xmc`, or `xp-headless` for `xpmvc2xpheadless`. For the latter read `../sitecore-mvc-to-xmc/references/target-xp-headless.md`; do not apply XMC-only operations. Record versions and identities separately even when the aliases address one instance. When a task spans both sides, read both flavors' references.

---

## Running operations (the execution convention)

For existing Headless SXA presentation composition and final target verification, load `presentation-composition` and use its approved operation packet. This is separate from the SXA provisioning/conversion scripts and component code transforms. Existing target readiness is a prerequisite; a blank site does not authorize conversion or copying definitions.

For Content Migration, require the assigned packet's `contentMigrationMode`: `mapped-content` or `native-serialization`. The [content transfer method guard](../mapped-content-migration/references/content-transfer-method.md) takes precedence over generic serialization dispatch. Missing or contradictory method evidence is `blocked`. Mapped-content tasks use the dedicated skill and never fall back to native transfer or aggregate serialization audits. Separate reference planning follows [reference resolution](../mapped-content-migration/references/reference-resolution.md), then uses the same writer/recorder with `operationKind: references`; it creates no items or versions. Its guarded target writer is available only through the explicit target-execution procedure, current mutation approval/capability/backup evidence and durable journal. Writer operation read-back does not replace independent final parity. Serialization mechanics below apply only to `native-serialization` tasks; setup and unrelated read-only Discovery retain their existing procedures.

For Setup and later service selection, follow `references/setup/capability-requirements.md#configuration-preflight-and-service-routing` and `references/setup/setup-recording-contract.md#surface-setup-results-and-route-later-work` from this skill's root. Surface missing configuration and retain verified alternatives before calling known-unavailable services.

- **SPE (`.ps1`) content executes against the remote Sitecore instance via the Sitecore PowerShell tool** — `run-powershell-script` on `source-sitecore/` (read/inspect/install) or `target-sitecore/` (provision/write). Default background jobs resume the chat with the terminal result; use `get-tool-results` only when that result was not delivered or a bounded foreground call returned a run ID. **Never** run SPE via `bash`. Reserve `bash` for the **local** `workspace-sandbox` (git, npm, file/build commands).
- **Ready-to-run operation scripts** — SXA provisioning, setup/install, item ops — live in **`scripts/`**: read the script, then pass its executable body unchanged to `run-powershell-script`, with the params named in its `.INJECTED_VARIABLES` header (they're injected as `$variables`). Never wrap an executable script body in `<# ... #>`; that comments it out and can produce a misleading empty result. See `scripts/README.md` (added with the phases that use them).
- **XM Cloud provisioning that is not SPE** (create collection/site, publish, list) uses the dedicated `xmc-*` REST tools — call them directly, not via `run-powershell-script`.
- **Serialization** follows `references/serialization/native-execution.md`: native local planning plus verified authenticated execution; no implicit endpoint selection.

---

## Topic dispatch

Open the reference that matches the task. *Reference files are added by the phase build that needs them; a missing entry means that area isn't built yet.*

| Task / question | Reference (added per phase) |
| --- | --- |
| Configure sandbox mock/live mode and resolver debugging | `references/dev-mode.md` (uses the `dev-server` skill's environment helper) |
| Items, templates, fields, standard values, presentation, versions/languages, serialization concepts | `references/common/content-model.md` |
| Sitecore field types and raw-HTML field behavior | `references/common/field-types.md` |
| What exists in XP but not in XMC (Analytics, MA, xDB, Forms) | `references/common/xp-vs-xmc-differences.md` |
| GraphQL — XP Master vs Edge schemas, introspection, field-name mangling, Layout Service vs GraphQL | `references/common/graphql-and-edge.md` |
| Writing/running SPE — rules, cmdlets, query templates | `references/spe/best-practices.md`, `references/spe/command-reference.md`, `references/spe/query-templates.md` |
| PowerShell export/download failure, redirects, incomplete export, SPE #1322 diagnosis and recovery | `references/setup/spe-1322-patch.md` (read before retrying; diagnose first, respect repair approval) |
| Installing Headless Services, applying the SPE-1322 patch, repairing an API key | `references/setup/*.md` |
| Creating or adopting the XM Cloud target app (starter pin, rendering host, baseline commit) | `references/setup/target-app-init.md` |
| Delivering captured layouts and dictionary into the target app | `references/discovery/baseline-delivery.md` |
| Rendering/variant inventory → approved capture → mapping → local mock preview | [rendering preview flow](references/discovery/rendering-preview-flow.md) |
| Validate Sitecore-specific local artifacts | [artifact contracts](assets/contracts/README.md) |
| Review source/target rendering mappings and explicit unused examples | [mapping contracts](scripts/mapping/README.md) |
| Prepare hash-bound selected preview navigation and deployment | [preview contracts](scripts/preview/README.md) |
| Serialization mechanics — setup→pull→push, target parity, ordering, timeouts/chunking, error recovery, XP→XMC exclusions | `references/serialization/*.md` |
| Pre-pull content health check — duplicate item detection + remediation | `references/serialization/health-check.md` |
| SXA — fundamentals, placeholder resolution, the ordered `xmc-*` provisioning procedure | `references/sxa/*.md` |
| Content discovery, executable coverage and source baselines | `references/discovery/content-analysis.md`, `references/discovery/discovery-script-inventory.md`, `rendering-analysis.md`, `layout-and-usage.md`, `baseline-capture.md` |
| MVC source inspection and evidence vocabulary | `references/mvc/scan-razor-source.md`, `references/mvc/analysis.md` |

---

## Where other things live (deliberately NOT here)

- **Source→target transforms** (Razor→JSX, JSS→Content SDK, field/helper mapping, resolver adapters, XMC-specific troubleshooting) → the migration **pair** skills (`sitecore-headless-to-xmc`, `sitecore-mvc-to-xmc`).
- **Vendor-agnostic process** (workflow, patterns, gates, state) → the **`cms-migration`** hub. The hub owns *when/what*; this skill owns *how* (the mechanics it dispatches to).
- **Generic frontend modernization** (jQuery→React, SVGR, `'use client'`, styles) → **`frontend-migration`**.

## Additional topic dispatch

- Headless payloads, fields and composition: references/headless/layout-service.md, field-rendering.md and placeholder-handling.md.
- Source/target compatibility: references/setup/topology-and-prerequisites.md and hotfixes.md.
- Setup capability applicability and deterministic blocker policy: references/setup/capability-requirements.md.
- Setup recording, gate equivalence and phase-boundary evidence: references/setup/setup-recording-contract.md.
- Current migration scope and execution state: read the Migration Artifact, `context.json`, `workflow.json`, `decisions.json`, and scoped evidence before resuming work.
- Executable contracts and prerequisites: scripts/README.md and its analysis, capture and serialization manifests.
- For requested Discovery mock preview, follow [rendering preview flow](references/discovery/rendering-preview-flow.md): inventory source presentation and definitions first, synthesize a draft, validate the user's included rendering scope, derive an approved native capture plan, then attempt capture and reviewed local delivery during Discovery. Static source analysis proceeds in parallel. A capture failure does not erase valid core content evidence, but an unattempted or undelivered requested preview needs an explicit deferral and owner before audit can close with that gap. Never seed unplanned mock fixtures from a sitemap before inventory.

## Sitecore migration profile

The Sitecore profile supports XP Headless/JSS and XP MVC sources targeting SitecoreAI/XM Cloud,
plus the explicitly selected in-place XP Headless route. These procedures are profile-specific and
do not belong in the generic CMS hub.

| Phase | Procedure | Primary work |
| --- | --- | --- |
| Setup | `../cms-migration/references/profiles/sitecore/pipeline/setup.md` | scope, connections, safety and prerequisites |
| Discovery | `../cms-migration/references/profiles/sitecore/pipeline/discovery.md` | approved source/target evidence, inventory and coverage |
| Code Migration, when approved | `../cms-migration/references/profiles/sitecore/pipeline/code-migration.md` | layout/styles, components and browser verification |
| Content Migration | `../cms-migration/references/profiles/sitecore/pipeline/content-migration.md` | selected mapped/native transfer, references and parity |
| SXA Conversion, when approved | `../cms-migration/references/profiles/sitecore/pipeline/sxa-conversion.md` | separately scoped provisioning/conversion |
| Resolver Adapters, when approved | `../cms-migration/references/profiles/sitecore/pipeline/resolver-adapters.md` | separately scoped resolver/data-contract implementation |
| Presentation Composition | `../cms-migration/references/profiles/sitecore/pipeline/presentation-composition.md` | virtual target-data preview, human review and guarded design/page application |
| Verification | `../cms-migration/references/profiles/sitecore/pipeline/verification.md` | actual target website visual/functional checks and final human acceptance |

Treat this as a catalog of possible phases, not an always-active execution list. Setup and
Discovery are active by default; after Discovery, select applicable later phases and synchronize
them into the workflow and Kajoo project plan. The profile workflow defines task state; the recipe
UI workflow is only its phase projection.

## Native execution and handoff contract

Required capabilities: native file tools for staged inputs/evidence and authenticated Sitecore queries/SPE through the selected connector. Verify availability before use. A script name in a manifest is not an installed capability.

Inputs depend on the assigned operation. Code-consuming work uses `roots.source`/source revision and `roots.app`/`target.sdkVersion` from `${MIGRATION_STATE_FILE_DIR}/context.json`; platform reads and presentation operations use their packet's source/target connector/site identities, CMS evidence and declared artifact paths. A source repository checkout is not a prerequisite for no-code presentation work. The target preview still requires the existing verified application foundation. Source code and raw captures remain read-only; write only assigned target files and task evidence.

Procedure: read the assigned task and prior evidence; confirm connector role, instance, site and scope; select the relevant platform reference; run read-only probes first. For a mutation, inspect the planned effects, required approval and appropriate backup before executing. Read back actual results and return affected IDs, output paths, checks and gaps. Frontend transformations belong to the pair skills. The cms-migration hub owns phase selection and task status; the Sitecore phase list is a catalog of possible phases. Native memory is reusable context, not task or approval storage.

Scripts: read the selected executable contract before execution. Remote SPE runs through the correct source/target connector with structured parameters; credentials stay with connectors. Compose new analysis/capture requests with prepare-request.mjs, which includes their shared helper. A local script may receive role-namespaced connector environment variables only when the Bash call explicitly attaches the correct connector; it must not accept credentials in arguments, params files or saved evidence. Preserve each sample's prerequisites, partial-result flags and explicit approval requirements; unavailable authenticated operations remain blocked rather than fabricated.

Completion evidence: connector identity without secrets, input scope, executed query/script provenance, job terminal state when applicable, affected item IDs, requested/succeeded/failed counts and read-back observations. Preserve unresolved references and partial failures. A local checkpoint does not roll back Sitecore items or workspace configuration; report remote backup/restore scope separately. The hub's checkpoint procedure defines the authorized mechanism; never invent a checkpoint ID.

Escalate unknown source/target identity, unavailable required capability, ambiguous mapping, missing baseline, protected-data dependencies or a failed gate. Return a partial/blocked result with evidence, not success. Framework repair is a separately scoped native change when needed; use the implemented [resolver scaffold](../sitecore-headless-to-xmc/scripts/README.md) or [mock scaffold](../sitecore-headless-to-xmc/assets/mock-layout-service/README.md) under that separate scope, with reviewed plans and hash-bound overwrite approvals.

## Result and decision schema

Return the [hub task-result contract](../cms-migration/references/task-results.md): taskId, outcome (success | failed | blocked | needs-redo | skipped), summary, evidence[], changedFiles[], checkpoint and unresolved[]. Only the coordinator writes workflow task.status. Read-only work returns an empty changedFiles array.

Decisions use the hub's scope, mapping, overwrite, mutation, verification or phase-continuation keys; preserve detailed hazard prefixes as rationale/evidence within the appropriate decision, not a competing state schema. Link the [decision contract](../cms-migration/references/decisions-and-approvals.md) and [checkpoints](../cms-migration/references/checkpoints.md).

## Migration artifact dispatch

For Sitecore migration metadata recording, read the generic `cms-migration` reference `references/migration-artifact-contract.md`. Keep Sitecore-specific platform facts in the artifact's existing `source`/`target` objects; keep probes, evidence, approvals and task state in the migration sandbox.
