import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./analyze-styles.mjs', import.meta.url));
async function fixture(t, files = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'style-sample-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source with spaces');
  await mkdir(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const output = path.join(dir, 'reports', 'source.json');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, '--output', output, ...args], { encoding: 'utf8' });
  return { dir, root, output, run };
}

test('help explains the executable contract without requiring analysis dependencies', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--root/);
  assert.match(result.stdout, /--mvc-analysis/);
});

test('writes repeatable evidence, returns only a summary, and leaves source untouched', async t => {
  const source = "import './site.scss';\nexport default () => <main/>;";
  const f = await fixture(t, { 'src/App.tsx': source, 'src/site.scss': '$brand: red;\n.a { color: $brand; }', 'node_modules/skip.css': ':root { --hidden: 1; }' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  const summary = JSON.parse(result.stdout);
  assert.equal(report.scan.filesRead, 2);
  assert.equal(report.scan.complete, true);
  assert.equal(report.cssFiles.total, 1);
  assert.equal(report.cssImports.some(i => i.file === './src/App.tsx' && i.path === './site.scss' && i.line === 1), true);
  assert.equal(summary.destination, f.output);
  assert.equal(summary.cssImports, undefined);
  assert.equal(await readFile(path.join(f.root, 'src/App.tsx'), 'utf8'), source);
  const second = path.join(f.dir, 'second.json');
  const again = spawnSync(process.execPath, [script, '--root', f.root, '--output', second], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await readFile(f.output, 'utf8'), await readFile(second, 'utf8'));
});

test('marks capped scans partial and scans paths in stable order', async t => {
  const f = await fixture(t, { 'z.css': '.z{}', 'a.css': '.a{}' });
  const result = f.run('--max-files', '1');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.scan.filesRead, 1);
  assert.equal(report.scan.filesMatched, 2);
  assert.equal(report.cssFiles.largestFiles[0].path, './a.css');
});

test('does not traverse symlinks or read oversized inputs and reports omissions', async t => {
  const f = await fixture(t, { 'large.css': 'x'.repeat(100), 'small.css': '.a{}' });
  await writeFile(path.join(f.dir, 'outside.css'), ':root { --secret: 1; }');
  await symlink(path.join(f.dir, 'outside.css'), path.join(f.root, 'linked.css'));
  const result = f.run('--max-file-bytes', '50');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.scan.filesRead, 1);
  assert.deepEqual(report.scan.omissions.map(o => o.reason).sort(), ['file-too-large', 'symlink']);
});

