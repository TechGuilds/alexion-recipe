import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigurationRoutes } from '../scripts/analysis/rendering-configurations.mjs';
import { buildSourceMappingInventory } from '../scripts/analysis/build-rendering-mapping-inventory.mjs';

function input(complete = true) {
  const renderings = [{ id: '{R-1}', name: 'Used' }, { id: 'R2', name: 'Unused' }];
  const artifacts = {
    'rendering-details': { inventory_scan_complete: true, usage_scan_complete: complete, source_instance: 'source', rendering_details: [{ id: 'r1', datasource_template: 'T1', parameters_template: '/templates/Params', placeholders: 'PH1', discovery_sources: ['site'] }, { id: 'R2' }] },
    'rendering-instances': [{ renderingId: 'r1', renderingName: 'Used', instanceId: 'I1', pageId: 'P1', itemPath: '/sitecore/content/Home', language: 'en', deviceId: null, placeholder: 'main', datasource: 'Data1', parameters: 'Style=wide', variantId: null }],
    'rendering-page-mapping': { pages: [{ itemPath: '/sitecore/content/Home', route: '/' }] },
    'rendering-variants': { schemaVersion: 1, variants: [{ id: 'V1', name: 'Wide', path: '/variants/Wide', renderingIds: ['r1'], fields: { Css: 'wide' }, nodes: [{ path: '/node', template: 'Text', fields: { FieldName: 'Title' } }], observed: false }] },
    'template-definitions': { templates: [{ id: 'T1', name: 'Data', fields: [{ id: 'F1', name: 'Title', type: 'Single-Line Text', standard_value: 'Default', shared: '1' }] }, { id: 'T2', path: '/templates/Params', fields: [] }] },
    'placeholder-settings': { placeholder_settings: [{ id: 'PH1', placeholder_key: 'main', allowed_renderings: ['r1'], editable: '1' }] },
    'sxa-conversion-inputs': { dynamicPlaceholders: { placeholders: [] } },
    'metadata-stats': { audit_metadata: { database: 'master', language: 'en' } },
    'code-discovery-report': { componentInventory: { Used: { sourcePath: 'Views/Used.cshtml' } } },
  };
  return { renderings, artifacts, entries: buildConfigurationRoutes(renderings, artifacts), generatedAt: '2026-10-20T00:00:00Z' };
}

test('complete scan preserves mapping metadata, unused definitions and exhaustive configurations', () => {
  const source = input();
  const before = JSON.stringify(source);
  const inventory = buildSourceMappingInventory(source);
  const used = inventory.renderings.find((r) => r.renderingId === 'r1');
  assert.equal(used.usage.status, 'used');
  assert.equal(used.usage.countsComplete, true);
  assert.equal(used.usage.instanceCount, 1);
  assert.deepEqual(used.dependencies.datasourceTemplateIds, ['t1']);
  assert.equal(used.dependencies.parametersTemplateId, 't2');
  assert.equal(used.implementation.filePath, 'Views/Used.cshtml');
  assert.equal(used.configurations.length, 2);
  assert.equal(inventory.renderings.find((r) => r.renderingId === 'r2').usage.status, 'unused');
  assert.equal(inventory.variants[0].nodes[0].fields.FieldName, 'Title');
  assert.equal(inventory.templates.find((t) => t.templateId === 't1').fields[0].standardValue, 'Default');
  assert.equal(inventory.requirements.find((r) => r.renderingId === 'r1' && !r.definitionOnly).sourceOccurrences[0].datasource, 'Data1');
  assert.equal(JSON.stringify(source), before);
  assert.equal(inventory.fingerprint, buildSourceMappingInventory({ ...source, generatedAt: 'later' }).fingerprint);
});

test('uncertified, excluded or malformed evidence never certifies absence as unused', () => {
  for (const mutate of [(s) => { s.artifacts['rendering-details'].usage_scan_complete = false; }, (s) => { s.artifacts['rendering-details'].excluded_content_paths = ['/excluded']; }, (s) => { s.artifacts['rendering-instances'] = '{broken'; }]) {
    const source = input(); mutate(source);
    const inventory = buildSourceMappingInventory(source);
    assert.equal(inventory.metadata.completeness.pageUsage, false);
    assert.equal(inventory.renderings.find((r) => r.renderingId === 'r2').usage.status, 'unknown');
  }
});

test('missing dependency and variant definitions remain explicit unknowns', () => {
  const source = input();
  source.artifacts['rendering-details'].rendering_details[0].datasource_template = 'Missing';
  source.artifacts['template-definitions'].templates[0].base_templates = ['MissingBase'];
  source.artifacts['rendering-variants'] = '{broken';
  const inventory = buildSourceMappingInventory(source);
  assert.equal(inventory.metadata.completeness.templateDefinitions, false);
  assert.equal(inventory.metadata.completeness.variantDefinitions, false);
  assert.ok(inventory.warnings.some((w) => w.includes('Template reference unresolved')));
});


test('observed variants without definitions never certify complete variant evidence', () => {
  const source=input();
  source.artifacts['rendering-variants']={schemaVersion:1,variants:[]};
  const result=buildSourceMappingInventory(source);
  assert.equal(result.metadata.completeness.variantDefinitions,false);
  assert.equal(result.metadata.completeness.variantAssociations,false);
});
