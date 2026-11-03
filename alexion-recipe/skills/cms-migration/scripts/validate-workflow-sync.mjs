import { cli, digest, readScoped, validate, workflowProposalTasks, workflowTasks, unique, isMain } from './contracts.mjs';

async function verifiedJSON(reference, base) {
  const bytes = await readScoped(base, reference.path);
  if (digest(bytes) !== reference.sha256) throw new Error(reference.path + ': fingerprint mismatch');
  return JSON.parse(bytes);
}

const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;

export async function validateWorkflowSync(input, { base }) {
  const errors = [];
  let proposal, active, bindings;
  try {
    await validate('validate-workflow-sync-input', input);
    proposal = await verifiedJSON(input.proposal, base);
    active = await verifiedJSON(input.activeWorkflow, base);
    bindings = await verifiedJSON(input.bindings, base);
    await workflowProposalTasks(proposal);
    await workflowTasks(active);
    await validate('workflow-bindings', bindings);
  } catch (error) {
    return { valid: false, errors: [error.message], summary: { phases: 0, tasks: 0 } };
  }

  const activeStructure = {
    version: active.version,
    phases: active.phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      tasks: phase.tasks.map(({ status, ...task }) => task),
    })),
  };
  if (JSON.stringify(stable(activeStructure)) !== JSON.stringify(stable(proposal))) errors.push('Active workflow structure does not exactly match the approved proposal.');
  const phaseIds = proposal.phases.map(phase => phase.id);
  const taskIds = proposal.phases.flatMap(phase => phase.tasks.map(task => task.id));
  const boundPhaseIds = bindings.phases.map(phase => phase.workflowPhaseId);
  const boundEpicIds = bindings.phases.map(phase => phase.kajooEpicId);
  const boundTaskIds = bindings.phases.flatMap(phase => phase.tasks.map(task => task.workflowTaskId));
  try {
    unique(boundPhaseIds, 'bound workflow phase IDs');
    unique(boundEpicIds, 'bound Kajoo epic IDs');
    unique(boundTaskIds, 'bound workflow task IDs');
    unique(bindings.phases.flatMap(phase => phase.tasks.map(task => task.kajooTaskId)), 'bound Kajoo task IDs');
  } catch (error) { errors.push(error.message); }
  if (JSON.stringify([...boundPhaseIds].sort()) !== JSON.stringify([...phaseIds].sort())) errors.push('Bindings do not cover every approved workflow phase exactly once.');
  if (JSON.stringify([...boundTaskIds].sort()) !== JSON.stringify([...taskIds].sort())) errors.push('Bindings do not cover every approved workflow task exactly once.');
  if (JSON.stringify([...input.artifactPhaseIds].sort()) !== JSON.stringify([...boundEpicIds].sort())) errors.push('Migration Artifact phase IDs do not match the bound Kajoo epic IDs.');
  if (Number.isNaN(Date.parse(bindings.reconciledAt))) errors.push('Workflow bindings require a valid reconciliation timestamp.');
  return { valid: errors.length === 0, errors, summary: { phases: phaseIds.length, tasks: taskIds.length, artifactPhases: input.artifactPhaseIds.length } };
}

if (await isMain(import.meta.url)) await cli('validate-workflow-sync', validateWorkflowSync);
