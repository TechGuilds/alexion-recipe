import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { example, bytes, hash, id } from './fixture-factory.mjs';
import { prepareSourceSnapshot } from '../scripts/prepare-source-snapshot.mjs';
import { validateSnapshotFile } from '../scripts/validate-snapshot.mjs';
import { openSnapshot, createSnapshotWriter } from '../scripts/lib/snapshot.mjs';
import { validateInputFile } from '../scripts/validate-inputs.mjs';
import { createCoverage } from '../scripts/lib/coverage.mjs';

test('capture envelopes reject unsupported versions, value semantics and malformed completion', async () => {
  for (const mode of ['version','valueMode','completion']) {
    const s=await setup();
    try {
      const source=s.data.sourceSnapshot,scope=s.request.scope;
      const header={version:mode==='version'?99:1,valueMode:mode==='valueMode'?'stored':'effective',scopeId:scope.scopeId,instanceId:scope.instanceId,database:scope.database,sourceStateId:scope.sourceStateId,requestId:'reviewed-capture',capturedAt:source.capturedAt};
      const records=[...source.items.map(data=>({kind:'item',data})),...source.renderingInstances.map(data=>({kind:'renderingInstance',data}))];
      const terminal={requestId:header.requestId,written:records.length,errors:0,partial:false,limited:false};if(mode==='completion')delete terminal.partial;
      const content=[{kind:'header',data:header},...records,{kind:'complete',data:terminal}].map(r=>JSON.stringify(r)).join('\n')+'\n';
      await writeFile(join(s.dir,'capture.jsonl'),content);
      s.request.evidence=[{...s.request.evidence[0],path:'capture.jsonl',format:'capture-jsonl',sha256:hash(content)}];await writeFile(s.input,bytes(s.request));
      await assert.rejects(prepareSourceSnapshot(s.input,s.output),/must|capture|value|version|required/i);
    } finally {await s.cleanup();}
  }
});

test('broader evidence reuses only per-item requested reference versions and languages', async () => {
  const s = await setup(({ source, scope }) => {
    scope.languages.push('fr');
    const item = source.items[0], spec = scope.items[0];
    spec.versions = structuredClone(spec.versions);
    spec.fields[0].referenceKind = 'list';
    const ref = { fieldId: item.fields[0].fieldId, kind: 'list', language: 'en', version: 1, targetSourceIds: [source.items[1].id] };
    item.references.push(ref, { ...ref, version: 2 });
    item.versions.push({ language: 'en', version: 2 }, { language: 'fr', version: 1 });
    spec.fields[1].storage = 'unversioned';
    item.fields[1].storage = 'unversioned'; delete item.fields[1].version;
    item.fields.push({ ...item.fields[1], language: 'fr' });
  });
  try {
    const result = await prepareSourceSnapshot(s.input, s.output);
    assert.equal(result.ready, true); assert.equal(result.captureRequests.length, 0);
  } finally { await s.cleanup(); }
});

test('duplicate reference tuples cannot pass preparation or coverage', async () => {
  const s = await setup(({ source, scope }) => {
    scope.items[0].fields[0].referenceKind = 'list';
    const ref = { fieldId: source.items[0].fields[0].fieldId, kind: 'list', language: 'en', version: 1, targetSourceIds: [source.items[1].id] };
    source.items[0].references.push(ref, { ...ref, targetSourceIds: [id(999)] });
  });
  try {
    assert.throws(() => createCoverage(s.request.scope).add({ kind: 'item', data: s.data.sourceSnapshot.items[0] }), /Repeated reference/);
    await assert.rejects(prepareSourceSnapshot(s.input, s.output), /Repeated field or reference/);
  } finally { await s.cleanup(); }
});

async function setup(change = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'source-snapshot-'));
  const data = await example(), source = data.sourceSnapshot;
  const scope = {
    version: 1, scopeId: source.scopeId, instanceId: source.instanceId, database: source.database,
    sourceStateId: 'reviewed-source-state', rootPaths: source.rootPaths, languages: source.languages,
    items: source.items.map(item => ({ id: item.id, path: item.path, templateId: item.templateId, parentId: item.parentId, versions: item.versions,
      fields: item.fields.map(f => ({ fieldId: f.fieldId, storage: f.storage })) })),
    renderingInstances: source.renderingInstances.map(r => ({ ...r, parameters: r.parameters.map(f => ({ fieldId: f.fieldId, storage: f.storage })) })),
  };
  const request = { version: 1, scope, evidence: [], maxRecordsPerPart: 1, maxPartBytes: 4096 };
  change({ source, scope, request, data });
  await writeFile(join(dir, 'source.json'), bytes(source));
  request.evidence.unshift({ path: 'source.json', sha256: hash(bytes(source)), format: 'snapshot-json', sourceStateId: scope.sourceStateId,
    capturedAt: source.capturedAt, scopeId: scope.scopeId, instanceId: scope.instanceId, database: scope.database });
  await writeFile(join(dir, 'request.json'), bytes(request));
  return { dir, data, request, input: join(dir, 'request.json'), output: join(dir, 'prepared'), async cleanup() { await rm(dir, { recursive: true, force: true }); } };
}

