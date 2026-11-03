# Data flow → props (Gate 1 type transfer)

Trace field → prop flow, build the Gate-1 data-flow table, and wire child components with the correct types. Load whenever wiring a converted component's props or hitting a Gate-1 type mismatch. **The #1 cause of "compiles, HTTP 200, blank UI" is a child component created but never passed its data.**

## Trace the flow (parent → child → grandchild)
1. **Find field access in the parent:** direct (`fields.Title`), bracket (`fields['Hat Title']`), destructured (`const { Title } = fields`), or helper (`getFieldValue(fields,'Image')`).
2. **Find where fields become props:** `<Display title={fields.Title} hasHat={!!fields['Hat Title']} tag="h1" />`.
3. **Preserve every handoff exactly** — for multi-level nesting, each prop rename (`fields.Title → fieldValue → text`) is preserved verbatim.

## The Gate-1 data-flow table (required before code)
| Sitecore field | TS type | → child | prop | line |
|---|---|---|---|---|
| `fields.Title` | `TextField` | Display | `title` | 41 |
| `fields['Hat Title']` | `TextField` | Display | `hasHat` | 38 |
| static `"h1"` | `string` | Display | `tag` | 45 |

The **TS type** column is what stops `any` and catches errors at compile time.

## Transfer the types into the interfaces (the discipline that's usually skipped)
Agents build the table then use `any` anyway. **When writing each child interface, copy the type from the table:**
```ts
// ❌ interface SocialLinkProps { icon: any; link: any; }
// ✅
import { ImageField, LinkField, Link } from '@sitecore-content-sdk/nextjs';
interface SocialLinkProps { icon: ImageField; link: LinkField; }   // from the Gate-1 rows
```
No `any` in any interface (except `componentMap`).

## Reading analyzer output
Run `node ../scripts/analyze-field-access.mjs --root <source-dir> --output <report.json>` (see [scripts/README.md](../scripts/README.md)). Each file's report has two parts:

- `fieldAccess[]` — every `fields.X` / `fields['X']` / `props.fields.X` / `props.fields['X']` access (dot or optional-chained) the parser found directly. These are **`🟢 High`** confidence — structurally unambiguous, use as-is.
- `blindSpots[]` — the exact patterns the parser structurally cannot resolve, flagged explicitly rather than silently missed: `getFieldValue-call` (`getFieldValue(fields,'X')` and any other `getField*` helper — the field name is only known when the second argument is a string literal), `fields-destructuring` (`const { X } = fields`, lists the destructured names), `dynamic-field-name` (`fields[someVariable]`). Any component with one or more `blindSpots` entries is **`🔴 Low / not-inferred`** for the fields those entries cover — read the source and infer from usage. A component with real complexity but `fieldAccess: []` and no `blindSpots` either is worth a manual look anyway (the field access may be happening in a child file the analyzer didn't scan, or via a pattern genuinely outside this detector's four shapes).

There is no `🟡 Medium` tier — a match is either structurally certain (`fieldAccess`) or explicitly flagged as unresolved (`blindSpots`); nothing in between.

Note `damAssets.hasDamAssets: false` means "no DAM API usage", **not** "no images" — regular ImageFields (`.value.src`) aren't counted, only `.asset`/`.files` access is.

## Infer type from usage (when not in the analyzer)
`prop?.src` → `ImageField` · `prop?.value` → `TextField` · `prop?.href` → `LinkField` · `prop?.files` → `FileField` · `!!prop` / ternary → `CheckboxField | Field<boolean>` · passed to `<Asset field={prop} />` / `<Image>` → `ImageField`.

## Checklist (before "done")
- [ ] All parent fields identified; each field's handoff to children found.
- [ ] Field→prop table built with TS types; every child receives ALL required props with matching names.
- [ ] Transformations preserved (boolean coercion, string ops).
- [ ] Gate-1 types transferred to the actual interfaces — no `any`.
- [ ] `tsc --noEmit` clean.
