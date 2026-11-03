# Style cross-cutting gotchas

Inspect external stylesheets, server-injected body classes, dynamic style attributes and externally coupled partials alongside SCSS/Bootstrap/Tailwind detection. Load when the native style analyzer reports findings or source review identifies these patterns. Zero counts do not rule them out: externally coupled partials are not automatically populated, and incomplete scans need manual review. Applies to both headless and MVC source.

**Read the full data:** the native script returns counts only; read the full arrays from its JSON `destination` using native `read`. Check `scan.complete` and omissions first. No companion markdown is generated. Earlier tool-created reports may still exist; keep them as historical evidence, not the current run's result.

## 1. External CDN stylesheets (`externalStylesheets[]`)
Triage account-scoped CDN URLs against the migration's license decision and preserve unresolved dependencies. Copy same-origin styles to the target asset tree and include them in the root style entry in their observed order. For external stylesheet links, follow the installed App Router's supported resource placement; do not use arbitrary metadata fields or Pages Router `Head` as a substitute. CMS chrome/head rendering belongs to the pair skill's head-placement guidance. See [App Router conventions](app-router-conventions.md).

## 2. Server-injected body classes (`serverInjectedBodyClasses[]`)
Source: `<body class="@(User.IsLoggedIn() ? "logged-in" : "")">` (MVC) or a JSX `<body className={…}>` expression. In App Router `<body>` is a Server Component in `app/layout.tsx` — you **cannot** branch its `className` on user state without breaking static rendering / leaking auth state into cached HTML. Pattern: toggle the class on `document.body` from a small `'use client'` component that reads the state:
```tsx
'use client';
export function BodyStateClasses() {
  const { isLoggedIn } = useUser();
  useEffect(() => { document.body.classList.toggle('logged-in', isLoggedIn);
    return () => document.body.classList.remove('logged-in'); }, [isLoggedIn]);
  return null;
}
```
Mount it in the layout. Surface the class list so the user confirms each still needs a toggle (some may be droppable).

## 3. Dynamic style attributes / CSS-string fields (`dynamicStyleAttributes[]`)
A Sitecore field stores a CSS string (`color:#ff0000; padding:8px;`) passed to a `style` attribute. React's `style` prop wants an **object**, not a string. Drop this `parseCssString` into `src/utils/parse-css-string.ts` and use it at the component boundary:
```ts
export function parseCssString(value: string | null | undefined): React.CSSProperties {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const decl of value.split(';')) {
    const i = decl.indexOf(':'); if (i === -1) continue;
    const prop = decl.slice(0, i).trim(), val = decl.slice(i + 1).trim();
    if (!prop || !val) continue;
    out[prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;   // kebab → camelCase
  }
  return out;
}
// <div style={parseCssString(fields.CTABoxButtonColor?.value)}>…</div>
```
If the same field powers multiple components (or downstream needs typed sub-values), parse it once in a **resolver adapter** and expose a typed shape instead.

## 4. Externally-coupled SCSS partials (`externallyCoupledPartials[]`)
A partial (`_coveo.scss`) targets DOM owned by a third-party JS lib. Surface it + ask: is that dependency also being migrated (→ keep the partial + note the coupling), replaced (→ mark for deletion in a follow-up), or unknown (→ keep + flag; unused selectors are harmless)? **Never** delete a coupled partial without explicit user confirmation — surface it as a `deferred` entry.

## Report
Populate `crossCuttingGotchas` in the developer's result with `found` counts, one-line `actedOn`, and one-line `deferred` entries (e.g. "_coveo.scss kept — Coveo migration tracked separately"; "FontAwesome Pro kit URL kept on CDN pending license confirmation").
