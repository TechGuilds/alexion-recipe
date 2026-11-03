import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './analyze-usage.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kajoo-layouts-'));
  await mkdir(path.join(root, 'home'), { recursive: true });
  await mkdir(path.join(root, 'products', 'one'), { recursive: true });
  const layout = (name, nested = {}) => JSON.stringify({ sitecore: { route: { placeholders: { 'jss-main': [{ componentName: name, uid: `${name}-uid`, placeholders: nested }] } } } });
  await writeFile(path.join(root, 'home', 'index.json'), layout('Hero', { 'jss-content': [{ componentName: 'Card' }] }));
  await writeFile(path.join(root, 'products', 'one', 'index.json'), layout('Hero', { 'jss-content': [{ componentName: 'Card' }, { componentName: 'Promo' }] }));
  return root;
}

test('analyze-usage preserves route, placeholder and frequency evidence', async () => {
  const layouts = await fixture();
  const output = path.join(await mkdtemp(path.join(tmpdir(), 'kajoo-usage-')), 'usage.json');
  const result = await run({ layouts, output, 'all-routes': true, 'max-files': 10 });
  assert.equal(result.authoritative, true);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.coverage.totalRoutes, 2);
  assert.equal(report.frequencies.find(item => item.componentName === 'Hero').routeCount, 2);
  assert.equal(report.frequencies.find(item => item.componentName === 'Card').routeCount, 2);
  assert.equal(report.occurrences.filter(item => item.placeholder === 'jss-content').length, 3);
});

test('partial/capped capture is never marked authoritative', async () => {
  const layouts = await fixture();
  const output = path.join(await mkdtemp(path.join(tmpdir(), 'kajoo-usage-')), 'usage.json');
  const result = await run({ layouts, output, 'all-routes': true, 'max-files': 1 });
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(report.frequencies.some(item => item.componentName === 'Hero'), 'partial capture still produces useful sample usage');
  assert.equal(report.coverage.authoritative, false);
});
