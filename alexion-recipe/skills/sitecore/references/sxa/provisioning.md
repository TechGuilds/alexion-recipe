# SXA provisioning — the ordered `xmc-*` procedure

How `sitecore-developer` converts an XP JSS/MVC site (already pushed to SitecoreAI via the CLI) into a working Headless SXA site — **in-place, without moving/duplicating content**. The phase flow + HITL gates live in `cms-migration/references/profiles/sitecore/pipeline/sxa-conversion.md`; this owns the mechanics and the script/tool per step.

**Approach (Understand + Replay):** understand what the `New-JSSSite` wizard creates, then surgically replicate only the missing pieces — idempotent, handles partial states, avoids branch-instantiation duplication. Module lists/template IDs/site structure start from discovery evidence; verify current target state before each write to detect drift. This is the XMC procedure; for XP Headless use the MVC pair's target-xp-headless.md applicability rules.

## Execution order (sacred)
```
1. Tenant Setup            ┐ parallel
2. Rendering Registration  ┘
3. Site Adoption           (requires: tenant exists)
4. Site Conversion         (requires: site under tenant + modules registered)
5. Presentation Setup      (requires: site converted)
6. Presentation Migration  (requires: presentation set up)
```
**Site MUST be under a tenant before conversion** — `xmc-convert-to-headless-site` validates this in Phase 0 and fails immediately if not (`Get-TenantItem returned null` → the site hasn't been adopted; run adoption first). The content path must be `/sitecore/content/{TenantName}/{SiteName}`.

## Step → script/tool
All are **async SPE** unless noted — run the relocated script via
`run-powershell-script` on `target-sitecore` and retain its terminal result.
The normal long-running operation path resumes the chat at completion; call
`get-tool-results` only if that terminal result was not delivered. The
**collection/site/publish** operations are XM Cloud **REST**
(`xmc-ensure-collection` / `xmc-ensure-site` / `xmc-publish`) — call those
tools directly, not via `run-powershell-script`.

| Step | Script (`scripts/sxa/…`) or tool | Notes |
|---|---|---|
| 1 Tenant Setup | `xmc-ensure-collection` (REST tool) — ensure the headless tenant/collection | idempotent (checks before creating); tenant path `/sitecore/content/{tenantName}` |
| 2 Rendering Registration | `xmc-register-rendering-folders.ps1`, then `xmc-ensure-rendering-parameters.ps1` per module | **`renderingsPrefix` is required** (avoids collision with system modules — never guess it); run `ensure-rendering-parameters` for every module **sequentially** (fixes RP template inheritance); `xmc-list-modules.ps1` to enumerate |
| 3 Site Adoption | `xmc-adopt-site-into-tenant.ps1` | move the site under the tenant, fix path references, patch page-template inheritance; pass `siteItemId` as a fallback for stale path caches. **HITL gate** after. |
| 4 Site Conversion | `xmc-convert-to-headless-site.ps1`, then `xmc-apply-rendering-modules.ps1` | ChangeTemplate + skeleton + settings + system modules + custom modules; run the **shared-data safety checkpoint** (item-cache-only clear, no LinkDB rebuild in automated runs). **HITL gate** after. |
| 5 Presentation Setup | `xmc-discover-presentation-patterns.ps1` → `xmc-create-partial-designs.ps1` → `xmc-create-page-designs.ps1` → `xmc-assign-page-design.ps1` (TemplatesMapping); `xmc-list-partial-designs.ps1` / `xmc-list-site-page-templates.ps1` to inspect | create Partial Designs + Page Designs, assign via TemplatesMapping. **TWO HITL gates** (partial-design plan + page-design plan) — see the naming contract below. |
| 6 Presentation Migration | `xmc-migrate-to-page-designs.ps1`; rollback via `xmc-backup-renderings.ps1` / `xmc-restore-renderings.ps1` | strip PD-covered renderings from template SVs + page items. **TWO HITL gates** — dry-run review `{ Confirmed \| Cancel }` (only `Confirmed` proceeds to the live `scope=both` run) and post-execution verification `{ Confirmed \| Roll back \| Report issues }` (`Roll back` → `xmc-restore-renderings.ps1`, report `rollback-complete`; `Report issues` → `TASK_RESULT: needs-redo` with `userIssues` so the orchestrator decides). **Back up before, restore on rollback.** Destructive at scale — the dry-run gate exists for that reason; never execute without it. |

### Presentation naming contract (Step 5 — do not skip)
`xmc-create-partial-designs.ps1` emits **deterministic** names so it stays idempotent. Deterministic names are rarely what an editor wants to see, so proposing readable alternatives at the partial-design gate is the step's real value — and it creates a data dependency:

1. At **gate 1**, present the discovered pattern → the PDs you plan to create → your proposed human-friendly name per PD. Keep it a table, not prose. The user may approve, rename any of them, or reject.
2. Keep the resulting **`nameMapping` (deterministic → confirmed)** for the rest of the step.
3. At **gate 2** and in the `xmc-create-page-designs.ps1` call, `partialDesignNames` **must use the confirmed names**, mapped through `nameMapping` — never the deterministic ones you started from. A Page Design that references a PD name the user renamed away points at nothing, and the page renders empty with no error.
4. Save approved plans and nameMapping in the assigned native evidence file before creation. Resume from those decisions and verify existing target artifacts; do not ask the user to repeat a recorded rename.

Other scripts: `xmc-create-module.ps1` / `xmc-create-rendering.ps1` (create a module/rendering when discovery finds one missing).

## Script preservation and output evidence

The 17 `scripts/sxa/*.ps1` files are the approved executable procedure. Read
the exact native file and send its unchanged executable body with only the
documented `.INJECTED_VARIABLES`; do not retype, trim, wrap, split, or recreate
one in a task. A script hash records provenance. A transport-only line-ending or
whitespace observation is not a failure when the terminal result has the
expected schema, but an invocation that changes behavior may receive one safe
shape-only retry.

Retain the script name/hash, connector job ID, terminal state, exact input
scope, result status/counts, affected IDs/paths and subsequent read-back in the
assigned task evidence. `Status: ok` is not sufficient where the script itself
reports skipped records, module errors, partial output, a different identity, or
an incomplete expected count.

## Presentation analysis and migration evidence

`xmc-discover-presentation-patterns.ps1` is read-only and produces the
candidate Partial Designs, Page Designs and template assignments. Preserve its
full deterministic plan before creation. The plan must show the inspected
template scope, final-layout basis, compatible and incompatible renderings,
page-level overrides, ghost/skipped placeholders, direct exceptions, and every
proposed assignment. Use final-layout resolution for composition; do not infer
absence from a link-database/referrer query or a display-name aggregate.

Before the Step 6 execute call:

1. Use `xmc-backup-renderings.ps1` in `plan` then bounded `fetch` mode and
   retain the returned original XML in task-local backup evidence. Verify every
   planned record matches its current ID before it is eligible for restoration.
2. Run `xmc-migrate-to-page-designs.ps1` with `mode=dry-run` and `scope=both`.
   Do not use the deprecated split scopes: orphan resolution and Final
   Renderings placeholder rewriting rely on the shared cross-pass context.
3. Present the dry-run's per-template/page `strip`, `preserve`, `no-change`,
   `skipped` and `failed` outcomes, together with
   `SimulatedInheritedSvRenderings` and the current TemplatesMapping/Partial
   Design signature set. The page forecast must exclude renderings inherited
   from Standard Values that the preceding SV pass would already remove, while
   retaining an explicitly page-owned override. The user approves this exact
   scope before an execute call.
4. Read the signature-mismatch evidence before deciding to strip. The contract
   is rendering definition ID + normalized datasource + normalized parameters.
   A mismatched datasource/parameter is a preserve result, not permission to
   strip. If preservation leaves a duplicated or unsafe composition, stop with
   the IDs and a `needs-redo` result; never create an unreviewed custom patch.
5. Default-language scope is the normal execution path for these scripts.
   Inspect the scope's `__Renderings` and `__Final Renderings` field sharing and
   record any non-default language/version layout delta as a deferred finding,
   including language/version and affected count or paths. Do not block E1 or
   E2 solely because a non-default layout delta exists and do not create a
   language decision prompt solely for it. Treat multilingual presentation
   migration as an explicit approved scope expansion; only then retain a
   per-language coverage/read-back plan. The default-context result proves the
   approved default-language scope only, and the final report must label the
   other variants deferred.

After execution, re-read the Page Design assignments and affected layouts.
Return discrepancies, IDs and evidence to the coordinator; do not apply a
cleanup, correction or retry that was not explicitly approved for that exact
operation and scope. On rollback, call `xmc-restore-renderings.ps1` only with
the scoped backup entries, then verify each returned `restored`/`failed` status
and exact item ID. A partially restored or failed rollback is a visible stop
condition, not a successful recovery.

## Invariants (from the SXA constitution)
- **Anti-hallucination:** never fabricate counts/paths/IDs/statuses — echo exact tool-result values; call a tool before answering a data question; get names from discovery artifacts or the user, never from prior-conversation assumptions.
- **Resume:** read the assigned task/result files and inspect current target artifacts. Verify prior success before adopting it; scripts are not universally safe to rerun after partial failure.
- **`renderingsPrefix` required** (customer/project-specific — ask, never guess).
- **Silent module-failure awareness:** `xmc-apply-rendering-modules` / `xmc-convert-to-headless-site` install modules via a Sitecore function that can fail silently — `Status: ok` is a strong signal, not absolute proof; if `ModuleErrors > 0`, report them (re-running is safe); recommend the user check SPE server logs for `ERROR`.
- **HITL gates are mandatory** between structural steps (the user verifies in Content Editor before the next agent runs).
- **State:** write the assigned attempt result and affected item IDs; the hub alone reconciles workflow lifecycle. Preserve module entries as objects `{ modulePath, layer }`, not bare strings. No tool-side state recording is assumed.
- **Never report partial data as complete.** If a tool result comes back truncated, say so and re-read the full output; don't fill the gap with an assumption.

## Benign errors (ignore / expected)
`ScriptSessionNotFound` (cleanup race — ignore) · `Non interactive session cannot perform an interactive 'Prompt'` (SPE Remoting limitation in `Get-ThemeItem` — scripts work around it) · poll timeout (inspect the existing run through the same connector; do not start duplicate work).

## Error escalation (what the message actually means)
| Message | Meaning | Action |
|---|---|---|
| `Get-TenantItem returned null` | the site isn't under a tenant | run Site Adoption (Step 3) first — conversion validates this in Phase 0 |
| "requires an XMC connector" | no target Sitecore connection | cannot proceed — tell the user to configure the target connector |
| "Site item not found at path" | wrong path, or adoption didn't finish | verify the path; check whether adoption completed and use its `newPath` |
| "Tenant has no Templates field" | the tenant item is malformed | inspect and repair the exact tenant within approved scope; do not recreate blindly |
