---
name: sitecore-headless-to-xmc
description: The transform pair for migrating a Sitecore XP Headless (JSS) site to SitecoreAI / XM Cloud — how JSS constructs map to the Sitecore Content SDK, the translation-not-transformation law, the quality gates (Gate 0–3), field-type mapping, placeholders/registration, editing mode, Edge enrichment, resolver adapters, and target-side troubleshooting. Make sure to load this skill whenever converting a JSS component to SitecoreAI, wiring its data, registering it, building a resolver adapter, or diagnosing why a converted component won't render — even for components that "look trivial". Sitecore platform knowledge lives in `sitecore`; the workflow/gates-in-context live in the `cms-migration` hub.
---

# XP Headless (JSS) → SitecoreAI — transform pair

How a Sitecore XP Headless (JSS) component becomes a working SitecoreAI (XM Cloud) Content SDK component. This skill owns the **source→target transforms, their invariants, and the quality gates**. It does **not** own the migration process (that's `cms-migration`), Sitecore knowledge (that's `sitecore`), or generic React/Next transforms (`frontend-migration`).

**How to use:** read this SKILL.md for the core law + preservation rules + the gates, then open the one reference that matches the construct you're converting.

---

## Core law: translation, not transformation

This is a **translation between similar languages** (JSS React → SitecoreAI Content SDK React), not a rewrite. **Goal: ~95% of the code identical to the source.** Change only the incompatible APIs; preserve everything else character-for-character.

**Only these lines should differ from source:**
- SDK **imports** (`@sitecore-jss/*` → `@sitecore-content-sdk/nextjs`)
- **Export** pattern (`export const Default = (props: ComponentProps) => …`)
- **Placeholder** component (`<AppPlaceholder … page={props.page} componentMap={…}>`)
- **Optional chaining** on field access (`fields?.Title`)
- **TypeScript types** added (no `any` for fields)
- **`'use client'`** directive (when needed)

Everything else — HTML, className values, business logic, variable names, conditionals — MUST be identical.

## Preservation rules (cannot violate)

- **HTML structure & attributes** exactly — `className`/`id`/`role`/`aria-*`/`data-*`, tag types, nesting order. **`className` values are CSS selector contracts — never rename them.**
- **Component architecture — keep the class.** wrapper (has `children`) stays a wrapper; leaf stays a leaf; container keeps placeholder names + passes `page`/`componentMap`. Never convert wrapper↔leaf.
- **Field names — exact match.** Bracket notation for spaces (`fields?.['Hat Title']`), exact capitalization, never camelCase. (Component *names* ARE normalized by infrastructure.)
- **Business logic** verbatim — conditionals, loops, calculations, state, variable names. Don't "improve" operators.
- **No `any`** for Sitecore fields (`TextField`/`ImageField`/`LinkField`/`RichTextField`/`CheckboxField`).

## Quality gates (cannot skip — the fidelity backstop)

| Gate | When | Requires |
| --- | --- | --- |
| **Gate 0** | Before any work | Error + install-health baseline (`preview_logs` at `level: error`, npm health) |
| **Gate 1** | Before code | Data-flow table with TS types from the analyzer |
| **Gate 2** | After **every** file | the frontend-migration native render-validation procedure PASS (HTTP + logs + markers) vs the Gate-0 baseline — BLOCKING. "Pre-existing" errors require character-for-character proof from Gate 0. |
| **Gate 3** | Before checkpoint | Structural parity + selector-contract parity + post-checkpoint fix policy |

**Checkpoint and fixes.** Follow the hub's native checkpoint procedure after Gate 3, recording the actual snapshot/diff reference and file scope. A later fix needs fresh validation and a new checkpoint reference in its result; the hub updates task status. Do not claim remote rollback from a local snapshot.

**Selector-contract parity (the Gate-3 clause).** For any behavior-critical element (positioned controls, close buttons, overlays, hero/scroll buttons), verify the class contract across **three** legs, not two: the class on the **source JSX** → the **source SCSS/CSS selector** that applies the behavior-critical rules → the class on the **migrated JSX**. A JSX→JSX comparison passes while the styling silently dies, because the CSS keys on the name you changed. Leg 2 is the one that catches it.

