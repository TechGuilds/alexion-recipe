import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateWorkflowPlan } from '../scripts/validate-workflow-plan.mjs';
import { validateWorkflowSync } from '../scripts/validate-workflow-sync.mjs';
import { materializeApprovedWorkflow } from '../scripts/materialize-approved-workflow.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = t => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-workflow-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    writeFileSync(join(root, name), bytes);
    return { path: name, sha256: sha(bytes) };
  };
  return { root, put };
};

const proposal = () => ({ version: 1, phases: [
  { id: 'setup', title: '0 — Setup', tasks: [{ id: 'setup.audit', title: 'Audit Setup', dependsOn: [] }] },
  { id: 'discovery', title: '1 — Discovery', tasks: [
    { id: 'discovery.audit', title: 'Audit Discovery', dependsOn: ['setup.audit'] },
    { id: 'discovery.plan-workflow', title: 'Prepare evidence-led workflow proposal', dependsOn: ['discovery.audit'] },
  ] },
  { id: 'code-migration', title: '2 — Code Migration', tasks: [{ id: 'code.items', title: 'Migrate approved component batches', dependsOn: ['discovery.plan-workflow'] }] },
] });

const activeWorkflow = () => ({ version: 1, phases: [
  { id: 'setup', title: '0 — Setup', tasks: [{ id: 'setup.audit', title: 'Audit Setup', status: 'done', dependsOn: [] }] },
  { id: 'discovery', title: '1 — Discovery', tasks: [
    { id: 'discovery.audit', title: 'Audit Discovery', status: 'done', dependsOn: ['setup.audit'] },
    { id: 'discovery.plan-workflow', title: 'Prepare evidence-led workflow proposal', status: 'running', dependsOn: ['discovery.audit'] },
  ] },
] });

test('workflow-plan approval must bind the exact status-free proposal and complete current evidence set', async t => {
  const f = fixture(t), plan = f.put('proposal.json', proposal()), discovery = f.put('discovery-report.md', '# Discovery\n\nComplete evidence set.\n');
  const decision = { id: 'approve-plan', kind: 'workflow-plan', scopeId: 'acme:en', choice: 'approve', rationale: 'Reviewed full plan', userResponse: 'Approve', at: '2026-09-25T12:00:00Z', inputs: [plan, discovery] };
  const report = await validateWorkflowPlan({ version: 1, scopeId: 'acme:en', proposal: plan, evidence: [discovery], decisions: [decision] }, { base: f.root });
  assert.equal(report.valid, true);
  assert.equal(report.summary.phases, 3);
  assert.equal(report.summary.tasks, 4);

  const stale = structuredClone(decision); stale.inputs[0].sha256 = '0'.repeat(64);
  const invalid = await validateWorkflowPlan({ version: 1, scopeId: 'acme:en', proposal: plan, evidence: [discovery], decisions: [stale] }, { base: f.root });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' '), /exact current proposal and evidence fingerprints/i);

  const duplicated = await validateWorkflowPlan({ version: 1, scopeId: 'acme:en', proposal: plan, evidence: [plan], decisions: [decision] }, { base: f.root });
  assert.equal(duplicated.valid, false);
  assert.match(duplicated.errors.join(' '), /must be distinct/i);
});

test('approved proposal materializes active statuses and synchronization validates structure', async t => {
  const f = fixture(t), approvedProposal = f.put('proposal.json', proposal()), currentActive = f.put('active.json', activeWorkflow());
  const materialized = await materializeApprovedWorkflow({ version: 1, proposal: approvedProposal, activeWorkflow: currentActive, planningTaskId: 'discovery.plan-workflow' }, { base: f.root });
  assert.equal(materialized.valid, true);
  const planningTask = materialized.workflow.phases.find(phase => phase.id === 'discovery').tasks.find(task => task.id === 'discovery.plan-workflow');
  const newTask = materialized.workflow.phases.find(phase => phase.id === 'code-migration').tasks[0];
  assert.equal(planningTask.status, 'done');
  assert.equal(newTask.status, 'pending');

  const promotedActive = f.put('promoted-active.json', materialized.workflow);
  const bindings = f.put('bindings.json', { version: 1, projectId: 'project-1', reconciledAt: '2026-09-25T12:05:00Z', phases: [
    { workflowPhaseId: 'setup', kajooEpicId: 'epic-setup', tasks: [{ workflowTaskId: 'setup.audit', kajooTaskId: 'task-setup-audit' }] },
    { workflowPhaseId: 'discovery', kajooEpicId: 'epic-discovery', tasks: [
      { workflowTaskId: 'discovery.audit', kajooTaskId: 'task-discovery-audit' },
      { workflowTaskId: 'discovery.plan-workflow', kajooTaskId: 'task-discovery-plan-workflow' },
    ] },
    { workflowPhaseId: 'code-migration', kajooEpicId: 'epic-code', tasks: [{ workflowTaskId: 'code.items', kajooTaskId: 'task-code-items' }] },
  ] });
  const report = await validateWorkflowSync({ version: 1, proposal: approvedProposal, activeWorkflow: promotedActive, bindings, artifactPhaseIds: ['epic-setup', 'epic-discovery', 'epic-code'] }, { base: f.root });
  assert.equal(report.valid, true);

  const structurallyDifferent = structuredClone(materialized.workflow);
  structurallyDifferent.phases.find(phase => phase.id === 'code-migration').tasks[0].title = 'Unexpected task title';
  const mismatchedActive = f.put('mismatched-active.json', structurallyDifferent);
  const structureMismatch = await validateWorkflowSync({ version: 1, proposal: approvedProposal, activeWorkflow: mismatchedActive, bindings, artifactPhaseIds: ['epic-setup', 'epic-discovery', 'epic-code'] }, { base: f.root });
  assert.equal(structureMismatch.valid, false);
  assert.match(structureMismatch.errors.join(' '), /structure does not exactly match/i);

  const missing = await validateWorkflowSync({ version: 1, proposal: approvedProposal, activeWorkflow: promotedActive, bindings, artifactPhaseIds: ['epic-setup', 'epic-discovery'] }, { base: f.root });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(' '), /artifact phase ids/i);
});

test('decision input fingerprints cannot be empty', () => {
  const schema = JSON.parse(readFileSync(new URL('../assets/contracts/decision.schema.json', import.meta.url)));
  assert.equal(schema.properties.inputs.minItems, 1);
});
