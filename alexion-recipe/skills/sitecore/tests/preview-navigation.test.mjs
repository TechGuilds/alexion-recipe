import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { preparePreviewNavigation } from '../scripts/preview/prepare-preview-navigation.mjs';
import { routeFile, sha256 } from '../scripts/capture/rendering-coverage.mjs';
import { fixture, seal, layout } from './capture-fixtures.mjs';
import { sourceFixture } from './mapping-fixtures.mjs';
import { createTargetRenderingInventory } from '../scripts/mapping/component-mapping.mjs';
import { buildComponentMigrationPlan } from '../scripts/mapping/component-migration-plan.mjs';
import { applyComponentMappings } from '../scripts/mapping/apply-component-mappings.mjs';
import { writeComponentExamples } from '../scripts/capture/build-component-examples.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const navigation = readFileSync(join(skillRoot, 'assets/mock-preview/navigation.template.txt'), 'utf8');
function setup(t, plan = fixture()) {
  const root = mkdtempSync(join(tmpdir(), 'v3-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const save = (name, value) => {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); return path;
  };
  const ref = (path) => ({ path, sha256: sha256(readFileSync(path)) });
  const planFile = save('plan.json', plan);
  const capture = (route, body = layout(), name = 'captures') => {
    const path = save(`${name}/${routeFile(route)}`, body);
    const page = [...plan.selectedPages, ...plan.requirements.flatMap((r) => r.alternatives)].find((p) => p.route === route);
    return { route, itemId: page?.itemId, itemPath: page?.itemPath, language: page?.language, status: 'captured', layoutFile: path, sha256: ref(path).sha256 };
  };
  const result = (outcomes, name = 'result.json', extra = {}) => ref(save(name, { selection: 'discovery-plan', capturePlanFingerprint: plan.fingerprint, outputDir: join(root, 'captures'), outcomes, ...extra }));
  const options = (captureResultFiles, extra = {}) => ({ capturePlanFile: planFile, capturePlanSha256: ref(planFile).sha256, captureResultFiles, outputDir: join(root, 'stage'), ...extra });
  return { root, plan, planFile, save, ref, capture, result, options };
}

test('stages only declared successful captures; stale files, failures and unattempted alternatives stay out', (t) => {
  const f = setup(t); const outcome = f.capture('/primary');
  f.save('captures/stale/index.json', layout()); f.save('captures/home/index.json', layout());
  const before = readFileSync(outcome.layoutFile);
  const manifest = preparePreviewNavigation(f.options([f.result([outcome])]));
  assert.deepEqual(manifest.routes, ['/primary']);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'stage/public/mock-preview/routes.json'))), { routes: ['/primary'] });
  assert.deepEqual(readFileSync(outcome.layoutFile), before);
  assert.deepEqual(readFileSync(join(f.root, 'stage/public/mock-layouts/primary/index.json')), before);
  assert.equal(readFileSync(join(f.root, 'stage/public/mock-preview/navigation.js'), 'utf8'), navigation);
  for (const entry of manifest.files) assert.equal(sha256(readFileSync(join(f.root, 'stage', entry.path))), entry.sha256);
  assert.match(manifest.coverage, /separate rendering coverage/);
  const failed = f.result([{ route: '/primary', status: 'failed' }], 'failed.json');
  const next = preparePreviewNavigation(f.options([failed], { outputDir: join(f.root, 'next') }));
  assert.deepEqual(next.routes, []);
  assert.equal(existsSync(join(f.root, 'next/public/mock-layouts/primary/index.json')), false);
});

test('requires current file hashes, approved plan and exact capture provenance before writing', (t) => {
  const f = setup(t), captured = f.capture('/primary'), result = f.result([captured]);
  assert.throws(() => preparePreviewNavigation(f.options([result], { capturePlanSha256: '0'.repeat(64) })), /SHA256/);
  assert.throws(() => preparePreviewNavigation(f.options([{ ...result, sha256: '0'.repeat(64) }])), /SHA256/);
  assert.throws(() => preparePreviewNavigation(f.options([result.path])), /path and sha256/);
  assert.throws(() => preparePreviewNavigation(f.options([])), /captureResultFiles/);
  assert.throws(() => preparePreviewNavigation(f.options([result, result])), /unique/);
  assert.throws(() => preparePreviewNavigation(f.options([result], { routes: ['/extra'] })), /Only approved/);
  const wrong = f.result([captured], 'wrong.json', { capturePlanFingerprint: '0'.repeat(64) });
  assert.throws(() => preparePreviewNavigation(f.options([wrong])), /approved plan/);
  writeFileSync(captured.layoutFile, '{}');
  assert.throws(() => preparePreviewNavigation(f.options([result])), /layout SHA256/);
  assert.equal(existsSync(join(f.root, 'stage')), false);
});

