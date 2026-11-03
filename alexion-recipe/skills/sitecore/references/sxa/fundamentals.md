# SXA fundamentals (Headless SXA on SitecoreAI)

Concepts behind the SXA conversion. SXA (Sitecore Experience Accelerator) provides a component-based site structure; **Headless SXA** is the SitecoreAI flavor where the head is a Next.js app and SXA supplies the site/presentation model in the CMS. Load when you need to understand what the `xmc-*` provisioning steps create.

> The `xmc-*` names below identify **provisioning steps**, not tools to call. Only `xmc-ensure-collection` / `-ensure-site` / `-publish` / `-list-sites` / `-list-collections` / `-list-site-templates` are live REST tools; every other `xmc-*` runs as a `.ps1` through `run-powershell-script` — `provisioning.md` maps each step to its script.

## The hierarchy
- **Collection / Headless tenant** — the top-level container under `/sitecore/content/{tenant}` that groups sites. Created by `xmc-ensure-collection`.
- **Site** — under the tenant (`/sitecore/content/{tenant}/{site}`). Adopted (moved under the tenant) by `xmc-adopt-site-into-tenant`, then converted to Headless SXA by `xmc-convert-to-headless-site` (ChangeTemplate to SXA site templates + skeleton + settings + system modules).
- **Renderings / SXA modules** — a rendering is a component available in the Pages editor. Migrated rendering folders are registered as **thin SXA modules** (`xmc-register-rendering-folders`) with a `renderingsPrefix` so they show up as *Available Renderings* without colliding with system modules. **Rendering-parameter templates** must inherit the correct SitecoreAI base template — `xmc-ensure-rendering-parameters` fixes that per module.
- **Partial Designs** — reusable presentation fragments (header, footer, shared layout) — a set of renderings placed in named placeholders. Created by `xmc-create-partial-designs`.
- **Page Designs** — compose Partial Designs (+ page-specific renderings) into the full presentation for a page-template. Created by `xmc-create-page-designs`, assigned to templates via **TemplatesMapping** (`xmc-assign-page-design`).
- **TemplatesMapping** — the SXA mechanism that maps a page template → its Page Design, so any item of that template inherits the presentation.

## Why the conversion works this way
Content was pushed to SitecoreAI via the CLI as ordinary items; it isn't yet an SXA site. The conversion **replays** what the New-JSSSite wizard would have created (tenant, SXA site templates, module registration, Page/Partial Designs) onto the existing items in place — so presentation comes from the **Page Design → Partial Design composition chain** rather than per-page rendering lists. Presentation Migration then **strips** the now-redundant PD-covered renderings from template Standard Values (SVs) and page items, so pages get presentation exclusively from the chain.

## Shared-data safety
Conversion touches shared data roots; the Site Conversion step runs a **shared-data safety checkpoint** (item-cache-only clear; no LinkDB rebuild in automated runs) and reports pre/post reference counts so the user can confirm nothing shared was broken.

## MVC delta
MVC sites have no JSS `sitecore.json` site definition, so Site Adoption works from the existing Sitecore site root rather than a config file. The rest of the SXA conversion is identical to the JSS path.
