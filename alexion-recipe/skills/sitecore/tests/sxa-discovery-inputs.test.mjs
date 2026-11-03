import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSxaInputs } from '../scripts/analysis/derive-sxa-inputs.mjs';

const id = n => `{${String(n).padStart(8, '0')}-0000-0000-0000-000000000000}`;
const page = (n, renderingIds, { language = 'en', deviceId = id(90), version = '1', slot = '/main' } = {}) => ({
  id: id(n), path: `/sitecore/content/site/page-${n}`, language, version, deviceId,
  templateId: id(50), templateName: 'Article',
  final: renderingIds.map((renderingId, index) => ({ index, uid: id(n * 100 + index), renderingId, placeholder: slot })),
  sxa: { pageDesign: id(70), partialDesigns: id(71), basePartialDesign: id(72) },
});
const node = (n, path, kind, fields = {}, parentId = null, language = 'en') => ({ id: id(n), path, kind, fields, parentId, language, version: '1', name: path.split('/').at(-1) });
const edge = (consumer, relation, target, status = 'resolved', required = true) => ({ consumer: { id: consumer.id, language: consumer.language, version: consumer.version }, relation, raw: target?.id ?? '', kind: 'sxa', status, required, language: consumer.language, ...(target ? { targetId: target.id, targetPath: target.path, version: target.version } : {}) });
const scope = { database: 'master', siteRoot: '/sitecore/content/site', languages: ['en', 'fr'], devices: [id(90), id(91)], versions: ['1', '2'] };
const derive = (presentation, nodes = [], edges = [], completeness = { presentation: 'complete', dependencies: 'complete' }, status = 'complete') => deriveSxaInputs({ presentation, dependencies: { version: 1, status, nodes, edges, cycles: [] }, scope, completeness });

test('distinct pages govern frequency; occurrences and representative count remain separate', () => {
  const result = derive([page(1, [id(10), id(10), id(10)]), page(2, [id(11)])]);
  const slot = result.placeholders[0];
  assert.equal(slot.pageCount, 2);
  assert.equal(slot.occurrenceCount, 4);
  assert.deepEqual(slot.renderings.map(r => [r.renderingId, r.pageCount, r.occurrenceCount, r.heuristicCandidate]), [[id(10).toLowerCase(), 1, 3, false], [id(11).toLowerCase(), 1, 1, false]]);
  assert.equal(slot.representativePage.id, id(1).toLowerCase());
  assert.equal(slot.representativePage.occurrenceCount, 3);
});

test('language, device and actual version have separate denominators and template identities', () => {
  const result = derive([page(1, [id(10)]), page(2, [id(10)], { language: 'fr' }), page(3, [id(10)], { deviceId: id(91) }), page(4, [id(10)], { version: '2' })]);
  assert.equal(result.placeholders.length, 4);
  assert.ok(result.placeholders.every(p => p.scope.pageCount === 1 && p.renderings[0].heuristicCandidate));
  assert.equal(result.pageTemplates.length, 4);
  assert.equal(result.pageTemplates[0].templateId, id(50).toLowerCase());
  assert.ok(result.pageTemplates.every(t => t.pages.length === 1 && t.pages[0].id));
});

test('dynamic suffix matches duplicate setting keys, allowed controls and parent declarations', () => {
  const settings = [node(20, '/sitecore/layout/Placeholder Settings/a', 'placeholder', { 'Placeholder Key': 'column', 'Allowed Controls': `${id(10)}|${id(11)}` }), node(21, '/sitecore/layout/Placeholder Settings/b', 'placeholder', { 'Placeholder Key': 'column' })];
  const parent = node(30, '/sitecore/layout/Renderings/Feature/Site/Grid', 'rendering', { Placeholders: `${id(20)}|${id(21)}` });
  const malformed = '/main/column-{oops}-1';
  const dynamic = `/main/column-${id(123)}-2`;
  const result = derive([page(1, [id(10)], { slot: dynamic }), page(2, [id(11)], { slot: malformed })], [...settings, parent]);
  const base = result.dynamicPlaceholderBases.find(b => b.baseName === 'column');
  assert.equal(base.isDynamic, true);
  assert.deepEqual(base.settings.map(s => s.id), [id(20).toLowerCase(), id(21).toLowerCase()]);
  assert.deepEqual(base.allowedControls.map(c => c.renderingId), [id(10).toLowerCase(), id(11).toLowerCase()]);
  assert.deepEqual(base.parentRenderings.map(r => r.id), [id(30).toLowerCase()]);
  assert.equal(result.placeholders.find(p => p.rawKey === dynamic).segments[1].baseName, 'column');
  assert.ok(result.findings.some(f => f.code === 'malformed-dynamic-placeholder-suffix'));
});

