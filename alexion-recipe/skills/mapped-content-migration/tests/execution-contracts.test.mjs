import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { validateSchema } from '../scripts/lib/schema.mjs';
import { id } from './fixture-factory.mjs';

test('every public contract wrapper registers with an independent strict validator', async () => {
  const root=new URL('../contracts/',import.meta.url),require=createRequire(new URL('../scripts/lib/schema.mjs',import.meta.url));
  const Ajv=require('ajv/dist/2020.js').default,ajv=new Ajv({allErrors:true,strict:true});
  ajv.addSchema(JSON.parse(await readFile(new URL('definitions.schema.json',root),'utf8')));
  const names=(await readdir(root)).filter(n=>n.endsWith('.schema.json')&&n!=='definitions.schema.json').sort();
  assert.ok(names.includes('execution-review.schema.json'));
  for(const name of names){const schema=JSON.parse(await readFile(new URL(name,root),'utf8'));assert.equal(typeof schema.$ref,'string',name);assert.equal(typeof ajv.compile(schema),'function',name);}
});

function exampleReview(){
  const sha='a'.repeat(64),root='/sitecore/content/Target',marker={id:id(1),templateId:id(2),path:root};
  const observation={id:id(3),templateId:id(4),path:root+'/Page',versionsComplete:true,versions:[{language:'en',version:1}],fields:[]};
  const capabilities={version:1,scopeId:'scope',instanceId:'target',database:'master',rootPath:root,connectorId:'spe',marker,evidence:{path:'capability-evidence.json',sha256:sha},expiresAt:'2099-01-01T00:00:00Z',maxRequestBytes:1048576,maxBackupBytes:1048576,maxJournalBytes:1048576,speRead:true,speWrite:true,fullItemBackup:true,restoreValidated:true,exclusiveWriteWindow:true,fileDownload:true,journalContinuityVerified:true};
  return {version:1,contentMigrationMode:'mapped-content',scopeId:'scope',mappingRevision:'reviewed',taskId:'task',batchPlanSha256:sha,batchId:'batch-0001',scriptSha256:sha,sourceInstanceId:'source',target:{instanceId:'target',database:'master',rootPath:root,connectorId:'spe',marker},structuralLanguage:'en',maxBackupBytes:1048576,maxJournalBytes:1048576,maxRequestBytes:1048576,capabilities,inputs:{planInput:sha,batchPlan:sha,dryRun:sha,targetState:sha,capabilities:sha},checkpointSha256:sha,guards:[{lookup:'id',value:id(3),exists:false},{lookup:'path',value:observation.path,exists:false}],operations:[{operationId:'op-'+'b'.repeat(24),kind:'content',action:'create',targetItemId:id(3),targetPath:observation.path,templateId:id(4),parentItemId:id(1),beforeFingerprint:sha,versionsToCreate:observation.versions,fields:[],dependsOn:[],expectedPost:observation}],knownSuccess:[],templates:[{id:id(4),name:'Content',path:'/sitecore/templates/Test/Content',kind:'content',baseTemplateIds:[id(5)],fields:[]}],identities:[]};
}

test('execution review requires exact declared operations, observations and capability evidence',()=>{
  assert.deepEqual(validateSchema('executionReview',exampleReview()),[]);
  for(const mutate of [r=>{delete r.operations[0].expectedPost;},r=>{delete r.capabilities.journalContinuityVerified;},r=>{delete r.templates[0].baseTemplateIds;},r=>{r.guards[0].exists=true;},r=>{r.templates[0].kind='parameters';},r=>{r.maxRequestBytes=8388609;}]){
    const review=exampleReview();mutate(review);assert.ok(validateSchema('executionReview',review).length);
  }
});

test('checkpoint and event contracts distinguish an unknown job from terminal evidence',()=>{
  const scope={scopeId:'scope',targetInstanceId:'target',database:'master',rootPath:'/sitecore/content/Target',connectorId:'spe'},sha='a'.repeat(64),requestId='exec-'+'b'.repeat(24);
  const checkpoint={version:1,...scope,sequence:0,previousSha256:null,active:null,completedBatches:[],operations:[],identities:[]};
  assert.deepEqual(validateSchema('executionCheckpoint',checkpoint),[]);
  const event={version:1,action:'unknown',checkpointSha256:sha,requestId,connectorId:'spe'};
  assert.deepEqual(validateSchema('executionEvent',event),[]);
  assert.ok(validateSchema('executionEvent',{...event,action:'submitted'}).length);
  assert.ok(validateSchema('executionEvent',{...event,action:'terminal',terminal:true,jobId:'job'}).length);
  assert.ok(validateSchema('executionScope',{...scope,version:1}).length);
});
