import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processDependencies } from '../scripts/analysis/process-dependencies.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const scope = { siteRoot: '/sitecore/content/Acme/Home', database: 'master', languages: ['en'], version: 'latest', devices: [id(90)] };
const node = (n, path, kind, fields = {}) => ({ id: `{${id(n)}}`, path, name: path.split('/').at(-1), kind, language: 'en', version: '1', templateId: id(99), fields, fieldDefinitions: [] });
const edge = (from, to, relation) => ({ consumer: from ? { id: id(from), language: 'en', version: '1' } : null, relation, raw: id(to), kind: 'template', status: 'resolved', required: true, targetId: id(to), language: 'en', version: '1' });
function fixture(t) {
  const base = mkdtempSync(join(process.cwd(), '.tmp-dependencies-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const nodes = [
    node(1, '/sitecore/content/Acme/Home', 'content'),
    node(2, '/sitecore/templates/Project/Acme/Page', 'template'),
    node(3, '/sitecore/templates/System/Analytics/Base', 'template'),
    node(4, '/sitecore/content/Shared/Promo', 'datasource'),
    node(5, '/sitecore/layout/Renderings/Feature/Acme/Hero', 'rendering'),
    node(6, '/sitecore/layout/Layouts/Project/Acme/Main', 'layout'),
    node(7, '/sitecore/layout/Placeholder Settings/Project/Acme/main', 'placeholder'),
    node(8, '/sitecore/system/Settings/Services/Rendering Contents Resolvers/Acme/Custom', 'resolver', { Type: 'Acme.Resolver, Acme' }),
    node(9, '/sitecore/templates/Branches/Project/Acme/Page/$name', 'branch'),
    node(10, '/sitecore/content/Acme/Presentation/Partial Designs/Header', 'sxa'),
    node(11, '/sitecore/content/Acme/Presentation/Partial Designs/Base', 'sxa'),
  ];
  const edges = [edge(null, 1, 'seed'), edge(1, 2, 'item-template'), edge(2, 3, 'base-template'), edge(3, 2, 'base-template'), edge(1, 4, 'datasource'), edge(1, 5, 'rendering'), edge(1, 6, 'layout'), edge(7, 5, 'allowed-rendering'), edge(5, 8, 'resolver'), edge(1, 9, 'branch-originator'), edge(1, 10, 'page-design'), edge(10, 11, 'base-partial-design'), edge(11, 10, 'base-partial-design'),
    { consumer: { id: id(1), language: 'en', version: '1' }, relation: 'field-reference:Empty Reference', raw: '{00000000-0000-0000-0000-000000000000}', kind: 'content', status: 'empty', required: true },
    { consumer: { id: id(5), language: 'en', version: '1' }, relation: 'datasource-location', raw: 'query:./*', status: 'dynamic', kind: 'datasource', required: true },
    { consumer: null, relation: 'seed', raw: '/sitecore/system/Settings/Feature/Absent', status: 'missing', kind: 'sxa', required: false, language: 'en' },
  ];
  const input = { version: 1, scope, targetFlavor: 'xmc', expectations: { inventory: { records: 'raw/inventory.jsonl', manifest: 'raw/inventory-manifest.json' }, renderings: { records: 'raw/renderings.jsonl', manifest: 'raw/renderings-manifest.json' } }, exports: { items: { records: 'raw/items.jsonl', manifest: 'raw/manifest.json' }, edges: { records: 'raw/edges.jsonl', manifest: 'raw/manifest.json' } } };
  function save(summary = {}) {
    mkdirSync(join(base, 'raw'), { recursive: true });
    for (const [name, rows] of [['items', nodes], ['edges', edges]]) writeFileSync(join(base, 'raw', name + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(base, 'raw/manifest.json'), JSON.stringify({ kind: 'kajoo-export', version: 1, files: ['items', 'edges'].map(name => ({ name: name + '.jsonl', size: statSync(join(base, 'raw', name + '.jsonl')).size })), summary: { partial: false, limited: false, errorCount: 0, visited: nodes.length, scope: { ...input.scope, operation: 'inspect-dependencies', seeds: [
      { reference: '/sitecore/content/Acme', kind: 'content', recursive: false, optional: false },
      { reference: scope.siteRoot, kind: 'content', recursive: true, optional: false },
      { reference: scope.siteRoot + '/Presentation', kind: 'sxa', recursive: true, optional: true },
      { reference: '/sitecore/layout/Placeholder Settings', kind: 'placeholder', recursive: true, optional: true },
      { reference: '/sitecore/layout/Renderings', kind: 'rendering', recursive: true, optional: false },
    ], remainingRequests: 0 }, ...summary } }));
    for (const name of ['inventory', 'renderings']) {
      const rows = nodes.filter(row => name === 'inventory' ? row.path === input.scope.siteRoot : row.kind === 'rendering').map(({ id, path, language, version }) => ({ id, path, language, version }));
      writeFileSync(join(base, 'raw', name + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
      writeFileSync(join(base, 'raw', name + '-manifest.json'), JSON.stringify({ kind: 'kajoo-export', version: 1, files: [{ name: name + '.jsonl', size: statSync(join(base, 'raw', name + '.jsonl')).size }], summary: { partial: false, limited: false, errorCount: 0, visited: rows.length, scope: { database: input.scope.database, languages: input.scope.languages, version: input.scope.version, ...(name === 'inventory' ? { sitePath: input.scope.siteRoot, includesRoot: true } : { itemPaths: ['/sitecore/layout/Renderings'], recurse: true }) } } }));
    }
  }
  save();
  return { base, nodes, edges, input, save, read: name => JSON.parse(readFileSync(join(base, 'out', name))) };
}

test('indexes exact dependency closure, reverse consumers, cycles and all serialization kinds', async t => {
  const f = fixture(t);
  const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.collectionComplete, true);
  assert.equal(result.discoveryComplete, false, 'graph collection alone is not full Discovery acceptance');
  const index = f.read('dependency-index.json');
  assert.equal(index.nodes.length, 11);
  assert.deepEqual(index.reverseConsumers.find(row => row.id === id(3)).contentItemIds, [id(1)]);
  assert.ok(index.cycles.some(row => row.family === 'template-inheritance' && row.ids.includes(id(2)) && row.ids.includes(id(3))));
  assert.ok(index.cycles.some(row => row.family === 'sxa-design' && row.ids.includes(id(10)) && row.ids.includes(id(11))));
  assert.equal(index.findings.filter(row => row.status === 'dynamic').length, 1);
  assert.equal(index.findings.filter(row => row.status === 'missing').length, 1);
  assert.equal(index.findings.filter(row => row.status === 'empty').length, 1, 'empty GUID sentinel should be retained without becoming a missing dependency');
  assert.equal(index.gaps.some(row => row.code === 'unread-reference' && row.status === 'empty'), false);
  assert.equal(index.nodes.find(row => row.id === id(8)).fields.Type, 'Acme.Resolver, Acme');
  const paths = f.read('serialization-items.json');
  assert.deepEqual(new Set(paths.items.map(row => row.kind)), new Set(['content', 'template', 'datasource', 'rendering', 'layout', 'placeholder', 'resolver', 'branch', 'sxa']));
  assert.ok(paths.items.some(row => row.path === '/sitecore/content/Shared/Promo'));
  const review = f.read('compatibility-review-input.json');
  assert.equal(review.status, 'requires-review');
  const candidate = review.candidates.find(row => row.id === id(3));
  assert.equal(candidate.basis, 'target-policy-review');
  assert.equal(candidate.approvedExclusion, false);
  assert.deepEqual(candidate.usedByItems, [id(1)]);
  assert.equal(review.baselineAreas.length, 6);
  assert.ok(result.inputs.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
});

test('does not apply XMC baseline policies to XP Headless and keeps outputs deterministic', async t => {
  const f = fixture(t); f.input.targetFlavor = 'xp-headless';
  await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.deepEqual(f.read('compatibility-review-input.json').baselineAreas, []);
  assert.deepEqual(f.read('compatibility-review-input.json').candidates, []);
  await processDependencies(f.input, { base: f.base, output: join(f.base, 'again') });
  for (const name of ['dependency-index.json', 'serialization-items.json', 'compatibility-review-input.json', 'dependency-processing-manifest.json']) assert.deepEqual(readFileSync(join(f.base, 'out', name)), readFileSync(join(f.base, 'again', name)));
  await assert.rejects(() => processDependencies(f.input, { base: f.base, output: join(f.base, 'out') }), /already exists/);
});

test('partial, failed, missing required and dangling identities cannot pass graph acceptance', async t => {
  for (const mode of ['partial', 'failed', 'missing', 'dangling-target', 'dangling-consumer']) {
    const f = fixture(t);
    if (mode === 'partial') f.save({ partial: true, limited: true });
    else {
      f.edges.push(mode === 'dangling-target' ? edge(1, 88, 'item-template') : mode === 'dangling-consumer' ? edge(88, 2, 'item-template') : { consumer: null, relation: 'seed', raw: id(88), kind: 'template', required: true, status: mode, language: 'en' });
      f.save();
    }
    const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
    assert.equal(result.collectionComplete, false, mode);
    assert.equal(result.serializationReady, false, mode);
    assert.equal(f.read('dependency-index.json').status, 'partial');
  }
});

test('items known to exist outside the requested language/version remain explicit scope gaps', async t => {
  const f = fixture(t);
  f.edges.push({ consumer: { id: id(1), language: 'en', version: '1' }, relation: 'datasource', raw: id(88), kind: 'datasource', required: true,
    status: 'available-outside-scope', language: 'en', requestedVersion: 'latest', available: [{ id: id(88), path: '/sitecore/content/Shared/Only French', language: 'fr', version: '1' }] });
  f.save();
  const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.collectionComplete, false);
  assert.equal(result.serializationReady, false);
  assert.ok(f.read('dependency-index.json').gaps.some(row => row.code === 'dependency-outside-requested-scope' && row.available?.[0]?.language === 'fr'));
});

test('partial dependency evidence exits successfully as a reportable result, not a tool error', async t => {
  const f = fixture(t);
  f.save({ partial: true, errorCount: 1 });
  writeFileSync(join(f.base, 'process-input.json'), JSON.stringify(f.input));
  const direct = await processDependencies(f.input, { base: f.base, output: join(f.base, 'partial-output') });
  assert.equal(direct.collectionComplete, false);
  assert.equal(direct.boundedComplete, true);
  assert.equal(direct.scopeReconciled, true);
  const items = JSON.parse(readFileSync(join(f.base, 'partial-output', 'serialization-items.json'), 'utf8'));
  assert.equal(items.status, 'partial');
  assert.equal(items.items.length, f.nodes.length);
  assert.equal(items.source.dependencyManifestSha256, direct.inputs[0].manifestSha256);
  assert.equal(direct.outputs.some(row => row.path === 'serialization-items.json'), true);
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/analysis/process-dependencies.mjs', import.meta.url)),
    '--input', join(f.base, 'process-input.json'), '--output', join(f.base, 'partial-cli-output'),
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.collectionComplete, false);
  assert.equal(result.boundedComplete, true);
  assert.equal(result.scopeReconciled, true);
  assert.equal(result.outputs.some(row => row.path === 'serialization-items.json'), true);
});

test('same-path distinct IDs stay visible and block path-only serialization', async t => {
  const f = fixture(t);
  f.nodes.push({ ...f.nodes[6], id: id(70) }); f.save();
  const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.collectionComplete, true);
  assert.equal(result.serializationReady, false);
  assert.equal(f.read('dependency-index.json').duplicates[0].ids.length, 2);
  assert.equal(f.read('dependency-index.json').nodes.length, 12);
  assert.equal(f.read('dependency-processing-manifest.json').outputs.some(row => row.path === 'serialization-items.json'), false);
});

test('rejects wrong scope, corrupt bytes and contradictory node versions', async t => {
  for (const mode of ['scope', 'bytes', 'conflict', 'missing-flags']) {
    const f = fixture(t);
    if (mode === 'scope') f.input.scope = { ...scope, database: 'web' };
    if (mode === 'bytes') writeFileSync(join(f.base, 'raw/items.jsonl'), '{}\n');
    if (mode === 'conflict') { f.nodes.push({ ...f.nodes[0], path: '/sitecore/content/Other' }); f.save(); }
    if (mode === 'missing-flags') { const p = join(f.base, 'raw/manifest.json'), m = JSON.parse(readFileSync(p)); delete m.summary.errorCount; writeFileSync(p, JSON.stringify(m)); }
    await assert.rejects(() => processDependencies(f.input, { base: f.base, output: join(f.base, 'out') }), /scope|byte size|conflicting|flags/i, mode);
  }
});

test('does not invent cross-language cycles or consumers by collapsing identity scope', async t => {
  const f = fixture(t);
  f.input.scope = { ...scope, languages: ['en', 'fr'] };
  f.nodes.splice(0, f.nodes.length,
    node(1, '/sitecore/content/Acme/Home', 'content'),
    node(2, '/sitecore/templates/Project/Acme/A', 'template'),
    node(3, '/sitecore/templates/Project/Acme/B', 'template'));
  f.nodes.push(...f.nodes.map(row => ({ ...row, language: 'fr' })));
  const french = (from, to, relation) => { const row = edge(from, to, relation); row.language = 'fr'; if (row.consumer) row.consumer.language = 'fr'; return row; };
  f.edges.splice(0, f.edges.length, edge(null, 1, 'seed'), edge(1, 2, 'item-template'), edge(2, 3, 'base-template'), french(null, 1, 'seed'), french(3, 2, 'base-template'));
  f.save();
  const p = join(f.base, 'raw/manifest.json'), m = JSON.parse(readFileSync(p)); m.summary.scope.languages = ['en', 'fr']; writeFileSync(p, JSON.stringify(m));
  await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  const index = f.read('dependency-index.json');
  assert.equal(index.cycles.length, 0);
  const consumers = index.reverseConsumers.filter(row => row.id === id(3));
  assert.deepEqual(consumers.find(row => row.language === 'en').contentItemIds, [id(1)]);
  assert.deepEqual(consumers.find(row => row.language === 'fr').contentItemIds, []);
});

test('retains transitive consumer versions in dependency and compatibility review evidence', async t => {
  const f = fixture(t);
  f.input.scope = { ...scope, version: '*' };
  f.nodes.push({ ...f.nodes[0], version: '2' }, { ...f.nodes[4], version: '2' });
  const contentV2 = edge(1, 3, 'item-template'); contentV2.consumer.version = '2';
  const renderingV2 = edge(5, 3, 'item-template'); renderingV2.consumer.version = '2';
  f.edges.push(contentV2, edge(5, 3, 'item-template'), renderingV2);
  f.save();
  await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  const dependency = f.read('dependency-index.json').reverseConsumers.find(row => row.id === id(3));
  const contentItems = [{ id: id(1), language: 'en', version: '1' }, { id: id(1), language: 'en', version: '2' }];
  const renderings = [{ id: id(5), language: 'en', version: '1' }, { id: id(5), language: 'en', version: '2' }];
  assert.deepEqual(dependency.contentItemConsumers, contentItems);
  assert.deepEqual(dependency.renderingConsumers, renderings);
  assert.deepEqual(dependency.contentItemIds, [id(1)]);
  assert.deepEqual(dependency.renderingIds, [id(5)]);
  const candidate = f.read('compatibility-review-input.json').candidates.find(row => row.id === id(3));
  assert.deepEqual(candidate.usedByItemIdentities, contentItems);
  assert.deepEqual(candidate.usedByRenderingIdentities, renderings);
  assert.deepEqual(candidate.usedByItems, [id(1)]);
  assert.deepEqual(candidate.usedByRenderings, [id(5)]);
});

test('serialization requires reconciliation against original inventory and rendering identities', async t => {
  for (const mode of ['absent', 'missing-record', 'moved-record', 'partial']) {
    const f = fixture(t);
    if (mode === 'absent') delete f.input.expectations;
    else {
      const file = join(f.base, 'raw/inventory.jsonl'), manifestFile = join(f.base, 'raw/inventory-manifest.json');
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse), manifest = JSON.parse(readFileSync(manifestFile));
      if (mode === 'missing-record') rows.push({ ...rows[0], id: id(75), path: scope.siteRoot + '/Uncaptured' });
      if (mode === 'moved-record') rows[0].path += '/Changed';
      if (mode === 'partial') manifest.summary.partial = true;
      writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); manifest.files[0].size = statSync(file).size; manifest.summary.visited = rows.length; writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
    assert.equal(result.scopeReconciled, false, mode);
    assert.equal(result.serializationReady, false, mode);
  }
});

