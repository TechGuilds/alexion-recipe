import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assembleDiscovery } from '../scripts/analysis/assemble-discovery.mjs';

const coverageScope = { sitePath: '/sitecore/content/acme', database: 'master', languages: ['en'], version: 'latest', devices: ['{DEVICE}'] };
const coverageRowScope = { language: 'en', version: 'latest', deviceId: '{DEVICE}' };

const fixture = t => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-discovery-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    return name;
  };
  const jsonl = (name, rows) => put(name, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const manifest = (name, operation, file, { partial = false, scope = {} } = {}) => put(name, {
    kind: 'kajoo-export', version: 1,
    files: [{ path: file, name: file, size: statSync(join(root, file)).size }],
    summary: { visited: 2, partial, limited: false, errorCount: partial ? 1 : 0, scope: { operation, ...(operation === 'analyze-rendering-coverage' ? coverageScope : {}), ...scope } },
  });
  return { root, put, jsonl, manifest };
};

function stagedInput(f, { presentationPartial = false } = {}) {
  f.jsonl('items.jsonl', [
    { id: '{PAGE-1}', path: '/sitecore/content/acme/home', name: 'Home', templateId: '{PAGE-T}', templateName: 'Page', language: 'en', version: '1', fields: {}, hasPresentation: true },
    { id: '{PAGE-2}', path: '/sitecore/content/acme/about', name: 'About', templateId: '{PAGE-T}', templateName: 'Page', language: 'en', version: '1', fields: {}, hasPresentation: true },
  ]);
  f.jsonl('renderings.jsonl', [
    { id: '{R-1}', path: '/sitecore/layout/Renderings/Feature/Hero', name: 'Hero', templateId: '{RENDERING-T}', templateName: 'Controller rendering', language: 'en', version: '1', fields: { Controller: 'Hero', 'Rendering Contents Resolver': '{RESOLVER-1}' }, missingFields: [] },
    { id: '{R-2}', path: '/sitecore/layout/Renderings/Feature/Card', name: 'Card', templateId: '{RENDERING-T}', templateName: 'Json rendering', language: 'en', version: '1', fields: { 'Component Name': 'Card' }, missingFields: [] },
  ]);
  f.jsonl('presentation.jsonl', [
    { id: '{PAGE-1}', path: '/sitecore/content/acme/home', name: 'Home', templateId: '{PAGE-T}', templateName: 'Page', language: 'en', version: '1', deviceId: '{DEVICE}', sharedXml: '<r/>', finalXml: '', shared: [{ index: 0, uid: '{U-1}', renderingId: '{R-1}', placeholder: 'main', datasource: '{D-1}', parameters: '' }], final: [], sxa: { pageDesign: '', partialDesigns: '', basePartialDesign: '', expanded: false }, inheritance: 'resolved' },
    { id: '{PAGE-2}', path: '/sitecore/content/acme/about', name: 'About', templateId: '{PAGE-T}', templateName: 'Page', language: 'en', version: '1', deviceId: '{DEVICE}', sharedXml: '<r/>', finalXml: '', shared: [{ index: 0, uid: '{U-2}', renderingId: '{R-2}', placeholder: 'main', datasource: '', parameters: '' }], final: [], sxa: { pageDesign: '{DESIGN-1}', partialDesigns: '', basePartialDesign: '', expanded: false }, inheritance: 'resolved' },
  ]);
  f.jsonl('coverage.jsonl', [
    { ...coverageRowScope, type: 'frequency', renderingId: '{R-1}', name: 'Hero', pageCount: 1, isGlobal: false },
    { ...coverageRowScope, type: 'frequency', renderingId: '{R-2}', name: 'Card', pageCount: 1, isGlobal: false },
    { ...coverageRowScope, type: 'coverage', version: '1', versionScope: 'latest', itemId: '{PAGE-1}', route: '/', itemPath: '/sitecore/content/acme/home', renderingIds: ['{R-1}'], renderingNames: ['Hero'], cumulativeCoverage: 1 },
    { ...coverageRowScope, type: 'coverage', version: '1', versionScope: 'latest', itemId: '{PAGE-2}', route: '/about', itemPath: '/sitecore/content/acme/about', renderingIds: ['{R-2}'], renderingNames: ['Card'], cumulativeCoverage: 2 },
    { ...coverageRowScope, type: 'meta', totalPages: 2, globalThreshold: 2 },
  ]);
  f.manifest('items-manifest.json', 'discover-site', 'items.jsonl', { scope: { sitePath: '/sitecore/content/acme', database: 'master', languages: ['en'], version: 'latest' } });
  f.manifest('renderings-manifest.json', 'inspect-renderings', 'renderings.jsonl');
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl', { partial: presentationPartial });
  f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl');
  f.put('serialization-manifest.json', { version: 1, status: 'complete', modules: [{ name: 'Acme', configPath: 'modules/Acme.module.json', includePaths: ['/sitecore/content/acme'] }], itemCount: 2, templateCount: 1, missingReferences: [] });
  f.put('modules/Acme.module.json', { namespace: 'Acme', items: { includes: [{ path: '/sitecore/content/acme', scope: 'ItemAndDescendants' }] } });
  f.put('template-classifications.json', { version: 1, source: 'reviewed-catalog', classifications: [{ templateId: '{PAGE-T}', classification: 'portable', reason: 'page template' }] });
  return {
    version: 1,
    source: { connectorId: 'source-sitecore', identity: 'acme-xp', revision: 'source-snapshot-1', capturedAt: '2026-09-25T12:00:00Z' },
    scope: { siteRoot: '/sitecore/content/acme', database: 'master', languages: ['en'], versions: ['latest'], devices: ['{DEVICE}'] },
    exports: {
      items: { records: 'items.jsonl', manifest: 'items-manifest.json' },
      renderings: { records: 'renderings.jsonl', manifest: 'renderings-manifest.json' },
      presentation: { records: 'presentation.jsonl', manifest: 'presentation-manifest.json' },
      coverage: { records: 'coverage.jsonl', manifest: 'coverage-manifest.json' },
      serialization: { manifest: 'serialization-manifest.json', suggestedExclusions: [{ path: '/sitecore/content/acme/archive', reason: 'approved discovery suggestion', affectedItems: 1, evidence: 'items.jsonl' }] },
      templateClassifications: { records: 'template-classifications.json' },
    },
  };
}

