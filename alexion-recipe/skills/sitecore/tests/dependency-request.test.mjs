import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareDependencyRequest } from '../scripts/analysis/prepare-dependency-request.mjs';

function fixture(t) {
  const base = mkdtempSync(join(process.cwd(), '.tmp-dependency-request-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const scope = { siteRoot: '/sitecore/content/Tenant/Acme', database: 'master', languages: ['en'], versions: ['latest'], devices: ['{00000000-0000-0000-0000-000000000090}'] };
  const input = { version: 1, scope, inventory: { records: 'items.jsonl', manifest: 'items-manifest.json' }, renderings: { records: 'renderings.jsonl', manifest: 'renderings-manifest.json' }, maxItems: 20000 };
  const put = (name, value) => writeFileSync(join(base, name), typeof value === 'string' ? value : JSON.stringify(value));
  put('items.jsonl', JSON.stringify({ id: '{00000000-0000-0000-0000-000000000001}', language: 'en', version: '1', path: scope.siteRoot, hasPresentation: false }) + '\n');
  put('renderings.jsonl', JSON.stringify({ id: '{00000000-0000-0000-0000-000000000002}', language: 'en', version: '1', path: '/sitecore/layout/Renderings/Feature/Acme/Hero' }) + '\n');
  for (const name of ['items', 'renderings']) put(name + '-manifest.json', { kind: 'kajoo-export', version: 1, files: [{ name: name + '.jsonl', size: statSync(join(base, name + '.jsonl')).size }], summary: { visited: 1, partial: false, limited: false, errorCount: 0, scope: { database: scope.database, languages: scope.languages, version: 'latest', ...(name === 'items' ? { sitePath: scope.siteRoot, includesRoot: true } : { itemPaths: ['/sitecore/layout/Renderings/Feature/Acme'], recurse: true }) } } });
  return { base, input, put };
}

test('builds exact dependency request from verified source/catalog roots with explicit scope', async t => {
  const f = fixture(t);
  const result = await prepareDependencyRequest(f.input, { base: f.base, output: join(f.base, 'prepared') });
  const request = JSON.parse(readFileSync(join(f.base, 'prepared/dependencies-request.json')));
  assert.equal(request.background, true);
  assert.equal(request.parameters.MaxItems, 20000);
  assert.deepEqual(request.parameters.Languages, ['en']);
  assert.equal(request.parameters.Version, 'latest');
  assert.deepEqual(request.parameters.Devices, f.input.scope.devices);
  assert.deepEqual(request.parameters.Seeds, [
    { reference: '/sitecore/content/Tenant', kind: 'content', recursive: false, optional: false },
    { reference: '/sitecore/content/Tenant/Acme', kind: 'content', recursive: true, optional: false },
    { reference: '/sitecore/content/Tenant/Acme/Presentation', kind: 'sxa', recursive: true, optional: true },
    { reference: '/sitecore/layout/Placeholder Settings', kind: 'placeholder', recursive: true, optional: true },
    { reference: '/sitecore/layout/Renderings/Feature/Acme', kind: 'rendering', recursive: true, optional: false },
  ]);
  assert.deepEqual(result.expectedSeeds, request.parameters.Seeds);
  assert.ok(request.script.includes('dependency-items.jsonl'));
  assert.equal(result.expectedInventoryIdentities.length, 1);
  assert.equal(result.expectedRenderingIdentities.length, 1);
  assert.match(result.request.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => prepareDependencyRequest(f.input, { base: f.base, output: join(f.base, 'prepared') }), /exist/i);
});

test('rejects contradictory record counts and latest versions rather than planning from truncated scope', async t => {
  for (const mode of ['count', 'latest']) {
    const f = fixture(t), file = join(f.base, 'items-manifest.json'), manifest = JSON.parse(readFileSync(file));
    manifest.summary.visited = 2;
    if (mode === 'latest') {
      const row = JSON.parse(readFileSync(join(f.base, 'items.jsonl'), 'utf8'));
      f.put('items.jsonl', JSON.stringify(row) + '\n' + JSON.stringify({ ...row, version: '2' }) + '\n');
      manifest.files[0].size = statSync(join(f.base, 'items.jsonl')).size;
    }
    f.put('items-manifest.json', manifest);
    await assert.rejects(() => prepareDependencyRequest(f.input, { base: f.base, output: join(f.base, 'prepared') }), /count|latest/i);
  }
});

test('rejects partial/mismatched captures, escaped rows and missing scope flags', async t => {
  for (const mode of ['partial', 'database', 'root', 'escaped', 'flags']) {
    const f = fixture(t), file = join(f.base, 'items-manifest.json'), manifest = JSON.parse(readFileSync(file));
    if (mode === 'partial') manifest.summary.partial = true;
    if (mode === 'database') manifest.summary.scope.database = 'web';
    if (mode === 'root') manifest.summary.scope.sitePath = '/sitecore/content/Other';
    if (mode === 'flags') delete manifest.summary.errorCount;
    if (mode === 'escaped') { f.put('items.jsonl', JSON.stringify({ id: 'id', language: 'en', version: '1', path: '/sitecore/content/Other' }) + '\n'); manifest.files[0].size = statSync(join(f.base, 'items.jsonl')).size; }
    f.put('items-manifest.json', manifest);
    await assert.rejects(() => prepareDependencyRequest(f.input, { base: f.base, output: join(f.base, 'prepared') }), /partial|scope|outside|flags/i, mode);
  }
});
