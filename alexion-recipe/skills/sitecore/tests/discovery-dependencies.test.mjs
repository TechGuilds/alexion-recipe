import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assembleDiscovery } from '../scripts/analysis/assemble-discovery.mjs';
import { deriveDependencySeeds } from '../scripts/analysis/prepare-dependency-request.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function fixture(t) {
  const base = mkdtempSync(join(process.cwd(), '.tmp-discovery-closure-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (name, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    mkdirSync(join(base, name, '..'), { recursive: true }); writeFileSync(join(base, name), bytes); return bytes;
  };
  const capture = (name, rows, scope, extra = {}) => {
    const bytes = put(name + '.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
    put(name + '-manifest.json', { version: 1, status: 'completed', files: [{ name: name + '.jsonl', size: bytes.length }], summary: { visited: rows.length, partial: false, limited: false, errorCount: 0, scope, ...extra } });
    return { records: name + '.jsonl', manifest: name + '-manifest.json' };
  };
  const scope = { siteRoot: '/sitecore/content/Acme', database: 'master', languages: ['en'], versions: ['latest'], devices: [id(90)] };
  const node = (n, path, kind, templateName, fields = {}) => ({ id: id(n), path, name: path.split('/').at(-1), language: 'en', version: '1', templateId: id(2), templateName, kind, fields, fieldDefinitions: Object.entries(fields).map(([name, value]) => ({ name, value, type: 'Single-Line Text', id: id(80) })) });
  const page = { ...node(1, scope.siteRoot, 'content', 'Page'), hasPresentation: true };
  const rendering = node(3, '/sitecore/layout/Renderings/Feature/Acme/Hero', 'rendering', 'Json rendering', { 'Component Name': 'Hero', Placeholders: id(4) });
  const nodes = [page, node(2, '/sitecore/templates/Project/Acme/Page', 'template', 'Template'), rendering,
    node(4, '/sitecore/layout/Placeholder Settings/Project/Acme/main', 'placeholder', 'Placeholder', { 'Placeholder Key': 'main', 'Allowed Controls': id(3) })];
  const relation = (from, to, name, kind) => ({ consumer: { id: id(from), language: 'en', version: '1' }, targetId: id(to), language: 'en', version: '1', relation: name, kind, status: 'resolved', required: true, raw: id(to) });
  const edges = [relation(1, 2, 'item-template', 'template'), relation(1, 3, 'rendering', 'rendering'), relation(4, 3, 'allowed-rendering', 'rendering')];
  const capturedScope = { database: 'master', languages: ['en'], version: 'latest' };
  const renderingScopes = [{ reference: '/sitecore/layout/Renderings/Feature/Acme', recursive: true }];
  const input = { version: 1, source: { connectorId: 'source-sitecore', identity: 'fixture', capturedAt: '2026-09-26T00:00:00Z' }, scope, exports: {
    items: capture('items', [page], { ...capturedScope, sitePath: scope.siteRoot, includesRoot: true }),
    renderings: capture('renderings', [rendering], { ...capturedScope, itemPaths: renderingScopes.map(row => row.reference), recurse: true }),
    presentation: capture('presentation', [{ ...page, deviceId: id(90), shared: [], final: [{ renderingId: id(3), uid: id(30), index: 0, placeholder: 'main', datasource: '', parameters: '' }], sxa: { pageDesign: '', partialDesigns: '', basePartialDesign: '', expanded: false } }], { ...capturedScope, itemPaths: [scope.siteRoot], devices: scope.devices }),
    coverage: capture('coverage', [{ type: 'meta', language: 'en', version: 'latest', deviceId: id(90), totalPages: 1 }, { type: 'coverage', itemId: id(1), itemPath: scope.siteRoot, route: '/', language: 'en', version: '1', versionScope: 'latest', deviceId: id(90), renderingIds: [id(3)], cumulativeCoverage: 1 }], { ...capturedScope, operation: 'analyze-rendering-coverage', sitePath: scope.siteRoot, devices: scope.devices }),
    serialization: { manifest: 'serialization.json', suggestedExclusions: [] },
    templateClassifications: { records: 'classifications.json' }, dependencyAudit: { records: 'audit.json' },
  } };
  const saveDependencies = (extra = {}) => {
    const itemBytes = put('dependency-items.jsonl', nodes.map(JSON.stringify).join('\n') + '\n');
    const edgeBytes = put('dependency-edges.jsonl', edges.map(JSON.stringify).join('\n') + '\n');
    put('dependencies-manifest.json', { version: 1, status: 'completed', files: [{ name: 'dependency-items.jsonl', size: itemBytes.length }, { name: 'dependency-edges.jsonl', size: edgeBytes.length }], summary: { visited: nodes.length, partial: false, limited: false, errorCount: 0, scope: { ...capturedScope, operation: 'inspect-dependencies', devices: scope.devices, seeds: deriveDependencySeeds(scope.siteRoot, renderingScopes), remainingRequests: 0 }, ...extra } });
  };
  saveDependencies();
  input.exports.dependencies = { targetFlavor: 'xmc', items: { records: 'dependency-items.jsonl', manifest: 'dependencies-manifest.json' }, edges: { records: 'dependency-edges.jsonl', manifest: 'dependencies-manifest.json' } };
  put('module.json', { namespace: 'Acme', items: { includes: nodes.map(row => ({ path: row.path, scope: 'SingleItem' })) } });
  put('serialization.json', { status: 'complete', modules: [{ name: 'Acme', configPath: 'module.json', includePaths: nodes.map(row => row.path) }], missingReferences: [] });
  put('classifications.json', { version: 1, classifications: [{ templateId: id(2), classification: 'review-required', reason: 'Target review recorded', evidence: ['dependency-items.jsonl'] }] });
  put('audit.json', { version: 1, sections: Object.fromEntries(['templates', 'datasources', 'layoutsPlaceholders', 'branches', 'resolvers', 'sxa', 'compatibility', 'duplicates'].map(key => [key, { status: 'complete', evidence: ['dependency-items.jsonl', 'dependency-edges.jsonl', 'dependencies-manifest.json'], findings: [{ reason: 'Reviewed migration risk remains', owner: 'migration' }] }])) });
  return { base, input, nodes, edges, put, capture, saveDependencies, read: name => JSON.parse(readFileSync(join(base, 'out', name))) };
}

test('optional coverage gaps do not block complete required content delivery', async t => {
  for (const state of ['absent', 'partial']) {
    await t.test(state, async t => {
      const f = fixture(t);
      if (state === 'absent') delete f.input.exports.coverage;
      else {
        const manifest = JSON.parse(readFileSync(join(f.base, 'coverage-manifest.json')));
        manifest.summary.partial = true;
        manifest.summary.errorCount = 1;
        f.put('coverage-manifest.json', manifest);
      }
      const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
      assert.equal(result.synthesisReady, true);
      assert.equal(result.deliverablesReady, true);
      assert.equal(result.completeness.coverage, state === 'absent' ? 'unavailable' : 'partial');
    });
  }
});

test('assembly derives SXA facts from revalidated dependency exports without waiving migration findings', async t => {
  const f = fixture(t);
  const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.deliverablesReady, true);
  const sxa = f.read('sxa-conversion-inputs.json');
  assert.equal(sxa.status, 'complete');
  assert.equal(sxa.pageTemplates.length, 1);
  assert.ok(sxa.placeholders.length > 0);
  assert.equal(f.read('discovery-manifest.json').completeness.dependencies, 'complete');
  assert.equal(f.read('dependencies/dependency-index.json').nodes.length, 4);
});

