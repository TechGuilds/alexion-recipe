# Razor helper classification catalog

Inventory every helper with file/line, exact call, arguments, output/editability, side effects and target disposition before Gate 3. Classify as available-OOTB, no-op-OOTB, partial-OOTB or defer-to-customer; no-op requires evidence that dropping it preserves the approved behavior.

| Construct | Mapping and required reference |
| --- | --- |
| Sitecore Field, BeginField/EndField, EditFrame | Preserve editable boundaries; [fields](hazards/fields.md) |
| Placeholder, DynamicPlaceholder, Rendering, Controller | Preserve composition and IDs; [rendering](hazards/rendering.md) |
| Partial, RenderPartial, Action, RenderAction | Trace input model and server work; [composition](hazards/composition.md) |
| Translate.Text and dictionary helpers | Preserve locale/fallback; [i18n](hazards/i18n.md) |
| BeginForm, AntiForgeryToken, form scripts | Identify backend/validation dependency; [forms](hazards/forms.md) |
| VisitorIdentification and analytics helpers | Target-dependent disposition; [analytics](hazards/analytics.md) |
| Custom helpers | Read implementation; [custom](hazards/custom.md) |
| User, Membership, FormsAuthentication | Separate UI visibility from authorization; [auth](auth-and-personalization.md) |

Server state, WebForms, filesystem, output pipeline and ViewData behavior require explicit customer/backend mapping when no verified target equivalent exists. Save unresolved calls as hazard-pending decisions in the assigned native result file; the hub owns acceptance and lifecycle. Never mark a component complete with unaccounted invocations.
