import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapturePlan, buildRenderingCoverageReport, capturedPlacements } from '../scripts/capture/rendering-coverage.mjs';
import { fixture, seal, layout } from './capture-fixtures.mjs';

test('approved plan rejects drafts, tampering, unsafe routes, and output aliases', () => {
  assert.equal(validateCapturePlan(fixture()).scope, 'approved');
  assert.throws(() => validateCapturePlan({ ...fixture(), draft: true }), /approved/);
  assert.throws(() => validateCapturePlan({ ...fixture(), warnings: ['tampered'] }), /fingerprint/);
  for (const route of ['/../escape', '/%2e%2e/escape', '/bad\\route', '//host/path', '/con', '/trail.']) {
    const plan = fixture(); plan.selectedPages[0].route = route;
    assert.throws(() => validateCapturePlan(seal(plan)), /Unsafe/);
  }
  const collision = fixture(); collision.requirements[0].alternatives.push({ route: '/', itemId: 'a' }, { route: '/home', itemId: 'b' });
  assert.throws(() => validateCapturePlan(seal(collision)), /collision/);
});
test('nested stable rendering plus variant verifies coverage; names alone never verify', () => {
  const plan = fixture();
  assert.equal(capturedPlacements(layout()).length, 2);
  const report = buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'captured', layout: layout() }]);
  assert.equal(report.captured, 1);
  assert.equal(report.requirements[0].examples[0].consistencyStatus, 'not-evaluated');
  const namesOnly = layout(); delete namesOnly.sitecore.route.placeholders.root[0].placeholders.main[0].renderingId;
  assert.equal(buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'captured', layout: namesOnly }]).captured, 0);
  assert.equal(buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'captured', layout: layout({ variant: 'small' }) }]).requirements[0].status, 'target-absent');
});
test('page identity and conflicting variant evidence are never verified', () => {
  for (const captured of [layout({ itemId: 'wrong' }), layout({ params: { VariantId: 'small' } })]) assert.equal(buildRenderingCoverageReport(fixture(), [{ route: '/primary', status: 'captured', layout: captured }]).captured, 0);
});
test('placement, datasource and nonvariant parameters are warnings, and unused definitions mapping-only', () => {
  const plan = fixture(); plan.requirements[0].sourceOccurrences = [{ route: '/primary', itemId: '{AAAA}', language: 'en', instanceId: 'u1', placeholder: 'other', datasource: 'source', parameters: { Styles: 'source-style' } }];
  plan.requirements.push({ key: 'unused', renderingId: 'unused', variantId: null, definitionOnly: true, alternatives: [] });
  const report = buildRenderingCoverageReport(seal(plan), [{ route: '/primary', status: 'captured', layout: layout() }]);
  assert.equal(report.requirements[0].status, 'captured');
  assert.equal(report.requirements[0].examples[0].consistencyStatus, 'warning');
  assert.equal(report.requirements[1].status, 'mapping-only');
});
test('mapping occurrences prove page-local UID identity, with exact item/language/variant association', () => {
  const plan = fixture(), captured = layout();
  delete captured.sitecore.route.placeholders.root[0].placeholders.main[0].renderingId;
  const source = { renderingId: 'hero-id', variantId: 'large', parameters: { Styles: 'source' }, sourceOccurrences: [{ route: '/primary', itemId: '{AAAA}', language: 'en', instanceId: 'u1', placeholder: 'root/main' }] };
  assert.equal(buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'captured', layout: captured }], { mappingInventory: { requirements: [source] } }).captured, 1);
  for (const stale of [
    { ...source, renderingId: 'wrong' }, { ...source, variantId: 'small' },
    { ...source, sourceOccurrences: [{ ...source.sourceOccurrences[0], itemId: '{BBBB}' }] },
    { ...source, sourceOccurrences: [{ ...source.sourceOccurrences[0], language: 'fr' }] },
    { ...source, sourceOccurrences: [{ ...source.sourceOccurrences[0], route: '/alternate' }] },
  ]) assert.equal(buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'captured', layout: captured }], { mappingInventory: { requirements: [stale] } }).captured, 0);
});
test('unattempted and skipped selected pages are pending rather than failed captures', () => {
  assert.equal(buildRenderingCoverageReport(fixture(), []).requirements[0].status, 'not-captured');
  assert.equal(buildRenderingCoverageReport(fixture(), [{ route: '/primary', status: 'skipped' }]).requirements[0].status, 'not-captured');
});
test('consistency picks the captured UID occurrence and compares parameter names without casing differences', () => {
  const plan = fixture();
  plan.requirements[0].sourceOccurrences = [
    { route: '/primary', itemId: '{AAAA}', language: 'en', instanceId: 'other', placeholder: 'other', datasource: 'other', parameters: { styles: 'wrong' } },
    { route: '/primary', itemId: '{AAAA}', language: 'en', instanceId: 'u1', placeholder: 'root/main', datasource: '', parameters: { styles: 'hero' } },
  ];
  const report = buildRenderingCoverageReport(seal(plan), [{ route: '/primary', status: 'captured', layout: layout({ params: { Styles: 'hero' } }) }]);
  const example = report.requirements[0].examples[0];
  assert.equal(example.consistencyStatus, 'consistent'); assert.equal(example.expectedPlacement.instanceId, 'u1');
  assert.deepEqual(example.differences, {}); assert.equal(example.severity, 'info');
});
test('content uncertainty is a warning, execution failures errors, and unattempted pages informational', () => {
  const plan = fixture();
  assert.equal(buildRenderingCoverageReport(plan, []).requirements[0].severity, 'info');
  assert.equal(buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'failed', reason: 'HTTP 503' }]).requirements[0].examples[0].severity, 'error');
  assert.equal(buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'captured', layout: layout({ variant: 'wrong' }) }]).requirements[0].severity, 'warning');
});
