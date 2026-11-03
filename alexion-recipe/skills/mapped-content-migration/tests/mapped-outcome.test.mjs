import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup} from './transform-fixture.mjs';
import {executionFixture} from './execution-fixture.mjs';
import {verificationFixture} from './verification-fixture.mjs';
import {referenceFixture} from './reference-fixture.mjs';
import {hash,bytes} from './fixture-factory.mjs';
import {readExecutionState,transitionExecutionState} from '../scripts/lib/execution-state.mjs';
import {validateMappedOutcome} from '../scripts/validate-mapped-outcome.mjs';
import {planContent} from '../scripts/plan-content.mjs';
import {validate as validateCMS} from '../../cms-migration/scripts/contracts.mjs';

const metadata=JSON.parse(await readFile(new URL('../assets/workflow-operations.json',import.meta.url),'utf8'));
async function put(s,path,value){await writeFile(join(s.dir,path),bytes(value));return {path,sha256:hash(bytes(value))};}
async function descriptor(s,path){return {path,sha256:hash(await readFile(join(s.dir,path)))};}
async function packet(s,operation,roles,outputs){
  const def=metadata.tasks.find(t=>t.operation===operation), inputs=await Promise.all(Object.entries(roles).map(async([role,path])=>({role,...await descriptor(s,path)})));
  const p={version:1,kind:'cms-migration-task-packet',scopeId:s.binding.scopeId,contentMigrationMode:'mapped-content',task:{id:def.id,title:def.title,phaseId:metadata.phaseId,agent:def.agent},inputs:inputs.map(({role,...d})=>d),mappedContent:{version:1,operation,procedure:`mapped-content-migration/${def.procedure}`,entryPoints:def.entryPoints,inputRoles:inputs,requiredOutputRoles:def.outputRoles,optionalOutputRoles:def.optionalOutputRoles??[]}};
  p.entities=[{id:`mapped-content-operation:${p.scopeId}:${operation}`,kind:`mapped-content:${operation}`,scope:'included',source:{identity:operation,path:'mode-decision.json'},parentIds:[],routeIds:[],joins:[],uncertainty:[]}];
  p.contentMigrationDecision={id:'mode',kind:'scope',scopeId:p.scopeId,choice:'mapped-content',rationale:'Reviewed scope',userResponse:'Use mapped content',at:new Date(Date.now()-1000).toISOString(),inputs:p.inputs};
  return {version:1,packet:await put(s,'task-packet.json',p),outputs:await Promise.all(Object.entries(outputs).flatMap(([role,paths])=>(Array.isArray(paths)?paths:[paths]).map(async path=>({role,...await descriptor(s,path)}))))};
}
async function valid(s,input){const result=await validateMappedOutcome(input,{base:s.dir});assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.workflowAdvanced,false);return result;}
async function invalid(s,input,pattern){const result=await validateMappedOutcome(input,{base:s.dir});assert.equal(result.valid,false);if(pattern)assert.match(result.errors.join(' '),pattern);return result;}

test('transform output replay catches hash-consistent tampering, missing roles and forged metadata',async()=>{
  const s=await setup();try{
    await s.run();const input=await packet(s,'transform',{transformInput:'transform.json'},{itemPlan:'output/item-plan.json',identityMap:'output/proposed-identity-map.json',transformReport:'output/transform-report.json'});
    await valid(s,input);await invalid(s,{...input,outputs:input.outputs.slice(1)},/required output/);
    const canonicalPacket=JSON.parse(await readFile(join(s.dir,'task-packet.json'),'utf8'));
    for(const mutate of [p=>{p.entities=[];},p=>{p.entities[0].kind='component';},p=>{p.entities[0].source.identity='capture';},p=>{p.entities[0].id='other';}]) {
      const p=structuredClone(canonicalPacket);mutate(p);await invalid(s,{...input,packet:await put(s,'foreign-packet.json',p)},/canonical mapped operation unit/);
    }
    const report=JSON.parse(await readFile(join(s.dir,'output/transform-report.json'),'utf8'));report.itemCount++;
    input.outputs.find(o=>o.role==='transformReport').sha256=(await put(s,'output/transform-report.json',report)).sha256;
    await invalid(s,input,/canonical operation/);
    const p=JSON.parse(await readFile(join(s.dir,'task-packet.json'),'utf8'));p.task.agent='tester';input.packet=await put(s,'task-packet.json',p);
    await invalid(s,input,/canonical operation/);
  }finally{await s.cleanup();}
});

