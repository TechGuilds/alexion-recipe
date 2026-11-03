import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareTaskPacket } from '../scripts/prepare-task-packet.mjs';
import { validateEvidence } from '../scripts/validate-evidence.mjs';
import { fixture as compositionFixture } from '../../presentation-composition/tests/fixture.mjs';

const catalog = JSON.parse(await readFile(new URL('../../presentation-composition/assets/workflow-operations.json', import.meta.url)));
function fixture(operation = 'compose') {
  const definition = catalog.tasks.find(item => item.operation === operation);
  const inputs = definition.inputRoles.map((role, i) => ({ path: `evidence/${role}.json`, sha256: String(i + 1).repeat(64) }));
  const entity = { id: `presentation-operation:demo:${operation}`, kind: `presentation:${operation}`, source: { identity: operation, path: `logical/${operation}` }, scope: 'included', parentIds: [], routeIds: [], joins: [], uncertainty: [] };
  return { scopeId: 'demo', taskId: definition.id, targetRoot: 'repos/site', attemptRoot: 'evidence/attempt-1',
    inventory: { version: 1, scopeId: 'demo', entities: [entity] },
    workflow: { version: 1, phases: [{ id: definition.phaseId, title: 'Presentation', tasks: [{ id: definition.id, title: 'Arbitrary caller wording', agent: definition.agent, status: 'pending', dependsOn: [] }] }] },
    mappings: [{ entityId: entity.id, taskId: definition.id, routeIds: [] }], inputs,
    presentationInputs: definition.inputRoles.map((role, i) => ({ role, ...inputs[i] })), acceptance: ['Domain evidence validates'] };
}

test('presentation dispatch derives every operation from catalog without a content mode decision', async () => {
  for (const definition of catalog.tasks) {
    const input = fixture(definition.operation), before = structuredClone(input);
    const packet = await prepareTaskPacket(input);
    assert.deepEqual(packet.presentation, { version: 1, operation: definition.operation, procedure: `presentation-composition/${definition.procedure}`, entryPoints: definition.entryPoints, inputRoles: input.presentationInputs, requiredOutputRoles: definition.outputRoles, optionalOutputRoles: definition.optionalOutputRoles ?? [] });
    assert.equal(packet.mappedContent, undefined);
    assert.deepEqual(input, before);
  }
});

test('presentation dispatch rejects spoofed task, entity, phase, worker, roles and paths', async () => {
  const changes = [
    i => { i.workflow.phases[0].tasks[0].agent = 'tester'; },
    i => { i.workflow.phases[0].id = 'other'; },
    i => { i.taskId = i.workflow.phases[0].tasks[0].id = i.mappings[0].taskId = 'other'; },
    i => { i.inventory.entities[0].kind = 'component'; },
    i => { i.inventory.entities[0].scope = 'excluded'; },
    i => { i.inventory.entities[0].source.identity = 'other'; },
    i => { i.inventory.entities[0].id = i.mappings[0].entityId = 'other'; },
    i => { delete i.presentationInputs; },
    i => { i.presentationInputs[0].role = 'previewInput'; },
    i => { i.presentationInputs[0].sha256 = 'f'.repeat(64); },
    i => { i.presentationInputs[0].path = i.inputs[0].path = '../spoof.json'; },
    i => { i.presentationInputs[0].path = i.inputs[0].path = 'C:/spoof.json'; },
    i => { i.presentationInputs[0].path = i.inputs[0].path = 'https://spoof.json'; },
    i => { i.presentationInputs.push({ ...i.presentationInputs[0] }); },
    i => { i.presentation = {}; },
  ];
  for (const change of changes) { const input = fixture(); change(input); await assert.rejects(prepareTaskPacket(input)); }
  const apply = fixture('apply');
  apply.presentationInputs.find(i => i.role === 'checkpoint').path = apply.inputs[2].path = 'journal/head.json';
  await assert.rejects(prepareTaskPacket(apply), /immutable/);
});

test('presentation metadata still dispatches when the approved prior content mode is mapped', async () => {
  const input = fixture();
  input.contentMigrationDecision = { id: 'mode', kind: 'scope', scopeId: 'demo', choice: 'mapped-content', rationale: 'Prior content migration', userResponse: 'Approve', at: '2026-01-01T00:00:00Z', inputs: input.inputs };
  assert.equal((await prepareTaskPacket(input)).presentation.operation, 'compose');
});

