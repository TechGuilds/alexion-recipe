import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setup } from './transform-fixture.mjs';
import { bytes,hash } from './fixture-factory.mjs';
import { planContent } from '../scripts/plan-content.mjs';
import { validateSchema } from '../scripts/validate-inputs.mjs';

async function prepare() {
  const s=await setup(); await s.run();
  const plan=JSON.parse(await readFile(join(s.output,'item-plan.json')));
  const nodes=[...plan.items.map(i=>({id:i.identity.targetItemId,path:i.identity.targetPath})),...plan.structures.map(i=>({id:i.targetItemId,path:i.targetPath}))];
  const evidence={version:1,scopeId:s.binding.scopeId,instanceId:s.d.targetInventory.instanceId,database:s.d.targetInventory.database,capturedAt:'2026-10-27T11:00:00Z',targetStateId:'reviewed-target',rootPath:s.d.destinationPlan.targetRootPath,valueMode:'effective',queries:[]};
  for(const n of nodes)evidence.queries.push({lookup:'id',value:n.id,exists:false},{lookup:'path',value:n.path,exists:false});
  const parents=new Set(nodes.map(n=>n.path.slice(0,n.path.lastIndexOf('/'))).filter(p=>!nodes.some(n=>n.path===p)));
  for(const p of parents){const actual=s.d.targetInventory.items.find(i=>i.path===p);assert.ok(actual,p);evidence.queries.push({lookup:'path',value:p,exists:true,item:{...actual,versionsComplete:true,versions:[],fields:[]}});}
  const request={version:1,maxItemsPerBatch:2,maxBatchBytes:4096};
  for(const [key,path] of Object.entries({transformInput:'transform.json',itemPlan:'output/item-plan.json',identityMap:'output/proposed-identity-map.json',transformReport:'output/transform-report.json'}))request[key]={path,sha256:hash(await readFile(join(s.dir,path)))};
  s.evidence=evidence;s.request=request;
  s.save=async()=>{await writeFile(join(s.dir,'target-state.json'),bytes(s.evidence));request.targetState={path:'target-state.json',sha256:hash(bytes(s.evidence))};await writeFile(join(s.dir,'plan-input.json'),bytes(request));};
  await s.save();s.plan=()=>planContent(join(s.dir,'plan-input.json'),join(s.dir,'dry-run'));
  return s;
}
test('planner binds transformation and target evidence into schema-valid immutable review artifacts',async()=>{
  const s=await prepare();try{
    const result=await s.plan();assert.equal(result.ready,true,JSON.stringify(result));assert.ok(result.batchCount>=3);
    const plan=JSON.parse(await readFile(join(s.dir,'dry-run/batch-plan.json')));assert.deepEqual(validateSchema('batchPlan',plan),[]);assert.equal(plan.reviewOnly,true);
    assert.equal(plan.inputs.targetState,s.request.targetState.sha256);assert.equal(result.executionAvailable,false);
    const again=await planContent(join(s.dir,'plan-input.json'),join(s.dir,'again'));assert.deepEqual(result,again);
    await assert.rejects(s.plan());
  }finally{await s.cleanup();}
});
test('partial target evidence creates reviewable gaps and withholds every batch',async()=>{
  const s=await prepare();try{s.evidence.queries.shift();await s.save();const r=await s.plan();assert.equal(r.ready,false);assert.equal(r.batchCount,0);assert.ok(r.gapCount);const gaps=JSON.parse(await readFile(join(s.dir,'dry-run/target-read-requirements.json')));assert.ok(gaps.gaps.length);}finally{await s.cleanup();}
});
test('wrong target identity and changed artifact bytes fail rather than being rebound',async()=>{
  for(const mode of ['identity','hash']){const s=await prepare();try{if(mode==='identity'){s.evidence.instanceId='another-target';await s.save();}else await writeFile(join(s.output,'item-plan.json'),'{}');await assert.rejects(s.plan(),/differs|SHA|Artifact/);}finally{await s.cleanup();}}
});
test('older reports without output hashes require regeneration',async()=>{
  const s=await prepare();try{const p=join(s.output,'transform-report.json'),r=JSON.parse(await readFile(p));delete r.itemPlanSha256;await writeFile(p,bytes(r));s.request.transformReport.sha256=hash(bytes(r));await s.save();await assert.rejects(s.plan(),/regenerate older reports/);}finally{await s.cleanup();}
});
test('reused planned parents retain explicit preconditions even without a write operation',async()=>{
  const s=await prepare();try{
    const p=JSON.parse(await readFile(join(s.output,'item-plan.json'))),folder=p.structures[0];
    const actual={id:folder.targetItemId,templateId:folder.templateId,path:folder.targetPath,versionsComplete:true,versions:[],fields:[]};
    for(const q of s.evidence.queries)if(q.value===folder.targetItemId||q.value===folder.targetPath){q.exists=true;q.item=actual;}
    await s.save();assert.equal((await s.plan()).ready,true);
    const batch=JSON.parse(await readFile(join(s.dir,'dry-run/batch-plan.json')));
    assert.ok(batch.preconditions.some(p=>p.targetItemId===folder.targetItemId&&p.beforeFingerprint));
    assert.ok(!batch.batches.flatMap(b=>b.operations).some(o=>o.targetItemId===folder.targetItemId));
    for(const b of batch.batches){assert.ok(b.operations.length<=s.request.maxItemsPerBatch);assert.ok(Buffer.byteLength(bytes(b))<=s.request.maxBatchBytes);}
  }finally{await s.cleanup();}
});
test('planner CLI supports review and rejects remote execution flags',async()=>{
  const s=await prepare();try{const script=fileURLToPath(new URL('../scripts/plan-content.mjs',import.meta.url));const r=spawnSync(process.execPath,[script,'--input',join(s.dir,'plan-input.json'),'--output',join(s.dir,'cli')],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(spawnSync(process.execPath,[script,'--apply'],{encoding:'utf8'}).status,1);}finally{await s.cleanup();}
});