test('ready planning is replayed and false ready outputs cannot complete a task',async()=>{
  const s=await executionFixture();try{
    const input=await packet(s,'plan',{planInput:'plan-input.json'},{batchPlan:'dry-run/batch-plan.json',dryRun:'dry-run/dry-run.json'});await valid(s,input);
    const dry=await s.read('dry-run/dry-run.json');dry.ready=false;input.outputs.find(o=>o.role==='dryRun').sha256=(await put(s,'dry-run/dry-run.json',dry)).sha256;
    await invalid(s,input,/canonical operation/);
  }finally{await s.cleanup();}
});

test('capture validates actual coverage, source binding and ready evidence',async()=>{
  const s=await setup();try{
    const input=await packet(s,'capture',{sourcePreparationInput:'prepare.json'},{snapshotManifest:'snapshot/source-snapshot.json',coverageReport:'snapshot/coverage.json'});await valid(s,input);
    const coverage=JSON.parse(await readFile(join(s.dir,'snapshot/coverage.json'),'utf8'));coverage.capturedItems++;
    input.outputs.find(o=>o.role==='coverageReport').sha256=(await put(s,'snapshot/coverage.json',coverage)).sha256;await invalid(s,input,/Coverage report differs/);
  }finally{await s.cleanup();}
});

test('audit and handoff independently replay parity and require an exact current human phase decision',async()=>{
  const s=await verificationFixture();try{
    const first=await s.verify();await s.makeReadbacks(first);const ready=await s.verify();assert.equal(ready.ready,true);
    const journal=await readExecutionState(s.state), checkpoint='journal/'+journal.head.path;
    const audit=await packet(s,'audit',{verificationInput:'verification-input.json',checkpoint},{verificationReport:ready.output+'/verification-report.json'});audit.packet=await put(s,'audit-task-packet.json',await s.read('task-packet.json'));await valid(s,audit);
    const report=await s.read(ready.output+'/verification-report.json');report.ready=false;
    audit.outputs[0].sha256=(await put(s,ready.output+'/verification-report.json',report)).sha256;await invalid(s,audit,/canonical operation/);
    report.ready=true;await put(s,ready.output+'/verification-report.json',report);
    await put(s,'phase.json',{});
    const approve=await packet(s,'approve',{verificationInput:'verification-input.json',verificationReport:ready.output+'/verification-report.json',checkpoint},{verificationReport:ready.output+'/verification-report.json',phaseDecision:'phase.json'});
    const p=await s.read('task-packet.json');const decision={id:'handoff',kind:'phase-continuation',scopeId:p.scopeId,taskId:p.task.id,choice:'approve',rationale:'Reviewed parity',userResponse:'Approve handoff',at:new Date(Date.now()-1000).toISOString(),inputs:p.inputs};
    approve.outputs.find(o=>o.role==='phaseDecision').sha256=(await put(s,'phase.json',decision)).sha256;await valid(s,approve);
    decision.inputs=decision.inputs.slice(1);approve.outputs.find(o=>o.role==='phaseDecision').sha256=(await put(s,'phase.json',decision)).sha256;await invalid(s,approve,/Decision inputs/);
    decision.inputs=p.inputs;decision.userResponse=' ';approve.outputs.find(o=>o.role==='phaseDecision').sha256=(await put(s,'phase.json',decision)).sha256;await invalid(s,approve,/Decision/);
    audit.outputs[0].sha256=(await descriptor(s,ready.output+'/verification-report.json')).sha256;
    await transitionExecutionState(s.state,journal.sha256,state=>state);
    await invalid(s,audit,/verification-checkpoint-stale/);
  }finally{await s.cleanup();}
});

