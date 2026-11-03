import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesizeDiscovery } from '../scripts/analysis/synthesize-discovery.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), '.tmp-discovery-synthesis-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const content = 'discovery.content/attempt-1';
  put(`${content}/task-result.json`, { taskId: 'discovery.content', outcome: 'success' });
  put(`${content}/discovery-manifest.json`, {
    discoveryReady: true, synthesisReady: true,
    scope: { siteRootPath: '/sitecore/content/example', database: 'master', language: 'en' },
    unresolved: [{ code: 'optional-layout-capture', status: 'not-requested' }],
  });
  put(`${content}/rendering-details.json`, {
    renderings: [
      { id: '{R-1}', name: 'Hero', path: '/sitecore/layout/Renderings/Hero', templateName: 'Json Rendering', fields: { 'Rendering Contents Resolver': '{RESOLVER-1}' } },
      { id: '{R-2}', name: 'Card', path: '/sitecore/layout/Renderings/Card', templateName: 'Json Rendering', fields: {} },
    ],
  });
  put(`${content}/rendering-page-mapping.json`, {
    renderings: [
      { renderingId: 'r-1', pageIds: ['{P-1}'], pagePaths: ['/sitecore/content/example/home'], routes: ['/'], occurrenceCount: 2 },
      { renderingId: '{R-2}', pageIds: ['{P-2}'], pagePaths: ['/sitecore/content/example/about'], routes: ['/about'], occurrenceCount: 1 },
    ],
  });
  put(`${content}/coverage-plan.json`, {
    completeness: 'partial',
    routes: [
      { route: '/', itemId: '{P-1}', itemPath: '/sitecore/content/example/home', language: 'en', version: '1', deviceId: '{D}', renderingIds: ['{R-1}', '{R-2}'], renderingNames: ['Hero', 'Card'], cumulativeCoverage: 2 },
      { route: '/about', itemId: '{P-2}', itemPath: '/sitecore/content/example/about', language: 'en', version: '1', deviceId: '{D}', renderingIds: ['{R-2}'], renderingNames: ['Card'], cumulativeCoverage: 2 },
    ],
  });
  put(`${content}/serialization-config.json`, { includes: ['/sitecore/content/example'] });
  put(`${content}/sxa-conversion-inputs.json`, { status: 'partial' });
  put(`${content}/xp-only-template-audit.json`, { templates: [] });
  const code = 'discovery.code/attempt-1';
  put(`${code}/task-result.json`, { taskId: 'discovery.code', outcome: 'success' });
  put(`${code}/reports/source.json`, { components: [{ componentName: 'Hero' }, { exportName: 'Other' }] });
  return {
    root,
    input: {
      version: 1,
      scope: { scopeId: 'example-1', siteRootPath: '/sitecore/content/example', database: 'master', language: 'en' },
      evidence: { contentRoot: content, codeRoot: code },
    },
  };
}

test('builds a deterministic draft-only inventory and preserves collector coverage order', async t => {
  const f = fixture(t);
  const output = join(f.root, 'discovery.synthesize', 'attempt-1');
  mkdirSync(join(f.root, 'discovery.synthesize'));
  const result = await synthesizeDiscovery(f.input, { base: f.root, output });
  assert.equal(result.valid, true);
  const {schemaVersion: _schema, fingerprint: planHash, ...planBody}=JSON.parse(readFileSync(join(output,'rendering-capture-plan.json')));
  assert.equal(planHash,sha256(JSON.stringify(planBody)));
  const inventory = JSON.parse(readFileSync(join(output, 'rendering-inventory.json')));
  assert.deepEqual(inventory.entities.map(entity => [entity.id, entity.codeEvidence, entity.occurrenceCount]), [
    ['{R-1}', 'exact-name-candidate', 2], ['{R-2}', 'unresolved', 1],
  ]);
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
  assert.deepEqual(coverage.routes.map(route => route.route), ['/', '/about']);
  assert.equal(coverage.authoritative, false);
  const resolvers = JSON.parse(readFileSync(join(output, 'resolver-candidates.json')));
  assert.deepEqual(resolvers.candidates.map(candidate => candidate.renderingId), ['{R-1}']);
  const phases = JSON.parse(readFileSync(join(output, 'phase-inputs.json')));
  assert.deepEqual(phases.candidates.map(candidate => [candidate.id, candidate.status]), [
    ['code-migration', 'applicable'], ['content-migration', 'applicable'], ['sxa-conversion', 'candidate'], ['resolver-adapters', 'candidate'],
  ]);
  const manifest = JSON.parse(readFileSync(join(output, 'synthesis-manifest.json')));
  assert.equal(manifest.draftOnly, true);
  assert.ok(manifest.outputs.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  const report = readFileSync(join(output, 'discovery-synthesis-report.md'), 'utf8');
  assert.match(report, /draft-only/i);
  assert.doesNotMatch(report, /Redirect Module/i);
});

test('keeps a terminal code failure visible without blocking valid content synthesis', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'discovery.code/attempt-1/task-result.json'), JSON.stringify({ taskId: 'discovery.code', outcome: 'failed' }));
  const output = join(f.root, 'failed-code');
  const result = await synthesizeDiscovery(f.input, { base: f.root, output });
  assert.equal(result.valid, true);
  const phases = JSON.parse(readFileSync(join(output, 'phase-inputs.json')));
  assert.equal(phases.candidates.find(candidate => candidate.id === 'code-migration').status, 'unresolved');
  const unresolved = JSON.parse(readFileSync(join(output, 'unresolved.json')));
  assert.ok(unresolved.findings.some(finding => finding.code === 'code-evidence-unavailable'));
});

