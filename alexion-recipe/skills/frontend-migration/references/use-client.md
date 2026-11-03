# `'use client'` — when to add it, and how it propagates

Determine when a converted component needs `'use client'`, and apply the client-propagation rule through the tree. Load whenever a component uses hooks, event handlers, browser APIs, interactive UI, or renders inside a client-owned `AppPlaceholder`.

## Add `'use client'` when the component uses
- **React hooks:** `useState`/`useEffect`/`useContext`/`useRef`/`useReducer`/`useCallback`/`useMemo`.
- **Event handlers:** `onClick`/`onChange`/`onSubmit`/`onBlur`/`onKeyDown`/…
- **Browser APIs:** `window`/`document`/`localStorage`/`sessionStorage`/`navigator`/`location`.
- **Client-only libraries** (not SSR-safe) or **interactive UI** (dropdowns, modals, tabs, accordions, form validation, animations).

**Don't** add it for purely presentational components that only render Sitecore fields or do server-side fetching (keep them Server Components for performance). SDK field components (`<Text>`/`<RichText>`/`<Image>`/`<Link>`) work in **both** server and client components. When unsure on a complex component, start **with** `'use client'` and optimize later.

## The client-propagation rule (critical)
The client boundary follows imports: modules imported by a client entry join its client dependency graph. A server parent can pass server-rendered children into a client wrapper; nesting alone does not require every child file to declare `'use client'`. For `AppPlaceholder`, inspect the installed SDK's component registration and client map requirements with the pair skill before deciding which registrations need client variants.

For an unknown or missing child, inspect registration names, generated maps, parent imports, data and runtime logs. A missing directive is only one possible cause; do not propagate it across the whole tree without checking server-only dependencies.

**Migration workflow:** use saved usage evidence to identify the owning parent, trace its import/registration boundary, and record the SDK-specific decision. See [App Router conventions](app-router-conventions.md).

## Common patterns
- **Form with state:** `useState` + `onSubmit`/`onChange` → `'use client'`.
- **Interactive library** (`react-bootstrap` Navbar/Dropdown) → `'use client'`.
- **Hydration-safe client-only value:** compute in `useEffect` (guard with a `mounted` flag / `return null` on the server pass) to avoid mismatches from timestamps/random values.

## Error → fix
- `useState only works in Client Components` → add `'use client';`.
- `window is not defined` → move browser access out of module scope/render into an effect or an appropriate client-only integration. A client directive alone does not disable server prerender.
- `Hydration failed` → server/client mismatch; move client-only code into `useEffect` behind a `mounted` gate.
