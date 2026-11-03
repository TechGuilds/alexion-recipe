import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareTaskPacket } from '../../cms-migration/scripts/prepare-task-packet.mjs';
import { inputFingerprint, nextWork } from '../../cms-migration/scripts/next-work.mjs';
import { validateTaskAttempt } from '../../cms-migration/scripts/validate-task-attempt.mjs';
import { validateMappedOutcome } from '../scripts/validate-mapped-outcome.mjs';
import { setup } from './transform-fixture.mjs';
import { bytes, hash } from './fixture-factory.mjs';

const definitions = JSON.parse(await readFile(new URL('../assets/workflow-operations.json', import.meta.url), 'utf8'));
function fixture(operation = 'transform') {
  const def = definitions.tasks.find(item => item.operation === operation);
  const inputs = def.inputRoles.map((role, index) => ({ path: `evidence/${role}.json`, sha256: String(index + 1).repeat(64) }));
  return {
    scopeId: 'site:en', taskId: def.id, targetRoot: 'repos/site', attemptRoot: `evidence/${def.id}/attempt-1`,
    inventory: { version: 1, scopeId: 'site:en', entities: [{ id: `mapped-content-operation:site:en:${operation}`, kind: `mapped-content:${operation}`, source: { identity: operation, path: `/logical/${operation}` }, scope: 'included', parentIds: [], routeIds: [], joins: [], uncertainty: [] }] },
    workflow: { version: 1, phases: [{ id: definitions.phaseId, title: definitions.phaseTitle, tasks: [{ id: def.id, title: 'Caller wording cannot select commands', agent: def.agent, status: 'pending', dependsOn: [] }] }] },
    mappings: [{ entityId: `mapped-content-operation:site:en:${operation}`, taskId: def.id, routeIds: [] }], inputs,
    mappedContentInputs: def.inputRoles.map((role, index) => ({ role, ...inputs[index] })),
    contentMigrationDecision: { id: 'mode', kind: 'scope', scopeId: 'site:en', choice: 'mapped-content', rationale: 'Approved scope', userResponse: 'Approved', at: '2026-10-27T12:00:00Z', inputs: [inputs[0]] },
    acceptance: ['Operation evidence validates'],
  };
}

test('all eight operations route solely through canonical recipe metadata and bound role descriptors', async () => {
  for (const def of definitions.tasks) {
    const input = fixture(def.operation), before = structuredClone(input);
    input.mappedContentInputs.reverse(); before.mappedContentInputs.reverse();
    const packet = await prepareTaskPacket(input);
    assert.deepEqual(packet.mappedContent, { version: 1, operation: def.operation, procedure: `mapped-content-migration/${def.procedure}`, entryPoints: def.entryPoints, inputRoles: def.inputRoles.map(role => input.mappedContentInputs.find(item => item.role === role)), requiredOutputRoles: def.outputRoles, optionalOutputRoles: def.optionalOutputRoles ?? [] });
    assert.deepEqual(input, before);
  }
});

test('mapped routing rejects operation, task, phase and assigned worker mismatches', async () => {
  const cases = [
    input => { input.inventory.entities[0].kind = 'component'; },
    input => { input.inventory.entities[0].kind = 'mapped-content:unknown'; },
    input => { input.inventory.entities[0].scope = 'excluded'; },
    input => { input.workflow.phases[0].id = 'content'; },
    input => { input.workflow.phases[0].tasks[0].agent = 'tester'; },
    input => { input.taskId = 'arbitrary'; input.workflow.phases[0].tasks[0].id = input.taskId; input.mappings[0].taskId = input.taskId; },
    input => { input.inventory.entities.push({ ...input.inventory.entities[0], id: 'other', kind: 'mapped-content:capture' }); input.mappings.push({ entityId: 'other', taskId: input.taskId, routeIds: [] }); },
  ];
  for (const mutate of cases) { const input = fixture(); mutate(input); await assert.rejects(prepareTaskPacket(input), /canonical operation|one supported operation/); }
});
test('mapped operation units cannot be dispatched through native mode or unsupported logical identities',async()=>{
 const native=fixture();native.contentMigrationDecision.choice='native-serialization';delete native.mappedContentInputs;await assert.rejects(prepareTaskPacket(native),/native dispatch cannot substitute/);
 const missing=fixture();delete missing.contentMigrationDecision;delete missing.mappedContentInputs;await assert.rejects(prepareTaskPacket(missing),/approved mapped-content workflow/);
 for(const change of [i=>i.inventory.entities[0].id='unrelated',i=>i.inventory.entities[0].source.identity='unrelated']){const i=fixture();change(i);if(i.inventory.entities[0].id==='unrelated')i.mappings[0].entityId='unrelated';await assert.rejects(prepareTaskPacket(i),/canonical operation unit/);}
});

