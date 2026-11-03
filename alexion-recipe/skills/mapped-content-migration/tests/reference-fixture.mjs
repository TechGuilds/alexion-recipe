import {executionFixture} from './execution-fixture.mjs';
import {readExecutionState} from '../scripts/lib/execution-state.mjs';
import {fieldKey} from '../scripts/lib/snapshot.mjs';
import {planReferences} from '../scripts/plan-references.mjs';
import {join} from 'node:path';
import {id} from './fixture-factory.mjs';

export async function referenceFixture(options={}){
 const s=await executionFixture({batchSize:options.batchSize??2,change:d=>{
  const source=d.sourceSnapshot.items[0],other=d.sourceSnapshot.items[1],group=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===source.templateId)),mapping=group.fields.find(f=>f.action==='map'),field=source.fields.find(f=>f.fieldId===mapping.sfid);
  const type=options.media?'Image':'Multilist';field.fieldType=type;field.value=options.media?'<image mediaid="'+id(900)+'" alt="Keep &amp; preserve" />':other.id+'|'+other.id;
  for(const template of d.targetInventory.templates)for(const f of template.fields)if(f.id===mapping.tfid)f.type=type;
  source.references.push({fieldId:field.fieldId,kind:options.media?'media':'list',language:field.language,version:field.version,targetSourceIds:options.media?[id(900)]:[other.id,other.id]});
  if(options.media){const existing={sourceItemId:id(900),targetItemId:id(901),targetPath:'/sitecore/media library/Approved/Image',templateId:id(902)};d.destinationPlan.existingReferenceTargets=[existing];d.targetInventory.rootPaths.push('/sitecore/media library');d.targetInventory.items.push({id:existing.targetItemId,path:existing.targetPath,templateId:existing.templateId});}
  else d.destinationPlan.referenceRules.push({sourceTemplateId:source.templateId,sourceFieldId:field.fieldId,targetOutputKey:d.destinationPlan.rules.find(r=>r.sourceTemplateId===other.templateId&&r.kind!=='parameters').outputKey});
  options.change?.(d);
 }});
 s.publishActual=receipt=>{for(const row of receipt.results.filter(r=>r.status==='success'))for(const query of s.evidence.queries)if(query.value.toLowerCase()===(query.lookup==='id'?row.targetItemId:row.targetPath).toLowerCase()){query.exists=true;query.item=structuredClone(row.post);}};
 if(options.complete!==false)for(const batch of s.batchPlan.batches){s.request.batchId=batch.batchId;delete s.request.approval;delete s.request.review;const a=await s.authorize(),receipt=await s.receipt(a);await s.finish(a,receipt);s.publishActual(receipt);}
 const report=await s.read('output/transform-report.json'),itemPlan=await s.read('output/item-plan.json');s.dependencies=report.referenceDependencies;
 for(const ref of report.referenceDependencies)for(const query of s.evidence.queries.filter(q=>q.exists&&q.item.id.toLowerCase()===ref.owner.targetItemId.toLowerCase())){
  const definition=itemPlan.items.find(i=>i.identity.targetItemId===ref.owner.targetItemId).fields.find(f=>fieldKey(f)===fieldKey(ref));
  if(!query.item.fields.some(f=>fieldKey(f)===fieldKey(definition)))query.item.fields.push({...definition,present:true,value:''});
 }
 const checkpoint=await readExecutionState(s.state);
 s.referenceInput={version:1,contentPlanInput:s.request.planInput,checkpoint:{path:'journal/'+checkpoint.head.path,sha256:checkpoint.sha256},targetState:await s.put('reference-baseline.json',s.evidence),maxItemsPerBatch:options.batchSize??2,maxBatchBytes:8192};
 if(options.media){const binding=s.d.destinationPlan.existingReferenceTargets[0];s.external={version:1,scopeId:s.binding.scopeId,instanceId:s.evidence.instanceId,database:s.evidence.database,capturedAt:new Date().toISOString(),targetStateId:'external-current',rootPath:'/sitecore',valueMode:'effective',queries:['id','path'].map(lookup=>({lookup,value:lookup==='id'?binding.targetItemId:binding.targetPath,exists:true,item:{id:binding.targetItemId,path:binding.targetPath,templateId:binding.templateId,versionsComplete:true,versions:[{language:'en',version:1}],fields:[]}}))};s.referenceInput.existingTargetState=await s.put('external-baseline.json',s.external);}
 s.saveReferences=async()=>{s.referenceInput.targetState=await s.put('reference-baseline.json',s.evidence);if(s.external)s.referenceInput.existingTargetState=await s.put('external-baseline.json',s.external);await s.put('reference-input.json',s.referenceInput);};
 s.planReferences=async(name='reference-plan')=>{await s.saveReferences();return planReferences(join(s.dir,'reference-input.json'),join(s.dir,name));};
 s.selectReferences=async()=>{const result=await s.planReferences();if(!result.ready)return result;delete s.request.approval;delete s.request.review;s.request.operationKind='references';s.request.planInput=await s.put('reference-input.json',s.referenceInput);s.request.batchPlan={path:'reference-plan/batch-plan.json',sha256:result.outputs.batchPlan.sha256};s.request.dryRun={path:'reference-plan/dry-run.json',sha256:result.outputs.dryRun.sha256};s.request.batchId=(await s.read('reference-plan/batch-plan.json')).batches[0]?.batchId;if(s.external)s.request.existingTargetState=await s.put('external-current.json',s.external);return result;};
 s.referenceReceipt=async authorized=>{const receipt=await s.receipt(authorized),core=await s.read(authorized.output+'/execution-review.json');receipt.backups=core.operations.map(op=>({operationId:op.operationId,targetItemId:op.targetItemId,files:[{path:receipt.journal.path.replace('journal.jsonl','backups/'+op.operationId+'/item.item'),sha256:'b'.repeat(64),bytes:100}]}));return receipt;};
 return s;
}
