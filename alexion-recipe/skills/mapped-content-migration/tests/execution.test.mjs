import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {executionFixture} from './execution-fixture.mjs';
import {readExecutionState,transitionExecutionState} from '../scripts/lib/execution-state.mjs';
import {assertContiguousVersions} from '../scripts/lib/execution-guards.mjs';
import {hash} from './fixture-factory.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('review is read-only and authorized preparation reserves exact request bytes',async()=>{
 const s=await executionFixture();try{const before=await readExecutionState(s.state),review=await s.prepare();assert.equal(review.approvalRequired,true);assert.equal((await readExecutionState(s.state)).sha256,before.sha256);
 const a=await s.authorize(),envelope=await s.read(a.output+'/target-request.json');assert.equal(hash(envelope.parameters.Request.reviewJson),a.review.sha256);assert.equal(envelope.background,true);assert.equal((await readExecutionState(s.state)).checkpoint.active.state,'reserved');await assert.rejects(s.prepare(),/reconciled/);
 }finally{await s.cleanup();}
});
test('unknown submission blocks further writes and can only reconcile the same known job',async()=>{
 const s=await executionFixture();try{const a=await s.authorize();await s.event('submitted',{jobId:'remote-1'});await s.event('unknown',{jobId:'remote-1'});await assert.rejects(s.prepare(),/reconciled/);await assert.rejects(s.event('submitted',{jobId:'remote-2'}),/cannot change/);assert.equal((await readExecutionState(s.state)).checkpoint.active.state,'unknown');
 const receipt=await s.receipt(a);const r=await s.event('terminal',{terminal:true,jobId:'remote-1',review:{path:a.output+'/execution-review.json',sha256:a.review.sha256},receipt:await s.put('receipt.json',receipt)});assert.equal(r.status,'success');const j=await readExecutionState(s.state);assert.equal(j.checkpoint.active,null);assert.ok(j.checkpoint.operations.every(o=>o.status==='success'));assert.equal(j.checkpoint.completedBatches.length,1);
 }finally{await s.cleanup();}
});
test('successful prior batches supply actual dependency guards to subsequent execution',async()=>{
 const s=await executionFixture();try{s.request.batchId=s.batchPlan.batches[1].batchId;const a=await s.authorize(),receipt=await s.receipt(a);await s.finish(a,receipt);
 for(const row of receipt.results)for(const q of s.evidence.queries)if(q.value.toLowerCase()===(q.lookup==='id'?row.targetItemId:row.targetPath).toLowerCase()){q.exists=true;q.item=row.post;}
 delete s.request.approval;delete s.request.review;s.request.batchId=s.batchPlan.batches[2].batchId;const review=await s.prepare();const core=await s.read(review.output+'/execution-review.json');assert.ok(core.knownSuccess.length);assert.ok(core.operations.length);assert.ok(core.knownSuccess.every(o=>o.post));
 }finally{await s.cleanup();}
});
test('forged successful read-back cannot release a pending request',async()=>{
 const s=await executionFixture();try{const a=await s.authorize(),r=await s.receipt(a);r.results[0].post.path+='/Wrong';await assert.rejects(s.finish(a,r),/does not match/);assert.ok((await readExecutionState(s.state)).checkpoint.active);
 }finally{await s.cleanup();}
});
test('partial mutations remain recorded and cannot be blindly retried',async()=>{
 const s=await executionFixture();try{const a=await s.authorize(),r=await s.receipt(a);r.status='partial';r.results[0].status='failed';for(const row of r.results.slice(1)){row.status='skipped';row.mutated=false;delete row.post;}await s.finish(a,r);const j=await readExecutionState(s.state);assert.equal(j.checkpoint.active,null);assert.ok(j.checkpoint.operations.some(o=>o.mutated&&o.status==='failed'));delete s.request.approval;delete s.request.review;await assert.rejects(s.prepare(),/Partial effects/);
 }finally{await s.cleanup();}
});
test('scope drift, expired capabilities and missing recovery proof block preparation',async()=>{
 for(const mutate of [s=>s.cap.instanceId='another',s=>s.cap.expiresAt='2020-01-01T00:00:00Z',s=>s.cap.restoreValidated=false,s=>s.cap.journalContinuityVerified=false]){const s=await executionFixture();try{mutate(s);await assert.rejects(s.prepare());assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}}
});
test('oversize connector envelope fails before reserving the journal',async()=>{
 const s=await executionFixture();try{s.cap.maxRequestBytes=1024;await assert.rejects(s.authorize(),/exceeds/);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}
});
test('stale checkpoint transitions cannot overwrite durable state',async()=>{
 const s=await executionFixture();try{const j=await readExecutionState(s.state);await transitionExecutionState(s.state,j.sha256,state=>state);await assert.rejects(transitionExecutionState(s.state,j.sha256,state=>state),/Checkpoint changed/);assert.equal((await readExecutionState(s.state)).checkpoint.sequence,1);}finally{await s.cleanup();}
});
test('version gaps and unapproved initial versions fail before target writes',()=>{
 const op={action:'create',kind:'content',targetPath:'/sitecore/content/Test',versionsToCreate:[{language:'en',version:2}]};assert.throws(()=>assertContiguousVersions(op,{exists:false}),/contiguous/);op.versionsToCreate=[{language:'en',version:1}];assert.doesNotThrow(()=>assertContiguousVersions(op,{exists:false}));op.action='update';op.versionsToCreate=[{language:'en',version:3}];assert.throws(()=>assertContiguousVersions(op,{exists:true,item:{versions:[{language:'en',version:1}]}}),/contiguous/);
});
test('updates require pre-write backup evidence before successful reconciliation',async()=>{
 const s=await executionFixture({update:true});try{const a=await s.authorize(),r=await s.receipt(a);assert.ok(r.results.length);await assert.rejects(s.finish(a,r),/backup descriptor/);
 const core=await s.read(a.output+'/execution-review.json');r.backups=core.operations.filter(o=>o.action==='update').map(o=>({operationId:o.operationId,targetItemId:o.targetItemId,files:[{path:r.journal.path.replace('journal.jsonl','backups/'+o.operationId+'/item.item'),sha256:'b'.repeat(64),bytes:100}]}));const result=await s.event('terminal',{jobId:'job-2',terminal:true,review:{path:a.output+'/execution-review.json',sha256:a.review.sha256},receipt:await s.put('receipt.json',r)});assert.equal(result.status,'success');
 }finally{await s.cleanup();}
});
test('contradictory receipt statuses and success after a failure cannot clear a pending job',async()=>{
 for(const mode of ['status','order','provenance']){const s=await executionFixture();try{const a=await s.authorize(),r=await s.receipt(a);if(mode==='status'){r.status='failed';r.results[0].status='failed';for(const row of r.results.slice(1)){row.status='skipped';row.mutated=false;delete row.post;}}else if(mode==='order'){r.status='partial';r.results[0].status='failed';}else{r.journal.path=r.journal.path.replace(a.requestId,'exec-'+'0'.repeat(24));}await assert.rejects(s.finish(a,r));assert.ok((await readExecutionState(s.state)).checkpoint.active);}finally{await s.cleanup();}}
});
test('a reviewed target or approval change requires a new review before reservation',async()=>{
 for(const mode of ['approval','evidence']){const s=await executionFixture();try{const review=await s.prepare();s.request.review={path:review.output+'/execution-review.json',sha256:review.review.sha256};s.request.approval=await s.put('approval.json',{id:'approval',kind:'mutation',scopeId:s.binding.scopeId,taskId:s.request.taskId,choice:'approve',rationale:'review',userResponse:'Approve',at:new Date().toISOString(),inputs:[{path:'wrong.json',sha256:'0'.repeat(64)}]});if(mode==='evidence')s.evidence.targetStateId='changed';await assert.rejects(s.prepare(),/review|decision/i);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}}
});
test('confirmed completed batches return no executable envelope on a safe rerun',async()=>{
 const s=await executionFixture();try{const a=await s.authorize(),r=await s.receipt(a);await s.finish(a,r);for(const row of r.results)for(const q of s.evidence.queries)if(q.value.toLowerCase()===(q.lookup==='id'?row.targetItemId:row.targetPath).toLowerCase()){q.exists=true;q.item=row.post;}delete s.request.approval;delete s.request.review;const completed=await s.authorize();assert.equal(completed.alreadyCompleted,true);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);await assert.rejects(readFile(join(s.dir,completed.output,'target-request.json')));
 }finally{await s.cleanup();}
});
test('unreadable partial updates demote earlier actual identity bindings',async()=>{
 const s=await executionFixture({update:true});try{const batch=s.batchPlan.batches.find(b=>b.batchId===s.request.batchId),op=batch.operations.find(o=>o.action==='update'),identity=(await s.read('output/proposed-identity-map.json')).entries.find(i=>i.targetItemId===op.targetItemId);const before=await readExecutionState(s.state);
 await transitionExecutionState(s.state,before.sha256,state=>{state.identities.push({identity,status:'success',requestId:'exec-'+'1'.repeat(24),batchPlanSha256:'1'.repeat(64),mappingRevision:'previous'});return state;});
 const a=await s.authorize(),r=await s.receipt(a);r.status='partial';for(const row of r.results){row.status=row.operationId===op.operationId?'failed':'skipped';row.mutated=row.status==='failed';delete row.post;}r.backups=[{operationId:op.operationId,targetItemId:op.targetItemId,files:[{path:r.journal.path.replace('journal.jsonl','backups/'+op.operationId+'/item.item'),sha256:'b'.repeat(64),bytes:100}]}];await s.finish(a,r);const after=await readExecutionState(s.state);assert.equal(after.checkpoint.identities.find(e=>e.identity.targetItemId===op.targetItemId).status,'partial');
 }finally{await s.cleanup();}
});
test('execution CLIs expose review-only exit codes, initialize journals and reject invented flags',async()=>{
 const s=await executionFixture();try{await s.save();const prepare=fileURLToPath(new URL('../scripts/prepare-execution.mjs',import.meta.url)),record=fileURLToPath(new URL('../scripts/record-execution.mjs',import.meta.url));
 const review=spawnSync(process.execPath,[prepare,'--input',join(s.dir,'execution-input.json'),'--output',join(s.dir,'cli-review'),'--state-dir',s.state],{encoding:'utf8'});assert.equal(review.status,2,review.stdout+review.stderr);assert.equal(JSON.parse(review.stdout).approvalRequired,true);
 const journal=await readExecutionState(s.state),{scopeId,targetInstanceId,database,rootPath,connectorId}=journal.checkpoint;await s.put('init.json',{version:1,action:'initialize',scope:{scopeId,targetInstanceId,database,rootPath,connectorId}});
 const init=spawnSync(process.execPath,[record,'--input',join(s.dir,'init.json'),'--state-dir',join(s.dir,'cli-journal')],{encoding:'utf8'});assert.equal(init.status,0,init.stdout+init.stderr);assert.match(JSON.parse(init.stdout).checkpointSha256,/^[a-f0-9]{64}$/);
 for(const script of [prepare,record])assert.equal(spawnSync(process.execPath,[script,'--apply'],{encoding:'utf8'}).status,1);
 }finally{await s.cleanup();}
});
test('same-instance source and target scope overlap is rejected before reservation',async()=>{
 const s=await executionFixture({overlap:true});try{await assert.rejects(s.prepare(),/disjoint/);assert.equal((await readExecutionState(s.state)).checkpoint.active,null);}finally{await s.cleanup();}
});
test('same-instance migration supports disjoint source and target sites',async()=>{
 const s=await executionFixture({sameInstance:true});try{assert.equal((await s.prepare()).reviewReady,true);}finally{await s.cleanup();}
});
