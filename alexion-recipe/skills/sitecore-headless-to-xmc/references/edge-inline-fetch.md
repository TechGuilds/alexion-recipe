# Inline Edge fetch (RSC queries Edge itself)

The pattern for when the chosen data path is "the component queries Edge GraphQL itself" (not props, not a resolver adapter). Load only **after** the constitution's selection rubric has chosen inline fetch. Carries the implementation pattern only.

## Server Component by default
Write the component as an `async` function that awaits Edge directly — **do not add `'use client'`**. Fallback: if the parent in the rendered tree is a client component, this must be too — load `../../frontend-migration/references/use-client.md`, then fetch client-side (effect / route handler) respecting `'use client'` propagation.

## Singleton GraphQL client (never a second client)
```tsx
import client from '@/lib/sitecore-client.server';   // server-only singleton (extends the SDK's NormalizingSitecoreClient)
import { ComponentProps } from 'lib/component-props';

const MY_QUERY = /* GraphQL */ `
  query MyQuery($datasource: String!, $language: String!) {
    item(path: $datasource, language: $language) { /* fields the component needs */ }
  }`;
type MyShape = { item: { /* mirrors the query */ } | null };

export default async function MyComponent(props: ComponentProps & { fields: { /* layout-JSON props */ } }) {
  const datasource = props.rendering?.dataSource ?? '';
  const language = /* propagate from page context — see below */;
  const data = await client.getData<MyShape>(MY_QUERY, { datasource, language });
  return <div>{/* render using `data` + any props.fields already on layout JSON */}</div>;
}
```
- Use `client.getData<T>(query, variables)` (inherited from the base). **Do not** instantiate a second client, add `apollo-client`/another transport, or grep `node_modules/` to verify the method shape.
- Keep the skeleton small — **translate, don't redesign**; the markup mirrors the source rendering, only the *data path* changes.

## Language / locale
Pass `language` (and locale-scoped vars) **exactly** as the project's existing layout-service `getData` call does — inspect the wired `sitecore-client.server.ts` / existing adapters for the convention; don't invent a locale-resolution path. The mock-layout fetch and the live Edge path must produce the **same** `language`; divergence is a framework bug — surface it.

## Per-case (not skill law)
Error handling, loading state (`Suspense` for client fallbacks), caching (`revalidate` / `cache: 'no-store'`), pagination/batching — choose what the rendering needs; don't over-engineer.

## Audit trail (required on success)
```json
{ "kind": "component", "key": "component.<slug>",
  "payload": { "decision": "completed", "rationale": "inline-edge-query: <one-line summary>", "source": "system" } }
```
The `rationale` MUST begin with the literal `inline-edge-query:` (downstream tooling greps for it). The payload schema is `.strict()`.

## Do NOT use inline fetch when
Data is already on `props.fields` / dataSource-resolved layout JSON (props path); a constitution safety rule trips (editing-mode parity / no Edge analog / shared enrichment) → defer to a resolver adapter (`resolver-pending:`); or the component is a pure wrapper/root layout with no data need.
