# MVC pair script boundary

This pair intentionally has no standalone executable. Read the exact native Razor/controller analysis contract under sitecore/scripts/analysis, use frontend-migration for local frontend checks, and use sitecore-headless-to-xmc/scripts for optional XMC resolver scaffolding. Keep source reconstruction in this pair's instructions rather than duplicating shared analyzers or generators. Inspect the selected script's prerequisites and limits before execution.

Inputs to those procedures are explicit source/target roots, rendering IDs, source revision, target SDK and saved baseline. Return mappings, hazards and evidence to this pair; the hub owns task lifecycle. For xpmvc2xpheadless, apply references/target-xp-headless.md and verify JSS/XP compatibility rather than calling the XMC scaffold.

No fake executable or tests are supplied. Future extraction must retain source markup/selector contracts and distinguish a manually inspected finding from a semantic analyzer result.


The shared SitecoreAI mock scaffold now supports verified preview stages and
mock-only tree navigation. Use the native Sitecore `scripts/preview` helper to
prepare explicitly selected capture/mapping/example outputs, then the reviewed
`sitecore-headless-to-xmc/scripts/scaffold-mock-service.mjs --preview-stage DIR
--preview-stage-sha256 HASH` interface for MVC-to-SitecoreAI. For MVC-to-XP-Headless,
the static navigation assets remain usable with an already verified JSS mock loader;
Content SDK scaffold installation remains outside that target's compatibility scope.
