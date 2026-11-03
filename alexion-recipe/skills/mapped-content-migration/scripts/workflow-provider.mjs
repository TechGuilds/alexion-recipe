import { readJSON, readScoped, unique, safeRelativePath } from '../../cms-migration/scripts/contracts.mjs';
import { signature } from '../../cms-migration/scripts/validate-evidence.mjs';

// Hooks used by cms-migration through the profile's operation-providers.json registry.

export async function operationCatalog() {
  const catalog = await readJSON(new URL('../assets/workflow-operations.json', import.meta.url));
  return { ...catalog, tasks: [...(catalog.mediaTasks ?? []), ...catalog.tasks] };
}

export function completedTasks({ active, definitions }) {
  return active && active.id === definitions.phaseId
    ? active.tasks.filter(task => task.status === 'done' && definitions.tasks.some(def => def.id === task.id))
    : [];
}

export async function packetMetadata(input, task, phase, entities) {
  const definitions = await operationCatalog();
  const definition = definitions.tasks.find(candidate => entities.every(entity =>
    entity.scope === 'included' && entity.kind === `mapped-content:${candidate.operation}`));
  if (!definition) throw new Error('Mapped-content packet requires included entities of one supported operation');
  if (task.id !== definition.id || task.agent !== definition.agent || phase.id !== definitions.phaseId) {
    throw new Error('Mapped-content task, assigned worker and phase must match the canonical operation');
  }
  if (entities.length !== 1 || entities[0].id !== `mapped-content-operation:${input.scopeId}:${definition.operation}` || entities[0].source.identity !== definition.operation) throw new Error('Mapped-content entity must match the canonical operation unit from the approved proposal');
  const descriptors = input.mappedContentInputs;
  if (!descriptors) throw new Error('Mapped-content operation requires mappedContentInputs');
  unique(descriptors.map(item => item.role), 'mapped-content input roles');
  unique(descriptors.map(item => item.path), 'mapped-content input paths');
  if (descriptors.length !== definition.inputRoles.length || descriptors.some(item => !definition.inputRoles.includes(item.role))) {
    throw new Error('Mapped-content input roles must exactly match the canonical operation');
  }
  for (const descriptor of descriptors) {
    safeRelativePath(descriptor.path, 'mapped-content input path');
    if (/^[a-z][a-z\d+.-]*:/i.test(descriptor.path)) throw new Error('Unsafe mapped-content input path: ' + descriptor.path);
    if (!input.inputs.some(item => item.path === descriptor.path && item.sha256 === descriptor.sha256)) {
      throw new Error('Mapped-content input role must be bound to current packet inputs: ' + descriptor.role);
    }
    if (descriptor.role === 'checkpoint' && descriptor.path.split('/').at(-1).toLowerCase() === 'head.json') {
      throw new Error('Mapped-content checkpoint must be an immutable file, not head.json');
    }
  }
  return {
    version: 1,
    operation: definition.operation,
    procedure: 'mapped-content-migration/' + definition.procedure,
    entryPoints: [...definition.entryPoints],
    inputRoles: definition.inputRoles.map(role => ({ ...descriptors.find(item => item.role === role) })),
    requiredOutputRoles: [...definition.outputRoles],
    optionalOutputRoles: [...(definition.optionalOutputRoles ?? [])],
  };
}

export async function replayEvidence({ evidence, id, input, base }) {
  const stored = JSON.parse(await readScoped(base, evidence.path));
          if (stored.version !== 1 || stored.valid !== true || stored.workflowAdvanced !== false || stored.taskId !== id || stored.scopeId !== input.scopeId) throw new Error('Invalid mapped-content operation evidence: ' + evidence.path);
          // Recheck domain outputs rather than accepting worker-authored "passed" flags.
          // Lazy loading keeps native/isolated CMS consumers independent of this optional skill.
          const { validateMappedOutcome } = await import('./validate-mapped-outcome.mjs');
          const checked = await validateMappedOutcome({ version: 1, packet: stored.packet, outputs: stored.outputs }, { base });
          if (!checked.valid || checked.taskId !== id || checked.scopeId !== input.scopeId || signature(checked.inputs) !== signature(input.inputs)) throw new Error('Mapped-content operation outputs are stale, incomplete or invalid: ' + (checked.errors ?? []).join('; '));
}