test('required roles reject missing, unexpected, duplicate, stale, unbound and mutable-checkpoint metadata', async () => {
  const cases = [
    input => { delete input.mappedContentInputs; },
    input => { input.mappedContentInputs.pop(); },
    input => { input.mappedContentInputs[0].role = 'unrecognized'; },
    input => { input.mappedContentInputs.push({ ...input.mappedContentInputs[0] }); },
    input => { input.mappedContentInputs[0].sha256 = 'f'.repeat(64); },
    input => { input.mappedContentInputs[0].path = 'missing.json'; },
    input => { input.mappedContentInputs[1].path = input.mappedContentInputs[0].path; },
    input => { input.mappedContentInputs[1].path = 'journal/head.json'; input.inputs[1].path = 'journal/head.json'; },
    input => { input.mappedContentInputs[1].path = '../checkpoint.json'; input.inputs[1].path = '../checkpoint.json'; },
    input => { input.mappedContentInputs[1].path = 'C:/checkpoint.json'; input.inputs[1].path = 'C:/checkpoint.json'; },
    input => { input.inputs.push({ ...input.inputs[0] }); },
  ];
  for (const mutate of cases) { const input = fixture('execute'); mutate(input); await assert.rejects(prepareTaskPacket(input), /mappedContentInputs|roles|input|checkpoint/i); }
});

test('mode evidence must be current, scoped, explicit and approved before role routing', async () => {
  const cases = [
    input => { delete input.contentMigrationDecision; },
    input => { input.contentMigrationDecision.choice = 'native-serialization'; },
    input => { input.contentMigrationDecision.scopeId = 'other'; },
    input => { input.contentMigrationDecision.taskId = 'other'; },
    input => { input.contentMigrationDecision.userResponse = '   '; },
    input => { input.contentMigrationDecision.at = 'invalid'; },
    input => { input.contentMigrationDecision.at = '2999-01-01T00:00:00Z'; },
    input => { input.contentMigrationDecision.inputs = [{ path: 'old.json', sha256: 'a'.repeat(64) }]; },
  ];
  for (const mutate of cases) { const input = fixture(); mutate(input); await assert.rejects(prepareTaskPacket(input), /mode|decision/i); }
  for (const choice of [undefined, 'native-serialization']) {
    const input = fixture(); delete input.mappedContentInputs; input.priorTaskAttempts = [];
    if (choice) input.contentMigrationDecision.choice = choice; else delete input.contentMigrationDecision;
    await assert.rejects(prepareTaskPacket(input), /priorTaskAttempts requires/);
  }
});

test('packet routing preserves canonical next-work and current human-verification gates', async () => {
  const input = fixture();
  const upstream = { id: 'content.capture', title: 'Capture', status: 'pending', dependsOn: [], agent: 'sitecore-developer' };
  input.workflow.phases[0].tasks.unshift(upstream);
  input.workflow.phases[0].tasks[1].dependsOn = [upstream.id];
  input.inventory.entities.push({ ...input.inventory.entities[0], id: 'earlier', kind: 'mapped-content:capture' });
  input.mappings.push({ entityId: 'earlier', taskId: upstream.id, routeIds: [] });
  await assert.rejects(prepareTaskPacket(input), /not the canonical next task/);
  upstream.status = 'done';
  await assert.rejects(prepareTaskPacket(input), /priorTaskAttempts/);
  const fingerprint = inputFingerprint(input.inputs);
  input.validation = { valid: true, inputs: input.inputs, inputFingerprint: fingerprint, entityAttestations: [{ taskId: upstream.id, entityId: 'earlier', status: 'attested', fingerprint }] };
  await assert.rejects(prepareTaskPacket(input), /priorTaskAttempts/);
});