test('assembles the Sitecore Discovery evidence set with stable joins and provenance', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'assembled');
  const report = await assembleDiscovery(input, { base: f.root, output });
  assert.equal(report.valid, true);
  assert.equal(report.synthesisReady, true);
  for (const name of ['rendering-usage.jsonl', 'rendering-details.json', 'rendering-page-mapping.json', 'sxa-conversion-inputs.json', 'xp-only-template-audit.json', 'serialization-config.json', 'coverage-plan.json', 'discovery-manifest.json', 'content-discovery-report.md']) {
    assert.equal(existsSync(join(output, name)), true, name);
  }
  const usage = readFileSync(join(output, 'rendering-usage.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(usage.map(row => [row.renderingId, row.pageId, row.layout]), [['{R-2}', '{PAGE-2}', 'shared'], ['{R-1}', '{PAGE-1}', 'shared']]);
  const mapping = JSON.parse(readFileSync(join(output, 'rendering-page-mapping.json')));
  assert.deepEqual(mapping.renderings.map(row => [row.renderingId, row.pagePaths]), [['{R-1}', ['/sitecore/content/acme/home']], ['{R-2}', ['/sitecore/content/acme/about']]]);
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
  assert.deepEqual(coverage.routes.map(row => row.route), ['/', '/about']);
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.equal(manifest.completeness.overall, 'partial');
  assert.ok(manifest.unresolved.some(item => item.code === 'sxa-design-unexpanded'));
  assert.ok(manifest.outputs.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  const second = join(f.root, 'assembled-again');
  await assembleDiscovery(input, { base: f.root, output: second });
  for (const name of ['rendering-usage.jsonl', 'rendering-details.json', 'rendering-page-mapping.json', 'sxa-conversion-inputs.json', 'xp-only-template-audit.json', 'serialization-config.json', 'coverage-plan.json', 'discovery-manifest.json', 'content-discovery-report.md']) {
    assert.deepEqual(readFileSync(join(second, name)), readFileSync(join(output, name)), name);
  }
});

test('preserves partial source evidence and refuses an existing output directory', async t => {
  const f = fixture(t), input = stagedInput(f, { presentationPartial: true }), output = join(f.root, 'assembled');
  const report = await assembleDiscovery(input, { base: f.root, output });
  assert.equal(report.valid, true);
  assert.equal(report.completeness.presentation, 'partial');
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output }), /already exists/i);
});