test('returned seeds must match planned site, rendering and probe roots', async t => {
  const f = fixture(t);
  const manifestPath = join(f.base, 'raw/manifest.json'), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.summary.scope.seeds = manifest.summary.scope.seeds.filter(row => row.kind !== 'placeholder');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.scopeReconciled, false);
  assert.equal(result.serializationReady, false);
  assert.ok(f.read('dependency-index.json').gaps.some(row => row.code === 'seed-scope-mismatch'));
});

test('branch root retains content consumers through its scaffold ancestor', async t => {
  const f = fixture(t);
  f.nodes.push(node(12, '/sitecore/templates/Branches/Project/Acme/Page', 'branch'));
  f.edges.push(edge(9, 12, 'branch-ancestor'));
  f.save();
  await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.deepEqual(f.read('dependency-index.json').reverseConsumers.find(row => row.id === id(12)).contentItemIds, [id(1)]);
});

test('expected captures reject numeric fallback and conflicting latest identities', async t => {
  for (const mode of ['numeric-fallback', 'latest-conflict']) {
    const f = fixture(t);
    if (mode === 'numeric-fallback') {
      f.input.scope = { ...scope, version: '2' };
      for (const row of f.nodes) row.version = '2';
      for (const row of f.edges) { if (row.consumer) row.consumer.version = '2'; if (row.status === 'resolved') row.version = '2'; }
    }
    f.save();
    const manifestPath = join(f.base, 'raw/inventory-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    const path = join(f.base, 'raw/inventory.jsonl');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    if (mode === 'numeric-fallback') rows[0].version = '1';
    else rows.push({ ...rows[0], version: '2' });
    writeFileSync(path, rows.map(JSON.stringify).join('\n') + '\n');
    manifest.files[0].size = statSync(path).size; manifest.summary.visited = rows.length;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => processDependencies(f.input, { base: f.base, output: join(f.base, 'out') }), /version|latest/i, mode);
  }
});

