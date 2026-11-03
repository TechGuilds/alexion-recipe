# Sitecore MVC analysis evidence

Discovery is read-only source inspection, not code generation or task-state mutation. Route here for sourcePlatform mvc, including xpmvc2xpheadless. The retired MCP tool remains unavailable. The implemented [analyze-dotnet CLI](../../scripts/analysis/analyze-dotnet.mjs) runs the retained analyzer with an explicitly supplied runtime/image; follow [runtime delivery and invocation](scan-razor-source.md).

Use [native source inspection](scan-razor-source.md) now. Preserve proven historical AST artifacts with their source commit and analyzer version, but do not present stale outputs as a fresh scan. Native/LSP findings must carry file/line evidence and coverage limits; regex matches are not Roslyn equivalence. Unknown bindings, dynamic calls and ambiguous types remain unresolved.

The vocabulary below retains the historical analysis contract for interpretation. Current executable guarantees and parser limits are defined in [local analysis](scan-razor-source.md); do not infer exhaustive coverage from historical descriptions. Supplemental native findings require explicit provenance and confidence. Discovery outputs feed the hub; only the coordinator edits workflow status.

## Mapping and interpretation rules

### 2. Rendering → Roslyn mapping is deterministic, not heuristic

```
❌ NEVER guess which controller class implements which Sitecore rendering
✅ ALWAYS resolve from the Sitecore rendering item's "Controller" + "Controller Action" fields
✅ ALWAYS match by exact short class name (e.g. "HeroController"), never a substring match
```

**Pattern the tool applies:**
1. For each Controller Rendering in the rendering catalog, take `controller_class` (e.g. `Project.Feature.Hero.Controllers.HeroController, Project.Feature.Hero`) and `controller_action` (e.g. `Index`).
2. Strip the assembly suffix (split on `, `, take index 0); take the unqualified short class name (split on `.`, take last).
3. Find that exact short class name among the analyzer's controller results (matching by short name, since fully qualified names may differ between the Sitecore field and the source).
4. Resolve the action by matching `controller_action` against the controller's actions; default to `Index` when the field is empty.
5. Resolve the view: an explicit view name wins; otherwise the convention `Views/{ControllerName-without-Controller-suffix}/{ActionName}.cshtml`.

Renderings with no captured `controller_class` (View Renderings, JSON Renderings) fall back to convention-only matching by rendering item name → view file name. Renderings with no match at all go into `unmappedRenderings[]` for human review — never fabricate a triple.

### 3. View → ViewModel mapping uses the `@model` directive first

```
❌ NEVER guess which class is the view model from class-name patterns alone
✅ ALWAYS prefer the view's model directive when present
✅ ONLY fall back to convention when @model is absent
```

**Pattern:**
1. If the view's `@model` directive is set → match to the analyzer's view-model results by fully qualified name. This is the authoritative binding.
2. If the view's `@inherits` directive is set (Glass Mapper pattern, e.g. `@inherits GlassView<IHero>`) → extract the type parameter, match to the Glass Mapper model results by interface name.
3. If neither directive is present → the view has no view model. Do not invent one.

### 4. Field names come from four sources, reconciled

```
❌ NEVER infer field names from C# property names
✅ ALWAYS extract field names from explicit Sitecore API calls
✅ ALWAYS reconcile across Razor, controller, item-model, and field-constant sources
```

**The four sources, in priority order:**
1. **Razor view** — field-helper calls with string-literal args (e.g. `@Html.Sitecore().Field("Title")`, `BeginField("Title")`) and field-helper calls with constant-ref args (e.g. `@Html.Sitecore().Field(FieldIds.Title)` — resolved via the field-constants source).
2. **Controller actions** — string field-name accesses and constant field accesses (resolved via field constants).
3. **Item models** — per-property wrapped-field mapping for the dominant non-Glass pattern (`public string Title => InnerItem.Fields[FieldIds.Title].Value;`); for multi-field getters, fall back to the item model's class-level field-access set.
4. **Field constants** — the `{ClassName}.{FieldName}` → actual-field-name mapping, used to resolve constant references from sources 1–3.

**Reconciliation rule:** the union of all four sources is the rendering's field set. Reconcile against the Layout Service mock JSON `fields` object — fields present in code but absent from the JSON indicate computed or resolver-supplied data (flag for resolver-adapter consideration).

