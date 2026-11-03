---
name: sitecore-mvc-to-xmc
description: The transform pair for migrating a Sitecore MVC (Razor) rendering to SitecoreAI / XM Cloud — the translate-do-not-redesign law, the source-of-truth and safety-check invariants, the four-step translation cadence, the quality gates (Gate 0–3), the three data channels + safety rules, resolver-adapter deferral, and the hazard-gate for Razor helpers. Make sure to load this skill whenever converting a Razor/MVC rendering to SitecoreAI, wiring its data, or classifying its helpers — even for renderings that "look trivial". Sitecore platform knowledge lives in `sitecore`; the workflow/gates-in-context live in the `cms-migration` hub.
---

# MVC (Razor) → SitecoreAI or XP Headless — transform pair

How a Sitecore MVC (Razor) rendering becomes a working SitecoreAI (XM Cloud) Content SDK component. This skill owns the **source→target transforms, their invariants, and the quality gates**. It does **not** own the migration process (that's `cms-migration`), Sitecore knowledge (that's `sitecore`), generic React/Next transforms (`frontend-migration`), or MVC discovery/Roslyn interpretation (`sitecore/references/mvc/analysis.md`).

**How to use:** read this SKILL.md for the core law + translation cadence + data channels + gates, then open the one reference that matches the construct you're converting.

---

For xpmvc2xpheadless, load [target XP Headless](references/target-xp-headless.md) first; its target SDK and platform rules override XMC-specific examples below.

Additional dispatch: all helper inventories → [helper catalog](references/razor-helpers-catalog.md); identity/rules → [auth and personalization](references/auth-and-personalization.md); asset URLs → [media](references/media-and-assets.md); SXA variants → [variant mapping](references/sxa-variants-to-components.md); approved Tailwind grid conversion → [grid policy](references/sxa-grid-to-tailwind.md).

## Core law: translate, do not redesign

- Keep source behavior and structure unless incompatibility forces a change.
- Preserve selector contracts used by styles. **`className` values are CSS selector contracts — never rename them.**
- Preserve placeholder names exactly.
- Razor → JSX only where forced by the language change itself. No upgrades, no "while we're in here" rewrites.

## Source-of-truth contract

Read the hub's rendering inventory and current source files with file/line provenance. Select by stable rendering ID and task key; retain name/slug as labels. Use [native MVC inspection](../sitecore/references/mvc/scan-razor-source.md) when structured analysis is absent, recording semantic gaps.

## Required safety checks

- Verify whether the rendering is an app root entry before applying shared wrappers.
- Do not hardcode a single root placeholder name.
- Derive placeholder mapping from analysis and mock-layout evidence.
- Gate 2 must fail on HTTP 200 with empty expected placeholder regions.

### Mechanical translation rule (per cshtml expression)

Strict 1:1 mapping when translating expressions inside the shell or inside any stub:

- `@Model.X` → `props.fields.x` (read-only access; do not upgrade to an editable component even when field-type inference is high-confidence).
- `@Html.Sitecore().Field(X)` → the corresponding Content-SDK editable field component (`Text`, `RichText`, `Image`, etc.), picked from analyzer-supplied field-type inference or the template field type.
- `@Html.Glass*(...)` and other Razor helpers → match the editability the source helper produced (editable vs read-only). The component never gains or loses editability relative to the source.
- **No `any`** for Sitecore fields (`TextField`/`ImageField`/`LinkField`/`RichTextField`/`CheckboxField`).

## Translation cadence (recursive per stub)

Translate every MVC rendering using this four-step cadence, applied recursively to every stub it spawns:

1. **Minimal shell.** Translate the cshtml's outer wrappers and structural markup 1:1. Leave every nested `@Html.Partial`/`Html.RenderPartial`, multi-element `@foreach` body, and named-class region with its own semantic identity as an orange-box stub subcomponent — each stub is its own `.tsx` file, whole-subcomponent scope only (never an inline-expression placeholder).
2. **Validate the shell.** Call the frontend-migration native render-validation procedure (explicit pagePath and markers) with explicit markers picked from the class names or text the outer wrappers should produce. This IS the validate step at every cadence gate — **not** bare HTTP 200.
3. **Add stubs one at a time + validate each.** For each stub, validate with markers proving the stub's wrapper renders inside its parent. No batch additions.
4. **Replace stubs one at a time + validate each.** Replacing a stub recurses into steps 1–4 for that subcomponent. This is also where **data wiring** happens for that subcomponent, per the data-channel rubric below.

