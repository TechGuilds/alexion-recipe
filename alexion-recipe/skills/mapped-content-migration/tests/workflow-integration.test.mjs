import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildContentWorkflow,prepareContentWorkflow} from '../scripts/prepare-content-workflow.mjs';
import {hash,jsonBytes} from '../scripts/lib/files.mjs';
import {validateWorkflowPlan} from '../../cms-migration/scripts/validate-workflow-plan.mjs';
import {materializeApprovedWorkflow} from '../../cms-migration/scripts/materialize-approved-workflow.mjs';
import {nextWork} from '../../cms-migration/scripts/next-work.mjs';

async function fixture(t){
 const parent=tmpdir();const base=await mkdtemp(join(parent,'workflow-integration-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const put=async(path,value)=>{const bytes=jsonBytes(value);await writeFile(join(base,path),bytes);return {path,sha256:hash(bytes)};};
 const active={version:1,phases:[{id:'setup',title:'Setup',tasks:[{id:'setup.audit',title:'Audit',dependsOn:[],status:'skipped'}]},{id:'discovery',title:'Discovery',tasks:[{id:'discovery.plan',title:'Plan',dependsOn:['setup.audit'],status:'running',agent:'orchestrator'}]}]};
 const evidence=[await put('evidence.json',{evidence:'current'})];
 const decision=(kind,choice)=>({id:kind+'-decision',kind,scopeId:'demo',choice,rationale:'User reviewed scope',userResponse:'Approved',at:'2026-01-01T00:00:00Z',inputs:evidence});
 const inventory={version:1,scopeId:'demo',entities:[{id:'original',kind:'discovery',source:{identity:'original',path:'evidence.json'},scope:'included',parentIds:[],routeIds:[],joins:[],uncertainty:[]}]};
 const input={version:1,scopeId:'demo',activeWorkflow:await put('active.json',active),inventory:await put('inventory.json',inventory),mappings:await put('mappings.json',[{entityId:'original',taskId:'discovery.plan'}]),planningTaskId:'discovery.plan',evidence,modeDecision:await put('mode.json',decision('scope','mapped-content')),mappingDecision:await put('mapping.json',decision('mapping','approve')),mediaDecision:await put('media.json',{...decision('scope','skip-media'),id:'media-decision',taskId:'discovery.plan'})};
 return {base,put,active,input,decision};
}

test('proposal composes with approval, materialization, resume and the human verification frontier',async t=>{
 const f=await fixture(t),before=await readFile(join(f.base,'active.json'),'utf8');const result=await buildContentWorkflow(f.input,{base:f.base});
 assert.equal(result.report.ready,true);assert.equal(result.proposal.phases.length,3);assert.equal(result.proposal.phases[2].tasks.length,8);assert.equal(result.proposal.phases[2].tasks.at(-1).id,'content.approve');assert.deepEqual(result.proposal.phases[2].tasks[0].dependsOn,['discovery.plan']);assert.equal(JSON.stringify(result.proposal).includes('"status"'),false);
 assert.equal(result.inventory.entities.length,9);assert.deepEqual(result.inventory.entities[0],JSON.parse(await readFile(join(f.base,'inventory.json'),'utf8')).entities[0]);
 const proposal=await f.put('proposal.json',result.proposal),approval={...f.decision('workflow-plan','approve'),inputs:[proposal,...f.input.evidence]};
 const review=await validateWorkflowPlan({version:1,scopeId:'demo',proposal,evidence:f.input.evidence,decisions:[approval]},{base:f.base});assert.equal(review.valid,true);
 const unapproved=await validateWorkflowPlan({version:1,scopeId:'demo',proposal,evidence:f.input.evidence,decisions:[]},{base:f.base});assert.equal(unapproved.valid,false);
 const promoted=await materializeApprovedWorkflow({version:1,proposal,activeWorkflow:f.input.activeWorkflow,planningTaskId:f.input.planningTaskId},{base:f.base});assert.equal(promoted.valid,true);assert.equal(promoted.workflow.phases[0].tasks[0].status,'skipped');assert.equal(promoted.workflow.phases[2].tasks[0].status,'pending');
 let frontier=await nextWork({version:1,workflow:promoted.workflow,inventory:result.inventory,mappings:result.mappings});assert.equal(frontier.next[0].taskId,'content.capture');
 promoted.workflow.phases[2].tasks[0].status='done';
 frontier=await nextWork({version:1,workflow:promoted.workflow,inventory:result.inventory,mappings:result.mappings});assert.equal(frontier.starved.some(item=>item.reason==='user-verification'&&item.blockedBy.some(blocker=>blocker.taskId==='content.capture')),true);assert.equal(frontier.next.length,0);
 const resume={...f.input,activeWorkflow:await f.put('resume.json',promoted.workflow),inventory:await f.put('resume-inventory.json',result.inventory),mappings:await f.put('resume-mappings.json',result.mappings)};
 const resumed=await buildContentWorkflow(resume,{base:f.base});assert.deepEqual(resumed.proposal,result.proposal);assert.deepEqual(resumed.inventory,result.inventory);assert.deepEqual(resumed.mappings,result.mappings);assert.equal(await readFile(join(f.base,'active.json'),'utf8'),before);
});

test('fails closed for invalid decisions, scope, evidence, prerequisites, conflicts and collisions',async t=>{
 const f=await fixture(t);
 for(const change of [{scopeId:'other'},{kind:'mapping'},{choice:'code'},{userResponse:' '},{at:'2099-01-01T00:00:00Z'},{at:'invalid'},{inputs:[{path:'other.json',sha256:'0'.repeat(64)}]}]){
  const modeDecision=await f.put('bad-mode.json',{...f.decision('scope','mapped-content'),...change});await assert.rejects(()=>buildContentWorkflow({...f.input,modeDecision},{base:f.base}));
 }
 await assert.rejects(()=>buildContentWorkflow({...f.input,planningTaskId:'missing'},{base:f.base}),/absent/);
 const blocked=structuredClone(f.active);blocked.phases[0].tasks[0].status='pending';await assert.rejects(async()=>buildContentWorkflow({...f.input,activeWorkflow:await f.put('blocked.json',blocked)},{base:f.base}),/terminal/);
 const conflict=structuredClone(f.active);conflict.phases.push({id:'sxa',title:'SXA',tasks:[{id:'sxa.migrate',title:'Migrate',dependsOn:['discovery.plan'],status:'pending'}]});await assert.rejects(async()=>buildContentWorkflow({...f.input,activeWorkflow:await f.put('conflict.json',conflict)},{base:f.base}),/conflicts/);
 const result=await buildContentWorkflow(f.input,{base:f.base}),collision=structuredClone(result.inventory);collision.entities.at(-1).kind='unrelated';await assert.rejects(async()=>buildContentWorkflow({...f.input,inventory:await f.put('collision.json',collision)},{base:f.base}),/collision/);
 await writeFile(join(f.base,'evidence.json'),'changed');await assert.rejects(()=>buildContentWorkflow(f.input,{base:f.base}),/SHA-256/);
});

test('publishes fresh output only and fingerprints exact emitted documents',async t=>{
 const f=await fixture(t),input=await f.put('input.json',f.input),output=join(f.base,'output');const report=await prepareContentWorkflow(join(f.base,input.path),output);
 for(const [name,key] of [['workflow-proposal.json','proposalSha256'],['inventory.json','inventorySha256'],['task-mappings.json','mappingsSha256']])assert.equal(hash(await readFile(join(output,name))),report[key]);
 await assert.rejects(()=>prepareContentWorkflow(join(f.base,input.path),output),/exist/i);
});

test('rejects malformed resumes and mapping/path identity conflicts without mutating active state',async t=>{
 const f=await fixture(t),result=await buildContentWorkflow(f.input,{base:f.base});
 const resumed={...structuredClone(result.proposal),phases:result.proposal.phases.map(phase=>({...phase,tasks:phase.tasks.map(task=>({...task,status:'pending'}))}))};
 resumed.phases[0].tasks[0].status='skipped';resumed.phases[2].tasks[0].title='Altered capture';
 const activeWorkflow=await f.put('bad-resume.json',resumed);await assert.rejects(()=>buildContentWorkflow({...f.input,activeWorkflow},{base:f.base}),/canonical/);
 const missingEntity=await f.put('missing-entity.json',[{entityId:'missing',taskId:'discovery.plan'}]);await assert.rejects(()=>buildContentWorkflow({...f.input,mappings:missingEntity},{base:f.base}),/unknown entity/);
 const duplicateMappings=await f.put('duplicate-mappings.json',[{entityId:'original',taskId:'discovery.plan'},{entityId:'original',taskId:'setup.audit'}]);await assert.rejects(()=>buildContentWorkflow({...f.input,mappings:duplicateMappings},{base:f.base}),/Repeated/);
 await assert.rejects(()=>buildContentWorkflow({...f.input,evidence:[{path:'../outside',sha256:'0'.repeat(64)}]},{base:f.base}),/manifest-relative/);
 const mappingDecision=await f.put('reject-mapping.json',f.decision('mapping','reject'));await assert.rejects(()=>buildContentWorkflow({...f.input,mappingDecision},{base:f.base}),/explicit user decision/);
 const unrelated=structuredClone(f.active);unrelated.phases.push({id:'handoff',title:'Handoff',tasks:[{id:'handoff.review',title:'Review',dependsOn:['discovery.plan'],status:'pending'}]});
 const preserved=await buildContentWorkflow({...f.input,activeWorkflow:await f.put('unrelated-phase.json',unrelated)},{base:f.base});assert.equal(preserved.proposal.phases[2].id,'handoff');assert.equal(preserved.proposal.phases[3].id,'content-migration');
});


test('rejects duplicate content-transfer phases even when one uses an alternate ID',async t=>{
 const f=await fixture(t);
 for(const id of ['native-transfer','mapped-content-migration']){
  const active=structuredClone(f.active);
  active.phases.push({id,title:'Content Migration',tasks:[{id:'legacy.transfer',title:'Transfer content',dependsOn:['discovery.plan'],agent:'sitecore-developer',status:'pending'}]});
  const activeWorkflow=await f.put('duplicate-'+id+'.json',active);
  await assert.rejects(()=>buildContentWorkflow({...f.input,activeWorkflow},{base:f.base}),/content.*phase|content.*transfer/i);
 }
});
