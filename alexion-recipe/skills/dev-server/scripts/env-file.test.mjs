import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
async function run(script, ...args) {
  const { stdout } = await exec(process.execPath, [path.join(root, script), ...args.map(a => typeof a === 'string' ? a : JSON.stringify(a))]);
  return JSON.parse(stdout);
}
async function fails(script, ...args) {
  await assert.rejects(run(script, ...args));
}
test('env-file preserves unrelated lines, never echoes values and is validated', async () => {
  const appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kajoo-env-'));
  try {
    const envPath = path.join(appPath, '.env.local');
    await fs.writeFile(envPath, '# keep me\nOTHER=value\nKEY=old\n');
    const result = await run('env-file.mjs', { appPath, updates: { KEY: 'secret # value', ADDED: 'one' } });
    assert.deepEqual(result.changed.sort(), ['ADDED', 'KEY']);
    assert.equal(result.restartRequired, true);
    assert.ok(!JSON.stringify(result).includes('secret # value'));
    const content = await fs.readFile(envPath, 'utf8');
    assert.match(content, /# keep me\nOTHER=value/);
    assert.match(content, /KEY='secret # value'/);
    const unchanged = await run('env-file.mjs', { appPath, updates: { ADDED: 'one' } });
    assert.deepEqual(unchanged.changed, []);
    const before = await fs.readFile(envPath, 'utf8');
    await fails('env-file.mjs', { appPath, updates: { 'BAD NAME': 'x' } });
    await fails('env-file.mjs', { appPath, updates: { MULTI: 'a\nb' } });
    await fails('env-file.mjs', { appPath, updates: { QUOTE: "it's" } });
    assert.equal(await fs.readFile(envPath, 'utf8'), before);
  } finally { await fs.rm(appPath, { recursive: true, force: true }); }
});
test('Sitecore dev modes edit .env.local through env-file and reject partial live settings', async () => {
  const appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kajoo-mode-'));
  try {
    const envPath = path.join(appPath, '.env.local');
    await fs.writeFile(envPath, 'SITECORE_EDGE_CONTEXT_ID=fixture\nSITECORE_EDITING_SECRET=fixture\n');
    const mode = name => run('../../sitecore/scripts/configure-dev-mode.js', { appPath, port: 3000, mode: name, envScript: path.join(root, 'env-file.mjs') });
    await mode('live-debug');
    const debug = await fs.readFile(envPath, 'utf8');
    assert.match(debug, /RESOLVER_DEBUG='true'/);
    assert.match(debug, /USE_MOCK_LAYOUT_SERVICE='false'/);
    assert.match(debug, /SITECORE_INTERNAL_EDITING_HOST_URL='http:\/\/localhost:3000'/);
    await mode('live');
    assert.match(await fs.readFile(envPath, 'utf8'), /RESOLVER_DEBUG='false'/);
    await mode('mock-debug');
    assert.match(await fs.readFile(envPath, 'utf8'), /USE_MOCK_LAYOUT_SERVICE='true'/);
    await run('env-file.mjs', { appPath, updates: { SITECORE_EDITING_SECRET: '' } });
    const before = await fs.readFile(envPath, 'utf8');
    await fails('../../sitecore/scripts/configure-dev-mode.js', { appPath, mode: 'live-debug', envScript: path.join(root, 'env-file.mjs') });
    assert.equal(await fs.readFile(envPath, 'utf8'), before);
  } finally { await fs.rm(appPath, { recursive: true, force: true }); }
});