test('audit labels cannot waive missing or partial dependency capture', async t => {
  for (const mode of ['absent', 'partial', 'limited']) {
    const f = fixture(t);
    if (mode === 'absent') delete f.input.exports.dependencies;
    else {
      f.saveDependencies({ partial: true, errorCount: 1, limited: mode === 'limited' });
      if (mode === 'partial') {
        const plan = JSON.parse(readFileSync(join(f.base, 'serialization.json')));
        plan.status = 'partial';
        plan.sourceDependencyManifestSha256 = createHash('sha256').update(readFileSync(join(f.base, 'dependencies-manifest.json'))).digest('hex');
        f.put('serialization.json', plan);
      }
      const audit = JSON.parse(readFileSync(join(f.base, 'audit.json')));
      for (const section of Object.values(audit.sections)) { section.status = 'partial'; section.findings.push({ reason: 'Supplemental referenced item could not be read', owner: 'discovery-follow-up' }); }
      f.put('audit.json', audit);
    }
    const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
    assert.equal(result.deliverablesReady, false, mode);
    assert.equal(result.discoveryReady, mode === 'partial', 'only a reconciled, non-truncated supplemental graph gap may remain non-blocking');
    assert.equal(f.read('discovery-manifest.json').completeness.dependencies, mode === 'absent' ? 'unavailable' : 'partial');
    assert.equal(f.read('discovery-manifest.json').discoveryReady, mode === 'partial');
  }
});