test('execution requires every batch, current head and new receipt provenance; old task reuse is read-only',async()=>{
  const s=await executionFixture();try{
    s.request.taskId='content.execute';await s.save();const before=await readExecutionState(s.state), reviews=[],receipts=[];
    for(const [i,batch] of s.batchPlan.batches.entries()){
      s.request.batchId=batch.batchId;delete s.request.approval;delete s.request.review;
      const a=await s.authorize(),r=await s.receipt(a);await s.finish(a,r);reviews.push(a.output+'/execution-review.json');receipts.push((await put(s,`receipt-${i}.json`,r)).path);
      for(const row of r.results)for(const q of s.evidence.queries)if(q.value.toLowerCase()===(q.lookup==='id'?row.targetItemId:row.targetPath).toLowerCase()){q.exists=true;q.item=structuredClone(row.post);}
    }
    const current=await readExecutionState(s.state);
    const input=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+before.head.path},{checkpoint:'journal/'+current.head.path,executionReview:reviews,executionReceipt:receipts});
    await valid(s,input);await invalid(s,{...input,outputs:input.outputs.filter(o=>o.role!=='executionReceipt')},/New journal successes/);
    await invalid(s,{...input,outputs:input.outputs.filter(o=>o.role==='checkpoint')},/No review covers/);
    const reused=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+current.head.path},{checkpoint:'journal/'+current.head.path,executionReview:reviews});await valid(s,reused);
    // A resumed task may present a fresh no-op review without reusing approval for writes.
    const noops=[];
    for(const batch of s.batchPlan.batches){s.request.batchId=batch.batchId;delete s.request.approval;delete s.request.review;const review=await s.prepare();assert.equal(review.operationCount,0);noops.push(review.output+'/execution-review.json');}
    const noop=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+current.head.path},{checkpoint:'journal/'+current.head.path,executionReview:noops});await valid(s,noop);
    assert.equal((await readExecutionState(s.state)).sha256,current.sha256);
  }finally{await s.cleanup();}
});

test('CLI writes an exclusive report and distinguishes invalid evidence from malformed input',async()=>{
  const s=await setup();try{
    await s.run();const input=await packet(s,'transform',{transformInput:'transform.json'},{itemPlan:'output/item-plan.json',identityMap:'output/proposed-identity-map.json',transformReport:'output/transform-report.json'});
    const cli=fileURLToPath(new URL('../scripts/validate-mapped-outcome.mjs',import.meta.url));
    await put(s,'outcome.json',input);const run=spawnSync(process.execPath,[cli,'--input',join(s.dir,'outcome.json'),'--output',join(s.dir,'postflight')],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
    const entityFiles=(await readdir(join(s.dir,'postflight'))).filter(p=>p.startsWith('entity-result-'));assert.equal(entityFiles.length,1);
    const entity=JSON.parse(await readFile(join(s.dir,'postflight',entityFiles[0]),'utf8'));await validateCMS('entity-result',entity);assert.equal(entity.outcome,'success');assert.equal(entity.entityId,`mapped-content-operation:${s.binding.scopeId}:transform`);assert.deepEqual(entity.changedFiles,[]);assert.equal(entity.checkpoint,null);assert.deepEqual(entity.decisionIds,[]);
    input.outputs.pop();await put(s,'outcome.json',input);assert.equal(spawnSync(process.execPath,[cli,'--input',join(s.dir,'outcome.json'),'--output',join(s.dir,'invalid')]).status,2);
    assert.deepEqual(await readdir(join(s.dir,'invalid')),['mapped-outcome-report.json']);
    await put(s,'outcome.json',{...input,result:{valid:true}});assert.equal(spawnSync(process.execPath,[cli,'--input',join(s.dir,'outcome.json'),'--output',join(s.dir,'malformed')]).status,1);
  }finally{await s.cleanup();}
});

test('historical receipts from another task support reuse but cannot authorize current-task new writes',async()=>{
  const s=await executionFixture({batchSize:100});try{
    const before=await readExecutionState(s.state), a=await s.authorize(), r=await s.receipt(a);await s.finish(a,r);
    const current=await readExecutionState(s.state);await put(s,'historical-receipt.json',r);
    const outputs={checkpoint:'journal/'+current.head.path,executionReview:a.output+'/execution-review.json',executionReceipt:'historical-receipt.json'};
    const old=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+before.head.path},outputs);
    await invalid(s,old,/Historical approval/);
    const reused=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+current.head.path},outputs);await valid(s,reused);
  }finally{await s.cleanup();}
});

