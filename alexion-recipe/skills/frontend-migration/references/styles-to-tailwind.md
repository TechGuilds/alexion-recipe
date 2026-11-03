# Convert styles to Tailwind

Use only when the selected migration strategy includes conversion. Read the installed Tailwind version and target configuration first; configuration and source-discovery mechanisms differ by version. Do not assume a particular config filename or add a second Tailwind entry.

Map source design values before translating selectors: colors, font families/weights, spacing, breakpoints, container widths, stacking and state variants. Keep a mapping of source selector/declaration to utility or retained CSS, including any deliberate approximation.

Convert one representative component and validate it before expanding. Preserve element structure and externally referenced classes. Translate hover/focus/disabled and responsive states explicitly. Use complete discoverable class strings or the target's supported explicit inclusion mechanism for dynamic variants; string interpolation alone may not produce generated CSS. Keep arbitrary CMS style values at a validated style boundary rather than generating unbounded utility names.

Retain CSS for pseudo-elements, complex selectors, vendor-owned DOM or behavior whose utility conversion would change semantics. Account for reset/preflight effects on headings, buttons, images and form controls. Remove old declarations only after checking all consumers and visual states; mixed CSS and utilities require a recorded order.

Return token mappings, converted selectors, retained CSS/reasons, class discovery configuration and evidence. Compare at breakpoint boundaries and test interactive states using [render validation](render-validation.md). A successful utility build does not establish source parity.
