import { assertExclusiveContentTransfer } from './content-transfer-phases.mjs';
import { isDeepStrictEqual } from 'node:util';
import { cli, digest, isMain, readScoped, safeRelativePath, unique, validate, workflowTasks } from './contracts.mjs';
import { loadProvider, providerRegistry } from './operation-providers.mjs';
import { nextWork } from './next-work.mjs';

const phaseMatches = (entry, phase) => !!phase && (entry.phaseSelectors ?? []).some(selector =>
  phase.id === selector.phaseId && (!selector.anyTaskId || phase.tasks.some(task => selector.anyTaskId.includes(task.id))));
const selectsWorkflow = (entry, { modeDecision, activePhase }) =>
  (!!entry.contentMode && modeDecision?.choice === entry.contentMode) || phaseMatches(entry, activePhase);
const hasEntityKind = (entry, entities) => !!entry.entityKindPrefix && entities.some(entity => entity.kind.startsWith(entry.entityKindPrefix));

function stableInputs(inputs) {
  unique(inputs.map(input => input.path), 'task input paths');
  return [...inputs].sort((left, right) => left.path.localeCompare(right.path));
}

async function priorTaskValidations(input, base, provider) {
  const definitions = await provider.module.operationCatalog();
  const evidenceKind = provider.entry.evidenceKind;
  const active = input.workflow.phases.find(phase => !phase.tasks.every(task => ['done', 'skipped'].includes(task.status)));
  const completed = provider.module.completedTasks({ active, definitions });
  const descriptors = input.priorTaskAttempts ?? [];
  unique(descriptors.map(item => item.path), 'prior task attempt paths');
  if (descriptors.length !== completed.length) throw new Error('Exactly one priorTaskAttempts request is required for each completed canonical operation task');
  if (descriptors.length && !base) throw new Error('Prior task attempts require the packet workspace base');
  const validations = [];
  for (const descriptor of descriptors) {
    const bytes = await readScoped(base, descriptor.path);
    if (digest(bytes) !== descriptor.sha256) throw new Error('Stale prior task attempt request: ' + descriptor.path);
    const request = await validate('validate-task-attempt-input', JSON.parse(bytes));
    const task = completed.find(candidate => candidate.id === request.taskId);
    const definition = definitions.tasks.find(candidate => candidate.id === request.taskId);
    if (!task || request.scopeId !== input.scopeId || task.agent !== definition.agent || !request.requiredEvidenceKinds?.includes(evidenceKind)) {
      throw new Error('Prior task attempt must name a completed canonical operation in the current scope with ' + evidenceKind + ' evidence');
    }
    if (validations.some(item => item.taskId === request.taskId)) throw new Error('Duplicate prior task attempt for task: ' + request.taskId);
    const currentWorkflow = await validate('workflow', JSON.parse(await readScoped(base, request.workflowPath)));
    if (!isDeepStrictEqual(currentWorkflow, input.workflow)) throw new Error('Prior task attempt workflow must match the current packet workflow');
    const { validateTaskAttempt } = await import('./validate-task-attempt.mjs');
    const report = await validateTaskAttempt(request, { options: { 'workspace-root': base } });
    if (!report.valid) throw new Error('Prior task attempt validation failed: ' + (report.errors ?? []).join('; '));
    validations.push({ taskId: request.taskId, validation: {
      valid: report.valid, inputs: report.inputs, inputFingerprint: report.inputFingerprint, entityAttestations: report.entityAttestations,
    } });
  }
  return validations;
}

/**
 * Builds a small, immutable dispatch handoff for the single task selected by
 * next-work. It deliberately packages references and hashes only: profile
 * instructions decide which domain evidence belongs in input.inputs.
 */
