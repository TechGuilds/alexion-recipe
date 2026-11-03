import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMedia, mediaMigration, compareMedia, groupMediaItems, MAX_MEDIA_PACKAGE_BYTES, validateMediaOutcome } from '../scripts/media-migration.mjs';
import { hash, jsonBytes } from '../scripts/lib/files.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tuple = name => ({ instanceId:name,connectorId:name+'-connector',database:'master',deployment:'XM',rootPath:'/sitecore/media library',marker:{id:id(90),path:'/sitecore/content/Site',templateId:id(91)} });
const asset = (n,path) => ({id:id(n),path,templateId:id(80),parentId:id(70),isFolder:false,fields:[{id:id(60),language:'en',version:1,value:'Accessible image'}],blobs:[{language:'en',version:1,bytes:8,sha256:hash('original')}]});
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(),'alexion-media-')); t.after(()=>rm(base,{recursive:true,force:true}));
  const put=async(name,value)=>{const bytes=jsonBytes(value);await writeFile(join(base,name),bytes);return {path:name,sha256:hash(bytes)};};
  const source=tuple('source'),target=tuple('target');
  const scope={kind:'media-scope',version:1,scopeId:'scope',source,target,selectors:[{path:'/sitecore/media library/Images',includeDescendants:true}],maxPackageBytes:MAX_MEDIA_PACKAGE_BYTES};
  const scopeArtifact=await put('scope.json',scope);
  const decision=(kind,choice,taskId,ref=scopeArtifact)=>({id:kind+'-'+choice,kind,choice,scopeId:'scope',taskId,rationale:'Reviewed exact scope',userResponse:'Yes, approved',at:'2026-01-01T00:00:00Z',inputs:[ref]});
  const input={version:1,action:'capture',scopeId:'scope',attemptId:'attempt-1',taskId:'content.media-prepare',scopeArtifact,
    mediaDecision:await put('opt.json',decision('scope','migrate-media','discovery.plan')),
    scopeDecision:await put('scope-decision.json',decision('scope','approve','content.media-prepare')),
    capabilities:{speRead:true,fileTransfer:true,stableReadWindow:true,updatePackages:true,binaryRoundTripVerified:true,restoreVerified:true,exclusiveWriteWindow:true,pilotSha256:hash('server pilot'),verifiedAt:'2026-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'}};
  const capture=await runMedia(input,{base}),sourceCaptureRequest=await put('capture-request.json',capture.request.value);
  const items=[asset(1,'/sitecore/media library/Images/Banner')];
  const sourceInventory=await put('inventory.json',{kind:'media-inventory',version:1,scopeId:'scope',target:source,selectors:scope.selectors,requestId:capture.request.value.requestId,requestSha256:sourceCaptureRequest.sha256,capturedAt:'2026-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',complete:true,items,missingIds:[],collisions:[],unresolvedOperations:[]});
  const preparation={...input,action:'prepare',sourceInventory,sourceCaptureRequest};
  const generated=await runMedia(preparation,{base});
  const bytes=Buffer.from('PK\x03\x04package-test'); await writeFile(join(base,'media.update'),bytes);
  const p={id:'media-0001',path:'media-0001.update',serverPath:'C:/source/media-0001.update',order:1,bytes:bytes.length,sha256:hash(bytes),itemIds:items.map(i=>i.id)};
  const manifest={kind:'media-package-manifest',version:1,scopeId:'scope',source,sourceInventorySha256:sourceInventory.sha256,requestId:generated.request.value.requestId,requestSha256:generated.request.sha256,completedAt:'2026-10-30T00:00:00Z',maxPackageBytes:MAX_MEDIA_PACKAGE_BYTES,items,packages:[p]};
  const packageManifest=await put('manifest.json',manifest),packageFiles=[{packageId:p.id,path:'media.update',sha256:p.sha256}];
  const prepare={...preparation,packageManifest,packageFiles};
  const install={...prepare,action:'install',taskId:'content.media-install',packageTransports:[{...p,serverPath:'C:/target/media-0001.update'}]};
  const inspection=await runMedia(install,{base}),inspectionRequest=await put('inspection-request.json',inspection.request.value);
  const observation=(request,items,missingIds=[])=>({kind:'media-inventory',version:1,scopeId:'scope',target,requestId:request.requestId,requestSha256:hash(jsonBytes(request)),sourceInventorySha256:sourceInventory.sha256,capturedAt:'2026-11-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',complete:true,items,missingIds,collisions:[],unresolvedOperations:[]});
  const targetInventory=await put('before.json',{...observation(inspection.request.value,[],items.map(i=>i.id)),capturedAt:'2026-10-30T12:00:00Z'});
  return {base,put,input,prepare,install:{...install,inspectionRequest,targetInventory},items,manifest,p,decision,observation};
}

