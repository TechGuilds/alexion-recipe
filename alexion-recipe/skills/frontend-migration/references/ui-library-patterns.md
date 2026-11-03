# UI library migration

Inventory the source library/version, imported widgets, CSS dependencies, initialization code and observable behavior. Read the target lockfile and installed types before choosing an existing component or adding a dependency. Preserve the behavior contract: controlled values, callback payloads, keyboard navigation, focus return, portal placement and responsive behavior.

For each widget, map source props/events to target props/events and record differences. A renamed component is not necessarily equivalent: modal dismissal, accordion exclusivity, carousel timing, form validation and dropdown focus often differ. Keep wrapper classes and theme tokens until their selector consumers have been checked.

Place interactive providers and widgets behind the smallest appropriate client boundary. Inspect module-scope browser access; a client directive alone does not make an SSR-unsafe dependency safe. If the target supports a client-only loading pattern, use it narrowly and document the initial/loading UI. Include vendor styles in their observed cascade position; avoid installing an entire legacy JS framework just to retain CSS.

Replace jQuery plugins through [jQuery guidance](jquery-to-react.md). Prefer existing target dependencies when they satisfy the contract; record any proposed new package/version and material behavior change in the migration decision record. Do not silently swap icon/SVG representation.

Validate mouse and keyboard operation, focus trapping/return, disabled/loading/error states, small viewport behavior and repeated mount/unmount. Report source widget, target widget, dependency changes, preserved behavior, deviations and evidence paths using [render validation](render-validation.md).