test('rejects route-to-file substitutions and mismatched captured item identity', (t) => {
  const f = setup(t), captured = f.capture('/primary');
  const other = f.save('captures/other/index.json', layout());
  assert.throws(() => preparePreviewNavigation(f.options([f.result([{ ...captured, layoutFile: other }])])), /path does not match/);
  const wrongItem = f.capture('/primary', layout({ itemId: 'wrong' }));
  assert.throws(() => preparePreviewNavigation(f.options([f.result([wrongItem], 'wrong-item.json')])), /item identity/);
  assert.equal(existsSync(join(f.root, 'stage')), false);
});

test('includes approved recovery alternatives only with explicit complete acyclic result lineage', (t) => {
  const f = setup(t), alternative = f.capture('/alternate', layout({ itemId: '{BBBB}' }));
  const original = f.result([{ route: '/primary', status: 'failed' }]);
  const recovery = f.result([alternative], 'recovery.json', { previousCaptureResultFiles: [original.path] });
  assert.throws(() => preparePreviewNavigation(f.options([recovery])), /every previous/);
  assert.throws(() => preparePreviewNavigation(f.options([f.result([alternative], 'unchained.json')])), /explicit recovery/);
  const manifest = preparePreviewNavigation(f.options([recovery, original]));
  assert.deepEqual(manifest.routes, ['/alternate']);
  const self = join(f.root, 'cycle.json');
  const cycle = f.result([], 'cycle.json', { previousCaptureResultFiles: [self] });
  assert.throws(() => preparePreviewNavigation(f.options([cycle], { outputDir: join(f.root, 'cycle-stage') })), /cycle/);
  const empty = f.result([], 'empty.json');
  const unattempted = f.result([alternative], 'unattempted.json', { previousCaptureResultFiles: [empty.path] });
  assert.throws(() => preparePreviewNavigation(f.options([empty, unattempted], { outputDir: join(f.root, 'unattempted-stage') })), /prior selected attempt/);
});

test('rejects symlink escapes, relative output and mismatched actual captured language before staging', (t) => {
  const f = setup(t); const captured = f.capture('/primary');
  const result = f.result([captured]);
  assert.throws(() => preparePreviewNavigation(f.options([result], { outputDir: 'stage-relative' })), /explicit absolute path/);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  const junction = join(f.root, 'junction'); symlinkSync(outside, junction, 'junction');
  assert.throws(() => preparePreviewNavigation(f.options([result], { outputDir: join(junction, 'stage') })), /symbolic link/);
  assert.equal(existsSync(join(outside, 'stage')), false);
  const wrongLanguage = f.capture('/primary', { ...layout(), sitecore: { ...layout().sitecore, context: { language: 'fr' } } });
  assert.throws(() => preparePreviewNavigation(f.options([f.result([wrongLanguage], 'wrong-language.json')])), /language mismatch/);
  const relocated = f.save('elsewhere/index.json', layout());
  rmSync(dirname(captured.layoutFile), { recursive: true });
  symlinkSync(dirname(relocated), dirname(captured.layoutFile), 'junction');
  const escaped = f.result([{ ...captured, sha256: f.ref(relocated).sha256 }], 'escaped.json');
  assert.throws(() => preparePreviewNavigation(f.options([escaped])), /escapes outputDir/);
  assert.equal(existsSync(join(f.root, 'stage')), false);
});