test('complete evidence is reused with bounded parts and no capture requests', async () => {
  const s = await setup();
  try {
    const result = await prepareSourceSnapshot(s.input, s.output);
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(result.captureRequests.length, 0);
    const snap = await openSnapshot(join(s.output, 'source-snapshot.json'));
    assert.equal(snap.manifest.parts.length, 3);
    for (const part of snap.manifest.parts) assert.ok(part.bytes <= 4096 && part.itemCount + part.renderingInstanceCount <= 1);
    const check = await validateSnapshotFile(join(s.output, 'source-snapshot.json'), s.request.scope);
    assert.equal(check.ready, true, JSON.stringify(check));
  } finally { await s.cleanup(); }
});

test('missing field creates an exact gap request, preserving explicit empty values', async () => {
  const s = await setup(({ source }) => { source.items[0].fields[0].value = ''; source.items[0].fields.pop(); });
  try {
    const result = await prepareSourceSnapshot(s.input, s.output);
    assert.equal(result.ready, false);
    assert.equal(result.captureRequests.length, 1);
    const envelope = JSON.parse(await readFile(join(s.output, result.captureRequests[0].path), 'utf8'));
    assert.equal(envelope.parameters.Request.scope.items.length, 1);
    assert.equal(envelope.parameters.Request.scope.items[0].fields.length, 1);
    assert.equal(envelope.parameters.Request.scope.renderingInstances.length, 0);
    assert.match(envelope.script, /kajoo-export/);
  } finally { await s.cleanup(); }
});

test('a missing versioned value does not recapture an already covered version', async () => {
  const s = await setup(({ scope }) => { scope.items[0].versions.push({ language: 'en', version: 2 }); });
  try {
    const result = await prepareSourceSnapshot(s.input, s.output);
    const envelope = JSON.parse(await readFile(join(s.output, result.captureRequests[0].path), 'utf8'));
    assert.deepEqual(envelope.parameters.Request.scope.items[0].versions, [{ language: 'en', version: 2 }]);
  } finally { await s.cleanup(); }
});

test('partitioned fixture validates against coverage and migration-input contracts', async () => {
  const fixture = new URL('./fixtures/', import.meta.url);
  const request = JSON.parse(await readFile(new URL('snapshot-validation.json', fixture), 'utf8'));
  assert.equal((await validateSnapshotFile(fileURLToPath(new URL('source-snapshot-manifest.json', fixture)), request.scope)).ready, true);
  assert.equal((await validateInputFile(fileURLToPath(new URL('migration-input-partitioned.json', fixture)))).valid, true);
});

test('stale evidence is not silently mixed with the approved source state', async () => {
  const s = await setup();
  try {
    s.request.evidence[0].sourceStateId = 'old-state'; await writeFile(s.input, bytes(s.request));
    const result = await prepareSourceSnapshot(s.input, s.output);
    assert.equal(result.ready, false);
    assert.equal(result.reusedItems, 0);
    assert.ok(result.captureRequests.length);
  } finally { await s.cleanup(); }
});

test('a partitioned snapshot can be reused on resume without recapturing', async () => {
  const s = await setup();
  try {
    await prepareSourceSnapshot(s.input, s.output);
    const manifest = await readFile(join(s.output, 'source-snapshot.json'));
    s.request.evidence = [{ ...s.request.evidence[0], path: 'prepared/source-snapshot.json', sha256: hash(manifest), format: 'snapshot-manifest' }];
    await writeFile(s.input, bytes(s.request));
    const result = await prepareSourceSnapshot(s.input, join(s.dir, 'resumed'));
    assert.equal(result.ready, true, JSON.stringify(result)); assert.equal(result.captureRequests.length, 0);
  } finally { await s.cleanup(); }
});

test('changed part hashes, false counts and traversal are rejected', async () => {
  for (const mutate of [m => { m.parts[0].sha256 = 'a'.repeat(64); }, m => { m.parts[0].itemCount++; }, m => { m.parts[0].path = '../source.json'; }]) {
    const s = await setup();
    try {
      await prepareSourceSnapshot(s.input, s.output);
      const path = join(s.output, 'source-snapshot.json'), m = JSON.parse(await readFile(path, 'utf8')); mutate(m); await writeFile(path, bytes(m));
      const result = await validateSnapshotFile(path, s.request.scope);
      assert.equal(result.ready, false); assert.ok(result.errors.length);
    } finally { await s.cleanup(); }
  }
});

