import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTargetRenderingInventory } from '../scripts/mapping/component-mapping.mjs';
import { buildComponentMigrationPlan, validateComponentMigrationPlan } from '../scripts/mapping/component-migration-plan.mjs';
import { verifyComponentMigrationPlanEvidence } from '../scripts/mapping/cli-files.mjs';
import { buildMigrationPlan } from '../scripts/mapping/build-component-migration-plan.mjs';
import { sourceFixture as realSourceFixture } from './mapping-fixtures.mjs';

const hash = v => createHash('sha256').update(v).digest('hex');
function fixture() {
  const body = { schemaVersion: 2, metadata: {}, requirementsFingerprint: 'legacy', renderings: [
    { renderingId: 'r1', name: 'Used', usage: { status: 'used' }, variants: [], configurations: [{ configurationKey: 'wide' }] },
    { renderingId: 'r2', name: 'Unused', usage: { status: 'unused' }, variants: [{ variantId: 'v2', usageStatus: 'unused' }], configurations: [] },
  ], requirements: [{ key: 'r1:wide', renderingId: 'r1', renderingName: 'Used', configurationKey: 'wide', variantId: null, parameters: {}, routes: ['/'], sourceOccurrences: [] }], templates: [], variants: [], placeholders: {}, warnings: ['source warning'] };
  const source = { ...body, fingerprint: hash(JSON.stringify(body)) }, target = createTargetRenderingInventory({ targetInstance: 'new', renderings: [] });
  const manifest = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: [{ sourceRenderingId: 'r1', action: 'implement-missing', confirmed: true }, { sourceRenderingId: 'r2', action: 'disregard', confirmed: true, rationale: 'Unused and outside agreed scope' }] };
  const inputFiles = ['source', 'target', 'manifest'].map(role => ({ role, path: `${role}.json`, sha256: hash(role) }));
  const decision = { id: 'map-1', kind: 'mapping', scopeId: 'component-mappings', choice: 'approve', rationale: 'Reviewed mapping', userResponse: 'I approve these exact mappings', at: '2026-10-21T00:00:00Z', inputs: inputFiles.map(({ role, ...ref }) => ref) };
  return { source, target, manifest, inputFiles, decision };
}

test('confirmed flags alone never approve mappings; all unused definitions and variants remain visible', () => {
  const f = fixture(), plan = buildComponentMigrationPlan(f.source, f.target, f.manifest, { inputFiles: f.inputFiles });
  assert.equal(plan.approval.status, 'unresolved');
  assert.ok(plan.entries.every(e => e.action === 'mapping-required' && !e.confirmed));
  assert.deepEqual(plan.entries.map(e => e.key), ['r1:wide', 'r2:definition', 'r2:variant:v2']);
  assert.throws(() => validateComponentMigrationPlan(plan, { requireApproval: true }), /approval/);
});

test('exact current keyed approval unlocks explicit actions without upgrading capture evidence', () => {
  const f = fixture(), plan = buildComponentMigrationPlan(f.source, f.target, f.manifest, { inputFiles: f.inputFiles, decisions: [f.decision] });
  assert.equal(plan.approval.status, 'approved');
  assert.equal(plan.entries[0].action, 'implement-missing');
  assert.equal(plan.entries[0].sourceCoverageStatus, 'not-captured');
  assert.equal(plan.entries[1].action, 'disregard');
  assert.equal(validateComponentMigrationPlan(plan, { requireApproval: true, currentInputs: f.inputFiles }).fingerprint, plan.fingerprint);
  assert.throws(() => validateComponentMigrationPlan({ ...plan, entries: [] }), /fingerprint/);
  assert.throws(() => validateComponentMigrationPlan(plan, { currentInputs: [] }), /inputs/);
  assert.deepEqual(plan, buildComponentMigrationPlan(f.source, f.target, f.manifest, { inputFiles: f.inputFiles, decisions: [f.decision] }));
});

