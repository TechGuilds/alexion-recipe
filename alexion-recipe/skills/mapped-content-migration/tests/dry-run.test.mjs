import test from 'node:test';
import assert from 'node:assert/strict';
import { planChanges } from '../scripts/lib/dry-run.mjs';
import { id } from './fixture-factory.mjs';

const root = '/sitecore/content/Site';
function fixture() {
  const identity = { sourceItemId: id(1), outputKey: 'page', targetItemId: id(2), targetPath: root + '/Page' };
  const field = { fieldId: id(3), storage: 'versioned', language: 'en', version: 1, value: 'new' };
  const plan = { version: 1, scopeId: 'test', mappingRevision: 'r1', inputs: {}, items: [{ identity, templateId: id(4), action: 'create', versions: [{ language: 'en', version: 1 }], parentPath: root, fields: [field], relationships: [] }], structures: [], issues: [] };
  const item = { id: id(90), templateId: id(91), path: root, versionsComplete: true, versions: [], fields: [] };
  const evidence = { version: 1, scopeId: 'test', instanceId: 'target', database: 'master', capturedAt: '2026-10-27T10:00:00Z', targetStateId: 'reviewed-state', rootPath: root, valueMode: 'effective', queries: [{ lookup: 'path', value: root, exists: true, item }, { lookup: 'path', value: identity.targetPath, exists: false }, { lookup: 'id', value: identity.targetItemId, exists: false }] };
  const report = { referenceDependencies: [], exclusions: [], deferredParameters: [] };
  return { plan, evidence, report, policies: new Map([[identity.targetPath.toLowerCase(), 'create-only']]), limits: { maxItemsPerBatch: 2, maxBatchBytes: 4096 } };
}
function exists(f, values = ['old']) {
  const row = f.plan.items[0], item = { id: row.identity.targetItemId, templateId: row.templateId, path: row.identity.targetPath, versionsComplete: true, versions: row.versions, fields: row.fields.map((v, i) => ({ ...v, value: values[i], present: true })) };
  f.evidence.queries = f.evidence.queries.map(q => q.value === row.identity.targetPath || q.value === row.identity.targetItemId ? { ...q, exists: true, item: structuredClone(item) } : q);
  return f;
}

test('explicit absence produces deterministic create batches and before-state fingerprints', () => {
  const f = fixture(), a = planChanges(f), b = planChanges(f);
  assert.equal(a.ready, true); assert.equal(a.rows[0].action, 'create'); assert.deepEqual(a, b);
  assert.equal(a.batches[0].operations[0].fields[0].value, 'new'); assert.match(a.rows[0].beforeFingerprint, /^[a-f0-9]{64}$/);
});
test('missing target lookups become evidence gaps, never implicit absence', () => {
  const f = fixture(); f.evidence.queries.pop(); const r = planChanges(f);
  assert.equal(r.ready, false); assert.equal(r.rows[0].action, 'conflict'); assert.equal(r.batches.length, 0); assert.ok(r.gaps.length);
});
test('update compares scoped fields, reuse requires equality and create-only blocks existing items', () => {
  for (const [policy, before, expected] of [['update','old','update'], ['update','new','reuse'], ['reuse','new','reuse'], ['reuse','old','conflict'], ['create-only','new','conflict']]) {
    const f = exists(fixture(), [before]); f.policies.set(f.plan.items[0].identity.targetPath.toLowerCase(), policy);
    const r = planChanges(f); assert.equal(r.rows[0].action, expected, JSON.stringify(r));
    assert.equal(r.ready, expected !== 'conflict');
  }
});
test('missing field observations differ from explicit empty or absent values', () => {
  const f = exists(fixture(), ['']); f.policies.set(f.plan.items[0].identity.targetPath.toLowerCase(), 'update');
  assert.equal(planChanges(f).ready, true);
  for (const q of f.evidence.queries.filter(q => q.item?.id === id(2))) q.item.fields = [];
  assert.equal(planChanges(f).ready, false);
});
test('moved or incompatible identities and contradictory lookups block planning', () => {
  const f = exists(fixture()); f.evidence.queries.find(q => q.lookup === 'id').item.path += '-moved';
  assert.throws(() => planChanges(f), /Contradictory/);
});
test('parent folders precede child items and batch item/byte bounds are enforced', () => {
  const f = fixture(); const row = f.plan.items[0], folderPath = root + '/Data';
  f.plan.structures.push({ targetItemId: id(5), targetPath: folderPath, templateId: id(6), parentPath: root, action: 'create' });
  row.identity.targetPath = folderPath + '/Page'; row.parentPath = folderPath;
  f.policies = new Map([[row.identity.targetPath.toLowerCase(), 'create-only']]);
  f.evidence.queries = f.evidence.queries.filter(q => q.value !== root + '/Page');
  f.evidence.queries.push({ lookup: 'path', value: folderPath, exists: false }, { lookup: 'id', value: id(5), exists: false }, { lookup: 'path', value: row.identity.targetPath, exists: false });
  f.limits.maxItemsPerBatch = 1;
  const r = planChanges(f); assert.equal(r.ready, true, JSON.stringify(r)); assert.equal(r.batches.length, 2);
  assert.equal(r.batches[0].operations[0].targetPath, folderPath); assert.equal(r.batches[1].operations[0].dependsOn.length, 1);
  row.fields[0].value = 'x'.repeat(5000); assert.equal(planChanges(f).ready, false);
});
test('reference fields are deferred and circular links do not become parent dependencies', () => {
  const f = fixture(), row = f.plan.items[0];
  row.relationships.push({ fieldId: row.fields[0].fieldId, language: 'en', version: 1, targets: [row.identity] });
  f.report.referenceDependencies.push({ owner: row.identity, fieldId: row.fields[0].fieldId, language: 'en', version: 1, kind: 'list', rawValue: row.fields[0].value, sourceFieldId: id(8), targetSourceIds: [id(1)], targets: [row.identity], status: 'planned' });
  const r = planChanges(f); assert.equal(r.ready, true); assert.equal(r.batches[0].operations[0].fields.length, 0); assert.equal(r.referencesPending, true);
});

test('fingerprints change with observed values while observation ordering is immaterial',()=>{
  const f=exists(fixture());f.policies.set(f.plan.items[0].identity.targetPath.toLowerCase(),'update');
  const a=planChanges(f);f.evidence.queries.reverse();assert.equal(planChanges(f).rows[0].beforeFingerprint,a.rows[0].beforeFingerprint);
  for(const q of f.evidence.queries)if(q.item?.id===id(2))q.item.fields[0].value='changed externally';
  assert.notEqual(planChanges(f).rows[0].beforeFingerprint,a.rows[0].beforeFingerprint);
});

test('missing versions are proposed explicitly and unobserved fields are never cleared',()=>{
  const f=exists(fixture());f.policies.set(f.plan.items[0].identity.targetPath.toLowerCase(),'update');
  for(const q of f.evidence.queries)if(q.item?.id===id(2)){q.item.versions=[];q.item.fields[0]={fieldId:id(3),storage:'versioned',language:'en',version:1,present:false};}
  const r=planChanges(f);assert.equal(r.ready,true);assert.deepEqual(r.rows[0].versionsToCreate,[{language:'en',version:1}]);assert.equal(r.rows[0].changes[0].before,null);
  assert.equal(r.batches[0].operations[0].fields.length,1);
});

test('complete version evidence and exact field storage are mandatory',()=>{
  const f=exists(fixture());f.evidence.queries.find(q=>q.lookup==='id').item.versionsComplete=false;
  assert.throws(()=>planChanges(f));
});
