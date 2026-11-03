# Sitecore content model

The core Sitecore concepts every phase touches — items, templates, fields, standard values, presentation, versions/languages, serialization. Load when you need to understand how a Sitecore subsystem is structured (both source XP and target XMC use the same content model; the delivery/analytics layers differ — see `xp-vs-xmc-differences.md`).

## Items & the tree
Everything is an **item** in a tree under `/sitecore` (`/content`, `/templates`, `/layout`, `/media library`, `/system`). Each item has an **ID** (GUID), a **name**, a **path**, a **template**, and **fields**. Paths map to namespaces in serialization (dot-notation) — see `../serialization/push-ordering.md`.

## Templates & inheritance
A **template** defines an item's fields. Templates have **base templates** (multiple inheritance) — a page template typically inherits from Foundation/Feature templates plus SitecoreAI base templates. `__Base template` is a pipe-delimited GUID field (splitting-gotcha: `.Split("|")`, never `-split "\\|"` — see `../spe/best-practices.md`). The **Helix tier** (Foundation → Feature → Project) drives serialization push order.

## Fields & standard values
Fields carry the content. Field **types** (Single-Line Text, Rich Text, Image, General Link, Checkbox, Droplink, Multilist, …) determine the value shape — see `field-types.md`. **Standard Values** (`__Standard Values` item under a template) provide default field values **and the default presentation** (the layout/renderings) for every item of that template. SXA's Page Design → Partial Design chain is what supplies presentation on a converted site (see `../sxa/fundamentals.md`); Presentation Migration strips renderings that the chain now covers from Standard Values + page items.

## Presentation details
Layout is stored on the `__Renderings` (shared) / `__Final Renderings` (versioned) fields as XML: a **layout** + a set of **renderings**, each placed in a **placeholder** with an optional **datasource** item and **rendering parameters**. In headless, the Layout Service serializes this into the JSON the Next.js head consumes (fields → `props.fields`; placeholders → `<AppPlaceholder>`). Rendering-parameter templates need the correct SitecoreAI base inheritance (`xmc-ensure-rendering-parameters`).

## Versions & languages
An item has a **version per language** (`en`, `fr-CA`, …). A field value can differ per language/version. The migration's primary content language is selected in Discovery; multi-language coverage is queryable (see `../spe/query-templates.md`).

## Serialization
Content moves XP→XMC as **YAML on disk** via an authenticated, verified Sitecore CLI — native files preserve structure, but transfer/rollback is not universally atomic. Modules define which subtrees serialize; exclusions drop XP-only content. Mechanics: `../serialization/overview.md`.
