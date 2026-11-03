import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const script = fileURLToPath(new URL('../scripts/extract-archive.mjs', import.meta.url));
const MARKERS = ['package.json', 'src', '*.csproj'];

const table = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xFFFFFFFF; for (const b of buffer) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

// Minimal zip writer that can also lie: override crc, size, flags, method or unix mode per entry.
function zip(entries) {
  const parts = [], directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8, body = method === 8 ? deflateRawSync(data) : data;
    const flags = entry.flags ?? 0x800, crc = entry.crc ?? crc32(data), size = entry.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) | (entry.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body); directory.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

function fixture(t, archive) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-zip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (archive) writeFileSync(join(dir, 'a.zip'), archive);
  let runs = 0;
  const run = (input = {}, flags = []) => {
    writeFileSync(join(dir, 'input.json'), JSON.stringify({ archivePath: 'a.zip', rootMarkers: MARKERS, ...input }));
    const out = join(dir, `report-${runs++}.json`);
    const r = spawnSync(process.execPath, [script, '--input', join(dir, 'input.json'), '--out', out, ...flags], { cwd: dir, encoding: 'utf8' });
    let output; try { output = JSON.parse(r.stdout); } catch { output = { errors: [r.stderr] }; }
    return { status: r.status, output, report: existsSync(out) ? JSON.parse(readFileSync(out)) : null };
  };
  return { dir, run, dest: name => join(dir, name), apply: (name, input) => run(input, ['--apply', '--destination', join(dir, name)]) };
}
const project = (...extra) => [{ name: 'proj/package.json', data: '{"name":"x"}' }, ...extra];

test('extracts only the detected project root and skips links, git metadata and macOS metadata', t => {
  const archive = zip([
    { name: '__MACOSX/proj-main/._package.json', data: 'junk' },
    { name: 'README.md', data: 'outside the root' },
    { name: 'proj-main/' },
    { name: 'proj-main/package.json', data: '{"name":"x"}' },
    { name: 'proj-main/src/' },
    { name: 'proj-main/src/index.js', data: 'console.log(1)' },
    { name: 'proj-main/run.sh', data: '#!/bin/sh\n', mode: 0o100755 },
    { name: 'proj-main/link', data: '../../etc/passwd', mode: 0o120777 },
    { name: 'proj-main/.git/config', data: '[core]\nfsmonitor = evil' },
    { name: 'proj-main/.git/hooks/pre-commit', data: '#!/bin/sh\nevil' },
  ]);
  const f = fixture(t, archive);
  const dry = f.run();
  assert.equal(dry.status, 0, JSON.stringify(dry.output));
  assert.equal(dry.report.root.path, 'proj-main');
  assert.equal(dry.report.root.method, 'markers');
  assert.deepEqual(dry.report.totals, { files: 3, directories: 1, bytes: 12 + 14 + 10 });
  assert.deepEqual([...new Set(dry.report.skipped.map(x => x.reason))].sort(), ['git metadata', 'macOS metadata', 'symbolic link']);
  assert.ok(dry.report.warnings.some(x => x.includes('1 symbolic link was not extracted')));
  assert.ok(dry.report.warnings.some(x => x.includes('1 entries outside the project root')));
  assert.equal(dry.report.archive.sha256, createHash('sha256').update(archive).digest('hex'));
  assert.deepEqual(readdirSync(f.dir).filter(x => !x.startsWith('report-')).sort(), ['a.zip', 'input.json'], 'dry run writes nothing');

  const applied = f.apply('out');
  assert.equal(applied.status, 0, JSON.stringify(applied.output));
  assert.equal(readFileSync(f.dest('out/package.json'), 'utf8'), '{"name":"x"}');
  assert.equal(readFileSync(f.dest('out/src/index.js'), 'utf8'), 'console.log(1)');
  assert.deepEqual(readdirSync(f.dest('out')).sort(), ['package.json', 'run.sh', 'src']);
  if (process.platform !== 'win32') assert.equal(statSync(f.dest('out/run.sh')).mode & 0o111, 0o111);
  assert.ok(!readdirSync(f.dir).some(x => x.includes('.partial-')));
});

test('unsafe entry names refuse the whole archive and leave nothing behind', t => {
  for (const name of ['../evil.txt', 'a/../../b', '/abs.txt', 'C:\\evil.txt', 'a\\..\\..\\b', 'x\0y']) {
    const f = fixture(t, zip(project({ name, data: 'x' })));
    const r = f.apply('out');
    assert.equal(r.status, 1, JSON.stringify(name));
    assert.match(r.output.errors[0], /unsafe path/, JSON.stringify(name));
    assert.deepEqual(readdirSync(f.dir).filter(x => !x.startsWith('report-')).sort(), ['a.zip', 'input.json'], JSON.stringify(name));
  }
});

