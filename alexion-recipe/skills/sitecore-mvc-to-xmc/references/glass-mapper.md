# Glass Mapper model → typed field contracts

Maps Glass Mapper model usage in MVC views/controllers to explicit, typed SitecoreAI component field contracts. Load whenever source code uses Glass model attributes, strongly-typed item models, or helper access patterns that hide raw field names.

## Goal

Convert Glass-driven model access into explicit TS field contracts without losing field intent.

## Mapping workflow

1. Identify the source model type used by the rendering.
2. Trace each model property to its underlying Sitecore field intent.
3. Build a typed TS interface that preserves nullable/optional behavior.
4. Keep naming aligned with the field contract expected by the migration pipeline.

## Rules

- Preserve semantic field meaning; do not remap to unrelated field names.
- Keep optionality if source property can be null or missing.
- Avoid `any`; use specific field types whenever possible.

## Escalation conditions

- If a model value is computed from controller-only logic, record a `resolver-pending:` rationale (see the pair SKILL.md's deferral contracts) and coordinate resolver-adapter follow-up.
- If a model combines multiple items implicitly, record evidence and avoid guessing merged shapes.

## Validation

- Confirm every referenced model property has a mapped TS counterpart.
- Confirm rendered output uses mapped fields under the same conditions.
