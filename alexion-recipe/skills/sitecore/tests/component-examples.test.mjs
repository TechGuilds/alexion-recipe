import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildComponentExamples, writeComponentExamples } from '../scripts/capture/build-component-examples.mjs';
import { createTargetRenderingInventory } from '../scripts/mapping/component-mapping.mjs';
import { buildComponentMigrationPlan } from '../scripts/mapping/component-migration-plan.mjs';
import { sourceFixture } from './mapping-fixtures.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const key = 'runused:definition';
const variantKey = 'rused:variant:variantunused';
function refresh(source) {
  const { fingerprint, generatedAt, ...body } = source;
  return { ...body, generatedAt, fingerprint: hash(JSON.stringify(body)) };
}
function planning(source, { decisions, inputFiles, approvalEvidence, approved = true } = {}) {
  const target = createTargetRenderingInventory({ targetInstance: 'https://target.example.test', renderings: [{ renderingId: 'target', componentName: 'TargetCard', path: '/renderings/TargetCard', fields: ['Heading'], parameters: ['Tone', 'FieldNames'], placeholders: ['content'] }] });
  const manifest = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: decisions ?? source.renderings.map((r) => ({ sourceRenderingId: r.renderingId, action: 'implement-missing', confirmed: true })) };
  const refs = inputFiles ?? ['source', 'target', 'manifest'].map((role) => ({ role, path: `${role}.json`, sha256: hash(role) }));
  const approval = { id: 'mapping-approved', kind: 'mapping', scopeId: 'component-mappings', choice: 'approve', rationale: 'Reviewed explicit example scope', userResponse: 'Approve these component mappings', at: '2026-10-21T00:00:00Z', inputs: refs.map(({ role, ...ref }) => ref) };
  return { target, manifest, refs, approval, plan: buildComponentMigrationPlan(source, target, manifest, { inputFiles: refs, decisions: approved ? [approval] : [], approvalEvidence }) };
}
function build(source, options = {}, planOptions) {
  return buildComponentExamples(source, { mappingPlan: planning(source, planOptions).plan, selectedRequirementKeys: [key], ...options });
}

test('examples require explicit reviewed scope and leave discovery evidence unchanged', () => {
  const source = sourceFixture(), before = JSON.stringify(source);
  assert.deepEqual(buildComponentExamples(source), []);
  assert.throws(() => buildComponentExamples(source, { selectedRequirementKeys: [key] }), /plan|object/);
  assert.throws(() => build(source, {}, { approved: false }), /approval/);
  const [example] = build(source);
  assert.equal(example.status, 'fixture-required');
  assert.equal(example.synthetic, true);
  assert.equal(example.visualValidation, 'pending');
  assert.match(example.route, /^\/__migration_examples\/[a-f0-9]{32}$/);
  assert.deepEqual(build(source), [example]);
  assert.equal(JSON.stringify(source), before);
});