test('accepts BOM-prefixed collector evidence and current collector field aliases', async t => {
  const f = fixture(t);
  const content = join(f.root, 'discovery.content/attempt-1');
  const putBomJson = (name, value) => writeFileSync(join(content, name), `\ufeff${JSON.stringify(value, null, 2)}\n`);
  putBomJson('rendering-details.json', {
    total: 1,
    rendering_details: [{
      id: '{R-1}', name: 'Hero', path: '/sitecore/layout/Renderings/Hero',
      template_name: 'Json Rendering', is_used: true,
      has_rendering_contents_resolver: true,
      rendering_contents_resolver: '{RESOLVER-1}',
    }],
  });
  putBomJson('rendering-page-mapping.json', {
    rendering_frequency: [{ rendering_id: '{R-1}', name: 'Hero', page_count: 1 }],
    coverage_plan: [{ route: '/', item_path: '/sitecore/content/example/home', renderings: ['Hero'], cumulative_coverage: 1 }],
  });
  putBomJson('serialization-config.json', { includes: ['/sitecore/content/example'] });
  putBomJson('sxa-conversion-inputs.json', { status: 'partial' });
  putBomJson('xp-only-template-audit.json', { templates: [] });
  writeFileSync(join(content, 'coverage-plan.json'), JSON.stringify({
    pagesScanned: 1,
    renderingsCovered: 1,
    renderingsUncovered: 0,
    coveragePlan: [{ route: '/', item_path: '/sitecore/content/example/home', renderings: ['Hero'], cumulative_coverage: 1 }],
  }, null, 2));

  const output = join(f.root, 'current-collector');
  await synthesizeDiscovery(f.input, { base: f.root, output });
  const inventory = JSON.parse(readFileSync(join(output, 'rendering-inventory.json')));
  assert.deepEqual(inventory.entities.map(entity => [entity.id, entity.templateName, entity.occurrenceCount]), [
    ['{R-1}', 'Json Rendering', 1],
  ]);
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
  assert.equal(coverage.completeness, 'complete');
  assert.deepEqual(coverage.routes.map(route => [route.route, route.itemPath, route.renderingNames]), [
    ['/', '/sitecore/content/example/home', ['Hero']],
  ]);
  const resolvers = JSON.parse(readFileSync(join(output, 'resolver-candidates.json')));
  assert.deepEqual(resolvers.candidates.map(candidate => candidate.references), [[{
    field: 'rendering_contents_resolver', value: '{RESOLVER-1}',
  }]]);
});

test('rejects mismatched content scope before writing an output directory', async t => {
  const f = fixture(t);
  f.input.scope.language = 'fr';
  const output = join(f.root, 'scope-mismatch');
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output }), /scope/i);
});

