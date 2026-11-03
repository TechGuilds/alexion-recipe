# Controller/action data → props / Edge / resolver

Traces controller action data flow into MVC renderings and determines what can be translated directly versus what needs resolver-adapter follow-up. Load whenever a rendering depends on controller-populated model data or action-level enrichment logic.

## Goal

Map controller-provided data into a safe conversion plan.

## Workflow

1. Identify the controller action tied to the rendering.
2. Separate direct field-backed values from computed/enriched values.
3. Map direct values into component field contracts.
4. Flag computed or external-query data for resolver-adapter phase.

## Rules

- Do not pretend computed controller logic is already present in layout data.
- Keep evidence for each non-trivial mapping decision.
- Preserve conditional data flow from action to view.

## Enrichment-signal patterns

The following patterns in the action body signal that the rendering needs enrichment beyond what is already in layout props. When you see any of them, do **not** immediately escalate — first apply the selection rubric in the pair SKILL.md's **Data channels (try in order)** section (props → inline Edge fetch → resolver adapter) to decide whether the component should query Edge inline or defer to a resolver adapter.

- `GetPageChildren<T>(...)` or any `GetPageChildren*` overload.
- `item.Axes.SelectItems(...)`, `item.Axes.SelectSingleItem(...)`, `item.Axes.GetDescendants()`, `item.Axes.GetAncestors()`.
- `item.GetChildren()`, `item.Children`.
- `item.Database.GetItem(...)` against an ID or path other than the datasource item itself.
- Any call returning `Item` or `IEnumerable<Item>` that is not the datasource.
- Repository methods (any class whose name ends in `Repository`, `Service`, or `Provider`).
- Search calls (`ContentSearchManager`, `Sitecore.ContentSearch.*`, `Find-Item`-style SPE queries embedded in C#).
- Glass relationship attributes that pull items not present on the datasource.

Apply the safety rules in the pair SKILL.md (editing-mode parity, no Edge analog, shared enrichment). If any safety rule trips, defer to a resolver adapter — shell-only component + a `resolver-pending:` rationale (see the pair SKILL.md's deferral contracts). If none trip, the default bias is inline-fetch-first. Do not attempt to model the queried data as a synthetic layout field. Do not seed mock layouts with fake data. The pair SKILL.md carries the full rubric; this reference carries the pattern list. **See also** `sitecore-headless-to-xmc/references/edge-inline-fetch.md` for the target-side RSC pattern when the chosen path is inline Edge fetch.

## Validation

- Converted component renders with mapped direct data.
- Missing controller-enriched fields are documented as follow-up scope.
- No silent data loss in output regions tied to controller logic.
