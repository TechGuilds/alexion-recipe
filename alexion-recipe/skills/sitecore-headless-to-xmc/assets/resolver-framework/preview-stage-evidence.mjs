// Semantic provenance boundary for the self-contained mock scaffold.
// File reads are supplied by the engine's strict hash/path verifier.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const canonical = value => typeof value === 'string' ? value.replace(/[{}-]/g, '').toLowerCase() : '';
export function validatePreviewEvidence(manifest, { readJSON, hash, routeFile }) {
 const plan=readJSON(manifest.capturePlan),{schemaVersion,fingerprint,...body}=plan;
 if(schemaVersion!==1||plan.identity!=='rendering-variant'||plan.scope!=='approved'||plan.draft!==false||fingerprint!==hash(Buffer.from(JSON.stringify(body)))||manifest.capturePlanFingerprint!==fingerprint||!Array.isArray(plan.selectedPages)||!Array.isArray(plan.requirements))throw Error('Preview stage requires an approved, intact capture plan');
 const pages=[...plan.selectedPages,...plan.requirements.flatMap(r=>r.alternatives??[])];
 for(const page of pages)routeFile(page.route);
 const selected=new Set(plan.selectedPages.map(p=>p.route));
 const documents=new Map(manifest.captureResultFiles.map(ref=>[path.resolve(ref.path),readJSON(ref)]));
 const resultPaths=new Set(documents.keys()),raw=new Map(),visited=new Set(),visiting=new Set();
 const lineage=file=>{
  if(visiting.has(file))throw Error('Preview recovery lineage contains a cycle');
  if(visited.has(file))return;
  visiting.add(file);const result=documents.get(file);
  for(const previous of result.previousCaptureResultFiles??[]){const prior=path.resolve(previous);if(!resultPaths.has(prior))throw Error('Preview recovery lineage is incomplete');lineage(prior);}
  visiting.delete(file);visited.add(file);
 };
 for(const file of resultPaths)lineage(file);
 const priorSelectedAttempt=result=>(result.previousCaptureResultFiles??[]).some(file=>{const previous=documents.get(path.resolve(file));return previous.outcomes?.some(o=>selected.has(o.route)&&['captured','failed'].includes(o.status))||priorSelectedAttempt(previous);});
 for(const ref of manifest.captureResultFiles){
  const result=documents.get(path.resolve(ref.path));
  if(result.selection!=='discovery-plan'||result.capturePlanFingerprint!==fingerprint||!Array.isArray(result.outcomes)||typeof result.outputDir!=='string'||!path.isAbsolute(result.outputDir))throw Error('Preview capture result does not match approved plan');
  if(result.outcomes.some(o=>!selected.has(o.route))&&(!selected.size||!priorSelectedAttempt(result)))throw Error('Preview alternative requires a prior selected page attempt');
  for(const outcome of result.outcomes){
   const page=pages.find(p=>p.route===outcome.route);
   if(!page||!['captured','failed','skipped'].includes(outcome.status))throw Error('Preview capture outcome is outside approved scope');
   if((outcome.itemId&&page.itemId&&canonical(outcome.itemId)!==canonical(page.itemId))||(outcome.itemPath&&page.itemPath&&outcome.itemPath!==page.itemPath)||(outcome.language&&page.language&&outcome.language!==page.language))throw Error('Preview outcome source identity mismatch');
   if(outcome.status!=='captured')continue;
   const expected=path.resolve(result.outputDir,routeFile(outcome.route).slice('public/mock-layouts/'.length));
   if(path.resolve(outcome.layoutFile)!==expected)throw Error('Preview captured layout path mismatch');
   const layout=readJSON({path:outcome.layoutFile,sha256:outcome.sha256}),actual=layout?.sitecore?.route??layout?.route;
   if(!actual||!actual.placeholders||typeof actual.placeholders!=='object'||Array.isArray(actual.placeholders)||(page.itemId&&canonical(actual.itemId??actual.itemID)!==canonical(page.itemId)))throw Error('Preview captured source identity is invalid');
   const language=layout?.sitecore?.context?.language??actual.itemLanguage;
   if(page.language&&language!==undefined&&language!==page.language)throw Error('Preview captured language mismatch');
   if(raw.has(outcome.route)&&raw.get(outcome.route).sha256!==outcome.sha256)throw Error('Ambiguous source capture for preview');
   raw.set(outcome.route,{path:path.resolve(outcome.layoutFile),sha256:outcome.sha256});
  }
 }
 const mappingProof=ref=>{
  const mapped=readJSON(ref),{fingerprint:fp,...contents}=mapped;
  if(mapped.schemaVersion!==1||fp!==hash(Buffer.from(JSON.stringify(contents)))||mapped.approval?.status!=='approved'||!mapped.approvalEvidence||!Array.isArray(mapped.inputFiles))throw Error('Preview requires an intact approved mapping plan');
  for(const input of mapped.inputFiles)readJSON(input);
  const decisions=readJSON(mapped.approvalEvidence),candidates=decisions.filter(d=>d.kind==='mapping'&&d.scopeId===mapped.approval.scopeId);
  const decision=candidates.length===1?candidates[0]:null;
  if(!decision||decision.id!==mapped.approval.decisionId||decision.choice!=='approve'||decision.entityId!==undefined||decision.taskId!==undefined||!decision.userResponse?.trim()||!Number.isFinite(Date.parse(decision.at)))throw Error('Preview mapping approval is stale or out of scope');
  const signature=refs=>JSON.stringify(refs.map(r=>[r.path,r.sha256]).sort((a,b)=>a[0].localeCompare(b[0])));
  if(signature(decision.inputs??[])!==signature(mapped.inputFiles))throw Error('Preview mapping approval inputs changed');
  return mapped;
 };
 const mappedResults=(manifest.mappedLayoutFiles??[]).map(readJSON),exampleResults=(manifest.componentExamplesFiles??[]).map(ref=>({ref,value:readJSON(ref)}));
 for(const capture of manifest.captures){
  if(capture.kind==='captured'){
   const source=raw.get(capture.route);
   if(!source||source.path!==path.resolve(capture.layoutFile)||source.sha256!==capture.sha256)throw Error('Preview page was not produced by a declared approved capture');
  }else if(capture.kind==='derived-mapped-layout'){
   const result=mappedResults.find(r=>r.kind==='derived-mapped-layout'&&r.route===capture.route&&r.outputFile===capture.layoutFile&&r.sha256===capture.sha256),source=raw.get(capture.route);
   if(!result||!source||result.sourceLayout.path!==source.path||result.sourceLayout.sha256!==source.sha256)throw Error('Preview mapped page is not bound to its source capture');
   mappingProof(result.mappingPlan);
  }else if(capture.kind==='synthetic-component-example'){
   const match=exampleResults.flatMap(({ref,value})=>(value.examples??[]).filter(e=>e.route===capture.route&&e.status==='layout-ready'&&e.synthetic===true&&e.visualValidation==='pending').map(example=>({ref,value,example}))).find(({ref,example})=>path.resolve(path.dirname(ref.path),example.relativeFile)===path.resolve(capture.layoutFile));
   if(!match||match.value.synthetic!==true)throw Error('Preview synthetic page is outside declared examples');
   readJSON(match.value.sourceInventory);const mapped=mappingProof(match.value.mappingPlan);
   if(mapped.sourceFingerprint!==match.value.sourceInventory.fingerprint||!isDeepStrictEqual(readJSON({path:capture.layoutFile,sha256:capture.sha256}),match.example.layout))throw Error('Preview synthetic layout differs from approved example');
  }else throw Error('Unknown preview capture kind');
 }
}
