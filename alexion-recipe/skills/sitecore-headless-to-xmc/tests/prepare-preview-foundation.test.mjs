import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(skill, 'scripts', 'prepare-preview-foundation.mjs');
const run = (...args) => {
  const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: child.status, data: child.stdout ? JSON.parse(child.stdout) : null };
};
const fixture = testContext => {
  const root = mkdtempSync(path.join(tmpdir(), 'preview-foundation-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const writeInputs = root => {
  const target = path.join(root, 'target');
  const evidence = path.join(root, 'evidence');
  mkdirSync(path.join(target, 'src'), { recursive: true });
  mkdirSync(evidence);
  writeFileSync(path.join(target, 'src', 'Layout.tsx'), "export const Layout = () => <main />;\n");
  const capture = path.join(root, 'selected-layout.json');
  writeFileSync(capture, JSON.stringify({
    sitecore: { route: { placeholders: { header: [], main: [], footer: [] } } },
  }));
  return { target, evidence, capture };
};

test('writes a deterministic, bounded manifest from explicit fixture and layout inputs', t => {
  const root = fixture(t);
  const { target, evidence, capture } = writeInputs(root);
  const first = path.join(evidence, 'first.json');
  const second = path.join(evidence, 'second.json');

  let result = run('--target', target, '--fixture', capture, '--route', '/', '--layout', 'src/Layout.tsx', '--out', first);
  assert.equal(result.code, 0);
  assert.equal(result.data.valid, true);
  const manifest = JSON.parse(readFileSync(first, 'utf8'));
  assert.equal(manifest.kind, 'sitecore-headless-preview-input');
  assert.equal(manifest.route, '/');
  assert.deepEqual(manifest.fixture.placeholderKeys, ['footer', 'header', 'main']);
  assert.equal(manifest.layout.path, 'src/Layout.tsx');
  assert.match(manifest.fixture.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.layout.sha256, /^[a-f0-9]{64}$/);

  result = run('--target', target, '--fixture', capture, '--route', '/', '--layout', 'src/Layout.tsx', '--out', second);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(second, 'utf8')), manifest);
});

test('rejects malformed layout fixtures without writing a manifest', t => {
  const root = fixture(t);
  const { target, evidence, capture } = writeInputs(root);
  writeFileSync(capture, JSON.stringify({ sitecore: { route: {} } }));
  const output = path.join(evidence, 'invalid.json');
  const result = run('--target', target, '--fixture', capture, '--route', '/', '--layout', 'src/Layout.tsx', '--out', output);
  assert.equal(result.code, 1);
  assert.equal(result.data.valid, false);
  assert.match(result.data.errors[0], /placeholder/i);
  assert.equal(existsSync(output), false);
});

test('rejects task evidence output beneath the application root', t => {
  const root = fixture(t);
  const { target, capture } = writeInputs(root);
  const output = path.join(target, 'preview-input.json');
  const result = run('--target', target, '--fixture', capture, '--route', '/', '--layout', 'src/Layout.tsx', '--out', output);
  assert.equal(result.code, 1);
  assert.equal(result.data.valid, false);
  assert.match(result.data.errors[0], /outside target/i);
  assert.equal(existsSync(output), false);
});

test('records prior result references without reading application directories', t => {
  const root = fixture(t);
  const { target, evidence, capture } = writeInputs(root);
  const prior = path.join(evidence, 'shared-styles-result.json');
  const output = path.join(evidence, 'manifest.json');
  writeFileSync(prior, '{"taskId":"code.shared-styles-shell"}\n');
  const result = run('--target', target, '--fixture', capture, '--route', '/', '--layout', 'src/Layout.tsx', '--prior-result', prior, '--out', output);
  assert.equal(result.code, 0);
  const manifest = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(manifest.priorResults.map(item => item.path), [path.resolve(prior)]);
  assert.match(manifest.priorResults[0].sha256, /^[a-f0-9]{64}$/);
});
