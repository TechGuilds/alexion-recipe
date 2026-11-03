# Resolver adapters (replace C# Rendering Contents Resolvers)

When a rendering used a **C# Rendering Contents Resolver** to assemble a custom data shape, that assembly isn't deployed to SitecoreAI — the Edge layout service returns raw datasource fields only. A **TypeScript resolver adapter** bridges the gap: it queries Edge GraphQL for the data the C# resolver assembled and injects it into the layout response, producing the **same field shape the component already expects**. Used in Phase 5 (Resolver Adapters), and referenced by the MVC data-channel rubric.

**Not a rewrite — the React component code must NOT change.** If the component reads `fields.X[0].title.value`, the adapter must produce exactly that.

## Invariants
1. **One adapter per invocation** — implement the single specified adapter with fresh context, then return. Mixing adapters cross-contaminates and misses fields.
2. **XP layout is the gold standard** — never guess the resolver's output. Get **both** layouts and **diff** them: the delta *is* the adapter's enrichment contract. Where each comes from:
   - **XP side (resolver-expanded):** the mock layout already captured on disk at `<roots.app>/public/mock-layouts/<route>/index.json` — it was fetched from the source XP JSS Layout Service, so its `fields` are exactly what the C# resolver produced. Read it natively; pick a route that contains this component (the usage report names them).
   - **XMC side (raw Edge):** `target-sitecore/graphql-query` with `layout(routePath: "<route>", site: "<targetSiteName>", language: "en")`.
   - **Target validation gate (hard):** if the target layout comes back `sitecore: null` or with no `route`, **STOP** — return `TASK_RESULT: failed` with `EVIDENCE.validationResult: "FAIL"` and a note asking the orchestrator to confirm/correct `targetSiteName`. Do **not** continue to introspection, queries, or code: every downstream step would be built on an empty baseline.
   - If the route's mock layout is missing, say so and fail — don't substitute a guess about what the resolver returned.
3. **Test the GraphQL** — introspect (schema varies by XMC version/config), then run the query via the GraphQL tool before writing adapter code. Handle Edge complexity limits: **drop `url { path }` first** — combining it with `field(name:)` calls is what usually blows the complexity budget; obtain URLs in a separate focused query or use a verified route mapping; never derive canonical paths by slugifying item names. Only then reduce `first`, then split the query. Don't burn four attempts re-running variations that still contain `url { path }`.
4. **Match field shape exactly** — names, nesting, types. The component's `fields.*` access defines the contract.
5. **Always cache** — `unstable_cache` (cross-request) + React `cache()` (per-request dedup):
   ```ts
   const fetchData = cache(async (datasource: string, language: string) =>
     unstable_cache(async () => { /* query */ }, [TAG, datasource, language], { revalidate: 300, tags: [TAG] })());
   ```
