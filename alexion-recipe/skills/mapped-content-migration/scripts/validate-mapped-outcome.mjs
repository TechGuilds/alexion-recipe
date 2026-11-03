import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Ajv2020 from '../../cms-migration/scripts/lib/vendor/ajv.mjs';
import {
  readJSON,
  readArtifactJSON,
  scopedPath,
  hash,
  jsonBytes,
  freshDirectory,
  writeNewJSON,
  fail,
  isMain,
  errorReport,
} from './lib/files.mjs';
import { requireSchema } from './lib/schema.mjs';
import { canonical, canonicalItem } from './lib/target-state.mjs';
import { readExecutionState, assertExecutionAncestor } from './lib/execution-state.mjs';
import { expectedPost } from './lib/execution-guards.mjs';
import { transformContent } from './transform-content.mjs';
import { planContent } from './plan-content.mjs';
import { planReferences } from './plan-references.mjs';
import { verifyTarget } from './verify-target.mjs';
import { validateSnapshotFile } from './validate-snapshot.mjs';

const operations = JSON.parse(
  await readFile(new URL('../assets/workflow-operations.json', import.meta.url), 'utf8'),
);
const decisionSchema = JSON.parse(
  await readFile(
    new URL('../../cms-migration/assets/contracts/decision.schema.json', import.meta.url),
    'utf8',
  ),
);
const validateDecision = new Ajv2020({ strict: true, allErrors: true }).compile(decisionSchema);
const entityResultSchema = JSON.parse(
  await readFile(
    new URL('../../cms-migration/assets/contracts/entity-result.schema.json', import.meta.url),
    'utf8',
  ),
);
const validateEntityResult = new Ajv2020({ strict: true, allErrors: true }).compile(entityResultSchema);
const check = (condition, message) => {
  if (!condition) throw fail('mapped-outcome', 'evidence', message);
};
const sameFile = (a, b) => a.path === b.path && a.sha256 === b.sha256;
const fileSet = (files) =>
  canonical(files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
const itemEqual = (a, b) => a && b && canonical(canonicalItem(a)) === canonical(canonicalItem(b));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

async function fileBytes(base, descriptor) {
  requireSchema('file', { path: descriptor.path, sha256: descriptor.sha256 });
  const path = await scopedPath(base, descriptor.path),
    bytes = await readFile(path);
  check(hash(bytes) === descriptor.sha256, `Artifact hash differs: ${descriptor.path}`);
  return { path, sha256: descriptor.sha256 };
}

function explicitDecision(decision, packet, kind, choice, exactInputs = false) {
  check(validateDecision(decision), 'Decision does not satisfy the CMS decision contract');
  check(
    decision.kind === kind &&
      decision.choice === choice &&
      decision.scopeId === packet.scopeId &&
      (exactInputs
        ? decision.taskId === packet.task.id
        : !decision.taskId || decision.taskId === packet.task.id) &&
      decision.userResponse?.trim() &&
      Number.isFinite(Date.parse(decision.at)) &&
      Date.parse(decision.at) <= Date.now(),
    'Decision must contain an explicit current human response for this task and scope',
  );
  check(
    decision.inputs.length > 0 &&
      decision.inputs.every((d) => packet.inputs.some((i) => sameFile(i, d))) &&
      (!exactInputs || fileSet(decision.inputs) === fileSet(packet.inputs)),
    'Decision inputs differ from the current packet inputs',
  );
}

async function replay(operation, input, outputs, scopeId) {
  const root = await mkdtemp(join(tmpdir(), 'mapped-outcome-'));
  try {
    const directory = join(root, 'replay');
    const result = await {
      transform: transformContent,
      plan: planContent,
      'reference-plan': planReferences,
      audit: verifyTarget,
      approve: verifyTarget,
    }[operation](input.path, directory);
    check(result.ready === true, 'Canonical operation is blocked or not ready');
    const names = {
      itemPlan: 'item-plan.json',
      identityMap: 'proposed-identity-map.json',
      transformReport: 'transform-report.json',
      batchPlan: 'batch-plan.json',
      dryRun: 'dry-run.json',
      referenceReport: 'reference-report.json',
      verificationReport: 'verification-report.json',
    };
    for (const output of outputs.filter((o) => Object.hasOwn(names, o.role))) {
      const expected = await readJSON(join(directory, names[output.role]));
      check(expected.value.scopeId === scopeId, 'Operation scope differs from task packet');
      check(expected.sha256 === output.sha256, `Output differs from canonical operation: ${output.role}`);
    }
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function validateExecution(packet, roles, outputs) {
  const request = roles.executionInput.value;
  requireSchema('executionInput', request);
  const references = packet.mappedContent.operation === 'reference-execute';
  check(
    (request.operationKind ?? 'content') === (references ? 'references' : 'content'),
    'Execution operation kind differs from packet',
  );
  const originalPlan = await readArtifactJSON(dirname(roles.executionInput.path), request.batchPlan),
    plan = originalPlan.value;
  requireSchema('batchPlan', plan);
  check(
    plan.ready === true && plan.scopeId === packet.scopeId,
    'Execution requires a ready scoped batch plan',
  );
  const plannerInput = await readArtifactJSON(dirname(roles.executionInput.path), request.planInput);
  await replay(
    references ? 'reference-plan' : 'plan',
    plannerInput,
    [{ role: 'batchPlan', sha256: originalPlan.sha256 }],
    packet.scopeId,
  );
  const journalDirectory = dirname(roles.checkpoint.path),
    current = await readExecutionState(journalDirectory);
  const outputCheckpoint = outputs.find((o) => o.role === 'checkpoint'),
    checkpoint = outputCheckpoint.value;
  requireSchema('executionCheckpoint', roles.checkpoint.value);
  requireSchema('executionCheckpoint', checkpoint);
  check(
    /checkpoint-[^/]+\.json$/.test(outputCheckpoint.path),
    'Output checkpoint must identify an immutable journal snapshot',
  );
  await assertExecutionAncestor(journalDirectory, roles.checkpoint.sha256);
  await assertExecutionAncestor(journalDirectory, outputCheckpoint.sha256);
  // Both hashes lie on the same verified chain. Sequence order therefore proves
  // input -> output -> live head without rebasing a completed task's evidence.
  check(
    roles.checkpoint.value.sequence <= checkpoint.sequence,
    'Input checkpoint must be an ancestor of the output checkpoint',
  );
  check(
    checkpoint.scopeId === packet.scopeId &&
      checkpoint.targetInstanceId === plan.targetInstanceId &&
      checkpoint.database === plan.database &&
      checkpoint.rootPath === plan.targetRootPath,
    'Journal target differs from batch plan',
  );
  check(
    !checkpoint.active && !current.checkpoint.active,
    'Execution still has a reserved, submitted or unknown job',
  );
  check(
    ['operations', 'completedBatches'].every((key) =>
      checkpoint[key].every((row, index) => canonical(row) === canonical(current.checkpoint[key][index])),
    ),
    'Live journal does not preserve the completed output records',
  );
  const reviews = outputs.filter((o) => o.role === 'executionReview'),
    receipts = outputs.filter((o) => o.role === 'executionReceipt');
  if (plan.batches.length === 0) {
    check(
      reviews.length === 0 && receipts.length === 0,
      'An empty plan must not fabricate execution reviews or receipts',
    );
    check(
      request.batchId === undefined && request.approval === undefined && request.review === undefined,
      'An empty plan must omit batch selection and mutation approval',
    );
    check(
      roles.checkpoint.sha256 === outputCheckpoint.sha256,
      'An empty plan must retain the unchanged input checkpoint',
    );
    check(
      current.checkpoint.identities.every((i) => ['success', 'reused'].includes(i.status)),
      'A live identity has failed or partial effects',
    );
    const latest = new Map(current.checkpoint.operations.map((o) => [o.targetItemId.toLowerCase(), o]));
    check(
      [...latest.values()].every((o) => o.status === 'success'),
      'Latest target item operation is failed or incomplete',
    );
    check(
      (await readExecutionState(journalDirectory)).sha256 === current.sha256,
      'Journal changed during outcome validation',
    );
    return;
  }
  const receiptBindings = new Set();
  for (const review of reviews) {
    const core = review.value;
    requireSchema('executionReview', core);
    check(
      core.scopeId === packet.scopeId &&
        core.batchPlanSha256 === originalPlan.sha256 &&
        (core.operationKind ?? 'content') === (references ? 'references' : 'content') &&
        core.target.instanceId === checkpoint.targetInstanceId &&
        core.target.database === checkpoint.database &&
        core.target.rootPath === checkpoint.rootPath &&
        core.target.connectorId === checkpoint.connectorId,
      'Execution review scope, operation kind or plan differs',
    );
    check(
      plan.batches.some((b) => b.batchId === core.batchId),
      'Review batch does not belong to this plan',
    );
    await assertExecutionAncestor(journalDirectory, core.checkpointSha256);
    // A review may predate this task's input during verified historical reuse,
    // but it cannot refer to a state newer than the completed output snapshot.
    if (core.checkpointSha256 !== outputCheckpoint.sha256) {
      const sequence = checkpoint.sequence;
      let cursor = current.checkpoint,
        digest = current.sha256;
      while (digest !== core.checkpointSha256) {
        const previous = cursor.previousSha256,
          index = cursor.sequence - 1;
        const path =
          index === 0
            ? 'checkpoint-000000.json'
            : `checkpoint-${String(index).padStart(6, '0')}-${previous.slice(0, 12)}.json`;
        const artifact = await readArtifactJSON(journalDirectory, { path, sha256: previous });
        cursor = artifact.value;
        digest = artifact.sha256;
      }
      check(cursor.sequence <= sequence, 'Execution review checkpoint is newer than the completed output');
    }
    const batch = plan.batches.find((b) => b.batchId === core.batchId);
    for (const operation of core.operations) {
      const { expectedPost: post, ...planned } = operation;
      check(
        batch.operations.some((o) => canonical(o) === canonical(planned)),
        'Review operation differs from the approved batch',
      );
      const observation = core.guards.find((g) => g.lookup === 'id' && same(g.value, operation.targetItemId));
      check(
        observation && itemEqual(post, expectedPost(planned, observation, core.structuralLanguage)),
        'Reviewed expected post-state differs from planned writes and observed state',
      );
      const recorded = checkpoint.operations.findLast(
        (o) =>
          o.requestId === 'exec-' + review.sha256.slice(0, 24) &&
          o.operationId === operation.operationId &&
          o.batchPlanSha256 === originalPlan.sha256,
      );
      check(
        recorded?.status === 'success' && recorded.batchId === core.batchId && itemEqual(recorded.post, post),
        'Execution review has no matching successful journal request',
      );
    }
    for (const known of core.knownSuccess) {
      // Reference guards can include read-only dependencies with no ledger operation.
      const historical = checkpoint.operations.findLast(
        (o) => o.batchPlanSha256 === originalPlan.sha256 && o.operationId === known.operationId,
      );
      if (historical)
        check(
          historical.status === 'success' && itemEqual(historical.post, known.post),
          'Review reuse differs from journal',
        );
    }
    if (!core.operations.length) {
      check(
        batch.operations.every((o) => core.knownSuccess.some((k) => k.operationId === o.operationId)),
        'No-op review omits planned operations',
      );
    }
  }
  for (const receipt of receipts) {
    const r = receipt.value;
    requireSchema('executionReceipt', r);
    const review = reviews.find((v) => v.sha256 === r.reviewSha256),
      core = review?.value;
    check(
      core &&
        r.requestId === 'exec-' + review.sha256.slice(0, 24) &&
        r.scopeId === packet.scopeId &&
        r.taskId === core.taskId &&
        r.batchPlanSha256 === originalPlan.sha256 &&
        r.batchId === core.batchId &&
        canonical(r.target) === canonical(core.target),
      'Receipt is not bound to a supplied execution review',
    );
    check(
      r.terminal === true &&
        r.status === 'success' &&
        r.results.length === core.operations.length &&
        new Set(r.results.map((o) => o.operationId)).size === r.results.length,
      'Receipt must successfully cover every reviewed operation',
    );
    for (const [index, row] of r.results.entries()) {
      const operation = core.operations[index];
      check(
        row.operationId === operation.operationId &&
          row.status === 'success' &&
          same(row.targetItemId, operation.targetItemId) &&
          same(row.targetPath, operation.targetPath) &&
          same(row.templateId, operation.templateId) &&
          itemEqual(row.post, operation.expectedPost),
        'Receipt result differs from reviewed expected post-state',
      );
      const recorded = checkpoint.operations.findLast(
        (o) =>
          o.requestId === r.requestId &&
          o.batchPlanSha256 === r.batchPlanSha256 &&
          o.operationId === row.operationId,
      );
      check(
        recorded &&
          recorded.status === 'success' &&
          recorded.batchId === r.batchId &&
          itemEqual(recorded.post, row.post),
        'Receipt result differs from the actual journal',
      );
      const previous = roles.checkpoint.value.operations.some((o) => canonical(o) === canonical(recorded));
      check(
        previous || core.taskId === packet.task.id,
        'Historical approval cannot authorize new writes for another task',
      );
      receiptBindings.add(canonical(recorded));
    }
    check(
      r.reused.length === core.knownSuccess.length &&
        new Set(r.reused.map((o) => o.operationId)).size === r.reused.length &&
        r.reused.every((row) =>
          core.knownSuccess.some(
            (k) =>
              k.operationId === row.operationId &&
              same(k.targetItemId, row.targetItemId) &&
              itemEqual(k.post, row.post),
          ),
        ),
      'Receipt reuse differs from reviewed actual state',
    );
  }
  for (const batch of plan.batches) {
    check(
      checkpoint.completedBatches.some(
        (b) => b.batchPlanSha256 === originalPlan.sha256 && b.batchId === batch.batchId,
      ),
      'Batch has not completed in the current journal',
    );
    for (const operation of batch.operations) {
      const latest = checkpoint.operations.findLast(
        (o) => o.batchPlanSha256 === originalPlan.sha256 && o.operationId === operation.operationId,
      );
      check(
        latest?.status === 'success' &&
          latest.batchId === batch.batchId &&
          (latest.operationKind ?? 'content') === (references ? 'references' : 'content'),
        'Planned operation lacks a successful current journal result',
      );
      const physicalLatest = current.checkpoint.operations.findLast((o) =>
        same(o.targetItemId, operation.targetItemId),
      );
      check(physicalLatest?.status === 'success', 'Latest target item operation is failed or incomplete');
      check(
        reviews.some(
          (r) =>
            r.value.batchId === batch.batchId &&
            [...r.value.operations, ...r.value.knownSuccess].some(
              (o) => o.operationId === operation.operationId,
            ),
        ),
        'No review covers the completed operation',
      );
    }
  }
  const prior = new Set(roles.checkpoint.value.operations.map(canonical));
  for (const row of checkpoint.operations.filter(
    (o) => o.batchPlanSha256 === originalPlan.sha256 && o.status === 'success' && !prior.has(canonical(o)),
  ))
    check(
      receiptBindings.has(canonical(row)),
      'New journal successes require receipts bound to their reviews',
    );
  check(
    (await readExecutionState(journalDirectory)).sha256 === current.sha256,
    'Journal changed during outcome validation',
  );
}

/** Read-only postflight evidence. It never submits jobs or advances the workflow. */
export async function validateMappedOutcome(input, { base = process.cwd() } = {}) {
  requireSchema('mappedOutcomeInput', input);
  const packetArtifact = await readArtifactJSON(base, input.packet),
    packet = packetArtifact.value;
  const report = {
    version: 1,
    scopeId: packet.scopeId,
    taskId: packet.task?.id,
    operation: packet.mappedContent?.operation,
    valid: false,
    errors: [],
    inputs: packet.inputs,
    packet: input.packet,
    outputs: input.outputs,
    workflowAdvanced: false,
  };
  try {
    check(
      packet.kind === 'cms-migration-task-packet' &&
        packet.version === 1 &&
        packet.contentMigrationMode === 'mapped-content',
      'Require a mapped-content CMS task packet',
    );
    const definition = [...(operations.mediaTasks ?? []), ...operations.tasks].find((t) => t.operation === report.operation),
      mapped = packet.mappedContent;
    check(
      definition &&
        packet.task.id === definition.id &&
        packet.task.agent === definition.agent &&
        packet.task.phaseId === operations.phaseId,
      'Packet task does not match the canonical operation',
    );
    check(
      Array.isArray(packet.entities) &&
        packet.entities.length > 0 &&
        new Set(packet.entities.map((e) => e.id)).size === packet.entities.length &&
        packet.entities.every(
          (e) =>
            e.scope === 'included' &&
            e.kind === `mapped-content:${report.operation}` &&
            e.id === `mapped-content-operation:${packet.scopeId}:${report.operation}` &&
            e.source?.identity === report.operation,
        ),
      'Packet entities do not match the canonical mapped operation unit',
    );
    check(
      mapped.version === 1 &&
        mapped.procedure === `mapped-content-migration/${definition.procedure}` &&
        canonical(mapped.entryPoints) === canonical(definition.entryPoints) &&
        canonical(mapped.requiredOutputRoles) === canonical(definition.outputRoles) &&
        canonical(mapped.optionalOutputRoles ?? []) === canonical(definition.optionalOutputRoles ?? []),
      'Packet operation metadata differs from canonical definition',
    );
    check(
      Array.isArray(packet.inputs) &&
        packet.inputs.length > 0 &&
        new Set(packet.inputs.map((i) => i.path)).size === packet.inputs.length,
      'Packet inputs are missing or duplicated',
    );
    explicitDecision(packet.contentMigrationDecision, packet, 'scope', 'mapped-content');
    check(
      Array.isArray(mapped.inputRoles) &&
        mapped.inputRoles.length === definition.inputRoles.length &&
        new Set(mapped.inputRoles.map((i) => i.role)).size === mapped.inputRoles.length &&
        new Set(mapped.inputRoles.map((i) => i.path)).size === mapped.inputRoles.length &&
        definition.inputRoles.every((role) => mapped.inputRoles.some((i) => i.role === role)),
      'Packet input roles differ from canonical definition',
    );
    const roles = {};
    for (const descriptor of packet.inputs) await fileBytes(base, descriptor);
    for (const descriptor of mapped.inputRoles) {
      check(
        packet.inputs.some((i) => sameFile(i, descriptor)),
        'Role descriptor is absent from packet inputs',
      );
      check(
        descriptor.role !== 'checkpoint' || /checkpoint-[^/]+\.json$/.test(descriptor.path),
        'Checkpoint role must identify an immutable checkpoint',
      );
      roles[descriptor.role] = await readArtifactJSON(base, descriptor);
      if (roles[descriptor.role].value.scopeId !== undefined)
        check(
          roles[descriptor.role].value.scopeId === packet.scopeId,
          'Input role scope differs from packet',
        );
    }
    const allowed = [...definition.outputRoles, ...(definition.optionalOutputRoles ?? [])],
      outputRoles = input.outputs.map((o) => o.role);
    check(
      definition.outputRoles.every((role) => outputRoles.includes(role)) &&
        outputRoles.every((role) => allowed.includes(role)),
      'Missing required output roles or unexpected output role',
    );
    check(
      new Set(input.outputs.map((o) => o.path)).size === input.outputs.length &&
        outputRoles.every(
          (role) =>
            ['executionReview', 'executionReceipt'].includes(role) ||
            outputRoles.filter((r) => r === role).length === 1,
        ),
      'Duplicate output roles or paths',
    );
    const outputs = [];
    for (const descriptor of input.outputs) {
      const artifact = await readArtifactJSON(base, descriptor);
      if (artifact.value.scopeId !== undefined)
        check(artifact.value.scopeId === packet.scopeId, 'Output scope differs from packet');
      outputs.push({ ...descriptor, ...artifact });
    }
    if (['media-prepare', 'media-install'].includes(report.operation)) {
      const { validateMediaOutcome } = await import('./media-migration.mjs');
      await validateMediaOutcome(report.operation, roles, outputs, packet);
    } else if (report.operation === 'capture') {
      requireSchema('prepareSourceInput', roles.sourcePreparationInput.value);
      check(
        roles.sourcePreparationInput.value.scope.scopeId === packet.scopeId,
        'Source preparation scope differs from packet',
      );
      const result = await validateSnapshotFile(
          outputs.find((o) => o.role === 'snapshotManifest').path,
          roles.sourcePreparationInput.value.scope,
        ),
        coverage = outputs.find((o) => o.role === 'coverageReport').value;
      check(
        result.valid === true && result.ready === true && coverage.valid === true && coverage.ready === true,
        'Source coverage is not ready',
      );
      for (const key of Object.keys(result).filter((k) => !['valid', 'errors'].includes(k)))
        check(
          canonical(result[key]) === canonical(coverage[key]),
          `Coverage report differs from snapshot: ${key}`,
        );
    } else if (['execute', 'reference-execute'].includes(report.operation))
      await validateExecution(packet, roles, outputs);
    else {
      const role = {
        transform: 'transformInput',
        plan: 'planInput',
        'reference-plan': 'referencePlanInput',
        audit: 'verificationInput',
        approve: 'verificationInput',
      }[report.operation];
      if (['audit', 'approve', 'reference-plan'].includes(report.operation))
        check(
          sameFile(
            roles[role].value.checkpoint,
            mapped.inputRoles.find((r) => r.role === 'checkpoint'),
          ),
          'Operation checkpoint differs from packet checkpoint',
        );
      await replay(report.operation, roles[role], outputs, packet.scopeId);
      if (report.operation === 'approve') {
        check(
          outputs.find((o) => o.role === 'verificationReport').sha256 === roles.verificationReport.sha256,
          'Handoff must retain the exact audited verification report',
        );
        explicitDecision(
          outputs.find((o) => o.role === 'phaseDecision').value,
          packet,
          'phase-continuation',
          'approve',
          true,
        );
      }
    }
    for (const descriptor of [...packet.inputs, ...input.outputs]) await fileBytes(base, descriptor);
    await readArtifactJSON(base, input.packet);
    report.valid = true;
  } catch (error) {
    report.errors.push(
      error.code
        ? `${error.code}: ${error.message}`
        : 'Cannot read or validate the supplied operation evidence',
    );
  }
  return report;
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output')
      throw fail(
        'usage',
        'arguments',
        'Usage: node validate-mapped-outcome.mjs --input request.json --output NEW_DIRECTORY',
      );
    const inputPath = resolve(args[1]),
      input = await readJSON(inputPath),
      report = await validateMappedOutcome(input.value, { base: dirname(inputPath) });
    const output = await freshDirectory(args[3]);
    await writeNewJSON(join(output, 'mapped-outcome-report.json'), report);
    if (report.valid) {
      const packet = (await readArtifactJSON(dirname(inputPath), report.packet)).value;
      for (const entity of packet.entities) {
        const result = {
          version: 1,
          taskId: report.taskId,
          entityId: entity.id,
          outcome: 'success',
          summary: `Validated mapped-content ${report.operation} operation evidence`,
          changedFiles: [],
          checkpoint: null,
          checks: [
            {
              name: 'mapped-content-operation',
              passed: true,
              detail: `mapped-outcome-report.json SHA-256 ${hash(jsonBytes(report))}; technical evidence only; human verification remains required`,
            },
          ],
          decisionIds: [],
          unresolved: [],
        };
        check(validateEntityResult(result), 'Generated entity result does not satisfy the CMS contract');
        await writeNewJSON(join(output, `entity-result-${hash(entity.id).slice(0, 24)}.json`), result);
      }
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.valid ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
