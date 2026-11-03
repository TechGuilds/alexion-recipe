import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('../scripts/capture/build-mock-dictionary.mjs', import.meta.url));
const record = (key, phrase, language = 'en', extra = {}) => ({ id: `id-${language}-${key}`, path: '/sitecore/content/x/Dictionary/' + key, name: key, language, domain: 'x', key, phrase, fallback: 'not inferred', duplicate: false, ...extra });

function fixture(t, records, errors) {
  const dir = mkdtempSync(join(tmpdir(), 'mock-dict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = join(dir, 'raw'); mkdirSync(raw);
  writeFileSync(join(raw, 'dictionary.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (errors) writeFileSync(join(raw, 'errors.jsonl'), errors.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { dir, raw, out: join(dir, 'out'), run: (extra = [], site = 'main') => {
    const r = spawnSync(process.execPath, [script, '--raw-root', raw, '--site', site, '--output', join(dir, 'out'), ...extra], { encoding: 'utf8' });
    let output; try { output = JSON.parse(r.stdout); } catch { output = { errors: [r.stderr] }; }
    return { status: r.status, output };
  } };
}
const read = (f, path) => JSON.parse(readFileSync(join(f.out, path), 'utf8'));

test('builds one flat sorted { key: phrase } file per language under the site', t => {
  const f = fixture(t, [record('zebra', 'Zèbre', 'fr-CA'), record('apple', 'Apple'), record('zebra', 'Zebra'), record('apple', 'Pomme', 'fr-CA'), record('empty', '')]);
  const r = f.run();
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.deepEqual(readdirSync(join(f.out, 'main')).sort(), ['en.json', 'fr-CA.json']);
  assert.deepEqual(read(f, 'main/en.json'), { apple: 'Apple', empty: '', zebra: 'Zebra' });
  assert.deepEqual(Object.keys(read(f, 'main/en.json')), ['apple', 'empty', 'zebra'], 'keys are sorted');
  assert.deepEqual(read(f, 'main/fr-CA.json'), { apple: 'Pomme', zebra: 'Zèbre' });
  const manifest = read(f, 'manifest.json');
  assert.equal(manifest.source.records, 5);
  assert.equal(manifest.emptyPhrases, 1);
  assert.equal(manifest.languages.en.keys, 3);
  const text = readFileSync(join(f.out, 'main/en.json'));
  assert.equal(manifest.languages.en.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(manifest.source.sha256, createHash('sha256').update(readFileSync(join(f.raw, 'dictionary.jsonl'))).digest('hex'));
  assert.ok(!readdirSync(f.dir).some(x => x.includes('.partial-')));
});

test('duplicate keys need an explicit precedence and the choice is recorded', t => {
  const records = [record('k', 'first'), record('k', 'second', 'en', { id: 'other', duplicate: true }), record('other', 'x')];
  const errors = [{ scope: '["x","en","k"]', message: 'Duplicate dictionary key; choose precedence explicitly' }];
  const f = fixture(t, records, errors);
  const refused = f.run();
  assert.equal(refused.status, 1);
  assert.match(refused.output.errors[0], /1 duplicate dictionary key.*en\/k.*--duplicates/);
  assert.ok(!existsSync(f.out));
  assert.equal(f.run(['--duplicates', 'first']).status, 0);
  assert.equal(read(f, 'main/en.json').k, 'first');
  assert.deepEqual(read(f, 'manifest.json').resolvedConflicts, [{ language: 'en', key: 'k', phrases: ['first', 'second'] }]);
  rmSync(f.out, { recursive: true });
  assert.equal(f.run(['--duplicates', 'last']).status, 0);
  assert.equal(read(f, 'main/en.json').k, 'second');
});

test('a partial export, a broken record or an empty capture is never turned into files', t => {
  const partial = fixture(t, [record('a', 'A')], [{ scope: 'root', message: 'Item limit reached' }]);
  assert.match(partial.run(['--duplicates', 'first']).output.errors[0], /partial capture/);
  assert.ok(!existsSync(partial.out));
  const cases = [
    [[record('', 'x')], /no key/],
    [[record('k', 'x', '../evil')], /no usable language/],
    [[record('k', 'x', 'en', { language: undefined })], /no usable language/],
    [[record('k', 42)], /non-text phrase/],
    [[], /no records/],
  ];
  for (const [records, pattern] of cases) {
    const f = fixture(t, records);
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.output.errors[0], pattern);
    assert.ok(!existsSync(f.out) && !readdirSync(f.dir).some(x => x.includes('.partial-')));
  }
  const malformed = fixture(t, [record('a', 'A')]);
  writeFileSync(join(malformed.raw, 'dictionary.jsonl'), '{not json}\n');
  assert.match(malformed.run().output.errors[0], /line 1 is not valid JSON/);
});

test('site, paths and flags are validated and an existing output is never reused', t => {
  const f = fixture(t, [record('a', 'A')]);
  for (const site of ['../x', 'a/b', '', '.x', 'a b']) assert.equal(f.run([], site).status, 1, JSON.stringify(site));
  assert.equal(f.run(['--duplicates', 'newest']).status, 1);
  assert.equal(f.run(['--bogus', 'x']).status, 1);
  mkdirSync(f.out);
  assert.match(f.run().output.errors[0], /already exists/);
  rmSync(f.out, { recursive: true });
  const missing = spawnSync(process.execPath, [script, '--raw-root', join(f.dir, 'nope'), '--site', 'main', '--output', f.out], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  const noFile = mkdtempSync(join(tmpdir(), 'mock-dict-empty-'));
  t.after(() => rmSync(noFile, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [script, '--raw-root', noFile, '--site', 'main', '--output', join(f.dir, 'out2')], { encoding: 'utf8' });
  assert.match(JSON.parse(r.stdout).errors[0], /dictionary\.jsonl not found/);
});