**Do not fake UI to bypass an error.** The deliberate orange fallback for a confirmed not-yet-migrated rendering (documented in `references/placeholders.md`) is a distinct partial-migration preview behavior, not a substitute for a required migrated component or a failed route. Do not modify template-owned framework files in a rendering task (`sitecore.config.ts`, `sitecore.cli.config.ts`, `src/lib/sitecore-client.ts`, `src/lib/sitecore-client.server.ts`, resolver-registry/strategy/types, mock-layout-service). Inspect existing framework wiring; if a required preview capability is absent, document and route a separately assigned, reviewable framework/scaffold task rather than improvising a protected-file edit.

**Migrate outwards-in.** Convert the outer/wrapper component before the leaves it contains: a leaf rendered inside an unmigrated wrapper has no mount point, so its Gate 2 fails for a reason unrelated to its own code.

**After editing any config file, restart before re-gating.** Emit `[⚠️ CHECKPOINT: Restart Required]`, restart the preview (`preview_stop`, then `preview_run`; see the dev-server skill), let it settle, re-check `preview_logs` at `level: error`, then re-run Gate 2 — proceed only on PASS. A Gate 2 against a stale bundle is not evidence.

**Never assume pre-existing code is correct.** If Gate 2 fails on a file you didn't write (a prior attempt's broken import, a partial stub, a bad config), that code is the problem — fix or rewrite it. (The converse still holds: excusing an error as "pre-existing" needs character-for-character proof from the Gate-0 baseline.)

---

## Dispatch — trigger inventory (Gate 1, code-backed)

**Reference selection is evidence-driven, not intuition-driven.** At Gate 1, before writing any code, run the trigger scan below against the source file and **paste the raw command + output**. Every pattern that matches makes its reference **mandatory** for this component. Gate 1 is incomplete without the scan.

| Trigger (grep the source) | Reference (required on match) |
| --- | --- |
| `<Placeholder` / `<AppPlaceholder` | `references/placeholders.md` |
| `useSitecoreContext` · `pageEditing` · `pageState` · Experience Editor / preview checks | `references/editing-mode.md` |
| `getFieldValue` · `getFieldImageSrc` · `getFieldText` · other `@sitecore-jss/sitecore-jss-react` helpers | `references/jss-to-content-sdk.md` |
| any `.svg` import · `{ ReactComponent as … }` · `react-inlinesvg` · icon libraries | `../frontend-migration/references/svg-svgr.md` |
| React hooks · event handlers · browser APIs · rendered inside a client component owning an `AppPlaceholder` | `../frontend-migration/references/use-client.md` |
| `from 'jquery'` · `require('jquery')` · `$(` · `jQuery(` · `.on(` · `.addClass(` · `.removeClass(` · `.animate(` | `../frontend-migration/references/jquery-to-react.md` |
| raw-HTML field rendered with embedded `<script>` | `references/raw-field-rendering.md` |
| the component needs data Edge doesn't return on the datasource | `references/edge-inline-fetch.md` |
| the rendering has a C# Rendering Contents Resolver | `references/resolver-adapter.md` |
| **always**, before wiring fields into children | `references/data-flow-to-props.md` |
| **always**, at registration | `references/component-registration.md` |

**Loading protocol:** load a reference only on a **quoted** trigger — the exact source line (with its number) or the exact Gate-2 stderr line. **One reference per trigger**; never batch, never load "to be prepared", never infer from the component's name. A repeat trigger reuses guidance already in context.

**Troubleshooting references are Gate-2-FAIL-only:** HTTP 200 but empty → `references/troubleshooting.md` §A · "unknown component" / placeholder children missing → §B · visuals/layout broken → §C. **Never preload them** — opening one before a failure exists invites fixing a problem you don't have, and burns the context the real failure will need.

This pair skill owns the Sitecore mock Layout Service scaffold and resolver framework. Use their [plan/apply contract](scripts/README.md), [mock golden assets](assets/mock-layout-service/README.md) and [resolver golden assets](assets/resolver-framework/README.md). A frontend developer may execute a separately assigned scaffold task using this contract. Inspect existing target wiring first. Default planning is read-only; replacements require exact current-file hashes and backups. Generated files still need target-SDK, bundler, build and runtime verification before implementing adapters. Captured source fixtures are separate Discovery inputs; scaffolding does not capture them.