test('source artifacts with wrong identity or conflicting values are rejected', async () => {
  const s = await setup();
  try {
    s.request.evidence[0].instanceId = 'other-instance'; await writeFile(s.input, bytes(s.request));
    await assert.rejects(() => prepareSourceSnapshot(s.input, s.output), /identity|scope/i);
  } finally { await s.cleanup(); }
  const c = await setup();
  try {
    const other = structuredClone(c.data.sourceSnapshot); other.items[0].fields[0].value = 'conflicting';
    await writeFile(join(c.dir, 'other.json'), bytes(other));
    c.request.evidence.push({ ...c.request.evidence[0], path: 'other.json', sha256: hash(bytes(other)) }); await writeFile(c.input, bytes(c.request));
    await assert.rejects(() => prepareSourceSnapshot(c.input, c.output), /conflict/i);
  } finally { await c.cleanup(); }
});

test('single records larger than the part limit fail without a complete manifest', async () => {
  const s = await setup(({ source }) => { source.items[0].fields[0].value = 'x'.repeat(6000); });
  try { await assert.rejects(() => prepareSourceSnapshot(s.input, s.output), /exceeds/i); }
  finally { await s.cleanup(); }
});

test('existing output directories are not overwritten', async () => {
  const s = await setup();
  try { await prepareSourceSnapshot(s.input, s.output); await assert.rejects(() => prepareSourceSnapshot(s.input, s.output)); }
  finally { await s.cleanup(); }
});

test('input validation accepts a source manifest without merging content values into memory', async () => {
  const s = await setup();
  try {
    await prepareSourceSnapshot(s.input, s.output);
    const mapping = { mapping: s.data.mapping, sourceSnapshot: null, targetInventory: s.data.targetInventory, destinationPlan: s.data.destinationPlan };
    const input = { version: 1, scopeId: s.request.scope.scopeId, mappingRevision: 'example-1' };
    for (const [key, value] of Object.entries(mapping)) {
      const path = key === 'sourceSnapshot' ? 'prepared/source-snapshot.json' : key + '.json';
      if (value) await writeFile(join(s.dir, path), bytes(value));
      input[key] = { path, sha256: hash(await readFile(join(s.dir, path))) };
    }
    await writeFile(join(s.dir, 'migration-input.json'), bytes(input));
    const result = await validateInputFile(join(s.dir, 'migration-input.json'));
    assert.equal(result.valid, true, JSON.stringify(result)); assert.equal(result.summary.sourceItems, 2);
  } finally { await s.cleanup(); }
});

test('native Discovery field rows are adapted only with explicit IDs, storage and parent evidence', async () => {
  const s = await setup();
  try {
    const rows = s.data.sourceSnapshot.items.map(item => ({ id: item.id, path: item.path, name: item.name, templateId: item.templateId,
      language: 'en', version: '1', fields: Object.fromEntries(item.fields.map(f => [f.fieldId, f.value])) }));
    for (const item of s.request.scope.items) item.fields.forEach(f => { f.name = f.fieldId; });
    s.request.scope.renderingInstances = [];
    const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n'; await writeFile(join(s.dir, 'items.jsonl'), content);
    s.request.evidence = [{ ...s.request.evidence[0], path: 'items.jsonl', sha256: hash(content), format: 'discovery-items-jsonl' }]; await writeFile(s.input, bytes(s.request));
    assert.equal((await prepareSourceSnapshot(s.input, s.output)).ready, true);
  } finally { await s.cleanup(); }
});

test('discovery summaries and missing parameter contexts produce gaps instead of invented values', async () => {
  const s = await setup(({ source }) => { source.renderingInstances = []; });
  try {
    const result = await prepareSourceSnapshot(s.input, s.output);
    assert.equal(result.ready, false); assert.equal(result.missingContexts.length, 1);
    const envelope = JSON.parse(await readFile(join(s.output, result.captureRequests[0].path), 'utf8'));
    assert.equal(envelope.parameters.Request.scope.items.length, 0);
    assert.equal(envelope.parameters.Request.scope.renderingInstances.length, 1);
  } finally { await s.cleanup(); }
});

test('captured evidence may reorder properties and normalize GUID casing without creating a conflict', async () => {
  const s = await setup();
  try {
    const other = structuredClone(s.data.sourceSnapshot);
    other.items.forEach(i => { i.id = i.id.toLowerCase(); i.fields = i.fields.map(f => ({ value: f.value, ...f, fieldId: f.fieldId.toLowerCase() })); });
    await writeFile(join(s.dir, 'other.json'), bytes(other));
    s.request.evidence.push({ ...s.request.evidence[0], path: 'other.json', sha256: hash(bytes(other)) }); await writeFile(s.input, bytes(s.request));
    assert.equal((await prepareSourceSnapshot(s.input, s.output)).ready, true);
  } finally { await s.cleanup(); }
});

