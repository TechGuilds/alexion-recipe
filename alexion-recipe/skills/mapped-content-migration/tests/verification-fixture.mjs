import {join} from 'node:path';
import {referenceFixture} from './reference-fixture.mjs';
import {readExecutionState} from '../scripts/lib/execution-state.mjs';
import {verifyTarget} from '../scripts/verify-target.mjs';
import {fieldKey} from '../scripts/lib/snapshot.mjs';
import {id} from './fixture-factory.mjs';

export async function verificationFixture(options={}){
 const s=await referenceFixture({media:options.media,...(options.change?{change:options.change}:{})});
 const initialContentInput=s.referenceInput.contentPlanInput;
 if(options.resolve!==false){await s.selectReferences();const a=await s.authorize(),receipt=await s.referenceReceipt(a);await s.finish(a,receipt);s.publishActual(receipt);}
 const journal=await readExecutionState(s.state);
 const capability={version:1,scopeId:s.binding.scopeId,instanceId:s.evidence.instanceId,database:s.evidence.database,rootPath:s.evidence.rootPath,connectorId:s.cap.connectorId,marker:s.cap.marker,speRead:true,fileDownload:true,stableReadWindow:true,verifiedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),maxCaptureBytes:8388608,maxRequestBytes:8388608,evidence:await s.put('read-proof.json',{synthetic:true,readOnly:true})};
 s.verificationInput={version:1,contentPlanInput:initialContentInput,checkpoint:{path:'journal/'+journal.head.path,sha256:journal.sha256},capabilities:await s.put('read-capabilities.json',capability),structuralLanguage:'en',readbackId:'synthetic-independent-audit',readbacks:[],maxQueriesPerRequest:options.queriesPerRequest??100};
 s.actual=[...new Map([...s.evidence.queries,...(s.external?.queries??[])].filter(q=>q.exists).map(q=>[q.item.id.toLowerCase(),structuredClone(q.item)])).values()];
 for(const item of s.actual){item.parentId=s.actual.find(p=>p.path===item.path.slice(0,item.path.lastIndexOf('/')))?.id??id(9999);for(const field of item.fields)if(field.present)field.fieldType=s.d.targetInventory.templates.find(t=>t.id.toLowerCase()===item.templateId.toLowerCase())?.fields.find(f=>f.id.toLowerCase()===field.fieldId.toLowerCase())?.type??'Single-Line Text';}
 let count=0;
 s.verify=async()=>{await s.put('verification-input.json',s.verificationInput);const output='verification-'+(++count);const result=await verifyTarget(join(s.dir,'verification-input.json'),join(s.dir,output));return {...result,output};};
 s.makeReadbacks=async(first)=>{
  const planned=await s.read(first.output+'/readback-requests.json');s.readbackStates=[];
  for(const [i,part]of planned.requests.entries()){
   const req=JSON.parse(part.envelope.parameters.RequestJson);
   const state={version:1,scopeId:req.scopeId,instanceId:req.target.instanceId,database:req.target.database,rootPath:'/sitecore',targetStateId:req.readbackId,capturedAt:new Date().toISOString(),valueMode:'effective',requestId:req.requestId,requestSha256:part.requestSha256,collectorSha256:req.collectorSha256,expectedSha256:req.expectedSha256,complete:true,errors:[],queries:req.queries.map(q=>{const actual=s.actual.find(a=>(q.lookup==='id'?a.id:a.path).toLowerCase()===q.value.toLowerCase());if(!actual)return {lookup:q.lookup,value:q.value,exists:false};return {lookup:q.lookup,value:q.value,exists:true,item:{...structuredClone(actual),fields:q.fields.map(selector=>{const field=actual.fields.find(f=>fieldKey(f)===fieldKey(selector));return field?structuredClone(field):{...selector,present:false};})}};})};
   s.readbackStates.push(state);s.verificationInput.readbacks.push(await s.put('readback-'+i+'.json',state));
  }
 };
 s.saveReadbacks=async()=>{s.verificationInput.readbacks=[];for(const [i,state]of s.readbackStates.entries())s.verificationInput.readbacks.push(await s.put('readback-'+i+'.json',state));};
 return s;
}
