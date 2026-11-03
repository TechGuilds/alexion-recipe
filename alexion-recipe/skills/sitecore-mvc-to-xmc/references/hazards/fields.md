# Sitecore MVC Helper — Fields

Classifies and translates Sitecore field/rendering helpers (`@Html.Sitecore().Field`, `BeginField`/`EndField`, `EditFrame`) to Content SDK field components. Loaded on demand by the `sitecore-mvc-to-xmc` hazard-gate whenever `mvc.viewSignals.fieldHelperCalls`, `fieldHelperConstantCalls`, or any `Field`/`BeginField`/`EndField`/`EditFrame` entry in `rawHelperInvocations` is present for the rendering being converted.

Use this skill when a `.cshtml` calls `@Html.Sitecore().Field(...)`, `BeginField`/`EndField`, or `EditFrame`.

## Match keys (from hazard inventory)

- `Sitecore.Mvc.Helpers.SitecoreHelper.Field(string, object)` — verdict `available-OOTB`. Field-type discriminator picks the Content SDK component.
- `Sitecore.Mvc.Helpers.SitecoreHelper.Field(string, Sitecore.Data.Items.Item, object)` — verdict `partial-OOTB` (datasource-resolver concern, not a helper concern).
- `Sitecore.Mvc.Helpers.SitecoreHelper.BeginField/EndField` — verdict `partial-OOTB`.
- `Sitecore.Mvc.Helpers.SitecoreHelper.EditFrame` — verdict `partial-OOTB`.

## Field-type → Content SDK component map

Analyzer field-type inference (from `mapping.viewModel.fields[*].fieldType` and template lookup) picks the component:

| Sitecore field type | Content SDK component | Import |
|---|---|---|
| Single-Line Text, Multi-Line Text | `<Text field={fields.X} />` | `@sitecore-content-sdk/nextjs` |
| Rich Text | `<RichText field={fields.X} />` | `@sitecore-content-sdk/nextjs` |
| Image | `<Image field={fields.X} />` or `<NextImage field={fields.X} />` | `@sitecore-content-sdk/nextjs` |
| General Link | `<Link field={fields.X} />` | `@sitecore-content-sdk/nextjs` |
| Date / Datetime | `<DateField field={fields.X} />` | `@sitecore-content-sdk/nextjs` |
| File | `<File field={fields.X} />` | `@sitecore-content-sdk/nextjs` |

## Translation rules

### `@Html.Sitecore().Field("Title")` → `<Text field={fields.Title} />`

Use field-type inference to pick the component. If the field type is ambiguous (no analyzer signal, no template hit), emit `hazard-pending: fields — Field("<name>"); ambiguous field-type`.

### `BeginField` / `EndField` wrappers

- If the wrapped markup is purely decorative chrome, drop the wrapper — the inner field component owns chrome.
- If the wrapping is semantically meaningful (e.g. wrapping an `Image` inside a `Link`), either restructure to a Content SDK composition, or emit `hazard-pending: fields — BeginField/EndField; semantic wrapper`.

### `EditFrame`

Limited support in Content SDK v1. Most edit-frame chrome semantics land as `hazard-pending: fields — EditFrame; semantic chrome`. Translate only when the analyzer can prove the frame is decorative.

## Anti-patterns

- Do NOT downgrade an editable `@Html.Sitecore().Field` to a read-only `{fields.X.value}` — that breaks Experience Editor / Pages parity.
- Do NOT invent a new field-type discriminator path that bypasses the analyzer's `fieldType` signal.

## Gate-3 ledger

Every field-helper call must either appear as the matching Content SDK field component in the generated TSX, or be recorded as `hazard-pending: fields — ...`.