test('route ordering and files are deterministic, Unicode URLs are encoded and no route limit is implicit', (t) => {
  const plan = fixture();
  plan.selectedPages = Array.from({ length: 30 }, (_, index) => ({ ...plan.selectedPages[0], route: `/pages/${String(index).padStart(2, '0')}` }));
  plan.selectedPages.push({ ...plan.selectedPages[0], route: '/café' });
  plan.selectedPages.push({ ...plan.selectedPages[0], route: '/Articles/News' });
  const f = setup(t, seal(plan));
  const outcomes = f.plan.selectedPages.map((page) => f.capture(page.route)).reverse();
  const first = preparePreviewNavigation(f.options([f.result(outcomes)]));
  const second = preparePreviewNavigation(f.options([f.result(outcomes.reverse(), 'reordered.json')], { outputDir: join(f.root, 'second') }));
  assert.equal(first.routes.length, 32);
  assert.deepEqual(first.files, second.files);
  assert.ok(JSON.parse(readFileSync(join(f.root, 'stage/public/mock-preview/routes.json'))).routes.includes('/caf%C3%A9'));
  assert.ok(JSON.parse(readFileSync(join(f.root, 'stage/public/mock-preview/routes.json'))).routes.includes('/Articles/News'));
  assert.ok(existsSync(join(f.root, 'stage/public/mock-layouts/Articles/News/index.json')));
  assert.throws(() => preparePreviewNavigation(f.options([f.result(outcomes, 'third.json')])), /new or empty/);
});

test('copied native helper and skill assets run from an unrelated workspace without Kajoo or node_modules', (t) => {
  const f = setup(t); const result = f.result([f.capture('/primary')]);
  const portable = join(f.root, 'portable');
  cpSync(join(skillRoot, 'scripts'), join(portable, 'scripts'), { recursive: true });
  cpSync(join(skillRoot, 'assets'), join(portable, 'assets'), { recursive: true });
  const params = f.save('params.json', f.options([result]));
  const run = spawnSync(process.execPath, [join(portable, 'scripts/preview/prepare-preview-navigation.mjs'), '--params', params], { cwd: f.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'stage/deployment-manifest.json'))).routes, ['/primary']);
});

function mappingEvidence(f) {
  const source = sourceFixture();
  const target = createTargetRenderingInventory({ targetInstance: 'target', renderings: [{ renderingId: 'target', componentName: 'TargetCard', path: '/target', fields: ['Heading'], parameters: [], placeholders: ['main'] }] });
  const manifest = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: [{ sourceRenderingId: 'rused', action: 'reuse-target', confirmed: true, targetRenderingId: 'target', targetComponent: 'TargetCard', fieldMap: { Title: 'Heading' } }, { sourceRenderingId: 'runused', action: 'implement-missing', confirmed: true }] };
  const inputs = [['source', source], ['target', target], ['manifest', manifest]].map(([role, value]) => ({ role, ...f.ref(f.save(`${role}.json`, value)) }));
  const decisions = [{ id: 'approved-mapping', kind: 'mapping', scopeId: 'component-mappings', choice: 'approve', rationale: 'Reviewed these mappings', userResponse: 'Approved mappings', at: '2026-10-21T00:00:00Z', inputs: inputs.map(({ role, ...ref }) => ref) }];
  const approvalEvidence = f.ref(f.save('decisions.json', decisions));
  const plan = buildComponentMigrationPlan(source, target, manifest, { inputFiles: inputs, decisions, approvalEvidence });
  const mappingPlanFile = f.save('mapping-plan.json', plan);
  return { sourceFile: inputs[0].path, mappingPlanFile, mappingPlanSha256: f.ref(mappingPlanFile).sha256, approvalEvidence };
}

