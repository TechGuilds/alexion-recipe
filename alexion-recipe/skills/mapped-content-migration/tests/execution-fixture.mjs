import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup} from './transform-fixture.mjs';
import {bytes,hash} from './fixture-factory.mjs';
import {planContent} from '../scripts/plan-content.mjs';
import {prepareExecution} from '../scripts/prepare-execution.mjs';
import {initializeExecutionState,readExecutionState} from '../scripts/lib/execution-state.mjs';
import {recordExecution} from '../scripts/record-execution.mjs';

export async function executionFixture(options={}){
  const s=await setup(d=>{if(options.update)for(const rule of d.destinationPlan.rules)rule.existingItem='update';if(options.overlap||options.sameInstance)d.targetInventory.instanceId=d.sourceSnapshot.instanceId;if(options.overlap)d.sourceSnapshot.rootPaths=['/sitecore/content'];options.change?.(d);});await s.run();let counter=0;
  s.put=async(path,value)=>{await writeFile(join(s.dir,path),bytes(value));return {path,sha256:hash(bytes(value))};};
  s.read=async path=>JSON.parse(await readFile(join(s.dir,path),'utf8'));
  const itemPlan=await s.read('output/item-plan.json');
  const nodes=[...itemPlan.items.map(i=>({id:i.identity.targetItemId,path:i.identity.targetPath})),...itemPlan.structures.map(i=>({id:i.targetItemId,path:i.targetPath}))];
  s.evidence={version:1,scopeId:s.binding.scopeId,instanceId:s.d.targetInventory.instanceId,database:s.d.targetInventory.database,capturedAt:new Date().toISOString(),targetStateId:'execution-current',rootPath:s.d.destinationPlan.targetRootPath,valueMode:'effective',queries:[]};
  for(const n of nodes)s.evidence.queries.push({lookup:'id',value:n.id,exists:false},{lookup:'path',value:n.path,exists:false});
  const parents=new Set([s.evidence.rootPath,...nodes.map(n=>n.path.slice(0,n.path.lastIndexOf('/'))).filter(p=>!nodes.some(n=>n.path===p))]);
  for(const path of parents){const actual=s.d.targetInventory.items.find(i=>i.path===path);if(!actual)throw Error('Missing fixture parent '+path);s.evidence.queries.push({lookup:'path',value:path,exists:true,item:{...actual,versionsComplete:true,versions:[],fields:[]}});}
  if(options.update){const item=itemPlan.items.find(i=>i.fields.length);const actual={id:item.identity.targetItemId,path:item.identity.targetPath,templateId:item.templateId,versionsComplete:true,versions:item.versions,fields:item.fields.map(f=>({...f,present:true,value:'old'}))};for(const q of s.evidence.queries)if(q.value===actual.id||q.value===actual.path){q.exists=true;q.item=actual;}}
  const p={version:1,maxItemsPerBatch:options.batchSize??2,maxBatchBytes:8192};
  for(const [key,path]of Object.entries({transformInput:'transform.json',itemPlan:'output/item-plan.json',identityMap:'output/proposed-identity-map.json',transformReport:'output/transform-report.json'}))p[key]={path,sha256:hash(await readFile(join(s.dir,path)))};
  p.targetState=await s.put('baseline.json',s.evidence);const planInput=await s.put('plan-input.json',p);
  await planContent(join(s.dir,'plan-input.json'),join(s.dir,'dry-run'));s.batchPlan=await s.read('dry-run/batch-plan.json');
  const root=s.evidence.queries.find(q=>q.value===s.evidence.rootPath).item;
  s.cap={version:1,scopeId:s.binding.scopeId,instanceId:s.evidence.instanceId,database:s.evidence.database,rootPath:s.evidence.rootPath,connectorId:'verified-target',marker:{id:root.id,path:root.path,templateId:root.templateId},speRead:true,speWrite:true,fullItemBackup:true,restoreValidated:true,exclusiveWriteWindow:true,fileDownload:true,journalContinuityVerified:true,expiresAt:new Date(Date.now()+3600000).toISOString(),maxBackupBytes:1048576,maxJournalBytes:8388608,maxRequestBytes:8388608,evidence:await s.put('capability-proof.json',{synthetic:true})};
  s.request={version:1,contentMigrationMode:'mapped-content',taskId:'content-write',planInput,batchPlan:{path:'dry-run/batch-plan.json',sha256:hash(await readFile(join(s.dir,'dry-run/batch-plan.json')))},dryRun:{path:'dry-run/dry-run.json',sha256:hash(await readFile(join(s.dir,'dry-run/dry-run.json')))},batchId:s.batchPlan.batches[0].batchId,structuralLanguage:s.d.sourceSnapshot.languages[0]};
  if(options.update)s.request.batchId=s.batchPlan.batches.find(b=>b.operations.some(o=>o.action==='update')).batchId;
  s.state=join(s.dir,'journal');await initializeExecutionState(s.state,{scopeId:s.binding.scopeId,targetInstanceId:s.evidence.instanceId,database:s.evidence.database,rootPath:s.evidence.rootPath,connectorId:s.cap.connectorId});
  s.save=async()=>{s.request.targetState=await s.put('current.json',s.evidence);s.request.capabilities=await s.put('capabilities.json',s.cap);await s.put('execution-input.json',s.request);};
  s.prepare=async()=>{await s.save();const output='exec-'+(++counter);const result=await prepareExecution(join(s.dir,'execution-input.json'),join(s.dir,output),s.state);return {...result,output};};
  s.authorize=async()=>{const review=await s.prepare();s.request.review={path:review.output+'/execution-review.json',sha256:review.review.sha256};s.request.approval=await s.put('approval.json',{id:'approval-1',kind:'mutation',scopeId:s.binding.scopeId,taskId:s.request.taskId,choice:'approve',rationale:'Reviewed synthetic batch',userResponse:'Approve this batch',at:new Date(Date.now()-1000).toISOString(),inputs:[s.request.review]});return s.prepare();};
  s.event=async(action,extra={})=>{const j=await readExecutionState(s.state);const value={version:1,action,checkpointSha256:j.sha256,requestId:j.checkpoint.active?.requestId,connectorId:s.cap.connectorId,...extra};await s.put('event.json',value);return recordExecution(join(s.dir,'event.json'),s.state);};
  s.receipt=async authorized=>{const core=await s.read(authorized.output+'/execution-review.json');return {version:1,kind:'mapped-content-execution',requestId:authorized.requestId,reviewSha256:authorized.review.sha256,scopeId:core.scopeId,taskId:core.taskId,batchPlanSha256:core.batchPlanSha256,batchId:core.batchId,target:core.target,terminal:true,status:'success',backups:[],results:core.operations.map(o=>({operationId:o.operationId,targetItemId:o.targetItemId,targetPath:o.targetPath,templateId:o.templateId,status:'success',mutated:true,post:o.expectedPost})),reused:core.knownSuccess,journal:{path:'kajoo/mapped-content/executions/'+hash(core.target.database.toLowerCase()+'|'+core.target.rootPath.toLowerCase())+'/'+authorized.requestId+'/journal.jsonl',sha256:'a'.repeat(64),bytes:100}};};
  s.finish=async(authorized,receipt)=>{await s.event('submitted',{jobId:'job-'+counter});return s.event('terminal',{jobId:'job-'+counter,terminal:true,review:{path:authorized.output+'/execution-review.json',sha256:authorized.review.sha256},receipt:await s.put('receipt.json',receipt)});};
  return s;
}
