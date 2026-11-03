import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./analyze-layout.mjs', import.meta.url));
async function fixture(t, files = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'layout-sample-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source with spaces');
  await mkdir(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const output = path.join(dir, 'reports', 'layout.json');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, '--output', output, '--framework', 'content-sdk', ...args], { encoding: 'utf8' });
  return { dir, root, output, run };
}

test('help is available without loading parser dependencies', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--layouts/);
});

test('ESM and CommonJS source files are parsed, with malformed modules visible', async t => {
  const f = await fixture(t, { 'broken.mjs': 'export const = ;', 'okay.cjs': 'module.exports = {};' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.filesRead, 2);
  assert.equal(report.scan.complete, false);
  assert.equal(report.parseWarnings[0].file, './broken.mjs');
});

test('reports deterministic source analysis without writing source or overwriting evidence', async t => {
  const source = 'export default function Page() { return <main/>; }';
  const f = await fixture(t, { 'src/app/page.tsx': source });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(summary.destination, f.output);
  assert.equal(summary.complete, true);
  assert.equal(report.scan.filesRead, 1);
  assert.equal(report.layoutDistribution, undefined);
  assert.equal(await readFile(path.join(f.root, 'src/app/page.tsx'), 'utf8'), source);
  assert.equal(f.run().status, 1);
  const second = path.join(f.dir, 'second.json');
  assert.equal(f.run('--output', second).status, 0);
  assert.equal(await readFile(second, 'utf8'), await readFile(f.output, 'utf8'));
});

test('caps, oversized inputs and symlinks cannot yield complete analysis', async t => {
  const f = await fixture(t, { 'a.tsx': 'export default () => <main/>;', 'z.tsx': 'x'.repeat(200) });
  await symlink(path.join(f.root, 'a.tsx'), path.join(f.root, 'alias.tsx'));
  const result = f.run('--max-file-bytes', '100');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.deepEqual(report.scan.omissions.map(o => o.reason).sort(), ['file-too-large', 'symlink']);
  const capped = path.join(f.dir, 'capped.json');
  assert.equal(f.run('--output', capped, '--max-files', '1').status, 0);
  assert.equal(JSON.parse(await readFile(capped, 'utf8')).scan.complete, false);
});

test('invalid input and destinations fail without changing existing files', async t => {
  const f = await fixture(t);
  await symlink(f.root, path.join(f.dir, 'alias'));
  for (const args of [['--framework', 'other'], ['--max-files', '0'], ['--max-file-bytes', '1.5'], ['--output', path.join(f.root, 'report.json')], ['--output', path.join(f.dir, 'alias', 'report.json')], ['--layouts', path.join(f.dir, 'missing')]]) {
    assert.equal(f.run(...args).status, 1, JSON.stringify(args));
  }
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('bad TSX is visible while good files remain usable', async t => {
  const f = await fixture(t, { 'good.tsx': 'export default () => <main/>;', 'bad.tsx': 'export default function {' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.scan.omissions.some(o => o.file === './bad.tsx' && o.reason === 'parse-error'), true);
});

test('distribution preserves source view paths and nested routes, distinguishes invalid pages', async t => {
  const f = await fixture(t);
  const layouts = path.join(f.dir, 'mock-layouts');
  const page = (layoutId, layoutFilePath, placeholders) => JSON.stringify({ sitecore: { route: { layoutId, layoutFilePath, placeholders } } });
  const routes = {
    home: page('{A}', '/Views/Default.cshtml', { main: [] }),
    'news/article': page('{A}', '/Views/Default.cshtml', { footer: [] }),
    about: page('{B}', '/Views/Article.cshtml', { other: [] }),
    broken: '{',
    invalid: JSON.stringify({ sitecore: { route: { placeholders: [] } } }),
  };
  for (const [route, json] of Object.entries(routes)) {
    await mkdir(path.join(layouts, route), { recursive: true });
    await writeFile(path.join(layouts, route, 'index.json'), json);
  }
  const result = f.run('--layouts', layouts);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.layoutDistribution.totalPages, 5);
  assert.equal(report.layoutDistribution.pagesAnalyzed, 3);
  assert.equal(report.layoutDistribution.uniqueLayouts, 2);
  assert.deepEqual(report.layoutDistribution.distributions[0], { layoutId: '{A}', layoutFilePath: '/Views/Default.cshtml', pageCount: 2, rootPlaceholders: ['footer', 'main'], sampleRoutes: ['/', '/news/article'] });
  assert.equal(report.layoutDistribution.scan.omissions.length, 2);
  assert.equal(f.run('--layouts', layouts, '--output', path.join(layouts, 'output.json')).status, 1);
});

test('unknown layout ID is retained but identified as incomplete evidence', async t => {
  const f = await fixture(t);
  const layouts = path.join(f.dir, 'layouts');
  await mkdir(path.join(layouts, 'orphan'), { recursive: true });
  await writeFile(path.join(layouts, 'orphan', 'index.json'), JSON.stringify({ sitecore: { route: { placeholders: {} } } }));
  assert.equal(f.run('--layouts', layouts).status, 0);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.layoutDistribution.distributions[0].layoutId, 'unknown');
});