test('resolved edges cannot join identities across languages', async t => {
  const f = fixture(t);
  f.input.scope = { ...scope, languages: ['en', 'fr'] };
  f.nodes.push({ ...f.nodes[0], language: 'fr' }, { ...f.nodes[1], language: 'fr' });
  const crossed = edge(1, 2, 'item-template'); crossed.language = 'fr';
  const templateToFrench = edge(2, 2, 'base-template'); templateToFrench.language = 'fr';
  const templateToEnglish = edge(2, 2, 'base-template'); templateToEnglish.consumer.language = 'fr';
  f.edges.push(crossed, templateToFrench, templateToEnglish);
  f.save();
  const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.serializationReady, false);
  const index = f.read('dependency-index.json');
  assert.ok(index.gaps.some(row => row.code === 'cross-language-edge'));
  assert.ok(index.edges.some(row => row.consumer?.id === id(1) && row.consumer.language === 'en' && row.language === 'fr'), 'raw invalid edge remains evidence');
  assert.deepEqual(index.reverseConsumers.find(row => row.id === id(2) && row.language === 'fr').contentItemIds, []);
  assert.equal(index.cycles.some(row => row.members.some(member => member.language === 'fr')), false);
});

test('dangling edges stay as evidence without entering derived relationships', async t => {
  const f = fixture(t);
  f.edges.push(edge(1, 88, 'item-template'), edge(88, 2, 'base-template'));
  f.save();
  await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  const index = f.read('dependency-index.json');
  assert.ok(index.edges.some(row => row.targetId === id(88)));
  assert.ok(index.gaps.some(row => row.code === 'missing-target'));
  assert.ok(index.gaps.some(row => row.code === 'missing-consumer'));
  assert.equal(index.reverseConsumers.some(row => row.directConsumers.some(consumer => consumer.id === id(88))), false);
  assert.equal(index.cycles.some(row => row.members.some(member => member.id === id(88))), false);
});

