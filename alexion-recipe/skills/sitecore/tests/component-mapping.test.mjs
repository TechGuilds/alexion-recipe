import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTargetRenderingInventory, validateTargetRenderingInventory, validateSourceMappingInventory, validateComponentMappings, resolveComponentMapping } from '../scripts/mapping/component-mapping.mjs';
import { buildComponentMigrationPlan } from '../scripts/mapping/component-migration-plan.mjs';
import { transformMappedRendering } from '../scripts/mapping/mapped-rendering.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function sourceFixture() {
  const body = { schemaVersion: 2, requirementsFingerprint: 'requirements', metadata: {}, renderings: [
    { renderingId: 'r1', name: 'Source', usage: { status: 'used' }, variants: [{ variantId: null }], configurations: [{ configurationKey: 'wide', variantId: null, parameters: {} }] },
    { renderingId: 'r2', name: 'Unused', usage: { status: 'unused' }, variants: [{ variantId: 'v2', usageStatus: 'unused' }], configurations: [] },
  ], templates: [], placeholders: {}, variants: [], requirements: [{ key: 'r1:wide', renderingId: 'r1', renderingName: 'Source', configurationKey: 'wide', variantId: null, parameters: {}, sourceOccurrences: [], routes: ['/'] }], warnings: [] };
  return { ...body, generatedAt: 'today', fingerprint: hash(JSON.stringify(body)) };
}
export const targetFixture = () => createTargetRenderingInventory({ targetInstance: 'target', renderings: [{ renderingId: '{T-1}', componentName: 'Hero', path: '/renderings/Hero', datasourceTemplateId: 'd1', fields: ['Title'], parameters: [], placeholders: [] }] });
export const manifestFixture = (source = sourceFixture(), target = targetFixture()) => ({ schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: [{ sourceRenderingId: '{R-1}', configurationKey: 'wide', action: 'reuse-target', confirmed: true, targetRenderingId: 't1', targetComponent: 'Hero' }] });

test('target inventory canonicalizes and fingerprints explicitly supplied entries including empty target', () => {
  const target = targetFixture();
  assert.equal(target.renderings[0].renderingId, 't1');
  assert.equal(validateTargetRenderingInventory(target).fingerprint, target.fingerprint);
  assert.deepEqual(createTargetRenderingInventory({ targetInstance: 'new', renderings: [] }).renderings, []);
  assert.throws(() => createTargetRenderingInventory({ targetInstance: 'new' }), /renderings/);
  assert.throws(() => createTargetRenderingInventory({ targetInstance: 'new', renderings: [], guessed: true }), /Unknown/);
  assert.throws(() => createTargetRenderingInventory({ targetInstance: 'new', renderings: [{ renderingId: '{}', componentName: 'Bad', path: '/bad' }] }), /ID/);
  assert.throws(() => validateTargetRenderingInventory({ ...target, targetInstance: 'changed' }), /fingerprint/);
  assert.throws(() => createTargetRenderingInventory({ targetInstance: 'new', renderings: [target.renderings[0], { ...target.renderings[0], renderingId: '{T-1}' }] }), /Duplicate/);
});

function transformedFixture(change = {}) {
  const source = sourceFixture(), target = targetFixture(), manifest = manifestFixture(source, target);
  manifest.decisions[0] = { ...manifest.decisions[0], fieldMap: { Title: 'Heading' }, parameterMap: { Width: 'Size' }, placeholderMap: { main: 'content' }, datasourceMap: { old: 'new' }, targetVariant: 'compact', ...change };
  const inputFiles = ['source', 'target', 'manifest'].map(role => ({ role, path: `${role}.json`, sha256: hash(role) }));
  const decision = { id: 'map-1', kind: 'mapping', scopeId: 'component-mappings', choice: 'approve', rationale: 'Reviewed', userResponse: 'Approved', at: '2026-10-21T00:00:00Z', inputs: inputFiles.map(({ role, ...ref }) => ref) };
  return { mapping: manifest.decisions[0], plan: buildComponentMigrationPlan(source, target, manifest, { inputFiles, decisions: [decision] }), input: { renderingId: 'r1', componentName: 'Source', configurationKey: 'wide', fields: { Title: { value: { links: ['/source'] } } }, parameters: { Width: 'large', fieldnames: 'old', RenderingVariant: 'old' }, placeholder: 'main', datasource: 'old', variantId: null } };
}

test('pure approved transformation renames inputs, replaces variant aliases and isolates nested source values', () => {
  const { mapping, plan, input } = transformedFixture(), before = structuredClone(input);
  const result = transformMappedRendering(input, mapping, { plan });
  assert.equal(result.renderingId, 't1');
  assert.equal(result.componentName, 'Hero');
  assert.deepEqual(result.parameters, { Size: 'large', FieldNames: 'compact' });
  assert.equal(result.placeholder, 'content');
  assert.equal(result.datasource, 'new');
  assert.equal(result.variantId, 'compact');
  result.fields.Heading.value.links.push('/changed');
  assert.deepEqual(input, before);
});