async function completedCompose(t) {
  const f = await compositionFixture(t), input = fixture();
  input.inputs = [f.inputRef]; input.presentationInputs = [{ role: 'compositionInput', ...f.inputRef }];
  const packet = await prepareTaskPacket(input), packetRef = await f.put('packet.json', packet);
  const { validatePresentationOutcome } = await import('../../presentation-composition/scripts/validate-presentation-outcome.mjs');
  const composed = await f.compose();
  const domain = await validatePresentationOutcome({ version: 1, packet: packetRef, outputs: [{ role: 'compositionPlan', ...composed.plan }] }, { base: f.base });
  assert.equal(domain.valid, true, JSON.stringify(domain.errors));
  const domainRef = await f.put('domain.json', domain);
  const entityRef = await f.put('entity.json', { version: 1, taskId: input.taskId, entityId: input.mappings[0].entityId, outcome: 'success', summary: 'Composed', changedFiles: [], checkpoint: null, checks: [{ name: 'Composition', passed: true }], decisionIds: [], unresolved: [] });
  const evidence = (kind, ref, extra = {}) => ({ kind, path: ref.path, role: 'target', scopeId: input.scopeId, provenance: { producer: 'validate-presentation-outcome.mjs', version: '1', sha256: ref.sha256, inputs: input.inputs }, observation: 'Domain outputs replayed', checks: [{ name: 'Replay', passed: true }], unresolved: [], ...extra });
  const result = { taskId: input.taskId, outcome: 'success', summary: 'Composed presentation', evidence: [evidence('presentation-operation', domainRef), evidence('entity-result', entityRef, { entityId: input.mappings[0].entityId })], changedFiles: [], checkpoint: null, unresolved: [] };
  const resultRef = await f.put('result.json', result);
  const decision = { id: 'human-compose', kind: 'verification', scopeId: 'demo', taskId: input.taskId, entityId: input.mappings[0].entityId, choice: 'verified', rationale: 'Reviewed composition', userResponse: 'Verified', at: '2026-01-01T00:00:00Z', inputs: [resultRef, domainRef, entityRef] };
  await f.put('decisions.json', [decision]);
  const evidenceInput = { workflow: input.workflow, scopeId: 'demo', inputs: input.inputs, results: ['result.json'], decisions: [decision], requiredTaskIds: [input.taskId], requiredEvidenceKindsByTask: { [input.taskId]: ['presentation-operation'] } };
  return { ...f, input, packet, packetRef, domain, domainRef, result, decision, evidenceInput, composed };
}

test('shared evidence validation replays actual presentation outputs and rejects forged reports', async t => {
  const f = await completedCompose(t);
  let report = await validateEvidence(f.evidenceInput, { base: f.base, taskScoped: true });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.entityAttestations[0].status, 'attested');
  for (const change of [d => { delete d.inputs; }, d => { d.scopeId = 'other'; }, d => { d.workflowAdvanced = true; }, d => { delete d.operation; }, d => { d.operation = 'preview'; }, d => { d.outputs = []; }]) {
    const value = structuredClone(f.domain); change(value);
    const ref = await f.put('domain.json', value); f.result.evidence[0].provenance.sha256 = ref.sha256; await f.put('result.json', f.result);
    report = await validateEvidence(f.evidenceInput, { base: f.base, taskScoped: true }); assert.equal(report.valid, false);
  }
  const original = await f.put('domain.json', f.domain); f.result.evidence[0].provenance.sha256 = original.sha256; await f.put('result.json', f.result);
  f.evidenceInput.workflow.phases[0].tasks[0].agent = 'tester';
  report = await validateEvidence(f.evidenceInput, { base: f.base, taskScoped: true }); assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => /current assigned task/.test(error)));
  f.evidenceInput.workflow.phases[0].tasks[0].agent = 'sitecore-developer';
  const forgedPlan = { ...f.composed.value, ready: false };
  const changedPlan = await f.put(f.composed.plan.path, forgedPlan);
  const changedReport = { ...f.domain, outputs: [{ role: 'compositionPlan', ...changedPlan }] };
  const changedRef = await f.put('domain.json', changedReport); f.result.evidence[0].provenance.sha256 = changedRef.sha256; await f.put('result.json', f.result);
  report = await validateEvidence(f.evidenceInput, { base: f.base, taskScoped: true }); assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => /Presentation operation outputs/.test(error)));
  await f.put(f.composed.plan.path, f.composed.value);
  const packet = structuredClone(f.packet); delete packet.presentation;
  const forgedPacketRef = await f.put('packet.json', packet);
  const forged = { ...f.domain, packet: forgedPacketRef };
  const ref = await f.put('domain.json', forged); f.result.evidence[0].provenance.sha256 = ref.sha256; await f.put('result.json', f.result);
  report = await validateEvidence(f.evidenceInput, { base: f.base, taskScoped: true }); assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => /Presentation operation outputs|presentation/i.test(error)));
});

