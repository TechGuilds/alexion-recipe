import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export async function context(options) {
  if (!options.appPath || !path.isAbsolute(options.appPath)) throw new Error('appPath must be absolute');
  const appPath = await fs.realpath(options.appPath);
  const base = appPath.startsWith('/workspace/') ? '/workspace/tmp' : os.tmpdir();
  const dir = path.join(base, 'kajoo-dev-server', crypto.createHash('sha256').update(appPath).digest('hex').slice(0, 24));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return { appPath, dir };
}
export async function locked(dir, action) {
  const lock = path.join(dir, 'lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Application operation locked; retry after the other operation finishes. Do not remove a live lock.');
    throw error;
  }
  try { return await action(); } finally { await fs.rmdir(lock); }
}
export async function atomicWrite(file, content) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, content, { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function input(argument) {
  if (argument) return JSON.parse(argument);
  let value = ''; for await (const chunk of process.stdin) value += chunk;
  return JSON.parse(value);
}