test('transformation refuses missing approval, identity mismatches, retained-key collisions and selector repurposing', () => {
  const { mapping, plan, input } = transformedFixture();
  assert.throws(() => transformMappedRendering(input, mapping), /plan/);
  assert.throws(() => transformMappedRendering({ ...input, renderingId: 'other' }, mapping, { plan }), /does not match/);
  assert.throws(() => transformMappedRendering(input, { ...mapping, targetComponent: 'Altered' }, { plan }), /approved plan/);
  assert.throws(() => transformMappedRendering({ ...input, fields: { Title: 'a', Heading: 'b' } }, mapping, { plan }), /field collision/);
  assert.throws(() => transformMappedRendering({ ...input, parameters: { Width: 'a', Size: 'b' } }, mapping, { plan }), /parameter collision/);
  const f = transformedFixture({ parameterMap: { FieldNames: 'Custom' } });
  assert.throws(() => transformMappedRendering(f.input, f.mapping, { plan: f.plan }), /variant selector/);
});

test('transformation preserves own prototype-named source values safely and unchanged selectors without override', () => {
  const { mapping, plan, input } = transformedFixture({ targetVariant: undefined, fieldMap: {} });
  const fields = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data","Title":"hello"}');
  const result = transformMappedRendering({ ...input, fields }, mapping, { plan });
  assert.deepEqual(result.fields, fields);
  assert.equal(Object.getPrototypeOf(result.fields), Object.prototype);
  assert.equal(Object.hasOwn(result.fields, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result.parameters, { Size: 'large', fieldnames: 'old', RenderingVariant: 'old' });
});

test('mapping binds actual source inventory fingerprint and exact source/configuration identifiers', () => {
  const source = sourceFixture(), target = targetFixture(), manifest = manifestFixture(source, target);
  assert.equal(validateSourceMappingInventory(source).fingerprint, source.fingerprint);
  assert.equal(validateComponentMappings(manifest, { sourceInventory: source, targetInventory: target }).decisions[0].sourceRenderingId, 'r1');
  assert.throws(() => validateSourceMappingInventory({ ...source, generatedAt: 'later', renderings: [] }), /fingerprint/);
  for (const change of [{ sourceFingerprint: 'requirements' }, { targetInventoryFingerprint: 'old' }]) assert.throws(() => validateComponentMappings({ ...manifest, ...change }, { sourceInventory: source, targetInventory: target }), /stale/);
  for (const change of [{ sourceRenderingId: 'unknown' }, { configurationKey: 'unknown' }, { targetComponent: 'Other' }, { targetDatasourceTemplateId: 'other' }, { targetRenderingId: 'other' }]) {
    assert.throws(() => validateComponentMappings({ ...manifest, decisions: [{ ...manifest.decisions[0], ...change }] }, { sourceInventory: source, targetInventory: target }));
  }
});

test('mapping rejects ambiguous or unsafe transformations and incompatible action details', () => {
  const source = sourceFixture(), target = targetFixture(), manifest = manifestFixture(source, target);
  for (const change of [{ fieldMap: { A: 'Title', B: 'Title' } }, { parameterMap: { a: 'Width', b: 'Width' } }, { fieldMap: JSON.parse('{"__proto__":"Title"}') }, { datasourceMap: { a: 'constructor' } }, { action: 'implement-missing' }]) {
    assert.throws(() => validateComponentMappings({ ...manifest, decisions: [{ ...manifest.decisions[0], ...change }] }, { sourceInventory: source, targetInventory: target }));
  }
  assert.throws(() => validateComponentMappings({ ...manifest, decisions: [...manifest.decisions, manifest.decisions[0]] }, { sourceInventory: source, targetInventory: target }), /Duplicate/);
  assert.deepEqual(validateComponentMappings({ ...manifest, decisions: [{ ...manifest.decisions[0], placeholderMap: { a: 'main', b: 'main' }, datasourceMap: { a: 'merged', b: 'merged' } }] }, { sourceInventory: source, targetInventory: target }).decisions[0].datasourceMap, { a: 'merged', b: 'merged' });
});

test('resolution is ID-based with explicit configuration taking precedence over explicit rendering fallback', () => {
  const source = sourceFixture(), target = targetFixture(), manifest = manifestFixture(source, target);
  manifest.decisions.push({ sourceRenderingId: 'r1', action: 'implement-missing', confirmed: true });
  const validated = validateComponentMappings(manifest, { sourceInventory: source, targetInventory: target });
  assert.equal(resolveComponentMapping(validated, 'r1', 'wide').action, 'reuse-target');
  assert.equal(resolveComponentMapping(validated, 'r1').action, 'implement-missing');
  assert.equal(resolveComponentMapping(validated, 'Source'), undefined);
});
