import { dirname } from 'node:path';
import { requireSchema } from './lib/schema.mjs';
import { readJSON, readArtifactJSON, hash, jsonBytes, fail, isMain, errorReport } from './lib/files.mjs';
import {
  initializeExecutionState,
  readExecutionState,
  transitionExecutionState,
} from './lib/execution-state.mjs';
import { canonical, canonicalItem } from './lib/target-state.mjs';
import { same } from './lib/execution-guards.mjs';
import { identityKey } from './lib/transform-paths.mjs';

function requireMatch(condition, message) {
  if (!condition) throw fail('execution-reconciliation', 'receipt', message);
}
function matchesItem(actual, expected) {
  return actual && canonical(canonicalItem(actual)) === canonical(canonicalItem(expected));
}
function fileRecord(file, prefix) {
  return (
    file &&
    typeof file.path === 'string' &&
    file.path.startsWith(prefix) &&
    !file.path.split('/').some((p) => p === '..' || p === '.') &&
    !/[\\\u0000-\u001f]/.test(file.path) &&
    /^[a-f0-9]{64}$/.test(file.sha256) &&
    Number.isSafeInteger(file.bytes) &&
    file.bytes > 0
  );
}

export async function recordExecution(inputPath, stateDirectory) {
  const input = await readJSON(inputPath),
    event = input.value;
  requireSchema('executionEvent', event);
  if (event.action === 'initialize') {
    const initialized = await initializeExecutionState(stateDirectory, event.scope);
    return {
      ready: true,
      state: 'initialized',
      checkpointSha256: initialized.sha256,
      sequence: initialized.checkpoint.sequence,
    };
  }
  const journal = await readExecutionState(stateDirectory),
    active = journal.checkpoint.active;
  requireMatch(
    event.checkpointSha256 === journal.sha256,
    'Reload the current checkpoint before recording an event',
  );
  requireMatch(active && active.requestId === event.requestId, 'Event does not identify the active request');
  requireMatch(
    event.connectorId === journal.checkpoint.connectorId,
    'Event belongs to a different connector',
  );
  if (active.jobId)
    requireMatch(
      !event.jobId || event.jobId === active.jobId,
      'A request cannot change its known remote job',
    );
  if (event.action === 'submitted' || event.action === 'unknown') {
    requireMatch(active.envelopeSha256, 'No durable executable envelope has been recorded');
    const next = await transitionExecutionState(stateDirectory, journal.sha256, (state) => {
      state.active.state = event.action;
      state.active.jobId = event.jobId ?? state.active.jobId;
      return state;
    });
    return {
      ready: true,
      requestId: active.requestId,
      state: next.checkpoint.active.state,
      checkpointSha256: next.sha256,
    };
  }
  requireMatch(
    event.action === 'terminal' && event.terminal === true && event.jobId,
    'A terminal connector job and durable receipt are required',
  );
  requireMatch(active.envelopeSha256, 'Request envelope was not durably recorded');
  const base = dirname(inputPath),
    review = await readArtifactJSON(base, event.review),
    receipt = await readArtifactJSON(base, event.receipt);
  const core = review.value,
    r = receipt.value;
  requireSchema('executionReview', core);
  requireSchema('executionReceipt', r);
  requireMatch(
    review.sha256 === active.reviewSha256 && hash(jsonBytes(core)) === active.reviewSha256,
    'Review bytes differ from the reserved request',
  );
  requireMatch(
    r.terminal === true &&
      r.requestId === active.requestId &&
      r.reviewSha256 === active.reviewSha256 &&
      r.scopeId === journal.checkpoint.scopeId &&
      r.taskId === core.taskId &&
      r.batchPlanSha256 === active.batchPlanSha256 &&
      r.batchId === active.batchId &&
      canonical(r.target) === canonical(core.target),
    'Receipt scope or request binding differs',
  );
  const remotePrefix =
    'kajoo/mapped-content/executions/' +
    hash(core.target.database.toLowerCase() + '|' + core.target.rootPath.toLowerCase()) +
    '/' +
    r.requestId +
    '/';
  requireMatch(
    fileRecord(r.journal, remotePrefix) && r.journal.path === remotePrefix + 'journal.jsonl',
    'Remote durable journal descriptor is invalid',
  );
  requireMatch(
    Array.isArray(r.results) &&
      r.results.length === core.operations.length &&
      new Set(r.results.map((o) => o.operationId)).size === r.results.length,
    'Receipt must report every requested operation exactly once',
  );
  requireMatch(
    Array.isArray(r.reused) &&
      r.reused.length <= core.knownSuccess.length &&
      (r.status !== 'success' || r.reused.length === core.knownSuccess.length) &&
      new Set(r.reused.map((o) => o.operationId)).size === r.reused.length,
    'Receipt must confirm reused dependencies without duplicates or omissions on success',
  );
  requireMatch(
    r.results.every((o, i) => o.operationId === core.operations[i].operationId),
    'Result order differs from approved dependency order',
  );
  let stopped = false;
  for (const row of r.results) {
    if (stopped)
      requireMatch(row.status === 'skipped', 'Only skipped results can follow a stopped operation');
    if (row.status !== 'success') stopped = true;
  }
  const bindings = [];
  for (const result of r.results) {
    const operation = core.operations.find((o) => o.operationId === result.operationId);
    requireMatch(
      operation &&
        same(result.targetItemId, operation.targetItemId) &&
        same(result.targetPath, operation.targetPath) &&
        same(result.templateId, operation.templateId),
      'Result identity differs from reviewed operation',
    );
    if (result.status === 'success')
      requireMatch(
        matchesItem(result.post, operation.expectedPost),
        'Successful result does not match reviewed values and versions',
      );
    if (result.status === 'skipped')
      requireMatch(
        result.mutated === false && !result.post,
        'Skipped result cannot claim a mutation or actual item',
      );
    if (result.post) {
      requireMatch(
        same(result.post.id, operation.targetItemId) &&
          same(result.post.path, operation.targetPath) &&
          same(result.post.templateId, operation.templateId),
        'Partial actual identity differs from reviewed target',
      );
      bindings.push({ result, status: result.status === 'success' ? 'success' : 'partial' });
    }
    if (operation.action === 'update' && (result.mutated || result.status === 'success')) {
      const backups = r.backups.filter((b) => b.operationId === operation.operationId);
      requireMatch(
        backups.length === 1 &&
          same(backups[0].targetItemId, operation.targetItemId) &&
          backups[0].files.length > 0 &&
          backups[0].files.every((f) =>
            fileRecord(f, remotePrefix + 'backups/' + operation.operationId + '/'),
          ),
        'An updated item needs a verified pre-write backup descriptor',
      );
    }
  }
  for (const result of r.reused) {
    const known = core.knownSuccess.find((o) => o.operationId === result.operationId);
    requireMatch(
      known &&
        same(result.targetItemId, known.targetItemId) &&
        same(result.targetPath, known.targetPath) &&
        same(result.templateId, known.templateId) &&
        matchesItem(result.post, known.post),
      'Reused dependency differs from its verified actual state',
    );
    bindings.push({ result, status: 'reused' });
  }
  const allSuccess = r.results.every((o) => o.status === 'success');
  requireMatch(
    (r.status === 'success') === allSuccess,
    'Receipt overall status contradicts operation outcomes',
  );
  const mutated = r.results.some((o) => o.mutated);
  requireMatch(
    r.status === 'success' ||
      (r.status === 'partial' && mutated) ||
      (r.status === 'failed' && !mutated && r.results.some((o) => o.status === 'failed')) ||
      (r.status === 'blocked' && !mutated && r.results.every((o) => o.status === 'skipped')),
    'Receipt mutation and terminal status contradict each other',
  );
  const next = await transitionExecutionState(stateDirectory, journal.sha256, (state) => {
    for (const row of r.results)
      state.operations.push({
        ...row,
        ...(core.operationKind ? { operationKind: core.operationKind } : {}),
        requestId: r.requestId,
        batchPlanSha256: r.batchPlanSha256,
        batchId: r.batchId,
      });
    for (const row of r.results.filter((o) => o.mutated && o.status !== 'success'))
      for (const previous of state.identities.filter((e) => same(e.identity.targetItemId, row.targetItemId)))
        previous.status = 'partial';
    for (const { result, status } of bindings)
      for (const identity of core.identities.filter((i) => same(i.targetItemId, result.targetItemId))) {
        const record = {
          identity,
          status,
          requestId: r.requestId,
          batchPlanSha256: r.batchPlanSha256,
          mappingRevision: core.mappingRevision,
        };
        const i = state.identities.findIndex((e) => identityKey(e.identity) === identityKey(identity));
        if (i < 0) state.identities.push(record);
        else state.identities[i] = record;
      }
    if (allSuccess)
      state.completedBatches.push({
        batchPlanSha256: r.batchPlanSha256,
        batchId: r.batchId,
        requestId: r.requestId,
      });
    state.active = null;
    return state;
  });
  return {
    ready: true,
    requestId: r.requestId,
    status: r.status,
    checkpointSha256: next.sha256,
    successful: r.results.filter((o) => o.status === 'success').length,
    failed: r.results.filter((o) => o.status === 'failed').length,
    skipped: r.results.filter((o) => o.status === 'skipped').length,
  };
}
if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--state-dir')
      throw fail(
        'usage',
        'arguments',
        'Usage: node record-execution.mjs --input event.json --state-dir JOURNAL_DIRECTORY',
      );
    console.log(JSON.stringify(await recordExecution(args[1], args[3]), null, 2));
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
