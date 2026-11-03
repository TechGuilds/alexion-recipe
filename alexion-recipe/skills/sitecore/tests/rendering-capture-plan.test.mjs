import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderingCapturePlan } from '../scripts/analysis/build-rendering-capture-plan.mjs';

const requirement = (id, extra = {}) => ({ key: `${id}:configuration`, renderingId: id, renderingName: id, configurationKey: 'configuration', variantId: null, parameters: {}, ...extra });
const page = (route, ids) => ({ route, requirements: ids.map((id) => requirement(id)) });
const approved = { includedRenderingIds: new Set(['a', 'b', 'c', 'd', 'e', 'f']) };

test('exact cover finds minimum and keeps dominated pages as alternatives', () => {
  const entries = [page('/greedy', ['a', 'b', 'c', 'd']), page('/left', ['a', 'b', 'e']), page('/right', ['c', 'd', 'f']), page('/small', ['a'])];
  const plan = buildRenderingCapturePlan(entries, approved);
  assert.deepEqual(plan.selectedPages.map((p) => p.route), ['/left', '/right']);
  assert.equal(plan.optimization.minimumProven, true);
  assert.equal(plan.requirements.find((r) => r.renderingId === 'a').alternatives.length, 3);
  assert.deepEqual(plan, buildRenderingCapturePlan(entries, approved));
  const bounded = buildRenderingCapturePlan(entries, { ...approved, searchLimit: 0 });
  assert.equal(bounded.optimization.minimumProven, false);
  assert.equal(bounded.uncoveredRequirementKeys.length, 0);
  assert.equal(bounded.selectedPages.length, 3);
});

test('selection ignores parameters, datasource and placement but distinguishes variants', () => {
  const entries = [{ route: '/', requirements: [requirement('{A}', { parameters: { style: 'wide' } }), requirement('a', { key: 'a:other', parameters: { style: 'narrow' }, sourceOccurrences: [{ datasource: 'different', placeholder: 'footer' }] }), requirement('a', { key: 'a:v', variantId: '{V-1}' })] }];
  const plan = buildRenderingCapturePlan(entries, { includedRenderingIds: new Set(['a']) });
  assert.equal(plan.totalRequirements, 2);
  assert.deepEqual(plan.requirements.map((r) => r.key), ['a:variant:default', 'a:variant:v1']);
});

test('missing scope is a discovery-only draft and explicit empty scope selects nothing', () => {
  const entries = [page('/', ['a'])];
  assert.equal(buildRenderingCapturePlan(entries).draft, true);
  assert.equal(buildRenderingCapturePlan(entries).scope, 'discovery-only');
  const empty = buildRenderingCapturePlan(entries, { includedRenderingIds: new Set() });
  assert.equal(empty.draft, false);
  assert.deepEqual(empty.selectedPages, []);
  for (const searchLimit of [-1, 1.5, NaN]) assert.throws(() => buildRenderingCapturePlan(entries, { searchLimit }), /search limit/);
});

test('unresolved used targets produce gaps; unused definitions never become capture targets', () => {
  const entries = [{ route: '/', requirements: [], unplacedRequirements: [requirement('a', { sourceOccurrences: [{ route: null }] }), requirement('b', { definitionOnly: true })] }];
  const plan = buildRenderingCapturePlan(entries, approved);
  assert.equal(plan.totalRequirements, 1);
  assert.deepEqual(plan.uncoveredRequirementKeys, ['a:variant:default']);
  assert.equal(plan.optimization.minimumProven, false);
});