test('explicit fixtures create synthetic layouts without claiming capture or validation', () => {
  const source = sourceFixture(), fields = { Title: { value: 'Representative title' } };
  const [example] = build(source, { fixtures: [{ requirementKey: key, fields }], language: 'fr' });
  assert.equal(example.status, 'layout-ready');
  assert.equal(example.visualValidation, 'pending');
  assert.equal(example.layout._migrationExample.visualValidation, 'pending');
  assert.deepEqual(example.layout.sitecore.route.placeholders.main[0].fields, fields);
  assert.equal(example.layout.sitecore.context.language, 'fr');
  assert.match(example.layout.sitecore.route.itemId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  example.layout.sitecore.route.placeholders.main[0].fields.Title.value = 'changed';
  assert.equal(fields.Title.value, 'Representative title');
});

test('unused variants of used renderings are eligible but used or uncertain configurations are rejected', () => {
  const source = sourceFixture();
  const [example] = build(source, { selectedRequirementKeys: [variantKey], fixtures: [{ requirementKey: variantKey, fields: {} }] });
  assert.equal(example.status, 'layout-ready');
  assert.equal(example.layout.sitecore.route.placeholders.main[0].params.FieldNames, 'variantunused');
  const used = source.requirements.find((r) => !r.definitionOnly);
  assert.throws(() => build(source, { selectedRequirementKeys: [used.key] }), /certified unused/);
  assert.throws(() => build(sourceFixture({ complete: false })), /certified unused/);
  const incompleteCounts = sourceFixture();
  incompleteCounts.renderings.find((r) => r.renderingId === 'rused').usage.countsComplete = false;
  assert.throws(() => build(refresh(incompleteCounts), { selectedRequirementKeys: [variantKey] }), /certified unused/);
  assert.throws(() => build(source, { selectedRequirementKeys: ['unknown:definition'] }), /Unknown selected/);
});

test('default definition remains addressable when discovery contains only unused variants', () => {
  const source = sourceFixture();
  source.requirements = source.requirements.filter((r) => r.key !== key);
  const rendering = source.renderings.find((r) => r.renderingId === 'runused');
  rendering.variants = [{ variantId: 'alternate', usageStatus: 'unused', observed: false, pageCount: 0 }];
  rendering.configurations = [{ configurationKey: 'variant:alternate', variantId: 'alternate', parameters: {}, pageCount: 0 }];
  source.requirements.push({ key: 'runused:variant:alternate', renderingId: 'runused', renderingName: rendering.name, configurationKey: 'variant:alternate', variantId: 'alternate', parameters: {}, definitionOnly: true, sourceOccurrences: [] });
  const [example] = build(refresh(source));
  assert.equal(example.requirementKey, key);
  assert.equal(example.variantId, null);
  assert.deepEqual(example.layout.sitecore.route.placeholders.main[0].params, {});
});

test('source parameters and variant selectors override fixture aliases without inventing a default variant', () => {
  for (const recorded of [false, true]) {
    const source = sourceFixture(), r = source.requirements.find((r) => r.key === variantKey);
    r.parameters = { style: 'wide', ...(recorded ? { fieldnames: 'variantunused' } : {}) };
    const [example] = build(refresh(source), { selectedRequirementKeys: [variantKey], fixtures: [{ requirementKey: variantKey, fields: {}, parameters: { Style: 'narrow', FIELDNAMES: 'wrong', renderingvariant: 'wrong', Extra: 'retained' } }] });
    assert.deepEqual(example.layout.sitecore.route.placeholders.main[0].params, { Extra: 'retained', style: 'wide', ...(recorded ? { fieldnames: 'variantunused' } : { FieldNames: 'variantunused' }) });
  }
  const [example] = build(sourceFixture(), { fixtures: [{ requirementKey: key, fields: {}, parameters: { FieldNames: 'invented' } }] });
  assert.deepEqual(example.layout.sitecore.route.placeholders.main[0].params, {});
});

test('runtime, missing definitions, and nested dependencies cannot become false layout proof', () => {
  const source = sourceFixture();
  source.renderings.find((r) => r.renderingId === 'runused').dependencies.layoutServicePlaceholders = 'children';
  const [example] = build(refresh(source), { fixtures: [{ requirementKey: key, fields: {}, unresolvedDependencies: ['search index'] }] });
  assert.equal(example.status, 'dependency-required');
  assert.ok(example.unresolvedDependencies.some((d) => d.includes('Nested placeholder')));
  assert.ok(example.unresolvedDependencies.includes('search index'));
  assert.equal(example.visualValidation, 'pending');
  const variantSource = sourceFixture();
  variantSource.variants = [];
  assert.equal(build(refresh(variantSource), { selectedRequirementKeys: [variantKey], fixtures: [{ requirementKey: variantKey, fields: {} }] })[0].status, 'dependency-required');
});

test('unrelated broken source components do not block an otherwise representative fixture', () => {
  const source = sourceFixture();
  source.metadata.unresolvedReferences = [{ source_item_path: '/sitecore/layout/Renderings/Other', rendering_id: 'other', reason: 'missing template' }, 'Unscoped discovery warning'];
  assert.equal(build(refresh(source), { fixtures: [{ requirementKey: key, fields: {} }] })[0].status, 'layout-ready');
  source.metadata.unresolvedReferences.push({ source_item_path: source.renderings.find((r) => r.renderingId === 'runused').path, reason: 'missing dependency' });
  assert.equal(build(refresh(source), { fixtures: [{ requirementKey: key, fields: {} }] })[0].status, 'dependency-required');
});

test('fixtures reject unknown keys, prototype names, unrelated keys, and duplicate selection or fixture keys', () => {
  const source = sourceFixture();
  for (const f of [{ requirementKey: key, fields: {}, ignored: true }, { requirementKey: key, fields: JSON.parse('{"__proto__":{"polluted":true}}') }, { requirementKey: key, fields: { nested: JSON.parse('{"constructor":1}') } }, { requirementKey: key, fields: {}, parameters: { Style: 'one', style: 'two' } }, { requirementKey: key, fields: {}, placeholder: '__proto__' }, { requirementKey: 'wrong', fields: {} }]) assert.throws(() => build(source, { fixtures: [f] }), /Unknown|reserved|duplicate|selected|Reserved/);
  const f = { requirementKey: key, fields: {} };
  assert.throws(() => build(source, { fixtures: [f, f] }), /Duplicate fixture/);
  assert.throws(() => build(source, { selectedRequirementKeys: [key, key] }), /unique/);
  const duplicate = structuredClone(source); duplicate.requirements.push(duplicate.requirements[0]);
  assert.throws(() => buildComponentExamples(refresh(duplicate)), /Duplicate source requirement|Duplicate requirement/);
  assert.throws(() => buildComponentExamples({ ...source, fingerprint: 'forged' }), /fingerprint/);
  assert.equal({}.polluted, undefined);
});

test('disregarded or unconfirmed mappings cannot authorize synthetic examples', () => {
  const source = sourceFixture();
  assert.throws(() => build(source, {}, { decisions: [{ sourceRenderingId: 'runused', action: 'disregard', rationale: 'Outside scope', confirmed: true }] }), /eligible approved/);
  assert.throws(() => build(source, {}, { decisions: [{ sourceRenderingId: 'runused', action: 'implement-missing', confirmed: false }] }), /eligible approved/);
});

test('reuse-target examples apply reviewed target transformations and retain original source configuration', () => {
  const source = sourceFixture();
  const decisions = [{ sourceRenderingId: 'runused', action: 'reuse-target', confirmed: true, targetRenderingId: 'target', targetComponent: 'TargetCard', targetVariant: 'targetvariant', fieldMap: { Title: 'Heading' }, parameterMap: { Style: 'Tone' }, placeholderMap: { main: 'content' }, datasourceMap: { sourceData: 'targetData' } }];
  const [example] = build(source, { fixtures: [{ requirementKey: key, fields: { Title: { value: 'Title' } }, parameters: { Style: 'wide' }, datasource: 'sourceData' }] }, { decisions });
  assert.deepEqual(example.sourceConfiguration.fields, { Title: { value: 'Title' } });
  assert.equal(example.sourceConfiguration.renderingId, 'runused');
  const node = example.layout.sitecore.route.placeholders.content[0];
  assert.equal(node.renderingId, 'target');
  assert.equal(node.componentName, 'TargetCard');
  assert.deepEqual(node.fields, { Heading: { value: 'Title' } });
  assert.deepEqual(node.params, { Tone: 'wide', FieldNames: 'targetvariant' });
  assert.equal(node.dataSource, 'targetData');
  assert.equal(example.visualValidation, 'pending');
});

function diskFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'v3-examples-'));
  t.after(() => { if (!root.startsWith(join(tmpdir(), 'v3-examples-'))) throw new Error('Unexpected cleanup root'); rmSync(root, { recursive: true, force: true }); });
  const save = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const source = sourceFixture(), p = planning(source);
  const sourceFile = save('source.json', source), targetFile = save('target.json', p.target), manifestFile = save('manifest.json', p.manifest);
  const sha = (path) => hash(readFileSync(path));
  const inputFiles = [sourceFile, targetFile, manifestFile].map((path, i) => ({ role: ['source', 'target', 'manifest'][i], path, sha256: sha(path) }));
  const initial = planning(source, { inputFiles });
  const decisionsFile = save('decisions.json', [initial.approval]);
  const { plan } = planning(source, { inputFiles, approvalEvidence: { path: decisionsFile, sha256: sha(decisionsFile) } });
  const planFile = save('plan.json', plan);
  const options = { sourceInventoryFile: sourceFile, sourceInventorySha256: sha(sourceFile), mappingPlanFile: planFile, mappingPlanSha256: sha(planFile), selectedRequirementKeys: [key], fixtures: [{ requirementKey: key, fields: {} }], outputDir: join(root, 'examples') };
  return { root, source, sourceFile, planFile, targetFile, manifestFile, save, sha, options };
}