## Data channels (try in order)

A rendering's data arrives one of three ways. Try them in order — do not escalate until you have checked each in turn:

1. **Props.** Values already present in `ComponentProps` — `fields`, `params`, resolver-adapter-projected shapes, or values a parent passed down. Always in-scope; translate directly.
2. **Inline Edge fetch.** The component itself queries Edge GraphQL for the shape it needs. **Default bias when no safety rule trips: inline-fetch-first.** (cross-links to `sitecore-headless-to-xmc/references/edge-inline-fetch.md` for the RSC fetch pattern and the audit-trail contract)
3. **Defer to a resolver adapter.** Shell-only component + a `resolver-pending:` decision (see below).

**Safety rules — any one forces defer to a resolver adapter:**

- **(a) Editing-mode parity** — if the source's enriched data was editable in Experience Editor, it must stay editable in Pages; like-for-like forces defer.
- **(b) No Edge analog** — the enrichment needs server-only secrets, custom indexes not exposed to Edge, or C# logic with no Edge equivalent.
- **(c) Shared enrichment** — the same enrichment is needed by more than one migrated component; centralize via resolver adapter.

## Deferral contracts

Write decisions to the assigned native task-result/evidence file for the hub to reconcile. Include task key, rendering ID, category, detail, rationale, source evidence and unresolved owner. Preserve searchable prefixes: inline-edge-query: for an implemented query, resolver-pending: for missing enrichment, hazard-pending: for unsupported helpers.

Resolver candidates come from the discovery inventory, including discrete C# resolvers and controller-side shaping. Link each candidate to its component task; do not assume an automatic resolver store. A .resolver.ts stub is appropriate only for verified controller-transform/controller-service/json-endpoint behavior without unresolved external dependencies; a stub is not completed enrichment.

## Hazard-gate (Gate 3 enforcement)

Every inline Razor helper call (`@Translate.Text(...)`, `@Html.Sitecore().Field(...)`, `@Html.BeginForm(...)`, `@User.IsInRole(...)`, form/security/url/composition/custom helper calls, etc.) must be classified as one of `available-OOTB` / `no-op-OOTB` / `partial-OOTB` / `defer-to-customer` before a component may be marked `completed`. An unaccounted helper call is silent data loss — **Gate 3 fails** when any raw helper invocation is unaccounted for by either a translated equivalent or a `hazard-pending:` entry.

The typed hazard references (below) load on demand — only for the categories that come back non-empty from the analyzer's `viewSignals`. Five categories — `server-state`, `webforms`, `filesystem`, `output-pipeline`, `view-data` — have no sub-skill or reference file: they are uniformly `defer-to-customer` (no Content SDK equivalent) and go straight to a `hazard-pending:` entry.

## Quality gates (cannot skip — the fidelity backstop)

| Gate | When | Requires |
| --- | --- | --- |
| **Gate 0** | Before any work | Error + install-health baseline (`preview_logs` at `level: error`, npm health) |
| **Gate 1** | Before code | Data-flow table with TS types from the analyzer |
| **Gate 2** | After **every** shell/stub/replace step (not merely every file) | the frontend-migration native render-validation procedure (explicit pagePath and markers) PASS with explicit markers vs the Gate-0 baseline — BLOCKING at every cadence step, not just bare HTTP 200. "Pre-existing" errors require character-for-character proof from Gate 0. |
| **Gate 3** | Before checkpoint | Structural parity + selector-contract parity + hazard-gate classification complete (see Hazard-gate) + post-checkpoint fix policy |

**Checkpoint and fixes.** Follow the hub's native checkpoint procedure after Gate 3, recording the actual snapshot/diff reference and file scope. A later fix needs fresh validation and a new checkpoint reference in its result; the hub updates task status. Do not claim remote rollback from a local snapshot.

**Selector-contract parity (the Gate-3 clause).** For any behavior-critical element, verify the class contract across **three** legs: the class on the **source Razor markup** → the **source SCSS/CSS selector** carrying the behavior-critical rules → the class on the **migrated JSX**. A markup→JSX comparison passes while the styling silently dies, because the CSS keys on the name you changed.

