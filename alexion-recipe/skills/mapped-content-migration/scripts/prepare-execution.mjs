import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireSchema } from './lib/schema.mjs';
import {
  readJSON,
  readArtifactJSON,
  hash,
  jsonBytes,
  normalizeId,
  fail,
  MAX_JSON_BYTES,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
} from './lib/files.mjs';
import { planContent } from './plan-content.mjs';
import { planReferences } from './plan-references.mjs';
import {
  readExecutionState,
  reserveExecution,
  transitionExecutionState,
  assertExecutionAncestor,
} from './lib/execution-state.mjs';
import { selectExecutionGuards, same, assertObservation } from './lib/execution-guards.mjs';
import { canonical, indexTargetState, queryKey } from './lib/target-state.mjs';
import { referenceKindForType } from './lib/field-compatibility.mjs';
import { identityKey, inside } from './lib/transform-paths.mjs';
import { validateInputFile } from './validate-inputs.mjs';

const bounded = (value) => {
  if (Buffer.byteLength(jsonBytes(value)) > MAX_JSON_BYTES)
    throw fail('execution-size', 'execution', 'Execution evidence exceeds 16 MiB; reduce approved scope');
  return value;
};
export async function writerSource() {
  return (
    (await readFile(new URL('./lib/target-common.ps1', import.meta.url), 'utf8')) +
    '\n' +
    (await readFile(new URL('./execute-target.ps1', import.meta.url), 'utf8'))
  );
}
export async function prepareExecution(inputPath, outputPath, stateDirectory) {
  const input = await readJSON(inputPath);
  requireSchema('executionInput', input.value);
  const request = input.value,
    base = dirname(inputPath);
  const references = request.operationKind === 'references';
  const names = [
    'planInput',
    'batchPlan',
    'dryRun',
    'targetState',
    'capabilities',
    ...(request.existingTargetState ? ['existingTargetState'] : []),
  ];
  const artifacts = {};
  for (const name of names) artifacts[name] = await readArtifactJSON(base, request[name]);
  const batchPlan = artifacts.batchPlan.value,
    dryRun = artifacts.dryRun.value,
    evidence = artifacts.targetState.value,
    cap = artifacts.capabilities.value;
  requireSchema('batchPlan', batchPlan);
  requireSchema('executionCapabilities', cap);
  if (!batchPlan.ready || !dryRun.ready || dryRun.batchPlanSha256 !== artifacts.batchPlan.sha256)
    throw fail('execution-plan', 'batchPlan', 'Require an exact ready reviewed dry-run and batch plan');
  const replayRoot = await mkdtemp(join(tmpdir(), 'mapped-plan-replay-'));
  let replayReport;
  try {
    const replay = await (references ? planReferences : planContent)(
      artifacts.planInput.path,
      join(replayRoot, 'plan'),
    );
    if (!replay.ready || replay.outputs.batchPlan.sha256 !== artifacts.batchPlan.sha256)
      throw fail('plan-binding', 'batchPlan', 'Batch plan differs from canonical planner output');
    replayReport = (await readJSON(join(replayRoot, 'plan/dry-run.json'))).value;
    if (
      canonical(replayReport.rows) !== canonical(dryRun.rows) ||
      canonical(replayReport.referenceDependencies) !== canonical(dryRun.referenceDependencies)
    )
      throw fail('plan-binding', 'dryRun', 'Reviewed rows differ from canonical planner output');
    if (references)
      for (const name of [
        'referenceUpdates',
        'referenceBindings',
        'referenceGuards',
        'identityCheckpointSha256',
      ])
        if (canonical(replayReport[name]) !== canonical(dryRun[name]))
          throw fail('plan-binding', name, 'Reference review differs from canonical planner output');
  } finally {
    await rm(replayRoot, { recursive: true, force: true });
  }
  const executionPlanInput = artifacts.planInput.value,
    planBase = dirname(artifacts.planInput.path);
  const original = references
    ? await readArtifactJSON(planBase, executionPlanInput.contentPlanInput)
    : artifacts.planInput;
  const planInput = original.value,
    contentBase = dirname(original.path);
  const baseline = await readArtifactJSON(planBase, executionPlanInput.targetState),
    map = await readArtifactJSON(contentBase, planInput.identityMap);
  const transform = await readArtifactJSON(contentBase, planInput.transformInput),
    migration = await readArtifactJSON(dirname(transform.path), transform.value.migrationInput);
  const inventory = await readArtifactJSON(dirname(migration.path), migration.value.targetInventory);
  const source = (await readArtifactJSON(dirname(migration.path), migration.value.sourceSnapshot)).value;
  if (!source.languages.includes(request.structuralLanguage))
    throw fail(
      'execution-language',
      'structuralLanguage',
      'Structural creation language must be explicitly included in the agreed source/target language scope',
    );
  if (
    source.instanceId === batchPlan.targetInstanceId &&
    source.database === batchPlan.database &&
    source.rootPaths.some(
      (path) => inside(path, batchPlan.targetRootPath) || inside(batchPlan.targetRootPath, path),
    )
  )
    throw fail(
      'source-overlap',
      'targetRootPath',
      'Same-instance source and target content roots must be disjoint',
    );
  for (const [key, wanted] of [
    ['scopeId', batchPlan.scopeId],
    ['instanceId', batchPlan.targetInstanceId],
    ['database', batchPlan.database],
    ['rootPath', batchPlan.targetRootPath],
  ])
    if (evidence[key] !== wanted || cap[key] !== wanted)
      throw fail('target-identity', key, 'Current target evidence/capability differs from plan scope');
  if (!batchPlan.targetRootPath.startsWith('/sitecore/content/'))
    throw fail(
      'target-root',
      'rootPath',
      'Writer supports content roots only, never template/rendering definitions',
    );
  if (cap.marker.path !== batchPlan.targetRootPath)
    throw fail('target-marker', 'marker', 'Capability marker must identify the exact approved target root');
  if (!Number.isFinite(Date.parse(cap.expiresAt)) || Date.parse(cap.expiresAt) <= Date.now())
    throw fail(
      'capability-expired',
      'capabilities',
      'Current verified target capability and exclusive write window are required',
    );
  for (const key of [
    'speRead',
    'speWrite',
    'fullItemBackup',
    'restoreValidated',
    'exclusiveWriteWindow',
    'fileDownload',
    'journalContinuityVerified',
  ])
    if (cap[key] !== true)
      throw fail('capability', key, 'Required target execution or recovery capability is not verified');
  await readArtifactJSON(dirname(artifacts.capabilities.path), cap.evidence);
  const journal = await readExecutionState(stateDirectory),
    checkpoint = journal.checkpoint;
  for (const [key, wanted] of [
    ['scopeId', batchPlan.scopeId],
    ['targetInstanceId', batchPlan.targetInstanceId],
    ['database', batchPlan.database],
    ['rootPath', batchPlan.targetRootPath],
    ['connectorId', cap.connectorId],
  ])
    if (checkpoint[key] !== wanted)
      throw fail('checkpoint-scope', key, 'Execution journal belongs to a different target/migration scope');
  if (checkpoint.active)
    throw fail(
      'pending-job',
      'checkpoint',
      'Reserved, submitted or unknown execution must be reconciled first',
    );
  const batch = batchPlan.batches.find((b) => b.batchId === request.batchId);
  if (!batch) throw fail('batch-selection', 'batchId', 'Select exactly one existing reviewed batch');
  const selected = selectExecutionGuards({
    batchPlan,
    dryRun,
    batch,
    evidence,
    baseline: baseline.value,
    checkpoint,
    marker: { ...cap.marker, structuralLanguage: request.structuralLanguage },
  });
  let referenceBindings, plannedReferenceGuards;
  if (references) {
    const ownerIds = new Set(batch.operations.map((o) => normalizeId(o.targetItemId))),
      neededIds = new Set(ownerIds);
    for (const update of dryRun.referenceUpdates.filter((r) =>
      ownerIds.has(normalizeId(r.owner.targetItemId)),
    ))
      for (const id of update.targetIds) neededIds.add(normalizeId(id));
    referenceBindings = dryRun.referenceBindings.filter((b) => neededIds.has(normalizeId(b.targetItemId)));
    plannedReferenceGuards = dryRun.referenceGuards.filter((g) => neededIds.has(normalizeId(g.item.id)));
    const originalCheckpoint = await readArtifactJSON(planBase, executionPlanInput.checkpoint);
    if (
      originalCheckpoint.value.connectorId !== checkpoint.connectorId ||
      originalCheckpoint.value.sequence > checkpoint.sequence
    )
      throw fail(
        'checkpoint-scope',
        'checkpoint',
        'Reference plan identity checkpoint is not compatible with the current journal',
      );
    await assertExecutionAncestor(stateDirectory, originalCheckpoint.sha256);
    const current = indexTargetState(evidence),
      outside = artifacts.existingTargetState?.value;
    let external;
    if (outside) {
      if (
        outside.rootPath !== '/sitecore' ||
        outside.instanceId !== evidence.instanceId ||
        outside.database !== evidence.database ||
        outside.scopeId !== evidence.scopeId
      )
        throw fail(
          'target-identity',
          'existingTargetState',
          'External reads must belong to this target and use read-only /sitecore root',
        );
      external = indexTargetState(outside);
    }
    for (const binding of referenceBindings) {
      if (binding.identity) {
        const prior = checkpoint.identities.find(
          (e) => identityKey(e.identity) === identityKey(binding.identity),
        );
        const previous = originalCheckpoint.value.identities.find(
          (e) => identityKey(e.identity) === identityKey(binding.identity),
        );
        if (
          prior
            ? !['success', 'reused'].includes(prior.status) ||
              canonical(prior.identity) !== canonical(binding.identity)
            : !!previous
        )
          throw fail(
            'identity-status',
            binding.targetPath,
            'Reference dependency is partial, failed, lost or changed',
          );
      }
    }
    const previous = checkpoint.operations.filter((o) => o.batchPlanSha256 === artifacts.batchPlan.sha256);
    for (const guard of plannedReferenceGuards) {
      const binding = referenceBindings.find(
        (b) =>
          same(b.targetItemId, guard.item.id) &&
          same(b.targetPath, guard.item.path) &&
          same(b.templateId, guard.item.templateId),
      );
      if (!binding) throw fail('reference-guard', 'dryRun', 'Reference guard has no approved binding');
      const key = queryKey(guard.lookup, guard.value),
        prior = previous.findLast((o) => same(o.targetItemId, binding.targetItemId));
      if (prior?.mutated && prior.status !== 'success')
        throw fail(
          'partial-effect',
          binding.targetPath,
          'Partial reference effects require a fresh plan and review',
        );
      const expected = prior?.status === 'success' ? { ...guard, item: prior.post } : guard;
      const actual = (binding.existing ? external : current)?.get(key);
      assertObservation(actual, expected, binding.targetPath);
      const existing = selected.guards.find((g) => queryKey(g.lookup, g.value) === key);
      if (!binding.existing && !existing) selected.guards.push(actual);
    }
    // Read-only verified dependencies use the existing reused-result receipt path.
    for (const binding of referenceBindings.filter(
      (b) =>
        b.identity &&
        !selected.operations.some((o) => same(o.targetItemId, b.targetItemId)) &&
        !selected.knownSuccess.some((o) => same(o.targetItemId, b.targetItemId)),
    )) {
      const post = current.get(queryKey('id', binding.targetItemId)).item;
      selected.knownSuccess.push({
        operationId: 'op-' + hash('reference-reuse|' + identityKey(binding.identity)).slice(0, 24),
        targetItemId: binding.targetItemId,
        targetPath: binding.targetPath,
        templateId: binding.templateId,
        post,
      });
    }
  }
  if (selected.operations.length > 100)
    throw fail('execution-size', 'batch', 'Writer supports at most 100 operations per reviewed request');
  const sourceIdentities = map.value.entries;
  for (const previous of checkpoint.identities) {
    const current = sourceIdentities.find((i) => identityKey(i) === identityKey(previous.identity));
    if (
      current &&
      (!same(current.targetItemId, previous.identity.targetItemId) ||
        !same(current.targetPath, previous.identity.targetPath))
    )
      throw fail(
        'identity-drift',
        'identityMap',
        'Previously verified identity changed; reconcile the mapping before another write',
      );
  }
  const ids = new Set(
    [...selected.operations, ...selected.knownSuccess].map((o) => normalizeId(o.targetItemId)),
  );
  const identities = sourceIdentities.filter((i) => ids.has(normalizeId(i.targetItemId)));
  const templateIds = new Set(selected.operations.map((o) => normalizeId(o.templateId)));
  const templates = inventory.value.templates.filter((t) => templateIds.has(normalizeId(t.id)));
  for (const operation of selected.operations) {
    const template = templates.find((t) => same(t.id, operation.templateId));
    if (!template || template.kind === 'branch' || template.kind === 'parameters')
      throw fail(
        'target-definition',
        operation.targetPath,
        'Writer needs an existing concrete item template',
      );
    for (const field of operation.fields) {
      const definition = template.fields.find((f) => same(f.id, field.fieldId));
      if (
        !definition ||
        definition.storage !== field.storage ||
        /^(?:blob|attachment|layout)$/i.test(definition.type) ||
        /^__(?:final\s*)?renderings$|^__(?:security|lock|workflow(?: state)?|created(?: by)?|updated(?: by)?)$/i.test(
          definition.name,
        )
      )
        throw fail(
          'unsupported-write',
          operation.targetPath,
          'Unsupported field, storage, binary, lifecycle or presentation write',
        );
    }
    if (
      references &&
      (operation.action !== 'update' ||
        operation.versionsToCreate.length ||
        operation.fields.some(
          (f) => !referenceKindForType(template.fields.find((d) => same(d.id, f.fieldId)).type),
        ))
    )
      throw fail(
        'reference-operation',
        operation.targetPath,
        'Reference batches only update supported reference fields on existing versions',
      );
  }
  const script = await writerSource();
  const referenceGuards = references
    ? plannedReferenceGuards.map((g) => {
        const prior = checkpoint.operations.findLast(
          (o) =>
            o.batchPlanSha256 === artifacts.batchPlan.sha256 &&
            same(o.targetItemId, g.item.id) &&
            o.status === 'success',
        );
        return prior ? { ...g, item: prior.post } : g;
      })
    : undefined;
  const core = bounded({
    version: 1,
    contentMigrationMode: 'mapped-content',
    ...(references ? { operationKind: 'references', referenceGuards, referenceBindings } : {}),
    scopeId: batchPlan.scopeId,
    mappingRevision: map.value.mappingRevision,
    taskId: request.taskId,
    batchPlanSha256: artifacts.batchPlan.sha256,
    batchId: batch.batchId,
    scriptSha256: hash(script),
    sourceInstanceId: batchPlan.sourceInstanceId,
    target: {
      instanceId: batchPlan.targetInstanceId,
      database: batchPlan.database,
      rootPath: batchPlan.targetRootPath,
      connectorId: cap.connectorId,
      marker: cap.marker,
    },
    structuralLanguage: request.structuralLanguage,
    maxBackupBytes: cap.maxBackupBytes,
    maxJournalBytes: cap.maxJournalBytes,
    maxRequestBytes: cap.maxRequestBytes,
    capabilities: cap,
    inputs: Object.fromEntries(names.map((n) => [n, request[n].sha256])),
    checkpointSha256: journal.sha256,
    ...selected,
    templates,
    identities,
  });
  requireSchema('executionReview', core);
  const reviewSha256 = hash(jsonBytes(core)),
    requestId = 'exec-' + reviewSha256.slice(0, 24);
  if (4096 + 4 * Buffer.byteLength(JSON.stringify(core)) > cap.maxJournalBytes)
    throw fail('journal-size', 'capabilities', 'Verified journal limit cannot contain this approved batch');
  const projected = {
    ...checkpoint,
    operations: [
      ...checkpoint.operations,
      ...selected.operations.map((o) => ({
        ...o,
        post: o.expectedPost,
        requestId,
        batchPlanSha256: core.batchPlanSha256,
        batchId: core.batchId,
      })),
    ],
    identities: [
      ...checkpoint.identities,
      ...identities.map((identity) => ({
        identity,
        status: 'success',
        requestId,
        batchPlanSha256: core.batchPlanSha256,
        mappingRevision: core.mappingRevision,
      })),
    ],
    completedBatches: [
      ...checkpoint.completedBatches,
      { batchPlanSha256: core.batchPlanSha256, batchId: core.batchId, requestId },
    ],
  };
  if (Buffer.byteLength(jsonBytes(projected)) > MAX_JSON_BYTES)
    throw fail(
      'checkpoint-size',
      'checkpoint',
      'Expected checkpoint growth exceeds supported scope; review smaller execution scope',
    );
  const output = await freshDirectory(outputPath);
  await writeNewJSON(join(output, 'execution-review.json'), core);
  if (!request.approval)
    return {
      ready: false,
      reviewReady: true,
      approvalRequired: true,
      requestId,
      review: { path: 'execution-review.json', sha256: reviewSha256 },
      operationCount: selected.operations.length,
      knownSuccessCount: selected.knownSuccess.length,
    };
  const approvedReview = await readArtifactJSON(base, request.review),
    approval = await readArtifactJSON(base, request.approval);
  requireSchema('executionDecision', approval.value);
  if (approvedReview.sha256 !== reviewSha256 || canonical(approvedReview.value) !== canonical(core))
    throw fail('review-drift', 'review', 'Execution inputs changed after review');
  const decision = approval.value;
  if (
    decision.kind !== 'mutation' ||
    decision.choice !== 'approve' ||
    decision.scopeId !== core.scopeId ||
    decision.taskId !== core.taskId ||
    !decision.userResponse?.trim() ||
    !Number.isFinite(Date.parse(decision.at)) ||
    Date.parse(decision.at) > Date.now() ||
    !decision.inputs.some((i) => i.sha256 === reviewSha256)
  )
    throw fail(
      'mutation-approval',
      'approval',
      'A current mutation decision must approve the exact execution review/task',
    );
  for (const name of names) await readArtifactJSON(base, request[name]);
  await readArtifactJSON(dirname(artifacts.capabilities.path), cap.evidence);
  await readArtifactJSON(base, request.approval);
  await readArtifactJSON(base, request.review);
  const revalidated = await validateInputFile(migration.path);
  if (!revalidated.valid)
    throw fail('execution-drift', 'migrationInput', 'Nested migration artifacts changed during preparation');
  if (references) {
    const checked = await readArtifactJSON(planBase, executionPlanInput.checkpoint);
    if (checked.sha256 !== dryRun.identityCheckpointSha256)
      throw fail('checkpoint-drift', 'checkpoint', 'Reference identity evidence changed');
    if (executionPlanInput.existingTargetState)
      await readArtifactJSON(planBase, executionPlanInput.existingTargetState);
    await readArtifactJSON(planBase, executionPlanInput.contentPlanInput);
  }
  if (hash(await writerSource()) !== core.scriptSha256 || (await readJSON(inputPath)).sha256 !== input.sha256)
    throw fail('execution-drift', 'input', 'Execution inputs or writer changed during preparation');
  if (!selected.operations.length)
    return {
      ready: true,
      alreadyCompleted: true,
      requestId,
      review: { path: 'execution-review.json', sha256: reviewSha256 },
      operationCount: 0,
    };
  const makeEnvelope = (reservation) => ({
    script,
    parameters: {
      Request: {
        version: 1,
        requestId,
        reviewSha256,
        reviewJson: jsonBytes(core),
        core,
        approval: decision,
        reservation,
      },
    },
    background: true,
    output: { mode: 'files' },
  });
  if (
    Buffer.byteLength(
      jsonBytes(makeEnvelope({ sequence: checkpoint.sequence + 1, checkpointSha256: '0'.repeat(64) })),
    ) > cap.maxRequestBytes
  )
    throw fail(
      'request-size',
      'request',
      'Complete connector envelope exceeds the verified request limit; reduce the approved batch',
    );
  const reservation = await reserveExecution(stateDirectory, journal.sha256, {
    requestId,
    reviewSha256,
    batchPlanSha256: core.batchPlanSha256,
    batchId: core.batchId,
    operationIds: selected.operations.map((o) => o.operationId),
  });
  const payload = {
    version: 1,
    requestId,
    reviewSha256,
    reviewJson: jsonBytes(core),
    core,
    approval: decision,
    reservation: { sequence: reservation.checkpoint.sequence, checkpointSha256: reservation.sha256 },
  };
  const envelope = { script, parameters: { Request: payload }, background: true, output: { mode: 'files' } };
  if (Buffer.byteLength(jsonBytes(envelope)) > cap.maxRequestBytes)
    throw fail(
      'request-size',
      'request',
      'Complete connector envelope exceeds the verified request limit; reservation remains blocked for review',
    );
  await writeNewJSON(join(output, 'target-request.json'), envelope);
  const envelopeSha256 = hash(jsonBytes(envelope));
  const registered = await transitionExecutionState(stateDirectory, reservation.sha256, (state) => {
    state.active.envelopeSha256 = envelopeSha256;
    return state;
  });
  return {
    ready: true,
    requiresDispatch: true,
    requestId,
    connectorId: cap.connectorId,
    review: { path: 'execution-review.json', sha256: reviewSha256 },
    request: { path: 'target-request.json', sha256: envelopeSha256 },
    checkpointSha256: registered.sha256,
    operationCount: core.operations.length,
  };
}
if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--input' || args[2] !== '--output' || args[4] !== '--state-dir')
      throw fail(
        'usage',
        'arguments',
        'Usage: node prepare-execution.mjs --input execution-input.json --output NEW_DIRECTORY --state-dir JOURNAL_DIRECTORY',
      );
    const result = await prepareExecution(args[1], args[3], args[5]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
