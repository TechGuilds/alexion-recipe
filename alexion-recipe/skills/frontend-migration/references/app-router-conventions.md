# App Router conventions

Read the installed Next.js/React versions, package scripts, route tree, TypeScript aliases and bundler configuration before adapting code. Use installed types and existing application patterns to establish version-specific APIs; do not copy a Pages Router or different-version recipe blindly.

## Routing and composition

Find the actual `app` or `src/app` root. Keep root HTML/body ownership in the root layout; preserve nested layouts, loading/error/not-found behavior, locale/site segments and catch-all route semantics. Confirm whether route parameters are promises in this application's types and follow its established access pattern. Do not invent a second catch-all route or assume all targets use the historical scaffold path.

Keep data fetching and server-only credentials on the server. Pass serializable data across client boundaries; callbacks need client ownership or an explicitly supported server action. Treat cookies, request-specific data and caching as an explicit design choice: never cache personalized output across users accidentally.

## Browser and head integration

Use small client components for interaction and providers. Browser globals still cannot run during server prerender merely because a module has a client directive. See [client boundaries](use-client.md) and [global JavaScript](global-js-coordination.md). A server parent may pass already-rendered children into a client wrapper; direct client imports are a different boundary.

Use the application's supported metadata mechanism for metadata. Stylesheet links are not arbitrary metadata fields; inspect supported head/resource placement and preserve stylesheet order. Do not introduce Pages Router `next/head` into App Router as a generic fix. CMS raw head/field content belongs to the pair skill's head-placement policy.

Import global styles from the root entry and preserve cascade order. Check bundler-specific SVG support using [SVG guidance](svg-svgr.md); a webpack block alone does not establish support when the application runs another bundler.

## Evidence

Return route/layout paths, installed versions, server/client ownership decisions, stylesheet entry order and route validation results. Verify direct navigation, client navigation and not-found behavior for changed routes. CMS placeholder registration, editing wrappers and resolver enrichment remain pair-skill responsibilities; do not replace them with generic React assumptions.