**Codebase-shape note:** different codebases lean on different sources. Razor-field-helper-heavy codebases populate source 1 densely; controller-driven codebases populate source 2; item-model-pattern codebases (typical of legacy non-Glass MVC) populate source 3 — sometimes almost exclusively. A near-empty (1)+(2) result on a 100+ Razor-view codebase is **not** a bug — check source 3 before concluding the analysis is shallow.

### 5. Glass Mapper is identified by attributes, not naming

```
❌ NEVER classify a class as a Glass Mapper model based on its name
✅ ALWAYS rely on the analyzer's Glass Mapper result set (already filtered by [SitecoreType]/[SitecoreField] presence)
```

**Rationale:** the analyzer was specifically validated to eliminate false positives from service interfaces with similar naming. Trust its detection.

### 6. Helix layer is derived from file path against solution architecture

```
❌ NEVER hardcode Helix-layer detection logic
✅ ALWAYS check the analyzer's solutionArchitecture verdict first
✅ ALWAYS parse filePath segments only when architecture === "Helix"
```

**Pattern:** `solutionArchitecture === "Helix"` → derive layer by scanning `filePath` for path segments `Feature`, `Foundation`, or `Project` (case-sensitive, in that priority order). Any other architecture (`flat`, `multi-project`, undefined) → `helixLayer: null`.

### 7. Resolver data is a separate, migration-agnostic artifact

```
❌ NEVER duplicate resolver AST data into the MVC rendering source mapping
✅ ALWAYS keep the per-resolver artifact separate; join by className when a consumer needs both
```

**Rationale:** per the small-targeted-artifact principle, resolver C# AST data is a separate concern with a different consumer (Resolver Adapters) than the MVC rendering source mapping (Code Migration). Keep them apart; let consumers join by `className`.

**Resolver inventory contract.** Save discrete Rendering Contents Resolvers and controller-side data shaping as separate candidates joined by rendering ID and class identity. The hub reconciles these into native resolver tasks; no automatic state seeding occurs. Absence can justify a phase skip only after complete scope inspection.

### 8. Preserve complete available evidence

Save targeted rendering mappings, separate resolver/controller shaping details and raw inputs. For native inspection retain the commands and source excerpts, never fabricate a raw AST file. Mark omitted outputs and partial scope explicitly. A pure frontend repository has no C# foundation; report that distinction.

### 9. No hardcoded paths, IDs, or customer names

```
❌ NEVER hardcode customer-specific content paths
❌ NEVER reference specific assembly names as if universal
❌ NEVER assume a particular Helix folder layout
✅ ALWAYS use placeholders ({sitePath}, {assemblyName}, {sourceRoot})
✅ ALWAYS read `roots.source` from `${MIGRATION_STATE_FILE_DIR}/context.json`
```

---

## Anti-hallucination rules

- **Never infer fields not in the Roslyn output.** If a resolver's field-access set is empty, it does not explicitly access named fields — it likely walks Sitecore APIs that return whole items. Do not invent likely field names; mark the rendering as needing resolver-adapter inspection.
- **Never infer Sitecore APIs not in the Roslyn output.** If a resolver's detected API-call list contains `["GetItem"]`, do not also write `["GetItem", "GetChildren"]` because "it looks like it walks children." Trust the AST — the analyzer detected exactly what calls exist.
- **Never invent return shapes.** A resolver's return shape is one of `single`, `list`, `anonymous`, `unknown`. If the analyzer reports `unknown`, write `unknown`. Do not classify based on guesswork.
- **Never invent components.** If a Sitecore rendering item exists in the catalog but has no Roslyn match (no captured `controller_class`, no convention match by name), write it to `unmappedRenderings[]` with a clear `reason`. Do not fabricate a controller/view/viewModel triple.

---

## Rendering type classification

Sitecore rendering template types:

