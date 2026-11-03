import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRenderingId, normalizeEvidenceRoute, parseRenderingInstances, parseRenderingVariants } from '../scripts/analysis/rendering-evidence.mjs';
import { buildConfigurationRoutes, normalizeRenderingParameters } from '../scripts/analysis/rendering-configurations.mjs';

const row = (overrides = {}) => ({ renderingId: '{AB-CD}', renderingName: 'Hero', instanceId: '{I-1}', pageId: '{P-1}', itemPath: '/sitecore/content/Home', language: 'en', deviceId: null, placeholder: 'main', datasource: '{DATA}', parameters: 'Style=wide', variantId: null, ...overrides });
const artifacts = (rows, pages = [{ itemPath: row().itemPath, route: '/' }]) => ({ 'rendering-instances': rows, 'rendering-page-mapping': { pages }, 'rendering-variants': { schemaVersion: 1, variants: [] } });

test('strict JSON/JSONL readers canonicalize only IDs and reject invalid evidence', () => {
  assert.equal(canonicalRenderingId('{AB-CD}'), 'abcd');
  assert.deepEqual(parseRenderingInstances('\uFEFF' + JSON.stringify(row()) + '\n'), [row()]);
  assert.deepEqual(parseRenderingInstances(''), []);
  assert.equal(parseRenderingInstances(null), null);
  for (const bad of ['{}', '[null]', [{ ...row(), renderingId: '' }], [{ ...row(), deviceId: 4 }]]) assert.throws(() => parseRenderingInstances(bad), /rerun source discovery/);
  assert.throws(() => parseRenderingVariants({ schemaVersion: 1, variants: [{ id: 'v' }] }), /rerun source discovery/);
});

test('only explicit safe website routes are accepted', () => {
  assert.equal(normalizeEvidenceRoute('/About/'), '/about');
  for (const bad of ['//evil', '/a%2fb/../c', '/%2e%2e/a', '/sitecore/content', '/a?b', '/a%23b', '/a%5cb', '/%00', '/%', 'home']) assert.equal(normalizeEvidenceRoute(bad), null, bad);
});

test('configuration identity preserves visual parameters and all placements', () => {
  assert.deepEqual(normalizeRenderingParameters('Style=z&Style=a&DataSource=ignored&DynamicPlaceholderId=2&FieldNames=%7BAAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE%7D'), { fieldnames: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', style: 'a\u001fz' });
  const rows = [row(), row({ instanceId: 'I2', datasource: 'other', placeholder: 'footer' }), row({ instanceId: 'I3', parameters: 'Style=narrow' })];
  const entries = buildConfigurationRoutes([{ id: 'abcd', name: 'Hero' }], artifacts(rows));
  assert.equal(entries[0].requirements.length, 2);
  assert.equal(entries[0].requirements[0].sourceOccurrences.length, 2);
  assert.equal(entries[0].requirements[0].sourceOccurrences[1].datasource, 'other');
  assert.deepEqual(entries, buildConfigurationRoutes([{ id: 'abcd', name: 'Hero' }], artifacts(rows)));
});

test('unused definitions and unobserved variants stay mapping-only', () => {
  const data = artifacts([]);
  data['rendering-variants'].variants.push({ id: '{V-1}', name: 'Wide', path: '/variants/Wide', renderingIds: ['AB-CD'], fields: {}, nodes: [], observed: false });
  const entries = buildConfigurationRoutes([{ id: 'abcd', name: 'Hero' }, { id: 'unused', name: 'Unused' }], data);
  assert.equal(entries[0].requirements.length, 0);
  assert.deepEqual(entries[0].unplacedRequirements.map((r) => r.configurationKey), ['variant:v1', 'definition']);
  assert.ok(entries[0].unplacedRequirements.every((r) => r.definitionOnly));
});

test('ambiguous routes and shared designs retain occurrences as unresolved', () => {
  const rows = [row(), row({ pageId: 'P2', itemPath: '/sitecore/content/Other' }), row({ pageId: 'P3', itemPath: '/sitecore/content/Presentation/Partial Designs/Header' })];
  const entries = buildConfigurationRoutes([{ id: 'abcd', name: 'Hero' }], artifacts(rows, rows.map((r) => ({ itemPath: r.itemPath, route: '/' }))));
  assert.equal(entries[0].requirements.length, 0);
  assert.equal(entries[0].unplacedRequirements[0].sourceOccurrences.length, 3);
  assert.deepEqual(new Set(entries[0].unplacedRequirements[0].sourceOccurrences.map((o) => o.routeIssue)), new Set(['route-conflict', 'shared-design-requires-page']));
  assert.deepEqual(buildConfigurationRoutes([], {}, [{ route: '/legacy' }]), [{ route: '/legacy' }]);
});