**Never fake UI to bypass an error. Never modify template-owned framework files** (`sitecore.config.ts`, `sitecore.cli.config.ts`, `src/lib/sitecore-client.ts`, `src/lib/sitecore-client.server.ts`, resolver-registry/strategy/types, mock-layout-service). Inspect existing framework wiring; document a scoped native repair or a separately assigned scaffold task.

**Migrate outwards-in.** Convert the outer/wrapper component before the leaves it contains — a leaf inside an unmigrated wrapper has no mount point, and its Gate 2 fails for a reason unrelated to its own code.

**After editing any config file, restart before re-gating.** Emit `[⚠️ CHECKPOINT: Restart Required]`, restart the preview (`preview_stop`, then `preview_run`; see the dev-server skill), let it settle, re-check `preview_logs` at `level: error`, then re-run Gate 2 — proceed only on PASS.

**Never assume pre-existing code is correct.** If Gate 2 fails on a file you didn't write, that code is the problem — fix or rewrite it. (Conversely, excusing an error as "pre-existing" needs character-for-character proof from the Gate-0 baseline.)

---

## Dispatch — trigger inventory (Gate 1, code-backed)

**Reference selection is evidence-driven.** At Gate 1, before writing code, scan the source `.cshtml` (+ its controller/model) for the triggers below and **paste the raw command + output**. Every match makes its reference **mandatory**; Gate 1 is incomplete without the scan. The analyzer's `viewSignals` is the second input — a non-empty hazard category there is itself a trigger for that category's reference.

| Trigger | Reference (required on match) |
| --- | --- |
| `@Translate.` / `Translate.Text(` | `references/hazards/i18n.md` |
| `@Html.Sitecore().Field` · `BeginField`/`EndField` · `EditFrame` | `references/hazards/fields.md` |
| `Placeholder(` · `DynamicPlaceholder(` · `.Rendering(` · `.Controller(` | `references/hazards/rendering.md` |
| `BeginForm(` · `RenderFormStyles`/`Scripts` · `FormHandler` | `references/hazards/forms.md` |
| `VisitorIdentification` | `references/hazards/analytics.md` |
| `@Html.Partial` · `RenderPartial` · `@Html.Action` · `RenderAction` | `references/hazards/composition.md` |
| any customer-defined `@Html.*` / `@*Helper.*` not in the rows above | `references/hazards/custom.md` |
| `@section` (esp. `Scripts`/`Styles`) or head-zone content | `references/head-placement.md` |
| `@Styles.Render` · `BundleConfig.cs` · Razor `<link>` | `references/style-migration.md` |
| Glass Mapper model (`Glass.Mapper.*`, `[SitecoreType]`) | `references/glass-mapper.md` |
| a typed view-model on `@model` | `references/view-model-types.md` |
| a partial that becomes its own subcomponent | `references/partial-views.md` |
| controller/action supplies the data | `references/controller-data.md` |
| **always**, for the markup itself | `references/razor-translation.md` |
| jQuery · `.svg` imports · hooks/handlers/browser APIs | the `frontend-migration` references (`jquery-to-react.md` / `svg-svgr.md` / `use-client.md`) |

**Loading protocol:** load only on a **quoted** trigger (exact source line + number, or exact Gate-2 stderr line); **one reference per trigger**; never batch, never load "to be prepared", never infer from the component's name; a repeat trigger reuses guidance already in context.

**Troubleshooting is Gate-2-FAIL-only** — `sitecore-headless-to-xmc/references/troubleshooting.md` (§A nothing renders · §B unknown component · §C styling broken) applies to the target side for both paths. **Never preload it.**

*Reference files are added by the Code Migration and Resolver Adapters build steps; a missing entry means that construct isn't built yet.*

| Task | Reference |
| --- | --- |
| Translate Razor markup to JSX mechanics | `references/razor-translation.md` |
| Map controller/action data → props/Edge/resolver | `references/controller-data.md` |
| Read a Glass Mapper model | `references/glass-mapper.md` |
| Type a view-model into TS types | `references/view-model-types.md` |
| Convert a partial view into a subcomponent | `references/partial-views.md` |
| Place `@section`/head content in the target | `references/head-placement.md` |
| Read MVC-source styles (`BundleConfig.cs`, Razor `<link>`, `@Styles.Render`, `@section Styles`) | `references/style-migration.md` (cross-links to `frontend-migration/references/styles.md` for the generic target mechanics) |
| Classify an i18n helper (`Translate.*`) | `references/hazards/i18n.md` |
| Classify a field helper (`SitecoreHelper.Field*`, `BeginField`/`EndField`, `EditFrame`) | `references/hazards/fields.md` |
| Classify a rendering helper (`Placeholder`, `DynamicPlaceholder`, `Rendering`, `Controller`) | `references/hazards/rendering.md` |
| Classify a forms helper (`RenderFormStyles`/`Scripts`, `FormHandler`) | `references/hazards/forms.md` |
| Classify an analytics helper (`VisitorIdentification`) | `references/hazards/analytics.md` |
| Classify a composition helper (`Partial`, `RenderPartial`, `Action`, `RenderAction`) | `references/hazards/composition.md` |
| Classify a customer-defined/custom helper | `references/hazards/custom.md` |

