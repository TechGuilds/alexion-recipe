# SXA placeholder resolution

How placeholders resolve in Headless SXA — the model the converted site relies on so components render in the right slots. Load when a converted page's renderings land in the wrong placeholder, or when wiring Page/Partial Designs.

## Placeholder settings
An SXA placeholder is defined by a **Placeholder Settings** item that lists the *Allowed Controls* (which renderings may be placed there) and, for nested/dynamic placeholders, the placeholder key pattern. In the head (Next.js Content SDK) the `<AppPlaceholder name="…">` name must match the placeholder key the layout service emits — see the headless pair's `placeholders.md` for the component-side contract.

## Resolution in the composition chain
On a converted site, a rendered page composes presentation from, in order:
1. the **Page Design** assigned to the page's template (via TemplatesMapping),
2. the **Partial Designs** that Page Design references (header/footer/shared layout),
3. any **page-specific renderings** on the item's own presentation.

A rendering resolves into a placeholder when its placeholder key matches a placeholder exposed by the layout at that level. Partial Designs contribute their renderings into the placeholders they define; the Page Design stitches them together. This is why Presentation Migration can **strip** renderings that the PD chain now supplies — they'd otherwise render twice.

## Dynamic placeholders
Renderings that expose child placeholders (containers) use a **dynamic placeholder key** (`key-{suffix}`) so multiple instances don't collide. Preserve the exact key naming from source — a mismatched key means the child renderings resolve to nothing (blank region). On the head side, the container component must pass `page` + `componentMap` to its `<AppPlaceholder>` (headless `placeholders.md`).

## Diagnosing a misplaced rendering
1. Confirm the placeholder key the rendering targets matches a placeholder the Page/Partial Design exposes at that level.
2. Confirm the rendering is in the placeholder's *Allowed Controls* (Placeholder Settings).
3. Confirm the Page Design → Partial Design chain is assigned to the page's template (TemplatesMapping) — an unassigned template gets no composed presentation.
4. If it renders twice, Presentation Migration hasn't stripped the page-level duplicate yet.
