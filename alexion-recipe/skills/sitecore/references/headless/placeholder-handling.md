# Placeholder semantics

Inspect the source layout tree before changing component composition. A placeholder is a rendering collection, not a field or an arbitrary React child.

Record route, device, parent rendering UID, exact placeholder key, ordered child rendering IDs, datasource IDs and parameters. Keep repeated occurrences distinct by UID and ancestry. Preserve dynamic placeholder suffixes until their relation to rendering IDs is demonstrated; never strip suffixes globally or assume main is the root.

Follow nested placeholders recursively, including SXA partial/page designs. Empty children may be legitimate on one route but a missing branch on another. Compare expected populated regions against browser output; HTTP 200 is insufficient.

Target registration must resolve every observed component name without collisions. Delegate SDK-specific wiring to [the headless pair](../../../sitecore-headless-to-xmc/references/placeholders.md) and SXA resolution to [the SXA reference](../sxa/placeholder-resolution.md). Save unresolved keys and source examples for the hub's coverage review.