test('module probe states and verified registration require actual parent chain', () => {
  const r = [node(30, '/sitecore/layout/Renderings/Feature/Promo/Card', 'rendering'), node(31, '/sitecore/layout/Renderings/Feature/Other/Card', 'rendering'), node(32, '/sitecore/layout/Renderings/Project/Failed/Card', 'rendering'), node(33, '/sitecore/layout/Renderings/Foundation/Untested/Card', 'rendering')];
  const settings = node(40, '/sitecore/system/Settings/Feature/Promo', 'sxa');
  const setup = { ...node(41, '/sitecore/system/Settings/Feature/Promo/HeadlessSiteSetupRoot', 'sxa', {}, settings.id), templateName: 'HeadlessSiteSetupRoot' };
  const add = { ...node(42, '/sitecore/system/Settings/Feature/Promo/HeadlessSiteSetupRoot/AddItem', 'sxa', {}, setup.id), templateName: 'AddItem' };
  const edges = [edge(r[0], 'module-settings', settings), edge(r[1], 'module-settings', null, 'missing', false), edge(r[2], 'module-settings', null, 'failed', false)];
  const result = derive([], [...r, settings, setup, add], edges);
  assert.deepEqual(result.renderingModules.map(m => [m.module, m.settingsProbe, m.registration]), [['Feature/Other', 'optional-missing', 'unregistered'], ['Feature/Promo', 'resolved', 'registered'], ['Foundation/Untested', 'not-probed', 'unknown'], ['Project/Failed', 'failed', 'unknown']]);
  assert.ok(result.findings.some(f => f.code === 'module-registration-missing' && f.module === 'Feature/Other'));
});

test('direct design references and cycles stay auditable; partial capture stays partial', () => {
  const p = page(1, []);
  const design = node(70, '/sitecore/content/site/Presentation/Page Design', 'sxa');
  const graph = { version: 1, status: 'partial', nodes: [design], edges: [edge(p, 'page-design', design)], cycles: [{ family: 'sxa-design', ids: [id(70).toLowerCase()], members: [{ id: id(70).toLowerCase(), language: 'en', version: '1' }] }] };
  const result = deriveSxaInputs({ presentation: [p], dependencies: graph, scope, completeness: { presentation: 'partial', dependencies: 'partial' } });
  assert.equal(result.status, 'partial');
  assert.equal(result.designReferences.length, 1);
  assert.equal(result.designCycles.length, 1);
});

