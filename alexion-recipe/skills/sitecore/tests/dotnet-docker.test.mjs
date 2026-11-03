import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, cp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/analysis/analyze-dotnet.mjs', import.meta.url));
const dockerfile = fileURLToPath(new URL('./dotnet.Dockerfile', import.meta.url));
const docker = process.env.DOCKER_EXECUTABLE || '/usr/local/bin/docker';
let image;
before(async () => {
  assert.ok(process.env.ROSLYN_SOURCE_ROOT, 'Set ROSLYN_SOURCE_ROOT to the retained deps/roslyn-analyzer directory; real integration is mandatory, not skipped');
  const tag = `kajoo-dotnet-local-test:${process.pid}`;
  const context = await mkdtemp(path.join(tmpdir(), 'dotnet-build-'));
  try {
    await cp(process.env.ROSLYN_SOURCE_ROOT, context, { recursive: true, filter: file => !['bin', 'obj', '.publish'].includes(path.basename(file)) });
    await cp(new URL('./dotnet.packages.lock.json', import.meta.url), path.join(context, 'packages.lock.json'));
    const build = spawnSync(docker, ['build', '-f', dockerfile, '-t', tag, context], { encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(build.status, 0, build.stderr);
  } finally { await rm(context, { recursive: true, force: true }); }
  const inspect = spawnSync(docker, ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  image = inspect.stdout.trim();
  console.log(`Real Roslyn test image: ${image}`);
});

async function fixture(t, files = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'dotnet-real-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source with spaces; literal-$()');
  await mkdir(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const output = path.join(dir, 'analysis.json');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, '--output', output, '--runtime', 'docker', '--executable', docker, '--image', image, '--assembly', '/app/roslyn-analyzer.dll', ...args], { encoding: 'utf8', timeout: 30000 });
  const report = async () => JSON.parse(await readFile(output, 'utf8'));
  return { dir, root, output, run, report };
}

test('real Roslyn C#/Razor output survives alongside qualified rendering/view/model joins', async t => {
  const files = {
    'Controllers/HeroController.cs': 'using System.Web.Mvc; namespace Feature { public class HeroController : Controller { public ActionResult Index() { return View("~/Views/Hero/Index.cshtml", new Feature.Hero()); } public ActionResult Dynamic(string viewName) { return View(viewName); } } }',
    'Other/HeroController.cs': 'using System.Web.Mvc; namespace Other { public class HeroController : Controller { public ActionResult Index() { return View(); } } }',
    'Models/Hero.cs': 'namespace Feature { public class Hero { public string Title { get; set; } public string Template { get; set; } } }',
    'Models/OtherHero.cs': 'namespace Other { public class Hero { public string Other { get; set; } } }',
    'Views/Hero/Index.cshtml': '@model Feature.Hero\n<h1>@Model.Title</h1>\n@Html.Sitecore().Field("Título")\n@Html.Sitecore().Placeholder("main")\n@Html.Partial(Model.Template)\n@Html.Partial("_Card")',
    'Views/Shared/_Card.cshtml': '<article>Card</article>',
    'Views/Other/Index.cshtml': '@model Other.Hero\n@Model.Other',
    'Resolvers/CardResolver.cs': 'namespace Feature { public class CardResolver : RenderingContentsResolver { public object ResolveContents() { return new { title = "value" }; } } }',
    'App_Config/Include/site.config': '<configuration><sitecore><settings><setting name="Test" value="Value" /></settings></sitecore></configuration>',
  };
  const f = await fixture(t, files);
  const catalog = path.join(f.dir, 'renderings.json');
  await writeFile(catalog, JSON.stringify({ renderings: [
    { id: 'one', name: 'Hero', controller_class: 'Feature.HeroController, Feature', controller_action: 'Index' },
    { id: 'two', name: 'Hero', controller_class: 'Hero', controller_action: 'Index' },
    { id: 'three', name: 'Dynamic', controller_class: 'Feature.HeroController', controller_action: 'Dynamic' },
  ] }));
  const run = f.run('--catalog', catalog, '--revision', 'fixture');
  assert.equal(run.status, 0, run.stderr);
  const report = await f.report();
  assert.equal(report.result.controllers.length, 2);
  assert.equal(report.result.razorViews.length, 3);
  assert.ok(report.result.contentResolvers.some(r => r.className === 'CardResolver'));
  assert.ok(report.result.controllers[0].actions[0].sourceText);
  assert.ok(report.result.razorViews.find(v => v.filePath === 'Views/Hero/Index.cshtml').hazards.fields[0].line > 0);
  assert.equal(report.mapping.renderings[0].controller.namespace, 'Feature');
  assert.equal(report.mapping.renderings[0].viewModel.className, 'Feature.Hero');
  assert.ok(report.mapping.renderings[0].fields.includes('Título'));
  assert.ok(report.mapping.renderings[1].diagnostics.some(d => d.code === 'ambiguous-controller'));
  assert.ok(report.mapping.renderings[2].diagnostics.some(d => d.code === 'view-selection-unverified'));
  assert.ok(report.mapping.diagnostics.some(d => d.code === 'dynamic-razor-reference'));
  assert.equal(report.scan.complete, true);
  assert.equal(report.complete, false);
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(f.root, name), 'utf8'), content);
  assert.equal(f.run('--catalog', catalog).status, 1);
});

