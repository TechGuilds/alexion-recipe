# JSS SDK → Content SDK (imports + helpers)

Map JSS SDK imports and `getField*` helpers to their SitecoreAI Content SDK equivalents. Load whenever the source imports from `@sitecore-jss/*` or calls any `getField*` helper.

## Import mapping
```ts
// JSS (source)                              →  Content SDK (target)
import { Text, RichText, Image, Link } from '@sitecore-jss/sitecore-jss-nextjs';
// becomes
import { Text, RichText, Image, Link, NextImage, AppPlaceholder } from '@sitecore-content-sdk/nextjs';
import { ComponentProps } from 'lib/component-props';
```
Field components (`Text`/`RichText`/`Image`/`Link`/`NextImage`) keep the **same `field={…}` prop shape** — only the import path changes.

## The field-shape difference (the trap)
- **JSS fields** carry an extra wrapper: text is `{ value: "Hello", editable: "<span>…" }`; `getFieldValue` **unwraps `.value`** because of that wrapper.
- **Content SDK fields are already unwrapped** — `fields.title` is `{ value: "Hello" }`; `<Text field={fields.title} />` expects the **field object**, not the primitive.

**Never re-create a `getFieldValue` that returns `.value`** — it unwraps one level too many and breaks `<Text>`/`<Image>` (they receive a bare string/`{src,alt}` instead of `{value: …}`). Symptom: component renders but text/images are invisible.

## `getField*` translation
| JSS source | Content SDK target |
|---|---|
| `getFieldValue(fields, 'title')` passed to a field component | remove the helper → `<Text field={fields?.title} />` |
| `getFieldValue(fields, 'title')` used for a conditional/text extraction | access `.value` directly → `fields?.title?.value` |
| `getFieldValue(fields, 'title', 'default')` (with default) | nullish coalesce the **field object** → `fields?.title ?? { value: 'default' }` |
| `getFieldImageSrc(fields, 'image')` | `fields?.image?.value?.src`, or use `<Image field={fields?.image} />` |
| `getFieldText(fields, 'title')` | `fields?.title?.value`, or `<Text field={fields?.title} />` |
| dynamic field name (loops) | `fields?.[`${name}Title` as keyof typeof fields]` |

**Conditional-check pass-through** (when the source uses the helper to test existence before rendering): if you must keep a helper, write one that returns the **whole field object** (not `.value`):
```ts
const getFieldValue = <T extends Field>(fields: ComponentProps['fields'], name: string, dflt?: T): T | undefined =>
  (fields?.[name] as T) ?? dflt;
// then test: titleField?.value && <h1>{titleField.value}</h1>
```

## `withSitecoreContext` / context helpers
`withSitecoreContext` and JSS context HOCs → the SitecoreAI Pages editing model (`useSitecore`/`page` context) — see `editing-mode.md`.

## Rule
In Content SDK, `fields` are already in the right shape. **Access them directly; don't unwrap further.** Prefer the field components (`<Text>`/`<Image>`/`<Link>`) over manual `.value` reads wherever the source did.