test('latest scope accepts distinct actual versions for different referenced IDs', async t => {
  const f = fixture(t);
  f.nodes.find(row => row.id === `{${id(2)}}`).version = '3';
  for (const row of f.edges) {
    if (row.consumer?.id === id(2)) row.consumer.version = '3';
    if (row.status === 'resolved' && row.targetId === id(2)) row.version = '3';
  }
  f.save();
  const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.serializationReady, true);
  assert.ok(f.read('dependency-index.json').nodes.some(row => row.id === id(2) && row.version === '3'));
});

test('numeric content scope permits unversioned metadata but rejects content and other fallback', async t => {
  for (const mode of ['metadata-zero', 'content-zero', 'metadata-other']) {
    const f = fixture(t);
    f.input.scope = { ...scope, version: '2' };
    for (const row of f.nodes) row.version = '2';
    for (const row of f.edges) {
      if (row.consumer) row.consumer.version = '2';
      if (row.status === 'resolved') row.version = '2';
    }
    const target = mode === 'content-zero' ? 1 : 2;
    const fallback = mode === 'metadata-other' ? '1' : '0';
    f.nodes.find(row => row.id === `{${id(target)}}`).version = fallback;
    for (const row of f.edges) {
      if (row.consumer?.id === id(target)) row.consumer.version = fallback;
      if (row.status === 'resolved' && row.targetId === id(target)) row.version = fallback;
    }
    f.save();
    const manifestPath = join(f.base, 'raw/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    manifest.summary.scope.version = '2';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    if (mode === 'metadata-zero') {
      const result = await processDependencies(f.input, { base: f.base, output: join(f.base, 'out') });
      assert.equal(result.collectionComplete, true);
      assert.ok(f.read('dependency-index.json').nodes.some(row => row.id === id(2) && row.version === '0'));
    } else {
      await assert.rejects(() => processDependencies(f.input, { base: f.base, output: join(f.base, 'out') }), /version outside requested scope/);
    }
  }
});
