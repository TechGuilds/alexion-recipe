import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPresentationWorkflow,
  preparePresentationWorkflow,
} from '../scripts/prepare-presentation-workflow.mjs';
import { hash, jsonBytes } from '../scripts/lib/common.mjs';
import { validateWorkflowPlan } from '../../cms-migration/scripts/validate-workflow-plan.mjs';
import { materializeApprovedWorkflow } from '../../cms-migration/scripts/materialize-approved-workflow.mjs';
import { nextWork } from '../../cms-migration/scripts/next-work.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'presentation-workflow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const put = async (path, value) => {
    const bytes = jsonBytes(value);
    await writeFile(join(base, path), bytes);
    return { path, sha256: hash(bytes) };
  };
  const active = {
    version: 1,
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        tasks: [
          { id: 'discovery.audit', title: 'Audit discovery', dependsOn: [], status: 'done' },
          {
            id: 'discovery.plan',
            title: 'Prepare evidence-led workflow proposal',
            dependsOn: ['discovery.audit'],
            status: 'running',
            agent: 'orchestrator',
          },
        ],
      },
      {
        id: 'content-migration',
        title: 'Content Migration',
        tasks: [
          {
            id: 'content.approve',
            title: 'Review content handoff',
            dependsOn: ['discovery.plan'],
            status: 'pending',
            agent: 'orchestrator',
          },
        ],
      },
    ],
  };
  const evidence = [await put('evidence.json', { approvedScope: 'synthetic definitions and mappings' })];
  const decision = {
    id: 'mapping-approved',
    kind: 'mapping',
    scopeId: 'demo',
    choice: 'approve',
    rationale: 'Reviewed mappings',
    userResponse: 'Approve mappings',
    at: '2026-01-01T00:00:00Z',
    inputs: evidence,
  };
  const inventory = {
    version: 1,
    scopeId: 'demo',
    entities: [
      {
        id: 'discovery-record',
        kind: 'discovery',
        source: { identity: 'original', path: evidence[0].path },
        scope: 'included',
        parentIds: [],
        routeIds: [],
        joins: [],
        uncertainty: [],
      },
    ],
  };
  const input = {
    version: 1,
    scopeId: 'demo',
    planningTaskId: 'discovery.plan',
    activeWorkflow: await put('active.json', active),
    inventory: await put('inventory.json', inventory),
    mappings: await put('mappings.json', [{ entityId: 'discovery-record', taskId: 'discovery.plan' }]),
    mappingDecision: await put('mapping-decision.json', decision),
    evidence,
    prerequisiteTaskIds: ['content.approve'],
  };
  return { base, put, active, input, decision, inventory };
}

test('proposal preserves scope and native state through plan approval, materialization and exact resume', async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.base, 'active.json'), 'utf8'),
    built = await buildPresentationWorkflow(f.input, { base: f.base });
  assert.equal(built.report.ready, true);
  assert.equal(built.report.workflowAdvanced, false);
  assert.equal(built.report.targetWrites, false);
  assert.equal(JSON.stringify(built.proposal).includes('"status"'), false);
  assert.deepEqual(
    built.proposal.phases.map((phase) => phase.id),
    ['discovery', 'content-migration', 'presentation-composition', 'verification'],
  );
  assert.deepEqual(built.proposal.phases[2].tasks[0].dependsOn, ['discovery.plan', 'content.approve']);
  assert.deepEqual(built.proposal.phases[3].tasks[0].dependsOn, ['presentation.approve']);
  assert.deepEqual(built.inventory.entities[0], f.inventory.entities[0]);
  assert.equal(built.inventory.entities.length, 9);
  const proposal = await f.put('proposal.json', built.proposal);
  const absent = await validateWorkflowPlan(
    { version: 1, scopeId: 'demo', proposal, evidence: f.input.evidence, decisions: [] },
    { base: f.base },
  );
  assert.equal(absent.valid, false);
  const approval = {
    ...f.decision,
    id: 'workflow-approved',
    kind: 'workflow-plan',
    inputs: [proposal, ...f.input.evidence],
  };
  const approved = await validateWorkflowPlan(
    { version: 1, scopeId: 'demo', proposal, evidence: f.input.evidence, decisions: [approval] },
    { base: f.base },
  );
  assert.equal(approved.valid, true);
  const materialized = await materializeApprovedWorkflow(
    { version: 1, proposal, activeWorkflow: f.input.activeWorkflow, planningTaskId: f.input.planningTaskId },
    { base: f.base },
  );
  assert.equal(materialized.workflow.phases[0].tasks[0].status, 'done');
  assert.equal(materialized.workflow.phases[2].tasks[0].status, 'pending');
  const next = await nextWork({
    workflow: materialized.workflow,
    inventory: built.inventory,
    mappings: built.mappings,
  });
  assert.equal(next.next.length, 0, 'Presentation cannot pass unfinished content prerequisite');
  const resumed = await buildPresentationWorkflow(
    {
      ...f.input,
      activeWorkflow: await f.put('resume.json', materialized.workflow),
      inventory: await f.put('resume-inventory.json', built.inventory),
      mappings: await f.put('resume-mappings.json', built.mappings),
    },
    { base: f.base },
  );
  assert.deepEqual(resumed.proposal, built.proposal);
  assert.deepEqual(resumed.inventory, built.inventory);
  assert.equal(await readFile(join(f.base, 'active.json'), 'utf8'), before);
});

