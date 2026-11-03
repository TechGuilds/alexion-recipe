import { open, lstat, mkdir, writeFile, rm, rename, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { cli, newPath, isMain } from './contracts.mjs';

// Dependency-free zip reader for untrusted uploads. It never creates links, never writes outside
// the destination and enforces size limits on the bytes actually inflated, not on declared sizes.
const LIMITS = { entries: 100_000, totalBytes: 2 * 1024 ** 3, entryBytes: 256 * 1024 ** 2, rootDepth: 5 };
const REPORTED_SKIPS = 50;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buffer => {
  let c = 0xFFFFFFFF;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Archive is truncated or its directory is damaged');
  return buffer;
}

// Strictly inside root: a second guard behind pathParts, independent of the platform's separator.
const within = (root, target) => { const rel = relative(root, target); return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
function unsafe(raw) { return new Error('Archive contains an unsafe path: ' + JSON.stringify(raw)); }
function pathParts(raw) {
  if (raw.includes('\0')) throw unsafe(raw);
  const name = raw.replaceAll('\\', '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw unsafe(raw);
  const parts = name.split('/').filter(part => part !== '' && part !== '.');
  if (parts.includes('..')) throw unsafe(raw);
  return parts;
}

async function listEntries(handle, size) {
  const tailLength = Math.min(size, 22 + 0xFFFF);
  if (tailLength < 22) throw new Error('Not a zip archive');
  const tail = await readAt(handle, size - tailLength, tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip archive, or its end record is damaged');
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) throw new Error('Multi-disk archives are not supported');
  const total = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
  if (total === 0xFFFF || directorySize === 0xFFFFFFFF || directoryOffset === 0xFFFFFFFF) throw new Error('Zip64 archives are not supported');
  if (total > LIMITS.entries) throw new Error(`Archive has ${total} entries; the limit is ${LIMITS.entries}`);
  if (directoryOffset + directorySize > size) throw new Error('Archive directory lies outside the file');
  const directory = await readAt(handle, directoryOffset, directorySize);
  const entries = [];
  let position = 0;
  for (let i = 0; i < total; i++) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) throw new Error('Archive directory is damaged');
    const madeBy = directory.readUInt16LE(position + 4), flags = directory.readUInt16LE(position + 8);
    const nameLength = directory.readUInt16LE(position + 28), extraLength = directory.readUInt16LE(position + 30), commentLength = directory.readUInt16LE(position + 32);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new Error('Archive directory is damaged');
    const raw = directory.toString(flags & 0x800 ? 'utf8' : 'latin1', position + 46, position + 46 + nameLength);
    const attributes = directory.readUInt32LE(position + 38);
    entries.push({
      raw, flags, method: directory.readUInt16LE(position + 10), crc: directory.readUInt32LE(position + 16),
      compressed: directory.readUInt32LE(position + 20), size: directory.readUInt32LE(position + 24), offset: directory.readUInt32LE(position + 42),
      mode: madeBy >> 8 === 3 ? attributes >>> 16 : 0, directory: /[\\/]$/.test(raw) || (attributes & 0x10) !== 0,
    });
    position = next;
  }
  return entries;
}

async function readEntry(handle, size, entry) {
  const header = await readAt(handle, entry.offset, 30);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Archive entry header is damaged: ' + JSON.stringify(entry.raw));
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressed > size) throw new Error('Archive entry lies outside the file: ' + JSON.stringify(entry.raw));
  const data = await readAt(handle, start, entry.compressed);
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try { out = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) }); }
    catch { throw new Error('Archive entry does not inflate to its declared size: ' + JSON.stringify(entry.raw)); }
  } else throw new Error(`Unsupported compression method ${entry.method}: ${JSON.stringify(entry.raw)}`);
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new Error('Archive entry failed its size or CRC check: ' + JSON.stringify(entry.raw));
  return out;
}

function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

