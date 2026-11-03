import { assertExclusiveContentTransfer } from './content-transfer-phases.mjs';
import { cli, digest, readScoped, validate, workflowProposalTasks, workflowTasks, isMain } from './contracts.mjs';

async function verifiedJSON(reference, base) {
  const bytes = await readScoped(base, reference.path);
  if (digest(bytes) !== reference.sha256) throw new Error(reference.path + ': fingerprint mismatch');
  return JSON.parse(bytes);
}

const shape = task => Object.fromEntries(Object.entries({
  id: task.id,
  title: task.title,
  dependsOn: task.dependsOn,
  ...(task.optionalDependsOn ? { optionalDependsOn: task.optionalDependsOn } : {}),
  ...(task.agent ? { agent: task.agent } : {}),
}));

export async function materializeApprovedWorkflow(input, { base }) {
  const errors = [];
  let proposal, active, proposalTasks, activeTasks;
  try {
    await validate('materialize-approved-workflow-input', input);
    proposal = await verifiedJSON(input.proposal, base);
    active = await verifiedJSON(input.activeWorkflow, base);
    proposalTasks = await workflowProposalTasks(proposal);
    assertExclusiveContentTransfer(proposal);
    activeTasks = await workflowTasks(active);
  } catch (error) {
    return { valid: false, errors: [error.message], summary: { phases: 0, tasks: 0 } };
  }

  const planning = proposalTasks.get(input.planningTaskId);
  if (!planning) errors.push('Planning task is absent from the approved proposal.');
  if (!activeTasks.has(input.planningTaskId)) errors.push('Planning task is absent from the active workflow.');
  for (const [id, activeTask] of activeTasks) {
    const proposed = proposalTasks.get(id);
    if (!proposed) errors.push('Approved proposal removes existing active task: ' + id);
    else if (JSON.stringify(shape(activeTask)) !== JSON.stringify(shape(proposed))) errors.push('Approved proposal changes existing active task structure: ' + id);
  }
  if (planning) for (const dependency of planning.dependsOn) {
    const status = activeTasks.get(dependency)?.status;
    if (status !== 'done' && status !== 'skipped') errors.push('Planning task dependency is not terminal: ' + dependency);
  }
  if (errors.length) return { valid: false, errors, summary: { phases: proposal.phases.length, tasks: proposalTasks.size } };

  const workflow = {
    version: proposal.version,
    phases: proposal.phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      tasks: phase.tasks.map(task => ({
        ...task,
        status: task.id === input.planningTaskId ? 'done' : (activeTasks.get(task.id)?.status ?? 'pending'),
      })),
    })),
  };
  await workflowTasks(workflow);
  return {
    valid: true,
    errors: [],
    workflow,
    summary: { phases: workflow.phases.length, tasks: proposalTasks.size, planningTaskId: input.planningTaskId },
  };
}

if (await isMain(import.meta.url)) await cli('materialize-approved-workflow', materializeApprovedWorkflow);
