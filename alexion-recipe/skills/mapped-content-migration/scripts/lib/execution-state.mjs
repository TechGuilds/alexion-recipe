import { open, rename, unlink, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireSchema } from './schema.mjs';
import {
  readJSON,
  readArtifactJSON,
  freshDirectory,
  jsonBytes,
  hash,
  fail,
  MAX_JSON_BYTES,
} from './files.mjs';

const bounded = (value) => {
  const bytes = jsonBytes(value);
  if (Buffer.byteLength(bytes) > MAX_JSON_BYTES)
    throw fail(
      'checkpoint-size',
      'checkpoint',
      'Checkpoint exceeds 16 MiB; preserve receipts and review a smaller execution scope',
    );
  return bytes;
};
async function durable(path, value) {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(bounded(value));
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function readExecutionState(directory) {
  const root = await realpath(resolve(directory)),
    head = (await readJSON(join(root, 'head.json'))).value;
  requireSchema('file', head);
  const checkpoint = await readArtifactJSON(root, head);
  requireSchema('executionCheckpoint', checkpoint.value);
  return { root, checkpoint: checkpoint.value, sha256: checkpoint.sha256, head };
}

/** Establish continuity through immutable, hash-verified checkpoints, not sequence alone. */
export async function assertExecutionAncestor(directory, ancestorSha256) {
  const current = await readExecutionState(directory);
  let checkpoint = current.checkpoint,
    digest = current.sha256;
  while (digest !== ancestorSha256) {
    if (checkpoint.sequence === 0 || !checkpoint.previousSha256)
      throw fail(
        'checkpoint-lineage',
        'checkpoint',
        'Reference identity checkpoint is not an ancestor of this journal',
      );
    const sequence = checkpoint.sequence - 1,
      previous = checkpoint.previousSha256;
    const path =
      sequence === 0
        ? 'checkpoint-000000.json'
        : `checkpoint-${String(sequence).padStart(6, '0')}-${previous.slice(0, 12)}.json`;
    const artifact = await readArtifactJSON(current.root, { path, sha256: previous });
    requireSchema('executionCheckpoint', artifact.value);
    if (
      artifact.value.sequence !== sequence ||
      ['scopeId', 'targetInstanceId', 'database', 'rootPath', 'connectorId'].some(
        (k) => artifact.value[k] !== current.checkpoint[k],
      )
    )
      throw fail('checkpoint-lineage', 'checkpoint', 'Journal history scope or sequence differs');
    checkpoint = artifact.value;
    digest = artifact.sha256;
  }
  return true;
}

export async function initializeExecutionState(directory, scope) {
  requireSchema('executionScope', scope);
  const root = await freshDirectory(directory);
  const checkpoint = {
    version: 1,
    ...scope,
    sequence: 0,
    previousSha256: null,
    active: null,
    completedBatches: [],
    operations: [],
    identities: [],
  };
  requireSchema('executionCheckpoint', checkpoint);
  const path = 'checkpoint-000000.json',
    sha256 = hash(bounded(checkpoint));
  await durable(join(root, path), checkpoint);
  await durable(join(root, 'head.json'), { path, sha256 });
  return { checkpoint, sha256 };
}

/** Single-writer CAS with immutable snapshots. A crashed lock requires review. */
export async function transitionExecutionState(directory, expectedSha256, change) {
  const root = await realpath(resolve(directory)),
    lockPath = join(root, '.transition.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch {
    throw fail(
      'journal-lock',
      'checkpoint',
      'Another transition or interrupted journal update needs reconciliation',
    );
  }
  try {
    const current = await readExecutionState(root);
    if (current.sha256 !== expectedSha256)
      throw fail(
        'checkpoint-drift',
        'checkpoint',
        'Checkpoint changed; reload before recording another event',
      );
    const next = await change(structuredClone(current.checkpoint));
    next.sequence = current.checkpoint.sequence + 1;
    next.previousSha256 = current.sha256;
    requireSchema('executionCheckpoint', next);
    const sha256 = hash(bounded(next)),
      path = `checkpoint-${String(next.sequence).padStart(6, '0')}-${sha256.slice(0, 12)}.json`;
    await durable(join(root, path), next);
    const temporary = join(root, `.head-${next.sequence}-${sha256.slice(0, 12)}.json`);
    await durable(temporary, { path, sha256 });
    await rename(temporary, join(root, 'head.json'));
    return { checkpoint: next, sha256 };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function reserveExecution(directory, expectedSha256, active) {
  return transitionExecutionState(directory, expectedSha256, (state) => {
    if (state.active)
      throw fail(
        'pending-job',
        'checkpoint',
        'A reserved, submitted or unknown request must be reconciled before another mutation',
      );
    state.active = { ...active, state: 'reserved', jobId: null, envelopeSha256: null };
    return state;
  });
}
