import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {setup} from './transform-fixture.mjs';
import {bytes,hash} from './fixture-factory.mjs';
import {prepareTaskPacket} from '../../cms-migration/scripts/prepare-task-packet.mjs';
import {validateEvidence} from '../../cms-migration/scripts/validate-evidence.mjs';

test('native postflight revalidates mapped outputs, emits technical coverage and preserves human verification',async()=>{
 const s=await setup();try{
  await s.run();const put=async(path,value)=>{await writeFile(join(s.dir,path),bytes(value));return {path,sha256:hash(bytes(value))};},descriptor=async path=>({path,sha256:hash(await readFile(join(s.dir,path)))});
  const task={id:'content.transform',title:'Transform mapped content',status:'pending',dependsOn:[],agent:'sitecore-developer'},workflow={version:1,phases:[{id:'content-migration',title:'Content Migration',tasks:[task]}]};
  const entity={id:'mapped-content-operation:'+s.binding.scopeId+':transform',kind:'mapped-content:transform',source:{identity:'transform',path:'transform.json'},scope:'included',parentIds:[],routeIds:[],joins:[],uncertainty:[]};
  const inputs=[await descriptor('transform.json')],mode={id:'mode',kind:'scope',scopeId:s.binding.scopeId,choice:'mapped-content',rationale:'Reviewed mechanism',userResponse:'Use mapped content',at:new Date(Date.now()-1000).toISOString(),inputs};
  const packet=await prepareTaskPacket({scopeId:s.binding.scopeId,taskId:task.id,targetRoot:'repos/target',attemptRoot:'evidence/transform',inventory:{version:1,scopeId:s.binding.scopeId,entities:[entity]},workflow,mappings:[{entityId:entity.id,taskId:task.id}],inputs,acceptance:['Mapped output validates'],contentMigrationDecision:mode,mappedContentInputs:[{role:'transformInput',...inputs[0]}]});
  const request={version:1,packet:await put('packet.json',packet),outputs:await Promise.all([['itemPlan','output/item-plan.json'],['identityMap','output/proposed-identity-map.json'],['transformReport','output/transform-report.json']].map(async([role,path])=>({role,...await descriptor(path)})))};
  await put('outcome-input.json',request);const cli=fileURLToPath(new URL('../scripts/validate-mapped-outcome.mjs',import.meta.url)),run=spawnSync(process.execPath,[cli,'--input',join(s.dir,'outcome-input.json'),'--output',join(s.dir,'domain')],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
  const files=await readdir(join(s.dir,'domain')),entityFile=files.find(f=>f.startsWith('entity-result-'));assert.ok(entityFile);
  const evidence=await Promise.all([['mapped-content-operation','domain/mapped-outcome-report.json'],['entity-result','domain/'+entityFile]].map(async([kind,path])=>({kind,path,role:'target',scopeId:s.binding.scopeId,...(kind==='entity-result'?{entityId:entity.id}:{}),provenance:{producer:'validate-mapped-outcome.mjs',version:'1',...(await descriptor(path)),inputs},observation:'Validated operation outputs',checks:[{name:'Actual domain outputs',passed:true}],unresolved:[]})));
  // Provenance uses the evidence's path field, not an extra nested descriptor path.
  for(const record of evidence)delete record.provenance.path;
  const result={taskId:task.id,outcome:'success',summary:'Transformed mapped content',evidence,changedFiles:[],checkpoint:null,unresolved:[]};await put('result.json',result);task.status='done';
  const input={workflow,scopeId:s.binding.scopeId,inputs,results:['result.json'],decisions:[],requiredTaskIds:[task.id],requiredEvidenceKindsByTask:{[task.id]:['mapped-content-operation']}};
  const valid=await validateEvidence(input,{base:s.dir,taskScoped:true});assert.equal(valid.valid,true,JSON.stringify(valid.errors));assert.equal(valid.verifiedEntityMappings[0].entityId,entity.id);assert.equal(valid.entityAttestations[0].status,'unattested');
  const refs=[await descriptor('result.json'),...evidence.map(e=>({path:e.path,sha256:e.provenance.sha256}))];input.decisions=[{id:'human-review',kind:'verification',scopeId:s.binding.scopeId,taskId:task.id,entityId:entity.id,choice:'verified',rationale:'Reviewed outputs',userResponse:'Verified',at:new Date(Date.now()-1000).toISOString(),inputs:refs}];
  const attested=await validateEvidence(input,{base:s.dir,taskScoped:true});assert.equal(attested.valid,true);assert.equal(attested.entityAttestations[0].status,'attested');
  const altered=JSON.parse(await readFile(join(s.dir,'output/transform-report.json'),'utf8'));altered.ready=false;await put('output/transform-report.json',altered);
  const domain=JSON.parse(await readFile(join(s.dir,'domain/mapped-outcome-report.json'),'utf8'));domain.valid=true;domain.outputs.find(o=>o.role==='transformReport').sha256=(await descriptor('output/transform-report.json')).sha256;await put('domain/mapped-outcome-report.json',domain);
  result.evidence[0].provenance.sha256=(await descriptor('domain/mapped-outcome-report.json')).sha256;await put('result.json',result);
  const forged=await validateEvidence(input,{base:s.dir,taskScoped:true});assert.equal(forged.valid,false);assert.ok(forged.errors.some(e=>e.includes('Mapped-content operation outputs')));
 }finally{await s.cleanup();}
});
