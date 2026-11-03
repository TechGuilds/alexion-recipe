# AppPlaceholder + nested placeholders

`AppPlaceholder` props, placeholder-name preservation, and the nested "unknown component" fix. Load whenever a converted component contains `<Placeholder>`/`<AppPlaceholder>` or nested placeholder children fail to resolve.

## AppPlaceholder requires BOTH `page` and `componentMap`
```tsx
'use client';
import { AppPlaceholder } from '@sitecore-content-sdk/nextjs';
import { ComponentProps } from 'lib/component-props';

interface NavigationProps extends ComponentProps {
  componentMap?: any;               // required for nested component resolution (the only allowed `any`)
}

export const Default = (props: NavigationProps) => {
  const { rendering, page, componentMap, fields } = props;
  return (
    <nav className="navigation">
      <AppPlaceholder
        name="jss-header"           // EXACT source name — never rename/shorten/camelCase
        rendering={rendering}
        page={page}                 // REQUIRED — omitting it → "Cannot read properties of undefined (reading 'mode')"
        componentMap={componentMap} // REQUIRED — omitting it → nested children show "unknown component"
      />
    </nav>
  );
};
```

## The two failure modes
- **Missing `page`** → runtime `Cannot read properties of undefined (reading 'mode')`.
- **Missing `componentMap`** → children render as **"unknown component"** even though they're registered. `AppPlaceholder` needs `componentMap` to look up child components; without it they can't be resolved.

**Fix order:** add `componentMap?: any` to the interface → extract it from props → pass it to `AppPlaceholder` → restart dev server → validate (HTTP + logs).

## Placeholder-name preservation (hard rule)
Keep placeholder names **exactly** as in source — they must match the Sitecore layout JSON.
```tsx
<Placeholder name="jss-header" … />   →   <AppPlaceholder name="jss-header" page={page} … />
```
Never `"header"` (shorter), `"jss-header-main"` (descriptive), or `"jssHeader"` (camelCase).

## Diagnostic checklist ("unknown component" in placeholder children)
- [ ] Parent renders `AppPlaceholder` with **both** `page` and `componentMap`.
- [ ] Parent interface extends `ComponentProps` and declares `componentMap?: any`.
- [ ] Parent extracts `componentMap` from props.
- [ ] Child components exist under `src/components/` and export `Default`.
- [ ] (Client propagation) if the parent is `'use client'`, its placeholder children must be too — see `../../frontend-migration/references/use-client.md`.

## Incremental migration preview fallback

During a partial migration, an in-scope route may contain both converted and not-yet-converted Sitecore renderings. Keep converted components bound to their real implementations. A confirmed, intentionally unconverted rendering may be shown as an obvious orange box labeled with its rendering name/identity so a reviewer can distinguish remaining work while still seeing converted siblings. Preserve and render nested placeholder children when the target SDK's supported extension point allows it.

This fallback is not a general error boundary: never render an orange box for a missing route/fixture, compile/runtime exception, malformed Layout Service response, missing mapping, or a component that was supposed to be converted. Diagnose those as failures. Inspect the target SDK's supported unknown-rendering extension point before changing framework code. If none is present, request a separately scoped, reviewable preview-foundation task; do not edit generated component maps or protected scaffold files, and do not claim the fallback exists until a browser check demonstrates it.
