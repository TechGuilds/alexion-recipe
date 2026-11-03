import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceFixture } from './mapping-fixtures.mjs';
import { buildRenderingCapturePlan } from '../scripts/analysis/build-rendering-capture-plan.mjs';
import { buildRenderingCoverageReport, sha256, validateCapturePlan } from '../scripts/capture/rendering-coverage.mjs';
import { buildComponentExamples, writeComponentExamples } from '../scripts/capture/build-component-examples.mjs';
import { createTargetRenderingInventory } from '../scripts/mapping/component-mapping.mjs';
import { buildComponentMigrationPlan } from '../scripts/mapping/component-migration-plan.mjs';
import { assembleMvcCaptures } from '../scripts/capture/assemble-mvc-captures.mjs';
import { fetchLayouts, GRAPHQL_API_KEY_ENV } from '../scripts/capture/fetch-layouts.mjs';
import { validateSitecoreArtifact, validateSitecoreArtifactSync as validate, validateSitecoreArtifactFileSync, sitecoreArtifactKinds } from '../scripts/contracts/sitecore-artifacts.mjs';
import { validateLocalSchema } from '../scripts/contracts/json-schema.mjs';

function temp(t) { const root = mkdtempSync(join(tmpdir(), 'sitecore-contracts-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function samples() {
  const source = sourceFixture();
  const used = source.requirements.find(r => !r.definitionOnly);
  const occurrence = used.sourceOccurrences[0];
  const entries = [{ route: occurrence.route, itemId: occurrence.itemId, itemPath: occurrence.itemPath, language: occurrence.language, requirements: [used] }];
  const draft = buildRenderingCapturePlan(entries);
  const capturePlan = buildRenderingCapturePlan(entries, { includedRenderingIds: new Set([used.renderingId]) });
  const target = createTargetRenderingInventory({ targetInstance: 'https://target.example.test', renderings: [] });
  const manifest = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, decisions: source.renderings.map(r => ({ sourceRenderingId: r.renderingId, action: 'implement-missing', confirmed: true })) };
  const inputFiles = ['source', 'target', 'manifest'].map(role => ({ role, path: `${role}.json`, sha256: sha256(role) }));
  const decision = { id: 'reviewed-mapping', kind: 'mapping', scopeId: 'component-mappings', choice: 'approve', rationale: 'Reviewed mapping', userResponse: 'Approve these mappings', at: '2026-10-21T00:00:00Z', inputs: inputFiles.map(({ role, ...ref }) => ref) };
  const plan = buildComponentMigrationPlan(source, target, manifest, { inputFiles, decisions: [decision] });
  const unresolvedPlan = buildComponentMigrationPlan(source, target, manifest);
  const examples = buildComponentExamples(source, { selectedRequirementKeys: ['runused:definition', 'rused:variant:variantunused'], mappingPlan: plan, fixtures: [{ requirementKey: 'runused:definition', fields: { Title: { value: 'Sample', nested: [1, null, true] } } }] });
  const exampleManifest = { schemaVersion: 1, kind: 'synthetic-component-examples', synthetic: true, visualValidation: 'pending', sourceInventory: { path: 'source.json', sha256: sha256('source'), fingerprint: source.fingerprint }, mappingPlan: { path: 'plan.json', sha256: sha256('plan'), fingerprint: plan.fingerprint, decisionId: decision.id }, examples };
  return { source, target, manifest, plan, unresolvedPlan, draft, capturePlan, exampleManifest, used, occurrence };
}

test('native producer artifacts validate with exact versions and nested identities', async () => {
  const f = samples();
  for (const [kind, value] of [['rendering-mapping-inventory', f.source], ['rendering-capture-plan', f.draft], ['rendering-capture-plan', f.capturePlan], ['target-rendering-inventory', f.target], ['component-mappings', f.manifest], ['component-migration-plan', f.plan], ['component-migration-plan', f.unresolvedPlan], ['component-examples', f.exampleManifest]]) {
    assert.equal(validate(kind, value), value, kind);
    assert.equal(await validateSitecoreArtifact(kind, value), value, kind);
  }
  assert.throws(() => validateCapturePlan(f.draft), /approved/);
  assert.throws(() => validate('component-migration-plan', f.unresolvedPlan, { requireApproval: true }), /approval/);
  validate('component-mappings', f.manifest, { sourceInventory: f.source, targetInventory: f.target });
});

test('coverage preserves real warning, failed, pending, absent and unverified evidence', () => {
  const f = samples(), page = f.capturePlan.selectedPages[0];
  const layout = { sitecore: { route: { itemId: page.itemId, placeholders: { changed: [{ uid: f.used.instanceIds[0], renderingId: f.used.renderingId, componentName: f.used.renderingName, params: {}, dataSource: 'different' }] } } } };
  const captured = { ...page, status: 'captured', layout, layoutFile: '/capture/home/index.json', sha256: sha256('layout') };
  delete captured.requirementKeys;
  const warning = buildRenderingCoverageReport(f.capturePlan, [captured], { mappingInventory: f.source });
  assert.equal(warning.requirements[0].status, 'captured');
  assert.equal(warning.requirements[0].examples[0].consistencyStatus, 'warning');
  const failed = { route: page.route, status: 'failed', reason: 'timeout' };
  const skipped = { route: page.route, status: 'skipped', reason: 'pending' };
  const absentLayout = structuredClone(layout); absentLayout.sitecore.route.placeholders.changed[0].params = { FieldNames: 'other' };
  const unknownLayout = { sitecore: { route: { itemId: page.itemId, placeholders: {} } } };
  const reports = [warning, buildRenderingCoverageReport(f.capturePlan, [failed]), buildRenderingCoverageReport(f.capturePlan, [skipped]), buildRenderingCoverageReport(f.capturePlan, []), buildRenderingCoverageReport(f.capturePlan, [{ ...captured, layout: absentLayout }]), buildRenderingCoverageReport(f.capturePlan, [{ ...captured, layout: unknownLayout }])];
  for (const report of reports) validate('rendering-coverage-report', report, { capturePlan: f.capturePlan });
  assert.deepEqual(reports.map(r => r.requirements[0].status), ['captured', 'capture-failed', 'not-captured', 'not-captured', 'target-absent', 'target-unverified']);
  assert.equal(f.exampleManifest.examples[1].status, 'fixture-required');
  const changed = structuredClone(f.exampleManifest); changed.examples[0].visualValidation = 'passed';
  assert.throws(() => validate('component-examples', changed), /constant/);
});

test('strict schema rejects unknown keys, wrong versions and missing nested identity before integrity checks', () => {
  const f = samples();
  const cases = [
    ['rendering-mapping-inventory', { ...f.source, surprise: true }],
    ['rendering-mapping-inventory', { ...f.source, schemaVersion: 1 }],
    ['rendering-capture-plan', { ...f.capturePlan, requirements: [{ ...f.capturePlan.requirements[0], renderingId: undefined }] }],
    ['component-migration-plan', { ...f.plan, approval: { ...f.plan.approval, automaticallyApproved: true } }],
    ['component-examples', { ...f.exampleManifest, examples: [{ ...f.exampleManifest.examples[0], sourceConfiguration: { ...f.exampleManifest.examples[0].sourceConfiguration, renderingId: undefined } }] }],
  ];
  for (const [kind, value] of cases) assert.throws(() => validate(kind, JSON.parse(JSON.stringify(value))), /unknown property|missing required|constant/);
  assert.throws(() => validate('invented', {}), /Unknown Sitecore/);
  const nested = structuredClone(f.source); nested.renderings[0].dependencies.guessed = true;
  assert.throws(() => validate('rendering-mapping-inventory', nested), /unknown property guessed/);
});

test('freshly produced fingerprints and current evidence bindings reject stale data', () => {
  const f = samples();
  for (const [kind, original] of [['rendering-capture-plan', f.capturePlan], ['rendering-mapping-inventory', f.source], ['target-rendering-inventory', f.target], ['component-migration-plan', f.plan]]) {
    const value = structuredClone(original); value.fingerprint = '0'.repeat(64);
    assert.throws(() => validate(kind, value), /fingerprint/i);
  }
  assert.throws(() => validate('component-mappings', { ...f.manifest, sourceFingerprint: '0'.repeat(64) }, { sourceInventory: f.source, targetInventory: f.target }), /stale/);
  assert.throws(() => validate('component-migration-plan', f.plan, { currentInputs: f.plan.inputFiles.map(ref => ({ ...ref, sha256: '0'.repeat(64) })) }), /current inputs/);
  assert.throws(() => validate('component-migration-plan', f.plan, { currentDecisions: [] }), /current decisions/);
});

test('unknown discovery references remain diagnostics and are not upgraded to complete facts', () => {
  const source = sourceFixture({ complete: false });
  source.metadata.unresolvedReferences.push({ id: 'missing', source_item_path: '/sitecore/layout/Renderings/Other', discovery_source: 'configured-root', database: 'master', reason: 'Rendering definition could not be resolved' });
  source.renderings[0].dependencies.datasourceTemplateId = null;
  source.renderings[0].dependencies.datasourceTemplateReference = '/missing/template';
  const { fingerprint: _fingerprint, generatedAt, ...body } = source;
  source.fingerprint = sha256(JSON.stringify(body));
  validate('rendering-mapping-inventory', source);
  assert.equal(source.metadata.completeness.pageUsage, false);
});

test('both native capture producers emit the shared capture-result contract', async t => {
  const root = temp(t), f = samples(), page = f.capturePlan.selectedPages[0];
  const planFile = join(root, 'plan.json'); writeFileSync(planFile, JSON.stringify(f.capturePlan));
  const rawRoot = join(root, 'raw'); mkdirSync(join(rawRoot, 'home'), { recursive: true });
  const inputs = { 'page.json': { Page: { Id: page.itemId, Path: page.itemPath, Language: 'en', Name: 'Home', FieldsJson: '{}' }, Renderings: [{ UniqueID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ItemID: f.used.renderingId, Placeholder: '/main', Datasource: null, Parameters: '' }] }, 'names.json': { [f.used.renderingId]: f.used.renderingName }, 'fields.json': {} };
  const hashes = {};
  for (const [name, value] of Object.entries(inputs)) { const bytes = JSON.stringify(value); writeFileSync(join(rawRoot, 'home', name), bytes); hashes[name] = sha256(bytes); }
  const rawManifest = { selection: 'discovery-plan', capturePlanFingerprint: f.capturePlan.fingerprint, siteName: 'test', language: 'en', routes: [{ ...page, normalized: 'home', hashes }] };
  const manifestFile = join(root, 'raw-manifest.json'); writeFileSync(manifestFile, JSON.stringify(rawManifest));
  const mvc = assembleMvcCaptures({ rawRoot, capturePlanFile: planFile, manifestFile, outputDir: join(root, 'mvc'), resultFile: join(root, 'mvc-result.json') });
  assert.equal(mvc.successCount, 1);
  validate('capture-result', mvc, { capturePlan: f.capturePlan });
  const oldFetch = globalThis.fetch, oldKey = process.env[GRAPHQL_API_KEY_ENV];
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env[GRAPHQL_API_KEY_ENV]; else process.env[GRAPHQL_API_KEY_ENV] = oldKey; });
  process.env[GRAPHQL_API_KEY_ENV] = 'fixture-credential';
  globalThis.fetch = async () => new Response(JSON.stringify({ sitecore: { route: { itemId: page.itemId, placeholders: {} } } }), { status: 200 });
  const headless = await fetchLayouts({ capturePlanFile: planFile, outputDir: join(root, 'headless'), layoutServiceUrl: 'https://fixture.example.test', siteName: 'test' });
  assert.equal(headless.successCount, 1);
  validate('capture-result', headless, { capturePlan: f.capturePlan });
  const stale = structuredClone(headless); stale.outcomes[0].sha256 = undefined;
  assert.throws(() => validate('capture-result', JSON.parse(JSON.stringify(stale))), /layoutFile and sha256/);
  const { preparePreviewNavigation } = await import('../scripts/preview/prepare-preview-navigation.mjs');
  const previewDir = join(root, 'preview');
  const deployment = preparePreviewNavigation({ capturePlanFile: planFile, capturePlanSha256: sha256(readFileSync(planFile)), captureResultFiles: [{ path: headless.captureResultFile, sha256: sha256(readFileSync(headless.captureResultFile)) }], outputDir: previewDir });
  validate('mock-preview-deployment', deployment);
  validate('mock-preview-routes', JSON.parse(readFileSync(join(previewDir, 'public', 'mock-preview', 'routes.json'))));
});