test('explicit mapped layouts replace only their verified source capture; synthetic examples stay labeled separately', (t) => {
  const plan = fixture(); plan.selectedPages[0].route = '/'; plan.selectedPages[0].itemId = 'page-1';
  const f = setup(t, seal(plan)), evidence = mappingEvidence(f);
  const body = { sitecore: { context: { language: 'en' }, route: { itemId: 'page-1', fields: {}, placeholders: { main: [{ uid: 'instance-1', renderingId: 'rused', componentName: 'Used Component', params: { Style: 'wide' }, fields: { Title: { value: 'Content' } } }] } } } };
  const capture = f.capture('/', body); const result = f.result([capture]);
  applyComponentMappings({ mappingPlanFile: evidence.mappingPlanFile, mappingPlanSha256: evidence.mappingPlanSha256, layoutFile: capture.layoutFile, layoutSha256: capture.sha256, route: '/', outputDir: join(f.root, 'mapped') });
  writeComponentExamples({ sourceInventoryFile: evidence.sourceFile, sourceInventorySha256: f.ref(evidence.sourceFile).sha256, mappingPlanFile: evidence.mappingPlanFile, mappingPlanSha256: evidence.mappingPlanSha256, selectedRequirementKeys: ['runused:definition'], fixtures: [{ requirementKey: 'runused:definition', fields: { Title: { value: 'Sample' } } }], outputDir: join(f.root, 'examples') });
  const options = f.options([result], { mappedLayoutFiles: [f.ref(join(f.root, 'mapped/mapping-result.json'))], componentExamplesFiles: [f.ref(join(f.root, 'examples/component-examples.json'))] });
  const staged = preparePreviewNavigation(options);
  assert.equal(staged.captures.find((entry) => entry.route === '/').kind, 'derived-mapped-layout');
  assert.equal(staged.captures.filter((entry) => entry.synthetic === true).length, 1);
  assert.equal(staged.outcomes.length, 1);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'stage/public/mock-layouts/home/index.json'))).sitecore.route.placeholders.main[0].componentName, 'TargetCard');
  assert.deepEqual(JSON.parse(readFileSync(capture.layoutFile)), body);
  const mappedResultFile = join(f.root, 'mapped/mapping-result.json');
  const wrongMapping = JSON.parse(readFileSync(mappedResultFile));
  wrongMapping.sourceLayout.sha256 = '0'.repeat(64);
  const wrongMappingFile = f.save('wrong-mapping.json', wrongMapping);
  assert.throws(() => preparePreviewNavigation({ ...options, mappedLayoutFiles: [f.ref(wrongMappingFile)], outputDir: join(f.root, 'wrong-mapped-stage') }), /SHA256/);
  const examplesFile = join(f.root, 'examples/component-examples.json');
  const examples = JSON.parse(readFileSync(examplesFile));
  const exampleFile = join(f.root, 'examples', examples.examples[0].relativeFile);
  writeFileSync(exampleFile, '{}');
  assert.throws(() => preparePreviewNavigation({ ...options, outputDir: join(f.root, 'wrong-example-stage') }), /SHA256/);
  writeFileSync(exampleFile, `${JSON.stringify(examples.examples[0].layout, null, 2)}\n`);
  writeFileSync(evidence.approvalEvidence.path, '[]');
  assert.throws(() => preparePreviewNavigation({ ...options, outputDir: join(f.root, 'revoked') }), /hash mismatch/);
  assert.equal(existsSync(join(f.root, 'revoked')), false);
});

