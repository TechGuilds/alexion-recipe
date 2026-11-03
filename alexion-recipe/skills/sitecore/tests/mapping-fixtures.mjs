// Real discovery builders keep item-3 tests aligned with the shipped inventory contract.
import { buildConfigurationRoutes } from '../scripts/analysis/rendering-configurations.mjs';
import { buildSourceMappingInventory } from '../scripts/analysis/build-rendering-mapping-inventory.mjs';

export function sourceFixture({ complete = true } = {}) {
  const renderings = [{ id: 'r-used', name: 'Used Component' }, { id: 'r-unused', name: 'Unused Component' }];
  const artifacts = {
    'rendering-details': { source_instance: 'https://source.example.test', site_root: '/sitecore/content/Test', language: 'en', inventory_scan_complete: true, usage_scan_complete: complete, rendering_details: renderings.map((r) => ({ ...r, path: `/sitecore/layout/Renderings/Test/${r.name}` })) },
    'rendering-instances': [{ renderingId: 'r-used', renderingName: 'Used Component', instanceId: 'instance-1', deviceId: null, pageId: 'page-1', itemPath: '/sitecore/content/Test/Home', language: 'en', placeholder: 'main', datasource: 'data-1', parameters: 'Style=wide', variantId: null }],
    'rendering-page-mapping': { pages: [{ itemPath: '/sitecore/content/Test/Home', route: '/' }] },
    'rendering-variants': { schemaVersion: 1, variants: [{ id: 'variant-unused', name: 'Alternate', path: '/sitecore/content/Test/Presentation/Rendering Variants/Used/Alternate', renderingIds: ['r-used'], fields: {}, nodes: [], observed: false }] },
    'template-definitions': { templates: [] },
    'placeholder-settings': { placeholder_settings: [] },
    'sxa-conversion-inputs': { dynamicPlaceholders: { placeholders: [] } },
    'metadata-stats': { audit_metadata: { database: 'master', language: 'en' } },
  };
  return buildSourceMappingInventory({ renderings, artifacts, entries: buildConfigurationRoutes(renderings, artifacts), generatedAt: '2026-10-21T00:00:00Z' });
}