test('consumes the actual PowerShell transfer manifest without rewriting its retained bytes', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'transferred');
  for (const name of ['items', 'renderings', 'presentation', 'coverage']) {
    const path = name + '-manifest.json', original = JSON.parse(readFileSync(join(f.root, path)));
    // stagePowershellOutput emits version/status/files/summary, not the original
    // remote kind marker. File pointers are absolute sandbox paths.
    f.put(path, { version: 1, status: 'completed', files: original.files.map(file => ({ name: file.name, path: '/workspace/tmp/captured/' + file.name, size: file.size })), summary: original.summary });
  }
  const before = readFileSync(join(f.root, 'items-manifest.json'));
  const result = await assembleDiscovery(input, { base: f.root, output });
  assert.equal(result.synthesisReady, true);
  assert.deepEqual(readFileSync(join(f.root, 'items-manifest.json')), before);
  const failed = JSON.parse(before); failed.status = 'failed'; f.put('items-manifest.json', failed);
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'failed-transfer') }), /manifest/);
});

test('unknown export failure state is not accepted as complete collection', async t => {
  for (const field of ['limited', 'errorCount']) {
    const f = fixture(t), input = stagedInput(f), path = 'items-manifest.json';
    const manifest = JSON.parse(readFileSync(join(f.root, path)));
    delete manifest.summary[field]; f.put(path, manifest);
    await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'unknown-flags') }), /completeness flags/i);
  }
});

test('retains scoped coverage groups and joins equivalent rendering GUID spellings', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'scoped-coverage');
  input.scope.languages = ['en', 'fr'];
  input.scope.devices = ['{D1}', '{D2}'];
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  for (const file of ['renderings.jsonl', 'presentation.jsonl']) {
    f.put(file, readFileSync(join(f.root, file), 'utf8').replaceAll('{R-1}', `{${id.toUpperCase()}}`));
  }
  const presentations = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  presentations[1].final.push({ ...presentations[0].shared[0], renderingId: id });
  f.jsonl('presentation.jsonl', presentations);
  f.manifest('renderings-manifest.json', 'inspect-renderings', 'renderings.jsonl');
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  f.jsonl('coverage.jsonl', [
    { type: 'frequency', renderingId: id, name: 'Hero', pageCount: 1, language: 'en', version: 'latest', deviceId: '{D1}' },
    { type: 'coverage', itemId: '{PAGE-1}', itemPath: '/sitecore/content/acme/home', route: '/en/home', renderingIds: [id], cumulativeCoverage: 1, language: 'en', version: '3', versionScope: 'latest', deviceId: '{D1}' },
    { type: 'meta', totalPages: 2, globalThreshold: 2, language: 'en', version: 'latest', deviceId: '{D1}', basis: 'SPE resolved final presentation' },
    { type: 'uncovered', renderingId: id, language: 'fr', version: 'latest', deviceId: '{D2}' },
    { type: 'meta', totalPages: 0, globalThreshold: 0, language: 'fr', version: 'latest', deviceId: '{D2}', basis: 'SPE resolved final presentation' },
  ]);
  f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl', { scope: { languages: ['fr', 'en'], devices: ['d2', 'd1'] } });
  await assembleDiscovery(input, { base: f.root, output });
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
  assert.equal(coverage.routes[0].language, 'en');
  assert.equal(coverage.routes[0].version, '3');
  assert.equal(coverage.routes[0].versionScope, 'latest');
  assert.equal(coverage.routes[0].deviceId, '{D1}');
  assert.equal(coverage.routes[0].itemId, '{PAGE-1}');
  assert.equal(coverage.frequencies[0].deviceId, '{D1}');
  assert.equal(coverage.uncovered[0].language, 'fr');
  assert.deepEqual(coverage.metadata.scopes.map(row => [row.language, row.deviceId, row.totalPages]), [['en', '{D1}', 2], ['fr', '{D2}', 0]]);
  const mapping = JSON.parse(readFileSync(join(output, 'rendering-page-mapping.json')));
  const heroRows = mapping.renderings.filter(row => row.renderingId.replace(/[{}]/g, '').toLowerCase() === id);
  assert.equal(heroRows.length, 1);
  assert.deepEqual(heroRows[0].routes, ['/en/home']);
});

