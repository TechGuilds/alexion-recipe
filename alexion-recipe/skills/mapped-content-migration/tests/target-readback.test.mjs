import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const guid=n=>`{00000000-0000-0000-0000-${String(n).padStart(12,'0')}}`;
const root='/sitecore/content/root', hash='a'.repeat(64);
function fixture() {
  const row=(id,path)=>({id,templateId:guid(9),parentId:guid(8),path,language:'en',version:1,fields:[]});
  const marker={id:guid(1),templateId:guid(9),path:root};
  return {markerId:marker.id,request:{version:1,requestId:'verify-'+'b'.repeat(24),expectedSha256:hash,collectorSha256:hash,readbackId:'readback-1',scopeId:'scope',target:{instanceId:'target',database:'master',rootPath:root,connectorId:'spe',marker},capabilities:{speRead:true,fileDownload:true,stableReadWindow:true,verifiedAt:'2026-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCaptureBytes:1048576,maxRequestBytes:1048576},queries:[{lookup:'id',value:guid(2),fields:[]}],maxBytes:1048576},items:[row(guid(1),root),row(guid(2),root+'/child')]};
}
function run(data) {
  data.requestJson=JSON.stringify(data.request,null,2)+'\n';
  data.requestSha256=createHash('sha256').update(data.requestJson).digest('hex');
  if(data.badHash) data.requestJson+=' ';
  const dir=mkdtempSync(join(tmpdir(),'kajoo-readback-')); data.dataRoot=join(dir,'data');
  const input=join(dir,'in.json'), output=join(dir,'out.json'); writeFileSync(input,JSON.stringify(data));
  try {
    const result=spawnSync(process.env.PWSH_EXE??'pwsh',['-NoProfile','-File',join(here,'fixtures','readback-harness.ps1'),'-InputPath',input,'-OutputPath',output],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const response=JSON.parse(readFileSync(output,'utf8').replace(/^\uFEFF/,''));
    assert.equal(response.writes,0);
    if(response.outputs) for(const descriptor of response.outputs.flatMap(o=>o.files)) {
      const bytes=readFileSync(join(data.dataRoot,descriptor.path));
      assert.equal(bytes.length,descriptor.size); assert.equal(createHash('sha256').update(bytes).digest('hex'),descriptor.sha256);
      assert.ok(descriptor.size<=data.request.maxBytes);
    }
    return response;
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
function fieldFixture() {
  const f=fixture();
  f.request.queries[0].fields=[{fieldId:guid(20),storage:'shared'},{fieldId:guid(21),storage:'unversioned',language:'en'},{fieldId:guid(22),storage:'versioned',language:'fr',version:2},{fieldId:guid(23),storage:'versioned',language:'en',version:1},{fieldId:guid(22),storage:'versioned',language:'fr',version:3}];
  f.items[1].fields=[{fieldId:guid(20),storage:'shared',fieldType:'Single-Line Text',value:''},{fieldId:guid(21),storage:'unversioned',fieldType:'Single-Line Text',value:'English'}];
  f.items.push({...f.items[1],language:'fr',version:2,fields:[{fieldId:guid(22),storage:'versioned',fieldType:'Rich Text',value:'Français'}]});
  return f;
}
test('exact readback includes provenance, all version tuples, parent identity and typed field scopes',()=>{
  const f=fieldFixture(), result=run(f), state=result.states?.[0]; assert.equal(state?.complete,true,JSON.stringify(result));
  assert.equal(state.requestSha256,f.requestSha256); assert.equal(state.rootPath,'/sitecore'); assert.equal(state.valueMode,'effective');
  const item=state.queries[0].item; assert.equal(item.parentId,guid(8)); assert.equal(item.versionsComplete,true);
  assert.deepEqual(item.versions,[{language:'en',version:1},{language:'fr',version:2}]);
  assert.deepEqual(item.fields.map(f=>[f.present,f.value]),[[true,''],[true,'English'],[true,'Français'],[false,undefined],[false,undefined]]);
  assert.equal(item.fields[2].fieldType,'Rich Text'); assert.equal('fieldType' in item.fields[3],false);
  assert.ok(result.reads.some(r=>r.language==='*'&&r.version==='*'));
  assert.ok(result.reads.some(r=>r.language==='fr'&&r.version==='2'));
});
test('missing exact item is complete absence, missing field is present false',()=>{ const f=fieldFixture(); f.request.queries.push({lookup:'path',value:root+'/absent',fields:[]}); const result=run(f); assert.equal(result.states?.[0].complete,true,JSON.stringify(result)); assert.deepEqual(result.states[0].queries[1],{lookup:'path',value:root+'/absent',exists:false}); });
test('exact request bytes are hashed before JSON parsing or reads',()=>{ const f=fixture(); f.badHash=true; const result=run(f); assert.match(result.error,/bytes\/hash mismatch/); assert.deepEqual(result.reads,[]); });
for (const [name,modify,pattern] of [
  ['wrong root marker',f=>f.request.target.marker.templateId=guid(99),/marker changed/],
  ['expired capability',f=>f.request.capabilities.expiresAt='2026-01-02T00:00:00Z',/window expired/],
  ['future verification',f=>f.request.capabilities.verifiedAt='2098-01-01T00:00:00Z',/window expired/],
  ['unconfirmed stable window',f=>f.request.capabilities.stableReadWindow=false,/capabilities required/],
  ['nonboolean read proof',f=>f.request.capabilities.speRead=1,/capabilities required/],
  ['path traversal',f=>f.request.queries[0]={lookup:'path',value:root+'/../secret',fields:[]},/Unsafe readback path/],
  ['template read scope',f=>f.request.queries[0]={lookup:'path',value:'/sitecore/templates/Test',fields:[]},/Unsafe readback path/],
  ['too many queries',f=>f.request.queries=Array(101).fill(f.request.queries[0]),/1\.\.100/],
  ['capture lower bound',f=>f.request.maxBytes=4095,/byte bounds/],
  ['request upper bound',f=>f.request.capabilities.maxRequestBytes=8388609,/byte bounds/],
  ['fractional byte bound',f=>f.request.maxBytes=4096.5,/byte bounds/],
  ['request bytes above capability',f=>{f.request.capabilities.maxRequestBytes=1024;f.request.scopeId+='x'.repeat(1024);},/byte bounds/],
]) test(name+' fails closed without writes',()=>{ const f=fixture(); modify(f); assert.match(run(f).error,pattern); });
test('query read errors preserve other results and mark partial',()=>{ const f=fixture(); f.readError=guid(2); f.request.queries.push({lookup:'path',value:root+'/absent',fields:[]}); const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); assert.equal(r.states[0].errors.length,1); assert.equal(r.states[0].queries.length,1); });
test('marker is checked again after reads with error scoped to requested query',()=>{ const f=fixture(); f.markerChanges=true; const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); assert.match(r.states[0].errors[0].message,/during capture/); assert.equal(r.states[0].errors[0].lookup,f.request.queries[0].lookup); assert.equal(r.states[0].errors[0].value,f.request.queries[0].value); });
test('versionless existing item returns complete empty version inventory',()=>{ const f=fixture(); f.items[1].version=0; f.items[1].language=''; const r=run(f); assert.equal(r.states?.[0].complete,true,JSON.stringify(r)); assert.equal(r.states[0].queries[0].exists,true); assert.deepEqual(r.states[0].queries[0].item.versions,[]); assert.equal(r.states[0].queries[0].item.versionsComplete,true); });
for (const version of [-1,'bogus','1.5','']) test(`invalid observed version ${JSON.stringify(version)} is rejected`,()=>{ const f=fixture(); f.items[1].version=version; const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); });
test('storage mismatch produces partial evidence',()=>{ const f=fieldFixture(); f.items[1].fields[0].storage='versioned'; const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); assert.equal(r.states[0].errors.length,1); });
test('missing actual field type produces partial evidence',()=>{ const f=fieldFixture(); delete f.items[1].fields[0].fieldType; const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); });
test('duplicate field selectors fail before reads',()=>{ const f=fieldFixture(); f.request.queries[0].fields.push(f.request.queries[0].fields[0]); const r=run(f); assert.match(r.error,/Duplicate field selector/); assert.deepEqual(r.reads,[]); });
test('duplicate observed language/version tuples are rejected',()=>{ const f=fixture(); f.items.push({...f.items[1]}); const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); assert.equal(r.states[0].queries.length,0); });
test('missing parent identity is incomplete evidence',()=>{ const f=fixture(); delete f.items[1].parentId; const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); });
test('ID queries report moved content metadata outside the approved content root',()=>{ const f=fixture(); f.items[1].path='/sitecore/content/other/moved'; const r=run(f); assert.equal(r.states?.[0].complete,true,JSON.stringify(r)); assert.equal(r.states[0].queries[0].item.path,f.items[1].path); });
test('ID queries reject actual paths outside content/media',()=>{ const f=fixture(); f.items[1].path='/sitecore/system/secret'; const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); });
test('exact media dependency metadata can be read',()=>{ const f=fixture(); f.items[1].path='/sitecore/media library/logo'; f.request.queries[0]={lookup:'path',value:f.items[1].path,fields:[]}; const r=run(f); assert.equal(r.states?.[0].complete,true,JSON.stringify(r)); });
test('overflow exports only a small incomplete error state',()=>{ const f=fieldFixture(); f.request.maxBytes=4096; f.items[1].fields[0].value='x'.repeat(10000); const r=run(f); assert.equal(r.states?.[0].complete,false,JSON.stringify(r)); assert.deepEqual(r.states[0].queries,[]); assert.match(r.states[0].errors[0].message,/byte limit/); });
test('duplicate requests preserve earlier evidence in distinct export directories',()=>{ const f=fixture(); f.repeat=true; const r=run(f); assert.equal(r.states?.length,2,JSON.stringify(r)); assert.ok(r.states.every(s=>s.complete)); assert.notEqual(r.outputs[0].files[0].path,r.outputs[1].files[0].path); });