test('100 MB is decimal and source preparation produces no target write',async t=>{
  const f=await fixture(t),result=await runMedia(f.prepare,{base:f.base});
  assert.equal(MAX_MEDIA_PACKAGE_BYTES,100000000);assert.equal(result.report.ready,true);assert.equal(result.report.targetWrites,false);
  assert.equal(result.request.envelope.role,'source');assert.equal(result.request.value.action,'package');
  assert.equal(result.request.envelope.parameters.RequestSha256,hash(result.request.envelope.parameters.RequestJson));
  const read1=await runMedia(f.input,{base:f.base}),read2=await runMedia({...f.input,attemptId:'attempt-2'},{base:f.base});
  assert.notEqual(read1.request.value.requestId,read2.request.value.requestId);
  const input=await f.put('input.json',f.prepare),out=join(f.base,'prepared');
  assert.equal((await mediaMigration(join(f.base,input.path),out)).ready,true);
  await assert.rejects(()=>mediaMigration(join(f.base,input.path),out),/exist/i);
});

test('preparation blocks declined/missing scope, SitecoreAI, expired capabilities and changed binary files',async t=>{
  const f=await fixture(t);
  const no=await f.put('no.json',f.decision('scope','skip-media','discovery.plan'));
  await assert.rejects(()=>runMedia({...f.prepare,mediaDecision:no},{base:f.base}),/human media decision/);
  await assert.rejects(()=>runMedia({...f.prepare,scopeDecision:undefined},{base:f.base}));
  await assert.rejects(()=>runMedia({...f.prepare,capabilities:{...f.prepare.capabilities,expiresAt:'2000-01-01'}},{base:f.base}),/expired/);
  await writeFile(join(f.base,'media.update'),'changed');
  await assert.rejects(()=>runMedia(f.prepare,{base:f.base}),/size\/hash|bytes differ/);
  const scope=JSON.parse(await readFile(join(f.base,'scope.json'),'utf8'));scope.target.deployment='SitecoreAI';
  const scopeArtifact=await f.put('cloud-scope.json',scope);
  await assert.rejects(()=>runMedia({...f.prepare,scopeArtifact},{base:f.base}),/XP\/XM/);
});

test('manifest coverage, parent ordering and actual output size cannot be bypassed',async t=>{
  const f=await fixture(t),bad=structuredClone(f.manifest);bad.packages[0].itemIds=[];
  const packageManifest=await f.put('bad-manifest.json',bad);
  await assert.rejects(()=>runMedia({...f.prepare,packageManifest},{base:f.base}));
  await truncate(join(f.base,'media.update'),100000001);
  await assert.rejects(()=>runMedia(f.prepare,{base:f.base}),/100 MB/);
});

test('comparison distinguishes reuse, updates, missing items and ID/path collisions',()=>{
  const a=asset(1,'/sitecore/media library/Images/A');
  assert.equal(compareMedia([a],[a])[0].action,'reuse');assert.equal(compareMedia([a],[])[0].action,'create');
  const changed=structuredClone(a);changed.fields[0].value='Different';assert.equal(compareMedia([a],[changed])[0].action,'update');
  assert.equal(compareMedia([a],[{...a,id:id(2)}])[0].action,'conflict');
  assert.equal(compareMedia([a],[{...a,path:a.path+'-moved'}])[0].action,'conflict');
  const groups=groupMediaItems([a,asset(2,a.path+'B')],1000);assert.equal(groups.flat().length,2);
});

test('installation requires exact review approval and target request scope; generation alone is not completion',async t=>{
  const f=await fixture(t),planned=await runMedia({...f.install,packageId:f.p.id},{base:f.base});
  assert.equal(planned.report.ready,false);assert.equal(planned.request,undefined);
  const review=await f.put('review.json',planned.review),approval=await f.put('approval.json',f.decision('mutation','approve','content.media-install',review));
  const approved=await runMedia({...f.install,packageId:f.p.id,review,approval},{base:f.base});
  assert.equal(approved.request.value.action,'install');assert.equal(approved.report.ready,false);
  assert.equal(approved.request.value.manifestSha256,f.prepare.packageManifest.sha256);
  assert.equal(approved.request.value.reviewSha256,review.sha256);
  const bad=await f.put('wrong-review.json',{...planned.review,operationId:'different'});
  await assert.rejects(()=>runMedia({...f.install,packageId:f.p.id,review:bad,approval},{base:f.base}),/stale/);
});