test('rejects coverage manifest scope mismatches before using its routes', async t => {
  const cases = [
    ['operation', 'discover-site'], ['sitePath', '/sitecore/content/other'], ['database', 'web'],
    ['languages', ['fr']], ['languages', ['en', 'fr']], ['devices', ['{OTHER}']],
    ['version', '2'], ['version', '*'], ['devices', undefined],
  ];
  for (const [field, value] of cases) await t.test(`${field}: ${JSON.stringify(value)}`, async t => {
    const f = fixture(t), input = stagedInput(f);
    const manifest = JSON.parse(readFileSync(join(f.root, 'coverage-manifest.json')));
    manifest.summary.scope[field] = value;
    f.put('coverage-manifest.json', manifest);
    const output = join(f.root, 'rejected');
    await assert.rejects(() => assembleDiscovery(input, { base: f.root, output }), /coverage.*scope/i);
    assert.equal(existsSync(join(output, 'coverage-plan.json')), false);
  });
});

test('rejects coverage records outside their declared scope', async t => {
  const cases = [
    ['language', 'fr'], ['deviceId', '{OTHER}'], ['version', 'latest'], ['versionScope', '2'],
    ['versionScope', undefined], ['itemPath', '/sitecore/content/acme-other/home'],
    ['itemPath', '/sitecore/content/acme/../other'], ['itemPath', undefined],
  ];
  for (const [field, value] of cases) await t.test(`${field}: ${JSON.stringify(value)}`, async t => {
    const f = fixture(t), input = stagedInput(f);
    const rows = readFileSync(join(f.root, 'coverage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    rows.find(row => row.type === 'coverage')[field] = value;
    f.jsonl('coverage.jsonl', rows);
    f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl');
    await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'rejected') }), /coverage.*scope/i);
  });
});

test('retains coverage input hashes and accepts matched numeric and all-version groups', async t => {
  for (const version of ['2', '*']) await t.test(version, async t => {
    const f = fixture(t), input = stagedInput(f), output = join(f.root, 'versioned');
    input.scope.versions = [version];
    const groups = version === '*' ? ['1', '2'] : ['2'];
    f.jsonl('coverage.jsonl', groups.flatMap(actualVersion => [
      { ...coverageRowScope, type: 'frequency', version: actualVersion, renderingId: '{R-1}', pageCount: 1 },
      { ...coverageRowScope, type: 'coverage', version: actualVersion, versionScope: actualVersion, itemId: '{PAGE-1}', itemPath: '/sitecore/content/acme/home', route: '/', renderingIds: ['{R-1}'], cumulativeCoverage: 1 },
      { ...coverageRowScope, type: 'meta', version: actualVersion, totalPages: 1, globalThreshold: 1 },
    ]));
    f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl', { scope: { version } });
    await assembleDiscovery(input, { base: f.root, output });
    const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
    assert.deepEqual(coverage.routes.map(row => row.versionScope), groups);
    const fingerprint = name => createHash('sha256').update(readFileSync(join(f.root, name))).digest('hex');
    assert.equal(coverage.source.sha256, fingerprint('coverage.jsonl'));
    assert.equal(coverage.source.manifestSha256, fingerprint('coverage-manifest.json'));
    assert.equal(coverage.source.scope.version, version);
    const mapping = JSON.parse(readFileSync(join(output, 'rendering-page-mapping.json')));
    assert.deepEqual(mapping.source.coverage, coverage.source);
  });
});

test('missing and valid partial coverage remain nonblocking optional evidence', async t => {
  const f = fixture(t), input = stagedInput(f);
  f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl', { partial: true });
  const partial = await assembleDiscovery(input, { base: f.root, output: join(f.root, 'partial') });
  assert.equal(partial.synthesisReady, true);
  assert.equal(partial.completeness.coverage, 'partial');
  delete input.exports.coverage;
  const missing = await assembleDiscovery(input, { base: f.root, output: join(f.root, 'missing') });
  assert.equal(missing.synthesisReady, true);
  assert.equal(missing.completeness.coverage, 'unavailable');
});

