# Razor → JSX translation mechanics

Translates Razor view patterns to SitecoreAI React/TSX with minimal behavioral drift, including conditional blocks, loops, helpers, and field rendering patterns. Load whenever a migrated MVC component reads `.cshtml` source or Razor syntax needs a safe React equivalent.

## Goal

Map Razor view behavior to React/TSX while preserving output intent.

## Translation rules

- `@if`, `@else`, ternaries: keep branch logic and order.
- `@foreach`: map to `.map()` with stable keys where possible.
- `@Html.Raw(...)`: convert to safe rich text rendering patterns, not string concatenation hacks.
- Inline text/field helpers: map to typed SDK field renderers.

## Structure rules

- Keep wrapper hierarchy and class names unless a compatibility change is required.
- Do not flatten nested containers that styles depend on.
- Preserve aria and data attributes.

## Anti-patterns

- Do not rewrite into a different component architecture for convenience.
- Do not collapse helper-driven sections into hardcoded strings.
- Do not remove guards that prevent null/empty content rendering.

## Validation checklist

- Compare key branches between Razor and TSX.
- Confirm output sections appear under the same conditions.
- Confirm expected rich text/HTML regions render without new runtime errors.