test('independent verification requires successful approved receipts for changes and emits verified identities',async t=>{
  const f=await fixture(t),planned=await runMedia({...f.install,packageId:f.p.id},{base:f.base});
  const review=await f.put('review.json',planned.review),approval=await f.put('approval.json',f.decision('mutation','approve','content.media-install',review));
  const approved=await runMedia({...f.install,packageId:f.p.id,review,approval},{base:f.base});
  const request=await f.put('submitted.json',approved.request.value);
  const receiptValue={kind:'media-install-receipt',version:1,scopeId:'scope',target:f.manifest.source /* corrected below */,requestId:approved.request.value.requestId,requestSha256:request.sha256,reviewSha256:review.sha256,operationId:planned.review.operationId,status:'successful',manifestSha256:f.prepare.packageManifest.sha256,sourceInventorySha256:f.prepare.sourceInventory.sha256,packageId:f.p.id,packageSha256:f.p.sha256,completedAt:'2026-10-31T00:00:00Z'};
  receiptValue.target=planned.review.target;
  const receipt=await f.put('receipt.json',receiptValue),verify={...f.install,action:'verify',receipts:[{request,receipt}]};
  const generated=await runMedia(verify,{base:f.base}),verificationRequest=await f.put('verification-request.json',generated.request.value);
  const verificationInventory=await f.put('after.json',f.observation(generated.request.value,f.items));
  const complete={...verify,verificationRequest,verificationInventory};
  const result=await runMedia(complete,{base:f.base});assert.equal(result.report.ready,true);assert.equal(result.report.identities[0].targetItemId,f.items[0].id);
  const verifiedInput=await f.put('verified-input.json',complete),verifiedReport=await mediaMigration(join(f.base,verifiedInput.path),join(f.base,'verified-output'));
  await validateMediaOutcome('media-install',{mediaInstallationInput:{path:join(f.base,verifiedInput.path),sha256:verifiedInput.sha256,value:complete}},
    [{role:'mediaVerificationReport',value:verifiedReport}],{scopeId:'scope',task:{id:'content.media-install'}});
  await assert.rejects(()=>runMedia({...complete,receipts:[]},{base:f.base}),/requires its successful/);
  const unknown=await f.put('unknown.json',{...receiptValue,status:'unknown'});
  await assert.rejects(()=>runMedia({...complete,receipts:[{request,receipt:unknown}]},{base:f.base}),/uncertain/);
  const old=await f.put('old-receipt.json',{...receiptValue,completedAt:'2026-10-29T00:00:00Z'});
  await assert.rejects(()=>runMedia({...complete,receipts:[{request,receipt:old}]},{base:f.base}),/stale/);
  const unresolved=await f.put('unresolved-target.json',{...f.observation(generated.request.value,f.items),unresolvedOperations:[{operationId:planned.review.operationId,status:'unknown'}]});
  await assert.rejects(()=>runMedia({...complete,verificationInventory:unresolved,receipts:[]},{base:f.base}),/reconciliation/);
});

test('media postflight replays preparation and rejects a forged ready report',async t=>{
  const f=await fixture(t),input=await f.put('prepare-input.json',f.prepare),out=join(f.base,'result');
  await mediaMigration(join(f.base,input.path),out);
  const report=JSON.parse(await readFile(join(out,'media-preparation-report.json'),'utf8'));
  const roles={mediaPreparationInput:{path:join(f.base,input.path),sha256:input.sha256,value:f.prepare}};
  const outputs=[{role:'mediaPreparationReport',value:report},{role:'mediaManifest',sha256:f.prepare.packageManifest.sha256}];
  await validateMediaOutcome('media-prepare',roles,outputs,{scopeId:'scope',task:{id:'content.media-prepare'}});
  outputs[0].value={...report,packageCount:100};await assert.rejects(()=>validateMediaOutcome('media-prepare',roles,outputs,{scopeId:'scope',task:{id:'content.media-prepare'}}),/canonical replay/);
});

test('historical postflight retains completed media evidence after expiry but rejects future captures',async t=>{
  const f=await fixture(t),expired={...f.prepare,capabilities:{...f.prepare.capabilities,expiresAt:'2026-10-31T00:00:00Z'}};
  const generated=await runMedia({...expired,packageManifest:undefined},{base:f.base,historical:true});
  expired.packageManifest=await f.put('old-manifest.json',{...f.manifest,requestSha256:generated.request.sha256});
  await assert.rejects(()=>runMedia(expired,{base:f.base}),/expired/);
  const replay=await runMedia(expired,{base:f.base,historical:true});assert.equal(replay.report.ready,true);
  const input=await f.put('historical-input.json',expired);replay.report.inputSha256=input.sha256;
  await validateMediaOutcome('media-prepare',{mediaPreparationInput:{path:join(f.base,input.path),sha256:input.sha256,value:expired}},
    [{role:'mediaPreparationReport',value:replay.report},{role:'mediaManifest',sha256:expired.packageManifest.sha256}],{scopeId:'scope',task:{id:'content.media-prepare'}});
  const future={...f.prepare,capabilities:{...f.prepare.capabilities,verifiedAt:'2098-01-01T00:00:00Z'}};
  await assert.rejects(()=>runMedia(future,{base:f.base,historical:true}),/future/);
  const futureManifest=await f.put('future-manifest.json',{...f.manifest,completedAt:'2098-01-01T00:00:00Z'});
  await assert.rejects(()=>runMedia({...f.prepare,packageManifest:futureManifest},{base:f.base,historical:true}),/future/);
});
