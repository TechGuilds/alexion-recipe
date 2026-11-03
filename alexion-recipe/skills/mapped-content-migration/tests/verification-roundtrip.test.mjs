import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readFile,copyFile} from 'node:fs/promises';
import {verificationFixture} from './verification-fixture.mjs';
import {hash} from './fixture-factory.mjs';

for(const media of [false,true])test(`generated read-only capture independently verifies ${media?'existing media':'mapped content/list'} target data`,async()=>{
 const s=await verificationFixture({media});try{
  const first=await s.verify(),groups=(await s.read(first.output+'/readback-requests.json')).requests;
  const items=s.actual.flatMap(item=>(item.versions.length?item.versions:[{language:'en',version:0}]).map(v=>({...item,...v,fields:item.fields.filter(f=>f.present&&(f.storage==='shared'||f.language===v.language&&(f.storage==='unversioned'||f.version===v.version)))})));
  for(const [i,group]of groups.entries()){
   const req=JSON.parse(group.envelope.parameters.RequestJson),dataRoot=join(s.dir,'capture-server-'+i);
   await s.put('capture-fixture.json',{requestJson:group.envelope.parameters.RequestJson,requestSha256:group.requestSha256,script:group.envelope.script,markerId:req.target.marker.id,items,dataRoot});
   const result=spawnSync(process.env.PWSH_EXE??'pwsh',['-NoProfile','-File',fileURLToPath(new URL('./fixtures/readback-harness.ps1',import.meta.url)),'-InputPath',join(s.dir,'capture-fixture.json'),'-OutputPath',join(s.dir,'capture-output.json')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
   const captured=await s.read('capture-output.json');assert.equal(captured.writes,0);assert.equal(captured.states?.[0].complete,true,JSON.stringify({error:captured.error,errors:captured.states?.[0].errors}));
   const descriptor=captured.outputs[0].files[0],relative='actual-readback-'+i+'.json';await copyFile(join(dataRoot,descriptor.path),join(s.dir,relative));const bytes=await readFile(join(s.dir,relative));assert.equal(hash(bytes),descriptor.sha256);s.verificationInput.readbacks.push({path:relative,sha256:hash(bytes)});
  }
  const verified=await s.verify();assert.equal(verified.ready,true,JSON.stringify(await s.read(verified.output+'/verification-report.json')));
 }finally{await s.cleanup();}
});
