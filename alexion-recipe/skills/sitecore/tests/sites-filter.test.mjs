import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/setup/filter-sites.mjs', import.meta.url));

const SYSTEM_SITE_NAMES = [
  'shell', 'login', 'admin', 'service', 'modules_shell', 'modules_website',
  'scheduler', 'system', 'publisher', 'testing', 'preview', 'speak',
];

function site(name, overrides) {
  return { name, rootPath: null, startItem: null, hostName: null, availableLanguages: [], ...overrides };
}

function raw(sites, availableLanguages = []) {
  return { sites, availableLanguages };
}

function run(rawEnvelope) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-'));
  const file = path.join(dir, 'raw.json');
  fs.writeFileSync(file, JSON.stringify(rawEnvelope));
  try {
    const p = spawnSync(process.execPath, [script, '--input', file], { encoding: 'utf8' });
    return { code: p.status, data: p.stdout ? JSON.parse(p.stdout) : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('empty input returns an empty, ready list', () => {
  const p = run(raw([]));
  assert.equal(p.code, 0);
  assert.deepEqual(p.data, { verdict: 'ready', list: [], availableLanguages: [] });
});

test('strips every documented system/chrome site', () => {
  const p = run(raw(SYSTEM_SITE_NAMES.map((n) => site(n))));
  assert.equal(p.data.list.length, 0);
});

test('passes through a single user-facing site', () => {
  const p = run(raw([site('website')]));
  assert.deepEqual(p.data.list, [{ name: 'website', displayName: 'website', rootPath: null, startItem: null, availableLanguages: [] }]);
});

test('preserves Factory order (primary site first) after filtering', () => {
  const p = run(raw(['shell', 'website', 'login', 'intranet', 'admin', 'marketing'].map((n) => site(n))));
  assert.deepEqual(p.data.list.map((s) => s.name), ['website', 'intranet', 'marketing']);
});

test('treats system site names case-insensitively', () => {
  const p = run(raw(['SHELL', 'Website', 'Login'].map((n) => site(n))));
  assert.deepEqual(p.data.list.map((s) => s.name), ['Website']);
});

test('drops entries with empty or whitespace-only names', () => {
  const p = run(raw([site(''), site('   '), site('website')]));
  assert.deepEqual(p.data.list.map((s) => s.name), ['website']);
});

test('drops duplicate names case-insensitively', () => {
  const p = run(raw(['website', 'Website', 'WEBSITE'].map((n) => site(n))));
  assert.deepEqual(p.data.list.map((s) => s.name), ['website']);
});

test('trims surrounding whitespace from site names', () => {
  const p = run(raw([site('  marketing  ')]));
  assert.equal(p.data.list[0].name, 'marketing');
});

test('realistic XP MVC mixed bag — the motivating shape', () => {
  const chrome = SYSTEM_SITE_NAMES.map((n) => site(n));
  const real = [
    site('website', { rootPath: '/sitecore/content/Home', startItem: '/Home' }),
    site('intranet', { rootPath: '/sitecore/content/Intranet', startItem: '/' }),
  ];
  const p = run(raw([...chrome, ...real]));
  assert.deepEqual(p.data.list, [
    { name: 'website', displayName: 'website', rootPath: '/sitecore/content/Home', startItem: '/Home', availableLanguages: [] },
    { name: 'intranet', displayName: 'intranet', rootPath: '/sitecore/content/Intranet', startItem: '/', availableLanguages: [] },
  ]);
});

test('forwards rootPath/startItem from the raw probe (MVC tools derive item paths from these)', () => {
  const p = run(raw([site('website', { rootPath: '/sitecore/content/PHO', startItem: '/Home' })]));
  assert.equal(p.data.list[0].rootPath, '/sitecore/content/PHO');
  assert.equal(p.data.list[0].startItem, '/Home');
});

test('preserves null rootPath/startItem for sites that do not define them', () => {
  const p = run(raw([site('minimal')]));
  assert.equal(p.data.list[0].rootPath, null);
  assert.equal(p.data.list[0].startItem, null);
});

test('per-site availableLanguages are forwarded and sorted', () => {
  const p = run(raw([site('website', { availableLanguages: ['ja-JP', 'en'] })]));
  assert.deepEqual(p.data.list[0].availableLanguages, ['en', 'ja-JP']);
});

test('instance-wide availableLanguages are deduped and sorted', () => {
  const p = run(raw([site('website')], ['fr', 'en', 'en', 'da']));
  assert.deepEqual(p.data.availableLanguages, ['da', 'en', 'fr']);
});

test('rejects a raw envelope missing sites', () => {
  const p = run({ availableLanguages: [] });
  assert.equal(p.code, 1);
  assert.match(p.data.error, /sites must be an array/);
});

test('rejects a site entry with an unknown field', () => {
  const p = run(raw([{ ...site('website'), extra: true }]));
  assert.equal(p.code, 1);
  assert.match(p.data.error, /unknown fields: extra/);
});

test('rejects a site entry missing a required field', () => {
  const { hostName, ...incomplete } = site('website');
  const p = run(raw([incomplete]));
  assert.equal(p.code, 1);
  assert.match(p.data.error, /missing fields: hostName/);
});

test('rejects a non-string, non-null rootPath', () => {
  const p = run(raw([site('website', { rootPath: 42 })]));
  assert.equal(p.code, 1);
  assert.match(p.data.error, /rootPath must be a string or null/);
});

test('rejects malformed JSON input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-'));
  const file = path.join(dir, 'raw.json');
  fs.writeFileSync(file, 'not json');
  try {
    const p = spawnSync(process.execPath, [script, '--input', file], { encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.equal(JSON.parse(p.stdout).error, 'Invalid JSON input');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a missing --input argument', () => {
  const p = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.match(JSON.parse(p.stdout).error, /--input is required/);
});
