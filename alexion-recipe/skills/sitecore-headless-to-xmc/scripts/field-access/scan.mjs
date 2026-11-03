import { constants } from 'node:fs';
import { lstat, readdir, realpath, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

// Trimmed, self-contained copy of frontend-migration/scripts/analysis-files.mjs's
// scan()/prepareOutput() — same safety properties (symlink rejection, byte
// limits, output-outside-root), narrowed to JS/TS/JSX source only (no
// CSS/JSON relevance — this analyzer doesn't need it).
const excluded = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.turbo', 'out', '.cache']);
const relevant = name => /\.(?:[cm]?[jt]sx?)$/i.test(name);
export const inside = (root, target) => { const rel = path.relative(root, target); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

async function readBounded(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not-regular-file');
    if (stat.size > limit) throw new Error('file-too-large');
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limit) throw new Error('file-too-large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await handle.close(); }
}

export async function scan(root, opts) {
  const files = [];
  const info = { complete: true, filesMatched: 0, filesRead: 0, omissions: [] };
  const omit = (file, reason) => { info.complete = false; info.omissions.push({ file, reason }); };
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (directory === root) throw error; omit(`./${path.relative(root, directory)}`, 'unreadable-directory'); return; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const relative = `./${path.relative(root, full).split(path.sep).join('/')}`;
      if (entry.isSymbolicLink()) { omit(relative, 'symlink'); continue; }
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || !relevant(entry.name)) continue;
      info.filesMatched++;
      if (info.filesMatched > opts['max-files']) { info.complete = false; continue; }
      try {
        const content = await readBounded(full, opts['max-file-bytes']);
        files.push({ path: relative, content, size: Buffer.byteLength(content) });
      } catch (error) { omit(relative, error.message === 'file-too-large' ? error.message : 'unreadable-file'); }
    }
  }
  await walk(root);
  info.filesRead = files.length;
  if (info.filesMatched > opts['max-files']) info.omissions.push({ reason: 'max-files', count: info.filesMatched - opts['max-files'] });
  return { files, info };
}

export async function prepareOutput(output, root) {
  const absolute = path.resolve(output);
  if (inside(root, absolute)) throw new Error('Output must be outside the analysis root');
  const { root: volume } = path.parse(absolute);
  let parent = volume;
  for (const part of path.relative(volume, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    try { await mkdir(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Output parent must be a real directory, not a symlink');
    if (inside(root, await realpath(parent))) throw new Error('Output resolves inside the analysis root');
  }
  return absolute;
}
