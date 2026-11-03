# Partial views → component composition

Converts MVC partial view composition to SitecoreAI component composition and placeholder-safe rendering patterns. Load whenever a source rendering references partial views, nested view fragments, `Html.Partial` calls, or mixed partial-plus-placeholder layouts.

## Goal

Translate partial composition safely without breaking nested rendering behavior.

## Supported translation patterns

- `Html.Partial` and static partial includes: map to explicit child components.
- Repeated partial blocks: keep iteration context and key stability.
- Placeholder-backed child regions: use `AppPlaceholder` with `page` and `componentMap` (see `sitecore-headless-to-xmc/references/placeholders.md` for the full `AppPlaceholder` contract).

## Critical rules

- Keep placeholder names exactly as discovered.
- Do not hardcode root placeholder assumptions.
- Keep wrapper/selector structure required by style contracts.

## RenderAction guard

- If source composition uses `Html.Action` or RenderAction-like behavior:
  - treat as controller/resolver data composition,
  - do not fake it as a static partial,
  - record a `resolver-pending:` rationale (see the pair SKILL.md's deferral contracts) for resolver-adapter phase follow-up.

## Validation

- Child regions render in expected order.
- No `unknown component` errors for nested placeholder content.
- Empty expected child regions are treated as a failure, not success.
