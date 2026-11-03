# Sitecore MVC Helper — Forms

Classifies and translates Sitecore Experience-Forms helpers (`RenderFormStyles`, `RenderFormScripts`, `FormHandler`) to the Content SDK `<Form />` integration. Loaded on demand by the `sitecore-mvc-to-xmc` hazard-gate whenever `mvc.viewSignals.formHelperCalls` is non-empty for the rendering being converted, or when any `@Html.Sitecore().FormHandler` / `RenderFormStyles` / `RenderFormScripts` call appears in `rawHelperInvocations`.

Use this skill when a `.cshtml` calls Experience-Forms helpers. Note: generic ASP.NET MVC form helpers (`@Html.BeginForm`, `@Html.AntiForgeryToken`, `@Html.TextBox`, etc.) are **defer-to-customer** — load `references/hazards/custom.md` for those.

## Match keys (from hazard inventory)

- `Sitecore.ExperienceForms.Mvc.Html.RenderingExtensions.RenderFormStyles(System.Web.Mvc.HtmlHelper)` — verdict `no-op-OOTB`.
- `Sitecore.ExperienceForms.Mvc.Html.RenderingExtensions.RenderFormScripts(System.Web.Mvc.HtmlHelper)` — verdict `no-op-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.FormHandler(string, string)` — verdict `no-op-OOTB`.

## Translation rules

### `@Html.RenderFormStyles()` and `@Html.RenderFormScripts()`

These are no-ops on the head — the Content SDK `<Form />` integration bundles styles and scripts. Drop the call.

Source:

```razor
@Html.RenderFormStyles()
@Html.RenderFormScripts()
```

Target: (removed)

Leave a one-line comment marking the deletion if the file would otherwise lose a leading comment block:

```tsx
{/* removed: @Html.RenderFormStyles() / @Html.RenderFormScripts() — bundled with <Form /> */}
```

### `@Html.Sitecore().FormHandler(...)`

Also a no-op — `<Form />` rendering handles form submission wiring. Drop the call.

### Forms rendering itself

The Experience-Forms rendering converts to the Content SDK `<Form />` component. Its data shape comes through Layout Service like any other rendering — there is no helper call to translate inside an arbitrary view.

## Anti-patterns

- Do NOT preserve `RenderFormStyles` / `RenderFormScripts` / `FormHandler` calls — leaving them in the TSX file produces undefined-identifier errors and is silent visual cruft.
- Do NOT manually inject form-styles / form-scripts script tags — the Content SDK ships them.

## Gate-3 ledger

Every Experience-Forms helper call must be dropped (with optional removal comment) from the generated TSX. Gate 3 fails if any of these calls survive verbatim.