test('synthetic manifest contract validates actual isolated writer output with bound approval evidence', t => {
  const root = temp(t), f = samples();
  const refs = [['source', f.source], ['target', f.target], ['manifest', f.manifest]].map(([role, value]) => {
    const path = join(root, `${role}.json`), bytes = JSON.stringify(value); writeFileSync(path, bytes);
    return { role, path, sha256: sha256(bytes) };
  });
  const decision = { ...f.plan.approval.decision, inputs: refs.map(({ role, ...ref }) => ref) };
  const decisionFile = join(root, 'decisions.json'), decisionBytes = JSON.stringify([decision]); writeFileSync(decisionFile, decisionBytes);
  const plan = buildComponentMigrationPlan(f.source, f.target, f.manifest, { inputFiles: refs, decisions: [decision], approvalEvidence: { path: decisionFile, sha256: sha256(decisionBytes) } });
  const planFile = join(root, 'mapping-plan.json'), planBytes = JSON.stringify(plan); writeFileSync(planFile, planBytes);
  const manifest = writeComponentExamples({ sourceInventoryFile: refs[0].path, sourceInventorySha256: refs[0].sha256, mappingPlanFile: planFile, mappingPlanSha256: sha256(planBytes), selectedRequirementKeys: ['runused:definition'], fixtures: [{ requirementKey: 'runused:definition', fields: { Title: { value: 'Representative' } } }], outputDir: join(root, 'examples') });
  validate('component-examples', manifest);
  validate('component-migration-plan', plan, { currentInputs: refs, currentDecisions: [decision], currentApprovalEvidence: plan.approvalEvidence });
});

