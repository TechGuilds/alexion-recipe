import { assertExclusiveContentTransfer } from './content-transfer-phases.mjs';
import { cli, digest, readScoped, validate, workflowProposalTasks, isMain } from './contracts.mjs';

const fingerprintKey = item => item.path + ':' + item.sha256;

async function verifiedBytes(reference, base) {
  const bytes = await readScoped(base, reference.path);
  if (digest(bytes) !== reference.sha256) throw new Error(reference.path + ': fingerprint mismatch');
  return bytes;
}

async function verifiedJSON(reference, base) {
  return JSON.parse(await verifiedBytes(reference, base));
}

export async function validateWorkflowPlan(input, { base }) {
  const errors = [];
  let proposal, tasks;
  try {
    await validate('validate-workflow-plan-input', input);
    const referencedPaths = [input.proposal, ...input.evidence].map(reference => reference.path);
    if (new Set(referencedPaths).size !== referencedPaths.length) throw new Error('Proposal and evidence paths must be distinct.');
    proposal = await verifiedJSON(input.proposal, base);
    tasks = await workflowProposalTasks(proposal);
    assertExclusiveContentTransfer(proposal);
    for (const evidence of input.evidence) await verifiedBytes(evidence, base);
  } catch (error) {
    return { valid: false, errors: [error.message], summary: { phases: 0, tasks: 0 } };
  }

  const expected = [input.proposal, ...input.evidence].map(fingerprintKey).sort();
  const current = input.decisions.filter(decision => decision.kind === 'workflow-plan' && decision.scopeId === input.scopeId);
  if (current.length !== 1) errors.push('Exactly one workflow-plan decision must match the current scope.');
  const decision = current[0];
  if (decision) {
    const actual = decision.inputs.map(fingerprintKey).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push('Workflow-plan approval must bind the exact current proposal and evidence fingerprints.');
    if (decision.choice !== 'approve') errors.push('Workflow-plan decision is not approved.');
    if (typeof decision.userResponse !== 'string' || !decision.userResponse.trim()) errors.push('Workflow-plan approval requires the user response.');
    if (typeof decision.at !== 'string' || Number.isNaN(Date.parse(decision.at))) errors.push('Workflow-plan approval requires a valid timestamp.');
  }
  return {
    valid: errors.length === 0,
    errors,
    approvedProposal: errors.length ? null : proposal,
    decisionId: errors.length ? null : decision.id,
    summary: { phases: proposal.phases.length, tasks: tasks.size, evidence: input.evidence.length },
  };
}

if (await isMain(import.meta.url)) await cli('validate-workflow-plan', validateWorkflowPlan);