6. **Defensive — never throw** (it breaks every rendering on the page): check the datasource exists; return the page unchanged if enrichment data is missing; log warnings, not crashing errors.
7. **No hardcoded IDs/paths** — enter from the rendering's `dataSource`; parameterize by `context.locale`/`context.site`.
8. **Validate before done** — compiles (dev server clean), `[resolver-debug] … changedFields=yes` in the logs, and an enrichment-specific render marker passing (Step 5's gate). **Do not re-read the layout to "confirm" enrichment** — it is served straight from Edge and bypasses the resolver strategy, so it always looks unenriched (see Framework facts). `fieldsEnriched > 0` with field-level proof is what the orchestrator's guardrail checks.

## Framework expectations — verify against the actual target
These properties describe the bundled resolver framework. Check the installed target implementation and SDK types once before relying on them; a missing framework is a prerequisite gap.

- **`componentName` is normalized — match on the no-space form.** `NormalizingSitecoreClient` strips **all** whitespace from `componentName` in layout data, so `"Corporate Navigation"` arrives as `"CorporateNavigation"`. Both `matches()` and the adapter's `componentName` must use that normalized form. Get this wrong and the adapter compiles, registers, and silently **never matches** — `fieldsEnriched` stays 0 with no error anywhere. **The component's *folder* keeps the spaced name** (`Corporate Navigation/`) — that mismatch is expected, not a clue; never "correct" one to the other. A scaffolded stub's `{{COMPONENT_NAME}}` placeholder is **already** the normalized form, so leave it alone.
- **`client.getData<T>(query, variables)` exists** on the singleton at `src/lib/sitecore-client.server.ts`. It is **inherited from the `SitecoreClient` base class** (`@sitecore-content-sdk/nextjs/client`) and is therefore *absent* from `NormalizingSitecoreClient`'s own source — that is expected, not a bug. Internally it calls `graphQLClient.request()` against the pre-configured Edge endpoint. **Hard ban:** never grep/read `node_modules/` to "verify" it (no `find … node_modules`, no `xargs grep … node_modules`, no hunting for `GraphQLRequestClient`), and never add a second client or transport to work around the doubt.
- **`[resolver-debug]` is how you see the framework work.** With `RESOLVER_DEBUG=true` (the default in live-debug mode), `resolver-strategy.ts` logs adapter matching, `enrich` calls, per-field change deltas, and summary stats. Read them with `preview_logs` (`level: all`, literal `search: "[resolver-debug]"`), taking the snapshot after a page request; logs are not a live stream. **If no `[resolver-debug]` markers appear after a page request, the framework is broken — return `failed`**, don't keep editing the adapter. Page-load timing is never evidence of enrichment.
- **A raw layout fetch can never show your enrichment.** Any direct layout read — Edge `layout()` or any layout-service call — comes **straight from Edge and bypasses the Next.js resolver strategy entirely**. It is a BEFORE snapshot only, and will show unenriched fields no matter how well the adapter works. Prove enrichment with `preview_logs` (`[resolver-debug]` field deltas) **plus** the frontend native render-validation procedure (the field's value visible in rendered markup). Reading Edge again and reporting "still missing" is a false negative.

## Procedure — run these in order

Do not improvise the sequence. Each step's output is the next step's input, and skipping ahead is the main way an adapter run burns turns.

### Step 0 — Context
From the dispatch: exact workflow `taskId`, stable source rendering/entity ID,
`componentName`, `resolverType` (`{Namespace}.{ClassName}, {Assembly}`), source
path, pages that contain the component, `targetSiteName`, source/target layout
sample paths and previously-completed adapters (read one as a pattern reference
only when its source contract is comparable).

- **Read your assigned task and prior attempt evidence** from native files; verify completed work before retry. Only the coordinator updates workflow status.
- **`targetSiteName` is required** — absent → `failed` asking for it, never inferred.
- **sourceSiteName** comes from the hub's verified context file. A conflict with captured evidence blocks comparison until reconciled.

### Step 1 — The original contract (what the C# produced)
1. Derive the class name from `resolverType` and **`find`** the `.cs` — never assume a path convention. Read it: extract the ViewModel's output shape, the data access (GetItem / GetChildren / queries / computed values), and any external sources.
2. Read the React component that consumes the data — which `fields.*` it touches and their expected types.
3. **Read every child UI file under the component's folder** (`ui/`, sub-components), not just the ones that look relevant — nested prop contracts routinely carry required field shapes the top-level file never mentions. Build an explicit shape table for nested structures (e.g. `followUs.links[]` needing `Link.value` + `Icon.value`). **Do all of these reads now** — deferring them until after GraphQL exploration means re-reading them with lost context.

### Step 2 — The gap (diff the two layouts)
Fetch both per invariant 2, extract this rendering's `fields` from each, and write the delta as a table: field · XP value sample · XMC value · action needed. That table is the adapter's contract and the **only** thing the queries in Step 3 may target. Every field present in XMC → **skipped**, no adapter.

### Step 3 — Working queries
Introspect, then run each query with `graphql-query` **before** writing any adapter code. One focused query per data need — never one monolithic query (it defeats granular caching and hits complexity limits first). Record for each: purpose, the `first:` that passed, returned fields.

### Step 4 — Write the adapter
One file. Follow the skeleton below and the three implementation rules under it.

### Step 4.5 — Immediate compile check (do NOT skip)
The moment the file is written: `preview_logs` with `level: error`, `lines: 30`. Fix wrong import paths / type mismatches / missing imports **now**, re-checking after each fix. **Never carry a known compile error into Step 5** — validating a build that didn't compile is how a run loses its cycle. (The orchestrator's live-mode gate already started the server; if there are no logs at all, restart the preview as a fallback: `preview_stop`, then `preview_run`.)

### Step 5 — Validate (the hard gate)
1. **Preflight.** Confirm this session's live-debug gate completed. If not, execute `Sitecore dev-mode script (live-debug)` followed by a preview restart (`preview_stop`, then `preview_run`). Request one page to generate logs.
2. **Compile.** `preview_logs` with `level: error`, `lines: 30` is clean.
3. **Enrichment evidence — the primary proof.** `preview_logs` with `level: all`, `search: "[resolver-debug]"`, `lines: 200` (after the page request) and look for the literal markers:
   - `[resolver-debug] match: {ComponentName} -> {rendering label}` — the adapter matched
   - `[resolver-debug] enrich: {ComponentName} changedFields=yes` — **fields actually changed**
   - `[resolver-debug] summary route=/ renderings={N} matches={N} enrichCalls={N} changedFieldSets={N}`
4. **Render evidence — the secondary proof.** the frontend native render-validation procedure with pagePath and explicit markers. **Choose markers that can only appear if enrichment succeeded** — nav link text, a logo URL fragment, contact details — i.e. values absent from the raw Edge layout you captured in Step 2. A marker that also passes unenriched proves nothing.

**Pass/fail gate — `success` requires BOTH:** `changedFields=yes` in the logs **AND** at least one enrichment-specific render marker passing. Then:
- `changedFields=no` → the adapter ran but changed nothing → **`failed`**.
- **No `[resolver-debug]` markers at all** → framework wiring, not your adapter → **`failed`** asking for a scoped framework repair or a separately assigned [native scaffold task](../scripts/README.md). Do not patch client/strategy files to chase it.
- HTTP 200 and clean logs are *supporting* signals only — never sufficient on their own.

### Step 5.5 — Anti-drift scan (before claiming success)
Grep your own adapter file for patterns that compile fine but mean the architecture is wrong:
```
edge.sitecorecloud.io | /api/graphql/v1 | /api/graph/edge | sitecoreContextId | new GraphQLClient | fetch(
```
Any hit means the adapter is building its own endpoint instead of using `client.getData()`. **Return `failed` immediately, listing the offending lines — do not fix and re-validate in the same run.** The approach is wrong, not the detail.

### Step 6 — Checkpoint, then return
On PASS, record a real local checkpoint following the hub's checkpoints reference. Return taskId, outcome, summary, evidence[], changedFiles[], checkpoint and unresolved[]. Evidence must quote the field-change log and passing enrichment marker; do not invent a checkpoint ID.

## File scope (you may edit exactly one file)
Write only `src/lib/server/resolvers/{component-name}.resolver.ts` (create it if the stub is absent). **Never** patch the framework to make your adapter fit — not `sitecore-client.server.ts`, `normalizing-sitecore-client.ts`, `resolver-strategy.ts`, `resolver-adapter.types.ts`, or `resolver-registry.ts`. If the wiring is genuinely missing or broken, return `TASK_RESULT: failed` asking for a scoped framework repair or a separately assigned [native scaffold task](../scripts/README.md) — an ad-hoc framework patch fixes one adapter and breaks every other one.

## Finding the C# source
The resolver inventory comes from the approved Discovery synthesis/report evidence
and current inventory/mappings. It supplies the stable rendering/entity ID,
consumer, `type` (`{Namespace}.{ClassName}, {Assembly}`), source path and used
routes. Derive the class from `type` and **`find`** the `.cs` file — don't assume
a path convention; read the actual source (resolvers have non-obvious logic:
traversal depth, inheritance, computed values). If the path/type evidence is
missing or ambiguous, return `blocked`; never derive an identity from a display
name.

## Categories
Neither category nor complexity is stored on the work-item — infer both from the resolver's own logic (the orchestrator uses complexity to order the loop high-first).

| Category (token) | Infer from | Complexity | Approach |
| --- | --- | --- | --- |
| `pass-through` (Edge already has it) | simple datasource enrichment, no traversal | low | **verify and SKIP** — no adapter needed |
| `rollup` (listing) | list/rollup queries, pagination | medium | shared rollup utility + component field mapping |
| `contextual` (route/context) | route context + field lookups | medium | shared context utility + component fields |
| `data-assembly` (complex aggregation) | multi-level tree traversal, aggregation across items | high | full custom adapter, multiple queries |

Use the **token** form in `EVIDENCE` and any category reporting — the orchestrator groups its completion summary by these exact values.

If the Step-2 diff shows **every** field already present in XMC, this component needs no adapter — return `TASK_RESULT: skipped` with that evidence rather than writing a no-op.

## File pattern & registration
```
src/lib/server/resolvers/{component-name}.resolver.ts   ← your adapter (export a ResolverAdapter)
src/lib/server/resolver-adapter.types.ts                ← interface   (scaffolded)
src/lib/server/resolver-strategy.ts                     ← page orchestrator (scaffolded)
src/lib/server/resolver-registry.ts                     ← build-time glob (scaffolded — never edit)
```
Drop the `*.resolver.ts` file in `resolvers/` and export a `ResolverAdapter`; the provided webpack registry discovers that convention. The `.resolver.ts` suffix **and** the `resolvers/` location are both required. Do not hand-register individual adapters. Read `../assets/resolver-framework/README.md` and `../scripts/README.md` for the native scaffold's plan/apply and hash-bound overwrite contract. Verify target SDK and bundler compatibility; this scaffold does not prove Turbopack registration or render correctness.

## The skeleton (follow it — don't design a new one per adapter)
```ts
import 'server-only';
import { unstable_cache } from 'next/cache';
import { cache } from 'react';
import type { Page } from '@sitecore-content-sdk/core/client';
import type { ResolverAdapter, RenderingNode, EnrichmentContext } from '../resolver-adapter.types';
import client from '../../sitecore-client.server';

type MyQueryData = { /* mirrors the query */ };
const CACHE_TAG = '{component-name}-enrichment';
const QUERY = `query …`;                                  // from Step 3, verbatim

const fetchData = cache(async (datasource: string, language: string) =>
  unstable_cache(
    async () => client.getData<MyQueryData>(QUERY, { datasource, language }),
    [CACHE_TAG, datasource, language], { revalidate: 300, tags: [CACHE_TAG] })());

function mapFields(r: MyQueryData): Record<string, unknown> { /* Step 2 gap fields only */ }

export const {componentNameCamel}Adapter: ResolverAdapter = {
  componentName: '{ComponentName}',                        // normalized, no spaces
  matches: (rendering) => rendering.componentName === '{ComponentName}',
  async enrich(page: Page, rendering: RenderingNode, context: EnrichmentContext): Promise<Page> {
    const datasource = rendering.dataSource || rendering.fields?.datasource;
    if (!datasource) return page;                          // defensive — never throw
    const data = await fetchData(datasource, context.locale);
    if (rendering.fields) Object.assign(rendering.fields, mapFields(data));
    return page;
  },
};
```

## Implementation rules

**GraphQL client sourcing.** Use `src/lib/sitecore-client.server.ts` for files in `src/lib/server/`. If it's absent, use the existing wrapper (`sitecore-client.ts` / `normalizing-sitecore-client.ts`) — the wrapper is the default path, always. Never construct or hardcode an endpoint URL in an adapter, and never crawl `node_modules` or grep package internals to discover endpoint/client behavior. If no wrapper exists or its behavior is genuinely unclear, run **at most one** verification command, then return `failed` with actionable notes. Fail fast beats a search spiral.

**Implementation style — no per-adapter architecture.** Focused query helpers + `client.getData(...)` + mappers tied directly to the Step 2 gap fields. That's the whole shape. If the implementation starts drifting into generic content-harvest logic — large navigation crawlers, broad schema sweeps, several unrelated query layers — **stop and return `failed`** with notes. Drift like that means the gap analysis was wrong, and no amount of code fixes it.

**Field-contract parity — exact keys, no "improvements".** Adapter output keys and nested shapes must match the Step 1 UI contract character-for-character. **Never rename a key even when it's semantically identical** (`link` vs `Link`, `icon` vs `Icon`, `path` vs `linkUrl`) — the component reads one spelling and gets `undefined` for the other. Preserve Sitecore field wrappers (`{ value: … }`) wherever the component expects them, and give optional arrays/objects consumed by direct access a defensive default (`childNavigation: []`).

**Be methodical — don't guess, ask.** If the C# does something unclear, the Edge schema has no obvious equivalent, or a field shape is ambiguous, use `ask-user-input` for the recoverable choice — e.g. one C# field with two plausible Edge equivalents (`ItemName` vs `DisplayName`), or two schema paths that could both satisfy the contract. Ask *before* picking. For an unrecoverable gap (the schema genuinely cannot satisfy the contract), return `failed` with notes the orchestrator can act on rather than asking. Guessing produces an adapter that compiles, enriches nothing, and costs a full redo cycle.

## Anti-hallucination
Don't invent fields (not in the XP payload = doesn't exist). Don't assume the Edge schema (introspect). Don't guess the C# logic (read it). Don't assume a generic-sounding custom resolver is OOTB. **Never skip the gap analysis** — always fetch both layouts and diff; reality beats assumptions. **Never** construct Edge endpoints by hand (`edge.sitecorecloud.io`, `/api/graphql/v1`, `sitecoreContextId=`) — use the singleton client (the orchestrator's guardrail rejects endpoint-construction).