test('synthetic manifests require current approval independently and examples needing fixtures stay out of navigation', (t) => {
  const f = setup(t), evidence = mappingEvidence(f);
  const failed = f.result([{ route: '/primary', status: 'failed' }]);
  const exampleOptions = { sourceInventoryFile: evidence.sourceFile, sourceInventorySha256: f.ref(evidence.sourceFile).sha256, mappingPlanFile: evidence.mappingPlanFile, mappingPlanSha256: evidence.mappingPlanSha256, selectedRequirementKeys: ['runused:definition'] };
  writeComponentExamples({ ...exampleOptions, outputDir: join(f.root, 'pending-examples') });
  const manifest = preparePreviewNavigation(f.options([failed], { componentExamplesFiles: [f.ref(join(f.root, 'pending-examples/component-examples.json'))] }));
  assert.deepEqual(manifest.routes, []);
  assert.equal(manifest.excludedExamples[0].status, 'fixture-required');
  writeComponentExamples({ ...exampleOptions, fixtures: [{ requirementKey: 'runused:definition', fields: {} }], outputDir: join(f.root, 'ready-examples') });
  const ref = f.ref(join(f.root, 'ready-examples/component-examples.json'));
  const value = JSON.parse(readFileSync(ref.path));
  value.examples[0].layout.sitecore.route.name = 'Unapproved altered example';
  writeFileSync(ref.path, `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => preparePreviewNavigation(f.options([failed], { componentExamplesFiles: [f.ref(ref.path)], outputDir: join(f.root, 'forged') })), /current approved synthetic/);
  writeFileSync(evidence.approvalEvidence.path, '[]');
  assert.throws(() => preparePreviewNavigation(f.options([failed], { componentExamplesFiles: [f.ref(ref.path)], outputDir: join(f.root, 'revoked-synthetic') })), /hash mismatch/);
  assert.equal(existsSync(join(f.root, 'revoked-synthetic')), false);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.hidden = false; this.listeners = {}; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML injection is forbidden'); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = undefined; }
  attachShadow() { this.shadowRoot = new Element('shadow'); return this.shadowRoot; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { this.focused = true; }
}
async function browser(data, { reject = false, pathname = '/', ok = true } = {}) {
  const body = new Element('body'), requests = [];
  const document = { body, createElement: (tag) => new Element(tag), getElementById: (id) => body.children.find((child) => child.id === id) };
  const context = { document, location: { pathname }, fetch: async (...args) => { requests.push(args); if (reject) throw new Error('offline'); return { ok, json: async () => data }; } };
  runInNewContext(navigation, context);
  await new Promise((resolve) => setImmediate(resolve));
  const host = body.children[0], shadow = host.shadowRoot;
  const all = (node) => [node, ...node.children.flatMap(all)];
  return { body, context, host, shadow, requests, nodes: all(shadow), nav: shadow.children.find((node) => node.tag === 'nav'), button: shadow.children.find((node) => node.tag === 'button') };
}

test('navigation builds nested native links, marks current route, toggles and escapes with no DOM HTML parsing', async () => {
  const b = await browser({ routes: ['/a/b', '/a', '/', '/%3Cimg%20src=x%20onerror=alert(1)%3E', '/%3Csvg%3E'] }, { pathname: '/a/b/' });
  assert.deepEqual(JSON.parse(JSON.stringify(b.requests[0])), ['/mock-preview/routes.json', { cache: 'no-store', redirect: 'error', credentials: 'same-origin' }]);
  const links = b.nodes.filter((node) => node.tag === 'a');
  assert.deepEqual(links.map((link) => link.href).sort(), ['/', '/%3Csvg%3E', '/a', '/a/b']);
  assert.equal(links.find((link) => link.href === '/a/b').attributes['aria-current'], 'page');
  assert.equal(links.find((link) => link.href === '/%3Csvg%3E').textContent, '<svg>');
  assert.ok(b.nodes.some((node) => node.tag === 'details'));
  b.button.onclick(); assert.equal(b.nav.hidden, true); assert.equal(b.button.attributes['aria-expanded'], 'false');
  b.button.onclick(); assert.equal(b.nav.hidden, false);
  b.shadow.listeners.keydown({ key: 'Escape' }); assert.equal(b.nav.hidden, true); assert.equal(b.button.focused, true);
  runInNewContext(navigation, b.context); assert.equal(b.body.children.length, 1);
});

test('navigation skips unsafe and malformed paths individually, without external requests or unsafe hrefs', async () => {
  const unsafe = ['//evil.test', 'https://evil.test', '/%2f%2fevil.test', '/%5cevil.test', '/a/../b', '/%2e%2e/b', '/%252f', '/%3fquery', '/%23hash', '/bad%', '/\u0000', '/a//b', '/a?x', '/a#x', '/a\\b', 3, null];
  const b = await browser({ routes: ['/safe', '/safe', ...unsafe] }, { pathname: '/bad%' });
  assert.deepEqual(b.nodes.filter((node) => node.tag === 'a').map((node) => node.href), ['/safe']);
  assert.equal(b.requests.length, 1);
});

test('navigation handles fetch failures, invalid response shape and empty indexes clearly', async () => {
  for (const [data, options] of [[{}, {}], [{ routes: [] }, { reject: true }], [{ routes: [] }, { ok: false }]]) {
    const b = await browser(data, options); assert.match(b.nav.textContent, /unavailable/);
  }
  const empty = await browser({ routes: [] }); assert.match(empty.nav.textContent, /No preview pages/);
});