test('prior presentation attempts replay actual evidence and retain current user attestations', async t => {
  const f = await completedCompose(t), preview = fixture('preview');
  const input = f.input;
  input.workflow.phases[0].tasks[0].status = 'done';
  const task = preview.workflow.phases[0].tasks[0]; task.dependsOn = [input.taskId]; input.workflow.phases[0].tasks.push(task);
  input.inventory.entities.push(preview.inventory.entities[0]); input.mappings.push(preview.mappings[0]);
  await f.put('workflow.json', input.workflow);
  const request = { workflowPath: 'workflow.json', decisionsPath: 'decisions.json', scopeId: 'demo', inputs: input.inputs, taskId: input.taskId, resultPath: 'result.json', requiredEvidenceKinds: ['presentation-operation', 'entity-result'] };
  input.priorTaskAttempts = [await f.put('postflight.json', request)];
  input.taskId = task.id; input.inputs = preview.inputs; input.presentationInputs = preview.presentationInputs;
  assert.equal((await prepareTaskPacket(input, { base: f.base })).presentation.operation, 'preview');
  await f.put('decisions.json', []);
  await assert.rejects(prepareTaskPacket(input, { base: f.base }), /No canonical next task.*waiting/);
  await f.put('decisions.json', [f.decision]);
  await f.put('postflight.json', { ...request, scopeId: 'other' });
  await assert.rejects(prepareTaskPacket(input, { base: f.base }), /Stale prior/);
  input.priorTaskAttempts = [await f.put('postflight.json', { ...request, requiredEvidenceKinds: ['entity-result'] })];
  await assert.rejects(prepareTaskPacket(input, { base: f.base }), /presentation-operation/);
  input.priorTaskAttempts = [await f.put('postflight.json', request)];
  await f.put('composition-input.json', { ...f.input, version: 1 });
  await assert.rejects(prepareTaskPacket(input, { base: f.base }), /validation failed/);
});

test('completed website verification requires prior attempts without any content mode decision', async () => {
  const input = fixture('final-approve'), website = fixture('website');
  website.workflow.phases[0].tasks[0].status = 'done';
  input.workflow.phases[0].tasks.unshift(website.workflow.phases[0].tasks[0]);
  input.inventory.entities.unshift(website.inventory.entities[0]); input.mappings.unshift(website.mappings[0]);
  await assert.rejects(prepareTaskPacket(input), /priorTaskAttempts/);
});

test('isolated CMS generic native packets remain dependency independent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-presentation-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../', import.meta.url), directory, { recursive: true });
  const { prepareTaskPacket: isolated } = await import(pathToFileURL(join(directory, 'scripts/prepare-task-packet.mjs')));
  const input = fixture(); delete input.presentationInputs;
  input.workflow.phases[0].id = 'components'; input.taskId = input.workflow.phases[0].tasks[0].id = input.mappings[0].taskId = 'components.migrate'; input.inventory.entities[0].kind = 'component';
  assert.equal((await isolated(input)).presentation, undefined);
  input.workflow.phases[0].id = 'verification';
  assert.equal((await isolated(input)).presentation, undefined);
});


test('final approval cannot bypass mandatory domain replay by omitting required evidence kinds', async t => {
  const f = await compositionFixture(t), input = fixture('final-approve'), entityId = input.mappings[0].entityId;
  input.workflow.phases[0].tasks[0].status = 'done';
  const inputs = [f.inputRef];
  const entity = await f.put('final-entity.json', { version: 1, taskId: input.taskId, entityId, outcome: 'success', summary: 'Claimed final success', changedFiles: [], checkpoint: null, checks: [{ name: 'Claimed pass', passed: true }], decisionIds: [], unresolved: [] });
  await f.put('final-result.json', { taskId: input.taskId, outcome: 'success', summary: 'Claimed final approval', evidence: [{ kind: 'entity-result', entityId, path: entity.path, role: 'target', scopeId: 'demo', provenance: { producer: 'fixture', version: '1', sha256: entity.sha256, inputs }, observation: 'Claimed success', checks: [{ name: 'Claimed pass', passed: true }], unresolved: [] }], changedFiles: [], checkpoint: null, unresolved: [] });
  const decision = { id: 'final-gate', kind: 'phase-continuation', scopeId: 'demo', taskId: input.taskId, choice: 'approve', rationale: 'Reviewed', userResponse: 'Approve', at: '2026-01-01T00:00:00Z', inputs };
  const report = await validateEvidence({ workflow: input.workflow, scopeId: 'demo', inputs, results: ['final-result.json'], decisions: [decision] }, { base: f.base });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => error.includes('Missing required evidence kind: presentation-operation')));
  assert.deepEqual(report.verifiedTaskIds, []);
});
