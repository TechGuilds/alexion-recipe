import { assertExclusiveContentTransfer, contentTransferPhases } from '../../cms-migration/scripts/content-transfer-phases.mjs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  readJSON,
  readArtifactJSON,
  hash,
  jsonBytes,
  fail,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
  scopedPath,
  MAX_JSON_BYTES,
} from './lib/files.mjs';
import { requireSchema } from './lib/schema.mjs';
import { validate, workflowTasks, workflowProposalTasks } from '../../cms-migration/scripts/contracts.mjs';

const fingerprint = (ref) => ref.path + ':' + ref.sha256;
const shape = (task) => Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'status'));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Builds a status-free proposal. Approval, materialization and synchronization stay external. */
export async function buildContentWorkflow(input, { base }) {
  requireSchema('workflowInput', input);
  const descriptors = [
    input.activeWorkflow,
    input.inventory,
    input.mappings,
    input.modeDecision,
    input.mappingDecision,
    input.mediaDecision,
    ...input.evidence,
  ];
  const paths = new Map();
  for (const ref of descriptors) {
    if (paths.has(ref.path) && paths.get(ref.path) !== ref.sha256)
      throw fail('workflow-binding', ref.path, 'Conflicting fingerprints for one artifact');
    paths.set(ref.path, ref.sha256);
  }
  const read = async (ref) => (await readArtifactJSON(base, ref)).value;
  const active = await read(input.activeWorkflow),
    inventory = await read(input.inventory),
    mappings = await read(input.mappings);
  const tasks = await workflowTasks(active);
  await validate('inventory', inventory);
  if (inventory.scopeId !== input.scopeId)
    throw fail('workflow-scope', 'inventory', 'Inventory scope differs');
  if (!Array.isArray(mappings))
    throw fail('workflow-mappings', 'mappings', 'Expected an array of task mappings');
  for (const mapping of mappings) await validate('mapping', mapping);
  if (
    new Set(inventory.entities.map((e) => e.id)).size !== inventory.entities.length ||
    new Set(mappings.map((m) => m.entityId)).size !== mappings.length
  )
    throw fail('workflow-collision', 'inventory', 'Repeated entity or mapping identity');
  for (const mapping of mappings)
    if (!inventory.entities.some((e) => e.id === mapping.entityId) || !tasks.has(mapping.taskId))
      throw fail(
        'workflow-mappings',
        mapping.entityId,
        'Original mapping names an unknown entity or active task',
      );
  const evidence = new Set(input.evidence.map(fingerprint));
  if (evidence.size !== input.evidence.length)
    throw fail('workflow-evidence', 'evidence', 'Repeated evidence descriptor');
  for (const descriptor of input.evidence) await verifyBytes(base, descriptor);
  for (const [descriptor, kind, choice] of [
    [input.modeDecision, 'scope', 'mapped-content'],
    [input.mappingDecision, 'mapping', 'approve'],
  ]) {
    const decision = await read(descriptor);
    await validate('decision', decision);
    if (
      decision.kind !== kind ||
      decision.choice !== choice ||
      decision.scopeId !== input.scopeId ||
      !decision.userResponse?.trim() ||
      !Number.isFinite(Date.parse(decision.at)) ||
      Date.parse(decision.at) > Date.now()
    )
      throw fail(
        'workflow-decision',
        descriptor.path,
        'Expected a current explicit user decision for this scope',
      );
    if (
      !decision.inputs.length ||
      new Set(decision.inputs.map(fingerprint)).size !== decision.inputs.length ||
      decision.inputs.some((ref) => !evidence.has(fingerprint(ref)))
    )
      throw fail(
        'workflow-decision-inputs',
        descriptor.path,
        'Decision must bind a nonempty subset of the current evidence',
      );
  }
  const planning = tasks.get(input.planningTaskId);
  if (!planning)
    throw fail('workflow-planning', 'planningTaskId', 'Planning task is absent from the active workflow');
  const mediaDecision = await read(input.mediaDecision);
  await validate('decision', mediaDecision);
  if (
    mediaDecision.kind !== 'scope' ||
    !['migrate-media', 'skip-media'].includes(mediaDecision.choice) ||
    mediaDecision.scopeId !== input.scopeId ||
    mediaDecision.taskId !== input.planningTaskId ||
    !mediaDecision.userResponse?.trim() ||
    !Number.isFinite(Date.parse(mediaDecision.at)) ||
    Date.parse(mediaDecision.at) > Date.now()
  ) throw fail('workflow-media-decision', input.mediaDecision.path,
    'Expected an explicit current media decision for this scope and planning task');
  if (
    !mediaDecision.inputs.length ||
    new Set(mediaDecision.inputs.map(fingerprint)).size !== mediaDecision.inputs.length ||
    mediaDecision.inputs.some(ref => !evidence.has(fingerprint(ref)))
  ) throw fail('workflow-media-decision-inputs', input.mediaDecision.path,
    'Media decision must bind a nonempty subset of the current evidence');
  const migrateMedia = mediaDecision.choice === 'migrate-media';
  if (migrateMedia) {
    const mediaEvidence = await Promise.all(mediaDecision.inputs.map(read));
    if (!mediaEvidence.some(scope => scope.version === 1 && scope.scopeId === input.scopeId &&
      scope.source && scope.target && typeof scope.target.instanceId === 'string' &&
      scope.target.instanceId.trim() && ['XP', 'XM'].includes(scope.target.deployment) &&
      Array.isArray(scope.selectors) && scope.selectors.length > 0))
      throw fail('workflow-media-scope', input.mediaDecision.path,
        'Media opt-in must bind current media scope evidence selecting a target XP or XM instance');
  }
  for (const dependency of planning.dependsOn)
    if (!['done', 'skipped'].includes(tasks.get(dependency)?.status))
      throw fail('workflow-planning', dependency, 'Planning prerequisite is not terminal');
  for (const phase of active.phases)
    if (
      !['setup', 'discovery', 'content-migration'].includes(phase.id) &&
      /(?:code|sxa|resolver)/i.test(phase.id + ' ' + phase.title) &&
      phase.tasks.some((task) => task.status !== 'skipped')
    )
      throw fail(
        'workflow-conflict',
        phase.id,
        'Existing code, SXA or resolver scope conflicts with the no-code migration decision',
      );
  const operations = JSON.parse(
    await readFile(new URL('../assets/workflow-operations.json', import.meta.url), 'utf8'),
  );
  const selectedOperations = [...(migrateMedia ? operations.mediaTasks : []), ...operations.tasks];
  const content = {
    id: operations.phaseId,
    title: operations.phaseTitle,
    tasks: selectedOperations.map((op, index) => ({
      id: op.id,
      title: op.title,
      dependsOn: [index ? selectedOperations[index - 1].id : input.planningTaskId],
      agent: op.agent,
    })),
  };
  if (content.tasks.some((task) => task.id === input.planningTaskId))
    throw fail('workflow-planning', 'planningTaskId', 'Planning task cannot be a content operation');
  const proposal = {
    version: 1,
    phases: active.phases.map((phase) => ({ ...phase, tasks: phase.tasks.map(shape) })),
  };
  const existing = proposal.phases.find((phase) => phase.id === content.id);
  if (existing) {
    if (!equal(existing, content))
      throw fail(
        'workflow-resume',
        content.id,
        'Existing content phase is not the exact canonical structural resume',
      );
  } else proposal.phases.push(content);
  const existingTransfers = contentTransferPhases(active);
  if (existingTransfers.some(phase => phase.id !== content.id))
    throw fail('workflow-conflict', 'content-transfer', 'Existing content-transfer phase must be reviewed before adding the mapped content phase');
  assertExclusiveContentTransfer(proposal);
  await workflowProposalTasks(proposal);
  const mergedInventory = structuredClone(inventory),
    mergedMappings = structuredClone(mappings);
  for (const op of selectedOperations) {
    const entity = {
      id: `mapped-content-operation:${input.scopeId}:${op.operation}`,
      kind: `mapped-content:${op.operation}`,
      source: { identity: op.operation, path: op.operation.startsWith('media-') ? input.mediaDecision.path : input.modeDecision.path },
      scope: 'included',
      parentIds: [],
      routeIds: [],
      joins: [],
      uncertainty: [],
    };
    const mapping = { entityId: entity.id, taskId: op.id };
    const oldEntity = mergedInventory.entities.find((e) => e.id === entity.id),
      oldMapping = mergedMappings.find((m) => m.entityId === entity.id);
    if ((oldEntity && !equal(oldEntity, entity)) || (oldMapping && !equal(oldMapping, mapping)))
      throw fail('workflow-collision', entity.id, 'Unrelated operation identity collision');
    if (!oldEntity) mergedInventory.entities.push(entity);
    if (!oldMapping) mergedMappings.push(mapping);
  }
  const report = {
    version: 1,
    scopeId: input.scopeId,
    ready: true,
    proposalSha256: hash(jsonBytes(proposal)),
    inventorySha256: hash(jsonBytes(mergedInventory)),
    mappingsSha256: hash(jsonBytes(mergedMappings)),
    taskIds: selectedOperations.map((op) => op.id),
    requiredEvidenceKindsByTask: Object.fromEntries(
      selectedOperations.map((op) => [op.id, ['mapped-content-operation']]),
    ),
    noCodeMigration: true,
    media: {
      decision: { ...input.mediaDecision },
      choice: mediaDecision.choice,
      skipped: !migrateMedia,
      taskIds: migrateMedia ? operations.mediaTasks.map(op => op.id) : [],
    },
  };
  // Recheck all caller artifacts after construction and before publishing any output.
  for (const descriptor of descriptors) await verifyBytes(base, descriptor);
  return { proposal, inventory: mergedInventory, mappings: mergedMappings, report };
}

