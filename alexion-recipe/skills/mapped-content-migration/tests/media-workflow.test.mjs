import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContentWorkflow } from '../scripts/prepare-content-workflow.mjs';
import { hash, jsonBytes } from '../scripts/lib/files.mjs';
import { operationCatalog, packetMetadata } from '../scripts/workflow-provider.mjs';

async function fixture(t, choice = 'skip-media') {
  const base = await mkdtemp(join(tmpdir(), 'media-workflow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const put = async (path, value) => { const bytes = jsonBytes(value); await writeFile(join(base, path), bytes); return { path, sha256: hash(bytes) }; };
  const active = { version: 1, phases: [{ id: 'discovery', title: 'Discovery', tasks: [{ id: 'discovery.plan', title: 'Plan', dependsOn: [], status: 'running', agent: 'orchestrator' }] }] };
  const evidence = [await put('scope.json', { version: 1, scopeId: 'demo', source: { instanceId: 'source' }, target: { instanceId: 'target', deployment: 'XP' }, selectors: [{ path: '/sitecore/media library/demo', includeDescendants: true }] })];
  const decision = (choice, kind = 'scope') => ({ id: choice, kind, scopeId: 'demo', taskId: 'discovery.plan', choice, rationale: 'Reviewed scope', userResponse: 'Yes, use this choice', at: '2026-01-01T00:00:00Z', inputs: evidence });
  const input = { version: 1, scopeId: 'demo', planningTaskId: 'discovery.plan', evidence,
    activeWorkflow: await put('active.json', active), inventory: await put('inventory.json', { version: 1, scopeId: 'demo', entities: [] }), mappings: await put('mappings.json', []),
    modeDecision: await put('mode.json', decision('mapped-content')), mappingDecision: await put('mapping.json', decision('approve', 'mapping')), mediaDecision: await put('media.json', decision(choice)) };
  return { base, put, active, input, decision };
}

test('media opt-in precedes capture in the same phase and binds the decision hash', async t => {
  const f = await fixture(t, 'migrate-media'), result = await buildContentWorkflow(f.input, { base: f.base });
  const tasks = result.proposal.phases.at(-1).tasks;
  assert.equal(tasks.length, 10);
  assert.deepEqual(tasks.slice(0, 3).map(t => t.id), ['content.media-prepare', 'content.media-install', 'content.capture']);
  for (const [index, task] of tasks.entries()) assert.deepEqual(task.dependsOn, [index ? tasks[index - 1].id : 'discovery.plan']);
  assert.deepEqual(result.report.media.decision, f.input.mediaDecision);
  assert.equal(result.report.media.skipped, false);
  assert.equal(result.inventory.entities.filter(e => e.kind.startsWith('mapped-content:media-')).length, 2);
});

test('explicit skip preserves all eight existing tasks and does not mutate source workflow', async t => {
  const f = await fixture(t), before = await readFile(join(f.base, 'active.json'));
  const result = await buildContentWorkflow(f.input, { base: f.base });
  assert.equal(result.proposal.phases.at(-1).tasks.length, 8);
  assert.equal(result.proposal.phases.at(-1).tasks[0].id, 'content.capture');
  assert.deepEqual(result.report.media, { decision: f.input.mediaDecision, choice: 'skip-media', skipped: true, taskIds: [] });
  assert.deepEqual(await readFile(join(f.base, 'active.json')), before);
});

test('missing, wrong, stale or nonhuman media decisions fail before a proposal', async t => {
  const f = await fixture(t);
  const missing = { ...f.input }; delete missing.mediaDecision;
  await assert.rejects(buildContentWorkflow(missing, { base: f.base }), /mediaDecision/);
  for (const change of [{ kind: 'mapping' }, { choice: 'approve' }, { taskId: 'other' }, { scopeId: 'other' }, { userResponse: ' ' }, { at: 'invalid' }, { at: '2999-01-01T00:00:00Z' }, { inputs: [] }, { inputs: [{ path: 'scope.json', sha256: '0'.repeat(64) }] }]) {
    const mediaDecision = await f.put('bad.json', { ...f.decision('skip-media'), ...change });
    await assert.rejects(buildContentWorkflow({ ...f.input, mediaDecision }, { base: f.base }));
  }
  const stale = await f.put('stale.json', f.decision('skip-media'));
  await writeFile(join(f.base, 'stale.json'), '{}');
  await assert.rejects(buildContentWorkflow({ ...f.input, mediaDecision: stale }, { base: f.base }), /SHA-256/);
});

test('media opt-in binds selected target evidence and rejects unrelated current evidence', async t => {
  const f = await fixture(t, 'migrate-media');
  const unrelated = await f.put('unrelated.json', { evidence: 'current' });
  const mediaDecision = await f.put('unscoped-media.json', { ...f.decision('migrate-media'), inputs: [unrelated] });
  await assert.rejects(buildContentWorkflow({ ...f.input, evidence: [unrelated], mediaDecision,
    modeDecision: await f.put('unscoped-mode.json', { ...f.decision('mapped-content'), inputs: [unrelated] }),
    mappingDecision: await f.put('unscoped-mapping.json', { ...f.decision('approve', 'mapping'), inputs: [unrelated] }) }, { base: f.base }), /target XP or XM/);
});

test('changing media choice cannot rewrite an active workflow or insert tasks into progressed content', async t => {
  for (const originalChoice of ['skip-media', 'migrate-media']) {
    const f = await fixture(t, originalChoice), first = await buildContentWorkflow(f.input, { base: f.base });
    const active = { ...first.proposal, phases: first.proposal.phases.map(p => ({ ...p, tasks: p.tasks.map(task => ({ ...task, status: task.id === 'discovery.plan' ? 'running' : 'pending' })) })) };
    active.phases.at(-1).tasks[0].status = 'done';
    const activeWorkflow = await f.put('progressed.json', active), mediaDecision = await f.put('changed.json', f.decision(originalChoice === 'skip-media' ? 'migrate-media' : 'skip-media'));
    const before = await readFile(join(f.base, 'progressed.json'));
    await assert.rejects(buildContentWorkflow({ ...f.input, activeWorkflow, inventory: await f.put('merged-inventory.json', first.inventory), mappings: await f.put('merged-mappings.json', first.mappings), mediaDecision }, { base: f.base }), /canonical structural resume/);
    assert.deepEqual(await readFile(join(f.base, 'progressed.json')), before);
    const resumed = await buildContentWorkflow({ ...f.input, activeWorkflow, inventory: await f.put('resume-inventory.json', first.inventory), mappings: await f.put('resume-mappings.json', first.mappings) }, { base: f.base });
    assert.deepEqual(resumed.proposal, first.proposal);
  }
});

test('media operations appear in provider catalog and bind exact packet roles', async () => {
  const catalog = await operationCatalog();
  assert.equal(catalog.tasks.length, 10);
  for (const definition of catalog.tasks.filter(t => t.operation.startsWith('media-'))) {
    const input = { scopeId: 'demo', inputs: [{ path: 'media.json', sha256: 'a'.repeat(64) }], mappedContentInputs: [{ role: definition.inputRoles[0], path: 'media.json', sha256: 'a'.repeat(64) }] };
    const entities = [{ id: `mapped-content-operation:demo:${definition.operation}`, kind: `mapped-content:${definition.operation}`, scope: 'included', source: { identity: definition.operation } }];
    const metadata = await packetMetadata(input, definition, { id: catalog.phaseId }, entities);
    assert.deepEqual(metadata.requiredOutputRoles, definition.outputRoles);
    assert.deepEqual(metadata.entryPoints, ['media-migration.mjs', 'media-package.ps1']);
    await assert.rejects(packetMetadata({ ...input, mappedContentInputs: [] }, definition, { id: catalog.phaseId }, entities), /roles/);
    await assert.rejects(packetMetadata({ ...input, mappedContentInputs: [{ ...input.mappedContentInputs[0], sha256: 'b'.repeat(64) }] }, definition, { id: catalog.phaseId }, entities), /bound/);
  }
});