test('empty source remains real Roslyn evidence and missing catalog is explicit', async t => {
  const f = await fixture(t);
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  const report = await f.report();
  assert.equal(report.result.meta.csFiles, 0);
  assert.deepEqual(report.result.controllers, []);
  assert.equal(report.mapping.status, 'skipped');
  assert.ok(report.diagnostics.some(d => d.code === 'no-csharp-foundation'));
});

test('bounded snapshot excludes symlinks/generated code and reports caps without modifying inputs', async t => {
  const f = await fixture(t, { 'a.cs': 'public class AController {}', 'z.cs': ' '.repeat(1000), 'obj/Ignored.cs': 'public class IgnoredController {}' });
  await symlink(f.root, path.join(f.root, 'loop'));
  await symlink(path.join(f.root, 'a.cs'), path.join(f.root, 'alias.cs'));
  const run = f.run('--max-file-bytes', '100');
  assert.equal(run.status, 0, run.stderr);
  const report = await f.report();
  assert.deepEqual(report.result.controllers.map(c => c.className), ['AController']);
  assert.equal(report.scan.complete, false);
  assert.deepEqual(report.scan.omissions.map(o => o.reason).sort(), ['file-too-large', 'symlink', 'symlink']);
  const output = path.join(f.dir, 'capped.json');
  assert.equal(f.run('--output', output, '--max-files', '1').status, 0);
  assert.ok(JSON.parse(await readFile(output, 'utf8')).scan.omissions.some(o => o.reason === 'max-files'));
});

test('SPE JSONL catalog identities and repeated language/version rows survive the join', async t => {
  const f = await fixture(t, { 'Views/Héro.cshtml': '<h1>Bonjour</h1>' });
  const catalog = path.join(f.dir, 'renderings.jsonl');
  const rows = ['fr', 'en'].map(language => ({ id: 'same-id', name: 'Héro', path: '/sitecore/layout/Renderings/Héro', templateName: 'View rendering', language, version: '1', fields: { Path: '~/Views/Héro.cshtml', Controller: null } }));
  await writeFile(catalog, rows.map(row => JSON.stringify(row)).join('\n'));
  const run = f.run('--catalog', catalog);
  assert.equal(run.status, 0, run.stderr);
  const report = await f.report();
  assert.equal(report.mapping.renderings.length, 2);
  assert.deepEqual(report.mapping.renderings.map(r => r.catalogRecord?.language), ['fr', 'en']);
  assert.equal(report.mapping.renderings[0].view.filePath, 'Views/Héro.cshtml');
  assert.ok(report.mapping.diagnostics.some(d => d.code === 'duplicate-rendering-id'));
});
