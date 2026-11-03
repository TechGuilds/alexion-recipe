# MVC-source style migration

Reads MVC-source styles (`BundleConfig.cs`, Razor `<link>` tags, `@Styles.Render`, `@section Styles`) and translates them to the SitecoreAI Next.js target. Load when the Code Migration - Styles step runs under `xpmvc2sai` and the native style-analysis script (`frontend-migration/references/style-analysis.md`) returns an `mvc` field with BundleConfig or Razor style reference data. For the generic Next.js target-side wiring (globals.scss import order, CSS Modules, Tailwind config) shared with the headless path, see `frontend-migration/references/styles.md`.

This reference covers ASP.NET MVC → SitecoreAI style system translation rules.
It applies when the native style-analysis script (`frontend-migration/references/style-analysis.md`) returns an `mvc` field in its
analysis output (i.e. under `xpmvc2sai` after MVC discovery has run).

---

## Reading the mvc? field

The native style-analysis script (`frontend-migration/references/style-analysis.md`) returns an `mvc` object when Roslyn discovery
data is present. It contains four sections:

```
mvc.bundleConfigs[]     — ASP.NET bundles (virtualPath + includes)
mvc.razorLinkTags[]     — href values from <link rel="stylesheet"> tags
mvc.stylesRender[]      — bundle virtual paths from @Styles.Render("...")
mvc.sectionStyles[]     — file paths that use @section Styles { ... }
```

If the source is JSS/headless, use the headless procedure. If the source is MVC
and `mvc` is absent, the analysis is incomplete: obtain the staged Roslyn artifact
and rerun with `--source-kind mvc --mvc-analysis`. Do not treat missing evidence
as permission to skip MVC styles.

---

## Rule 1 — BundleConfig bundle order → globals.scss import order

`mvc.bundleConfigs` lists bundles in BundleConfig.cs declaration order.
Declaration order is inventory, not proof of page cascade order. The actual
layout's `@Styles.Render` and `<link>` sequence determines insertion order.

**Action:** Use `bundleConfigs[].includes` to derive the correct `@import`
order within each bundle in the target `globals.scss` (or equivalent entry file).
Order the bundle blocks by the actual layout's render/link sequence. If aggregate
metadata cannot distinguish layouts, inspect the producer's per-view evidence.

```
first rendered bundle → first @import block in globals.scss
second rendered bundle → second @import block
...
```

Cross-reference with `cssImports[].path`, `file`, `line`, and `raw` from the FS analysis to map
bundle CSS globs to actual SCSS partials.

---

## Rule 2 — Razor `<link>` tags → Next.js import sites

`mvc.razorLinkTags` contains raw href values from `<link rel="stylesheet">`
tags in Razor layout and partial views.

**Common patterns:**

| Razor href | Next.js equivalent |
|---|---|
| `/Content/print.css` | Copy file to `src/assets/`, import in Layout.tsx or a specific page |
| CDN URL (e.g. `//fonts.googleapis.com/...`) | Keep as-is in a `<link>` tag via `next/head` or the Next.js metadata API |
| `~/bundles/...` (handled by BundleConfig) | Already covered by Rule 1 — skip |

If the href is a CDN or external URL, add it to the `<Head>` component in
`src/Layout.tsx` rather than as a JS import.

---

## Rule 3 — @Styles.Render → which CSS module wires into Layout.tsx

`mvc.stylesRender` lists bundle virtual paths called by `@Styles.Render`.
These are the bundles the layout actively injects into the page.

**Action:** The `@Styles.Render("~/bundles/site-css")` call means
`~/bundles/site-css` is the primary stylesheet bundle. Map its `includes`
(from Rule 1) to the SCSS entry file imported in Layout.tsx.

```typescript
// In src/Layout.tsx — maps to @Styles.Render("~/bundles/site-css")
import 'src/assets/sass/site.scss';
```

If multiple bundles are rendered (e.g. both `site-css` and `vendor`),
import them in `@Styles.Render` order.

---

## Rule 4 — @section Styles → per-page CSS injection

`mvc.sectionStyles` lists Razor view file paths that use
`@section Styles { ... }` to inject page-specific CSS.

**Action:** For each file listed:

1. Identify the corresponding SitecoreAI component (cross-reference with
   the component analysis).
2. Move the page-specific CSS to a co-located `.module.scss` or a scoped
   import inside that component.
3. Do **not** hoist page-specific styles into the global SCSS entry point.

```typescript
// Before (Razor): @section Styles { <style>.hero { ... }</style> }
// After (Next.js): import styles from './Hero.module.scss';
```

---

## Evidence strings to watch for

When the native style-analysis script (`frontend-migration/references/style-analysis.md`) includes these evidence entries, this
reference applies:

- `BundleConfig: N bundle(s) — ~/bundles/site-css, ...`
- `Razor <link> tags: N stylesheet reference(s)`
- `@Styles.Render: N call(s)`
- `@section Styles: N file(s)`

Only treat empty MVC findings as absence after checking `scan.complete` and
confirming the appropriate Roslyn input was supplied.

---

## Cross-cutting findings — see the shared gotchas reference

The saved report contains top-level cross-cutting arrays; the command's compact
stdout contains their counts under `crossCutting`. These findings apply to
both MVC and headless migrations:

- Razor `<link>` tags whose href is a CDN URL (FontAwesome Pro, Semantic
  UI, etc.) — these become `externalStylesheets[]` entries in the report.
- `<body class="@(...)">` server-conditional classes — these become
  `serverInjectedBodyClasses[]` entries.
- `style="@Model.X"` viewmodel CSS-string properties — these become
  `dynamicStyleAttributes[]` entries and require the
  `parseCssString()` utility.
- SCSS partials coupled to external JS dependencies require targeted inspection.
  The script does not automatically populate `externallyCoupledPartials`; a zero
  count is not proof that no coupling exists. Record inspected findings separately.

For the full triage flow, the canonical `parseCssString` utility, the
"body is a Server Component" pattern, and CDN licensing rules, load
`frontend-migration/references/style-cross-cutting.md`. It is shared
between MVC and headless flavors so the patterns stay consistent.
