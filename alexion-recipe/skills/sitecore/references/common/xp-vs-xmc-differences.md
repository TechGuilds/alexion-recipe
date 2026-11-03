# XP vs SitecoreAI (XMC) — platform differences

What exists in Sitecore XP but **not** in SitecoreAI, and how the equivalent works now. Load when scoping a migration or when surprised by a subsystem difference. The **content-exclusion** counterpart (which items to drop + the paths) is `../serialization/xp-to-xmc-exclusions.md`; this is the subsystem-knowledge overview.

## Delivery & analytics (removed / replaced)
| XP subsystem | In SitecoreAI? | Replacement |
|---|---|---|
| Analytics / xDB (tracking, profiles, patterns, goals, contacts) | **No** | Sitecore CDP / Personalize |
| Marketing Automation (plans, campaigns, automation rules) | **No** | Sitecore Send |
| Experience Database (xDB / Data Exchange) | **No** | CDP |
| Sitecore Forms (XP) | **No** | not supported — exclude `/sitecore/Forms` unconditionally; Content SDK `<Form>` integration is a separate concern |
| Solr / on-box search indexes | **No** (delivery) | Experience Edge (published content graph) |

These carry template dependencies that fail serialization push → excluded (see the exclusions reference).

## Presentation & editing (changed)
| XP | SitecoreAI |
|---|---|
| Experience Editor (`pageEditing`, `useSitecoreContext`) | **Pages** editor (`page.mode.isEditing`, `page` prop) — see pair `editing-mode.md` |
| MVC / classic rendering host, or XP JSS | Next.js App Router + Content SDK head |
| Layout Service on XP | Experience **Edge** (`layout()` returns the same JSON, pre-built + CDN-cached, **published-only**) |
| SXA on XP | **Headless SXA** on SitecoreAI (Page/Partial Designs, TemplatesMapping) — see `../sxa/fundamentals.md` |

## Same (migrates cleanly)
The **content model** is the same — items, templates + base-template inheritance, fields, standard values, versions/languages, the media library. Ordinary content/templates/renderings serialize XP→XMC directly (in dependency order). The migration preserves this and only rebuilds the presentation/host layers.

## GraphQL
XP Master GraphQL (source, `sc_apikey`, includes drafts/master) and SitecoreAI **Edge** (target, published-only, different schema) are **different surfaces** — see `graphql-and-edge.md`. Empty Edge results usually mean content isn't published yet, not that the migration failed.

## Practical implications for the migration
- Content migration **excludes** the removed subsystems (Analytics/MA/xDB/Forms) — expected, not a bug.
- Code migration retargets Experience-Editor patterns to Pages and the JSS/MVC host to Next.js + Content SDK.
- Verification against the target must query **Edge** (published) — publish before expecting content there.
