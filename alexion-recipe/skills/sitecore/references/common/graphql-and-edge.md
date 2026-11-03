# GraphQL & Edge

Guidance for `graphql-query`, including introspection (both `source-sitecore/*` and `target-sitecore/*`). **Confusing the two schemas is the #1 cause of `Cannot query field "X" on type "Y"`.** Load before any non-trivial GraphQL call.

## The GraphQL surfaces (different schemas)
| Endpoint | Connector | Schema | Use for |
|---|---|---|---|
| **XP Master GraphQL** (Item Service GraphQL on XP 10.x) | `source-sitecore` | generic item-service; module-extended (Coveo/SXA add types); auth via `sc_apikey` (the API-Key item GUID) | inspect source XP content / read item fields |
| **SitecoreAI Edge** (Experience Edge Delivery) | `target-sitecore` | Edge-flavored; layout+content split; **published-only** items; bearer/context-ID | verify migrated content reached Edge; fetch layout JSON |
| **SitecoreAI Authoring** (Authoring/Management API) | XMC connector if configured | authoring schema (master, incl. drafts); OAuth | read/write items on SitecoreAI directly |

**Always state which side you queried** (source XP master / Edge published / Authoring master).

## Introspection first (don't guess fields)
Introspection is a normal query: use the same connector's `graphql-query` for discovery and execution. Load golden samples from this skill's installed directory, then pass the file contents as `query` (not the filename):

1. `scripts/graphql/schema-overview.graphql` — returns query/mutation/subscription root names and type names/kinds. No variables.
2. `scripts/graphql/inspect-type.graphql` — returns one type's fields, arguments, input fields, enum values, interfaces, possible types, and nested type references. Pass `variables` as a JSON object string, for example `{"typeName":"Item"}`. Use an actual type name from step 1; never assume the query root is named `Query`.
3. Run the content/layout query through that same connector's `graphql-query`.

The XP Master schema is extended per installed module. Reuse findings only for the same endpoint/schema; refresh after schema changes or unknown-field errors. If introspection is disabled, report the limitation and use verified endpoint-specific schema documentation rather than guessing or changing endpoint permissions.

Adapt these samples for focused discovery, preserving the operation and variables for repeatability. `__type: null` means the requested type was not found. Follow `ofType` through `NON_NULL`/`LIST` wrappers to a named type; if the sample's depth is exhausted, extend the selection before inferring the type. Check response `errors` even when partial `data` exists. Summarize only relevant schema facts, not the full type inventory. Connector tools manage authentication; do not move credentials or HTTP execution into bash.

## Field-name mangling (XP Item Service)
Sitecore field names (spaces, leading `__`) are mangled in GraphQL: **lowercase, strip spaces, strip leading underscores, camelCase.** `Title`→`title` · `Display Name`→`displayName` · `__Created By`→`createdBy` · `__Renderings`→`renderings`. Reserved-identifier collisions get a template-name prefix — introspect if unsure.

## Schema basics
- **Edge** (delivery, published-only, no BeginEdit/versioning/workflow): entry points `item(path:, language:)`, `layout(routePath:, site:, language:)`, `site(name:)`; `item.fields` is a name→value **object map** (`TextField`/`LinkField`/`ImageField`/…). Items unpublished in master are invisible.
- **XP Master:** `item(path:)` + `search(...)`; `item.fields(ownFields: true|false)` returns an **array** of `{ name, value, jsonValue }`; `item.children` (paginated) / `item.parent`.

```graphql
# XP Master — item by path
{ item(path: "/sitecore/content/site/home") { id: itemId name template { name } fields(ownFields: false){ name value jsonValue } } }
# XP Master — search by template
{ search(rootItem: "/sitecore/content/site", fieldsEqual: [{ name: "_template", value: "{GUID}" }], first: 100) { total results { items { item { name path } } } } }
# Edge — item / layout
{ item(path: "/sitecore/content/Site/Home", language: "en") { id name template { name } fields { name value } } }
{ layout(routePath: "/", site: "site-name", language: "en") { item { rendered } } }
```
GUID literals: braces + consistent case.

## Layout Service vs GraphQL (different questions)
Raw field values → **GraphQL**. The rendered presentation tree (placeholders→renderings→datasources) for a route → **Layout Service**. "What does this page render?" → Layout Service. "What's in this field?" → GraphQL. Bulk single-field-across-many-items → GraphQL `search`.

**How to actually get a layout here** (no agent in this recipe has a layout-fetch tool — use these two):
- **Source XP layout, resolver-expanded** → the mock layout captured during Discovery: `<roots.app>/public/mock-layouts/<route>/index.json`, read natively. It is the XP JSS Layout Service response, so it already includes whatever C# Rendering Contents Resolvers produced.
- **Target layout** → Edge `layout(routePath:, site:, language:)` via `target-sitecore/graphql-query` (see the Edge example above). A `null`/route-less response almost always means a wrong `site` name, not missing content.

## Auth / result pitfalls
401 XP → API-Key item missing/disabled or `sc_apikey` not flowing. · 404 XP → wrong endpoint path (configured on the connector, don't guess). · 403 Edge → context-ID/token mismatch or not published. · **Empty Edge results → content is in master but not published** (verify via XP Master). Always check the `errors` array even when `data` is populated (partial errors are common). Large responses land at `.data[0].output`.

## Don't
Don't paste the full introspection result into chat (hundreds of types). · Don't query Edge to verify just-edited-but-unpublished content. · Don't write mutations against a source XP connector unless explicitly asked. · Don't conflate XP Master `fields(ownFields:)` array with Edge `fields { name value }` object map.
