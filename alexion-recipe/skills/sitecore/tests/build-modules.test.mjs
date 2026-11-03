import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const original = fileURLToPath(new URL('../scripts/serialization/', import.meta.url));
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'build-modules-'));
const copied = path.join(base, 'copied-skill', 'scripts', 'serialization');
fs.cpSync(original, copied, { recursive: true, filter: (p) => !p.includes('node_modules') });
const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: copied, encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);

const { buildModules } = await import(pathToFileURL(path.join(copied, 'build-modules.mjs')));

function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  return { root, input: path.join(root, 'discovery.json'), output: path.join(root, 'out') };
}
function cli(f, items, status = 0) {
  fs.writeFileSync(f.input, JSON.stringify({ items }));
  const result = spawnSync(process.execPath, [path.join(copied, 'build-modules.mjs'), '--input', f.input, '--output-root', f.output], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  return result;
}

// --- Pure function: grouping, scope, warnings, duplicates ---

test('every include gets SingleItem scope, never overlapping by construction', () => {
  const { modules } = buildModules([
    { path: '/sitecore/content/Home', kind: 'content' },
    { path: '/sitecore/content/Home/About', kind: 'content' },
  ]);
  const includes = modules.flatMap((m) => m.items.includes);
  assert.ok(includes.every((i) => i.scope === 'SingleItem'));
  assert.deepEqual(includes.map((i) => i.path).sort(), ['/sitecore/content/Home', '/sitecore/content/Home/About']);
});

test('groups items by kind and path structure into a readable namespace', () => {
  const { modules } = buildModules([{ path: '/sitecore/templates/Project/MySite/Pages/Home', kind: 'template' }]);
  assert.equal(modules.length, 1);
  assert.equal(modules[0].namespace, 'Template.Project.MySite.Pages');
});

test('a single leftover segment (just the site root) does not create a nested namespace', () => {
  const { modules } = buildModules([{ path: '/sitecore/templates/Project', kind: 'template' }]);
  assert.equal(modules[0].namespace, 'Template');
});

test('items with no kind infer one from the path root segment', () => {
  const { modules } = buildModules([{ path: '/sitecore/content/Home' }]);
  assert.equal(modules[0].namespace, 'Content');
});

test('unknown root segments and non-standard paths fall back to a bare kind namespace', () => {
  const { modules } = buildModules([{ path: '/sitecore/media library/Images/logo', kind: 'media' }]);
  assert.equal(modules[0].namespace, 'Media');
});

test('two items in the same grouping key land in one module, not two', () => {
  const { modules } = buildModules([
    { path: '/sitecore/content/Data/Datalayer/Articles/A', kind: 'content' },
    { path: '/sitecore/content/Data/Datalayer/Articles/B', kind: 'content' },
  ]);
  assert.equal(modules.length, 1);
  assert.equal(modules[0].items.includes.length, 2);
});

test('exact-duplicate paths are deduplicated and reported, not double-included', () => {
  const { modules, duplicates } = buildModules([
    { path: '/sitecore/content/Home', kind: 'content' },
    { path: '/sitecore/content/Home', kind: 'content' },
  ]);
  assert.equal(modules.flatMap((m) => m.items.includes).length, 1);
  assert.deepEqual(duplicates, ['/sitecore/content/Home']);
});

test('duplicate detection is case-insensitive', () => {
  const { duplicates } = buildModules([
    { path: '/sitecore/content/Home', kind: 'content' },
    { path: '/sitecore/Content/HOME', kind: 'content' },
  ]);
  assert.equal(duplicates.length, 1);
});

test('flags a known OOTB module path as a warning without dropping it', () => {
  const { modules, warnings } = buildModules([
    { path: '/sitecore/templates/Foundation/Experience Accelerator/Something', kind: 'template' },
  ]);
  assert.equal(modules.flatMap((m) => m.items.includes).length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].matched, 'experience accelerator');
});

test('a normal Feature/Project path is not flagged as OOTB', () => {
  const { warnings } = buildModules([{ path: '/sitecore/templates/Feature/CustomFeature/Data', kind: 'template' }]);
  assert.equal(warnings.length, 0);
});

test('rejects a path outside /sitecore', () => {
  assert.throws(() => buildModules([{ path: '/other/path', kind: 'content' }]), /absolute \/sitecore/);
});

test('rejects path traversal', () => {
  assert.throws(() => buildModules([{ path: '/sitecore/content/../system', kind: 'content' }]), /Unsafe or malformed/);
});

test('rejects an item with an unsupported field', () => {
  assert.throws(() => buildModules([{ path: '/sitecore/content/Home', kind: 'content', rules: [] }]), /unsupported fields/);
});

test('rejects a non-string kind', () => {
  assert.throws(() => buildModules([{ path: '/sitecore/content/Home', kind: 42 }]), /kind must be a string/);
});

// --- CLI: file I/O, exit codes, module.json shape ---

test('writes one .module.json per namespace plus a summary, matching inspect-items.mjs\'s accepted shape', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  cli(f, [
    { path: '/sitecore/content/Home', kind: 'content' },
    { path: '/sitecore/templates/Project/MySite/Data', kind: 'template' },
  ]);
  const summary = JSON.parse(fs.readFileSync(path.join(f.output, 'build-modules.json'), 'utf8'));
  assert.equal(summary.moduleCount, 2);
  assert.equal(summary.itemCount, 2);
  const contentModule = JSON.parse(fs.readFileSync(path.join(f.output, 'Content.module.json'), 'utf8'));
  assert.equal(contentModule.namespace, 'Content');
  assert.deepEqual(contentModule.items.includes, [{
    name: 'item-2b08f28d7aa2175c',
    path: '/sitecore/content/Home',
    scope: 'SingleItem',
  }]);
  // No `rules` key anywhere — this is the actual compatibility contract with core.mjs's inspect().
  assert.ok(!JSON.stringify(contentModule).includes('"rules"'));
});

test('exits 2 (not 1) when duplicates or OOTB warnings are present, but still writes output', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = cli(f, [
    { path: '/sitecore/content/Home', kind: 'content' },
    { path: '/sitecore/content/Home', kind: 'content' },
  ], 2);
  assert.ok(fs.existsSync(path.join(f.output, 'build-modules.json')));
  const summary = JSON.parse(fs.readFileSync(path.join(f.output, 'build-modules.json'), 'utf8'));
  assert.deepEqual(summary.duplicates, ['/sitecore/content/Home']);
});

test('rejects an empty items array', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  cli(f, [], 1);
});

test('refuses to write into an existing output root (exclusive-create)', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  cli(f, [{ path: '/sitecore/content/Home', kind: 'content' }]);
  const result = spawnSync(process.execPath, [path.join(copied, 'build-modules.mjs'), '--input', f.input, '--output-root', f.output], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 1);
});