test('reference planning and execution retain operation kind and current checkpoint binding',async()=>{
  const s=await referenceFixture({batchSize:100});try{
    await s.selectReferences();
    const planning=await packet(s,'reference-plan',{referencePlanInput:'reference-input.json',checkpoint:s.referenceInput.checkpoint.path},{batchPlan:'reference-plan/batch-plan.json',dryRun:'reference-plan/dry-run.json',referenceReport:'reference-plan/reference-report.json'});await valid(s,planning);
    const before=await readExecutionState(s.state);s.request.taskId='content.reference-execute';const a=await s.authorize(),r=await s.referenceReceipt(a);await s.finish(a,r);await put(s,'reference-receipt.json',r);
    const current=await readExecutionState(s.state), execution=await packet(s,'reference-execute',{executionInput:'execution-input.json',checkpoint:'journal/'+before.head.path},{checkpoint:'journal/'+current.head.path,executionReview:a.output+'/execution-review.json',executionReceipt:'reference-receipt.json'});await valid(s,execution);
    s.request.operationKind='content';await s.save();
    const wrong=await packet(s,'reference-execute',{executionInput:'execution-input.json',checkpoint:'journal/'+before.head.path},{checkpoint:'journal/'+current.head.path,executionReview:a.output+'/execution-review.json',executionReceipt:'reference-receipt.json'});await invalid(s,wrong,/operation kind/);
  }finally{await s.cleanup();}
});

test('completed execution retains its immutable output after later successful journal progress, while partial effects invalidate it',async()=>{
  const s=await executionFixture({batchSize:100});try{
    s.request.taskId='content.execute';const before=await readExecutionState(s.state),a=await s.authorize(),r=await s.receipt(a);await s.finish(a,r);await put(s,'content-receipt.json',r);
    const completed=await readExecutionState(s.state);
    const input=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+before.head.path},{checkpoint:'journal/'+completed.head.path,executionReview:a.output+'/execution-review.json',executionReceipt:'content-receipt.json'});
    input.packet=await put(s,'completed-task-packet.json',await s.read('task-packet.json'));
    await valid(s,input);
    const noop=await transitionExecutionState(s.state,completed.sha256,state=>state);await valid(s,input);
    const advanced=await transitionExecutionState(s.state,noop.sha256,state=>{
      const prior=state.operations.at(-1);
      state.operations.push({...structuredClone(prior),operationId:'op-'+ 'e'.repeat(24),operationKind:'references',requestId:'exec-'+ 'e'.repeat(24),batchPlanSha256:'e'.repeat(64),batchId:'later-reference-batch'});
      return state;
    });
    await valid(s,input);
    const live=await readExecutionState(s.state);
    const inverted=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:'journal/'+live.head.path},{checkpoint:'journal/'+completed.head.path,executionReview:a.output+'/execution-review.json',executionReceipt:'content-receipt.json'});
    await invalid(s,inverted,/ancestor of the output/);
    await transitionExecutionState(s.state,advanced.sha256,state=>{const prior=state.operations.at(-1);state.operations.push({...structuredClone(prior),status:'failed',mutated:true,requestId:'exec-'+'f'.repeat(24)});return state;});
    await invalid(s,input,/Latest target item operation/);
  }finally{await s.cleanup();}
});