test('hash-bound output is fresh, isolated, and cannot overwrite any source evidence', (t) => {
  const f = diskFixture(t), before = readFileSync(f.sourceFile);
  const manifest = writeComponentExamples(f.options);
  assert.equal(manifest.kind, 'synthetic-component-examples');
  assert.equal(manifest.examples[0].status, 'layout-ready');
  assert.ok(existsSync(join(f.options.outputDir, manifest.examples[0].relativeFile)));
  assert.deepEqual(readFileSync(f.sourceFile), before);
  assert.throws(() => writeComponentExamples(f.options), /fresh/);
  assert.throws(() => writeComponentExamples({ ...f.options, sourceInventorySha256: '0'.repeat(64), outputDir: join(f.root, 'bad-hash') }), /SHA256 mismatch/);
  assert.equal(existsSync(join(f.root, 'bad-hash')), false);
  writeFileSync(f.targetFile, '{}');
  assert.throws(() => writeComponentExamples({ ...f.options, outputDir: join(f.root, 'stale') }), /hash mismatch/);
  assert.equal(existsSync(join(f.root, 'stale')), false);
});

test('recomputed plan checksums cannot manufacture mapping or approval proof', (t) => {
  const f = diskFixture(t);
  const plan = JSON.parse(readFileSync(f.planFile));
  plan.entries.find((entry) => entry.key === key).sourceComponent = 'Fabricated source metadata';
  const { fingerprint, ...body } = plan;
  plan.fingerprint = hash(JSON.stringify(body));
  writeFileSync(f.planFile, JSON.stringify(plan));
  assert.throws(() => writeComponentExamples({ ...f.options, mappingPlanSha256: f.sha(f.planFile) }), /does not match current approved input evidence/);
  assert.equal(existsSync(f.options.outputDir), false);
});

