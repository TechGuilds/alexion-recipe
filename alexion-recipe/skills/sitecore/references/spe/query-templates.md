# SPE query templates

Ready-to-use SPE query patterns for content analysis / instance interrogation. Every script starts with `Set-Location master:\sitecore | Out-Null` (see `best-practices.md`). **Output:** the CLIXML normalizer auto-JSONs `[PSCustomObject]`/`Select-Object` output — you do **not** need `ConvertTo-Json` for flat results; use `ConvertTo-Json -Depth N` only for nested objects (depth ≥ 2).

## Descendant-fetching strategy (pick the right tool)
| Need | Method | Gotcha |
|---|---|---|
| immediate children | `.Children` | no recursion |
| small tree (<5K), simple filter | `Get-ChildItem -Recurse | Where-Object` | slowest at scale |
| all descendants, mid tree (<100K), in-memory filtering | `.Axes.GetDescendants()` | raw items — pipe `| Initialize-Item` for dot-notation |
| large tree (10K+) or indexed filters | `Find-Item` | returns `SearchResultItem` — pipe `| Initialize-Item` |
Never `Get-ChildItem -Recurse` on `/sitecore/content` without a path scope.

## Patterns
```powershell
# List site roots under /sitecore/content
Get-ChildItem -Path "master:/sitecore/content" | Select-Object Name, @{N='Path';E={$_.Paths.FullPath}}

# Verify a path (fallback to listing content roots)
if (Test-Path "master:/sitecore/content/MySite") { Get-ChildItem -Path "master:/sitecore/content/MySite" | Select-Object Name, TemplateName } else { Get-ChildItem -Path "master:/sitecore/content" | Select-Object Name }

# Item details by path
$i = Get-Item -Path "master:/sitecore/content/MySite/Home"
[PSCustomObject]@{ Name=$i.Name; ID=$i.ID; Path=$i.Paths.FullPath; Template=$i.TemplateName; Updated=$i.Statistics.Updated; Version=$i.Version.Number; Language=$i.Language.Name }

# Template distribution (small tree)
Get-ChildItem -Path "master:/sitecore/content/MySite" -Recurse | Group-Object TemplateName | ForEach-Object { [PSCustomObject]@{ Template=$_.Name; Count=$_.Count } } | Sort-Object Count -Descending

# Rendering usage (which pages use which rendering, in which placeholder)
$results=@(); foreach ($p in (Get-ChildItem -Path "master:/sitecore/content/MySite" -Recurse | ? { $_ | Get-Rendering -FinalLayout } | Select-Object -First 50)) {
  foreach ($r in (Get-Rendering -Item $p -FinalLayout)) { $results += [PSCustomObject]@{ Page=$p.Paths.FullPath; Rendering=$r.RenderingItem.Name; Placeholder=$r.Placeholder } } }; $results

# Language versions (e.g. French coverage)
foreach ($i in (Get-ChildItem -Path "master:/sitecore/content/MySite" -Recurse | Select-Object -First 100)) {
  $fr = Get-Item -Path "master:" -ID $i.ID -Language "fr"; if ($fr) { [PSCustomObject]@{ Path=$i.Paths.FullPath; HasFr=($fr.Fields["Title"].Value -ne "") } } }
```

## Indexed search (large trees) — `Find-Item`
```powershell
$root = Get-Item -Path "master:/sitecore/content/MySite"
Find-Item -Index sitecore_master_index -Criteria @(
  @{ Filter="DescendantOf"; Value=$root },
  @{ Filter="Equals"; Field="_templatename"; Value="Page" }
) -First 500 | Initialize-Item | ForEach-Object { [PSCustomObject]@{ Name=$_.Name; Path=$_.Paths.FullPath; Template=$_.TemplateName } }
# Distribution: add -FacetOn "_templatename" -FacetMinCount 1 (no -Criteria template filter)
```
Filters: `DescendantOf` · `Equals` · `Contains` · `StartsWith` · `InclusiveRange` (dates). Indexed fields: `_template`, `_templatename`, `_fullpath`, `_name`, `_displayname`, `_language`, `_version`, `__smallcreateddate`, `__smallupdateddate`. **`Find-Item` returns `SearchResultItem` — always `| Initialize-Item` before field access.**

## Page-Design assignments (verify TemplatesMapping after conversion)
```powershell
$site = Get-Item -Path "master:/sitecore/content/Tenant/MySite"
Import-Function Get-PageDesignsItem; $pd = Get-PageDesignsItem $site
$raw = $pd.TemplatesMapping  # "{tplId}={pdId}&{tplId2}={pdId2}" (URL-encoded)
if ($raw) { [System.Web.HttpUtility]::UrlDecode($raw) -split '&' | % { if ($_ -match '^(.+?)=(.+)$') {
  $t=Get-Item -Path "master:" -ID $matches[1] -EA SilentlyContinue; $d=Get-Item -Path "master:" -ID $matches[2] -EA SilentlyContinue
  [PSCustomObject]@{ Template=$(if($t){$t.Name}else{"(not found)"}); PageDesign=$(if($d){$d.Name}else{"(not found)"}) } } } }
```
A page can override via its `Designing` field (from `_Designable`) — non-empty = per-page Page Design override.

## `.Axes.GetDescendants()` field-access trap
Raw items → `$_."Title"` returns `$null`. Fix: `| Initialize-Item` (adds the SPE adapter) or bracket access `$_["Title"]`.