For XMC targets, use the shared [script contract](scripts/README.md) and [resolver scaffold assets](../sitecore-headless-to-xmc/assets/resolver-framework/README.md). Inspect existing target wiring first and review a read-only plan. Replacements require exact current-file hashes and backups. Verify target SDK/bundler compatibility and runtime behavior; XP Headless targets need their own documented integration, not an assumed XMC scaffold.

## Where other things live

- **Migration process & gates-in-context** → the **`cms-migration`** hub (this skill is invoked *within* its loop).
- **Sitecore knowledge** (what Content SDK/Edge/fields are) → the **`sitecore`** skill.
- **Generic React/Next transforms** (jQuery→React, SVGR, `'use client'`, styles) → **`frontend-migration`**.
- **MVC native inspection and historical Roslyn vocabulary** (`mvc.complexity.kind`, `viewSignals`) → **`sitecore/references/mvc/analysis.md`** and **`sitecore/references/mvc/scan-razor-source.md`**.

## Native execution and handoff contract

Required capabilities: native file read/search/edit and local build checks; browser execution for visual/interaction evidence; authenticated Sitecore queries and SPE delegated to the selected connector. Verify availability before use. A script name in a manifest is not an installed capability.

Inputs: the migration type, `roots.source`/source revision and `roots.app`/`target.sdkVersion` from `${MIGRATION_STATE_FILE_DIR}/context.json`, separate source and target connector/site identities, scoped rendering/task key, baseline and evidence directory. Source code and raw captures remain read-only; write target code and task evidence only to their assigned writable paths.

Procedure: read the assigned task and prior evidence; inspect the source and captured payload; select the triggered references; make the scoped target transformation; validate rendering, editing and behavior; return changed paths, checks, gaps and checkpoint references. The cms-migration hub owns all six Sitecore phases and lifecycle decisions through native workflow files. Native memory is reusable context, never task status, evidence or approval storage.

Scripts: read the selected executable contract before execution. Remote SPE runs through the correct source/target connector with structured parameters; credentials stay with connectors. Local scripts cannot borrow that authentication. Preserve each sample's prerequisites, partial-result flags and explicit approval requirements; unavailable authenticated operations remain blocked rather than fabricated.

Completion evidence: source provenance, mapping/data-flow table, exact changed target paths, baseline-relative compile/render results, populated-region and selector checks, unresolved hazards and a restorable local checkpoint reference. A local checkpoint does not roll back Sitecore items or workspace configuration. The hub's checkpoint procedure defines the authorized mechanism; never invent an ID or require a commit when commits are prohibited.

Escalate unknown source/target identity, unavailable required capability, ambiguous mapping, missing baseline, protected-data dependencies or a failed gate. Return a partial/blocked result with evidence, not success. Framework repair is a separately scoped native change when needed; use the implemented [resolver scaffold](../sitecore-headless-to-xmc/scripts/README.md) or [mock scaffold](../sitecore-headless-to-xmc/assets/mock-layout-service/README.md) under that separate scope, with reviewed plans and hash-bound overwrite approvals.

## Result and decision schema

Return the [hub task-result contract](../cms-migration/references/task-results.md): taskId, outcome (success | failed | blocked | needs-redo | skipped), summary, evidence[], changedFiles[], checkpoint and unresolved[]. Only the coordinator writes workflow task.status. Read-only work returns an empty changedFiles array.

Decisions use the hub's scope, mapping, overwrite, mutation, verification or phase-continuation keys; preserve detailed hazard prefixes as rationale/evidence within the appropriate decision, not a competing state schema. Link the [decision contract](../cms-migration/references/decisions-and-approvals.md) and [checkpoints](../cms-migration/references/checkpoints.md).