test('bounded reconciled dependency misses and a nonempty partial serialization plan remain visible without blocking historical Discovery', async t => {
  const f = fixture(t);
  f.saveDependencies({ partial: true, errorCount: 1 });
  const sections = Object.fromEntries(['templates', 'datasources', 'layoutsPlaceholders', 'branches', 'resolvers', 'sxa', 'compatibility', 'duplicates'].map(key => [key, {
    status: 'partial', evidence: ['dependency-items.jsonl', 'dependency-edges.jsonl', 'dependencies-manifest.json'],
    findings: [{ code: 'unread-reference', relation: 'datasource', reason: 'A supplemental source reference was not found' }],
  }]));
  f.put('audit.json', { version: 1, sections });
  f.input.exports.dependencyAudit = { records: 'audit.json' };
  const pages = readFileSync(join(f.base, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  pages[0].final[0].renderingId = '';
  f.input.exports.presentation = f.capture('presentation', pages, { database: 'master', languages: ['en'], version: 'latest', devices: f.input.scope.devices, itemPaths: [f.input.scope.siteRoot] });
  const includePaths = f.nodes.map(row => row.path);
  f.put('module.json', { namespace: 'Acme', items: { includes: includePaths.map(path => ({ path, scope: 'SingleItem' })) } });
  const dependencyManifestSha256 = createHash('sha256').update(readFileSync(join(f.base, 'dependencies-manifest.json'))).digest('hex');
  f.put('serialization.json', { status: 'partial', sourceDependencyManifestSha256: dependencyManifestSha256, modules: [{ name: 'Acme', configPath: 'module.json', includePaths }], missingReferences: [{ relation: 'datasource', id: id(5), reason: 'unread-reference' }] });

  const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
  const manifest = f.read('discovery-manifest.json');
  assert.equal(result.discoveryReady, true, JSON.stringify({ result, unresolved: manifest.unresolved, dependencyProcessing: manifest.completeness }));
  assert.equal(result.synthesisReady, true);
  assert.equal(result.deliverablesReady, false);
  assert.equal(manifest.completeness.dependencies, 'partial');
  assert.ok(manifest.unresolved.some(row => row.code === 'rendering-identity-unavailable'));
  assert.ok(manifest.unresolved.some(row => row.code === 'serialization-references-unresolved' && row.count === 1));
  assert.ok(readFileSync(join(f.base, 'out', 'content-discovery-report.md'), 'utf8').includes('success with findings'));
});

test('unreconciled, truncated, or stale serialization evidence still blocks partial-plan Discovery acceptance', async t => {
  for (const mode of ['unreconciled', 'truncated', 'stale-plan']) {
    const f = fixture(t);
    f.saveDependencies(mode === 'truncated' ? { partial: true, errorCount: 1, limited: true } : { partial: true, errorCount: 1 });
    if (mode === 'unreconciled') {
      const manifest = JSON.parse(readFileSync(join(f.base, 'dependencies-manifest.json')));
      const nodes = readFileSync(join(f.base, 'dependency-items.jsonl'), 'utf8').trim().split('\n');
      f.put('dependency-items.jsonl', nodes.slice(1).join('\n') + '\n');
      manifest.summary.visited -= 1;
      manifest.files[0].size = statSync(join(f.base, 'dependency-items.jsonl')).size;
      f.put('dependencies-manifest.json', manifest);
    }
    const sections = Object.fromEntries(['templates', 'datasources', 'layoutsPlaceholders', 'branches', 'resolvers', 'sxa', 'compatibility', 'duplicates'].map(key => [key, {
      status: 'partial', evidence: ['dependency-items.jsonl', 'dependency-edges.jsonl', 'dependencies-manifest.json'], findings: [{ reason: 'A dependency read needs follow-up' }],
    }]));
    f.put('audit.json', { version: 1, sections });
    f.input.exports.dependencyAudit = { records: 'audit.json' };
    const includePaths = mode === 'unreconciled' ? [] : mode === 'stale-plan' ? [f.input.scope.siteRoot] : f.nodes.map(row => row.path);
    f.put('module.json', { namespace: 'Acme', items: { includes: includePaths.map(path => ({ path, scope: 'SingleItem' })) } });
    f.put('serialization.json', { status: 'partial', modules: [{ name: 'Acme', configPath: 'module.json', includePaths }], missingReferences: [{ relation: 'datasource', id: id(5) }] });
    const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
    assert.equal(result.discoveryReady, false, mode);
  }
});

test('assembly rejects dependency scope drift and retains raw input unchanged', async t => {
  const f = fixture(t), before = readFileSync(join(f.base, 'dependency-items.jsonl'));
  const manifest = JSON.parse(readFileSync(join(f.base, 'dependencies-manifest.json')));
  manifest.summary.scope.database = 'web'; f.put('dependencies-manifest.json', manifest);
  await assert.rejects(() => assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') }), /scope/);
  assert.deepEqual(readFileSync(join(f.base, 'dependency-items.jsonl')), before);
});

test('complete non-page collection does not require invented presentation rows', async t => {
  const f = fixture(t);
  f.nodes[0].hasPresentation = false;
  f.input.exports.items = f.capture('items', [f.nodes[0]], { sitePath: f.input.scope.siteRoot, includesRoot: true, database: 'master', languages: ['en'], version: 'latest' });
  f.input.exports.presentation = f.capture('presentation', [], { database: 'master', languages: ['en'], version: 'latest', devices: f.input.scope.devices });
  f.saveDependencies();
  const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.deliverablesReady, true);
  assert.deepEqual(f.read('sxa-conversion-inputs.json').pageTemplates, []);
});

test('missing native SXA fields make derived output and delivery partial', async t => {
  for (const missingField of ['pageDesign', 'partialDesigns', 'basePartialDesign']) {
    const f = fixture(t);
    const pages = readFileSync(join(f.base, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    delete pages[0].sxa[missingField];
    f.input.exports.presentation = f.capture('presentation', pages, { database: 'master', languages: ['en'], version: 'latest', devices: f.input.scope.devices, itemPaths: [f.input.scope.siteRoot] });
    const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
    assert.equal(result.deliverablesReady, false, missingField);
    assert.equal(f.read('sxa-conversion-inputs.json').status, 'partial', missingField);
    assert.equal(f.read('discovery-manifest.json').completeness.sxa, 'partial', missingField);
    assert.ok(f.read('discovery-manifest.json').unresolved.some(row => row.code === 'sxa-fields-unavailable'), missingField);
  }
});

test('resolved design graph can remain complete without runtime flattening', async t => {
  const f = fixture(t);
  const pages = readFileSync(join(f.base, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  pages[0].sxa.pageDesign = id(4);
  f.input.exports.presentation = f.capture('presentation', pages, { database: 'master', languages: ['en'], version: 'latest', devices: f.input.scope.devices, itemPaths: [f.input.scope.siteRoot] });
  f.edges.push({ consumer: { id: id(1), language: 'en', version: '1' }, targetId: id(4), language: 'en', version: '1', relation: 'page-design', kind: 'sxa', status: 'resolved', required: true, raw: id(4) });
  f.saveDependencies();
  const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.deliverablesReady, true);
  assert.equal(f.read('sxa-conversion-inputs.json').status, 'complete');
  assert.equal(f.read('sxa-conversion-inputs.json').designReferences.length, 1);
});

test('serialization planning cannot silently omit captured dependency paths', async t => {
  const f = fixture(t), paths = [f.input.scope.siteRoot];
  f.put('module.json', { namespace: 'Acme', items: { includes: paths.map(path => ({ path, scope: 'SingleItem' })) } });
  f.put('serialization.json', { status: 'complete', modules: [{ name: 'Acme', configPath: 'module.json', includePaths: paths }], missingReferences: [] });
  const result = await assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') });
  assert.equal(result.deliverablesReady, false);
  assert.equal(result.discoveryReady, false, 'complete graph plus omitted required paths must block historical serialization acceptance');
  assert.ok(f.read('discovery-manifest.json').unresolved.some(row => row.code === 'serialization-dependencies-missing'));
});

test('full delivery validates native presentation scope and resolved-array shape', async t => {
  for (const mode of ['database', 'version', 'missing-final']) {
    const f = fixture(t);
    const pages = readFileSync(join(f.base, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    if (mode === 'missing-final') delete pages[0].final;
    const scope = { database: mode === 'database' ? 'web' : 'master', languages: ['en'], version: mode === 'version' ? '2' : 'latest', devices: f.input.scope.devices, itemPaths: [f.input.scope.siteRoot] };
    f.input.exports.presentation = f.capture('presentation', pages, scope);
    await assert.rejects(() => assembleDiscovery(f.input, { base: f.base, output: join(f.base, 'out') }), /presentation/i, mode);
  }
});
