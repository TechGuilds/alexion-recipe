import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../scripts/capture/normalize-baseline.mjs',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,body=JSON.stringify({sitecore:{context:{language:'en'},route:{name:'Home',fields:{price:{value:9007199254740993n.toString()},html:{value:'<p>Ü</p>'}},placeholders:{main:[{uid:'{ABC}',componentName:'X Y',fields:{nested:{value:{b:2,a:1}}}},{uid:'{ABC}',componentName:'X Y',fields:{}}]}}}})){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'baseline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const raw=path.join(root,'raw');fs.mkdirSync(raw);
 fs.writeFileSync(path.join(raw,'layout-000001.json'),body);
 const record={index:0,item:'/',site:'source',language:'en',success:true,status:200,rawFile:'layout-000001.json',sha256:hash(body),bytes:Buffer.byteLength(body)};
 fs.writeFileSync(path.join(raw,'layouts.jsonl'),JSON.stringify(record)+'\n');
 fs.writeFileSync(path.join(raw,'capture-summary.jsonl'),JSON.stringify({kind:'layout-capture',version:1,total:1,succeeded:1,failed:0,partial:false})+'\n');
 const mapping=path.join(root,'mapping.json');
 fs.writeFileSync(mapping,JSON.stringify({version:1,routes:[{source:'layout-000001.json',output:'target/en/index.json'}]}));
 return {root,raw,mapping,record,body};
}
function run(f,...extra){
 const p=spawnSync(process.execPath,[script,'--raw-root',f.raw,'--mapping',f.mapping,'--output',path.join(f.root,'derived'),...extra],{encoding:'utf8'});
 return {code:p.status,data:p.stdout?JSON.parse(p.stdout):null};
}
test('copies exact resolver fields UID order and bytes with source hashes; never mutates raw evidence',t=>{
 const f=fixture(t); const before=fs.readdirSync(f.raw).map(n=>[n,fs.readFileSync(path.join(f.raw,n))]);
 let p=run(f); assert.equal(p.code,0);assert.equal(p.data.success,true);
 assert.equal(fs.readFileSync(path.join(f.root,'derived/target/en/index.json'),'utf8'),f.body);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'derived/manifest.json'),'utf8'));
 assert.equal(manifest.files[0].sourceHash,hash(f.body));assert.equal(manifest.files[0].outputHash,hash(f.body));
 for(const [n,bytes] of before)assert.deepEqual(fs.readFileSync(path.join(f.raw,n)),bytes);
 p=run(f);assert.equal(p.code,1);assert.match(p.data.error,/exist/i);
});
test('partial capture and null route/HTML/error payloads never normalize as success',t=>{
 for(const body of ['{"sitecore":{"route":null}}','<html>error</html>','{"error":"failed"}']){
  const f=fixture(t,body),p=run(f);assert.equal(p.code,2);assert.equal(p.data.success,false);
  assert.equal(fs.existsSync(path.join(f.root,'derived/target/en/index.json')),false);
 }
 const f=fixture(t);fs.writeFileSync(path.join(f.raw,'capture-summary.jsonl'),JSON.stringify({kind:'layout-capture',version:1,total:2,succeeded:1,failed:1,partial:true})+'\n');
 const p=run(f);assert.equal(p.code,2);assert.equal(p.data.success,false);
});
test('rejects mismatched source hashes duplicate mappings traversal and symlinks',t=>{
 const f=fixture(t);
 fs.appendFileSync(path.join(f.raw,'layout-000001.json'),' ');
 assert.equal(run(f).code,2);
 for(const routes of [
  [{source:'layout-000001.json',output:'../escape'}],
  [{source:'layout-000001.json',output:'a.json'},{source:'layout-000001.json',output:'a.json'}],
  [{source:'layout-000001.json',output:'a.json'},{source:'layout-000001.json',output:'A.json'}],
  [{source:'layout-000001.json',output:'MANIFEST.json'}],
 ]){
  fs.writeFileSync(f.mapping,JSON.stringify({version:1,routes}));assert.equal(run(f).code,1);
 }
 const g=fixture(t);fs.unlinkSync(path.join(g.raw,'layout-000001.json'));
 fs.symlinkSync(process.platform==='win32'?g.root:g.mapping,path.join(g.raw,'layout-000001.json'),process.platform==='win32'?'junction':'file');
 assert.equal(run(g).code,1);
});