export async function prepareTaskPacket(input, { base } = {}) {
  await validate('prepare-task-packet-input', input);
  assertExclusiveContentTransfer(input.workflow);
  if (input.scopeId !== input.inventory.scopeId) throw new Error('Task packet scope does not match inventory scope');
  const { providers: entries, contentModes } = await providerRegistry();
  const modeDecision=input.contentMigrationDecision;
  if(modeDecision){
    const timestamp = Date.parse(modeDecision.at);
    if(modeDecision.kind!=='scope'||modeDecision.scopeId!==input.scopeId||(modeDecision.taskId&&modeDecision.taskId!==input.taskId)||!contentModes.includes(modeDecision.choice)||!modeDecision.userResponse?.trim()||!Number.isFinite(timestamp)||timestamp>Date.now()||!modeDecision.inputs.every(d=>input.inputs.some(i=>i.path===d.path&&i.sha256===d.sha256)))throw new Error('Content transfer method decision must be explicit, approved and bound to current task/scope inputs');
  }
  for (const entry of entries) {
    if (entry.inputsField && entry.contentMode && input[entry.inputsField] !== undefined && modeDecision?.choice !== entry.contentMode)
      throw new Error(`${entry.inputsField} requires an explicit content transfer method decision for ${entry.contentMode}`);
  }
  const activePhase = input.workflow.phases.find(phase => !phase.tasks.every(task => ['done', 'skipped'].includes(task.status)));
  const selected = entries.find(entry => selectsWorkflow(entry, { modeDecision, activePhase }));
  if (input.priorTaskAttempts !== undefined && !selected)
    throw new Error(entries.find(entry => entry.priorAttemptsError)?.priorAttemptsError ?? 'priorTaskAttempts requires an active operation provider workflow');
  const validationByTask = selected ? await priorTaskValidations(input, base, await loadProvider(selected)) : undefined;
  const recommendation = await nextWork({
    inventory: input.inventory,
    workflow: input.workflow,
    mappings: input.mappings,
    inputs: input.inputs,
    ...(input.validation ? { validation: input.validation } : {}),
    ...(validationByTask ? { validationByTask } : {}),
    ...(input.proceedWithoutHost ? { proceedWithoutHost: input.proceedWithoutHost } : {}),
  }, { options: { limit: 1 } });
  if (!recommendation.primary) throw new Error('No canonical next task is available: ' + recommendation.status);
  if (recommendation.primary.taskId !== input.taskId) {
    throw new Error(`Selected task ${input.taskId} is not the canonical next task; recommended ${recommendation.primary.taskId}`);
  }

  const tasks = await workflowTasks(input.workflow);
  const task = tasks.get(input.taskId);
  if (!task?.agent) throw new Error('Canonical next task does not name an assigned worker');
  const phase = input.workflow.phases.find(candidate => candidate.tasks.some(candidateTask => candidateTask.id === input.taskId));
  const byId = new Map(input.inventory.entities.map(entity => [entity.id, entity]));
  const entities = input.mappings
    .filter(mapping => mapping.taskId === input.taskId)
    .map(mapping => byId.get(mapping.entityId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!entities.length) throw new Error('Canonical next task has no mapped entities');
  for (const entry of entries) {
    if (entry.contentMode && hasEntityKind(entry, entities) && modeDecision?.choice !== entry.contentMode) throw new Error(entry.entityGuardError);
  }
  const claimant = entries.find(entry =>
    (entry.contentMode && modeDecision?.choice === entry.contentMode) ||
    (entry.inputsField && input[entry.inputsField] !== undefined) ||
    phaseMatches(entry, phase) || hasEntityKind(entry, entities));
  if (claimant) {
    for (const other of entries)
      if (other !== claimant && other.inputsField && input[other.inputsField] !== undefined) throw new Error(`${claimant.label} operations cannot carry ${other.inputsField}`);
  }
  const metadata = claimant ? await (await loadProvider(claimant)).module.packetMetadata(input, task, phase, entities) : undefined;

  return {
    valid: true,
    kind: 'cms-migration-task-packet',
    version: 1,
    scopeId: input.scopeId,
    ...(modeDecision?{contentMigrationMode:modeDecision.choice,contentMigrationDecision:modeDecision}:{}),
    ...(metadata ? { [claimant.packetKey]: metadata } : {}),
    ...(input.priorTaskAttempts ? { priorTaskAttempts: stableInputs(input.priorTaskAttempts) } : {}),
    task: { id: task.id, title: task.title, phaseId: phase.id, agent: task.agent },
    entities,
    inputs: stableInputs(input.inputs),
    target: {
      root: safeRelativePath(input.targetRoot, 'target root'),
      attemptRoot: safeRelativePath(input.attemptRoot, 'attempt root'),
    },
    acceptance: [...input.acceptance],
    summary: { taskId: task.id, phaseId: phase.id, entityCount: entities.length, inputCount: input.inputs.length },
  };
}

if (await isMain(import.meta.url)) await cli('prepare-task-packet', prepareTaskPacket);