For the conditional `preview-foundation` task, create one task-owned preview-input manifest after the scaffold and any shared-styles prerequisite are complete. Run `scripts/prepare-preview-foundation.mjs` with the selected Discovery fixture, its agreed route, the explicit target layout path, an evidence-directory output path, and current prerequisite task-result paths. The manifest is the bounded handoff: it records fixture placeholder keys and input hashes without scanning application directories. Preview work reads that manifest, checks only its declared route/layout and writes its own evidence/result. Do not create a bespoke browser/Playwright capture script, rediscover alternate routes, or rewrite worker evidence in the coordinator. A browser-only configuration failure is a separately scoped preview repair only when the declared route check proves it blocks acceptance.

## Where other things live

- **Migration process & gates-in-context** → the **`cms-migration`** hub (this skill is invoked *within* its loop).
- **Sitecore knowledge** (what JSS/Content SDK/Edge/fields are) → the **`sitecore`** skill.
- **Generic React/Next transforms** (jQuery→React, SVGR, `'use client'`, styles) → **`frontend-migration`**.

## Native execution and handoff contract

Required capabilities: native file read/search/edit and local build checks; browser execution for visual/interaction evidence; authenticated Sitecore queries and SPE delegated to the selected connector. Verify availability before use. A script name in a manifest is not an installed capability.

Inputs: the migration type, `roots.source`/source revision and `roots.app`/`target.sdkVersion` from `${MIGRATION_STATE_FILE_DIR}/context.json`, separate source and target connector/site identities, scoped rendering/task key, baseline and evidence directory. Source code and raw captures remain read-only; write target code and task evidence only to their assigned writable paths.

Procedure: read the assigned task and prior evidence; inspect the source and captured payload; select the triggered references; make the scoped target transformation; validate rendering, editing and behavior; return changed paths, checks, gaps and checkpoint references. The cms-migration hub owns all six Sitecore phases and lifecycle decisions through native workflow files. Native memory is reusable context, never task status, evidence or approval storage.

Scripts: read the selected executable contract before execution. Remote SPE runs through the correct source/target connector with structured parameters; credentials stay with connectors. A local script may receive role-namespaced connector environment variables only when its foreground Bash call explicitly attaches `mcpCredentials.source` or `mcpCredentials.target`; never pass credentials in arguments, params files or saved evidence. Preserve each sample's prerequisites, partial-result flags and explicit approval requirements; unavailable authenticated operations remain blocked rather than fabricated.

Completion evidence: source provenance, mapping/data-flow table, exact changed target paths, baseline-relative compile/render results, populated-region and selector checks, unresolved hazards and a restorable local checkpoint reference. A local checkpoint does not roll back Sitecore items or workspace configuration. The hub's checkpoint procedure defines the authorized mechanism; never invent an ID or require a commit when commits are prohibited.

Escalate unknown source/target identity, unavailable required capability, ambiguous mapping, missing baseline, protected-data dependencies or a failed gate. Return a partial/blocked result with evidence, not success. Framework repair is a separately scoped native change when needed; use the implemented [resolver scaffold](../sitecore-headless-to-xmc/scripts/README.md) or [mock scaffold](../sitecore-headless-to-xmc/assets/mock-layout-service/README.md) under that separate scope, with reviewed plans and hash-bound overwrite approvals.

## Result and decision schema

Return the [hub task-result contract](../cms-migration/references/task-results.md): taskId, outcome (success | failed | blocked | needs-redo | skipped), summary, evidence[], changedFiles[], checkpoint and unresolved[]. Only the coordinator writes workflow task.status. Read-only work returns an empty changedFiles array.

Decisions use the hub's scope, mapping, overwrite, mutation, verification or phase-continuation keys; preserve detailed hazard prefixes as rationale/evidence within the appropriate decision, not a competing state schema. Link the [decision contract](../cms-migration/references/decisions-and-approvals.md) and [checkpoints](../cms-migration/references/checkpoints.md).
