import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validate, workflowTasks, workflowProposalTasks } from '../../cms-migration/scripts/contracts.mjs';
import {
  assertExclusiveContentTransfer,
  contentTransferPhases,
} from '../../cms-migration/scripts/content-transfer-phases.mjs';
import {
  requireSchema,
  readJSON,
  readArtifactJSON,
  unique,
  equal,
  hash,
  jsonBytes,
  publish,
  cli,
  isMain,
} from './lib/common.mjs';
import { scopedPath } from '../../cms-migration/scripts/lib/files.mjs';

const catalog = JSON.parse(
  await readFile(new URL('../assets/workflow-operations.json', import.meta.url), 'utf8'),
);
const shape = (task) => Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'status'));
const fingerprint = (ref) => ref.path + ':' + ref.sha256;

/** Prepare a local proposal; existing workflow approval and materialization own activation. */
export async function buildPresentationWorkflow(input, { base }) {
  requireSchema('workflowInput', input);
  const refs = [],
    read = async (descriptor) => {
      const artifact = await readArtifactJSON(base, descriptor);
      refs.push({ path: artifact.path, sha256: artifact.sha256 });
      return artifact.value;
    };
  const active = await read(input.activeWorkflow),
    inventory = await read(input.inventory),
    mappings = await read(input.mappings);
  const tasks = await workflowTasks(active);
  assertExclusiveContentTransfer(active);
  await validate('inventory', inventory);
  if (inventory.scopeId !== input.scopeId || !Array.isArray(mappings))
    throw Error('Workflow inventory/mapping scope differs');
  unique(inventory.entities, (entity) => entity.id, 'inventory identity');
  unique(mappings, (mapping) => mapping.entityId, 'task mapping identity');
  for (const mapping of mappings) {
    await validate('mapping', mapping);
    if (!tasks.has(mapping.taskId) || !inventory.entities.some((entity) => entity.id === mapping.entityId))
      throw Error('Existing mapping names an unknown task/entity');
  }
  const descriptors = [
      input.activeWorkflow,
      input.inventory,
      input.mappings,
      input.mappingDecision,
      ...input.evidence,
    ],
    hashes = new Map();
  for (const descriptor of descriptors) {
    if (hashes.has(descriptor.path) && hashes.get(descriptor.path) !== descriptor.sha256)
      throw Error('Conflicting evidence hashes');
    hashes.set(descriptor.path, descriptor.sha256);
  }
  unique(input.evidence, fingerprint, 'workflow evidence');
  for (const descriptor of input.evidence) {
    const path = await scopedPath(base, descriptor.path),
      bytes = await readFile(path);
    if (bytes.length > 16 * 1024 * 1024 || hash(bytes) !== descriptor.sha256)
      throw Error('Stale or oversized workflow evidence');
    refs.push({ path, sha256: descriptor.sha256 });
  }
  const decision = await read(input.mappingDecision);
  await validate('decision', decision);
  const evidence = new Set(input.evidence.map(fingerprint));
  if (
    decision.scopeId !== input.scopeId ||
    decision.kind !== 'mapping' ||
    decision.choice !== 'approve' ||
    !decision.userResponse?.trim() ||
    !Number.isFinite(Date.parse(decision.at)) ||
    Date.parse(decision.at) > Date.now() ||
    !decision.inputs.length ||
    decision.inputs.some((ref) => !evidence.has(fingerprint(ref)))
  )
    throw Error('Require explicit approved mappings bound to current evidence');
  unique(decision.inputs, fingerprint, 'mapping approval input');
  const planning = tasks.get(input.planningTaskId);
  if (!planning || planning.dependsOn.some((id) => !['done', 'skipped'].includes(tasks.get(id)?.status)))
    throw Error('Planning task or its completed prerequisites are missing');
  if (catalog.tasks.some((task) => task.id === input.planningTaskId))
    throw Error('Planning task cannot be a presentation operation');
  for (const id of input.prerequisiteTaskIds)
    if (!tasks.has(id) || tasks.get(id).status === 'skipped' || catalog.tasks.some((task) => task.id === id))
      throw Error('Presentation prerequisite must be an existing non-skipped delivery task');
  const content = contentTransferPhases(active);
  if (content.length !== 1 || !content[0].tasks.some((task) => input.prerequisiteTaskIds.includes(task.id)))
    throw Error('Select an existing content delivery prerequisite before presentation');
  const requiredContentTask = content[0].tasks.at(-1);
  if (!input.prerequisiteTaskIds.includes(requiredContentTask.id))
    throw Error('Presentation must depend on the final approved content handoff');
  for (const phase of active.phases)
    if (
      /(?:code[-_\s]*migration|sxa[-_\s]*conversion|resolver[-_\s]*adapters)/i.test(
        phase.id + ' ' + phase.title,
      ) &&
      phase.tasks.some((task) => task.status !== 'skipped')
    )
      throw Error(
        'Existing code/SXA conversion/resolver scope conflicts with this no-code presentation workflow; reconcile it explicitly',
      );
  const added = catalog.phases.map((phase) => ({
    ...phase,
    tasks: catalog.tasks
      .filter((task) => task.phaseId === phase.id)
      .map((task, index, phaseTasks) => ({
        id: task.id,
        title: task.title,
        agent: task.agent,
        dependsOn: index
          ? [phaseTasks[index - 1].id]
          : phase.id === 'presentation-composition'
            ? [...new Set([input.planningTaskId, ...input.prerequisiteTaskIds])]
            : ['presentation.approve'],
      })),
  }));
  const proposal = {
    version: 1,
    phases: active.phases.map((phase) => ({ ...phase, tasks: phase.tasks.map(shape) })),
  };
  for (const phase of added) {
    const existing = proposal.phases.find((candidate) => candidate.id === phase.id);
    if (existing && !equal(existing, phase))
      throw Error('Existing presentation/verification phase is not a canonical structural resume');
    if (!existing) {
      if (
        proposal.phases.some(
          (candidate) =>
            candidate.id !== phase.id &&
            ((phase.id === 'presentation-composition' &&
              /presentation[-_\s]*composition/i.test(candidate.id + ' ' + candidate.title)) ||
              (phase.id === 'verification' &&
                (/^(?:verification|final[-_\s]*verification)$/i.test(candidate.id) ||
                  /^(?:verification|final[-_\s]*verification)$/i.test(candidate.title)))),
        )
      )
        throw Error('Conflicting presentation/verification phase must be reconciled explicitly');
      proposal.phases.push(phase);
    }
  }
  await workflowProposalTasks(proposal);
  const mergedInventory = structuredClone(inventory),
    mergedMappings = structuredClone(mappings);
  for (const operation of catalog.tasks) {
    const entity = {
      id: `presentation-operation:${input.scopeId}:${operation.operation}`,
      kind: `presentation:${operation.operation}`,
      source: { identity: operation.operation, path: input.mappingDecision.path },
      scope: 'included',
      parentIds: [],
      routeIds: [],
      joins: [],
      uncertainty: [],
    };
    const mapping = { entityId: entity.id, taskId: operation.id },
      priorEntity = mergedInventory.entities.find((candidate) => candidate.id === entity.id),
      priorMapping = mergedMappings.find((candidate) => candidate.entityId === entity.id);
    if ((priorEntity && !equal(priorEntity, entity)) || (priorMapping && !equal(priorMapping, mapping)))
      throw Error('Presentation operation identity collision');
    if (!priorEntity) mergedInventory.entities.push(entity);
    if (!priorMapping) mergedMappings.push(mapping);
  }
  const report = {
    version: 1,
    scopeId: input.scopeId,
    ready: true,
    proposalSha256: hash(jsonBytes(proposal)),
    inventorySha256: hash(jsonBytes(mergedInventory)),
    mappingsSha256: hash(jsonBytes(mergedMappings)),
    taskIds: catalog.tasks.map((task) => task.id),
    requiredEvidenceKindsByTask: Object.fromEntries(
      catalog.tasks.map((task) => [task.id, ['presentation-operation']]),
    ),
    workflowAdvanced: false,
    targetWrites: false,
    workflowPlanApprovalRequired: true,
    phaseContinuationRequired: true,
  };
  return { proposal, inventory: mergedInventory, mappings: mergedMappings, report, refs };
}

export async function preparePresentationWorkflow(inputPath, outputPath) {
  const staged = await readJSON(inputPath),
    result = await buildPresentationWorkflow(staged.value, { base: dirname(inputPath) });
  await publish(
    outputPath,
    {
      'workflow-proposal.json': result.proposal,
      'inventory.json': result.inventory,
      'task-mappings.json': result.mappings,
      'integration-report.json': result.report,
    },
    [...result.refs, { path: inputPath, sha256: staged.sha256 }],
  );
  return result.report;
}
if (isMain(import.meta.url)) await cli(preparePresentationWorkflow);
