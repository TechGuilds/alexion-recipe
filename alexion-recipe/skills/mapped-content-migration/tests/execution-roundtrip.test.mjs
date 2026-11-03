import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {executionFixture} from './execution-fixture.mjs';
import {readExecutionState} from '../scripts/lib/execution-state.mjs';
import {validateSchema} from '../scripts/lib/schema.mjs';

for(const update of [false,true])test(`generated approved ${update?'update':'create'} envelope runs in synthetic SPE and its actual receipt reconciles`,async()=>{
 const s=await executionFixture({batchSize:1,update});try{
  const a=await s.authorize(),envelope=await s.read(a.output+'/target-request.json'),core=envelope.parameters.Request.core;
  const items=core.guards.filter(q=>q.exists).map(q=>q.item).filter((item,i,rows)=>rows.findIndex(r=>r.id===item.id)===i).flatMap(item=>(item.versions.length?item.versions:[{language:core.structuralLanguage,version:0}]).map(v=>({...item,...v,fields:item.fields})));
  for(const template of core.templates)items.push({id:template.id,templateId:template.id,path:template.path,language:core.structuralLanguage,version:1,fields:[]});
  await s.put('remote-fixture.json',{request:envelope.parameters.Request,script:envelope.script,items,dataRoot:join(s.dir,'server-data')});
  const result=spawnSync(process.env.PWSH_EXE??'pwsh',['-NoProfile','-File',fileURLToPath(new URL('./fixtures/target-harness.ps1',import.meta.url)),'-InputPath',join(s.dir,'remote-fixture.json'),'-OutputPath',join(s.dir,'remote-output.json')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const remote=await s.read('remote-output.json');assert.equal(remote.receipt?.status,'success',JSON.stringify(remote));assert.deepEqual(validateSchema('executionReceipt',remote.receipt),[]);
  const recorded=await s.finish(a,remote.receipt);assert.equal(recorded.status,'success');const journal=await readExecutionState(s.state);assert.equal(journal.checkpoint.active,null);assert.ok(journal.checkpoint.identities.length);assert.ok(journal.checkpoint.identities.every(i=>i.status==='success'));
 }finally{await s.cleanup();}
});