test('project root detection covers ambiguity, explicit roots, depth and suffix markers', t => {
  const two = fixture(t, zip([{ name: 'a/package.json' }, { name: 'b/package.json' }]));
  const ambiguous = two.run();
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.output.errors[0], /ambiguous.*a, b.*rootPath/);
  assert.equal(two.run({ rootPath: 'a' }).report.root.path, 'a');
  assert.equal(two.run({ rootPath: 'a/', rootMarkers: undefined }).report.root.method, 'explicit');
  assert.match(two.run({ rootPath: 'zzz' }).output.errors[0], /not a directory/);
  assert.match(two.run({ rootMarkers: undefined }).output.errors[0], /Provide rootMarkers/);

  const deep = level => zip([{ name: Array.from({ length: level }, (_, i) => 'd' + i).join('/') + '/package.json' }]);
  assert.equal(fixture(t, deep(5)).run().status, 0, 'a root five levels down is found');
  assert.match(fixture(t, deep(7)).run().output.errors[0], /No project root found/);

  const dotnet = fixture(t, zip([{ name: 'site/Site.csproj' }, { name: 'site/Views/Home.cshtml' }]));
  assert.equal(dotnet.run().report.root.path, 'site');
  assert.equal(fixture(t, zip([{ name: 'package.json' }])).run().report.root.path, '.');
  assert.equal(fixture(t, zip([{ name: 'a/x' }])).run({ rootPath: '.' }).report.root.path, '.');
});

test('duplicate, case-colliding and file-versus-directory entries are refused', t => {
  const cases = [
    [[{ name: 'p/A.txt' }, { name: 'p/a.txt' }], /case-colliding/],
    [[{ name: 'p/x' }, { name: 'p/x' }], /case-colliding/],
    [[{ name: 'p/a' }, { name: 'p/a/b' }], /both a file and a directory/],
  ];
  for (const [entries, pattern] of cases) {
    const f = fixture(t, zip([{ name: 'p/package.json' }, ...entries]));
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.output.errors[0], pattern);
  }
});

test('corrupt, lying and unsupported archives fail without leaving a destination', t => {
  const lies = [
    ['a wrong CRC', project({ name: 'proj/bad.txt', data: 'hello', crc: 123 }), /CRC/],
    ['an understated size', project({ name: 'proj/bad.txt', data: 'hello world, hello world', size: 3 }), /inflate|CRC/],
    ['an unsupported method', project({ name: 'proj/bad.txt', data: 'x', method: 12 }), /Unsupported compression/],
  ];
  const encrypted = fixture(t, zip(project({ name: 'proj/bad.txt', data: 'x', flags: 0x801 })));
  assert.match(encrypted.run().output.errors[0], /Encrypted/, 'encryption is refused from the directory, even in a dry run');
  for (const [label, entries, pattern] of lies) {
    const f = fixture(t, zip(entries));
    assert.equal(f.run().status, 0, label + ' is only detected when content is read');
    const r = f.apply('out');
    assert.equal(r.status, 1, label);
    assert.match(r.output.errors[0], pattern, label);
    assert.ok(!existsSync(f.dest('out')) && !readdirSync(f.dir).some(x => x.includes('.partial-')), label);
  }
  const good = zip(project());
  const zip64 = Buffer.from(good); zip64.writeUInt16LE(0xFFFF, zip64.length - 12);
  const cases = [['truncated', good.subarray(0, 10), /Not a zip|truncated|damaged/], ['text', Buffer.from('not a zip archive at all, sorry'), /Not a zip/],
    ['zip64', zip64, /Zip64/], ['empty directory record', good.subarray(0, good.length - 30), /Not a zip|damaged|outside/]];
  for (const [label, bytes, pattern] of cases) {
    const r = fixture(t, bytes).run();
    assert.equal(r.status, 1, label);
    assert.match(r.output.errors[0], pattern, label);
  }
});

test('destination and flag handling never overwrites and requires a deliberate apply', t => {
  const f = fixture(t, zip(project()));
  mkdirSync(f.dest('taken'));
  assert.match(f.apply('taken').output.errors[0], /already exists/);
  assert.deepEqual(readdirSync(f.dest('taken')), []);
  assert.match(f.run({}, ['--destination', f.dest('out')]).output.errors[0], /requires --apply/);
  assert.match(f.run({}, ['--apply']).output.errors[0], /Missing value|requires --destination/);
  assert.equal(f.run({ archivePath: 'missing.zip' }).status, 1);
  assert.equal(f.run({ unknown: true }).status, 1);
  assert.equal(f.apply('out').status, 0);
  assert.equal(f.apply('out').status, 1, 'a second extraction to the same destination is refused');
});