test('does not mutate inputs and is stable under record order', () => {
  const pages = [page(2, [id(11)]), page(1, [id(10)])];
  const nodes = [node(21, '/sitecore/layout/Placeholder Settings/b', 'placeholder', { 'Placeholder Key': 'main' }), node(20, '/sitecore/layout/Placeholder Settings/a', 'placeholder', { 'Placeholder Key': 'main' })];
  const before = structuredClone({ pages, nodes });
  const a = derive(pages, nodes);
  const b = derive([...pages].reverse(), [...nodes].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual({ pages, nodes }, before);
});

test('latest uses one page denominator while page identities keep actual versions', () => {
  const a = page(1, [id(10)], { version: '17' });
  const b = page(2, [id(11)], { version: '18' });
  const result = deriveSxaInputs({ presentation: [a, b], dependencies: { version: 1, status: 'complete', nodes: [], edges: [], cycles: [] },
    scope: { ...scope, versions: ['latest'] }, completeness: { presentation: 'complete', dependencies: 'complete' } });
  assert.equal(result.placeholders.length, 1);
  assert.equal(result.placeholders[0].scope.version, 'latest');
  assert.equal(result.placeholders[0].renderings[0].heuristicCandidate, false);
  assert.deepEqual(result.placeholders[0].pages.map(p => p.version), ['17', '18']);
});

test('latest joins independently versioned settings/renderings and registration templates, excluding folders', () => {
  const p = page(1, [id(30)], { version: '17', slot: `/header-${id(123)}-2` });
  const setting = { ...node(20, '/sitecore/layout/Placeholder Settings/header', 'placeholder', { 'Placeholder Key': 'header' }), version: '2' };
  const rendering = { ...node(30, '/sitecore/layout/Renderings/Feature/Promo/Card', 'rendering', { Placeholders: id(20) }), version: '3', templateName: 'View Rendering' };
  const folder = { ...node(31, '/sitecore/layout/Renderings/Feature/Promo/Inner', 'rendering'), templateName: 'Rendering Folder' };
  const root = { ...node(40, '/sitecore/system/Settings/Feature/Promo', 'sxa'), version: '4' };
  const setup = { ...node(41, '/sitecore/system/Settings/Feature/Promo/Custom Setup', 'sxa', {}, root.id), version: '5', templateName: 'HeadlessSiteSetupRoot' };
  const add = { ...node(42, '/sitecore/system/Settings/Feature/Promo/Custom Setup/Custom Add', 'sxa', {}, setup.id), version: '6', templateName: 'AddItem' };
  const result = deriveSxaInputs({ presentation: [p], dependencies: { version: 1, status: 'complete', nodes: [setting, rendering, folder, root, setup, add],
    edges: [edge(rendering, 'module-settings', root)], cycles: [] }, scope: { ...scope, versions: ['latest'] }, completeness: { presentation: 'complete', dependencies: 'complete' } });
  assert.deepEqual(result.dynamicPlaceholderBases[0].settings.map(s => s.version), ['2']);
  assert.deepEqual(result.dynamicPlaceholderBases[0].parentRenderings.map(s => s.version), ['3']);
  assert.equal(result.renderingModules[0].renderings.length, 1);
  assert.equal(result.renderingModules[0].registration, 'registered');
  assert.equal(result.placeholders[0].sharedSlotNameHeuristic, true);
});

test('module probes may originate on a rendering folder without counting it as a rendering', () => {
  const folder = { ...node(31, '/sitecore/layout/Renderings/Feature/Promo', 'rendering'), templateName: 'Rendering Folder' };
  const executable = { ...node(30, '/sitecore/layout/Renderings/Feature/Promo/Card', 'rendering'), templateName: 'View Rendering' };
  const settings = node(40, '/sitecore/system/Settings/Feature/Promo', 'sxa');
  const branch = node(50, '/sitecore/templates/Branches/Feature/Promo', 'branch');
  const setup = { ...node(41, '/sitecore/system/Settings/Feature/Promo/Custom Setup', 'sxa', {}, settings.id), templateName: 'HeadlessSiteSetupRoot' };
  const add = { ...node(42, '/sitecore/system/Settings/Feature/Promo/Custom Setup/Custom Add', 'sxa', {}, setup.id), templateName: 'AddItem' };
  const result = derive([], [folder, executable, settings, branch, setup, add], [edge(folder, 'module-settings', settings), edge(folder, 'module-branch', branch)]);
  assert.equal(result.renderingModules.length, 1);
  assert.deepEqual(result.renderingModules[0].renderings.map(row => row.id), [id(30).toLowerCase()]);
  assert.equal(result.renderingModules[0].settingsProbe, 'resolved');
  assert.equal(result.renderingModules[0].branchProbe, 'resolved');
  assert.equal(result.renderingModules[0].registration, 'registered');
});

test('a captured module folder with no executable definition retains its probe and zero count', () => {
  const folder = { ...node(31, '/sitecore/layout/Renderings/Feature/Empty', 'rendering'), templateName: 'Rendering Folder' };
  const result = derive([], [folder], [edge(folder, 'module-settings', null, 'missing', false)]);
  assert.equal(result.renderingModules.length, 1);
  assert.equal(result.renderingModules[0].module, 'Feature/Empty');
  assert.deepEqual(result.renderingModules[0].renderings, []);
  assert.equal(result.renderingModules[0].settingsProbe, 'optional-missing');
});
