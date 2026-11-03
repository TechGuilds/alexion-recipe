import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./plan-style-foundation.mjs', import.meta.url));

const report = (overrides = {}) => ({
  primarySystem: 'sass',
  confidence: 0.9,
  secondarySystems: ['plain-css'],
  scan: { complete: true, omissions: [] },
  configFiles: [{ path: './next.config.mjs', type: 'other', exists: true }],
  dependencies: {
    dependencies: { classnames: '^2.5.0' },
    devDependencies: { sass: '^1.80.0' },
    peerDependencies: {},
  },
  cssImports: [
    { type: 'js-import', file: './src/app/layout.tsx', line: 2, path: '../styles/global.scss', raw: "import '../styles/global.scss';" },
    { type: 'js-import', file: './src/components/Hero.tsx', line: 1, path: './Hero.module.scss', raw: "import styles from './Hero.module.scss';" },
  ],
  cssFiles: { total: 2, byType: { plain: 0, modules: 1, sass: 1, less: 0 }, largestFiles: [] },
  externalStylesheets: [],
  serverInjectedBodyClasses: [],
  dynamicStyleAttributes: [],
  ...overrides,
});

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'style-foundation-plan-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'source');
  const targetRoot = path.join(dir, 'target');
  const evidence = path.join(dir, 'evidence');
  await Promise.all([mkdir(sourceRoot), mkdir(targetRoot), mkdir(evidence)]);
  const sourceAnalysis = path.join(evidence, 'source.json');
  const targetAnalysis = path.join(evidence, 'target.json');
  const output = path.join(evidence, 'style-foundation-plan.json');
  const run = (...args) => spawnSync(process.execPath, [script,
    '--source-analysis', sourceAnalysis,
    '--source-root', sourceRoot,
    '--target-root', targetRoot,
    '--output', output,
    ...args,
  ], { encoding: 'utf8' });
  return { dir, sourceRoot, targetRoot, sourceAnalysis, targetAnalysis, output, run };
}

test('creates a deterministic, bounded foundation handoff from retained reports', async t => {
  const f = await fixture(t);
  await writeFile(f.sourceAnalysis, JSON.stringify(report({
    cssImports: [
      { type: 'js-import', file: './src/z.tsx', line: 3, path: './later.scss', raw: "import './later.scss';" },
      { type: 'js-import', file: './src/app/layout.tsx', line: 2, path: '../styles/global.scss', raw: "import '../styles/global.scss';" },
      { type: 'js-import', file: './src/components/Hero.tsx', line: 1, path: './Hero.module.scss', raw: "import styles from './Hero.module.scss';" },
      { type: 'js-import', file: './src/app/layout.tsx', line: 2, path: '../styles/global.scss', raw: "import '../styles/global.scss';" },
    ],
  })));
  await writeFile(f.targetAnalysis, JSON.stringify(report({
    dependencies: { dependencies: { classnames: '^2.5.0' }, devDependencies: {}, peerDependencies: {} },
    cssImports: [],
  })));

  const result = f.run('--target-analysis', f.targetAnalysis);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const plan = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(summary.success, true);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.input.source.scanComplete, true);
  assert.deepEqual(plan.foundation.globalImportCandidates.map(item => item.path), ['../styles/global.scss', './later.scss']);
  assert.deepEqual(plan.componentLocal.excludedImports.map(item => item.path), ['./Hero.module.scss']);
  assert.deepEqual(plan.dependencies.sourceOnly.map(item => item.name), ['sass']);
  assert.equal(plan.order.requiresLayoutConfirmation, true);
  assert.equal(plan.limitations.some(item => item.code === 'runtime-import-order-unproven'), true);
  assert.equal(plan.input.target.scanComplete, true);
});

test('makes incomplete evidence visible rather than treating it as absence', async t => {
  const f = await fixture(t);
  await writeFile(f.sourceAnalysis, JSON.stringify(report({ scan: { complete: false, omissions: [{ reason: 'max-files', count: 4 }] } })));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(plan.input.source.scanComplete, false);
  assert.deepEqual(plan.limitations.find(item => item.code === 'source-analysis-incomplete').omissions, [{ reason: 'max-files', count: 4 }]);
});

test('rejects malformed reports and leaves no output', async t => {
  const f = await fixture(t);
  await writeFile(f.sourceAnalysis, JSON.stringify({ scan: { complete: true } }));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).success, false);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('protects application roots and existing plan output', async t => {
  const f = await fixture(t);
  await writeFile(f.sourceAnalysis, JSON.stringify(report()));
  const insideSource = spawnSync(process.execPath, [script,
    '--source-analysis', f.sourceAnalysis,
    '--source-root', f.sourceRoot,
    '--target-root', f.targetRoot,
    '--output', path.join(f.sourceRoot, 'plan.json'),
  ], { encoding: 'utf8' });
  assert.equal(insideSource.status, 1);
  await writeFile(f.output, 'keep');
  const existing = f.run();
  assert.equal(existing.status, 1);
  assert.equal(await readFile(f.output, 'utf8'), 'keep');
});
