import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { preparePresentationBatches } from '../scripts/analysis/prepare-presentation-batches.mjs';

const device = 'fe5d7fdf-64b8-446f-a16c-12cea264723b';
async function fixture(t, count = 795) {
  const root = await mkdtemp(join(process.cwd(), '.tmp-presentation-batches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`, path: `/sitecore/content/Example/Home/What's next, ${index}?`.replace('?', '!'),
    language: 'fr', version: '2', hasPresentation: true,
  }));
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(root, 'items.jsonl'), bytes);
  const manifest = { kind: 'kajoo-export', version: 1, files: [{ name: 'items.jsonl', size: bytes.length }], summary: {
    visited: count, partial: false, limited: false, errorCount: 0,
    scope: { sitePath: '/sitecore/content/Example', database: 'master', languages: ['fr'], version: 'latest' },
  } };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest, input: { version: 1, inventory: { records: 'items.jsonl', manifest: 'manifest.json' },
    scope: { siteRoot: '/sitecore/content/Example', database: 'master', languages: ['fr'], versions: ['latest'], devices: [device] } } };
}

test('builds exact bounded requests from retained inventory without retyping paths or scripts', async t => {
  const { root, input } = await fixture(t);
  const result = await preparePresentationBatches(input, { base: root, output: join(root, 'requests') });
  assert.deepEqual(result.batches.map(batch => batch.itemPaths), [200, 200, 200, 195]);
  assert.equal(result.expectedPresentationRecords, 795);
  const requests = await Promise.all(result.batches.map(async batch => JSON.parse(await readFile(join(root, 'requests', batch.request), 'utf8'))));
  assert.equal(new Set(requests.flatMap(r => r.parameters.ItemPaths)).size, 795);
  for (const r of requests) {
    assert.deepEqual(r.parameters.Languages, ['fr']);
    assert.deepEqual(r.parameters.Devices, [device]);
    assert.equal(r.parameters.Database, 'master');
    assert.equal(r.parameters.Version, 'latest');
    assert.equal(r.background, true);
    assert.equal(r.output.mode, 'files');
    assert.match(r.script, /Get-KajooOccurrences/);
  }
  assert.ok(result.inventory.every(p => /^[a-f0-9]{64}$/.test(p.sha256)));
  await assert.rejects(preparePresentationBatches(input, { base: root, output: join(root, 'requests') }), /exists/);
});

test('rejects incomplete inventory, mismatched scope and unsafe batches before writing requests', async t => {
  const { root, input, manifest } = await fixture(t, 1);
  const run = value => preparePresentationBatches(value, { base: root, output: join(root, 'requests') });
  await assert.rejects(run({ ...input, batchSize: 0 }), /batchSize/);
  await assert.rejects(run({ ...input, scope: { ...input.scope, devices: ['Default'] } }), /device/i);
  await assert.rejects(run({ ...input, scope: { ...input.scope, languages: ['en'] } }), /scope/i);
  manifest.summary.partial = true;
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(run(input), /partial/i);
});

test('supports a verified no-presentation inventory without manufacturing a request', async t => {
  const { root, input, manifest } = await fixture(t, 1);
  const rows = (await readFile(join(root, 'items.jsonl'), 'utf8')).replace('"hasPresentation":true', '"hasPresentation":false');
  await writeFile(join(root, 'items.jsonl'), rows);
  manifest.files[0].size = Buffer.byteLength(rows);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const result = await preparePresentationBatches(input, { base: root, output: join(root, 'requests') });
  assert.equal(result.batches.length, 0);
  assert.equal(result.expectedPresentationRecords, 0);
});

test('counts every language/version/device identity without duplicating path requests', async t => {
  const { root, input, manifest } = await fixture(t, 201);
  const original = (await readFile(join(root, 'items.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const rows = original.flatMap(row => [row, { ...row, version: '1' }, { ...row, language: 'en' }]);
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(root, 'items.jsonl'), bytes);
  manifest.files[0].size = bytes.length;
  manifest.summary.visited = rows.length;
  manifest.summary.scope.languages = ['fr', 'en'];
  manifest.summary.scope.version = '*';
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  input.scope.languages = ['fr', 'en'];
  input.scope.versions = ['*'];
  input.scope.devices.push('00000000-0000-0000-0000-000000000001');
  const result = await preparePresentationBatches(input, { base: root, output: join(root, 'requests') });
  assert.equal(result.expectedPresentationRecords, 201 * 3 * 2);
  assert.deepEqual(result.batches.map(b => b.itemPaths), [200, 1, 200, 1, 200, 1]);
  const first = JSON.parse(await readFile(join(root, 'requests', result.batches[0].request), 'utf8'));
  assert.equal(first.parameters.MaxItems, 200);
  assert.deepEqual(first.parameters.Languages, ['en']);
  assert.equal(first.parameters.Version, '2');
});

test('does not request non-page language/version siblings or exhaust the cap on them', async t => {
  const { root, input, manifest } = await fixture(t, 1);
  const [page] = (await readFile(join(root, 'items.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const rows = [page, { ...page, language: 'en', hasPresentation: false }, { ...page, version: '1', hasPresentation: false }];
  const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(join(root, 'items.jsonl'), bytes);
  manifest.files[0].size = Buffer.byteLength(bytes);
  manifest.summary.visited = rows.length;
  manifest.summary.scope.languages = ['en', 'fr'];
  manifest.summary.scope.version = '*';
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  input.scope.languages = ['en', 'fr']; input.scope.versions = ['*'];
  const result = await preparePresentationBatches(input, { base: root, output: join(root, 'requests') });
  assert.equal(result.expectedPresentationRecords, 1);
  const selected = [];
  for (const batch of result.batches) {
    const { parameters: p } = JSON.parse(await readFile(join(root, 'requests', batch.request), 'utf8'));
    const matches = rows.filter(row => p.ItemPaths.includes(row.path) && p.Languages.includes(row.language) && (p.Version === '*' || p.Version === String(row.version)));
    assert.equal(matches.length, p.MaxItems);
    selected.push(...matches);
  }
  assert.deepEqual(selected, [page]);
});

test('rejects an absent inventory and contradictory latest-version or path identities', async t => {
  const { root, input, manifest } = await fixture(t, 1);
  const run = value => preparePresentationBatches(value, { base: root, output: join(root, 'requests') });
  await assert.rejects(run({ ...input, inventory: [] }), /inventory/i);
  const [page] = (await readFile(join(root, 'items.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const conflicting of [{ ...page, version: '1' }, { ...page, id: 'different-item' }]) {
    const bytes = [page, conflicting].map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(join(root, 'items.jsonl'), bytes);
    manifest.files[0].size = Buffer.byteLength(bytes);
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(run(input), /latest|ambiguous/i);
  }
});


test('creates missing project scratch parents and preserves existing request batches', async t => {
  const { root, input } = await fixture(t, 1);
  const output = join(root, '.kajoo', 'project-a', 'tmp', 'presentation-attempt-1');
  const result = await preparePresentationBatches(input, { base: root, output });
  const manifestPath = join(output, 'batch-manifest.json');
  const original = await readFile(manifestPath, 'utf8');
  assert.equal(JSON.parse(original).batches.length, 1);
  assert.equal(JSON.parse(await readFile(join(output, result.batches[0].request), 'utf8')).output.mode, 'files');
  await assert.rejects(preparePresentationBatches(input, { base: root, output }), /exists/);
  assert.equal(await readFile(manifestPath, 'utf8'), original);
  await assert.rejects(readFile(join(root, '.kajoo', 'tmp', 'batch-manifest.json')), { code: 'ENOENT' });
});