test('changing current user decision evidence invalidates example generation before writing', (t) => {
  const f = diskFixture(t);
  const plan = JSON.parse(readFileSync(f.planFile));
  const decisions = JSON.parse(readFileSync(plan.approvalEvidence.path));
  decisions[0].choice = 'reject';
  writeFileSync(plan.approvalEvidence.path, JSON.stringify(decisions));
  plan.approvalEvidence.sha256 = f.sha(plan.approvalEvidence.path);
  const { fingerprint, ...body } = plan;
  plan.fingerprint = hash(JSON.stringify(body));
  writeFileSync(f.planFile, JSON.stringify(plan));
  assert.throws(() => writeComponentExamples({ ...f.options, mappingPlanSha256: f.sha(f.planFile) }), /approval/);
  assert.equal(existsSync(f.options.outputDir), false);
});

test('copied scripts run in an unrelated directory with native Node and explicit hashed fixtures', (t) => {
  const f = diskFixture(t), scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '../scripts'), copied = join(f.root, 'portable');
  cpSync(scriptRoot, copied, { recursive: true });
  const fixturesFile = f.save('fixtures.json', [{ requirementKey: key, fields: { Title: { value: 'Portable sample' } } }]);
  const { fixtures, ...options } = f.options;
  const params = f.save('params.json', { ...options, fixturesFile, fixturesSha256: f.sha(fixturesFile) });
  const result = spawnSync(process.execPath, [join(copied, 'capture/build-component-examples.mjs'), '--params', params], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(options.outputDir, 'component-examples.json')));
  assert.equal(manifest.examples[0].synthetic, true);
  assert.equal(manifest.examples[0].visualValidation, 'pending');
  assert.equal(manifest.examples[0].layout.sitecore.route.placeholders.main[0].fields.Title.value, 'Portable sample');
});
