# SXA rendering variants to components

Read the source variant tree and rendering parameters. Record variant ID/name, field sections, wrappers, classes, conditions, tokens, links and ordering. Resolve inherited/shared definitions and custom rendering logic; do not assume a variant is just a field list.

Map each selected variant to a target component variant or explicit parameter-driven branch, preserving selector and editing contracts. Keep a table from source variant ID and rendering occurrence to target export/parameter. Detect name normalization collisions before registration.

Scriban, custom processors and server-side conditions require source inspection and a recorded disposition. Do not copy a variant item and assume Content SDK executes it. Unresolved behavior becomes a hazard or resolver dependency.

Test every used variant with its datasource and parameters, including empty optional fields. Delegate target rendering item creation and page/partial design operations to sitecore; the hub owns phase ordering. For XP Headless consult [target scope](target-xp-headless.md) before selecting target templates.