test('proposal refuses stale decisions, collisions, conflicting conversion, skipped content and unsafe evidence', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { choice: 'reject' },
    { scopeId: 'other' },
    { userResponse: ' ' },
    { at: '2099-01-01T00:00:00Z' },
    { inputs: [] },
  ])
    await assert.rejects(
      buildPresentationWorkflow(
        { ...f.input, mappingDecision: await f.put('bad-decision.json', { ...f.decision, ...patch }) },
        { base: f.base },
      ),
      /approved mappings|invalid/,
    );
  await assert.rejects(
    buildPresentationWorkflow({ ...f.input, prerequisiteTaskIds: ['discovery.audit'] }, { base: f.base }),
    /content delivery prerequisite/,
  );
  const conflict = structuredClone(f.active);
  conflict.phases.push({
    id: 'sxa-conversion',
    title: 'SXA Conversion',
    tasks: [{ id: 'sxa.convert', title: 'Convert', dependsOn: ['content.approve'], status: 'pending' }],
  });
  await assert.rejects(
    buildPresentationWorkflow(
      { ...f.input, activeWorkflow: await f.put('conversion.json', conflict) },
      { base: f.base },
    ),
    /conflicts/,
  );
  const alias = structuredClone(f.active);
  alias.phases.push({
    id: 'website-checks',
    title: 'Verification',
    tasks: [{ id: 'website.manual', title: 'Check site', dependsOn: ['content.approve'], status: 'pending' }],
  });
  await assert.rejects(
    buildPresentationWorkflow(
      { ...f.input, activeWorkflow: await f.put('verification-alias.json', alias) },
      { base: f.base },
    ),
    /Conflicting/,
  );
  const skipped = structuredClone(f.active);
  skipped.phases[1].tasks[0].status = 'skipped';
  await assert.rejects(
    buildPresentationWorkflow(
      { ...f.input, activeWorkflow: await f.put('skipped.json', skipped) },
      { base: f.base },
    ),
    /non-skipped/,
  );
  const built = await buildPresentationWorkflow(f.input, { base: f.base }),
    collision = structuredClone(built.inventory);
  collision.entities.at(-1).kind = 'unrelated';
  await assert.rejects(
    buildPresentationWorkflow(
      { ...f.input, inventory: await f.put('collision.json', collision) },
      { base: f.base },
    ),
    /collision/,
  );
  await assert.rejects(
    buildPresentationWorkflow(
      { ...f.input, evidence: [{ path: '../outside.json', sha256: '0'.repeat(64) }] },
      { base: f.base },
    ),
    /relative|scoped|manifest/,
  );
  await writeFile(join(f.base, 'evidence.json'), '{}');
  await assert.rejects(buildPresentationWorkflow(f.input, { base: f.base }), /Stale/);
});

test('proposal publishes only fresh task evidence and exact output hashes', async (t) => {
  const f = await fixture(t),
    input = await f.put('request.json', f.input),
    output = join(f.base, 'proposal');
  const report = await preparePresentationWorkflow(join(f.base, input.path), output);
  for (const [name, key] of [
    ['workflow-proposal.json', 'proposalSha256'],
    ['inventory.json', 'inventorySha256'],
    ['task-mappings.json', 'mappingsSha256'],
  ])
    assert.equal(hash(await readFile(join(output, name))), report[key]);
  await assert.rejects(preparePresentationWorkflow(join(f.base, input.path), output), /exist/);
});
