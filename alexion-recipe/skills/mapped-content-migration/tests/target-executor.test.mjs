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
  const observation=(id,path)=>({id,templateId:guid(9),path,versionsComplete:true,versions:[{language:'en',version:1}],fields:[]});
  const parent=observation(guid(1),root), post=observation(guid(2),root+'/child');
  const operation={operationId:'op-'+'b'.repeat(24),kind:'content',action:'create',targetItemId:guid(2),targetPath:post.path,templateId:guid(9),parentItemId:guid(1),beforeFingerprint:hash,versionsToCreate:[{language:'en',version:1}],fields:[],dependsOn:[],expectedPost:post};
  const request={version:1,requestId:'exec-'+'a'.repeat(24),reviewSha256:hash,reservation:{sequence:1,checkpointSha256:hash},approval:{id:'decision',kind:'mutation',scopeId:'scope',taskId:'task',choice:'approve',rationale:'approved',userResponse:'Approve',at:'2026-01-01T00:00:00Z',inputs:[{path:'review.json',sha256:hash}]},core:{version:1,contentMigrationMode:'mapped-content',scopeId:'scope',taskId:'task',batchPlanSha256:hash,batchId:'batch-0001',target:{instanceId:'target',database:'master',rootPath:root,connectorId:'spe',marker:{id:guid(1),templateId:guid(9),path:root}},structuralLanguage:'en',maxRequestBytes:1048576,maxBackupBytes:1048576,maxJournalBytes:1048576,capabilities:{speRead:true,speWrite:true,fullItemBackup:true,restoreValidated:true,exclusiveWriteWindow:true,fileDownload:true,journalContinuityVerified:true,expiresAt:'2099-01-01T00:00:00Z'},guards:[{lookup:'id',value:guid(2),exists:false},{lookup:'path',value:post.path,exists:false},{lookup:'path',value:root,exists:true,item:parent}],templates:[{id:guid(9),name:'Content',path:'/sitecore/templates/Content',kind:'content',fields:[],baseTemplateIds:[]}],operations:[operation],knownSuccess:[],identities:[]}};
  return {request,items:[{...parent,language:'en',version:1},{id:guid(9),templateId:guid(8),path:'/sitecore/templates/Content',language:'en',version:1,fields:[]}]};
}
function run(data) {
  data.request.reviewJson=JSON.stringify(data.request.core,null,2)+'\n';
  data.request.reviewSha256=createHash('sha256').update(data.request.reviewJson).digest('hex');
  data.request.approval.inputs=data.request.approval.inputs.map(input=>({...input,sha256:data.request.reviewSha256}));
  if(data.tamperCore) data.request.core.operations[0].fields[0].value='unapproved';
  if(data.tamperReview) data.request.reviewJson+=' ';
  const dir=mkdtempSync(join(tmpdir(),'kajoo-target-')); data.dataRoot=join(dir,'data');
  const input=join(dir,'in.json'), output=join(dir,'out.json'); writeFileSync(input,JSON.stringify(data));
  try {
    const result=spawnSync(process.env.PWSH_EXE??'pwsh',['-NoProfile','-File',join(here,'fixtures','target-harness.ps1'),'-InputPath',input,'-OutputPath',output],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); return JSON.parse(readFileSync(output,'utf8').replace(/^\uFEFF/,''));
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
test('target create verifies actual postcondition',()=>{ const result=run(fixture()); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); assert.equal(result.writes,1); assert.equal(result.receipt.results[0].mutated,true); });
test('wrong approval blocks all content writes',()=>{ const f=fixture(); f.request.approval.inputs=[]; const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
test('target drift blocks all content writes',()=>{ const f=fixture(); f.request.core.guards[2].item.path+='/drift'; const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
test('duplicate request returns existing durable receipt without repeating writes',()=>{ const f=fixture(); f.repeat=true; const result=run(f); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); assert.equal(result.output.summary.duplicate,true); assert.equal(result.writes,1); });
test('version gaps are rejected before writes',()=>{ const f=fixture(); f.request.core.operations[0].versionsToCreate[0].version=2; const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
test('field absent from effective template is rejected before writes',()=>{ const f=fixture(); f.request.core.operations[0].fields=[{fieldId:guid(20),storage:'shared',value:'x'}]; const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
test('existing target backup precedes version update and remains downloadable on duplicate',()=>{ const f=fixture(), op=f.request.core.operations[0]; op.action='update'; op.versionsToCreate=[{language:'en',version:2}]; op.expectedPost.versions.push({language:'en',version:2}); const before={...op.expectedPost,versions:[{language:'en',version:1}]}; f.items.push({...before,language:'en',version:1}); f.request.core.guards[0]={lookup:'id',value:op.targetItemId,exists:true,item:before}; f.request.core.guards[1]={lookup:'path',value:op.targetPath,exists:true,item:before}; f.repeat=true; const result=run(f); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); assert.equal(result.exports,1); assert.equal(result.receipt.backups[0].files.length,1); assert.equal(result.output.files.length,3); assert.equal(result.output.files[2].path,result.receipt.backups[0].files[0].path); assert.equal(result.output.summary.duplicate,true); });
test('expected post versions must equal exact approved additions before writes',()=>{ const f=fixture(), op=f.request.core.operations[0]; op.expectedPost.versions.push({language:'fr',version:1}); const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
test('created version mismatch preserves readable partial mutation',()=>{ const f=fixture(); f.wrongCreatedVersion=true; const result=run(f); assert.equal(result.receipt?.status,'partial',JSON.stringify(result)); assert.equal(result.receipt.results[0].status,'failed'); assert.equal(result.receipt.results[0].mutated,true); assert.equal(result.receipt.results[0].post.versions[0].language,'fr'); });

function withField() {
  const f=fixture(), field={id:guid(20),name:'Title',type:'Single-Line Text',storage:'versioned',declaringTemplateId:guid(9)};
  f.request.core.templates[0].fields=[field];
  const op=f.request.core.operations[0];
  op.fields=[{fieldId:field.id,storage:'versioned',language:'en',version:1,value:'Hello'}];
  op.expectedPost.fields=[{...op.fields[0],present:true}];
  return f;
}
test('exact approved versioned field is written and read back',()=>{ const result=run(withField()); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); assert.equal(result.receipt.results[0].post.fields[0].value,'Hello'); assert.equal(result.writes,2); });
test('effective field type drift blocks all writes',()=>{ const f=withField(); f.metadataDrift=true; const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
test('injected core changes cannot replace reviewed field values',()=>{ const f=withField(); f.tamperCore=true; const result=run(f); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); assert.equal(result.receipt.results[0].post.fields[0].value,'Hello'); });
test('review bytes must exactly match the approval hash',()=>{ const f=fixture(); f.tamperReview=true; const result=run(f); assert.match(result.error,/Exact reviewed request bytes/); assert.equal(result.writes,0); });
test('failure records readable partial post and skips remaining operations',()=>{
  const f=withField(); f.failEdit=true;
  const op=structuredClone(f.request.core.operations[0]); op.operationId='op-'+'c'.repeat(24); op.targetItemId=guid(3); op.targetPath=root+'/later'; op.expectedPost.id=op.targetItemId; op.expectedPost.path=op.targetPath;
  f.request.core.operations.push(op); f.request.core.guards.push({lookup:'id',value:op.targetItemId,exists:false},{lookup:'path',value:op.targetPath,exists:false});
  const result=run(f); assert.equal(result.receipt?.status,'partial',JSON.stringify(result)); assert.deepEqual(result.receipt.results.map(r=>r.status),['failed','skipped']); assert.equal(result.receipt.results[0].mutated,true); assert.equal(result.receipt.results[1].mutated,false);
});
test('newly created parent uses approved afterstate for child guard',()=>{
  const f=fixture(), parent=f.request.core.operations[0], op=structuredClone(parent);
  parent.kind='folder'; op.operationId='op-'+'c'.repeat(24); op.targetItemId=guid(3); op.targetPath=parent.targetPath+'/child'; op.parentItemId=parent.targetItemId; op.dependsOn=[parent.operationId]; op.expectedPost.id=op.targetItemId; op.expectedPost.path=op.targetPath;
  f.request.core.operations.push(op); f.request.core.guards.push({lookup:'id',value:op.targetItemId,exists:false},{lookup:'path',value:op.targetPath,exists:false});
  const result=run(f); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); assert.equal(result.writes,2);
});
test('all transitive bases are accepted independent of order',()=>{
  const f=fixture(); f.request.core.templates[0].baseTemplateIds=[guid(11),guid(10)];
  f.baseTree=[{ID:guid(10),BaseTemplates:[{ID:guid(11),BaseTemplates:[]}]}];
  const result=run(f); assert.equal(result.receipt?.status,'success',JSON.stringify(result));
});
test('a transitive base drift blocks writes even when effective fields match',()=>{
  const f=fixture(); f.request.core.templates[0].baseTemplateIds=[guid(10)];
  f.baseTree=[{ID:guid(10),BaseTemplates:[{ID:guid(11),BaseTemplates:[]}]}];
  const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0);
});
for(const name of ['Rendering instructions','Layout options','Security notes','__Display name','__Sortorder']) {
  test(`mapped business or display field is allowed: ${name}`,()=>{ const f=withField(); f.request.core.templates[0].name='Rendering Layout Security Content'; f.items[1].path='/sitecore/templates/Rendering Layout Security Content'; f.request.core.templates[0].path=f.items[1].path; f.request.core.templates[0].fields[0].name=name; const result=run(f); assert.equal(result.receipt?.status,'success',JSON.stringify(result)); });
}
for(const name of ['__Renderings','__Final Renderings','__Security','__Workflow state','__Created by']) {
  test(`critical system field remains blocked: ${name}`,()=>{ const f=withField(); f.request.core.templates[0].fields[0].name=name; const result=run(f); assert.equal(result.receipt?.status,'blocked',JSON.stringify(result)); assert.equal(result.writes,0); });
}

function referenceFixture(type='Droplink',value=guid(3),targetPath=root+'/bound') {
  const f=withField(),core=f.request.core,op=core.operations[0];
  core.operationKind='references';core.templates[0].fields[0].type=type;
  op.action='update';op.versionsToCreate=[];op.fields[0].value=value;op.expectedPost.fields[0].value=value;
  const before=structuredClone(op.expectedPost);before.fields[0].value='';
  f.items.push({...before,language:'en',version:1});
  core.guards[0]={lookup:'id',value:op.targetItemId,exists:true,item:before};
  core.guards[1]={lookup:'path',value:op.targetPath,exists:true,item:before};
  const bound={id:guid(3),templateId:guid(9),path:targetPath,versionsComplete:true,versions:[{language:'en',version:1}],fields:[]};
  f.items.push({...bound,language:'en',version:1});
  core.referenceBindings=[{sourceItemId:guid(30),targetItemId:bound.id,targetPath:bound.path,templateId:bound.templateId,existing:true}];
  core.referenceGuards=[{lookup:'id',value:bound.id,exists:true,item:bound},{lookup:'path',value:bound.path,exists:true,item:bound}];
  return f;
}

test('reference-only update validates bound existing target and backs up only the writer',()=>{
  const result=run(referenceFixture());assert.equal(result.receipt?.status,'success',JSON.stringify(result));assert.equal(result.writes,1);assert.equal(result.exports,1);assert.equal(result.receipt.results[0].post.fields[0].value,guid(3));
});
for(const scenario of ['absent','changed','missing-id-guard','missing-path-guard','unbound-guard','wrong-metadata','unbound-value'])test(`reference target ${scenario} blocks before backup and writes`,()=>{
  const f=referenceFixture(),core=f.request.core;
  if(scenario==='absent')f.items=f.items.filter(i=>i.id!==guid(3));
  if(scenario==='changed')f.items.find(i=>i.id===guid(3)).path+='/drift';
  if(scenario==='missing-id-guard')core.referenceGuards.shift();
  if(scenario==='missing-path-guard')core.referenceGuards.pop();
  if(scenario==='unbound-guard')core.referenceBindings=[];
  if(scenario==='wrong-metadata')core.referenceBindings[0].templateId=guid(8);
  if(scenario==='unbound-value'){core.operations[0].fields[0].value=guid(31);core.operations[0].expectedPost.fields[0].value=guid(31);}
  const result=run(f);assert.equal(result.receipt?.status,'blocked',JSON.stringify(result));assert.equal(result.writes,0);assert.equal(result.exports,0);
});
for(const scenario of ['create','version-addition','scalar','folder','unknown-mode','missing-bindings','missing-guards'])test(`reference mode rejects ${scenario} before writes`,()=>{
  const f=referenceFixture(),core=f.request.core,op=core.operations[0];
  if(scenario==='create')op.action='create';
  if(scenario==='version-addition'){op.versionsToCreate=[{language:'en',version:2}];op.expectedPost.versions.push({language:'en',version:2});}
  if(scenario==='scalar')core.templates[0].fields[0].type='Single-Line Text';
  if(scenario==='folder')op.kind='folder';
  if(scenario==='unknown-mode')core.operationKind='other';
  if(scenario==='missing-bindings')delete core.referenceBindings;
  if(scenario==='missing-guards')delete core.referenceGuards;
  const result=run(f);assert.equal(result.receipt?.status,'blocked',JSON.stringify(result));assert.equal(result.writes,0);assert.equal(result.exports,0);
});
test('reference XML attributes are preserved and external media remains read only',()=>{
  const raw=` \n<image alt='A &amp; B' mediaid = '${guid(3)}' src="/unchanged" /> `;
  const result=run(referenceFixture('Image',raw,'/sitecore/media library/external/image'));
  assert.equal(result.receipt?.status,'success',JSON.stringify(result));assert.equal(result.writes,1);assert.equal(result.exports,1);assert.equal(result.receipt.results[0].post.fields[0].value,raw);
});
test('existing circular references use verified afterstate for earlier writes without dependencies',()=>{
  const f=referenceFixture(),core=f.request.core,first=core.operations[0],second=structuredClone(first);
  const beforeFirst=structuredClone(core.guards[0].item),beforeSecond=structuredClone(beforeFirst);
  beforeSecond.id=guid(3);beforeSecond.path=root+'/bound';
  Object.assign(second,{operationId:'op-'+'c'.repeat(24),targetItemId:guid(3),targetPath:beforeSecond.path});
  Object.assign(second.expectedPost,{id:guid(3),path:beforeSecond.path});second.fields[0].value=guid(2);second.expectedPost.fields[0].value=guid(2);
  f.items.find(i=>i.id===guid(3)).fields=structuredClone(beforeSecond.fields);
  core.operations.push(second);core.guards.push({lookup:'id',value:guid(3),exists:true,item:beforeSecond},{lookup:'path',value:beforeSecond.path,exists:true,item:beforeSecond});
  core.referenceBindings.push({sourceItemId:guid(20),targetItemId:guid(2),targetPath:first.targetPath,templateId:guid(9),existing:false,identity:{}});
  core.referenceGuards=[...core.guards.filter(g=>g.lookup==='id'||g.value!==root)];
  const result=run(f);assert.equal(result.receipt?.status,'success',JSON.stringify(result));assert.equal(result.writes,2);assert.equal(result.exports,2);
});

for(const value of [`<link id="${guid(3)}" id="${guid(3)}" />`,`<link id="${guid(3)}" title="&bogus;" />`,`<link id="&#123;${guid(3).slice(1,-1)}&#125;" />`,`${guid(3)}|`,guid(0)])test(`reference mode blocks malformed reference syntax: ${value}`,()=>{
  const f=referenceFixture(value.startsWith('<')?'General Link':'Multilist',value),result=run(f);
  assert.equal(result.receipt?.status,'blocked',JSON.stringify(result));assert.equal(result.writes,0);assert.equal(result.exports,0);
});
test('reference guard is rechecked after backup before the first write',()=>{
  const f=referenceFixture(),executor=join(here,'../scripts/execute-target.ps1').replaceAll("'","''");
  f.script=`function Export-Item {
    [CmdletBinding()]param($Item,$Root)
    $global:exports++
    [IO.File]::WriteAllText([IO.Path]::Combine($Root,'item.item'),'synthetic backup')
    $target=@($global:databaseItems.Values | Where-Object { $_.ID -eq '${guid(3)}' })[0]
    $target.Paths.FullPath='/sitecore/content/root/moved'
  }
  & '${executor}'`;
  const result=run(f);assert.equal(result.receipt?.status,'failed',JSON.stringify(result));assert.equal(result.writes,0);assert.equal(result.exports,1);assert.equal(result.receipt.results[0].mutated,false);
});
