# Coordinate global JavaScript

Before component work, inventory scripts in source layouts, bundles, head/footer blocks and shared modules. Record load order, selectors, global variables, libraries, route scope and initialization events. Identify which components depend on each script and assign one owner for shared target files.

Move React-owned UI state to props/state and component event handlers where practical. For unavoidable DOM integration, use refs or a scoped root, initialize after mount, and return cleanup for listeners, timers, observers and plugin instances. Avoid document-wide selectors for repeated widgets. See [jQuery conversion](jquery-to-react.md) for reusable helpers; do not reintroduce jQuery.

Global providers, analytics and externally loaded scripts need one intentional initialization point. Read existing target integrations before adding another. Keep required dependency order explicit; do not equate source document-ready with every client navigation. Verify whether initialization must respond to route changes and whether previous instances are disposed.

Preserve approved consent and data-handling behavior. Record third-party endpoints and configuration names without copying secrets into client code or evidence. Raw CMS scripts and head injection require the pair skill's content policy, rather than automatically evaluating field strings.

Shared-file handoff must name the owner, dependent components, required exports and readiness evidence. Return component-local work without overwriting another owner's layout/provider edits. Validate first load, client navigation, back navigation and repeated mount/unmount; check duplicate requests/listeners and console errors. Record unresolved ordering or external dependencies explicitly.
