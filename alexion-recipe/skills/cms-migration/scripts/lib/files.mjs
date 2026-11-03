import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => JSON.stringify(value, null, 2) + '\n';
export const normalizeId = (value) => String(value).toLowerCase();
export const fail = (code, path, message) => Object.assign(new Error(message), { code, path });
export const MAX_JSON_BYTES = 16 * 1024 * 1024;

export async function scopedPath(base, relative) {
  if (
    typeof relative !== 'string' ||
    isAbsolute(relative) ||
    /[\\:\u0000-\u001f]/.test(relative) ||
    relative.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw fail('file-path', relative, 'Expected a clean manifest-relative artifact path');
  let current = await realpath(base);
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
      throw fail('file-path', relative, 'Artifact must be a regular file without links');
  }
  return current;
}

export async function readJSON(path, maxBytes = MAX_JSON_BYTES) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw fail('file-size', path, 'JSON file is not regular or exceeds the byte limit');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw fail('file-size', path, 'JSON file exceeds the byte limit');
  return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes), bytes: bytes.length };
}

export async function readArtifactJSON(base, descriptor, maxBytes = MAX_JSON_BYTES) {
  const path = await scopedPath(base, descriptor.path);
  const result = await readJSON(path, maxBytes);
  if (result.sha256 !== descriptor.sha256)
    throw fail('hash', descriptor.path, 'Artifact differs from its declared SHA-256');
  return { ...result, path };
}

/** Bounded line buffering, with streaming verification of the entire artifact. */
export async function* readJSONLines(base, descriptor, maxLineBytes = MAX_JSON_BYTES) {
  const path = await scopedPath(base, descriptor.path);
  if (descriptor.bytes !== undefined && (await lstat(path)).size !== descriptor.bytes)
    throw fail('file-size', descriptor.path, 'Artifact byte count differs');
  const digest = createHash('sha256');
  let pending = Buffer.alloc(0),
    line = 0,
    bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    digest.update(chunk);
    bytes += chunk.length;
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const row = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      line++;
      if (row.length > maxLineBytes)
        throw fail('record-size', descriptor.path, 'JSONL record exceeds byte limit');
      if (row.toString('utf8').trim()) yield JSON.parse(row.toString('utf8'));
    }
    if (pending.length > maxLineBytes)
      throw fail('record-size', descriptor.path, 'JSONL record exceeds byte limit');
  }
  if (pending.length) {
    line++;
    if (pending.toString('utf8').trim()) yield JSON.parse(pending.toString('utf8'));
  }
  if (digest.digest('hex') !== descriptor.sha256)
    throw fail('hash', descriptor.path, 'JSONL artifact differs from its declared SHA-256');
  if (descriptor.bytes !== undefined && descriptor.bytes !== bytes)
    throw fail('file-size', descriptor.path, 'Artifact byte count differs');
}

export async function freshDirectory(path) {
  const target = resolve(await realpath(dirname(resolve(path))), path.split(/[\\/]/).at(-1));
  await mkdir(target); // exclusive: no reuse or overwrite of a previous attempt
  return target;
}
export const writeNewJSON = (path, value) => writeFile(path, jsonBytes(value), { flag: 'wx' });
export const isMain = (url) => !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url;
export function errorReport(error) {
  return {
    valid: false,
    errors: [
      {
        code: error.code ?? 'input',
        path: error.path ?? 'input',
        message: error.code ? error.message : 'Cannot read or validate the supplied artifacts',
      },
    ],
  };
}