function wholeSiteFixture(t) {
  const f = fixture(t);
  const content = join(f.root, f.input.evidence.contentRoot);
  writeFileSync(join(content, 'task-result.json'), JSON.stringify({ taskId: 'kajoo-content-task-id', workflowKey: 'discovery.content', outcome: 'success' }));
  const reports = ['rendering-details.json', 'rendering-page-mapping.json', 'serialization-config.json', 'sxa-conversion-inputs.json', 'xp-only-template-audit.json'];
  const coverage = JSON.parse(readFileSync(join(content, 'coverage-plan.json')));
  const mapping = JSON.parse(readFileSync(join(content, 'rendering-page-mapping.json')));
  writeFileSync(join(content, 'rendering-page-mapping.json'), JSON.stringify({ ...mapping, coverage_plan: coverage.routes, renderings_uncovered: 1 }));
  mkdirSync(join(content, 'collector-files'));
  const files = reports.map(name => {
    renameSync(join(content, name), join(content, 'collector-files', name));
    const bytes = readFileSync(join(content, 'collector-files', name));
    return { name, path: '/old/transient/tool-results/' + name, size: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = JSON.parse(readFileSync(join(content, 'discovery-manifest.json')));
  rmSync(join(content, 'discovery-manifest.json'));
  rmSync(join(content, 'coverage-plan.json'));
  writeFileSync(join(content, 'discovery-evidence-manifest.json'), JSON.stringify({ ...manifest, collector: 'xp-discovery-v3', terminalSuccess: true, gaps: [], files }));
  const code = join(f.root, f.input.evidence.codeRoot);
  writeFileSync(join(code, 'task-result.json'), JSON.stringify({ taskId: 'kajoo-code-task-id', workflowKey: 'discovery.code', outcome: 'success' }));
  renameSync(join(code, 'reports/source.json'), join(code, 'source-analysis.json'));
  const source = readFileSync(join(code, 'source-analysis.json'));
  writeFileSync(join(code, 'manifest.json'), JSON.stringify({ files: { 'source-analysis.json': { sha256: sha256(source), bytes: source.length } } }));
  return f;
}

test('consumes hash-bound whole-site files and embedded coverage without staging copies', async t => {
  const f = wholeSiteFixture(t);
  const output = join(f.root, 'whole-site');
  await synthesizeDiscovery(f.input, { base: f.root, output });
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-plan.json')));
  assert.equal(coverage.source.path, f.input.evidence.contentRoot + '/collector-files/rendering-page-mapping.json');
  assert.deepEqual(coverage.routes.map(route => route.route), ['/', '/about']);
  const inventory = JSON.parse(readFileSync(join(output, 'rendering-inventory.json')));
  assert.equal(inventory.entities[0].codeEvidence, 'exact-name-candidate');
  const manifest = JSON.parse(readFileSync(join(output, 'synthesis-manifest.json')));
  assert.ok(manifest.inputs.code.some(file => file.path.endsWith('/source-analysis.json')));
});

test('rejects changed whole-site evidence before writing outputs', async t => {
  const f = wholeSiteFixture(t);
  writeFileSync(join(f.root, f.input.evidence.contentRoot, 'collector-files/rendering-details.json'), '{}');
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'tampered') }), /hash|size/i);
});

test('rejects code hash mismatches instead of silently dropping code evidence', async t => {
  const f = wholeSiteFixture(t);
  writeFileSync(join(f.root, f.input.evidence.codeRoot, 'source-analysis.json'), '{}');
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'tampered-code') }), /hash|size/i);
});

test('rejects successful code results without a source report', async t => {
  const f = fixture(t);
  rmSync(join(f.root, f.input.evidence.codeRoot, 'reports/source.json'));
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'missing-code') }), /source report/i);
});

test('accepts explicit relative report locations without following manifest transfer paths', async t => {
  const f = wholeSiteFixture(t);
  const content = join(f.root, f.input.evidence.contentRoot);
  renameSync(join(content, 'collector-files'), join(content, 'retained-reports'));
  f.input.evidence.contentFilesRoot = 'retained-reports';
  f.input.evidence.contentManifest = 'discovery-evidence-manifest.json';
  f.input.evidence.codeSourceReport = 'source-analysis.json';
  await synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'declared') });
});

test('rejects ambiguous source reports unless the input selects one', async t => {
  const f = fixture(t);
  const code = join(f.root, f.input.evidence.codeRoot);
  writeFileSync(join(code, 'source-analysis.json'), readFileSync(join(code, 'reports/source.json')));
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'ambiguous') }), /Ambiguous code source report/);
  f.input.evidence.codeSourceReport = 'reports/source.json';
  await synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'selected') });
});

test('supports an explicitly declared flat whole-site report directory', async t => {
  const f = wholeSiteFixture(t);
  const content = join(f.root, f.input.evidence.contentRoot);
  const manifest = JSON.parse(readFileSync(join(content, 'discovery-evidence-manifest.json')));
  for (const file of manifest.files) renameSync(join(content, 'collector-files', file.name), join(content, file.name));
  f.input.evidence.contentFilesRoot = null;
  await synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'flat') });
});