test('distinguishes an explicitly validated empty scope from failed or missing content evidence', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'empty');
  f.jsonl('items.jsonl', []);
  f.jsonl('renderings.jsonl', []);
  f.jsonl('presentation.jsonl', []);
  f.jsonl('coverage.jsonl', [{ ...coverageRowScope, type: 'meta', totalPages: 0, globalThreshold: 0 }]);
  f.manifest('items-manifest.json', 'discover-site', 'items.jsonl', { scope: { sitePath: '/sitecore/content/acme', database: 'master', languages: ['en'], version: 'latest' } });
  f.manifest('renderings-manifest.json', 'inspect-renderings', 'renderings.jsonl');
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl');
  f.put('serialization-manifest.json', { version: 1, status: 'complete', modules: [], itemCount: 0, templateCount: 0, missingReferences: [] });
  f.put('template-classifications.json', { version: 1, source: 'reviewed-empty-scope', classifications: [] });
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output }), /explicitly validate zero-result scope/i);
  input.expectations = { allowEmptyContent: true };
  const valid = await assembleDiscovery(input, { base: f.root, output: join(f.root, 'empty-approved') });
  assert.equal(valid.synthesisReady, true);

  const missing = structuredClone(input);
  missing.exports.items.records = 'missing-items.jsonl';
  await assert.rejects(() => assembleDiscovery(missing, { base: f.root, output: join(f.root, 'missing') }), /missing-items\.jsonl/i);
});

test('rejects a retained export that does not match its connector manifest', async t => {
  const f = fixture(t), input = stagedInput(f);
  f.put('items-manifest.json', {
    kind: 'kajoo-export', version: 1,
    files: [{ path: 'items.jsonl', name: 'items.jsonl', size: 1 }],
    summary: { visited: 2, partial: false, limited: false, errorCount: 0, scope: {} },
  });
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'mismatch') }), /byte size does not match/i);
});

test('preserves the producer coverage ranking and reports shared/final counts without calling them deltas', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'ranked');
  f.jsonl('coverage.jsonl', [
    { ...coverageRowScope, type: 'coverage', version: '1', versionScope: 'latest', itemId: '{PAGE-1}', itemPath: '/sitecore/content/acme/z-dense', route: '/z-dense', renderingIds: ['{R-1}', '{R-2}'], cumulativeCoverage: 2 },
    { ...coverageRowScope, type: 'coverage', version: '1', versionScope: 'latest', itemId: '{PAGE-2}', itemPath: '/sitecore/content/acme/a-sparse', route: '/a-sparse', renderingIds: ['{R-3}'], cumulativeCoverage: 3 },
  ]);
  f.manifest('coverage-manifest.json', 'analyze-rendering-coverage', 'coverage.jsonl');
  const pages = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  pages[0].final = [...pages[0].shared]; // SPE final view includes shared occurrences.
  f.jsonl('presentation.jsonl', pages);
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  await assembleDiscovery(input, { base: f.root, output });
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
  assert.deepEqual(coverage.routes.map(row => row.route), ['/z-dense', '/a-sparse']);
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.equal(manifest.counts.sharedOccurrences, 2);
  assert.equal(manifest.counts.finalOccurrences, 1);
  assert.equal(manifest.counts.renderingOccurrences, 3);
  const report = readFileSync(join(output, 'content-discovery-report.md'), 'utf8');
  assert.match(report, /Shared occurrence records: 2/);
  assert.match(report, /Final occurrence records: 1/);
  assert.match(report, /not.*unique runtime/i);
});

test('missing SXA field evidence is unavailable rather than an empty complete audit', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'unknown-sxa');
  const pages = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const page of pages) delete page.sxa;
  f.jsonl('presentation.jsonl', pages);
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  await assembleDiscovery(input, { base: f.root, output });
  const sxa = JSON.parse(readFileSync(join(output, 'sxa-conversion-inputs.json')));
  assert.equal(sxa.completeness, 'unavailable');
  assert.equal(sxa.scope, 'direct-presentation-design-references');
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.ok(manifest.unresolved.some(item => item.code === 'sxa-fields-unavailable'));
});

test('a successful presentation sample cannot stand in for site-wide collection', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'sample');
  const pages = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  f.jsonl('presentation.jsonl', pages.slice(0, 1));
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  const result = await assembleDiscovery(input, { base: f.root, output });
  assert.equal(result.synthesisReady, false);
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.equal(manifest.collectionCoverage.expectedPresentationRecords, 2);
  assert.equal(manifest.collectionCoverage.missing.length, 1);
  assert.equal(manifest.completeness.presentation, 'partial');
});

