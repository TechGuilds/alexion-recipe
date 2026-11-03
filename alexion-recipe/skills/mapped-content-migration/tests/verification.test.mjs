import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verificationFixture} from './verification-fixture.mjs';
import {readExecutionState,transitionExecutionState} from '../scripts/lib/execution-state.mjs';
import {hash} from './fixture-factory.mjs';
import {id} from './fixture-factory.mjs';

test('missing readbacks generate bounded exact read requests without changing target or journal',async()=>{
 const s=await verificationFixture({queriesPerRequest:3});try{const before=await readExecutionState(s.state),r=await s.verify();assert.equal(r.ready,false);assert.ok(r.gapCount);assert.ok(r.readRequestCount>1);const requests=await s.read(r.output+'/readback-requests.json');for(const part of requests.requests){assert.ok(JSON.parse(part.envelope.parameters.RequestJson).queries.length<=3);assert.equal(hash(part.envelope.parameters.RequestJson),part.requestSha256);}assert.equal((await readExecutionState(s.state)).sha256,before.sha256);}finally{await s.cleanup();}
});
test('independent content audit covers every split output, structure, field and resolved reference',async()=>{
 const s=await verificationFixture();try{const first=await s.verify();await s.makeReadbacks(first);const r=await s.verify();assert.equal(r.ready,true,JSON.stringify(await s.read(r.output+'/verification-report.json')));assert.equal(r.gapCount,0);const report=await s.read(r.output+'/verification-report.json');assert.equal(report.items.length,(await s.read('output/item-plan.json')).items.length+(await s.read('output/item-plan.json')).structures.length);assert.ok(report.items.every(i=>i.status==='success'||i.status==='reused'));assert.equal(report.requiresUserConfirmation,true);assert.equal(report.boundaries.visualVerified,false);assert.equal(report.boundaries.workflowAdvanced,false);assert.ok(report.executionOutcomes.length);}finally{await s.cleanup();}
});
test('explicit absence, changed values, wrong parent, types and extra versions fail parity',async()=>{
 for(const mode of ['missing','value','parent','type','versions']){const s=await verificationFixture();try{const first=await s.verify();const actual=s.actual.find(a=>a.fields.length&&a.versions.length);if(mode==='missing')s.actual=s.actual.filter(a=>a.id!==actual.id);if(mode==='value')actual.fields[0].value='changed';if(mode==='parent')actual.parentId='{00000000-0000-4000-8000-000000000001}';if(mode==='type')actual.fields[0].fieldType='Unexpected Type';if(mode==='versions')actual.versions.push({language:'fr',version:1});await s.makeReadbacks(first);const r=await s.verify();assert.equal(r.ready,false,mode);assert.ok((await s.read(r.output+'/verification-report.json')).items.some(i=>i.status==='failed'),mode);}finally{await s.cleanup();}}
});
test('unresolved reference values cannot pass merely because initial execution succeeded',async()=>{
 const s=await verificationFixture({resolve:false});try{const first=await s.verify();await s.makeReadbacks(first);const r=await s.verify();assert.equal(r.ready,false);assert.ok((await s.read(r.output+'/verification-report.json')).items.some(i=>i.differences.some(d=>d.code==='field-value')));}finally{await s.cleanup();}
});
test('receipt data cannot substitute for fresh audit capture provenance',async()=>{
 const s=await verificationFixture();try{const first=await s.verify();await s.makeReadbacks(first);s.readbackStates[0].requestSha256='0'.repeat(64);await s.saveReadbacks();await assert.rejects(s.verify(),/exact target/);}finally{await s.cleanup();}
});
test('partial responses and missing parts remain incomplete rather than counting as absence',async()=>{
 const s=await verificationFixture({queriesPerRequest:3});try{const first=await s.verify();await s.makeReadbacks(first);s.readbackStates.pop();const partial=s.readbackStates[0],query=partial.queries.pop();partial.complete=false;partial.errors.push({lookup:query.lookup,value:query.value,message:'Collector read failed'});await s.saveReadbacks();const r=await s.verify();assert.equal(r.ready,false);assert.ok(r.gapCount);assert.ok((await s.read(r.output+'/verification-report.json')).issues.some(i=>i.code==='capture-error'));}finally{await s.cleanup();}
});
test('tampered saved plans fail source reconstruction even when their local descriptors are rehashed',async()=>{
 const s=await verificationFixture();try{const input=await s.read('plan-input.json'),plan=await s.read('output/item-plan.json');plan.items[0].fields[0].value='fabricated';input.itemPlan=await s.put('output/item-plan.json',plan);s.verificationInput.contentPlanInput=await s.put('plan-input.json',input);await assert.rejects(s.verify(),/independently rebuilt/);}finally{await s.cleanup();}
});
test('pending write jobs and partial identity history cannot produce a passing final audit',async()=>{
 for(const mode of ['pending','partial']){const s=await verificationFixture();try{const before=await readExecutionState(s.state),next=await transitionExecutionState(s.state,before.sha256,state=>{if(mode==='partial')state.identities[0].status='partial';else state.active={requestId:'exec-'+'1'.repeat(24),reviewSha256:'1'.repeat(64),batchPlanSha256:'1'.repeat(64),batchId:'batch-0001',operationIds:['op-'+'1'.repeat(24)],state:'unknown',jobId:'unknown-job',envelopeSha256:'1'.repeat(64)};return state;});const head=await readExecutionState(s.state);s.verificationInput.checkpoint={path:'journal/'+head.head.path,sha256:next.sha256};const first=await s.verify();await s.makeReadbacks(first);const r=await s.verify();assert.equal(r.ready,false,mode);}finally{await s.cleanup();}}
});
test('verification CLI returns evidence-gap exit 2 and rejects invented mutation flags',async()=>{
 const s=await verificationFixture();try{await s.put('verification-input.json',s.verificationInput);const script=fileURLToPath(new URL('../scripts/verify-target.mjs',import.meta.url)),run=spawnSync(process.execPath,[script,'--input',join(s.dir,'verification-input.json'),'--output',join(s.dir,'cli-verification')],{encoding:'utf8'});assert.equal(run.status,2,run.stdout+run.stderr);assert.equal(spawnSync(process.execPath,[script,'--apply'],{encoding:'utf8'}).status,1);}finally{await s.cleanup();}
});
test('audit captures cannot be reused after the selected journal checkpoint changes',async()=>{
 const s=await verificationFixture();try{const first=await s.verify();await s.makeReadbacks(first);const before=await readExecutionState(s.state);await transitionExecutionState(s.state,before.sha256,state=>state);await assert.rejects(s.verify(),/current immutable checkpoint/);const current=await readExecutionState(s.state);s.verificationInput.checkpoint={path:'journal/'+current.head.path,sha256:current.sha256};await assert.rejects(s.verify(),/exact target/);}finally{await s.cleanup();}
});
test('approved source exclusions remain explicit and separate from output failures',async()=>{
 const s=await verificationFixture({change:d=>{const excluded=structuredClone(d.sourceSnapshot.items[0]);excluded.id=id(950);excluded.name='Excluded Legacy Page';excluded.path='/sitecore/content/Legacy/Excluded Legacy Page';d.sourceSnapshot.items.push(excluded);d.destinationPlan.exclusions.push({sourceItemId:excluded.id,reason:'User excluded this legacy page'});}});try{const first=await s.verify();await s.makeReadbacks(first);const r=await s.verify();assert.equal(r.ready,true);assert.equal(r.summary.excluded,1);assert.equal(r.summary.failed,0);const report=await s.read(r.output+'/verification-report.json');assert.equal(report.exclusions[0].sourceItemId,id(950));}finally{await s.cleanup();}
});
test('conflicting ID/path reads, wrong cohorts and false completion are rejected',async()=>{
 for(const mode of ['conflict','cohort','completion']){const s=await verificationFixture();try{const first=await s.verify();await s.makeReadbacks(first);const state=s.readbackStates[0];if(mode==='cohort')state.targetStateId='another-audit';else if(mode==='completion')state.queries.pop();else state.queries.find(q=>q.lookup==='path'&&q.item?.fields.length).item.fields[0].value='contradictory';await s.saveReadbacks();await assert.rejects(s.verify());}finally{await s.cleanup();}}
});
test('oldest failures remain visible after successful recovery without becoming current failures',async()=>{
 const s=await verificationFixture();try{const before=await readExecutionState(s.state);await transitionExecutionState(s.state,before.sha256,state=>{const old=structuredClone(state.operations[0]);old.status='failed';old.mutated=false;old.message='Preserved earlier failed attempt';state.operations.unshift(old);return state;});const current=await readExecutionState(s.state);s.verificationInput.checkpoint={path:'journal/'+current.head.path,sha256:current.sha256};const first=await s.verify();await s.makeReadbacks(first);const r=await s.verify();assert.equal(r.ready,true);assert.ok((await s.read(r.output+'/verification-report.json')).executionOutcomes.some(o=>o.status==='failed'));}finally{await s.cleanup();}
});
