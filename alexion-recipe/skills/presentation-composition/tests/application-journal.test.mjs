import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeApplicationState,
  readApplicationJournal,
  transitionApplication,
} from '../scripts/lib/application-state.mjs';
import {
  recordPresentationExecution,
  validatePresentationReceipt,
  verifyPresentationCompletionEvidence,
} from '../scripts/record-presentation-execution.mjs';
import { verifyApplicationCompletion } from '../scripts/audit-presentation-application.mjs';
import { hash, jsonBytes } from '../scripts/lib/common.mjs';

const sha = 'a'.repeat(64),
  target = {
    instanceId: 'target',
    database: 'master',
    connectorId: 'connector',
    rootPath: '/sitecore/content/site',
    marker: {
      id: '{00000000-0000-4000-8000-000000000001}',
      templateId: '{00000000-0000-4000-8000-000000000002}',
      path: '/sitecore/content/site',
    },
  };
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'presentation-journal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const put = async (file, value) => {
    const bytes = jsonBytes(value);
    await writeFile(join(base, file), bytes);
    return { path: file, sha256: hash(bytes) };
  };
  return { base, put, directory: join(base, 'journal') };
}
function data() {
  const item = {
    id: 'item',
    templateId: 'template',
    path: '/sitecore/content/site/page',
    versionPresent: true,
    contexts: [{ itemId: 'item', language: 'en', version: 1 }],
    fields: [],
  };
  const op = {
    operationId: 'op',
    itemId: item.id,
    templateId: item.templateId,
    path: item.path,
    action: 'create',
    contexts: [
      {
        query: { key: 'item|en|1', id: item.id, language: 'en', version: 1 },
        before: null,
        fields: [],
        layouts: [],
      },
    ],
  };
  const active = {
    requestId: 'request',
    requestSha256: sha,
    reviewSha256: sha,
    applicationPlanSha256: sha,
    batchId: 'batch',
    connectorId: 'connector',
  };
  const review = {
    version: 1,
    kind: 'presentation-mutation-review',
    scopeId: 'scope',
    taskId: 'task',
    target,
    applicationPlanSha256: sha,
    batchId: 'batch',
    operations: [op],
  };
  const receipt = {
    version: 1,
    kind: 'presentation-execution-receipt',
    scopeId: 'scope',
    taskId: 'task',
    target,
    requestId: 'request',
    requestSha256: sha,
    reviewSha256: sha,
    applicationPlanSha256: sha,
    batchId: 'batch',
    status: 'success',
    results: [{ operationId: 'op', status: 'success', post: [{ key: 'item|en|1', item }] }],
    backups: [],
    journal: [{ file: 'journal.jsonl', bytes: 4, sha256: hash('log\n') }],
  };
  return { item, op, active, review, receipt };
}
test('journal verifies immutable full SHA chain, CAS and rollback protection', async (t) => {
  const { directory } = await fixture(t),
    init = await initializeApplicationState(directory, 'scope', target),
    originalHead = await readFile(join(directory, 'head.json'));
  const next = await transitionApplication(directory, init.sha256, (state) => {
    state.active = data().active;
  });
  assert.equal((await readApplicationJournal(directory)).sha256, next.sha256);
  await assert.rejects(
    transitionApplication(directory, init.sha256, () => {}),
    /Stale/,
  );
  await writeFile(join(directory, 'head.json'), originalHead);
  await assert.rejects(readApplicationJournal(directory), /rolled-back/);
});
test('receipt verifies logical actual state and all exact bindings', () => {
  const { receipt, review, active } = data();
  assert.equal(validatePresentationReceipt(receipt, review, active, { scopeId: 'scope', target }).length, 1);
  for (const key of [
    'requestId',
    'requestSha256',
    'reviewSha256',
    'applicationPlanSha256',
    'batchId',
    'taskId',
  ])
    assert.throws(
      () =>
        validatePresentationReceipt({ ...receipt, [key]: 'wrong' }, review, active, {
          scopeId: 'scope',
          target,
        }),
      /differs/,
    );
  const wrong = structuredClone(receipt);
  wrong.results[0].post[0].item.path += '/wrong';
  assert.throws(
    () => validatePresentationReceipt(wrong, review, active, { scopeId: 'scope', target }),
    /identity/,
  );
});
test('journal detects edited predecessors and prevents completed history replacement', async (t) => {
  const { directory } = await fixture(t),
    init = await initializeApplicationState(directory, 'scope', target);
  const next = await transitionApplication(directory, init.sha256, (state) => {
    state.completed.push({ requestId: 'done', status: 'failed' });
  });
  await assert.rejects(
    transitionApplication(directory, next.sha256, (state) => {
      state.completed = [];
    }),
    /immutable/,
  );
  const initial = JSON.parse(await readFile(join(directory, 'checkpoint-000000.json'), 'utf8'));
  initial.completed.push({ requestId: 'tampered' });
  await writeFile(join(directory, 'checkpoint-000000.json'), jsonBytes(initial));
  await assert.rejects(readApplicationJournal(directory), /SHA chain/);
});
test('unknown cannot be cleared by submitted or inconclusive terminal evidence', async (t) => {
  const { base, put, directory } = await fixture(t),
    init = await initializeApplicationState(directory, 'scope', target);
  const reserved = await transitionApplication(directory, init.sha256, (state) => {
    state.active = { ...data().active, status: 'unknown', jobId: 'job' };
  });
  const common = {
    version: 1,
    scopeId: 'scope',
    journalDirectory: directory,
    expectedHeadSha256: reserved.sha256,
    requestId: 'request',
    connectorId: 'connector',
    jobId: 'job',
  };
  await put('event.json', { ...common, action: 'submitted' });
  await assert.rejects(recordPresentationExecution(join(base, 'event.json')), /cannot clear unknown/);
  await put('event.json', { ...common, action: 'terminal' });
  await assert.rejects(recordPresentationExecution(join(base, 'event.json')), /Terminal reconciliation/);
  assert.equal((await readApplicationJournal(directory)).state.active.status, 'unknown');
});
test('terminal requires downloaded journal bytes before clearing active', async (t) => {
  const { base, put, directory } = await fixture(t),
    d = data(),
    reviewRef = await put('review.json', d.review);
  d.active.reviewSha256 = reviewRef.sha256;
  d.receipt.reviewSha256 = reviewRef.sha256;
  const receiptRef = await put('receipt.json', d.receipt),
    init = await initializeApplicationState(directory, 'scope', target);
  const reserved = await transitionApplication(directory, init.sha256, (state) => {
    state.active = { ...d.active, status: 'submitted', jobId: 'job' };
  });
  const event = {
    version: 1,
    action: 'terminal',
    scopeId: 'scope',
    journalDirectory: directory,
    expectedHeadSha256: reserved.sha256,
    requestId: 'request',
    connectorId: 'connector',
    jobId: 'job',
    review: reviewRef,
    receipt: receiptRef,
    backups: [{ path: 'journal.jsonl', sha256: hash('log\n') }],
  };
  await writeFile(join(base, 'journal.jsonl'), 'bad\n');
  await put('event.json', event);
  await assert.rejects(recordPresentationExecution(join(base, 'event.json')), /bytes or filename/);
  assert.ok((await readApplicationJournal(directory)).state.active);
  await writeFile(join(base, 'journal.jsonl'), 'log\n');
  assert.equal((await recordPresentationExecution(join(base, 'event.json'))).status, 'success');
  const final = await readApplicationJournal(directory);
  assert.equal(final.state.active, null);
  assert.equal(final.state.completed[0].jobId, 'job');
  const completion = final.state.completed[0];
  assert.equal(completion.evidenceRoot, base);
  assert.equal((await verifyPresentationCompletionEvidence(completion, final.state)).length, 3);
  await writeFile(join(base, 'journal.jsonl'), 'bad\n');
  await assert.rejects(verifyPresentationCompletionEvidence(completion, final.state), /bytes or filename/);
  await writeFile(join(base, 'journal.jsonl'), 'log\n');
  await put('receipt.json', { ...d.receipt, status: 'failed' });
  await assert.rejects(verifyPresentationCompletionEvidence(completion, final.state), /SHA-256/);
});
test('final audit verifies reused desired operations and fresh post-terminal capture', () => {
  const d = data(),
    plan = { ready: true, scopeId: 'scope', target, operations: [{ ...d.op, action: 'reuse' }], batches: [] },
    journal = { state: { scopeId: 'scope', target, active: null, completed: [] } };
  const current = { capturedAt: '2026-10-28T12:00:00Z', queries: [{ key: 'item|en|1', byId: d.item }] };
  assert.equal(verifyApplicationCompletion(plan, sha, journal, current), true);
  assert.throws(
    () =>
      verifyApplicationCompletion(plan, sha, journal, {
        ...current,
        queries: [{ key: 'item|en|1', byId: null }],
      }),
    /identity/,
  );
  plan.batches.push({ id: 'batch', operationIds: ['op'] });
  assert.throws(() => verifyApplicationCompletion(plan, sha, journal, current), /lacks/);
  journal.state.completed.push({ ...d.receipt, recordedAt: '2026-10-28T12:01:00Z' });
  assert.throws(() => verifyApplicationCompletion(plan, sha, journal, current), /must follow/);
});

test('failed updates retain downloaded recovery backups before terminal reconciliation', () => {
  const { receipt, review, active } = data();
  review.operations[0].action = 'update';
  receipt.status = 'failed';
  receipt.results[0].status = 'failed';
  assert.throws(
    () => validatePresentationReceipt(receipt, review, active, { scopeId: 'scope', target }),
    /backups/,
  );
  receipt.backups.push({ file: 'backups/page.item', bytes: 6, sha256: hash('backup') });
  assert.equal(validatePresentationReceipt(receipt, review, active, { scopeId: 'scope', target }).length, 2);
});