async function completedCapture() {
  const s = await setup();
  const descriptor = async path => ({ path, sha256: hash(await readFile(join(s.dir, path))) });
  const put = async (path, value) => { await writeFile(join(s.dir, path), bytes(value)); return descriptor(path); };
  const input = fixture('capture');
  input.scopeId = input.inventory.scopeId = input.contentMigrationDecision.scopeId = s.binding.scopeId;
  input.inventory.entities[0].id = `mapped-content-operation:${input.scopeId}:capture`;
  input.inventory.entities[0].source.identity = 'capture';
  input.mappings[0].entityId = input.inventory.entities[0].id;
  input.inputs = [await descriptor('prepare.json')];
  input.mappedContentInputs = [{ role: 'sourcePreparationInput', ...input.inputs[0] }];
  input.contentMigrationDecision.inputs = input.inputs;
  const packet = await prepareTaskPacket(input);
  const packetRef = await put('capture-packet.json', packet);
  const outputs = await Promise.all([['snapshotManifest', 'snapshot/source-snapshot.json'], ['coverageReport', 'snapshot/coverage.json']].map(async ([role, path]) => ({ role, ...await descriptor(path) })));
  const report = await validateMappedOutcome({ version: 1, packet: packetRef, outputs }, { base: s.dir });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  const reportRef = await put('capture-outcome.json', report);
  const entityRef = await put('capture-entity.json', { version: 1, taskId: input.taskId, entityId: input.mappings[0].entityId, outcome: 'success', summary: 'Captured and validated snapshot', changedFiles: [], checkpoint: null, checks: [{ name: 'source coverage', passed: true }], decisionIds: [], unresolved: [] });
  const evidence = (kind, ref, extra = {}) => ({ kind, path: ref.path, role: 'target', scopeId: input.scopeId, provenance: { producer: 'fixture', version: '1', sha256: ref.sha256, inputs: input.inputs }, observation: 'Reviewed operation evidence', checks: [{ name: 'valid', passed: true }], unresolved: [], ...extra });
  const result = { taskId: input.taskId, outcome: 'success', summary: 'Source coverage ready', evidence: [evidence('mapped-content-operation', reportRef), evidence('entity-result', entityRef, { entityId: input.mappings[0].entityId })], changedFiles: [], checkpoint: null, unresolved: [] };
  const resultRef = await put('capture-result.json', result);
  const decision = { id: 'human-capture', kind: 'verification', scopeId: input.scopeId, taskId: input.taskId, entityId: input.mappings[0].entityId, choice: 'verified', rationale: 'Reviewed source coverage', userResponse: 'Verified', at: '2026-10-27T12:00:00Z', inputs: [resultRef, reportRef, entityRef] };
  await put('decisions.json', [decision]);
  input.workflow.phases[0].tasks[0].status = 'done';
  const transform = definitions.tasks.find(item => item.operation === 'transform');
  input.workflow.phases[0].tasks.push({ id: transform.id, title: transform.title, agent: transform.agent, status: 'pending', dependsOn: [input.taskId] });
  input.inventory.entities.push({ ...input.inventory.entities[0], id: `mapped-content-operation:${input.scopeId}:transform`, kind: 'mapped-content:transform', source: { identity: 'transform', path: 'logical/transform' } });
  input.mappings.push({ entityId: input.inventory.entities[1].id, taskId: transform.id, routeIds: [] });
  await put('workflow.json', input.workflow);
  const request = { workflowPath: 'workflow.json', decisionsPath: 'decisions.json', scopeId: input.scopeId, inputs: input.inputs, taskId: input.taskId, resultPath: resultRef.path, requiredEvidenceKinds: ['mapped-content-operation', 'entity-result'] };
  const requestRef = await put('capture-postflight.json', request);
  const postflight = await validateTaskAttempt(request, { options: { 'workspace-root': s.dir } });
  assert.equal(postflight.valid, true, JSON.stringify(postflight.errors));
  assert.equal(postflight.entityAttestations[0].status, 'attested');
  input.taskId = transform.id;
  input.inputs = [await descriptor('transform.json')];
  input.mappedContentInputs = [{ role: 'transformInput', ...input.inputs[0] }];
  input.contentMigrationDecision.inputs = input.inputs;
  input.priorTaskAttempts = [requestRef];
  return { s, input, request, postflight, put, decision };
}

