# Sitecore MVC Helper — Analytics

Classifies and translates Sitecore analytics helpers (`@Html.Sitecore().VisitorIdentification`) to their headless equivalents — typically a no-op on the head because the Edge / CD tier owns visitor identification. Loaded on demand by the `sitecore-mvc-to-xmc` hazard-gate whenever `VisitorIdentification` appears in `mvc.viewSignals.rawHelperInvocations` for the rendering being converted.

Use this skill when a `.cshtml` calls `@Html.Sitecore().VisitorIdentification()`.

## Match keys (from hazard inventory)

- `Sitecore.Mvc.Analytics.Extensions.SitecoreHelperExtensions.VisitorIdentification(Sitecore.Mvc.Helpers.SitecoreHelper)` — verdict `no-op-OOTB`.

## Translation rules

Visitor-identification is an Edge / CD concern in headless. Strip the call and leave a removal marker:

Source:

```razor
@Html.Sitecore().VisitorIdentification()
```

Target:

```tsx
{/* removed: @Html.Sitecore().VisitorIdentification() — handled at Edge */}
```

The removal comment is optional but recommended for layout / shell components — it documents the source-side analytics surface for future review.

## Anti-patterns

- Do NOT replace `VisitorIdentification` with a `<script />` tag that hits an analytics endpoint directly. The Edge / CD tier owns identification; the head shouldn't probe it.
- Do NOT promote this helper into a `hazard-pending:` deferral. The verdict is `no-op-OOTB` — strip and move on.

## Gate-3 ledger

Every `VisitorIdentification` call must be dropped from the generated TSX. The removal marker (or its absence) is not load-bearing; what matters is that the call doesn't survive verbatim.
