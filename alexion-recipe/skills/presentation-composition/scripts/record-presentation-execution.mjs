import { readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { scopedPath } from '../../cms-migration/scripts/lib/files.mjs';
import {
  initializeApplicationState,
  readApplicationJournal,
  transitionApplication,
} from './lib/application-state.mjs';
import { verifyOperationPost } from './plan-presentation-application.mjs';
import {
  requireSchema,
  readJSON,
  readArtifactJSON,
  hash,
  jsonBytes,
  equal,
  id,
  recheck,
  publish,
  cli,
  isMain,
} from './lib/common.mjs';

function requireMatch(condition, message) {
  if (!condition) throw Error(message);
}

// Kept separate from I/O so receipts can be tested without a Sitecore connection.
export function validatePresentationReceipt(receipt, review, active, state) {
  requireMatch(
    receipt?.version === 1 &&
      receipt.kind === 'presentation-execution-receipt' &&
      ['success', 'failed'].includes(receipt.status),
    'Invalid presentation terminal receipt',
  );
  requireMatch(
    receipt.scopeId === state.scopeId &&
      receipt.taskId === review.taskId &&
      receipt.requestId === active.requestId &&
      receipt.requestSha256 === active.requestSha256 &&
      receipt.reviewSha256 === active.reviewSha256 &&
      receipt.applicationPlanSha256 === active.applicationPlanSha256 &&
      receipt.batchId === active.batchId &&
      equal(receipt.target, state.target) &&
      equal(receipt.target, review.target),
    'Receipt request, review, plan, batch or target differs',
  );
  requireMatch(
    review.version === 1 &&
      review.kind === 'presentation-mutation-review' &&
      review.scopeId === state.scopeId &&
      review.applicationPlanSha256 === active.applicationPlanSha256 &&
      review.batchId === active.batchId &&
      Array.isArray(review.operations) &&
      review.operations.length > 0,
    'Reserved presentation review differs',
  );
  requireMatch(
    Array.isArray(receipt.results) &&
      receipt.results.length === review.operations.length &&
      new Set(receipt.results.map((row) => row.operationId)).size === receipt.results.length,
    'Receipt must report every operation exactly once',
  );
  let stopped = false;
  for (let i = 0; i < review.operations.length; i++) {
    const operation = review.operations[i],
      row = receipt.results[i];
    requireMatch(
      row.operationId === operation.operationId &&
        ['success', 'failed', 'skipped'].includes(row.status) &&
        Array.isArray(row.post),
      'Receipt operation order or result differs',
    );
    requireMatch(
      !stopped || row.status === 'skipped',
      'Only skipped operations may follow a failed operation',
    );
    if (row.status === 'success') verifyOperationPost(operation, row.post);
    else {
      stopped = true;
      requireMatch(
        row.status !== 'skipped' || row.post.length === 0,
        'Skipped operation cannot report effects',
      );
    }
    requireMatch(
      new Set(row.post.map((post) => post.key)).size === row.post.length &&
        row.post.every(
          (post) =>
            operation.contexts.some((ctx) => ctx.query.key === post.key) &&
            (!post.item ||
              (id(post.item.id) === id(operation.itemId) &&
                id(post.item.templateId) === id(operation.templateId) &&
                post.item.path === operation.path)),
        ),
      'Actual partial result identity/context differs from approved operation',
    );
  }
  requireMatch(
    (receipt.status === 'success') === receipt.results.every((row) => row.status === 'success'),
    'Receipt status contradicts operation results',
  );
  requireMatch(
    receipt.status !== 'failed' || receipt.results.some((row) => row.status === 'failed'),
    'Failed receipt must identify a failed operation',
  );
  for (const field of ['backups', 'journal'])
    requireMatch(
      Array.isArray(receipt[field]) &&
        receipt[field].every(
          (row) =>
            typeof row.file === 'string' &&
            row.file &&
            !row.file.includes('\\') &&
            !row.file.split('/').some((p) => !p || p === '.' || p === '..') &&
            !/[:\x00-\x1f]/.test(row.file) &&
            /^[a-f0-9]{64}$/.test(row.sha256) &&
            Number.isSafeInteger(row.bytes) &&
            row.bytes > 0,
        ),
      'Invalid downloaded ' + field + ' descriptor',
    );
  requireMatch(receipt.journal.length > 0, 'Terminal receipt requires durable remote journal evidence');
  const files = [...receipt.backups, ...receipt.journal];
  requireMatch(
    new Set(files.map((row) => row.file)).size === files.length,
    'Duplicate receipt evidence file',
  );
  if (review.operations.some((op) => op.action === 'update'))
    requireMatch(receipt.backups.length > 0, 'Updated items require downloaded backups');
  return files;
}

export async function verifyPresentationDownloads(base, downloaded, files) {
  requireMatch(
    Array.isArray(downloaded) &&
      downloaded.length === files.length &&
      new Set(downloaded.map((row) => row.path)).size === files.length,
    'Every remote backup and journal file must be downloaded exactly once',
  );
  const remaining = [...files],
    refs = [];
  for (const ref of downloaded) {
    const path = await scopedPath(base, ref.path),
      stat = await lstat(path),
      bytes = await readFile(path);
    const index = remaining.findIndex(
      (row) =>
        row.sha256 === ref.sha256 &&
        row.sha256 === hash(bytes) &&
        row.bytes === bytes.length &&
        (ref.path === row.file || ref.path.endsWith('/' + row.file)),
    );
    requireMatch(
      stat.size === bytes.length && index >= 0,
      'Downloaded backup/journal bytes or filename differ',
    );
    remaining.splice(index, 1);
    refs.push({ path, sha256: ref.sha256 });
  }
  return refs;
}

export async function verifyPresentationCompletionEvidence(completion, state) {
  const {
    evidenceRoot,
    receipt: receiptRef,
    review: reviewRef,
    downloaded,
    connectorId,
    jobId,
    recordedAt,
    ...embedded
  } = completion;
  requireMatch(
    typeof evidenceRoot === 'string' &&
      isAbsolute(evidenceRoot) &&
      connectorId === state.target.connectorId &&
      typeof jobId === 'string' &&
      jobId &&
      Number.isFinite(Date.parse(recordedAt)),
    'Completed presentation evidence location or job binding is absent',
  );
  const review = await readArtifactJSON(evidenceRoot, reviewRef),
    receipt = await readArtifactJSON(evidenceRoot, receiptRef);
  requireMatch(
    equal(receipt.value, embedded) &&
      review.sha256 === completion.reviewSha256 &&
      hash(jsonBytes(review.value)) === completion.reviewSha256,
    'Completed receipt/review differs from immutable journal history',
  );
  const files = validatePresentationReceipt(receipt.value, review.value, completion, state);
  return [
    ...(await verifyPresentationDownloads(evidenceRoot, downloaded, files)),
    { path: review.path, sha256: review.sha256 },
    { path: receipt.path, sha256: receipt.sha256 },
  ];
}

export async function recordPresentationExecution(inputPath, outputPath) {
  const input = await readJSON(inputPath),
    event = requireSchema('presentationEvent', input.value),
    base = dirname(inputPath),
    directory = resolve(base, event.journalDirectory);
  if (event.action === 'initialize') {
    requireMatch(
      event.target && !event.requestId && !event.expectedHeadSha256,
      'Initialization requires an explicit target and no active request',
    );
    const next = await initializeApplicationState(directory, event.scopeId, event.target);
    const report = { ready: true, status: 'initialized', checkpointSha256: next.sha256 };
    if (outputPath)
      await publish(outputPath, { 'presentation-execution-record.json': report }, [
        { path: inputPath, sha256: input.sha256 },
      ]);
    return report;
  }
  const journal = await readApplicationJournal(directory),
    active = journal.state.active;
  requireMatch(
    event.scopeId === journal.state.scopeId && event.expectedHeadSha256 === journal.sha256,
    'Reload the current presentation journal checkpoint',
  );
  requireMatch(
    active &&
      active.requestId === event.requestId &&
      event.connectorId === active.connectorId &&
      event.connectorId === journal.state.target.connectorId,
    'Event does not identify the reserved request and connector',
  );
  requireMatch(!event.target || equal(event.target, journal.state.target), 'Event target differs');
  requireMatch(
    !active.jobId || !event.jobId || active.jobId === event.jobId,
    'Known connector job cannot change',
  );
  const refs = [{ path: inputPath, sha256: input.sha256 }];
  let completion;
  if (event.action === 'terminal') {
    requireMatch(
      active.jobId &&
        event.jobId === active.jobId &&
        ['submitted', 'unknown'].includes(active.status) &&
        event.review &&
        event.receipt &&
        Array.isArray(event.backups),
      'Terminal reconciliation requires a bound connector job, exact review, receipt and downloaded evidence',
    );
    const review = await readArtifactJSON(base, event.review),
      receipt = await readArtifactJSON(base, event.receipt);
    requireMatch(
      review.sha256 === active.reviewSha256 && hash(jsonBytes(review.value)) === active.reviewSha256,
      'Review bytes differ from reservation',
    );
    const files = validatePresentationReceipt(receipt.value, review.value, active, journal.state);
    refs.push(...(await verifyPresentationDownloads(base, event.backups, files)));
    refs.push({ path: review.path, sha256: review.sha256 }, { path: receipt.path, sha256: receipt.sha256 });
    completion = {
      ...receipt.value,
      connectorId: event.connectorId,
      jobId: event.jobId,
      recordedAt: new Date().toISOString(),
      evidenceRoot: await realpath(base),
      receipt: event.receipt,
      review: event.review,
      downloaded: event.backups,
    };
  } else {
    requireMatch(['submitted', 'unknown'].includes(event.action), 'Unsupported presentation journal action');
    requireMatch(
      event.action !== 'submitted' || (event.jobId && ['reserved', 'submitted'].includes(active.status)),
      'Submission requires a connector job and cannot clear unknown effects',
    );
  }
  await recheck(refs);
  const next = await transitionApplication(directory, journal.sha256, (state) => {
    if (completion) {
      state.completed.push(completion);
      state.active = null;
    } else {
      state.active.status = event.action;
      if (event.jobId) state.active.jobId = event.jobId;
    }
  });
  const report = {
    ready: true,
    requestId: event.requestId,
    status: completion?.status ?? next.state.active.status,
    checkpointSha256: next.sha256,
  };
  if (outputPath) await publish(outputPath, { 'presentation-execution-record.json': report }, refs);
  return report;
}
if (isMain(import.meta.url)) await cli(recordPresentationExecution);
