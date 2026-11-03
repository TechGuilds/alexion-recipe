import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../analyze-source.mjs', import.meta.url));
async function fixture(t, files = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'source-analysis-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source with spaces');
  await mkdir(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const output = path.join(dir, 'report.json');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, '--output', output, ...args], { encoding: 'utf8' });
  const report = async () => JSON.parse(await readFile(output, 'utf8'));
  return { dir, root, output, run, report };
}

test('help works without loading parsers and required arguments are enforced', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--root/);
  assert.equal(spawnSync(process.execPath, [script]).status, 1);
});

test('nested components, barrel exports, aliases, packages and dynamic edges carry coordinates', async t => {
  const source = 'import { Card } from "@/ui";\nimport React from "react";\nexport default function Page(){ return <Card/>; }\nconst lazy = import("./later.js"); const unknown = import(target);';
  const f = await fixture(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'package.json': JSON.stringify({ dependencies: { react: '19.0.0' } }),
    'src/Page.tsx': source,
    'src/ui/index.ts': 'export { Card } from "./Card";',
    'src/ui/Card.tsx': 'export const Card = () => <article/>;',
    'src/later.ts': 'export default 1;',
  });
  const run = f.run('--revision', '0f107ac46');
  assert.equal(run.status, 0, run.stderr);
  const report = await f.report();
  assert.equal(report.scope.revision, '0f107ac46');
  assert.deepEqual(report.components.map(c => [c.file, c.name]), [['./src/Page.tsx', 'Page'], ['./src/ui/Card.tsx', 'Card']]);
  assert.equal(report.components[0].line, 3);
  const edge = report.edges.find(e => e.specifier === '@/ui');
  assert.equal(edge.target, './src/ui/index.ts');
  assert.equal(edge.status, 'resolved');
  assert.equal(edge.line, 1);
  assert.equal(report.edges.find(e => e.specifier === './Card').kind, 're-export');
  assert.equal(report.edges.find(e => e.specifier === './later.js').target, './src/later.ts');
  assert.equal(report.edges.find(e => e.specifier === 'react').status, 'external');
  assert.equal(report.edges.find(e => e.status === 'computed').kind, 'dynamic-import');
  assert.equal(report.graphComplete, false);
  assert.equal(report.scan.complete, true);
  assert.equal(report.packages[0].dependencies.react, '19.0.0');
  assert.equal(await readFile(path.join(f.root, 'src/Page.tsx'), 'utf8'), source);
  assert.equal(f.run().status, 1);
  const second = path.join(f.dir, 'second.json');
  assert.equal(f.run('--output', second, '--revision', '0f107ac46').status, 0);
  assert.equal(await readFile(second, 'utf8'), await readFile(f.output, 'utf8'));
});

test('malformed JS and JSON are explicit while valid source survives', async t => {
  const f = await fixture(t, { 'bad.tsx': 'export const = <;', 'bad.json': '{', 'Good.jsx': 'export function Good(){return <div/>;}' });
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  const report = await f.report();
  assert.equal(report.scan.complete, false);
  assert.deepEqual(report.parseWarnings.map(w => w.code).sort(), ['JSON_PARSE_ERROR', 'JS_PARSE_ERROR']);
  assert.equal(report.components[0].name, 'Good');
});

test('empty root produces an empty complete inventory', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const report = await f.report();
  assert.deepEqual(report.files, []);
  assert.deepEqual(report.edges, []);
  assert.equal(report.scan.complete, true);
});

test('file caps, byte limits, excluded trees and symlinks remain visible', async t => {
  const f = await fixture(t, { 'a.ts': 'export const a = 1;', 'z.ts': ' '.repeat(300), 'node_modules/ignore.ts': 'broken !!!' });
  await symlink(f.root, path.join(f.root, 'loop'));
  await symlink(path.join(f.root, 'a.ts'), path.join(f.root, 'alias.ts'));
  assert.equal(f.run('--max-file-bytes', '100').status, 0);
  const report = await f.report();
  assert.equal(report.scan.filesMatched, 2);
  assert.deepEqual(report.scan.omissions.map(o => o.reason).sort(), ['file-too-large', 'symlink', 'symlink']);
  const capped = path.join(f.dir, 'capped.json');
  assert.equal(f.run('--output', capped, '--max-files', '1').status, 0);
  assert.equal(JSON.parse(await readFile(capped, 'utf8')).scan.omissions.some(o => o.reason === 'max-files'), true);
});

test('invalid options and output aliases never write into source', async t => {
  const f = await fixture(t);
  await symlink(f.root, path.join(f.dir, 'alias'));
  for (const args of [['--max-files', '0'], ['--max-file-bytes', '1.5'], ['--unknown', 'x'], ['--output', path.join(f.root, 'x.json')], ['--output', path.join(f.dir, 'alias', 'x.json')]]) {
    assert.equal(f.run(...args).status, 1, JSON.stringify(args));
  }
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('require, export-all and missing local modules are inventoried without executing code', async t => {
  const f = await fixture(t, { 'index.cjs': 'const x = require("./missing"); module.exports = x;', 'barrel.mts': 'export * from "./index.cjs";' });
  assert.equal(f.run().status, 0);
  const report = await f.report();
  assert.equal(report.edges.find(e => e.kind === 'require').status, 'unresolved');
  assert.equal(report.edges.find(e => e.kind === 're-export').target, './index.cjs');
  assert.equal(report.files.find(f => f.path === './index.cjs').exports[0].name, 'module.exports');
});

test('TypeScript import-equals dependencies and nested CommonJS exports are retained', async t => {
  const f = await fixture(t, { 'index.cts': 'import thing = require("./thing"); module.exports.thing = thing;', 'thing.ts': 'export const thing = 1;' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = await f.report();
  assert.equal(report.edges[0]?.target, './thing.ts');
  assert.equal(report.files[0].exports[0]?.name, 'thing');
});

test('nested config aliases resolve locally; unsupported inheritance and recovered syntax stay partial', async t => {
  const f = await fixture(t, {
    'sub/tsconfig.json': JSON.stringify({ extends: '../base.json', compilerOptions: { paths: { '@local/*': ['./lib/*'] } } }),
    'sub/Page.tsx': 'import { Thing } from "@local/Thing"; const a=1; const a=2; export default () => <Thing/>;',
    'sub/lib/Thing.tsx': 'export const Thing = () => <div/>;',
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = await f.report();
  assert.equal(report.edges[0].target, './sub/lib/Thing.tsx');
  assert.equal(report.components[0].name, 'default');
  assert.equal(report.scan.complete, false);
  assert.equal(report.graphComplete, false);
  assert.equal(report.limitations[0].reason, 'config-inheritance-not-resolved');
});