test('CLI works from a copied skill with explicit file hashes and no repository packages', t => {
  const root = temp(t), copied = join(root, 'skill');
  const skill = fileURLToPath(new URL('..', import.meta.url));
  cpSync(join(skill, 'scripts'), join(copied, 'scripts'), { recursive: true });
  cpSync(join(skill, 'assets', 'contracts'), join(copied, 'assets', 'contracts'), { recursive: true });
  const cli = join(copied, 'scripts', 'validate-sitecore-artifact.mjs'), file = join(root, 'artifact.json');
  const bytes = JSON.stringify(samples().source); writeFileSync(file, bytes);
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const args = ['--kind', 'rendering-mapping-inventory', '--file', file, '--sha256', sha256(bytes)];
  assert.equal(run(args).status, 0, run(args).stderr);
  assert.equal(JSON.parse(run(args).stdout).validation, 'structure-and-integrity');
  assert.notEqual(run(args.slice(0, -2)).status, 0);
  assert.notEqual(run([...args.slice(0, -1), '0'.repeat(64)]).status, 0);
  assert.notEqual(run(['--kind', 'invented', ...args.slice(2)]).status, 0);
  const params = join(root, 'params.json'); writeFileSync(params, JSON.stringify({ kind: 'rendering-mapping-inventory', file, sha256: sha256(bytes) }));
  assert.equal(run(['--params', params]).status, 0);
  assert.equal(validateSitecoreArtifactFileSync({ kind: 'rendering-mapping-inventory', file, sha256: sha256(bytes) }).schemaVersion, 2);
  assert.equal(sitecoreArtifactKinds.length >= 8, true);
});

test('schema engine audits all keywords and unresolved references instead of silently accepting them', t => {
  const root = temp(t), file = join(root, 'probe.schema.json');
  for (const schema of [{ type: 'object', unevaluatedProperties: false }, { $ref: 'https://example.test/remote.schema.json' }, { $ref: '#/$defs/missing' }, { type: 'invented' }, { anyOf: [] }]) {
    writeFileSync(file, JSON.stringify(schema));
    assert.throws(() => validateLocalSchema('probe.schema.json', {}, { directory: root }), /Unsupported|local|Unresolved|Malformed/);
  }
  writeFileSync(file, JSON.stringify({ type: 'array', items: { type: 'integer', minimum: 2 } }));
  assert.throws(() => validateLocalSchema('probe.schema.json', [1], { directory: root }), /at least/);
  assert.throws(() => validateLocalSchema('probe.schema.json', [2.5], { directory: root }), /expected/);
  assert.equal(validateLocalSchema('probe.schema.json', [2], { directory: root })[0], 2);
});
