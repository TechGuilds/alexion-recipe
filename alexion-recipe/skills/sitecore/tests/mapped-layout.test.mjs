import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFixture } from './mapping-fixtures.mjs';
import { createTargetRenderingInventory, sha256 } from '../scripts/mapping/component-mapping.mjs';
import { buildComponentMigrationPlan } from '../scripts/mapping/component-migration-plan.mjs';
import { mapLayoutForTarget } from '../scripts/mapping/map-layout-for-target.mjs';

function fixture(placeholderMap = { main: 'headless-main' }) {
  const source = sourceFixture(), target = createTargetRenderingInventory({ targetInstance: 'target', renderings: [{ renderingId: 'target-card', componentName: 'TargetCard', path: '/target/card' }] });
  const manifest = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: [{ sourceRenderingId: 'rused', action: 'reuse-target', confirmed: true, targetRenderingId: 'targetcard', targetComponent: 'TargetCard', fieldMap: { Title: 'Heading' }, parameterMap: { Style: 'Display' }, placeholderMap, datasourceMap: { 'data-1': 'target-data' } }] };
  const inputFiles = ['source', 'target', 'manifest'].map(role => ({ role, path: `${role}.json`, sha256: sha256(role) }));
  const decisions = [{ id: 'mapping', kind: 'mapping', scopeId: 'component-mappings', choice: 'approve', rationale: 'Reviewed', userResponse: 'Reuse the target card', at: '2026-10-21T00:00:00Z', inputs: inputFiles.map(({ role, ...ref }) => ref) }];
  const plan = buildComponentMigrationPlan(source, target, manifest, { inputFiles, decisions });
  const layout = { sitecore: { context: { language: 'en' }, route: { itemId: 'page-1', fields: {}, placeholders: { main: [{ uid: 'instance-1', componentName: 'Used Component', params: { Style: 'wide' }, dataSource: 'data-1', fields: { Title: { value: 'Text' } }, placeholders: { inner: [{ uid: 'unknown', componentName: 'Unmapped', params: {}, fields: {} }] } }], empty: [] } } } };
  return { plan, layout };
}

test('derived full layout maps exact page-local source UIDs and preserves nesting and raw source', () => {
  const { plan, layout } = fixture(), before = structuredClone(layout);
  const result = mapLayoutForTarget(layout, '/', plan);
  assert.deepEqual(layout, before);
  const node = result.layout.sitecore.route.placeholders['headless-main'][0];
  assert.equal(node.componentName, 'TargetCard'); assert.equal(node.renderingId, 'targetcard');
  assert.equal(node.fields.Heading.value, 'Text'); assert.deepEqual(node.params, { Display: 'wide' });
  assert.equal(node.dataSource, 'target-data'); assert.equal(node.placeholders.inner[0].componentName, 'Unmapped');
  assert.deepEqual(result.layout.sitecore.route.placeholders.empty, []);
  assert.equal(result.appliedRequirementKeys.length, 1); assert.equal(result.warnings.length, 1);
  assert.throws(() => mapLayoutForTarget(result.layout, '/', plan), /raw source/);
});

test('names, wrong page identities, languages, variants and parameters cannot authorize reuse', () => {
  for (const mutate of [
    layout => { delete layout.sitecore.route.placeholders.main[0].uid; },
    layout => { layout.sitecore.route.itemId = 'another-page'; },
    layout => { layout.sitecore.context.language = 'fr'; },
    layout => { layout.sitecore.route.placeholders.main[0].params.Style = 'different'; },
    layout => { layout.sitecore.route.placeholders.main[0].params.FieldNames = 'another-variant'; },
    layout => { layout.sitecore.route.placeholders.main[0].variantId = 'another-variant'; },
  ]) {
    const { plan, layout } = fixture(); mutate(layout);
    const result = mapLayoutForTarget(layout, '/', plan);
    assert.equal(result.appliedRequirementKeys.length, 0);
    assert.equal(result.layout.sitecore.route.placeholders.main[0].componentName, 'Used Component');
  }
});

test('colliding fields and cross-container placeholder moves fail without mutating source', () => {
  const first = fixture(); first.layout.sitecore.route.placeholders.main[0].fields.Heading = { value: 'Existing' };
  const original = structuredClone(first.layout);
  assert.throws(() => mapLayoutForTarget(first.layout, '/', first.plan), /collision/);
  assert.deepEqual(first.layout, original);
  const second = fixture({ main: 'footer/main' });
  const node = second.layout.sitecore.route.placeholders.main[0]; node.sourcePlaceholder = 'main';
  second.layout.sitecore.route.placeholders = { outer: [{ componentName: 'Container', params: {}, fields: {}, placeholders: { main: [node] } }] };
  assert.throws(() => mapLayoutForTarget(second.layout, '/', second.plan), /explicit target composition/);
});


test('query-string presentation parameters are parsed and explicit variant evidence cannot be ignored', () => {
  const first = fixture(); first.layout.sitecore.route.placeholders.main[0].params = 'Style=wide';
  assert.equal(mapLayoutForTarget(first.layout, '/', first.plan).appliedRequirementKeys.length, 1);
  const second = fixture(); second.layout.sitecore.route.placeholders.main[0].params = 'Style=wide&Style=other';
  assert.throws(() => mapLayoutForTarget(second.layout, '/', second.plan), /repeated rendering parameter/);
  const third = fixture(); third.layout.sitecore.route.placeholders.main[0].params = 'Style=wide&FieldNames=first';
  third.layout.sitecore.route.placeholders.main[0].variantId = 'second';
  assert.equal(mapLayoutForTarget(third.layout, '/', third.plan).appliedRequirementKeys.length, 0);
});
