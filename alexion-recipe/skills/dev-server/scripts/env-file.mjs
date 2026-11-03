import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite, context, input, locked } from './common.mjs';

export function parseEnv(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"')) value = value.slice(1, value.lastIndexOf('"'));
    else if (value.startsWith("'")) value = value.slice(1, value.lastIndexOf("'"));
    else value = value.split('#')[0].trim();
    result[match[1]] = value;
  }
  return result;
}
export async function updateEnv(options, prepare) {
  const { appPath, dir } = await context(options);
  return locked(dir, async () => {
    const file = path.join(appPath, '.env.local');
    let content = '';
    try { content = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const previous = parseEnv(content);
    const updates = prepare ? await prepare(previous) : options.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('updates must be a map');
    for (const [key, value] of Object.entries(updates)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value) || value.includes("'")) {
        throw new Error('Invalid environment entry: use valid names and single-line strings without single quotes');
      }
    }
    const seen = new Set();
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content ? content.replace(/\r?\n$/, '').split(/\r?\n/) : [];
    const output = lines.map(line => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!match || !Object.hasOwn(updates, match[1])) return line;
      seen.add(match[1]); return `${match[1]}='${updates[match[1]]}'`;
    });
    for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) output.push(`${key}='${value}'`);
    await atomicWrite(file, output.join(newline) + newline);
    return { changed: Object.keys(updates).filter(key => previous[key] !== updates[key]), restartRequired: true };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await updateEnv(await input(process.argv[2])))); }
  catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
