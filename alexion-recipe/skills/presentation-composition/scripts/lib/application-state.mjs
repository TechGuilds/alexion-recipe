import { open, rename, unlink, realpath, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readJSON, readArtifactJSON, freshDirectory, hash, jsonBytes, equal } from './common.mjs';

async function durable(path, value) {
  const bytes = jsonBytes(value);
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw Error('Presentation checkpoint exceeds byte bound');
  const file = await open(path, 'wx');
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function initializeApplicationState(directory, scopeId, target) {
  const root = await freshDirectory(directory),
    state = {
      version: 1,
      kind: 'presentation-checkpoint',
      scopeId,
      target,
      sequence: 0,
      previousSha256: null,
      active: null,
      completed: [],
    };
  await durable(join(root, 'checkpoint-000000.json'), state);
  const sha256 = hash(jsonBytes(state));
  await durable(join(root, 'head.json'), { path: 'checkpoint-000000.json', sha256 });
  return { root, state, sha256 };
}
export async function readApplicationJournal(directory) {
  const root = await realpath(resolve(directory)),
    headPath = join(root, 'head.json'),
    stat = await lstat(headPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error('Invalid presentation journal head');
  const head = (await readJSON(headPath)).value;
  if (
    !/^checkpoint-(?:000000|\d{6,}-[a-f0-9]{12})\.json$/.test(head.path) ||
    !/^[a-f0-9]{64}$/.test(head.sha256)
  )
    throw Error('Invalid presentation journal head descriptor');
  const artifact = await readArtifactJSON(root, head),
    state = artifact.value;
  if (
    state.version !== 1 ||
    state.kind !== 'presentation-checkpoint' ||
    !Number.isInteger(state.sequence) ||
    state.sequence < 0 ||
    !Array.isArray(state.completed) ||
    !state.scopeId ||
    !state.target
  )
    throw Error('Invalid presentation journal checkpoint');
  const checkpoints = new Map();
  for (const name of await readdir(root))
    if (name.startsWith('checkpoint-') && name.endsWith('.json')) {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error('Invalid linked presentation checkpoint');
      const entry = await readJSON(join(root, name));
      if (checkpoints.has(entry.value.sequence) || entry.value.sequence > state.sequence)
        throw Error('Forked or rolled-back presentation journal');
      checkpoints.set(entry.value.sequence, { ...entry, name });
    }
  if (checkpoints.size !== state.sequence + 1) throw Error('Incomplete presentation journal chain');
  let previous = null;
  for (let sequence = 0; sequence <= state.sequence; sequence++) {
    const entry = checkpoints.get(sequence),
      row = entry?.value;
    if (
      !row ||
      row.version !== 1 ||
      row.kind !== 'presentation-checkpoint' ||
      row.scopeId !== state.scopeId ||
      !equal(row.target, state.target) ||
      !Array.isArray(row.completed) ||
      row.previousSha256 !== (previous?.sha256 ?? null)
    )
      throw Error('Invalid presentation journal SHA chain');
    const filename =
      sequence === 0
        ? 'checkpoint-000000.json'
        : 'checkpoint-' + String(sequence).padStart(6, '0') + '-' + entry.sha256.slice(0, 12) + '.json';
    if (
      entry.name !== filename ||
      (previous && !equal(row.completed.slice(0, previous.value.completed.length), previous.value.completed))
    )
      throw Error('Presentation journal history was replaced');
    previous = entry;
  }
  if (previous.sha256 !== artifact.sha256) throw Error('Presentation journal head differs from chain');
  return { root, state, sha256: artifact.sha256, head };
}
export async function transitionApplication(directory, expectedHead, change) {
  const old = await readApplicationJournal(directory),
    lockPath = join(old.root, '.journal.lock'),
    lock = await open(lockPath, 'wx');
  try {
    const current = await readApplicationJournal(directory);
    if (current.sha256 !== expectedHead) throw Error('Stale presentation journal transition');
    const state = structuredClone(current.state);
    await change(state);
    if (state.scopeId !== current.state.scopeId || !equal(state.target, current.state.target))
      throw Error('Journal target scope cannot change');
    if (
      !Array.isArray(state.completed) ||
      !equal(state.completed.slice(0, current.state.completed.length), current.state.completed)
    )
      throw Error('Completed presentation history is immutable');
    if (state.active && state.completed.some((row) => row.requestId === state.active.requestId))
      throw Error('Presentation request was already completed');
    state.sequence++;
    state.previousSha256 = current.sha256;
    const sha256 = hash(jsonBytes(state)),
      path = 'checkpoint-' + String(state.sequence).padStart(6, '0') + '-' + sha256.slice(0, 12) + '.json';
    await durable(join(current.root, path), state);
    const next = join(current.root, 'head-' + sha256.slice(0, 16) + '.tmp');
    await durable(next, { path, sha256 });
    await rename(next, join(current.root, 'head.json'));
    return { root: current.root, state, sha256, head: { path, sha256 } };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
