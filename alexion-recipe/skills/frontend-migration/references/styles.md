# Style migration policy

Analyze before selecting a strategy. Use [style analysis](style-analysis.md) plus the source layout's actual stylesheet/import order. CMS-specific bundle and field interpretation belongs to the migration pair skill.

## Reuse Discovery evidence before inspecting code

For a shared styles/shell task, do not repeat repository-wide style discovery. When
the retained source style report is current, run the frontend skill's
`scripts/plan-style-foundation.mjs` once to create a new
`style-foundation-plan.json` from that report and the current target report when
available. Read the plan first and inspect only its declared import, configuration,
dependency and cross-cutting candidates plus the actual source layout needed to
confirm cascade order. The plan is advisory: it intentionally labels runtime order,
fonts/icons/assets and incomplete scans as limitations rather than guessing.

If the plan identifies missing or contradictory evidence, perform one bounded probe
for that gap and preserve its result. Do not rescan either repository merely to
reconstruct the plan. Component-local CSS Modules stay with the component task.

Preserve the source cascade by default unless the migration's recorded decision selects Tailwind conversion. Read [preserve SCSS](styles-preserve-scss.md) for faithful transfer, or [Tailwind conversion](styles-to-tailwind.md) for an explicit conversion. Do not silently combine broad framework removal with a component migration.

Global styles have one root entry in App Router. Keep vendor/reset styles before the source overrides that depend on them. Component-scoped styles may remain modules or shared partials according to the source's selector contract; never rename externally consumed classes just to tidy them. Source bundle declaration order alone does not establish runtime inclusion order.

Inspect [cross-cutting styles](style-cross-cutting.md) for external links, body classes, dynamic CSS and third-party DOM coupling, including gaps static detection cannot cover. Coordinate global files with [global JavaScript](global-js-coordination.md) and validate the shared shell before dependent component work.

## Foundation-task boundary

When the analysis establishes a shared foundation gap, one explicitly scoped shared styles/shell task owns the global style entrypoints and import order, common partials, shared shell behavior, common fonts/icons/assets, build transforms and shared runtime dependencies. It must state the owned paths and capability changes, preserve target work outside that scope, and validate a representative route before dependent component tasks begin.

A rendering or component task owns only module-local styles and behavior. It must not absorb a missing shared dependency by changing root configuration, global styles, common assets, packages or the shell. Instead, return a bounded blocked result that identifies the missing capability and the source/target evidence so the coordinator can create or repair the shared prerequisite.

Return the chosen strategy/decision, ordered entrypoints, copied assets/dependencies, selector changes and deferred couplings. Use [render validation](render-validation.md) for build, route, visual and interaction evidence; no removed render tool is required.