test('manifest-backed batches reconcile every item/language/version/device without double counting overlap', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'batched');
  const pages = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  input.exports.presentation = pages.map((page, index) => {
    const records = f.jsonl(`batch-${index}.jsonl`, [page]);
    const manifest = f.manifest(`batch-${index}-manifest.json`, 'inspect-presentation', records);
    return { records, manifest };
  });
  input.exports.presentation.push(input.exports.presentation[0]);
  const result = await assembleDiscovery(input, { base: f.root, output });
  assert.equal(result.synthesisReady, true);
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.equal(manifest.counts.presentationRecords, 2);
  assert.equal(manifest.collectionCoverage.missing.length, 0);
  assert.equal(manifest.inputs.presentation.length, 3);
  assert.ok(manifest.inputs.presentation.every(batch => batch.sha256 && batch.manifestSha256));
});

test('missing language/version/device tuples and limited inventory prevent collection acceptance', async t => {
  const f = fixture(t), input = stagedInput(f);
  delete input.exports.coverage; // This case isolates required presentation reconciliation.
  input.scope.devices.push('{SECOND-DEVICE}');
  const result = await assembleDiscovery(input, { base: f.root, output: join(f.root, 'device-gap') });
  assert.equal(result.synthesisReady, false);
  input.scope.devices.pop();
  const items = readFileSync(join(f.root, 'items.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  items.push({ ...items[0], language: 'fr', version: '2' });
  input.scope.languages.push('fr');
  f.jsonl('items.jsonl', items);
  f.manifest('items-manifest.json', 'discover-site', 'items.jsonl');
  assert.equal((await assembleDiscovery(input, { base: f.root, output: join(f.root, 'language-gap') })).synthesisReady, false);
  f.manifest('items-manifest.json', 'discover-site', 'items.jsonl', { partial: true });
  assert.equal((await assembleDiscovery(input, { base: f.root, output: join(f.root, 'inventory-gap') })).synthesisReady, false);
});

test('conflicting overlapping batches are not silently merged', async t => {
  const f = fixture(t), input = stagedInput(f);
  const pages = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  pages[0].shared = [];
  const records = f.jsonl('conflict.jsonl', pages);
  const manifest = f.manifest('conflict-manifest.json', 'inspect-presentation', records);
  input.exports.presentation = [input.exports.presentation, { records, manifest }];
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'conflict') }), /conflicting presentation/i);
});

test('an empty-content waiver cannot accept a nonempty inventory with no presentation capture', async t => {
  const f = fixture(t), input = stagedInput(f);
  input.expectations = { allowEmptyContent: true };
  f.jsonl('presentation.jsonl', []);
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  assert.equal((await assembleDiscovery(input, { base: f.root, output: join(f.root, 'false-empty') })).synthesisReady, false);
});

function dependencyAudit(f, input) {
  const sections = Object.fromEntries(['templates', 'datasources', 'layoutsPlaceholders', 'branches', 'resolvers', 'sxa', 'compatibility', 'duplicates'].map(key => [key, {
    status: 'complete', evidence: ['items.jsonl'], findings: [],
  }]));
  f.put('dependency-audit.json', { version: 1, sections });
  input.exports.dependencyAudit = { records: 'dependency-audit.json' };
  return sections;
}

test('assessment findings are retained but labels alone cannot prove dependency collection', async t => {
  const f = fixture(t), input = stagedInput(f);
  const core = await assembleDiscovery(input, { base: f.root, output: join(f.root, 'core-only') });
  assert.equal(core.synthesisReady, true);
  assert.equal(core.deliverablesReady, false);
  const sections = dependencyAudit(f, input);
  sections.compatibility.findings.push({ templateId: '{XP-T}', reason: 'Needs target remap; observed dependency', owner: 'Content Migration' });
  f.put('dependency-audit.json', { version: 1, sections });
  const output = join(f.root, 'all-delivered');
  const complete = await assembleDiscovery(input, { base: f.root, output });
  assert.equal(complete.deliverablesReady, false, 'assessment labels lack retained dependency capture');
  const audit = JSON.parse(readFileSync(join(output, 'dependency-audit.json')));
  assert.equal(audit.sections.compatibility.findings.length, 1);
  assert.ok(audit.evidence.every(file => file.sha256 && file.bytes > 0));
});

