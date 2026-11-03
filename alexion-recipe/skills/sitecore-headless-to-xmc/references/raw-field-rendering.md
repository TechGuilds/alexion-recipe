# Raw-field rendering (make injected scripts run)

**A `<script>` inserted via `dangerouslySetInnerHTML` never executes** — the HTML parser flags it "already started". Route any field whose value is raw HTML through the scaffolded `RawFieldHtml` renderer so contained scripts run. Load the moment a **field value flows into a raw-HTML sink** (`dangerouslySetInnerHTML={{ __html: field.value }}` in JSS; `@Html.Raw(field)` in MVC).

## Why the plain wrapper is broken
A script inserted *after* parse time through `innerHTML`/`dangerouslySetInnerHTML` is never executed — the markup string is present but the behavior is gone (an **inert tag**). Validation that only checks "is the tag there?" reports a false pass. The fix is **not** to parse the field into discrete tags (it's per-page runtime content, unknowable at conversion time) — it's one universal renderer that writes the raw value **and revives** every contained `<script>`.

## Detection is structural (never name-based)
Any field value flowing into a raw-HTML sink takes this path — CSS fields, script fields, head-markup, mixed content all the same, because at conversion time you can't know which a given field holds. Never key on field name, component name, or content.

## The fix — import `RawFieldHtml`, pass your source field
```tsx
// ❌ inert — a <script> in this field never runs
<div dangerouslySetInnerHTML={{ __html: props.fields.embedMarkup.value }} />
// ✅ scripts revived and executed
import { RawFieldHtml } from '@/components/content-sdk/RawFieldHtml';
<RawFieldHtml html={props.fields.embedMarkup.value} />
```
`RawFieldHtml` is generated during initialization (`src/components/content-sdk/RawFieldHtml.tsx`) — a `'use client'` component that renders the value and, in a `useEffect`, re-creates every contained `<script>` as a live element (attrs + inline code, source order, cleanup on unmount); style/plain markup passes straight through. The field binding (`embedMarkup` is a placeholder) comes **verbatim** from this component's source binding. **Never** inline the revive logic or hand-write a raw sink around a script. `RawFieldHtml` is a protected scaffold — don't edit it; if missing, surface that (target helper is unavailable) and route a scoped helper implementation to the hub; the target helper is unavailable until a scoped helper implementation is provided.

## Self-verify (structural, at conversion time)
Grep your own output before marking done: it **must find** `RawFieldHtml` and **must NOT find** a hand-rolled `dangerouslySetInnerHTML` on a field value (outside `RawFieldHtml` itself). A residual raw sink on a field value is a self-verify failure. (Proving a revived script *actually ran* is a runtime/Playwright concern, out of scope here.)

## Scope
**Not** for scripts you author as static chrome in `Layout.tsx` (jQuery, gtag, analytics) — those are known at authoring time → use `next/script` with an explicit strategy. This is only for **field-sourced** raw HTML (runtime data).