test('missing roots and invalid limits fail without producing a report', async t => {
  const f = await fixture(t);
  for (const args of [['--max-files', '0'], ['--max-files', '1.5'], ['--max-file-bytes', '-1'], ['--source-kind', 'unknown'], ['--surprise', 'yes']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).success, false);
  }
  const result = spawnSync(process.execPath, [script, '--root', path.join(f.dir, 'missing'), '--output', f.output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('protects source trees, symlink destinations, and existing reports', async t => {
  const f = await fixture(t, { 'a.css': '.a{}' });
  const original = path.join(f.root, 'original.json');
  await writeFile(original, 'keep');
  await symlink(f.root, path.join(f.dir, 'source-link'));
  for (const output of [original, path.join(f.root, 'new.json'), path.join(f.dir, 'source-link', 'escaped.json')]) {
    const result = spawnSync(process.execPath, [script, '--root', f.root, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 1);
  }
  assert.equal(await readFile(original, 'utf8'), 'keep');
  await mkdir(path.dirname(f.output));
  await writeFile(f.output, 'prior report');
  assert.equal(f.run().status, 1);
  assert.equal(await readFile(f.output, 'utf8'), 'prior report');
});

test('empty source is distinguishable from an unavailable source', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.primarySystem, 'none');
  assert.equal(report.scan.complete, true);
  assert.equal(report.scan.filesRead, 0);
});

test('MVC without staged evidence is explicitly incomplete; malformed evidence fails', async t => {
  const f = await fixture(t, { 'a.css': '.a{}' });
  assert.equal(f.run('--source-kind', 'mvc').status, 0);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.evidence.some(e => e.includes('MVC style references unavailable')), true);
  const malformed = path.join(f.dir, 'bad.json');
  await writeFile(malformed, '{"result":{"styleReferences":{}}}');
  const result = spawnSync(process.execPath, [script, '--root', f.root, '--output', path.join(f.dir, 'bad-output.json'), '--source-kind', 'mvc', '--mvc-analysis', malformed], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  await assert.rejects(readFile(path.join(f.dir, 'bad-output.json')), { code: 'ENOENT' });
});

test('parse failures are reported as partial rather than a clean absence of imports', async t => {
  const f = await fixture(t, { 'broken.tsx': 'export const = ;', 'good.css': '.a{}', 'package.json': '{invalid' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, false);
  assert.equal(report.scan.omissions.some(o => o.file === './broken.tsx' && o.reason === 'parse-error'), true);
  assert.equal(report.scan.omissions.some(o => o.file === './package.json' && o.reason === 'invalid-package-json'), true);
  assert.equal(report.cssFiles.total, 1);
});

test('headless mode preserves cross-cutting evidence in the saved file', async t => {
  const f = await fixture(t, { 'Layout.tsx': 'export default () => <body className={props.className}><link rel="stylesheet" href="https://example.test/site.css"/><div style={props.styles}/></body>;' });
  const result = f.run('--source-kind', 'headless');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).crossCutting, { externalStylesheets: 1, serverInjectedBodyClasses: 1, dynamicStyleAttributes: 1, externallyCoupledPartials: 0 });
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.externalStylesheets[0].foundIn.file, './Layout.tsx');
  assert.equal(report.scan.complete, true);
});

test('MVC mode merges staged bundle and Razor evidence without rewriting its source', async t => {
  const f = await fixture(t, { 'site.scss': '.a{}' });
  const rawPath = path.join(f.dir, 'roslyn.json');
  const raw = JSON.stringify({ result: { styleReferences: { bundleConfigs: [{ bundles: [{ virtualPath: '~/bundles/main', includes: ['~/Content/base.css', '~/Content/site.css'] }] }], razorStyleRefs: [{ filePath: 'Views/Layout.cshtml', linkTags: [], stylesRenders: ['~/bundles/main'], hasStylesSection: true }] } } });
  await writeFile(rawPath, raw);
  const result = f.run('--source-kind', 'mvc', '--mvc-analysis', rawPath);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.scan.complete, true);
  assert.deepEqual(report.mvc.bundleConfigs[0].includes, ['~/Content/base.css', '~/Content/site.css']);
  assert.deepEqual(report.mvc.sectionStyles, ['Views/Layout.cshtml']);
  assert.equal(await readFile(rawPath, 'utf8'), raw);
});

const validMvcRefs = () => ({
  bundleConfigs: [{ filePath: 'BundleConfig.cs', bundles: [{ virtualPath: '~/site', includes: ['~/site.css'], bundleType: 'StyleBundle' }] }],
  razorStyleRefs: [{ filePath: 'Layout.cshtml', linkTags: ['/site.css'], stylesRenders: ['~/site'], hasStylesSection: false }],
  buildToolFiles: ['gulpfile.js'],
  razorBodyClasses: [{ filePath: 'Layout.cshtml', expression: '@Model.Class', staticClasses: [] }],
  razorInlineStyleAttrs: [{ filePath: 'Hero.cshtml', lineNumber: 1, tag: 'div', expression: '@Model.Color' }],
  cssStringViewModelProps: [{ filePath: 'Hero.cs', className: 'Hero', propertyName: 'Color' }],
});