| Template | Has controller? | Has view? | Notes |
|---|---|---|---|
| **Controller Rendering** | Yes (`Controller` + `Controller Action` fields) | Convention-resolved or explicit | Most common. Full controller logic. |
| **View Rendering** | No | Yes (rendering's `Path` field, e.g. `~/Views/Hero/Index.cshtml`) | View-only, no server logic. |
| **Json Rendering** | Yes (returns JSON via an HTTP-get action) | None (or unused) | API endpoint, no Razor view. |
| **Sublayout** | (legacy ASP.NET WebForms) | (legacy `.ascx`) | Out of scope — flag for human review. |

**Implications for mapping:**
- Controller Rendering → expect both `controller` and `view` populated.
- View Rendering → `controller: null`, `view` populated.
- Json Rendering → `controller` populated, `view: null`.
- Sublayout → emit to `unmappedRenderings[]` with `reason: "sublayout/webforms — manual review required"`.

---

## Field helper → Content SDK mapping (reference only — discovery does not translate)

| Razor helper detected | Implied field type |
|---|---|
| `@Html.Sitecore().Field("X")` (basic) | Text / single-value field |
| Glass `@Model.X.Rendered` | Field (renderable, editable) |
| Glass `@Model.X.Value` | Field (raw value) |
| `@Html.Sitecore().Placeholder("name")` | Placeholder (not a field; tracked separately) |

The actual Content SDK component (`<Text>`, `<Image>`, `<RichText>`, `<Link>`) is picked by Code Migration from the Layout Service JSON's typed `fields` object — never inferred from Razor here. Discovery only records what was called; translation happens in `sitecore-mvc-to-xmc`.

---

## Style analysis boundaries

Two complementary sources, neither alone sufficient:

| Source | What it provides | Limitations |
|---|---|---|
| Native style-analysis script (`frontend-migration/references/style-analysis.md`) | CSS/SCSS/SASS/LESS inventory and framework/build-tool detection; merges supplied Roslyn style references in MVC mode | Capped or skipped inputs are explicitly partial; it does not parse C#/Razor itself |
| The Roslyn analyzer's style-reference result | `BundleConfig.cs` bundles, `_Layout.cshtml` `<link>` tags, `@Styles.Render()` calls, `@section Styles` | No filesystem CSS file inventory |

**Discovery rule:** run the native script with `--source-kind mvc --mvc-analysis`
pointing to the raw Roslyn artifact returned by discovery. It combines both into
one report; check `scan.complete` and preserve its actual evidence destination.
If no compatible Roslyn artifact exists, record native C#/Razor findings separately and report the missing structured style input. For frontend patterns outside
the static detector's coverage, use targeted LSP/source inspection and record the
additional evidence separately. Report unresolved gaps rather than inventing data.

---

## Configuration patch awareness

Config-patch data from the analyzer is **awareness-only** at discovery time: report counts and pipeline names, but do not attempt to translate config patches — App_Config XML patches have no direct SitecoreAI equivalent. Code Migration (and possibly a future config-migration effort) consumes this data to flag manual-review work. Do not infer SitecoreAI equivalents from `<patch:after>` directives — just record what's there.

---

## Soft failure modes

| Condition | Behavior |
|---|---|
| Source has zero `.cs` files (a pure-frontend repo misclassified as MVC) | Log a warning ("no C# foundation detected"); skip the code-side staged files and the C#-foundation section of the report; complete discovery successfully. |
| Roslyn analyzer returns errors (bad source root, missing assemblies) | Surface the error verbatim; do not retry; do not fabricate output. |
| Layout/mock-layout capture failed upstream | Non-fatal to code discovery — proceed code-only; the layout-derived enrichment (usage cross-reference, home-page inventory) is skipped, everything else proceeds. (Headless-services / license gating for layout capture is a **Setup**-time concern — MVC-source `discovery-only` runs bypass that gate entirely; this skill never probes for it.) |
| Renderings without a captured `controller_class` | Fall back to convention match by name; if still no match, go to `unmappedRenderings[]`. Do not abort. |

---

## Discovery outputs

| Output | Kind | Purpose |
|---|---|---|
| `code-discovery-report` | Artifact (markdown) | Synthesis-compatible summary; authored per the `cms-migration` Discovery Phase 1 contract — no component file paths embedded in the content. |
| MVC rendering source mapping | Staged JSON (`agent-data/discovery/mvc/`) | Per-rendering controller/view/viewModel join; the source evidence for per-rendering conversion. |
| Resolver analysis | Staged JSON (`agent-data/discovery/mvc/`) | Per-resolver + controller-side-shaping AST data; migration-agnostic; the inventory the hub uses for resolver tasks. |
| Raw analysis (escape hatch) | Staged JSON (`agent-data/discovery/mvc/`) | Full unfiltered analyzer result; the safety net for outputs with no targeted consumer yet (Hard Invariant #8). |

Read the needed slices of evidence files directly. Reports link actual paths and source provenance; no automatic projection or artifact retrieval tool is assumed.

---

## Downstream signal vocabulary — `mvc.complexity.kind` / `viewSignals` / `externalDependencies`

The following historical tokens remain useful to pair-skill consumers. A supplemental native classification must be labeled as such with supporting lines; unknown is preferable to an unsupported deterministic claim.

- **`mvc.complexity.kind`** — a historical five-way verdict; record the evidence and whether it came from historical structured analysis or current native inspection:
  - `view-only`, `controller-passthrough` — no stub emitted downstream; data is props + inline Edge fetch.
  - `controller-transform`, `controller-service`, `json-endpoint` — these three need controller-side enrichment; downstream, a resolver-adapter stub is emitted for renderings in this bucket.
- **`mvc.externalDependencies`** — non-empty means the rendering depends on something with no Edge analog (a search SDK, a third-party service, etc.). Downstream, this is the shell-only-and-escalate override, independent of `complexity.kind`.
- **`mvc.viewSignals`** — the categorized inline-helper-call inventory extracted per rendering:
  - `translateHelperCalls` — `@Translate.*` invocations (i18n).
  - `formHelperCalls` — `@Html.BeginForm`, `@Html.AntiForgeryToken`, `@Html.RenderFormStyles/Scripts`, `@Html.Sitecore().FormHandler`, `@Ajax.*`.
  - `securityHelperCalls` — `@User.*`, `@Membership.*`, `@FormsAuthentication.*`, `@HttpContext.*`.
  - `urlHelperCalls` — `@Url.Action`, `@Url.Content`, `@Url.RouteUrl`.
  - `fieldHelperCalls` / `fieldHelperConstantCalls` — Sitecore field/rendering helpers (`@Html.Sitecore().Field`, `BeginField`/`EndField`, `EditFrame`); the `Constant` variant keys the field by a string literal. Classified downstream by `sitecore-mvc-to-xmc/references/hazards/fields.md`.
  - `placeholderCalls` — rendering-composition helpers (`Placeholder`, `DynamicPlaceholder`, `Rendering`, `Controller`, `ViewRendering`, `CurrentItem`, `CurrentRendering`). Classified by `hazards/rendering.md`.
  - `partialViewRefs` / `htmlActionCalls` — MVC composition primitives (`Html.Partial`/`RenderPartial` and `Html.Action`/`RenderAction` respectively). Classified by `hazards/composition.md`.
  - `customHelperCalls` — helper calls that don't match any typed category and don't match the field/placeholder/partial/action/glass extractors.
  - `rawHelperInvocations` — a broad catch-all of every inline helper call in the view, verbatim; the lookup input when disambiguating an unclassified call.
  - `modelPropertyAccesses` — typed-property (`@Model.X`) and typed-loop-variable accesses, used downstream to build the Gate-1 data-flow table alongside declared viewModel properties.
- **`mvc.viewModel.properties[]`** — the declared schema: each entry carries the C# type (from the Roslyn analyzer) plus a field-type inference (`sitecoreFieldType`, `contentSdkComponent`, `confidence`) added by the projection layer, not the raw analyzer.

**Why this matters for discovery, concretely:** every one of these downstream fields is a re-projection of data this skill's Hard Invariants govern how to read faithfully — `viewSignals.*HelperCalls` come from the same field/helper extraction Hard Invariant #4 describes; `complexity.kind` and `externalDependencies` are built from the controller/service/resolver detection Hard Invariants #2 and #7 describe. Getting the discovery-time interpretation right is what makes the downstream vocabulary trustworthy — this skill has no separate "classify complexity" step of its own to duplicate.

---

## What this skill does not decide

1. Whether to translate a component — Code Migration's call (`sitecore-mvc-to-xmc`).
2. Which Content SDK field helper to use — Code Migration picks from the Layout Service JSON shape.
3. Whether to write a resolver adapter — Resolver Adapters' call, fed by the resolver inventory this skill stages.
4. How to translate config patches — out of scope everywhere in this migration.
5. Whether the migration is feasible — the orchestrator's and the human's call.

**This skill's job:** interpret the analyzer's output accurately and completely, and know the artifact/signal vocabulary well enough that discovery never silently degrades what downstream phases depend on. Nothing more.

---

## Where other things live

- **MVC → SitecoreAI transform** (translation cadence, quality gates, hazard classification of the signals above) → **`sitecore-mvc-to-xmc`**.
- **Migration process & gates-in-context** → the **`cms-migration`** hub (Discovery Phase 1 dispatches MVC code analysis, pointing here).
- **Sitecore platform knowledge** (what fields/Edge/Content SDK are, content-side discovery) → the rest of the **`sitecore`** skill (its other references).
