import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { example, id } from './fixture-factory.mjs';
import { validateDocuments, validateSchema } from '../scripts/validate-inputs.mjs';

const valid = async () => validateDocuments(await example());
const invalid = async (change, code) => {
  const data = await example(); change(data);
  const result = validateDocuments(data);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.ok(result.errors.some(e => e.code === code), JSON.stringify(result));
};

test('conflicting map/remove actions are rejected while multi-destination maps remain supported', async () => {
  await invalid(d => { const g=d.mapping.templates[1],f=g.fields.find(f=>f.action==='map');g.fields.push({action:'remove',sfid:f.sfid,from:f.from}); }, 'mapping-action');
});

test('supplied mapping and synthetic one-to-many/inherited-field/global/parameter examples validate', async () => {
  assert.deepEqual((await valid()).errors, []);
  assert.equal((await valid()).valid, true);
});
test('every companion contract validates against its public schema', async () => {
  const data = await example();
  for (const [name, value] of Object.entries(data)) assert.deepEqual(validateSchema(name, value), [], name);
});
test('public schema files can be registered and used by an independent validator', async () => {
  const require = createRequire(new URL('../scripts/validate-inputs.mjs', import.meta.url));
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(JSON.parse(await readFile(new URL('../contracts/definitions.schema.json', import.meta.url), 'utf8')));
  const data = await example();
  data.migrationInput = JSON.parse(await readFile(new URL('./fixtures/migration-input.json', import.meta.url), 'utf8'));
  const files = { mapping: 'sitecore-mapping', sourceSnapshot: 'source-snapshot', targetInventory: 'target-inventory', destinationPlan: 'destination-plan', itemPlan: 'item-plan', identityMap: 'identity-map', migrationInput: 'migration-input' };
  for (const [key, name] of Object.entries(files)) {
    const schema = JSON.parse(await readFile(new URL(`../contracts/${name}.schema.json`, import.meta.url), 'utf8'));
    const validate = ajv.compile(schema);
    assert.equal(validate(data[key]), true, JSON.stringify(validate.errors));
  }
});
test('unknown actions, extra fields and malformed IDs fail structural validation', async () => {
  await invalid(d => { d.mapping.templates[0].fields[0].action = 'execute'; }, 'schema');
  await invalid(d => { d.mapping.secret = 'unsupported'; }, 'schema');
  await invalid(d => { d.sourceSnapshot.items[0].id = 'not-an-id'; }, 'schema');
});
test('unsupported contract versions and mixed migration scopes are rejected', async () => {
  await invalid(d => { d.sourceSnapshot.version = 2; }, 'schema');
  await invalid(d => { d.destinationPlan.scopeId = 'other-project'; }, 'scope');
});
test('missing target definitions and fields are reported', async () => {
  await invalid(d => { d.targetInventory.templates.shift(); }, 'target-template');
  await invalid(d => { d.targetInventory.templates[0].fields = []; }, 'target-field');
  await invalid(d => { d.targetInventory.renderings = []; }, 'target-rendering');
  await invalid(d => { d.targetInventory.placeholders = []; }, 'target-placeholder');
});
test('inherited field must belong to exactly one mapped target item template', async () => {
  await invalid(d => {
    const g = d.mapping.templates[1]; g.target[1].baseTemplates.push(g.target[0].baseTemplates[0]);
  }, 'field-owner');
});
test('field declaring-template identity cannot disagree with target evidence', async () => {
  await invalid(d => { d.targetInventory.templates[0].fields[0].declaringTemplateId = id(999); }, 'field-owner');
});
test('same template in two mapping groups is rejected instead of using first match', async () => {
  await invalid(d => { d.mapping.templates.push(structuredClone(d.mapping.templates[0])); }, 'duplicate');
});
test('missing destinations and duplicate output identities fail', async () => {
  await invalid(d => { d.destinationPlan.rules.shift(); }, 'destination-missing');
  await invalid(d => { d.destinationPlan.rules.push(structuredClone(d.destinationPlan.rules[0])); }, 'duplicate');
});
test('unsafe and unspecified destination expressions fail', async () => {
  await invalid(d => { d.destinationPlan.rules[0].pathPattern = '/sitecore/content/Site/../Other/{sourceName}'; }, 'path');
  await invalid(d => { d.destinationPlan.rules[0].pathPattern = '/sitecore/content/Other/{sourceName}'; }, 'path');
  await invalid(d => { d.destinationPlan.rules[0].pathPattern = '/sitecore/content/Site/{eval}'; }, 'path');
});
test('local/global datasource identity rules cannot silently change sharing', async () => {
  await invalid(d => { const r = d.destinationPlan.rules.find(r => r.scope === 'page-local'); r.identity = 'source-item'; }, 'destination-scope');
  await invalid(d => { const r = d.destinationPlan.rules.find(r => r.scope === 'global'); r.identity = 'source-item-and-page'; }, 'destination-scope');
});
test('parameter destinations are values, not content items with paths', async () => {
  await invalid(d => { const r = d.destinationPlan.rules.find(r => r.kind === 'parameters'); r.pathPattern = '/sitecore/content/Site/Parameters'; }, 'parameter-item');
});
test('missing folder/branch definitions block destination planning', async () => {
  await invalid(d => { d.destinationPlan.folders[0].segments[0].templateId = id(999); }, 'folder-template');
  await invalid(d => { d.destinationPlan.rules[0].branchId = id(999); }, 'branch');
});
test('duplicate source IDs, field scopes and invalid versions fail', async () => {
  await invalid(d => { d.sourceSnapshot.items.push(structuredClone(d.sourceSnapshot.items[0])); }, 'duplicate');
  await invalid(d => { d.sourceSnapshot.items[0].fields.push(structuredClone(d.sourceSnapshot.items[0].fields[0])); }, 'duplicate');
  await invalid(d => { d.sourceSnapshot.items[0].fields[0].version = 3; }, 'field-scope');
});
test('shared values cannot contain language/version selectors', async () => {
  await invalid(d => { d.sourceSnapshot.items[0].fields[0].storage = 'shared'; }, 'field-scope');
});
test('rendering instance keys include page, device, language and version', async () => {
  const d = await example();
  d.sourceSnapshot.renderingInstances.push({ ...d.sourceSnapshot.renderingInstances[0], deviceId: id(99) });
  assert.equal(validateDocuments(d).valid, true);
  await invalid(d => { d.sourceSnapshot.renderingInstances[0].pageId = id(999); }, 'rendering-context');
});
test('identity maps reject duplicate bindings and foreign instances', async () => {
  await invalid(d => { d.identityMap.entries.push(structuredClone(d.identityMap.entries[0])); }, 'duplicate');
  await invalid(d => { d.identityMap.targetInstanceId = 'different-target'; }, 'identity-instance');
});
test('parameter-derived items require the complete captured occurrence identity', async () => {
  const d = await example();
  const r = d.sourceSnapshot.renderingInstances[0];
  const rule = d.destinationPlan.rules.find(rule => rule.sourceTemplateId === r.parameterTemplateId && rule.kind === 'datasource');
  const entry = {
    sourceItemId: r.instanceId, outputKey: rule.outputKey, targetItemId: id(200), targetPath: '/sitecore/content/Site/Shared/Banner-Instance',
    pageId: r.pageId, renderingInstanceId: r.instanceId, deviceId: r.deviceId, language: r.language, version: r.version,
  };
  d.identityMap.entries.push(entry);
  assert.equal(validateDocuments(d).valid, true);
  delete entry.deviceId;
  assert.ok(validateDocuments(d).errors.some(e => e.code === 'identity-rule'));
});
test('plan metadata binds to the exact staged inputs', async () => {
  const d = await example();
  const binding = { scopeId: d.sourceSnapshot.scopeId, mappingRevision: 'example-1' };
  for (const key of Object.keys(d.itemPlan.inputs)) binding[key] = { sha256: d.itemPlan.inputs[key] };
  assert.equal(validateDocuments(d, binding).valid, true);
  binding.mapping.sha256 = 'a'.repeat(64);
  assert.ok(validateDocuments(d, binding).errors.some(e => e.code === 'input-binding'));
});
test('transformed plans require known target templates/fields and safe target paths', async () => {
  await invalid(d => { d.itemPlan.items[0].templateId = id(999); }, 'target-template');
  await invalid(d => { d.itemPlan.items[0].fields = [{ fieldId: id(999), value: '', storage: 'shared' }]; }, 'target-field');
  await invalid(d => { d.itemPlan.items[0].identity.targetPath = '/sitecore/content/Elsewhere/A'; }, 'path');
});
test('CLI validates staged artifacts, verifies hashes, rejects escapes and writes no files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mapped-contracts-'));
  const cli = fileURLToPath(new URL('../scripts/validate-inputs.mjs', import.meta.url));
  try {
    await cp(new URL('./fixtures/', import.meta.url), dir, { recursive: true });
    const run = () => spawnSync(process.execPath, [cli, '--input', join(dir, 'migration-input.json')], { encoding: 'utf8' });
    const before = await readdir(dir);
    const beforeBytes = await Promise.all(before.map(f => readFile(join(dir, f), 'utf8')));
    let result = run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(await readdir(dir), before);
    assert.deepEqual(await Promise.all(before.map(f => readFile(join(dir, f), 'utf8'))), beforeBytes);
    const manifestPath = join(dir, 'migration-input.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.mapping.path = '../sitecore-mapping.json';
    await writeFile(manifestPath, JSON.stringify(manifest));
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /file-path/);
    manifest.mapping.path = 'sitecore-mapping.json';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(dir, 'sitecore-mapping.json'), '{}');
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /hash/);
    const flags = spawnSync(process.execPath, [cli, '--apply'], { encoding: 'utf8' });
    assert.equal(flags.status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the skill directory validates independently of the authoring monorepo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-mapped-contracts-'));
  const dir = join(root, 'mapped-content-migration');
  try {
    await cp(new URL('../', import.meta.url), dir, { recursive: true, filter: path => !path.split(/[\\/]/).includes('node_modules') });
    // The platform stages sibling recipe skills; the shared validator and file helpers live in cms-migration.
    await cp(new URL('../../cms-migration/scripts/lib/', import.meta.url), join(root, 'cms-migration', 'scripts', 'lib'), { recursive: true });
    const result = spawnSync(process.execPath, [join(dir, 'scripts', 'validate-inputs.mjs'), '--input', join(dir, 'tests', 'fixtures', 'migration-input.json')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
