import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/analysis/analyze-dotnet.mjs', import.meta.url));
const core = await import(script).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('analyze-dotnet.mjs')) return {};
  throw error;
});
const result = () => ({ controllers: [], razorViews: [], viewModels: [], itemModels: [], glassMapperModels: [], fieldConstants: [], contentResolvers: [], configPatches: [], renderingParameters: [], meta: {} });
const rendering = (id, values = {}) => ({ id, name: 'Duplicate name', path: `/sitecore/layout/Renderings/${id}`, template_name: 'Controller rendering', controller_class: 'Feature.HeroController, Feature', controller_action: 'Index', view_path: null, ...values });

test('joins qualified identities and preserves duplicate rendering names without first-match ambiguity', () => {
  assert.equal(typeof core.joinRenderings, 'function');
  const raw = result();
  raw.controllers = ['Feature', 'Other'].map(namespace => ({ namespace, className: 'HeroController', filePath: `${namespace}/Hero.cs`, actions: [{ name: 'Index', explicitViewName: '~/Views/Hero/Index.cshtml' }] }));
  raw.razorViews = [{ filePath: 'Views/Hero/Index.cshtml', modelDirectiveResolved: 'Feature.Hero', modelDirective: 'Hero' }];
  raw.viewModels = [{ namespace: 'Feature', className: 'Hero', filePath: 'Models/Hero.cs', properties: [{ name: 'Title', type: 'string' }] }];
  const before = structuredClone(raw);
  const joined = core.joinRenderings(raw, [rendering('one'), rendering('two'), rendering('three', { controller_class: 'Hero' })]);
  assert.equal(joined.renderings.length, 3);
  assert.equal(joined.renderings[0].controller.namespace, 'Feature');
  assert.equal(joined.renderings[0].view.filePath, 'Views/Hero/Index.cshtml');
  assert.equal(joined.renderings[0].viewModel.className, 'Feature.Hero');
  assert.equal(joined.renderings[2].controller, null);
  assert.ok(joined.renderings[2].diagnostics.some(d => d.code === 'ambiguous-controller'));
  assert.ok(joined.diagnostics.some(d => d.code === 'duplicate-rendering-name'));
  assert.deepEqual(raw, before);
});

test('overloaded actions, duplicate view suffixes and dynamic raw signals stay unresolved', () => {
  assert.equal(typeof core.joinRenderings, 'function');
  const raw = result();
  raw.controllers = [{ namespace: 'Feature', className: 'HeroController', filePath: 'Hero.cs', actions: [{ name: 'Index' }, { name: 'Index' }] }];
  raw.razorViews = ['A', 'B'].map(prefix => ({ filePath: `${prefix}/Views/Hero/Index.cshtml`, rawHelperInvocations: ['@Html.Partial(Model.Template)'] }));
  const joined = core.joinRenderings(raw, [rendering('overload'), rendering('view', { controller_class: null, view_path: '~/Views/Hero/Index.cshtml' })]);
  assert.ok(joined.renderings[0].diagnostics.some(d => d.code === 'ambiguous-action'));
  assert.equal(joined.renderings[1].view, null);
  assert.ok(joined.renderings[1].diagnostics.some(d => d.code === 'ambiguous-view'));
  assert.ok(joined.diagnostics.some(d => d.code === 'dynamic-razor-reference'));
});

test('shared explicit views and unique Glass interfaces join; conflicting field constants stay unresolved', () => {
  const raw = result();
  raw.controllers = [{ namespace: 'Feature', className: 'HeroController', filePath: 'Hero.cs', actions: [{ name: 'Index', explicitViewName: 'Card', constantFieldAccesses: ['Fields.Title'] }] }];
  raw.razorViews = [{ filePath: 'Views/Shared/Card.cshtml', inheritsDirective: 'GlassView<Feature.ICard>' }];
  raw.glassMapperModels = [{ namespace: 'Feature', interfaceName: 'ICard', filePath: 'ICard.cs', properties: [] }];
  raw.fieldConstants = [{ filePath: 'A.cs', constants: [{ className: 'Fields', fieldName: 'Title', value: 'Title' }] }, { filePath: 'B.cs', constants: [{ className: 'Fields', fieldName: 'Title', value: 'OtherTitle' }] }];
  const joined = core.joinRenderings(raw, [rendering('one')]);
  assert.equal(joined.renderings[0].view?.filePath, 'Views/Shared/Card.cshtml');
  assert.equal(joined.renderings[0].viewModel?.className, 'Feature.ICard');
  assert.deepEqual(joined.renderings[0].fields, []);
  assert.ok(joined.renderings[0].diagnostics.some(d => d.code === 'ambiguous-field-constant'));
});

async function fixture(t, program = 'process.stdout.write("{}");') {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'dotnet-failure-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source');
  await mkdir(root);
  const executable = process.execPath;
  const assembly = path.join(dir, 'fake-runtime.mjs');
  await writeFile(assembly, program);
  const output = path.join(dir, 'analysis.json');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, '--output', output, '--runtime', 'dotnet', '--executable', executable, '--assembly', assembly, ...args], { encoding: 'utf8', timeout: 10000 });
  return { dir, root, output, run };
}

test('help and missing/invalid runtime configuration fail clearly without a fallback', async t => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const f = await fixture(t);
  for (const args of [['--runtime', 'regex'], ['--executable', '/does/not/exist'], ['--max-files', '0'], ['--timeout-ms', '-1'], ['--runtime', 'docker', '--image', 'latest']]) {
    const run = f.run(...args);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(JSON.parse(run.stderr).success, false);
  }
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('nonzero, invalid JSON, wrong schema, timeout and oversized stdout do not create evidence', async t => {
  for (const [program, args, reason] of [
    ['process.stderr.write("real failure"); process.exit(7);', [], 'exit 7'],
    ['process.stdout.write("not json");', [], 'JSON'],
    ['process.stdout.write("{}");', [], 'schema'],
    ['setInterval(() => {}, 1000);', ['--timeout-ms', '100'], 'timeout'],
    ['process.stdout.write("x".repeat(100000));', ['--max-output-bytes', '100'], 'output-limit'],
  ]) {
    const f = await fixture(t, program);
    const run = f.run(...args);
    assert.equal(run.status, 1, run.stderr);
    assert.match(JSON.parse(run.stderr).error, new RegExp(reason));
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  }
});

test('output inside source, alias parents and existing evidence are protected before process execution', async t => {
  const f = await fixture(t, 'process.exit(88)');
  await symlink(f.root, path.join(f.dir, 'alias'));
  for (const output of [path.join(f.root, 'new', 'report.json'), path.join(f.dir, 'alias', 'report.json')]) {
    const run = f.run('--output', output);
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stderr, /exit 88/);
  }
  await writeFile(f.output, 'keep');
  assert.equal(f.run().status, 1);
  assert.equal(await readFile(f.output, 'utf8'), 'keep');
});

test('malformed/partial catalogs and non-directory roots fail before running the analyzer', async t => {
  const f = await fixture(t, 'process.exit(88)');
  const catalog = path.join(f.dir, 'catalog.json');
  for (const content of ['{', '{"status":"failed","renderings":[]}', '{"complete":false,"renderings":[]}', '{"renderings":[{"id":"x","name":"n","controller_class":{}}]}']) {
    await writeFile(catalog, content);
    const run = f.run('--catalog', catalog);
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stderr, /exit 88/);
  }
  assert.equal(f.run('--root', catalog).status, 1);
});

test('final report also respects the output-byte cap after joins and metadata', async t => {
  const f = await fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify(result()))});`);
  const run = f.run('--max-output-bytes', '512');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /output-limit/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
