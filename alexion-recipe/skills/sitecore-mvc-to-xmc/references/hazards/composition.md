# Sitecore MVC Helper — Composition

Classifies and translates MVC composition primitives (`Html.Partial`, `Html.RenderPartial`, `Html.Action`, `Html.RenderAction`) to Content SDK React components, placeholder slots, RSC self-fetch, or resolver-adapter escalation per the hazard-inventory sub-pattern rules. Loaded on demand by the `sitecore-mvc-to-xmc` hazard-gate whenever `mvc.viewSignals.partialViewRefs` or `htmlActionCalls` is non-empty, or any `Partial`/`RenderPartial`/`Action`/`RenderAction` invocation appears in `rawHelperInvocations` for the rendering being converted.

Use this skill when a `.cshtml` composes child markup via `Html.Partial`, `Html.RenderPartial`, `Html.Action`, or `Html.RenderAction`.

## Match keys (from hazard inventory)

- `System.Web.Mvc.Html.PartialExtensions.Partial(System.Web.Mvc.HtmlHelper, string, object)` (+ overloads) — verdict `available-OOTB`.
- `System.Web.Mvc.Html.RenderPartialExtensions.RenderPartial(System.Web.Mvc.HtmlHelper, string, object)` (+ overloads) — verdict `available-OOTB`.
- `System.Web.Mvc.Html.ChildActionExtensions.Action(System.Web.Mvc.HtmlHelper, string, string, object)` (+ overloads) — verdict `partial-OOTB`.
- `System.Web.Mvc.Html.ChildActionExtensions.RenderAction(System.Web.Mvc.HtmlHelper, string, string, object)` (+ overloads) — verdict `partial-OOTB`.

## Translation rules

### `Html.Partial(name, model)` / `Html.RenderPartial(name, model)` → React subcomponent

Each `_Foo.cshtml` partial becomes one `Foo.tsx`. The `@model` declaration becomes the props interface (see `references/view-model-types.md`). `ViewBag` / `ViewData` is lifted to explicit props during conversion.

Source:

```razor
@Html.Partial("_HeroBadge", Model.Hero)
```

Target:

```tsx
<HeroBadge {...model.hero} />
```

`MvcHtmlString` vs output-stream is irrelevant in React — both `Partial` and `RenderPartial` translate identically.

### `Html.Action(action, controller, args)` / `Html.RenderAction(...)` — pick one of four sub-patterns

The analyzer inspects the target controller's action signature and body (see `sitecore/references/mvc/analysis.md`) and routes:

1. **Sitecore-rendering controller called from a view that is itself a rendering** → resolver adapter that enriches the parent rendering's Layout Service output. The child becomes a React component receiving the enriched fields as props. Load `sitecore-headless-to-xmc/references/resolver-adapter.md` and record `resolver-pending: <controller>.<action> — ...`.

2. **Sitecore-rendering controller called from a layout** → promote the inline child to its own rendering, place it in a placeholder slot with a `componentMap` entry. The child component reads its data from its own Layout Service slot.

3. **Non-Sitecore controller fetching its own data** (external API, cache, repository) → async React Server Component that fetches its own data inside the component body. App Router only. Load `sitecore-headless-to-xmc/references/edge-inline-fetch.md` if the data source is Edge; otherwise wire `fetch(...)` directly.

4. **Action body is a thin partial passthrough** (no data fetch) → flatten to `<Child {...props} />`, same as `Html.Partial`.

If none of the four classify cleanly, emit `hazard-pending: composition — Action("<ctrl>", "<action>"); unclassified target`.

## Anti-patterns

- Do NOT absorb a `Html.RenderAction` target's data fetch inline when the target is itself a Sitecore rendering — that breaks rendering-level migration boundaries. Pick sub-pattern 2 (promote to own rendering) instead.
- Do NOT pick sub-pattern 3 (RSC self-fetch) for a target controller that hits the master / web databases via Sitecore APIs. Edge is the data plane in headless; controller-side Sitecore reads route through a resolver adapter (sub-pattern 1).

## Gate-3 ledger

Every `Partial` / `RenderPartial` / `Action` / `RenderAction` call must either appear as the matching React composition in the generated TSX, or be recorded as `hazard-pending: composition — ...` (or `resolver-pending: ...` when sub-pattern 1 fires).
