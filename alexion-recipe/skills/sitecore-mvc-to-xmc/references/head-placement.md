# Head placement — emit-shape contract

Emit-shape contract for MVC chrome components that render into a head or scripts placeholder. Load when the component's work-item context carries a head-placement signal (written by the Code Migration - MVC Styles step's head-placement producer). Covers the signal-read contract and the per-zone emit-shape table — swap the body wrapper to a head-eligible tag (`<style>` / `<link>` / `<meta>` / Metadata API) so React hoists it, instead of burying head markup in a `<div dangerouslySetInnerHTML>`.

Chrome components — the ones that inject a `<style>` block, a run of
`<meta>` / `<link>` tags, or a bottom-of-body `<script>` — render into a
**head** or **scripts** placeholder, not a body region. The default MVC
translation (`@Html.Raw(...)` → `<div dangerouslySetInnerHTML>`) buries that
markup in a body-position `<div>`, where the browser either hoists it wrong
or discards it. The fix is to **emit a head-eligible element** so React 19
hoists the real node into `<head>`.

This reference is the **consumer** half of the head-placement contract. The
**producer** (the MVC Styles step's head-placement step) detects which
placeholders sit in the head/scripts zone — structurally, by call-site
position — and records the signal on the affected component's work-item.

## When this reference applies

Load this reference when the component work-item's Decisions tail (read at
the start of the conversion cadence) carries a `head-placement:` rationale.
Absent that rationale → ordinary body component; this reference does not
apply.

## The signal

The source-inspection worker records the structural call site in the assigned native evidence file:

```text
head-placement: zone=<head|scripts>; placeholder=<placeholder-key>
```

Include task ID, rendering ID, source file/line, zone, placeholder and rationale. The consumer reads those fields, verifies the source position and preserves the signal in its result. The hub reconciles task decisions; no backend decision schema or memory key is involved. A missing signal does not prove body placement: inspect the call site when source contains head/scripts content.

The placeholder string is provenance, not a rule for guessing zone. Use the target's installed React/Next version to confirm hoisting behavior; the table below describes the intended output contract.

## Emit-shape table

| `zone` | Source shape | Emit (target) | Never |
| ------ | ------------ | ------------- | ----- |
| `head` | Raw `<style>` / CSS block | `<style dangerouslySetInnerHTML={{ __html: css }} />` — keep `dangerouslySetInnerHTML`, just on `<style>` not `<div>`. | A `<div>` wrapper. |
| `head` | `<link>` references (stylesheets, icons, preconnect) | Real `<link>` JSX elements. | A `metadata.other` string — it renders **escaped**. |
| `head` | `<meta>` tags (keywords, description, OG) | Real `<meta>` JSX elements, **or** the Next.js Metadata API (`export const metadata`) for `<title>` / canonical SEO. | A `metadata.other` string. |
| `scripts` | **Field-sourced** `<script>` — a field value flowing into a raw-HTML sink (`@Html.Raw(field)` → `dangerouslySetInnerHTML={{ __html: field.value }}`). | **Routing decision only:** hand the `<script>`-execution emit to the raw-field-rendering reference (the scaffolded `RawFieldHtml` renderer — see `sitecore-headless-to-xmc/references/raw-field-rendering.md`). Do NOT route this to `next/script`. | A `next/script` (it can't carry field-sourced markup) or a `<div>` wrapper. |
| `scripts` | **Static authored chrome** — a `<script>` you author at authoring time (jQuery, gtag, analytics loaders), not sourced from a field. | A `next/script` with an explicit `strategy`. | Inlining a `<script>` tag (it never executes) or a `<div>` wrapper. |

### The one rule

**Swap the wrapper element to a head-eligible tag — do not parse the field
into structured props.** The field content is already valid head markup; the
defect was the wrapping `<div>`, not the content. Changing the wrapper from
`<div>` to `<style>` / `<link>` / `<meta>` is the whole fix. A structured-prop
rewrite is out of scope and unnecessary.

## Scripts zone — boundary

For `zone: scripts`, this contract stops at the **routing decision**. There
are two cases, and they route to different canonicals:

- **Field-sourced scripts** — a field value flowing into a raw-HTML sink
  (`@Html.Raw(field)` → `dangerouslySetInnerHTML={{ __html: field.value }}`).
  The `<script>`-execution emit is owned by `sitecore-headless-to-xmc/references/raw-field-rendering.md`
  via the scaffolded `RawFieldHtml` renderer, which actually executes the
  injected markup. Record that the routing target is the raw-field-rendering
  reference; do not hand this to `next/script` and do not author the script
  body.
- **Static authored chrome** — scripts you author yourself (jQuery, gtag,
  analytics loaders), not sourced from a field. These stay `next/script`
  with an explicit `strategy`. Record the routing decision; the
  `strategy` / hydration timing is the `next/script` concern.

In both cases record the routing decision only; do not author the script body.

## Worked example (generic)

A component whose work-item carries `zone: head` and whose source emits a
raw style block:

Source Razor (read during discovery/conversion):

```cshtml
@Html.Raw(Model.InlineStyles)
```

Default (wrong) translation — body wrapper buries head markup:

```tsx
// ❌ lands in body position; React can't hoist it
<div dangerouslySetInnerHTML={{ __html: props.fields.inlineStyles.value }} />
```

Head-eligible emit — React hoists the real `<style>` into `<head>`:

```tsx
// ✅ real <style> element; dangerouslySetInnerHTML kept, wrapper swapped
<style dangerouslySetInnerHTML={{ __html: props.fields.inlineStyles.value }} />
```

The same swap applies per the table: a `<link>`-emitting component emits real
`<link>` JSX; a `<meta>`-emitting one emits real `<meta>` JSX (or the Metadata
API for title/SEO). The example uses a **neutral** field name on purpose —
apply the swap to the actual field your component reads.

## Anti-patterns

- Do NOT re-detect head-ness from the placeholder name. The producer already
  decided, structurally. Read the `zone`, trust it.
- Do NOT route a `<link>` through `metadata.other` — it renders as an escaped
  string, not a real link.
- Do NOT keep the `<div dangerouslySetInnerHTML>` wrapper "to be safe." A body
  `<div>` is exactly the defect this contract removes.
- Do NOT parse the raw field into structured props. Swap the wrapper element;
  leave the content as-is.
