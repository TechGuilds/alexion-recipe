# Troubleshooting a converted component

Diagnose a converted component that renders wrong. Three symptom families — pick the branch, then apply the fix. Cross-refs: `data-flow-to-props.md`, `placeholders.md`, `jss-to-content-sdk.md`, `component-registration.md`.

## Branch by symptom
| Symptom | Family |
|---|---|
| HTTP 200, no build errors, **blank/empty UI** | **Nothing renders** |
| **"unknown component"** in a placeholder (component IS registered) | **Unknown component** |
| A rendering is unresolved and is explicitly recorded as not yet migrated | **Incremental preview fallback** (not an error only when the scoped fallback is visibly verified) |
| Renders + content correct, but **layout/spacing/colors wrong** | **Styling broken** |

---

## A. Nothing renders (200, empty)
Five causes, checked in order:
1. **Fields not passed to children** — created a child but wired no props. Re-read source, pass ALL props the child expects (see `data-flow-to-props.md`). `<Child />` → `<Child title={fields?.Title} hasHat={!!fields?.['Hat Title']?.value} tag="h1" />`.
2. **Early `return null`** blocking the whole render — `if (!fields?.title) return null;` kills everything below. Convert to conditional renders: `{fields?.title && <Title … />}`.
3. **Wrapper → leaf swap** — original took `children` and rendered `{children}`; migration replaced it with specific components. Re-read source: if it has `children` in the signature or `{children}` in JSX, **preserve the `children` prop** (see the constitution's architecture rule).
4. **Wrong field names** — Sitecore field names are exact (spaces + capitals); the mock client does NOT transform them (only component names). `fields?.hatTitle` → `fields?.['Hat Title']`.
5. **Broken `getFieldValue`** — a re-created helper that returns `.value` unwraps one level too many, so `<Text>`/`<Image>` get a bare string/`{src}` and render nothing. Remove it → `<Text field={fields?.title} />` (see `jss-to-content-sdk.md`).

Diagnose: `preview_logs` (`level: error`; raise `lines` or use `level: all` for stack traces); the frontend native render-validation procedure on the component's route with class-name markers; check for empty `<div class="component…"></div>`.

## B. Unknown component
**Cause: missing `componentMap` prop** on the parent's `AppPlaceholder` — the placeholder can't look up children without it, so registered components still show "unknown". Fix (every component with a placeholder, at every nesting level): declare `componentMap?: any` on the interface → extract from props → pass to `AppPlaceholder` alongside `page` (see `placeholders.md`). Nested case: if a first-level child doesn't pass `componentMap` down, its own children break.
**Related — not registered:** file missing / wrong folder (`src/components/hero-banner/HeroBanner.tsx`, kebab folder, no spaces) / not exporting `export const Default`. Fix folder+export, then restart the preview (`preview_stop`, `preview_run`). **Never** run manual map-generation scripts (`sitecore-tools:generate-map`, `…/sitemap generate-component`) — components auto-register; manual generation causes file-watcher races (see `component-registration.md`).

## C. Styling broken
**Cause: you changed HTML — `className`/`id`/`role`/`aria-*`/`data-*`, tag type, or nesting order.** CSS selectors are exact contracts:
```css
.links {…}   #hero-banner {…}   section.hero {…}   .container > .hero-media {…}   [role="banner"] {…}   [data-theme="dark"] {…}
```
Any change breaks the match. **Never** "improve" a class name (`links`→`policies`), drop an `id`/`role`/`data-*` because "unused in React", change `<section>`→`<div>`, or flatten nesting. Only SDK imports / export pattern / optional chaining / TS types / `'use client'` may differ.
Fix: re-read the original (fresh, not from memory) → side-by-side attribute comparison (className/id/role/aria/data/tag/nesting) → rewrite to match character-for-character → validate the render. This is the Gate 3 / Gate 3A (selector-contract parity) check.

## D. Incremental preview fallback
If the exact rendering ID is explicitly classified as not yet migrated in the approved scope, an orange labeled placeholder is an intentional preview state only if the target framework's fallback has been verified in the browser. It must not masquerade as the converted component or swallow nested children that are expected to render. If that rendering is assigned for migration, or its status/mapping is unknown, treat the unresolved component as a defect or evidence gap—not as expected orange output. A missing route/fixture, failed build or runtime exception is always a failure, never a placeholder case. See [the Sitecore placeholder contract](placeholders.md#incremental-migration-preview-fallback).

## Quick checklist before "done"
- [ ] Re-read the original source fresh.
- [ ] All children receive all required props; field names exact (bracket notation for spaces).
- [ ] No early `return null`; `children` preserved if the original had it.
- [ ] Every `AppPlaceholder` gets `page` + `componentMap`.
- [ ] Every `className`/`id`/`role`/`aria-*`/`data-*`/tag/nesting matches source exactly.
- [ ] the frontend native render-validation procedure passes with the expected markers.