test('MVC rejects malformed nested evidence with a field-specific JSON error and no report', async t => {
  const invalid = [
    ['bundleConfigs[0]', null],
    ['bundleConfigs[0].bundles', {}],
    ['bundleConfigs[0].bundles[0]', {}],
    ['bundleConfigs[0].bundles[0].virtualPath', undefined],
    ['bundleConfigs[0].bundles[0].includes', undefined],
    ['bundleConfigs[0].bundles[0].includes[0]', 1],
    ['bundleConfigs[0].filePath', false],
    ['bundleConfigs[0].bundles[0].bundleType', 1],
    ['razorStyleRefs[0]', []],
    ['razorStyleRefs[0].filePath', undefined],
    ['razorStyleRefs[0].linkTags', undefined],
    ['razorStyleRefs[0].linkTags[0]', {}],
    ['razorStyleRefs[0].stylesRenders', 'site'],
    ['razorStyleRefs[0].stylesRenders[0]', null],
    ['razorStyleRefs[0].hasStylesSection', 'false'],
    ['buildToolFiles', {}],
    ['buildToolFiles[0]', 1],
    ['razorBodyClasses', null],
    ['razorBodyClasses[0]', null],
    ['razorBodyClasses[0].filePath', undefined],
    ['razorBodyClasses[0].expression', undefined],
    ['razorBodyClasses[0].staticClasses', undefined],
    ['razorBodyClasses[0].staticClasses[0]', false],
    ['razorBodyClasses[0].conditionHint', {}],
    ['razorInlineStyleAttrs', {}],
    ['razorInlineStyleAttrs[0].filePath', null],
    ['razorInlineStyleAttrs[0].tag', undefined],
    ['razorInlineStyleAttrs[0].expression', 4],
    ['razorInlineStyleAttrs[0].lineNumber', '1'],
    ['razorInlineStyleAttrs[0].lineNumber', 0],
    ['razorInlineStyleAttrs[0].lineNumber', 1.5],
    ['razorInlineStyleAttrs[0].viewModelProperty', false],
    ['cssStringViewModelProps', 'bad'],
    ['cssStringViewModelProps[0]', []],
    ['cssStringViewModelProps[0].propertyName', undefined],
    ['cssStringViewModelProps[0].consumedByView', 1],
    ['cssStringViewModelProps[0].filePath', {}],
    ['cssStringViewModelProps[0].className', false],
  ];
  for (const [field, value] of invalid) {
    await t.test(`${field} = ${JSON.stringify(value)}`, async t => {
      const f = await fixture(t);
      const refs = validMvcRefs();
      const keys = field.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = refs;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)] = value;
      const artifact = path.join(f.dir, 'roslyn.json');
      await writeFile(artifact, JSON.stringify({ result: { styleReferences: refs } }));
      const result = f.run('--source-kind', 'mvc', '--mvc-analysis', artifact);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stdout, '');
      const error = JSON.parse(result.stderr);
      assert.equal(error.success, false);
      assert.ok(error.error.includes(`result.styleReferences.${field}`), error.error);
      await assert.rejects(readFile(f.output), { code: 'ENOENT' });
    });
  }
});

test('MVC accepts omitted legacy fields, nullable hints, and unknown extensions', async t => {
  for (const full of [false, true]) {
    await t.test(full ? 'nullable optional hints and metadata' : 'minimal legacy payload', async t => {
      const f = await fixture(t);
      const refs = full ? validMvcRefs() : { bundleConfigs: [], razorStyleRefs: [] };
      refs.futureField = { arbitrary: true };
      if (full) {
        refs.razorBodyClasses[0].conditionHint = null;
        refs.razorInlineStyleAttrs[0].viewModelProperty = null;
        refs.cssStringViewModelProps[0].consumedByView = null;
        refs.bundleConfigs[0].bundles[0].futureField = [];
      }
      const artifact = path.join(f.dir, 'roslyn.json');
      await writeFile(artifact, JSON.stringify({ result: { styleReferences: refs } }));
      const result = f.run('--source-kind', 'mvc', '--mvc-analysis', artifact);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(await readFile(f.output, 'utf8')).scan.complete, true);
    });
  }
});
