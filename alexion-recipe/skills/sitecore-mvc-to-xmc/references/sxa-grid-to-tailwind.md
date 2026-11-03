# SXA grid to Tailwind policy

Apply only when the hub's selected style strategy explicitly permits Tailwind conversion. Otherwise preserve source SCSS/CSS using [style migration](style-migration.md). Do not remove SXA grid classes merely because Tailwind is installed.

Read the source grid definition, breakpoint widths, gutters, container widths, offsets, nesting and responsive rendering parameters. Build a measured mapping table for each used combination; a twelve-column name does not establish identical breakpoints.

Map to verified target utilities or scoped CSS where utilities cannot express the original behavior. Preserve classes used by scripts or selectors even when layout moves to utilities. Handle nested grids, negative margins and mobile stacking explicitly.

Compare at the source breakpoint boundaries and representative narrow/wide viewports, checking wrapping, order, overflow and spacing. Save screenshots and computed-style evidence. Unverified breakpoint mappings remain pending; visual similarity at one width is insufficient.