test('canonical all-reuse content plans complete without selecting a batch or fabricating execution evidence',async()=>{
  const s=await executionFixture({update:true,batchSize:100});try{
    delete s.request.batchId;await assert.rejects(s.prepare(),/Select exactly one existing reviewed batch/);
    const itemPlan=await s.read('output/item-plan.json');
    const actual=[...itemPlan.items.map(i=>({id:i.identity.targetItemId,path:i.identity.targetPath,templateId:i.templateId,versionsComplete:true,versions:i.versions,fields:i.fields.map(f=>({...f,present:true}))})),...itemPlan.structures.map(i=>({id:i.targetItemId,path:i.targetPath,templateId:i.templateId,versionsComplete:true,versions:[],fields:[]}))];
    for(const query of s.evidence.queries){const item=actual.find(i=>(query.lookup==='id'?i.id:i.path)===query.value);if(item){query.exists=true;query.item=structuredClone(item);}}
    const planRequest=await s.read('plan-input.json');planRequest.targetState=await put(s,'all-reused-target.json',s.evidence);s.request.planInput=await put(s,'all-reused-plan.json',planRequest);
    const planned=await planContent(join(s.dir,'all-reused-plan.json'),join(s.dir,'all-reused-plan'));assert.equal(planned.ready,true);assert.equal(planned.batchCount,0);
    s.request.taskId='content.execute';s.request.batchPlan=await descriptor(s,'all-reused-plan/batch-plan.json');s.request.dryRun=await descriptor(s,'all-reused-plan/dry-run.json');delete s.request.batchId;await s.save();
    assert.equal(Object.hasOwn(await s.read('execution-input.json'),'batchId'),false);
    const checkpoint=await readExecutionState(s.state),path='journal/'+checkpoint.head.path;
    const input=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:path},{checkpoint:path});await valid(s,input);
    assert.equal((await readExecutionState(s.state)).sha256,checkpoint.sha256);
    const changed=await transitionExecutionState(s.state,checkpoint.sha256,state=>state);
    const live=await readExecutionState(s.state),mutated=await packet(s,'execute',{executionInput:'execution-input.json',checkpoint:path},{checkpoint:'journal/'+live.head.path});await invalid(s,mutated,/unchanged input checkpoint/);
    assert.ok(changed.sha256);
  }finally{await s.cleanup();}
});

test('already-correct reference plans complete with unchanged checkpoint and no fake batch, review or receipt',async()=>{
  const s=await referenceFixture({batchSize:100});try{
    await s.selectReferences();const a=await s.authorize(),receipt=await s.referenceReceipt(a);await s.finish(a,receipt);s.publishActual(receipt);
    const checkpoint=await readExecutionState(s.state),path='journal/'+checkpoint.head.path;s.referenceInput.checkpoint={path,sha256:checkpoint.sha256};
    const planned=await s.planReferences('already-correct-references');assert.equal(planned.ready,true);assert.equal(planned.batchCount,0);
    s.request.planInput=await descriptor(s,'reference-input.json');s.request.batchPlan=await descriptor(s,'already-correct-references/batch-plan.json');s.request.dryRun=await descriptor(s,'already-correct-references/dry-run.json');s.request.taskId='content.reference-execute';delete s.request.batchId;delete s.request.approval;delete s.request.review;await s.save();
    const input=await packet(s,'reference-execute',{executionInput:'execution-input.json',checkpoint:path},{checkpoint:path});await valid(s,input);
    assert.equal((await readExecutionState(s.state)).sha256,checkpoint.sha256);
    input.outputs.push({role:'executionReview',...await descriptor(s,a.output+'/execution-review.json')});await invalid(s,input,/must not fabricate/);
  }finally{await s.cleanup();}
});
