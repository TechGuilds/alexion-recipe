# Editing mode (`useSitecoreContext` → `page` prop)

Migrate JSS `useSitecoreContext` / `pageEditing` / Experience Editor patterns to the SitecoreAI Pages model. Load whenever the source reads `sitecoreContext`, branches on `pageEditing`/`pageState`, or calls `isExperienceEditorActive()`.

## Core migration: hook → `page` prop
JSS used the `useSitecoreContext()` hook; **Content SDK puts `page` in props** (no hook needed for reads).
```tsx
// ❌ JSS
const { sitecoreContext } = useSitecoreContext();
const isEditing = sitecoreContext?.pageEditing;
// ✅ Content SDK
export const Default = (props: ComponentProps) => {
  const isEditing = props.page?.mode?.isEditing;
  return isEditing ? <EditView /> : <NormalView />;
};
```
`isExperienceEditorActive()` and `sitecoreContext?.pageState` likewise become `props.page?.mode?.isEditing` (keep the surrounding `useState`/`useEffect` logic **exactly** — and add `'use client'` since it uses hooks).

## `page.mode` flags
| Property | Meaning |
|---|---|
| `page.mode.isNormal` | normal viewing |
| `page.mode.isPreview` | preview in Experience Editor |
| `page.mode.isEditing` | editing in Experience Editor |
| `page.mode.isDesignLibrary` | Design Library (SitecoreAI) |
| `page.mode.name` | `'normal' \| 'edit' \| 'preview'` |

## Route / site / language data
```ts
// route:     sitecoreContext.route            → props.page?.layout?.sitecore?.route  (.fields, .name, .itemId)
// site:      sitecoreContext.site?.name        → props.page?.siteName
// language:  sitecoreContext.language          → props.page?.locale
// itemId:    sitecoreContext.itemId            → props.page?.layout?.sitecore?.route?.itemId
```

## Hook vs props
| Scenario | Use |
|---|---|
| Component receives `page` in props | `props.page.mode.isEditing` (most migrations — it's already there) |
| Needs `page` but doesn't receive it | `useSitecore()` hook |
| Needs to UPDATE context (rare) | `useSitecore({ updatable: true })` → `updatePage({ … })` (needs `'use client'`) |

## Detection → action
See `import { useSitecoreContext }`, `sitecoreContext?.pageEditing`/`pageState`, `isExperienceEditorActive()`, or `pageState === 'edit'` → add `'use client'`, convert reads to `props.page.mode.isEditing`, remove the JSS import, **keep the conditional logic pattern exactly**.
