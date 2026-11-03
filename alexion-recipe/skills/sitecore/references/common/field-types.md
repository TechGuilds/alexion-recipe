# Sitecore field types

What each Sitecore field type is, how its raw value looks, and how it maps to the SitecoreAI Content SDK. Load when reasoning about a field's shape (source or target). The component-side TS-type mapping also lives in the headless pair's `data-flow-to-props.md`; this is the platform-knowledge companion.

## Type → value shape → Content SDK
| Sitecore field type | Raw value | Content SDK component / TS type |
|---|---|---|
| Single-Line / Multi-Line Text | plain string | `<Text>` / `TextField` |
| Rich Text | HTML string | `<RichText>` / `RichTextField` (raw-HTML-with-scripts → `RawFieldHtml`, see pair `raw-field-rendering.md`) |
| Image | XML/attrs → `{ src, alt, width, height }` | `<Image>` / `<NextImage>` / `ImageField` (access `.value.src`) |
| General Link | `{ href, text, target, class, … }` | `<Link>` / `LinkField` (access `.value.href`) |
| Checkbox | `"1"`/`""` (boolean) | `CheckboxField \| Field<boolean>` (`!!field.value`) |
| Date / Datetime | ISO-ish string | `DateField` / `Field<string>` |
| Number / Integer | numeric string | `Field<number>` |
| Droplink / Droptree / Reference | **single GUID** | resolve the referenced item (Edge query or datasource) |
| Multilist / Treelist / Checklist | **pipe-delimited GUIDs** `{G1}|{G2}` | array of referenced items — split with `.Split("|")`, never `-split "\\|"` (SPE gotcha) |
| Grouped/Name-Value | encoded key/value | parse per usage |

## Key behaviors
- **JSS vs Content SDK field shape:** JSS fields carry an extra `.value`+`.editable` wrapper; **Content SDK fields are already unwrapped** — `<Text field={fields.title} />` expects the field object `{ value }`, not the primitive. Never re-create a `getFieldValue` that returns `.value` (pair `jss-to-content-sdk.md`).
- **Field names are exact** — spaces + capitalization preserved (bracket notation `fields['Hat Title']`); never camelCase. (In GraphQL they're *mangled* — see `graphql-and-edge.md`; in layout JSON / component props they're exact.)
- **Standard-values fields** (`__…`) hold defaults + presentation; leading `__` fields are system fields.
- **Multi-value / reference fields store GUIDs**, not names — resolve them via a datasource, an Edge query, or a resolver adapter (pair `resolver-adapter.md`) when the component needs the referenced item's fields.
- **Raw-HTML fields** (CSS/script/embed content) route through `RawFieldHtml` so contained scripts execute (pair `raw-field-rendering.md`).

## No `any`
In component interfaces, use the exact Content SDK type from the table (except `componentMap`) — the Gate-1 data-flow table is the source (pair `data-flow-to-props.md`).
