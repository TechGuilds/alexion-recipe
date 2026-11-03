# SPE scripting best practices

For scripts run via `run-powershell-script`. Covers the patterns/gotchas that cause **silent** failures. Load before writing any SPE script.

## MANDATORY: `Set-Location` first (every script)
SPE Remoting sessions start at `C:\windows\system32\inetsrv` — the Sitecore provider is NOT active until you set location into a Sitecore drive. Without it, `Get-Item`/`Get-ChildItem`/SXA functions/`Test-Path master:`/template resolution can silently fail.
```powershell
Set-Location "master:\sitecore" | Out-Null   # first line of EVERY script; Out-Null keeps output clean
```

## MANDATORY: no `param()` — parameters are pre-bound variables
The transport injects each `params` entry as a `$VarName = <value>` assignment **inside the session, before your body runs**. Refer to them as plain variables (`$ItemPath`). **Do not add a `param()` block** — it's invalid here (the injected assignments ran first) and causes a parser error / shadows the values. Defaults via inline guards: `if (-not $MaxDepth) { $MaxDepth = 3 }`.

## Field access (write ops)
- **SPE shorthand auto-saves** (SPE's adapter does BeginEdit→set→EndEdit): `$item."Renderings" = $ids`, `$item.__Name = "new-name"`. Standard for most fields.
- **`$item.Fields["X"].Value` bypasses the adapter → requires explicit edit context:**
```powershell
$item.Editing.BeginEdit()
$item.Fields["Template"].Value = $branchId
$item.Editing.EndEdit() > $null    # batch multiple field writes in one edit block
```
Use `Fields[]` only when the field name collides with a reserved SPE property; always wrap in BeginEdit/EndEdit.

## Reserved SPE properties (read-only — shorthand won't set)
`$item.Template` / `.Name` / `.ID` / `.TemplateID` / `.TemplateName` are read-only. Set Template via `$item.Fields["Template"].Value` (with BeginEdit); set name via `$item.__Name = …`. `$item.Template = …` errors "ReadOnly property".

## `$db.GetItem()` vs `Get-Item` (SPE property adapter — critical)
`Get-Item`/`Get-ChildItem` return **SPE-adapted** items (field→dot-notation maps: `$item.Modules` → the pipe value). `$db.GetItem()` returns a **raw** item — `.Modules` is `$null`. **SXA functions use dot-notation** (`Add-SiteModule` does `$Site.Modules.Split("|")`), so a raw item → `$null.Split()` throws. Rule: any item passed to an SXA function must come from **`Get-Item`**; re-fetch with `Get-Item -Path "master:" -ID $item.ID` after `ChangeTemplate`. `.Fields[]`/`.Editing`/`.ChangeTemplate()` work on either.

## `New-Item` syntax (CmsItemProvider)
`-Path` is the **parent**, `-Name` is the new item, `-ItemType` is the template/branch GUID (differs from the filesystem provider):
```powershell
New-Item -Path "master:/sitecore/content" -Name "my-site" -ItemType "{TEMPLATE-GUID}"
```
`-Parent` is invalid ("parameter cannot be found"). Branch instantiation (`-ItemType $branchTpl.ID`) copies the whole subtree (30–60s+ for large branches).

## Reserved variables (silent bugs — never reassign)
`$home` (user home dir), `$host` (PS host object), `$PID` (process id — case-insensitive, so `$pId`/`$pid` all hit it). Assigning to them is silently ignored → your script operates on the wrong value. Use `$homeItem`/`$hostItem`/`$parentId`.

## Pipe-splitting Sitecore multi-value fields (data-corruption gotcha)
Multi-value fields are pipe-delimited GUIDs (`{G1}|{G2}`). `-split` is **regex** (`|` = alternation). **Safe:** `.Split("|")` (plain .NET) or `-split '\|'` (single-quoted). **Catastrophic:** `-split "\\|"` (double-quoted double-backslash) → splits between **every character** → writes back corrupted, growing each run. Rule: `$parts = @($value.Split("|") | ? { $_ -ne "" })`.

## Tree traversal (pick the right tool)
1-level → `.Children` · <100 → `Get-ChildItem -Recurse` · <1000 → `.Axes.GetDescendants()` · 10K+ with filters → `Find-Item` (indexed). `.Axes.GetDescendants()`/`Find-Item` results need `Initialize-Item` for dot-notation (bracket `$_["Title"]` works without). **Never** `Get-ChildItem -Recurse` on `/sitecore/content` without a path scope. See `query-templates.md`.