test('empty mappings duplicate capture identities and failed records reject a claimed complete summary',t=>{
 const f=fixture(t);
 fs.writeFileSync(f.mapping,JSON.stringify({version:1,routes:[]}));
 assert.equal(run(f).code,1);
 const g=fixture(t);
 fs.writeFileSync(path.join(g.raw,'layouts.jsonl'),JSON.stringify({...g.record,success:false,error:'timeout'})+'\n');
 assert.equal(run(g).code,2);
 const inconsistent=fixture(t);
 fs.writeFileSync(path.join(inconsistent.raw,'layouts.jsonl'),JSON.stringify({...inconsistent.record,error:'timeout'})+'\n');
 assert.equal(run(inconsistent).code,2);
 const h=fixture(t);
 fs.copyFileSync(path.join(h.raw,'layout-000001.json'),path.join(h.raw,'layout-000002.json'));
 fs.writeFileSync(path.join(h.raw,'layouts.jsonl'),[h.record,{...h.record,index:1,rawFile:'layout-000002.json'}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 fs.writeFileSync(path.join(h.raw,'capture-summary.jsonl'),JSON.stringify({kind:'layout-capture',version:1,total:2,succeeded:2,failed:0,partial:false}));
 fs.writeFileSync(h.mapping,JSON.stringify({version:1,routes:[{source:'layout-000001.json',output:'one.json'},{source:'layout-000002.json',output:'two.json'}]}));
 assert.equal(run(h).code,2);
});
test('large valid layouts are byte-identical and raw/output overlap is rejected',t=>{
 const f=fixture(t,JSON.stringify({sitecore:{context:{},route:{fields:{html:{value:'λ'.repeat(3*1024*1024)}},placeholders:{}}}}));
 assert.equal(run(f).code,0);assert.equal(fs.statSync(path.join(f.root,'derived/target/en/index.json')).size,Buffer.byteLength(f.body));
 const p=spawnSync(process.execPath,[script,'--raw-root',f.raw,'--mapping',f.mapping,'--output',path.join(f.raw,'derived')],{encoding:'utf8'});
 assert.equal(p.status,1);
});

test('per-file limit accepts higher positive safe integers without a task-wide quota',t=>{
 const f=fixture(t);
 assert.equal(run(f,'--max-bytes','9007199254740991').code,0);
 for(const value of ['0','-1','1.5','9007199254740992']){
  const g=fixture(t);assert.equal(run(g,'--max-bytes',value).code,1);
 }
});

test('explicit partial delivery preserves successful bytes and accounts for failed routes without rewriting raw evidence',t=>{
 const f=fixture(t);
 const failed={...f.record,index:1,item:'/failed',success:false,status:500,error:'http-status',rawFile:null,sha256:null,bytes:0};
 fs.writeFileSync(path.join(f.raw,'layouts.jsonl'),[f.record,failed].map(JSON.stringify).join('\n')+'\n');
 fs.writeFileSync(path.join(f.raw,'capture-summary.jsonl'),JSON.stringify({kind:'layout-capture',version:1,total:2,succeeded:1,failed:1,partial:true}));
 const before=fs.readFileSync(path.join(f.raw,'layouts.jsonl'));
 assert.equal(run(f).code,2);
 const result=run(f,'--allow-partial');
 assert.equal(result.code,0);
 assert.equal(result.data.partial,true);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'derived/manifest.json')));
 assert.deepEqual(manifest.counts,{requested:2,delivered:1,failed:1});
 assert.equal(manifest.failedRoutes[0].item,'/failed');
 assert.equal(fs.readFileSync(path.join(f.root,'derived/target/en/index.json'),'utf8'),f.body);
 assert.deepEqual(fs.readFileSync(path.join(f.raw,'layouts.jsonl')),before);
});

test('partial delivery still rejects inconsistent metadata, unmapped successes and corrupted successful bytes',t=>{
 for(const defect of ['summary','unmapped','bytes']){
  const f=fixture(t);
  if(defect==='summary') fs.writeFileSync(path.join(f.raw,'capture-summary.jsonl'),JSON.stringify({kind:'layout-capture',version:1,total:2,succeeded:1,failed:1,partial:true}));
  if(defect==='unmapped'){
   const second={...f.record,index:1,item:'/second',rawFile:'layout-000002.json'};
   fs.copyFileSync(path.join(f.raw,f.record.rawFile),path.join(f.raw,second.rawFile));
   fs.writeFileSync(path.join(f.raw,'layouts.jsonl'),[f.record,second].map(JSON.stringify).join('\n')+'\n');
   fs.writeFileSync(path.join(f.raw,'capture-summary.jsonl'),JSON.stringify({kind:'layout-capture',version:1,total:2,succeeded:2,failed:0,partial:false}));
  }
  if(defect==='bytes') fs.appendFileSync(path.join(f.raw,f.record.rawFile),'changed');
  assert.equal(run(f,'--allow-partial').code,2,defect);
  assert.equal(fs.existsSync(path.join(f.root,'derived')),false);
 }
});