test('missing response, stale bindings, duplicate approval, and missing provenance remain unresolved', () => {
  const f = fixture();
  for (const change of [{ userResponse: '' }, { inputs: f.decision.inputs.slice(1) }, { choice: 'reject' }, { at: 'invalid' }, { entityId: 'r1' }, { taskId: 'task-1' }]) {
    assert.equal(buildComponentMigrationPlan(f.source, f.target, f.manifest, { inputFiles: f.inputFiles, decisions: [{ ...f.decision, ...change }] }).approval.status, 'unresolved');
  }
  assert.equal(buildComponentMigrationPlan(f.source, f.target, f.manifest, { inputFiles: f.inputFiles, decisions: [f.decision, f.decision] }).approval.status, 'unresolved');
  assert.equal(buildComponentMigrationPlan(f.source, f.target, f.manifest, { decisions: [f.decision] }).approval.status, 'unresolved');
});

test('coverage joins configurations by stable rendering and variant rather than misleading names', () => {
  const f = fixture(), coverageReport = { schemaVersion: 1, captureIdentity: 'rendering-variant', requirements: [{ renderingId: 'r1', variantId: null, status: 'captured', examples: [{ route: '/', status: 'captured', consistencyStatus: 'warning', warnings: ['Source and captured parameters differ'] }] }], warnings: [] };
  const plan = buildComponentMigrationPlan(f.source, f.target, f.manifest, { coverageReport });
  assert.equal(plan.entries[0].sourceCoverageStatus, 'captured');
  assert.ok(plan.entries[0].warnings.includes('Source and captured parameters differ'));
  assert.equal(plan.entries[1].sourceCoverageStatus, 'mapping-only');
});

test('real discovery inventory preserves definition-only configurations in the mapping scope', () => {
  const source = realSourceFixture(), target = createTargetRenderingInventory({ targetInstance: 'new', renderings: [] });
  const manifest = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: [] };
  const plan = buildComponentMigrationPlan(source, target, manifest);
  assert.equal(plan.entries.length, source.requirements.length);
  assert.ok(plan.entries.some(e => e.key === 'runused:definition'));
  assert.ok(plan.entries.some(e => e.key === 'rused:variant:variantunused'));
});

test('CLI binds file bytes and downstream verification rebuilds approved actions and rejects revoked proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mapping-evidence-'));
  try {
    const f = fixture(), refs = [];
    for (const [role, value] of [['source', f.source], ['target', f.target], ['manifest', f.manifest]]) {
      const path = join(directory, `${role}.json`), bytes = `${JSON.stringify(value, null, 2)}\n`;
      writeFileSync(path, bytes); refs.push({ role, path, sha256: hash(bytes) });
    }
    const decisions = [{ ...f.decision, inputs: refs.map(({ role, ...ref }) => ref) }], decisionPath = join(directory, 'decisions.json');
    const decisionBytes = JSON.stringify(decisions); writeFileSync(decisionPath, decisionBytes);
    const args = refs.flatMap(r => [`--${r.role}`, r.path, `--${r.role}-sha256`, r.sha256]);
    args.push('--decisions', decisionPath, '--decisions-sha256', hash(decisionBytes), '--output-dir', join(directory, 'plan'));
    const sourceBefore = readFileSync(refs[0].path, 'utf8');
    const planPath = buildMigrationPlan(args), plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(verifyComponentMigrationPlanEvidence(plan).fingerprint, plan.fingerprint);
    assert.equal(readFileSync(refs[0].path, 'utf8'), sourceBefore);
    assert.throws(() => buildMigrationPlan(args), /fresh/);
    const altered = structuredClone(plan); altered.entries[0].action = 'disregard';
    const { fingerprint, ...body } = altered; altered.fingerprint = hash(JSON.stringify(body));
    assert.throws(() => verifyComponentMigrationPlanEvidence(altered), /does not match/);
    writeFileSync(decisionPath, JSON.stringify([{ ...decisions[0], choice: 'reject' }]));
    assert.throws(() => verifyComponentMigrationPlanEvidence(plan), /hash mismatch/);
    assert.throws(() => buildMigrationPlan(args.map(v => v === refs[0].sha256 ? hash('stale') : v)), /hash mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
