# Sitecore MVC Helper — Rendering composition

Classifies and translates Sitecore rendering-composition helpers (`Placeholder`, `DynamicPlaceholder`, `Rendering`, `Controller`, `ViewRendering`, `CurrentItem`, `CurrentRendering`) to Content SDK placeholder + Layout Service equivalents. Loaded on demand by the `sitecore-mvc-to-xmc` hazard-gate whenever `mvc.viewSignals.placeholderCalls` is non-empty or any of those helper names appear in `rawHelperInvocations` for the rendering being converted.

Use this skill when a `.cshtml` calls placeholder helpers or context-item/rendering accessors.

## Match keys (from hazard inventory)

- `Sitecore.Mvc.Helpers.SitecoreHelper.Placeholder(string)` — verdict `available-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.DynamicPlaceholder(string, int, int, int)` and overloads — verdict `available-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.Rendering(string, object)` — verdict `partial-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.Controller(string, string, object)` — verdict `partial-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.ViewRendering(string, object)` — verdict `partial-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.CurrentItem` (property) — verdict `available-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.CurrentRendering` (property) — verdict `available-OOTB`.

## Translation rules

### `@Html.Sitecore().Placeholder("ph-name")`

App Router target:

```tsx
<AppPlaceholder name="ph-name" rendering={rendering} componentMap={componentMap} />
```

Pages Router target:

```tsx
<Placeholder name="ph-name" rendering={rendering} />
```

`sitecore-headless-to-xmc/references/placeholders.md` carries the deeper App-vs-Pages router contract (`AppPlaceholder`, nested placeholders, client-propagation); load it when this gate fires.

### `@Html.Sitecore().DynamicPlaceholder("ph-name", count, max, modifier)`

Same `<Placeholder />` / `<AppPlaceholder />` translation. Headless Layout Service emits per-rendering unique placeholder keys, so the "dynamic" affordance is built-in.

If `count`, `max`, or `modifier` overloads are passed with non-default values, emit `hazard-pending: rendering — DynamicPlaceholder("<name>", ...); non-default overload args`.

### `Rendering(path)` / `Controller(controller, action)` / `ViewRendering(path)`

Inline-by-path rendering composition is replaced by Layout Service routing. Promote the inline child to its own rendering entry in `componentMap`, add a placeholder slot, and let Layout Service deliver the child's data via its own slot.

When the child is controller-driven and needs enrichment, route through `sitecore-headless-to-xmc/references/resolver-adapter.md` rather than absorbing the data fetch inline.

### `CurrentItem` / `CurrentRendering`

These context accessors flow through component props in headless:

| Source | Target |
|---|---|
| `@Html.Sitecore().CurrentItem` | The component's `fields` / context-item props from Layout Service, or `useSitecore().page.layout.sitecore.route`. |
| `@Html.Sitecore().CurrentRendering` | The component's own `rendering` / `params` / `fields` props. |

Never reach for a global helper to access the current item or rendering — the props carry it.

## Anti-patterns

- Do NOT hardcode a placeholder name that the analyzer didn't surface.
- Do NOT lift `Rendering` / `Controller` / `ViewRendering` inline composition into a single component — Layout Service owns composition.

## Gate-3 ledger

Every rendering-composition helper must either appear as the matching placeholder / Layout Service surface in the generated TSX, or be recorded as `hazard-pending: rendering — ...`.