async function verifyBytes(base, descriptor) {
  const bytes = await readFile(await scopedPath(base, descriptor.path));
  if (bytes.length > MAX_JSON_BYTES || hash(bytes) !== descriptor.sha256)
    throw fail(
      'workflow-hash',
      descriptor.path,
      'Artifact differs from its declared SHA-256 or exceeds the byte limit',
    );
}

export async function prepareContentWorkflow(inputPath, outputPath) {
  const staged = await readJSON(inputPath),
    result = await buildContentWorkflow(staged.value, { base: dirname(inputPath) });
  if ((await readJSON(inputPath)).sha256 !== staged.sha256)
    throw fail('workflow-hash', 'input', 'Workflow input changed while preparing the proposal');
  const output = await freshDirectory(outputPath);
  for (const [name, value] of [
    ['workflow-proposal.json', result.proposal],
    ['inventory.json', result.inventory],
    ['task-mappings.json', result.mappings],
    ['integration-report.json', result.report],
  ])
    await writeNewJSON(join(output, name), value);
  return result.report;
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (
        !['--input', '--output'].includes(args[i]) ||
        options[args[i]] ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw fail('arguments', 'cli', 'Use --input staged.json --output fresh-directory');
      options[args[i]] = args[i + 1];
    }
    if (!options['--input'] || !options['--output'])
      throw fail('arguments', 'cli', 'Use --input staged.json --output fresh-directory');
    console.log(JSON.stringify(await prepareContentWorkflow(options['--input'], options['--output'])));
    process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error)));
    process.exitCode = 1;
  }
}