export async function extractArchive(input, { base, options }) {
  const path = await realpath(resolve(base, input.archivePath));
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error('archivePath must be a regular file');
  if (options.apply && !options.destination) throw new Error('--apply requires --destination');
  if (!options.apply && options.destination) throw new Error('--destination requires --apply');
  if (input.rootPath === undefined && !input.rootMarkers?.length) throw new Error('Provide rootMarkers to detect the project root, or rootPath to name it');

  const handle = await open(path, 'r');
  try {
    const skipped = [], kept = [], warnings = [];
    for (const entry of await listEntries(handle, stat.size)) {
      const parts = pathParts(entry.raw);
      if (entry.flags & 1) throw new Error('Encrypted archive entries are not supported: ' + JSON.stringify(entry.raw));
      if (!parts.length) continue;
      const type = entry.mode & 0o170000;
      const skip = parts.includes('.git') ? 'git metadata' : parts[0] === '__MACOSX' ? 'macOS metadata'
        : type === 0o120000 ? 'symbolic link' : type && type !== 0o100000 && type !== 0o040000 ? 'special file' : null;
      if (skip) { skipped.push({ path: parts.join('/'), reason: skip }); continue; }
      kept.push({ ...entry, parts, directory: entry.directory || type === 0o040000 });
    }
    // A file may not repeat, differ only by case, or also be a directory: extraction order must never matter.
    const seen = new Map(), directories = new Set();
    for (const entry of kept) for (let i = 1; i < entry.parts.length; i++) directories.add(entry.parts.slice(0, i).join('/'));
    for (const entry of kept) {
      const key = entry.parts.join('/');
      if (entry.directory) { directories.add(key); continue; }
      if (seen.has(key.toLowerCase())) throw new Error('Archive has duplicate or case-colliding entries: ' + JSON.stringify(key));
      seen.set(key.toLowerCase(), key);
    }
    for (const key of seen.values()) if (directories.has(key)) throw new Error('Archive has an entry that is both a file and a directory: ' + JSON.stringify(key));

    const children = new Map([['', new Set()]]);
    for (const entry of kept) for (let i = 0; i < entry.parts.length; i++) {
      const dir = entry.parts.slice(0, i).join('/');
      if (!children.has(dir)) children.set(dir, new Set());
      children.get(dir).add(entry.parts[i]);
    }
    const isMarker = name => input.rootMarkers.some(marker => (marker.startsWith('*') ? name.endsWith(marker.slice(1)) : name === marker));
    let root, candidates = [], method;
    if (input.rootPath !== undefined) {
      root = pathParts(input.rootPath).join('/'); method = 'explicit';
      if (root && !directories.has(root)) throw new Error('rootPath is not a directory in the archive: ' + input.rootPath);
      candidates = [root];
    } else {
      method = 'markers';
      const walk = (dir, depth) => {
        const names = children.get(dir) ?? new Set();
        if ([...names].some(isMarker)) { candidates.push(dir); return; }
        if (depth >= LIMITS.rootDepth) return;
        for (const name of [...names].sort()) { const child = dir ? dir + '/' + name : name; if (children.has(child)) walk(child, depth + 1); }
      };
      walk('', 0);
      if (!candidates.length) throw new Error('No project root found: no directory within ' + LIMITS.rootDepth + ' levels holds any of ' + input.rootMarkers.join(', '));
      if (candidates.length > 1) throw new Error('Archive is ambiguous. Project roots found: ' + candidates.map(x => x || '.').join(', ') + '. Choose one with rootPath.');
      root = candidates[0];
    }
    const prefix = root ? root.split('/') : [];
    const underRoot = entry => prefix.every((part, i) => entry.parts[i] === part);
    const ancestor = entry => entry.directory && entry.parts.length <= prefix.length && entry.parts.every((part, i) => prefix[i] === part);
    const inside = kept.filter(entry => underRoot(entry) && entry.parts.length > prefix.length);
    const outside = kept.filter(entry => !underRoot(entry) && !ancestor(entry)).length;
    const files = inside.filter(entry => !entry.directory);
    const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of files) {
      if (Math.max(entry.size, entry.compressed) > LIMITS.entryBytes) throw new Error(`Entry exceeds ${LIMITS.entryBytes} bytes: ${JSON.stringify(entry.parts.join('/'))}`);
    }
    if (totalBytes > LIMITS.totalBytes) throw new Error(`Archive expands to ${totalBytes} bytes; the limit is ${LIMITS.totalBytes}`);
    const folders = new Set();
    for (const entry of inside) {
      const relative = entry.parts.slice(prefix.length), depth = entry.directory ? relative.length : relative.length - 1;
      for (let i = 1; i <= depth; i++) folders.add(relative.slice(0, i).join('/'));
    }
    for (const kind of ['symbolic link', 'special file']) {
      const count = skipped.filter(item => item.reason === kind).length;
      if (count) warnings.push(`${count} ${kind}${count > 1 ? 's were' : ' was'} not extracted`);
    }
    if (skipped.some(item => item.reason === 'git metadata')) warnings.push('Git metadata was not extracted; clone the repository if history is needed');
    if (outside > 0) warnings.push(`${outside} entries outside the project root were not extracted`);

    let destination = null;
    if (options.apply) {
      destination = await newPath(options.destination);
      const staging = destination + '.partial-' + randomBytes(4).toString('hex');
      try {
        await mkdir(staging);
        for (const entry of inside) {
          const target = resolve(staging, ...entry.parts.slice(prefix.length));
          if (!within(staging, target)) throw unsafe(entry.raw);
          if (entry.directory) { await mkdir(target, { recursive: true }); continue; }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await readEntry(handle, stat.size, entry), { flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 });
        }
        await rename(staging, destination);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    const totals = { files: files.length, directories: folders.size, bytes: totalBytes };
    return {
      valid: true, mode: options.apply ? 'extract' : 'dry-run',
      archive: { path, bytes: stat.size, sha256: await sha256(path), entries: kept.length + skipped.length },
      root: { path: root || '.', method, candidates: candidates.map(x => x || '.') }, totals,
      skippedCount: skipped.length, skipped: skipped.slice(0, REPORTED_SKIPS), warnings, destination, limits: LIMITS,
      summary: { mode: options.apply ? 'extract' : 'dry-run', root: root || '.', ...totals, skipped: skipped.length, destination },
    };
  } finally {
    await handle.close();
  }
}
if (await isMain(import.meta.url)) await cli('extract-archive', extractArchive, ['apply', 'destination']);
