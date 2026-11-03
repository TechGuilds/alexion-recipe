# Resolver framework assets

Status: executable with ../../scripts/scaffold-resolver.mjs. Nine payloads are bundled golden samples; manifest.json records target paths and canonical SHA-256 hashes. The native scaffold-engine.mjs is also owned here and shared with this pair skill's mock Layout Service scaffold. Copy the whole pair skill for standalone use; --resolver-assets remains an optional explicit directory override. No monorepo runtime dependencies exist.

| Generated target file | Bundled template constant |
| --- | --- |
| src/lib/layout-normalizer.ts | LAYOUT_NORMALIZER_TEMPLATE |
| src/lib/normalizing-sitecore-client.ts | NORMALIZING_SITECORE_CLIENT_TEMPLATE |
| src/lib/media/bynder-asset-normalizer.ts | BYNDER_ASSET_NORMALIZER_TEMPLATE |
| src/lib/server/resolver-adapter.types.ts | RESOLVER_ADAPTER_TYPES_TEMPLATE |
| src/lib/server/resolver-registry.ts | RESOLVER_REGISTRY_TEMPLATE |
| src/lib/server/resolver-strategy.ts | RESOLVER_STRATEGY_TEMPLATE |
| src/lib/server/resolver-adapter.stub.ts.template | RESOLVER_ADAPTER_STUB_TEMPLATE |
| src/lib/server/resolvers/README.md | RESOLVER_FOLDER_README_TEMPLATE |
| src/lib/sitecore-client.ts | SITECORE_CLIENT_TEMPLATE via writeClients() |

The scaffold recognizes src/app/[site]/[locale]/[[...path]]/page.tsx, src/app/[[...path]]/page.tsx and src/app/[...path]/page.tsx in that order. It imports applyResolverStrategy and inserts live-mode enrichment before the notFound guard, passing locale/site/routePath/resolverDebug. The native scaffold requires explicit --route for a patch and proposes import plus enrichment together for its supported shape; import-only or unsupported integration remains unresolved.

The scaffold reports file actions and before/after hashes, preserves conflicts, and requires exact overwrite hashes with backups for replacements. It creates missing files, leaves identical files unchanged and never overwrites existing content without an explicit matching approval.

Substitution contract: framework constants are written directly. The per-component stub template retains {{COMPONENT_NAME}} (whitespace-normalized match name) and {{COMPONENT_NAME_CAMEL}} (valid exported identifier prefix). Validate collisions and identifier syntax. Resolve imports relative to the final resolvers/ file location, not the stored template location. Consumers must verify the actual client entrypoint.

Generated imports require Content SDK, Next, React and server-only. The combined 14-file scaffold covers internal dependencies. Resolver-only setup reports missing mock-sitecore-client.ts and sitecore.config.ts. Registry discovery uses webpack require.context and *.resolver.ts, not Turbopack. Optional --component Name=identifier generates identifier.resolver.ts and corrects the final-location type import. Existing registrations are preserved; enrichment stubs remain unresolved.

Installed SDK compatibility and actual application build/browser results remain target-specific checks. The native script does not import a retired package. See the [executable CLI contract](../../scripts/README.md).
