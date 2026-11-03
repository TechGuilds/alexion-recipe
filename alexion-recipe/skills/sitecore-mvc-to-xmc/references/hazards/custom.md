# Sitecore MVC Helper — Custom / customer-hazard inventory

Resolves customer-defined Razor helpers and out-of-scope ASP.NET MVC helpers (`@Html.BeginForm`, `@Url.Action`, `@User.IsInRole`, `@Html.Glass()`, etc.) via the per-workspace customer-hazard inventory. Loaded on demand by the `sitecore-mvc-to-xmc` hazard-gate whenever `mvc.viewSignals.customHelperCalls`, `securityHelperCalls`, or `urlHelperCalls` is non-empty, or `rawHelperInvocations` contains entries unresolved by the typed sub-skills.

Use this skill when a `.cshtml` calls a helper that is **not** in the OOTB inventory:

- Customer-defined Razor helpers (`@MyHelpers.Render(...)`).
- Generic ASP.NET MVC form / link helpers (`@Html.BeginForm`, `@Html.AntiForgeryToken`, `@Html.TextBox`, `@Html.DropDownList`, `@Html.ValidationSummary`, `@Html.ValidationMessageFor`, `@Html.Raw`, `@Html.Encode`, `@Url.Action`, `@Url.Content`, `@Url.RouteUrl`, `@Ajax.BeginForm`, `@Ajax.ActionLink`).
- Security / context helpers (`@User.IsInRole`, `@Membership.*`, `@FormsAuthentication.*`, `@HttpContext.*`).
- Third-party libraries (Glass Mapper, Synthesis, Foundation.Kernel-style Helix extensions).

These categories are intentionally **not** in the OOTB inventory — they route through the per-workspace customer-hazard inventory.

## Customer-hazard inventory contract

The inventory lives at `agent-data/<workspace>/customer-helper-inventory.md`. Each row pairs a match key with a per-workspace verdict and Content SDK equivalent. The MVC component agent reads this file at the hazard-gate (native `read`/`bash`, not a fetch tool); the customer (or a follow-up agent) populates it.

If the file is missing or the call has no row, default to `defer-to-customer` and emit:

```
hazard-pending: custom — <verbatim call signature>; no customer-helper-inventory entry
```

## Resolution procedure

For each entry in `customHelperCalls` / `securityHelperCalls` / `urlHelperCalls` / unresolved `rawHelperInvocations`:

1. **Look up the match key** in `customer-helper-inventory.md`. Match keys follow the same shape as the OOTB inventory (fully-qualified declaring type + method, or `Razor.Helpers.<file>.<helper-name>`).
2. **Apply the row's verdict**:
   - `available-OOTB` (rare — customer wrote a wrapper over an OOTB helper): translate inline per the equivalent listed.
   - `no-op-OOTB`: drop the call.
   - `partial-OOTB`: translate the supported portion; `hazard-pending:` the rest.
   - `defer-to-customer`: leave the call as `hazard-pending: custom — <signature>`.
3. **If no row exists**, classify as `defer-to-customer` and emit `hazard-pending: custom — <signature>; no customer-helper-inventory entry`.

## Common-case defaults (when the inventory is missing)

When `agent-data/<workspace>/customer-helper-inventory.md` doesn't exist, use these defaults — they still mint a `hazard-pending:` row so the resolution surfaces, but they suggest the most likely Content SDK target so the follow-up reviewer can move fast.

| Source | Likely target | Suggested hazard-pending category |
|---|---|---|
| `@Html.BeginForm(...)` / `@Html.EndForm()` | Next.js `<form action={serverAction}>` or route handler. | `forms` |
| `@Html.AntiForgeryToken()` | Next.js server-action CSRF token (built-in). | `forms` |
| `@Html.TextBox` / `@Html.DropDownList` / `@Html.Hidden` | Plain JSX form controls bound via state or server action. | `forms` |
| `@Html.ValidationSummary` / `@Html.ValidationMessageFor` | Form-validation library or server-action validation result. | `forms` |
| `@Html.ActionLink(text, action, controller)` | `<Link href="...">` (Next.js). | `urls` |
| `@Url.Action(action, controller)` / `@Url.Content(path)` / `@Url.RouteUrl(...)` | String literal or `getStaticProps`-style URL computation. | `urls` |
| `@User.IsInRole("Editor")` / `@User.Identity.IsAuthenticated` | Next.js session helper (NextAuth / Auth.js / per-workspace auth). | `security` |
| `@Membership.*` / `@FormsAuthentication.*` | Per-workspace auth provider. | `security` |
| `@HttpContext.Current.Items[...]` / `@HttpContext.Current.User` | Next.js `headers()` / `cookies()` / `auth()` — Server Component scope. | `security` |
| `@Html.Raw(html)` | Route field-sourced raw HTML through the scaffolded `RawFieldHtml` renderer (`src/components/content-sdk/RawFieldHtml.tsx`) — a plain `dangerouslySetInnerHTML` wrapper leaves any contained `<script>` **inert** (it never executes). Load `sitecore-headless-to-xmc/references/raw-field-rendering.md`. **Head-destined carve-out:** if the component's pin carries a `## Head Placement` section, emit a head-eligible tag (`<style>` / `<link>` / `<meta>`), NOT a `<div>` — load `references/head-placement.md` and follow its emit table. | `custom` |
| `@Html.Glass().GetRenderingParameters<T>()` / `@Html.Glass().Editable(...)` | Custom resolver-adapter — these are typed-model accessors. Load `references/glass-mapper.md`. | `custom` |
| `@MyHelpers.Whatever(...)` (any non-OOTB identifier) | Unknown — emit `hazard-pending: custom — <signature>; no customer-helper-inventory entry`. | `custom` |

## Anti-patterns

- Do NOT hand-translate a `@Html.BeginForm` to JSX without recording a `hazard-pending: forms — ...` row. Forms wiring is workspace-specific (Next.js route handler vs server action vs API route) and the human reviewer owns the call.
- Do NOT silently drop `@Html.Glass().Editable(...)` — it's an editable-field surface in MVC and dropping it breaks Pages parity. Either translate via `references/glass-mapper.md` or `hazard-pending: custom — ...`.
- Do NOT invent a `useUser()` / `useSession()` hook for `@User.*` without verifying the workspace ships one — emit `hazard-pending: security — ...` so the reviewer can wire the real auth surface.

## Gate-3 ledger

Every customer-helper / security-helper / URL-helper call must either appear translated in the generated TSX (with the inventory row's equivalent) or be recorded as `hazard-pending: <category> — <signature>`. Gate 3 fails on any unaccounted entry in `customHelperCalls` / `securityHelperCalls` / `urlHelperCalls` / residual `rawHelperInvocations`.
