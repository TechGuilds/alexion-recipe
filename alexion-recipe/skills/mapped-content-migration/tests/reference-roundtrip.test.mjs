import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {referenceFixture} from './reference-fixture.mjs';
import {readExecutionState} from '../scripts/lib/execution-state.mjs';

for(const media of [false,true])test(`generated ${media?'external media':'mapped list'} reference request executes and reconciles actual synthetic receipt`,async()=>{
 const s=await referenceFixture({media,batchSize:1});try{
  assert.equal((await s.selectReferences()).ready,true);const a=await s.authorize(),envelope=await s.read(a.output+'/target-request.json'),core=envelope.parameters.Request.core;
  const observations=[...core.guards,...core.referenceGuards].filter(q=>q.exists).map(q=>q.item),items=observations.filter((item,i,rows)=>rows.findIndex(r=>r.id.toLowerCase()===item.id.toLowerCase())===i).flatMap(item=>(item.versions.length?item.versions:[{language:core.structuralLanguage,version:0}]).map(v=>({...item,...v})));
  for(const template of core.templates)items.push({id:template.id,templateId:template.id,path:template.path,language:core.structuralLanguage,version:1,fields:[]});
  await s.put('remote-fixture.json',{request:envelope.parameters.Request,script:envelope.script,items,dataRoot:join(s.dir,'reference-server')});
  const process=spawnSync(globalThis.process.env.PWSH_EXE??'pwsh',['-NoProfile','-File',fileURLToPath(new URL('./fixtures/target-harness.ps1',import.meta.url)),'-InputPath',join(s.dir,'remote-fixture.json'),'-OutputPath',join(s.dir,'remote-output.json')],{encoding:'utf8'});assert.equal(process.status,0,process.stderr);
  const remote=await s.read('remote-output.json');assert.equal(remote.receipt?.status,'success',JSON.stringify(remote));assert.equal(remote.exports,1);const recorded=await s.finish(a,remote.receipt);assert.equal(recorded.status,'success');assert.ok((await readExecutionState(s.state)).checkpoint.operations.some(o=>o.operationKind==='references'&&o.status==='success'));
 }finally{await s.cleanup();}
});