test('rejects unsafe declared report paths', async t => {
  const f = wholeSiteFixture(t);
  f.input.evidence.contentFilesRoot = '../outside';
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'unsafe-report') }), /Unsafe relative path/);
});

test('rejects whole-site readiness flags backed by a failed terminal export', async t => {
  const f = wholeSiteFixture(t);
  const path = join(f.root, f.input.evidence.contentRoot, 'discovery-evidence-manifest.json');
  const manifest = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ ...manifest, terminalSuccess: false }));
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'failed-export') }), /terminal evidence gaps/);
});

test('does not accept output reuse', async t => {
  const f = fixture(t);
  const output = join(f.root, 'output');
  await synthesizeDiscovery(f.input, { base: f.root, output });
  await assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output }), /already exists/i);
});

test('the synthesis input contains only relative evidence roots', t => {
  const f = fixture(t);
  assert.equal(sha256(JSON.stringify(f.input)).length, 64);
  f.input.evidence.contentRoot = '../escape';
  return assert.rejects(() => synthesizeDiscovery(f.input, { base: f.root, output: join(f.root, 'unsafe') }), /Unsafe relative path/);
});


test('enhanced synthesis retains all occurrence evidence and emits draft capture and mapping files', async t => {
  const f=fixture(t), content=join(f.root,'discovery.content/attempt-1');
  const page='/sitecore/content/example/home';
  const instances=[{renderingId:'{R-1}',renderingName:'Hero',instanceId:'{I-1}',pageId:'{P-1}',itemPath:page,language:'en',deviceId:null,placeholder:'header',datasource:'{DATA}',parameters:'Color=Blue',variantId:null}];
  const extras={
    'rendering-instances.jsonl':instances.map(row=>JSON.stringify(row)).join('\n'),
    'rendering-variants.json':JSON.stringify({schemaVersion:1,variants:[]}),
    'template-definitions.json':JSON.stringify({templates:[]}),
    'placeholder-settings.json':JSON.stringify({placeholders:[]}),
    'metadata-stats.json':JSON.stringify({audit_metadata:{site_root_path:'/sitecore/content/example',database:'master',language:'en'}}),
  };
  for(const[name,text]of Object.entries(extras))writeFileSync(join(content,name),text);
  writeFileSync(join(content,'rendering-page-mapping.json'),JSON.stringify({renderings:[],usage_scan_complete:true,pages:[{itemPath:page,route:'/'}]}));
  const manifestPath=join(content,'discovery-manifest.json');
  const manifest=JSON.parse(readFileSync(manifestPath));
  manifest.outputs=[...Object.keys(extras),'rendering-details.json','rendering-page-mapping.json','coverage-plan.json','serialization-config.json','sxa-conversion-inputs.json','xp-only-template-audit.json'].map(path=>{const bytes=readFileSync(join(content,path));return {path,sha256:sha256(bytes),bytes:bytes.length};});
  writeFileSync(manifestPath,JSON.stringify(manifest));
  writeFileSync(join(f.root,'discovery.code/attempt-1/reports/source.json'),JSON.stringify({components:[{componentName:'Hero'}],componentInventory:{Hero:{sourcePath:'src/Hero.tsx'}}}));
  const output=join(f.root,'enhanced');
  await synthesizeDiscovery(f.input,{base:f.root,output});
  const plan=JSON.parse(readFileSync(join(output,'rendering-capture-plan.json')));
  assert.equal(plan.draft,true);
  assert.equal(plan.scope,'discovery-only');
  assert.equal(plan.totalRenderings,1);
  assert.equal(plan.selectedPages.length,1);
  const mapping=JSON.parse(readFileSync(join(output,'rendering-mapping-inventory.json')));
  assert.equal(mapping.schemaVersion,2);
  assert.equal(mapping.renderings.length,2);
  assert.equal(mapping.renderings.find(row=>row.name==='Hero').implementation.filePath,'src/Hero.tsx');
  assert.equal(mapping.requirements.flatMap(row=>row.sourceOccurrences??[])[0].itemPath,page);
  const resultManifest=JSON.parse(readFileSync(join(output,'synthesis-manifest.json')));
  assert.ok(resultManifest.outputs.some(file=>file.path==='rendering-capture-plan.json'));
  assert.ok(resultManifest.inputs.content.some(file=>file.path.endsWith('rendering-instances.jsonl')));
  writeFileSync(join(content,'rendering-instances.jsonl'),'{}');
  await assert.rejects(()=>synthesizeDiscovery(f.input,{base:f.root,output:join(f.root,'tampered')}),/hash|size/i);
});
