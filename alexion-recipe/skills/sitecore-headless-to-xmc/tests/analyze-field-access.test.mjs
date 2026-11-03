import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(skill, 'scripts', 'analyze-field-access.mjs');
const run = (...args) => {
  const p = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const raw = p.stdout || p.stderr;
  return { code: p.status, data: raw ? JSON.parse(raw) : null };
};
const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'field-access-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('scans a real source tree and writes a report covering field access, DAM assets and blind spots', (t) => {
  const root = fixture(t);
  const src = path.join(root, 'src');
  mkdirSync(src);
  writeFileSync(path.join(src, 'Hero.tsx'), `
export const Hero = (props) => {
  const { Title } = props.fields;
  return <div>{Title}<img src={props.fields.image.asset} /></div>;
};
`);
  const output = path.join(root, 'report.json');
  const p = run('--root', src, '--output', output);
  assert.equal(p.code, 0);
  assert.equal(p.data.success, true);
  assert.equal(p.data.filesRead, 1);
  assert.equal(p.data.fieldAccess, 1);
  assert.equal(p.data.blindSpots, 1);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.files[0].path, './Hero.tsx');
  assert.deepEqual(report.files[0].damAssets, { hasDamAssets: true, fields: ['image'] });
  assert.equal(report.files[0].blindSpots[0].kind, 'fields-destructuring');
});

test('rejects an output path inside the scanned root', (t) => {
  const root = fixture(t);
  const src = path.join(root, 'src');
  mkdirSync(src);
  writeFileSync(path.join(src, 'C.tsx'), 'fields.x;');
  const p = run('--root', src, '--output', path.join(src, 'report.json'));
  assert.equal(p.code, 1);
  assert.match(p.data.error, /analysis root/);
});

test('refuses to overwrite an existing output file', (t) => {
  const root = fixture(t);
  const src = path.join(root, 'src');
  mkdirSync(src);
  writeFileSync(path.join(src, 'C.tsx'), 'fields.x;');
  const output = path.join(root, 'report.json');
  writeFileSync(output, '{}');
  const p = run('--root', src, '--output', output);
  assert.equal(p.code, 1);
});

test('rejects a non-directory root', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'not-a-dir.txt');
  writeFileSync(file, 'x');
  const p = run('--root', file, '--output', path.join(root, 'report.json'));
  assert.equal(p.code, 1);
});

test('--help prints usage without requiring --root/--output', () => {
  const p = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(p.status, 0);
  assert.match(p.stdout, /Usage: node analyze-field-access\.mjs/);
});

test('reports parse errors as omissions and marks the run incomplete without crashing', (t) => {
  const root = fixture(t);
  const src = path.join(root, 'src');
  mkdirSync(src);
  writeFileSync(path.join(src, 'Broken.tsx'), 'function C( { return <div>');
  const output = path.join(root, 'report.json');
  const p = run('--root', src, '--output', output);
  assert.equal(p.code, 0);
  assert.equal(p.data.complete, false);
  assert.equal(p.data.graphComplete, false);
});
