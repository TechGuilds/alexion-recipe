import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProvider, providerRegistry } from '../scripts/operation-providers.mjs';

const scripts = new URL('../scripts/', import.meta.url);
const skills = new URL('../../', import.meta.url);

test('shared cms-migration scripts do not name optional provider skills', async () => {
  for (const entry of await readdir(scripts, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const text = await readFile(new URL(entry.name, scripts), 'utf8');
    for (const { skill } of (await providerRegistry()).providers)
      assert.ok(!text.includes(skill), `${entry.name} must reach ${skill} through the profile registry`);
  }
});

test('every registered provider exists and exports the hooks the shared scripts call', async () => {
  const { providers } = await providerRegistry();
  assert.ok(providers.length > 0);
  const ids = new Set();
  for (const entry of providers) {
    assert.ok(!ids.has(entry.id), 'duplicate provider ' + entry.id);
    ids.add(entry.id);
    await access(new URL(`${entry.skill}/${entry.module}`, skills));
    const { module } = await loadProvider(entry);
    for (const hook of ['operationCatalog', 'completedTasks', 'packetMetadata', 'replayEvidence'])
      assert.equal(typeof module[hook], 'function', `${entry.id} must export ${hook}`);
    if (entry.replayTaskIds?.length) assert.equal(typeof module.requireReplay, 'function', `${entry.id} must export requireReplay`);
    const catalog = await module.operationCatalog();
    for (const id of entry.replayTaskIds ?? []) assert.ok(catalog.tasks.some(task => task.id === id), `${entry.id} replay task ${id} is not in its catalog`);
  }
});

test('a registered provider whose skill is not staged fails with a clear error', async () => {
  await assert.rejects(
    loadProvider({ id: 'missing-provider', skill: 'not-a-staged-skill', module: 'scripts/workflow-provider.mjs' }),
    /Operation provider skill "not-a-staged-skill" is not available/,
  );
});

test('a new provider loads from its own skill without changing shared scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-root-'));
  try {
    await mkdir(join(root, 'extra-skill', 'scripts'), { recursive: true });
    await writeFile(join(root, 'extra-skill', 'scripts', 'workflow-provider.mjs'), 'export const operationCatalog = async () => ({ tasks: [] });\n');
    const { entry, module } = await loadProvider({ id: 'extra-provider', skill: 'extra-skill', module: 'scripts/workflow-provider.mjs' }, { root: pathToFileURL(root + '/') });
    assert.equal(entry.id, 'extra-provider');
    assert.deepEqual(await module.operationCatalog(), { tasks: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
