#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,child)=>root===child||child.startsWith(root+path.sep);
function rootPath(value) {
 let current=path.resolve(value), tail=[];
 while(!fs.existsSync(current)){
  try { if(fs.lstatSync(current).isSymbolicLink())throw Error('Symlink root rejected'); } catch(e){if(e.code!=='ENOENT')throw e;}
  tail.unshift(path.basename(current));current=path.dirname(current);
 }
 if(fs.lstatSync(current).isSymbolicLink())throw Error('Symlink root rejected');
 return path.join(fs.realpathSync(current),...tail);
}
function safeRelative(root,value) {
 if(typeof value!=='string'||!value||path.isAbsolute(value)||/[\\:\0]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe relative path');
 let full=root;
 for(const part of value.split('/')){
  full=path.join(full,part);
  try{if(fs.lstatSync(full).isSymbolicLink())throw Error('Symlink path rejected');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return full;
}
function bytes(file,max) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size>max)throw Error('File type or size limit rejected');
  const content=fs.readFileSync(fd);
  if(content.length>max)throw Error('File exceeds size limit');
  return content;
 }finally{fs.closeSync(fd);}
}
function parseArgs(args) {
 const o={'max-bytes':128*1024*1024};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--allow-partial'){
   if(o['allow-partial'])throw Error('Duplicate argument');
   o['allow-partial']=true;continue;
  }
  if(!['--raw-root','--mapping','--output','--max-bytes'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('Expected --raw-root DIR --mapping FILE --output NEW_DIR [--max-bytes N]');
  const key=args[i].slice(2);
  if(key!=='max-bytes'&&o[key])throw Error('Duplicate argument');
  o[key]=args[++i];
 }
 if(!o['raw-root']||!o.mapping||!o.output)throw Error('raw-root, mapping and output are required');
 o['max-bytes']=Number(o['max-bytes']);
 if(!Number.isSafeInteger(o['max-bytes'])||o['max-bytes']<1)throw Error('Invalid max-bytes: expected a positive safe integer');
 return o;
}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function validLayout(value) {
 return object(value)&&!Object.hasOwn(value,'error')&&!Object.hasOwn(value,'errors')&&object(value.sitecore)&&object(value.sitecore.context)&&object(value.sitecore.route)&&object(value.sitecore.route.fields)&&object(value.sitecore.route.placeholders);
}
function normalize(o) {
 const raw=rootPath(o['raw-root']), output=rootPath(o.output), mappingPath=rootPath(o.mapping);
 if(!fs.statSync(raw).isDirectory())throw Error('raw-root must be a directory');
 if(inside(raw,output)||inside(output,raw)||inside(output,mappingPath))throw Error('Raw, mapping and output paths must not overlap');
 if(fs.existsSync(output))throw Error('Output already exists; choose a new directory');
 const mappingBytes=bytes(mappingPath,8*1024*1024);
 const mapping=JSON.parse(mappingBytes);
 if(!object(mapping)||mapping.version!==1||!Array.isArray(mapping.routes)||mapping.routes.length===0||Object.keys(mapping).some(k=>!['version','routes'].includes(k)))throw Error('Expected mapping version 1 with explicit routes');
 const outputNames=new Set(),sourceNames=new Set();
 const mappings=mapping.routes.map(m=>{
  if(!object(m)||Object.keys(m).some(k=>!['source','output'].includes(k)))throw Error('Unsupported mapping; only explicit source/output paths are supported');
  const source=safeRelative(raw,m.source),dest=safeRelative(output,m.output);
  if(!/^layout-\d{6}\.json$/.test(m.source)||!m.output.endsWith('.json')||m.output.toLowerCase()==='manifest.json')throw Error('Invalid mapped filename');
  const outKey=m.output.normalize('NFC').toLowerCase(),sourceKey=m.source.toLowerCase();
  if(sourceNames.has(sourceKey)||[...outputNames].some(p=>p===outKey||p.startsWith(outKey+'/')||outKey.startsWith(p+'/')))throw Error('Duplicate or conflicting mapping');
  outputNames.add(outKey);sourceNames.add(sourceKey);
  return {...m,sourcePath:source,dest};
 });
 const indexBytes=bytes(safeRelative(raw,'layouts.jsonl'),16*1024*1024);
 const summaryBytes=bytes(safeRelative(raw,'capture-summary.jsonl'),1024*1024);
 let records,summary;
 try {
  records=indexBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
  const summaries=summaryBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
  if(summaries.length!==1)throw Error();
  summary=summaries[0];
 }catch{ return {success:false,partial:true,errors:['Invalid capture metadata']}; }
 const errors=[], byFile=new Map(),identities=new Set(),indices=new Set(),failedRoutes=[];
 const succeeded=records.filter(r=>object(r)&&r.success===true).length;
 const failed=records.filter(r=>object(r)&&r.success===false).length;
 if(!object(summary)||summary.kind!=='layout-capture'||summary.version!==1||typeof summary.partial!=='boolean'||summary.total!==records.length||summary.succeeded!==succeeded||summary.failed!==failed||succeeded+failed!==records.length||succeeded===0||(!summary.partial&&failed>0))errors.push('Capture summary/counts are inconsistent or no successful routes exist');
 if(!o['allow-partial']&&(summary?.partial!==false||failed!==0))errors.push('Capture is partial; explicit --allow-partial is required to deliver successful routes');
 for(const r of records){
  if(!object(r)||!Number.isInteger(r.index)||r.index<0||indices.has(r.index)||typeof r.item!=='string'||typeof r.site!=='string'||typeof r.language!=='string'){
   errors.push('Failed or invalid capture record');continue;
  }
  indices.add(r.index);
  const identity=JSON.stringify([r.item,r.site,r.language,r.mode,r.device,r.version,r.database]);
  if(identities.has(identity))errors.push('Duplicate route identity');
  identities.add(identity);
  if(r.success===false){
   if(typeof r.error!=='string'||!r.error)errors.push('Failed capture record requires an error');
   failedRoutes.push({item:r.item,site:r.site,language:r.language,status:r.status,error:r.error});
   continue;
  }
  if(r.success!==true||r.error!=null||r.status!==200||!/^[a-f0-9]{64}$/.test(r.sha256||'')||!Number.isSafeInteger(r.bytes)||r.bytes<1){
   errors.push('Failed or invalid capture record');continue;
  }
  if(typeof r.rawFile!=='string'||!/^layout-\d{6}\.json$/.test(r.rawFile)||byFile.has(r.rawFile)){
   errors.push('Duplicate or invalid raw filename');continue;
  }
  safeRelative(raw,r.rawFile);
  byFile.set(r.rawFile,r);
 }
 if(mappings.length!==succeeded)errors.push('Mapping does not cover every successful captured route exactly once');
 const files=[];
 for(const m of mappings){
  const record=byFile.get(m.source);
  if(!record){errors.push('Mapping has no successful capture record: '+m.source);continue;}
  let content;
  try{content=bytes(m.sourcePath,o['max-bytes']);}catch(e){if(e.code==='ENOENT'){errors.push('Missing raw capture: '+m.source);continue;}throw e;}
  const digest=hash(content);
  if(digest!==record.sha256||content.length!==record.bytes){errors.push('Source hash/size mismatch: '+m.source);continue;}
  try{if(!validLayout(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(content))))throw Error();}
  catch{errors.push('Invalid Layout Service response: '+m.source);continue;}
  files.push({source:m.source,output:m.output,sourceHash:digest,outputHash:digest,bytes:content.length,request:{item:record.item,site:record.site,language:record.language,mode:record.mode,device:record.device,version:record.version,database:record.database}});
 }
 if(errors.length)return {success:false,partial:true,errors};
 // Read-only preflight completed. mkdir is exclusive; no existing output is reused.
 fs.mkdirSync(path.dirname(output),{recursive:true});
 fs.mkdirSync(output);
 for(const [i,m] of mappings.entries()){
  const content=bytes(m.sourcePath,o['max-bytes']);
  if(hash(content)!==files[i].sourceHash)throw Error('Source changed during normalization; output is incomplete');
  fs.mkdirSync(path.dirname(m.dest),{recursive:true});
  fs.writeFileSync(m.dest,content,{flag:'wx'});
 }
 if(hash(bytes(safeRelative(raw,'layouts.jsonl'),16*1024*1024))!==hash(indexBytes)||hash(bytes(safeRelative(raw,'capture-summary.jsonl'),1024*1024))!==hash(summaryBytes)||hash(bytes(mappingPath,8*1024*1024))!==hash(mappingBytes))throw Error('Capture metadata changed; output is incomplete');
 const partial=summary.partial||failed>0;
 const manifest={kind:'normalized-layout-baseline',version:1,success:true,partial,counts:{requested:records.length,delivered:files.length,failed},failedRoutes,rawRoot:raw,mappingHash:hash(mappingBytes),indexHash:hash(indexBytes),summaryHash:hash(summaryBytes),transformations:['explicit output-path mapping only; raw bytes unchanged'],files};
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return {success:true,partial,output,files:files.length,manifest:path.join(output,'manifest.json')};
}
try{
 const result=normalize(parseArgs(process.argv.slice(2)));
 console.log(JSON.stringify(result,null,2));process.exitCode=result.success?0:2;
}catch(e){
 // Parser diagnostics can contain response fragments; never forward them.
 const error=e instanceof SyntaxError?'Invalid JSON input':(e.code?'Filesystem operation failed ('+e.code+')':e.message);
 console.log(JSON.stringify({success:false,error}));process.exitCode=1;
}