test('total snapshot content can exceed the legacy JSON limit while each part remains bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'large-partitioned-snapshot-'));
  try {
    const { sourceSnapshot: source } = await example();
    const { items, renderingInstances, ...header } = source;
    const scope = { ...header, sourceStateId: 'large-fixture-state', items: [], renderingInstances: [] }; delete scope.capturedAt;
    const writer = await createSnapshotWriter(dir, header, { maxPartBytes: 65536, maxRecordsPerPart: 10 });
    try {
      for (let i = 0; i < 1200; i++) {
        const item = { ...items[0], id: id(1000 + i), path: `/sitecore/content/Legacy/Item-${i}`, name: `Item-${i}`,
          fields: [{ ...items[0].fields[0], value: 'x'.repeat(15000) }] };
        scope.items.push({ id: item.id, path: item.path, templateId: item.templateId, versions: item.versions, fields: [{ fieldId: item.fields[0].fieldId, storage: item.fields[0].storage }] });
        await writer.add({ kind: 'item', data: item });
      }
      const manifest = await writer.finish({ sourceStateId: scope.sourceStateId, preparedAt: header.capturedAt, complete: true, requestSha256: 'a'.repeat(64), provenance: [] });
      assert.ok(manifest.parts.reduce((n, p) => n + p.bytes, 0) > 16 * 1024 * 1024);
      assert.ok(manifest.parts.every(p => p.bytes <= 65536 && p.itemCount <= 10));
      assert.equal((await validateSnapshotFile(join(dir, 'source-snapshot.json'), scope)).ready, true);
    } finally { await writer.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const powershell = [process.env.PWSH_EXE, 'pwsh', 'powershell.exe'].filter(Boolean).find(exe => spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).status === 0);
for (const mode of ['success', 'missing-field', 'byte-limit', 'rendering-context', 'link-reference']) test(`read-only SPE export under synthetic Sitecore doubles: ${mode}`, { skip: !powershell }, async () => {
  const s = await setup();
  try {
    s.request.evidence[0].sourceStateId = 'stale';
    if (mode !== 'rendering-context') s.request.scope.renderingInstances = [];
    if (mode === 'byte-limit') s.request.maxPartBytes = 1024;
    if (mode === 'link-reference') s.request.scope.items[1].fields.at(-1).referenceKind = 'link';
    await writeFile(s.input, bytes(s.request));
    const prepared = await prepareSourceSnapshot(s.input, s.output);
    const selected = mode === 'rendering-context' ? prepared.captureRequests.at(-1) : prepared.captureRequests[0];
    const source = structuredClone(s.data.sourceSnapshot);
    if (mode === 'missing-field') source.items[0].fields = [];
    if (mode === 'byte-limit') source.items[0].fields[0].value = 'x'.repeat(4000);
    if (mode === 'link-reference') source.items[1].fields.at(-1).value = `<link id="${source.items[0].id}" linktype="internal" />`;
    await writeFile(join(s.dir, 'mock-source.json'), bytes(source));
    const run = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./fixtures/capture-harness.ps1', import.meta.url)),
      '-CaptureScript', fileURLToPath(new URL('../scripts/capture-source.ps1', import.meta.url)), '-EnvelopePath', join(s.output, selected.path), '-SourcePath', join(s.dir, 'mock-source.json'), '-DataRoot', s.dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.kind, 'kajoo-export');
    const capturePath = result.files[0].path, content = await readFile(join(s.dir, capturePath));
    assert.ok(content.length <= (s.request.maxPartBytes ?? 4 * 1024 * 1024));
    assert.equal(result.summary.partial, ['missing-field', 'byte-limit'].includes(mode), run.stdout);
    if (['success', 'rendering-context', 'link-reference'].includes(mode)) {
      const snapshotSource = structuredClone(source);
      if (mode === 'rendering-context') snapshotSource.renderingInstances = [];
      else snapshotSource.items = snapshotSource.items.map(i => ({ ...i, fields: [] }));
      await writeFile(join(s.dir, 'partial.json'), bytes(snapshotSource));
      s.request.evidence = [
        { ...s.request.evidence[0], path: 'partial.json', format: 'snapshot-json', sourceStateId: s.request.scope.sourceStateId, sha256: hash(bytes(snapshotSource)) },
        { ...s.request.evidence[0], path: capturePath, format: 'capture-jsonl', sourceStateId: s.request.scope.sourceStateId, sha256: hash(content), capturedAt: JSON.parse(content.toString('utf8').split('\n')[0]).data.capturedAt },
      ];
      await writeFile(s.input, bytes(s.request));
      assert.equal((await prepareSourceSnapshot(s.input, join(s.dir, 'combined'))).ready, true);
    }
  } finally { await s.cleanup(); }
});
