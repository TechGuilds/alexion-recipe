import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRecoveryPages } from '../scripts/capture/process-capture-results.mjs';
import { buildRenderingCoverageReport } from '../scripts/capture/rendering-coverage.mjs';
import { fixture, seal, layout } from './capture-fixtures.mjs';

test('recovery proposes only real unattempted alternatives and counts originals in overall budget', () => {
  const plan = fixture();
  const failed = [{ route: '/primary', status: 'failed', reason: 'upstream timeout' }];
  const report = buildRenderingCoverageReport(plan, failed);
  assert.equal(selectRecoveryPages(plan, report).pages[0].route, '/alternate');
  assert.deepEqual(selectRecoveryPages(plan, report, { maxUrls: 1 }).pages, []);
  assert.equal(selectRecoveryPages(plan, report, { maxUrls: 2 }).pages.length, 1);
  assert.deepEqual(selectRecoveryPages(plan, report, { maxAlternativePages: 0 }).pages, []);
});
test('all attempts remain after success and repeated processing never retries the same page', () => {
  const plan = fixture();
  const outcomes = [{ route: '/primary', status: 'failed', reason: 'timeout' }, { route: '/alternate', status: 'captured', layout: layout({ itemId: '{BBBB}' }) }];
  const report = buildRenderingCoverageReport(plan, outcomes);
  assert.equal(report.captured, 1); assert.equal(report.outcomes.length, 2);
  assert.equal(report.requirements[0].examples[0].reason, 'timeout');
  assert.deepEqual(selectRecoveryPages(plan, report).pages, []);
});
test('per-requirement and global alternative budgets bound a chain of failures', () => {
  const plan = fixture(); plan.requirements[0].alternatives.push({ route: '/third', itemId: 'c' });
  const report = buildRenderingCoverageReport(seal(plan), [{ route: '/primary', status: 'failed' }, { route: '/alternate', status: 'failed' }]);
  assert.deepEqual(selectRecoveryPages(plan, report).pages, []);
  assert.equal(selectRecoveryPages(plan, report, { maxAlternativesPerRequirement: 2 }).pages[0].route, '/third');
  assert.deepEqual(selectRecoveryPages(plan, report, { maxAlternativesPerRequirement: 2, maxAlternativePages: 1 }).pages, []);
});
test('unattempted selected pages resume first and skipped pages consume no network attempt budget', () => {
  const plan = fixture();
  const report = buildRenderingCoverageReport(plan, [{ route: '/primary', status: 'skipped' }]);
  const recovery = selectRecoveryPages(plan, report, { maxUrls: 1, maxAlternativePages: 0 });
  assert.equal(recovery.previousAttempts, 0); assert.equal(recovery.skippedPages, 1);
  assert.equal(recovery.pages.length, 1); assert.equal(recovery.pages[0].route, '/primary');
});
