import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFiles } from './parser.mjs';
import { inventory } from './source.mjs';
import { analyzeFiles } from './core.mjs';
import { detectJSCSSImports } from '../styles/detectors/js-css-import-detector.mjs';

const cast = `import './app.scss';
export function check(context: Context) { return (<Context>context).req !== undefined; }
export interface Plugin { order: number; }`;

test('TypeScript angle assertions do not become JSX in source, layout or style analysis', async () => {
  const files = [{ path: '/project/src/page-props-factory/index.ts', content: cast },
    { path: '/project/src/Card.tsx', content: 'export const Card = () => <main/>;' }];
  assert.deepEqual(inventory(files, { rootPath: '/project' }).parseWarnings, []);
  for (const framework of ['jss', 'content-sdk']) {
    assert.deepEqual((await analyzeFiles(files, { rootPath: '/project', framework })).parseWarnings, []);
  }
  const warnings = [];
  assert.equal(detectJSCSSImports(files, warnings).length, 1);
  assert.deepEqual(warnings, []);
});

test('parser preserves real TSX failures, JSX in JS, and file-specific syntax for identical bytes', () => {
  const files = [
    { path: '/project/good.ts', content: cast },
    { path: '/project/bad.tsx', content: cast },
    { path: '/project/component.js', content: 'export const Card = () => <main/>;' },
    { path: '/project/broken.ts', content: 'export const broken = ;' },
  ];
  const result = inventory(files, { rootPath: '/project' });
  assert.deepEqual(result.parseWarnings.map(w => w.file), ['./bad.tsx', './broken.ts']);
  assert.equal(result.files.find(f => f.path === './good.ts').parsed, true);
  assert.equal(result.files.find(f => f.path === './bad.tsx').parsed, false);
  assert.ok(result.components.some(c => c.file === './component.js'));
  assert.equal(result.graphComplete, false);
});

test('plain TS accepts assertions; module TS rejects ambiguous assertions', () => {
  const files = ['plain.ts', 'module.mts', 'common.cts'].map(name => ({ path: `/project/${name}`, content: cast }));
  const result = parseFiles(files, { rootPath: '/project' });
  assert.deepEqual(result.parseWarnings.map(w => w.file), ['./module.mts', './common.cts']);
});