test('capture postflight and real human attestation unlock transform with different role inputs', async () => {
  const f = await completedCapture();
  try {
    assert.notEqual(inputFingerprint(f.input.inputs), f.postflight.inputFingerprint);
    assert.equal((await prepareTaskPacket(f.input, { base: f.s.dir })).mappedContent.operation, 'transform');
    await f.put('next-packet-input.json', f.input);
    const cli = fileURLToPath(new URL('../../cms-migration/scripts/prepare-task-packet.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [cli, '--input', join(f.s.dir, 'next-packet-input.json'), '--out', join(f.s.dir, 'next-packet.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(await readFile(join(f.s.dir, 'next-packet.json'), 'utf8')).mappedContent.operation, 'transform');
    const scoped = { ...f.input, validationByTask: [{ taskId: f.request.taskId, validation: f.postflight }] };
    assert.equal((await nextWork(scoped)).primary.taskId, 'content.transform');
    scoped.validationByTask[0].validation = { ...f.postflight, inputFingerprint: 'f'.repeat(64) };
    assert.equal((await nextWork(scoped)).primary, null);
    await assert.rejects(prepareTaskPacket({ ...f.input, validationByTask: [] }, { base: f.s.dir }), /unknown field validationByTask/);
    await f.put('decisions.json', []);
    await assert.rejects(prepareTaskPacket(f.input, { base: f.s.dir }), /No canonical next task.*waiting/);
    await f.put('decisions.json', [{ ...f.decision, inputs: [f.input.inputs[0]] }]);
    await assert.rejects(prepareTaskPacket(f.input, { base: f.s.dir }), /No canonical next task.*waiting/);
  } finally { await f.s.cleanup(); }
});

test('prior attempts reject stale files, duplicates, unrelated scopes/tasks and obsolete workflows', async () => {
  const f = await completedCapture();
  try {
    await assert.rejects(prepareTaskPacket(f.input), /workspace base/);
    for (const change of [
      request => { request.scopeId = 'other'; },
      request => { request.taskId = 'content.transform'; },
      request => { request.requiredEvidenceKinds = ['entity-result']; },
      request => { request.workflowPath = 'old-workflow.json'; },
    ]) {
      await f.put('old-workflow.json', fixture().workflow);
      const request = structuredClone(f.request); change(request);
      f.input.priorTaskAttempts = [await f.put('changed-request.json', request)];
      await assert.rejects(prepareTaskPacket(f.input, { base: f.s.dir }), /Prior task attempt/);
    }
    f.input.priorTaskAttempts = [await f.put('capture-postflight.json', f.request)];
    f.input.priorTaskAttempts.push(f.input.priorTaskAttempts[0]);
    await assert.rejects(prepareTaskPacket(f.input, { base: f.s.dir }), /Duplicate prior/);
    f.input.priorTaskAttempts.pop();
    await f.put('capture-postflight.json', { ...f.request, taskId: 'other' });
    await assert.rejects(prepareTaskPacket(f.input, { base: f.s.dir }), /Stale prior/);
    f.input.priorTaskAttempts = [await f.put('capture-postflight.json', f.request)];
    await writeFile(join(f.s.dir, 'prepare.json'), '{}');
    await assert.rejects(prepareTaskPacket(f.input, { base: f.s.dir }), /validation failed/);
  } finally { await f.s.cleanup(); }
});

test('an isolated CMS copy still produces native packets without mapped skill assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cms-native-packet-'));
  try {
    await cp(new URL('../../cms-migration/', import.meta.url), directory, { recursive: true });
    const { prepareTaskPacket: isolated } = await import(pathToFileURL(join(directory, 'scripts/prepare-task-packet.mjs')));
    const input = fixture(); delete input.mappedContentInputs;
    input.contentMigrationDecision.choice = 'native-serialization';
    input.inventory.entities[0].kind = 'component';
    const packet = await isolated(input);
    assert.equal(packet.contentMigrationMode, 'native-serialization');
    assert.equal(packet.mappedContent, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
