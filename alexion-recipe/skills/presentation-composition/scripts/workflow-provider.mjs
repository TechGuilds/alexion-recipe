import { readJSON, readScoped, unique, safeRelativePath } from '../../cms-migration/scripts/contracts.mjs';
import { signature } from '../../cms-migration/scripts/validate-evidence.mjs';

// Hooks used by cms-migration through the profile's operation-providers.json registry.

export const operationCatalog = () => readJSON(new URL('../assets/workflow-operations.json', import.meta.url));

export function completedTasks({ active, definitions }) {
  return active
    ? active.tasks.filter(task => task.status === 'done' && definitions.tasks.some(def => def.id === task.id && def.phaseId === active.id))
    : [];
}

export async function packetMetadata(input, task, phase, entities) {
  const definitions = await operationCatalog();
  const definition = definitions.tasks.find(candidate => candidate.id === task.id);
  if (!definition || task.agent !== definition.agent || phase.id !== definition.phaseId) throw new Error('Presentation task, assigned worker and phase must match the canonical operation');
  if (entities.length !== 1 || entities[0].scope !== 'included' || entities[0].kind !== `presentation:${definition.operation}` || entities[0].id !== `presentation-operation:${input.scopeId}:${definition.operation}` || entities[0].source.identity !== definition.operation) throw new Error('Presentation entity must match the canonical operation unit');
  const descriptors = input.presentationInputs;
  if (!descriptors) throw new Error('Presentation operation requires presentationInputs');
  unique(descriptors.map(item => item.role), 'presentation input roles');
  unique(descriptors.map(item => item.path), 'presentation input paths');
  if (descriptors.length !== definition.inputRoles.length || descriptors.some(item => !definition.inputRoles.includes(item.role))) throw new Error('Presentation input roles must exactly match the canonical operation');
  for (const descriptor of descriptors) {
    safeRelativePath(descriptor.path, 'presentation input path');
    if (/^[a-z][a-z\d+.-]*:/i.test(descriptor.path)) throw new Error('Unsafe presentation input path: ' + descriptor.path);
    if (!input.inputs.some(item => item.path === descriptor.path && item.sha256 === descriptor.sha256)) throw new Error('Presentation input role must be bound to current packet inputs: ' + descriptor.role);
    if (descriptor.role === 'checkpoint' && descriptor.path.split('/').at(-1).toLowerCase() === 'head.json') throw new Error('Presentation checkpoint must be an immutable file, not head.json');
  }
  return { version: 1, operation: definition.operation, procedure: 'presentation-composition/' + definition.procedure,
    entryPoints: [...definition.entryPoints], inputRoles: definition.inputRoles.map(role => ({ ...descriptors.find(item => item.role === role) })),
    requiredOutputRoles: [...definition.outputRoles], optionalOutputRoles: [...(definition.optionalOutputRoles ?? [])] };
}

// Canonical presentation operations always require actual domain replay, including
// the final gate, which has no later task whose prior-attempt frontier can catch it.
export async function requireReplay({ entries, errors, requiredEvidenceKindsByTask }) {
  {
    const definitions = await operationCatalog();
    for (const { phase, task } of entries) {
      const definition = definitions.tasks.find(item => item.id === task.id);
      if (!definition || definition.phaseId !== phase.id || definition.agent !== task.agent) errors.push('Presentation task does not match the canonical operation: ' + task.id);
      if (!requiredEvidenceKindsByTask.has(task.id)) requiredEvidenceKindsByTask.set(task.id, new Set());
      requiredEvidenceKindsByTask.get(task.id).add('presentation-operation');
    }
  }
}

export async function replayEvidence({ evidence, id, input, base, tasks }) {
  const stored = JSON.parse(await readScoped(base, evidence.path));
          if (stored.version !== 1 || stored.valid !== true || stored.workflowAdvanced !== false || stored.taskId !== id || stored.scopeId !== input.scopeId || !Array.isArray(stored.inputs) || signature(stored.inputs) !== signature(input.inputs)) throw new Error('Invalid presentation operation evidence: ' + evidence.path);
          // Replay actual operation outputs; the skill is optional for generic CMS consumers.
          const { validatePresentationOutcome } = await import('./validate-presentation-outcome.mjs');
          const checked = await validatePresentationOutcome({ version: 1, packet: stored.packet, outputs: stored.outputs }, { base });
          if (!checked.valid || checked.version !== 1 || checked.workflowAdvanced !== false || checked.taskId !== id || checked.scopeId !== input.scopeId || checked.operation !== stored.operation || signature(checked.inputs ?? []) !== signature(input.inputs)) throw new Error('Presentation operation outputs are stale, incomplete or invalid: ' + (checked.errors ?? []).join('; '));
          const packet = JSON.parse(await readScoped(base, stored.packet.path));
          const phase = input.workflow.phases.find(item => item.tasks.some(task => task.id === id));
          if (packet.task?.id !== id || packet.task.agent !== tasks.get(id).agent || packet.task.phaseId !== phase?.id) throw new Error('Presentation packet does not match the current assigned task and phase');
}
