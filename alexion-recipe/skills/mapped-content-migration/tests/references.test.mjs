import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {referenceFixture} from './reference-fixture.mjs';
import {planReferences} from '../scripts/plan-references.mjs';
import {readExecutionState} from '../scripts/lib/execution-state.mjs';
import {fieldKey} from '../scripts/lib/snapshot.mjs';
import {transitionExecutionState} from '../scripts/lib/execution-state.mjs';

function reciprocal(d){
 const source=d.sourceSnapshot.items[1],page=d.sourceSnapshot.items[0],group=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===source.templateId)),mapping=group.fields.find(f=>f.action==='map'),field=source.fields.find(f=>f.fieldId===mapping.sfid);
 field.fieldType='Droplink';field.value=page.id;for(const template of d.targetInventory.templates)for(const f of template.fields)if(f.id===mapping.tfid)f.type='Droplink';source.references.push({fieldId:field.fieldId,kind:'datasource',language:field.language,version:field.version,targetSourceIds:[page.id]});d.destinationPlan.referenceRules.push({sourceTemplateId:source.templateId,sourceFieldId:field.fieldId,targetOutputKey:d.destinationPlan.rules.find(r=>r.sourceTemplateId===page.templateId&&r.kind==='page').outputKey});
}

test('reference planning rewrites ordered duplicate IDs only after content identities exist',async()=>{
 const s=await referenceFixture();try{const result=await s.planReferences();assert.equal(result.ready,true,JSON.stringify(result));const plan=await s.read('reference-plan/batch-plan.json'),report=await s.read('reference-plan/reference-report.json');assert.ok(plan.batches.length);assert.equal(report.updates.length,s.dependencies.length);for(const update of report.updates){assert.equal(update.targetIds.length,2);assert.equal(update.targetIds[0],update.targetIds[1]);assert.equal(update.value,update.targetIds.join('|'));}assert.ok(plan.batches.flatMap(b=>b.operations).every(o=>o.action==='update'&&!o.versionsToCreate.length));const again=await planReferences(join(s.dir,'reference-input.json'),join(s.dir,'again'));assert.deepEqual(again,result);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}
});
test('proposed IDs without successful writes do not become reference targets',async()=>{
 const s=await referenceFixture({complete:false});try{const r=await s.planReferences();assert.equal(r.ready,false);assert.equal(r.batchCount,0);assert.ok(r.issues.some(i=>i.code==='unconfirmed-identity'));}finally{await s.cleanup();}
});
test('missing target observations and absent versions produce gaps or conflicts, never creations',async()=>{
 for(const mode of ['query','version','field']){const s=await referenceFixture();try{const ref=s.dependencies[0];if(mode==='query')s.evidence.queries=s.evidence.queries.filter(q=>q.value!==ref.targets[0].targetItemId);else for(const q of s.evidence.queries.filter(q=>q.exists&&q.item.id===ref.owner.targetItemId)){if(mode==='version'){q.item.versions=[];q.item.fields=[];}else q.item.fields=q.item.fields.filter(f=>fieldKey(f)!==fieldKey(ref));}const r=await s.planReferences();assert.equal(r.ready,false);assert.equal(r.batchCount,0);}finally{await s.cleanup();}}
});
test('explicit existing media bindings remain read-only and preserve XML metadata',async()=>{
 const s=await referenceFixture({media:true});try{const result=await s.selectReferences();assert.equal(result.ready,true,JSON.stringify(result));const a=await s.authorize(),core=await s.read(a.output+'/execution-review.json');assert.equal(core.operationKind,'references');assert.ok(core.operations[0].fields[0].value.includes(s.d.destinationPlan.existingReferenceTargets[0].targetItemId));assert.ok(core.operations[0].fields[0].value.includes('alt="Keep &amp; preserve"'));assert.ok(core.referenceBindings.some(b=>b.existing));assert.ok(!core.operations.some(o=>o.targetPath.startsWith('/sitecore/media library')));}finally{await s.cleanup();}
});
test('approved reference updates use the same durable writer lifecycle and protect unknown jobs',async()=>{
 const s=await referenceFixture();try{assert.equal((await s.selectReferences()).ready,true);const a=await s.authorize();await s.event('unknown');await assert.rejects(s.prepare(),/reconciled/);const receipt=await s.referenceReceipt(a);const result=await s.finish(a,receipt);assert.equal(result.status,'success');s.publishActual(receipt);const j=await readExecutionState(s.state);assert.ok(j.checkpoint.operations.some(o=>o.operationKind==='references'&&o.status==='success'));assert.equal(j.checkpoint.active,null);}finally{await s.cleanup();}
});
test('target reference drift after review blocks request preparation',async()=>{
 const s=await referenceFixture();try{assert.equal((await s.selectReferences()).ready,true);const ref=s.dependencies[0];for(const q of s.evidence.queries.filter(q=>q.exists&&q.item.id===ref.owner.targetItemId))q.item.fields.find(f=>fieldKey(f)===fieldKey(ref)).value='changed';await assert.rejects(s.prepare(),/differ|changed/);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}
});
test('circular references run in bounded passes and use prior verified reference afterstates',async()=>{
 const s=await referenceFixture({change:reciprocal,batchSize:1});try{assert.equal((await s.selectReferences()).ready,true);const plan=await s.read('reference-plan/batch-plan.json');assert.ok(plan.batches.length>=2);for(const batch of plan.batches){s.request.batchId=batch.batchId;delete s.request.approval;delete s.request.review;const a=await s.authorize(),receipt=await s.referenceReceipt(a);await s.finish(a,receipt);s.publishActual(receipt);}const j=await readExecutionState(s.state);assert.equal(j.checkpoint.operations.filter(o=>o.operationKind==='references'&&o.status==='success').length,2);delete s.request.approval;delete s.request.review;const rerun=await s.authorize();assert.equal(rerun.alreadyCompleted,true);}finally{await s.cleanup();}
});
test('partial identities and mismatched current external reads cannot be approved for references',async()=>{
 const s=await referenceFixture({media:true});try{assert.equal((await s.selectReferences()).ready,true);s.external.queries[0].item.path+='/Wrong';s.request.existingTargetState=await s.put('external-current.json',s.external);await assert.rejects(s.prepare());assert.equal((await readExecutionState(s.state)).checkpoint.active,null);
 const journal=await readExecutionState(s.state);await transitionExecutionState(s.state,journal.sha256,state=>{state.identities[0].status='partial';return state;});await assert.rejects(s.prepare());
 }finally{await s.cleanup();}
});
test('a fresh reference comparison reports reuse after verified updates without emitting writes',async()=>{
 const s=await referenceFixture();try{assert.equal((await s.selectReferences()).ready,true);const a=await s.authorize(),receipt=await s.referenceReceipt(a);await s.finish(a,receipt);s.publishActual(receipt);const checkpoint=await readExecutionState(s.state);s.referenceInput.checkpoint={path:'journal/'+checkpoint.head.path,sha256:checkpoint.sha256};const r=await s.planReferences('reference-complete');assert.equal(r.ready,true);assert.equal(r.batchCount,0);assert.equal((await s.read('reference-complete/dry-run.json')).summary.reuse,1);}finally{await s.cleanup();}
});
test('a foreign identity checkpoint cannot supply continuity for the execution journal',async()=>{
 const s=await referenceFixture();try{const journal=await readExecutionState(s.state),foreign=structuredClone(journal.checkpoint);foreign.identities[0].requestId='exec-'+'0'.repeat(24);s.referenceInput.checkpoint=await s.put('foreign-checkpoint.json',foreign);assert.equal((await s.selectReferences()).ready,true);await assert.rejects(s.prepare(),/ancestor/);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}
});
