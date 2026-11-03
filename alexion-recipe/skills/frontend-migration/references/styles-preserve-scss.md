# Preserve SCSS and CSS

Use when source appearance and selector compatibility must be retained. Inputs are the style report, actual layout/bundle order, source asset root and target Sass/bundler configuration.

1. Inventory reset/vendor/theme/component/override files and their inclusion order. Trace Sass imports, variables, mixins, fonts and URL references; record unresolved imports before copying.
2. Transfer assets to an intentional target location and adjust URLs according to their new emitted location. Public assets use application URLs; imported assets use the bundler's resolution. Verify case-sensitive paths.
3. Create or extend the existing root global entry in source cascade order. Preserve framework partial position. Retain module scoping only where it existed or where every selector consumer is understood.
4. Check the installed Sass version and supported syntax. Do not casually convert ordered legacy imports to module semantics: namespace and evaluation changes can alter output. Record any required compatibility change.
5. Preserve classes, IDs, nesting and specificity used by CMS output or external plugins. Do not remove apparently unused selectors based only on a filesystem search.
6. Build and inspect representative routes at source breakpoints. Check fonts, computed styles, pseudo-elements, RTL where applicable, and asset failures.

Return ordered file mappings, dependency/configuration edits, URL changes and known couplings. Follow [cross-cutting guidance](style-cross-cutting.md) for external styles and dynamic fields, and [render validation](render-validation.md) for evidence. Reload/restart the preview as needed after configuration changes.
