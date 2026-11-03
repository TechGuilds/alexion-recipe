# View-model → TypeScript types

Builds strong TypeScript interfaces from MVC view-model usage so converted components preserve nullability, nested shapes, and field access semantics. Load whenever Razor or controllers pass typed view models to a rendering.

## Goal

Create accurate TS types that mirror real view-model behavior.

## Type derivation steps

1. Collect model properties used by the rendering.
2. Mark optional properties where source null checks exist.
3. Preserve nested object shape used by the view.
4. Separate display fields from computed/controller-only values.

## Rules

- Prefer explicit interfaces over loose records.
- Use nullable unions when source allows missing data.
- Keep naming stable across component and child props.
- Avoid type widening that hides contract issues.

## Common pitfalls

- Dropping null guards from source logic.
- Collapsing nested model objects into flat props without need.
- Treating computed values as persisted field data.

## Validation

- TS compile checks pass without `any` fallback.
- Branch logic using optional data matches source behavior.
- Child components receive compatible prop types.
