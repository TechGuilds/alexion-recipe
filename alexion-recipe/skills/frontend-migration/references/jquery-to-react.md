# jQuery → React-safe DOM

Replace jQuery with a React-safe DOM utility. Load whenever the source imports jQuery or uses `$()`/`jQuery()`/`.on()`/`.addClass()`/`.animate()`. **Never install jQuery in the target** — not even via dynamic `import()`.

## Why jQuery is unsafe in Next.js
| Problem | What happens |
|---|---|
| SSR crash | `$()` needs `window`/`document`, absent during server render |
| Hydration mismatch | jQuery mutates DOM before React hydrates → React sees unexpected HTML |
| Stale references | jQuery holds a selector-grabbed node React later replaces → detached-node bugs |
| Memory leaks | `.on()` handlers aren't cleaned on unmount; source never `.off()`s them |
| DOM-ownership conflict | jQuery bypasses React's virtual DOM → lost state, render bugs |

## The organic `dom-helpers.ts` pattern
Instead of scattering raw `document.querySelector` calls, build a project-specific `src/lib/utils/dom-helpers.ts` that **grows organically** — create it on the first jQuery component with only the functions you need; on later components, read it first and reuse/extend. Every helper is `'use client'` and event helpers **return a cleanup function** for `useEffect` teardown (the migrated code MUST clean up even though the source never did).

Starter (add only what you use — don't pre-populate):
```ts
// src/lib/utils/dom-helpers.ts
'use client';
export function qs(sel: string, scope: ParentNode = document) { return scope.querySelector<HTMLElement>(sel); }
export function qsa(sel: string, scope: ParentNode = document) { return Array.from(scope.querySelectorAll<HTMLElement>(sel)); }
export function onClick(sel: string, handler: (e: Event, el: HTMLElement) => void): () => void {
  const els = qsa(sel); const w = function (this: HTMLElement, e: Event) { handler(e, this); };
  els.forEach(el => el.addEventListener('click', w));
  return () => els.forEach(el => el.removeEventListener('click', w));
}
export function onDelegatedClick(sel: string, handler: (e: Event, el: HTMLElement) => void): () => void {
  const l = (e: Event) => { const t = (e.target as HTMLElement).closest<HTMLElement>(sel); if (t) handler(e, t); };
  document.addEventListener('click', l); return () => document.removeEventListener('click', l);
}
export function toggleClass(sel: string, c: string) { qsa(sel).forEach(el => el.classList.toggle(c)); }
export function addClass(sel: string, c: string) { qsa(sel).forEach(el => el.classList.add(c)); }
export function removeClass(sel: string, c: string) { qsa(sel).forEach(el => el.classList.remove(c)); }
export function hasClass(sel: string, c: string) { return qs(sel)?.classList.contains(c) ?? false; }
export function getScrollTop() { return window.scrollY; }
export function setScrollTop(v: number) { window.scrollTo(0, v); }
export function outerHeight(sel: string) { return qs(sel)?.getBoundingClientRect().height ?? 0; }
export function smoothScrollTo(sel: string, offset = 0) {
  const t = qs(sel); if (!t) return; window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
}
```
Keep the **same code structure** as the source (a `useEffect` calling DOM ops) — swap the import, map the calls, return the cleanup.

## Conversion table
| jQuery | dom-helpers |
|---|---|
| `$('.x')` / multiple | `qs('.x')` / `qsa('.x')` |
| `$('.x').on('click', fn)` | `onClick('.x', fn)` (or `onDelegatedClick` for delegation) — returns cleanup |
| `.addClass/removeClass/hasClass/toggleClass('y')` | `addClass/removeClass/hasClass/toggleClass('.x','y')` |
| `$(window).scrollTop()` / `(n)` | `getScrollTop()` / `setScrollTop(n)` |
| `$('.x').outerHeight()` | `outerHeight('.x')` |
| `$('html,body').animate({scrollTop}, ms)` | `smoothScrollTo('.x', offset)` (timing differs, functionally equivalent) |
| `$(function(){…})` | `useEffect(() => {…}, [])` |
| `.attr('data-x')` / `.focus()` | `qs('.el')?.getAttribute('data-x')` / `qs('.el')?.focus()` |

## Complex patterns (no 1:1 — propose in Gate 1)
- `$.animate()` custom easing → Web Animations API (`el.animate()`) or `framer-motion`.
- jQuery plugins → a React equivalent, or wrap the DOM work in `useEffect` with cleanup.
- `$.ajax/get/post` → `fetch()` (map success/error to try/catch).
- jQuery UI (draggable/sortable/datepicker) → React equivalents (`@dnd-kit/core`, `react-datepicker`) — these ARE new deps; install via `bash npm install` (pin from source, run a health check; **never** jQuery).

## Rules
Never install jQuery · build the utility organically · always return cleanup from event helpers · all helpers are `'use client'` · check if `dom-helpers.ts` already exists (reuse) · preserve the component's logic flow.