test('missing dependency evidence or missing assessments cannot be called delivered', async t => {
  const f = fixture(t), input = stagedInput(f), sections = dependencyAudit(f, input);
  delete sections.branches;
  f.put('dependency-audit.json', { version: 1, sections });
  assert.equal((await assembleDiscovery(input, { base: f.root, output: join(f.root, 'missing-section') })).deliverablesReady, false);
  sections.templates.evidence = ['never-read.json'];
  f.put('dependency-audit.json', { version: 1, sections });
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'missing-proof') }), /never-read.json/);
});

test('nonempty scope needs actual serialization includes, not a complete label on an empty plan', async t => {
  const f = fixture(t), input = stagedInput(f);
  dependencyAudit(f, input);
  f.put('serialization-manifest.json', { version: 1, status: 'complete', modules: [], missingReferences: [] });
  assert.equal((await assembleDiscovery(input, { base: f.root, output: join(f.root, 'empty-config') })).deliverablesReady, false);
});

test('verified non-page content needs no presentation rows but still needs dependency capture', async t => {
  const f = fixture(t), input = stagedInput(f);
  const items = readFileSync(join(f.root, 'items.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  f.jsonl('items.jsonl', items.map(item => ({ ...item, hasPresentation: false })));
  f.manifest('items-manifest.json', 'discover-site', 'items.jsonl');
  f.jsonl('presentation.jsonl', []);
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');
  dependencyAudit(f, input);
  const result = await assembleDiscovery(input, { base: f.root, output: join(f.root, 'non-pages') });
  assert.equal(result.synthesisReady, true);
  assert.equal(result.deliverablesReady, false);
});

test('serialization includes must match retained module files', async t => {
  const f = fixture(t), input = stagedInput(f);
  f.put('modules/Acme.module.json', { namespace: 'Acme', items: { includes: [{ path: '/sitecore/content/other' }] } });
  await assert.rejects(() => assembleDiscovery(input, { base: f.root, output: join(f.root, 'module-mismatch') }), /include paths.*match/i);
});

test('known rendering folders are not definitions and classifications preserve dependency evidence', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'catalog');
  const rows = readFileSync(join(f.root, 'renderings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  rows.push({ id: '{FOLDER}', path: '/sitecore/layout/Renderings/Feature', language: 'en', version: '1', templateName: 'Rendering Folder' });
  f.jsonl('renderings.jsonl', rows);
  f.manifest('renderings-manifest.json', 'inspect-renderings', 'renderings.jsonl');
  f.put('template-classifications.json', { classifications: [{ templateId: '{BASE-T}', templatePath: '/sitecore/templates/System/Analytics/Test', classification: 'xp-only', reason: 'Observed base dependency', evidence: ['items.jsonl'], usedByItems: ['{PAGE-1}'] }] });
  await assembleDiscovery(input, { base: f.root, output });
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.equal(manifest.counts.renderingDefinitions, 2);
  assert.equal(manifest.counts.renderingFolders, 1);
  const audit = JSON.parse(readFileSync(join(output, 'xp-only-template-audit.json')));
  assert.deepEqual(audit.templates.find(row => row.templateId === '{BASE-T}').usedByItems, ['{PAGE-1}']);
});

test('presentation occurrences with no Sitecore ItemID are retained without fabricating or requiring a rendering definition', async t => {
  const f = fixture(t), input = stagedInput(f), output = join(f.root, 'empty-rendering-id');
  const pages = readFileSync(join(f.root, 'presentation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  pages[0].shared[0].renderingId = '';
  f.jsonl('presentation.jsonl', pages);
  f.manifest('presentation-manifest.json', 'inspect-presentation', 'presentation.jsonl');

  const result = await assembleDiscovery(input, { base: f.root, output });
  const usage = readFileSync(join(output, 'rendering-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const mapping = JSON.parse(readFileSync(join(output, 'rendering-page-mapping.json')));
  const manifest = JSON.parse(readFileSync(join(output, 'discovery-manifest.json')));
  assert.equal(result.synthesisReady, true);
  assert.equal(usage.find(row => row.pageId === '{PAGE-1}').renderingId, null);
  assert.ok(manifest.unresolved.some(row => row.code === 'rendering-identity-unavailable' && row.pageId === '{PAGE-1}'));
  assert.ok(!manifest.unresolved.some(row => row.code === 'missing-rendering-definition' && row.pageId === '{PAGE-1}'));
  assert.ok(!mapping.renderings.some(row => !row.renderingId));
});
