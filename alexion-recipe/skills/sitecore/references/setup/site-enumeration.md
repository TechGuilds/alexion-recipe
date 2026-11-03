# Site enumeration — when the user doesn't know the site path

Setup normally asks the user to state the source site content path directly (see
[workflow-state.md](../../../cms-migration/references/workflow-state.md) and the Setup pipeline). That's
the common, preferred path — a user running their own migration usually knows their site. This is
the fallback for when they explicitly don't: run
[`probe-sites.ps1`](../../scripts/setup/probe-sites.ps1) through `run-powershell-script` on the source
connector (no parameters; use the default background job and resume from its terminal result), save its
JSON result to a file, then:
```sh
node scripts/setup/filter-sites.mjs --input probe-result.json
```

Present the returned `list` to the user for confirmation before treating any entry as the resolved
site — **this discovers candidates, it does not pick one.** Never auto-select a single result as
correct without the user confirming; a Sitecore instance can have exactly one non-system site and
still be the wrong one for this migration.

## Probe-output contract

Use the executable script body from `probe-sites.ps1` as the canonical source. Preserve its behavior
and do not retype, paraphrase, wrap, or rewrite comment delimiters. Whitespace or line-ending
normalization alone is not a capability failure when the terminal envelope is valid; reject only a
wrapper or transformation that changes execution or output shape. Do
not replace it with an inline probe or call `Sitecore.Globalization.LanguageManager` directly: that
type is not available on every supported connector, while the canonical script uses the content tree
and returns the stable envelope. Do not wrap the body in a PowerShell block comment (`<# ... #>`),
prepend a second wrapper, or replace it with an inline array probe. The terminal result must be a JSON object with both top-level properties `availableLanguages`
and `sites`; a bare `[]`, non-JSON output, or an object without `sites` is an execution-contract
failure and must be preserved as blocked evidence and corrected/retried. Only `{ "sites": [] }` in a
valid envelope means that the connected instance returned no candidates. The default background job
resumes the chat after terminal completion; use `get-tool-results` only when the terminal result was
not delivered or when a bounded foreground call explicitly returned a run ID.

## What it returns
`list`: real, user-facing sites only — Sitecore's own chrome (`shell`, `login`, `admin`, `scheduler`,
`publisher`, `speak`, etc. — see `filter-sites.mjs` for the full exclusion list) is stripped before
the user ever sees it. Each entry carries `rootPath`/`startItem` (may be `null` for minimally
configured sites) so a confirmed selection can seed the site content path directly — no second
round-trip needed. `availableLanguages` per entry is scoped to that site specifically (languages
with actual versioned content under its `rootPath`), separate from the top-level `availableLanguages`
(every language definition installed on the instance, not scoped to any site).

## Scope
**XP/XM only.** XM Cloud sources do not surface sites this way — sites live in `xmcloud.build.json`,
not the config Factory — use the target connector's `xmc-list-sites` tool instead when the target is
XM Cloud.

This deliberately probes `Sitecore.Configuration.Factory` rather than the Layout Service, so it keeps
working on an XP MVC source with unlicensed/unavailable Headless Services, where a
Layout-Service-driven site probe would return nothing.

## What this does not do
It lists *candidates*, not a verified scope. It does not validate that the selected site is actually
in-scope for this migration, does not check permissions on its content, and does not substitute for
the topology/HS-install checks in [topology-and-prerequisites.md](topology-and-prerequisites.md) —
run both.
