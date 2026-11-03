# SVG & SVGR

Handle SVG imports when converting a component. **Preserve the source SVG pattern-class; enable target framework support incrementally per component; never assume config exists.** Load whenever a converted component imports a `.svg`, uses `react-inlinesvg`, references an icon library, or SVG imports fail at build.

## Five patterns → target
| Source | Target |
|---|---|
| CRA `import { ReactComponent as Icon } from './icon.svg'` | **convert** to default import `import Icon from './icon.svg'` (needs SVGR) — CRA syntax fails in Next.js even with SVGR |
| `import Icon from './icon.svg'` | keep (needs SVGR) |
| icon library `import { X } from 'lucide-react'` | keep (verify it's in `package.json`) |
| `import InlineSVG from 'react-inlinesvg'` | keep (verify installed) |
| inline `<svg>…</svg>` | keep as-is (no config) |

**Pattern-class preservation (Gate 3):** file-based SVG import must stay file-based — do **not** silently replace with inline `<svg>` or an icon-library swap. Those deviations require **explicit HITL approval** (quote the source import, state the deviation + risks + fallback). The only no-HITL translation is CRA `{ReactComponent}` → Next default import (same class).

## SVGR config (for the file-import patterns)
Verify before claiming it exists — read `next.config.ts` and **quote** the webpack block; if absent, state "SVGR not configured" then add:
```ts
webpack(config) {
  config.module.rules.push({ test: /\.svg$/i, issuer: /\.[jt]sx?$/, use: ['@svgr/webpack'] });
  return config;
}
```
Add `@svgr/webpack` (^8.1.0) as a devDependency via `bash` `npm install -D @svgr/webpack` (pin from source where present; **never install jQuery**; run a health check after — see the Sandbox safety guidance), then **restart the dev server** (config changed) and validate. Never claim "SVGR is configured" without quoting the block you read.

## The `public/` trap
Files under `public/` are static assets — webpack (and SVGR) never process them. A tsconfig alias resolving to `public/` (e.g. `icons/* → public/icons/*`) works in CRA but **crashes at runtime in Next.js**: TS compiles clean, then the page 500s with `Module parse failed: Unexpected token` and the error path contains `public/`. Fix: move the SVGs into a `src/` subdir (e.g. `src/assets/icons/`) and update the alias — you **cannot** fix it with config while they stay in `public/`. Don't misdiagnose the resulting 500 as "dev server / proxy / preexisting infra" — `Module parse failed` + `public/` in the path is this cause.

## Error → fix
- `Module parse failed: Unexpected token` on a `.svg` → SVGR not configured (add rule, install `@svgr/webpack`, restart) — or the `public/` trap above.
- `Cannot find module 'lucide-react'` → install the icon library actually used in source.
- SVG shows as `[object Object]` → imported as a URL, not a component → import as a component (default import with SVGR).

## Checklist
- [ ] SVG pattern identified; `next.config.ts` checked + webpack block quoted (or "not found").
- [ ] SVGR config added if needed; `@svgr/webpack` installed; **dev server restarted after config change**.
- [ ] CRA `{ReactComponent}` converted to default import; pattern-class otherwise preserved.
- [ ] SVG renders in the browser.
