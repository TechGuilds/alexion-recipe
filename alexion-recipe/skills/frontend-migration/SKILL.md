---
name: frontend-migration
description: Use when analyzing or migrating legacy frontend code, styles and browser behavior to React or Next.js.
---

# Frontend migration

Use for source dependency/layout analysis, jQuery, SVG imports, client boundaries, UI libraries, global JavaScript, styles, and frontend verification. This skill owns CMS-agnostic frontend procedures. Sitecore fields, resolved layout semantics, component registration, resolver adapters and remote operations belong to the Sitecore and migration pair skills.

## Capabilities and inputs

Use native file reads/edits, bash and available LSP navigation/diagnostics. Browser execution is needed for visual and interaction evidence. Resolve explicit source/target application roots, source revision, target framework/package versions, assigned work item, route/site/language scope, baseline artifacts and chosen styling strategy before changing code. Installed skills are read-only; write application changes and evidence only in the writable workspace.

Removed migration state, layout/component analysis, render validation and scaffold tools are not prerequisites. Read existing workspace inventory and task files directly; return results to their designated writer. Do not invent a state schema or update workflow status from an analyzer.

## Procedure

1. Read [source analysis](references/source-analysis.md); trace the assigned component from its route through imports, data inputs and browser behavior. Record unknowns with source coordinates.
2. Read [App Router conventions](references/app-router-conventions.md) and the applicable transformation references below. Preserve source behavior and selector contracts.
3. Migrate shared styles and global behavior before dependent components where the work dependencies require it. A task explicitly scoped as shared styles/shell owns global entrypoints, import order, common styles, shell behavior, shared fonts/icons/assets, build transforms and shared runtime dependencies. A component task owns its component-local styles and may add a source-declared, non-jQuery package that the assigned implementation directly imports. Compare source and target manifests first, pin the source or recorded compatible version, use the target repository's existing package manager, update its lockfile, and run a package-manager health/type/build check before returning. Never add an unreferenced package or reintroduce jQuery. A package that lacks current source/version evidence, conflicts with the target, or requires build/root configuration remains a bounded blocked prerequisite; do not modify unrelated global assets/styles, the shell, or root configuration outside explicit scope. Coordinate shared-file ownership.
4. Confirm the assigned route's data and preview prerequisites through the applicable CMS pair skill before collecting runtime evidence. Report missing integration or captured data as a dependency to the coordinator.
5. Collect [render validation](references/render-validation.md) evidence. Return changed files, route coverage, outcomes, unresolved findings and artifact paths to the migration coordinator.

## Topic dispatch

| Topic | Reference |
| --- | --- |
| Source dependency, component and layout inventory | [Source analysis](references/source-analysis.md) |
| Existing runnable style scanner | [Style analysis](references/style-analysis.md) |
| Style policy and strategy selection | [Styles](references/styles.md) |
| Preserve the source cascade | [Preserve SCSS](references/styles-preserve-scss.md) |
| Convert styles to utilities | [Tailwind conversion](references/styles-to-tailwind.md) |
| External styles, body classes and dynamic CSS | [Cross-cutting styles](references/style-cross-cutting.md) |
| jQuery replacement | [jQuery to React](references/jquery-to-react.md) |
| SVG component imports | [SVG and SVGR](references/svg-svgr.md) |
| Server/client boundaries | [Client components](references/use-client.md) |
| UI framework behavior | [UI libraries](references/ui-library-patterns.md) |
| Shared browser scripts | [Global JavaScript](references/global-js-coordination.md) |
| Target routing and composition | [App Router](references/app-router-conventions.md) |
| Build, HTTP, browser and parity evidence | [Render validation](references/render-validation.md) |

## Script status and completion

[Script contracts](scripts/README.md) describe standalone style/layout/source analysis and HTTP probing. Read the selected contract and use its actual output paths and partial-coverage flags. Never install dependencies into a read-only skill projection: copy the selected script tree and its pinned package files to a writable task directory first. A passing static analysis is not runtime parity.

A completed frontend result identifies source and target revisions, changed paths, examined routes and data mode, validation commands/outcomes, browser evidence and outstanding gaps. A successful build or HTTP 200 alone cannot establish parity. Missing source/data/browser capability means the affected check remains unverified; report its impact and the concrete input needed. Escalate unresolved behavior changes through the existing migration decision process. Never install jQuery in the target.
