import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { parseDocument } from 'yaml';
const baseTemplateFieldId='12c33f3f-86c5-43a5-aeb4-5598cec45116';
export const cmp = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export function guid(value) {
  if (typeof value !== 'string' || !/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\})$/i.test(value)) throw Error(`Invalid GUID: ${value}`);
  const hex = value.replace(/[{}-]/g,'').toLowerCase();
  if (!/^[\da-f]{32}$/.test(hex)) throw Error(`Invalid GUID: ${value}`);
  return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
}
export function safe(p) {
  p = path.resolve(p);
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error(`Symlink forbidden: ${current}`); }
    catch(e) { if(e.code !== 'ENOENT') throw e; break; }
  }
  return p;
}
export function separate(a,b) {
  a=safe(a); b=safe(b);
  if(a===b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep)) throw Error('Roots must be separate and non-overlapping');
}
export function walk(root) {
  root=safe(root);
  return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>cmp(a.name,b.name)).flatMap(e=>{
    const p=path.join(root,e.name);
    if(e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) throw Error(`Unsafe input: ${p}`);
    return e.isDirectory()?walk(p):[p];
  });
}
export function args(allowed) {
  const out={}; const argv=process.argv.slice(2);
  for(let i=0;i<argv.length;i++) {
    const key=argv[i].replace(/^--/,'');
    if(!argv[i].startsWith('--') || !allowed.includes(key) || key in out) throw Error(`Unknown or duplicate option: ${argv[i]}`);
    out[key]=key==='apply'?true:argv[++i];
    if(out[key]===undefined || String(out[key]).startsWith('--')) throw Error(`Missing value: ${key}`);
  }
  return out;
}
export function required(a,...names) { for(const n of names) if(!a[n]) throw Error(`Required --${n}`); }
export function writeReport(root,name,data,inputs=[]) {
  root=safe(root); for(const input of inputs) separate(input,root);
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
}
export function run(fn) { try { fn(); } catch(e) { console.error(JSON.stringify({error:e.message})); process.exitCode=1; } }
export function readBytes(file) {
  safe(file);
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.nlink!==1) throw Error(`Unsafe input file: ${file}`);
  return fs.readFileSync(file);
}
export function readItem(file, bytes=readBytes(file)) {
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  const doc=parseDocument(text,{uniqueKeys:true,strict:true});
  // Sitecore CLI can serialize a field scalar beginning with `%`. The YAML
  // library flags that as a directive-indicator syntax error while still
  // constructing the intended value. Preserve strict parsing for every other
  // error, and surface this known Sitecore serialization dialect difference as
  // a warning for the caller to retain in evidence.
  const warnings=doc.errors.filter(error=>/Plain value cannot start with directive indicator character %/.test(error.message));
  const errors=doc.errors.filter(error=>!warnings.includes(error));
  if(errors.length) throw Error(errors.map(e=>e.message).join('; '));
  const data=doc.toJS({maxAliasCount:0});
  if(!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Expected item mapping');
  const id=guid(data.ID), template=guid(data.Template);
  if(typeof data.Path !== 'string' || !data.Path.startsWith('/sitecore/') || data.Path.slice(1).split('/').some(p=>p==='..'||p==='.'||p==='')) throw Error('Invalid item Path');
  return {text,doc,data,id,template,warnings:warnings.map(error=>error.message)};
}
export const hash = text => createHash('sha256').update(text).digest('hex');
export function inspect(itemsRoot,modulesRoot) {
  itemsRoot=safe(itemsRoot); modulesRoot=safe(modulesRoot);
  const diagnostics=[], warnings=[], modules=[];
  const inputManifest={roots:{items:itemsRoot,modules:modulesRoot},files:[]};
  const consume=(file,role)=>{
    const bytes=readBytes(file);
    inputManifest.files.push({role,path:path.relative(inputManifest.roots[role],file),sha256:hash(bytes),bytes:bytes.length});
    return bytes;
  };
  for(const file of walk(modulesRoot).filter(f=>f.endsWith('.module.json'))) {
    try {
      const m=JSON.parse(consume(file,'modules'));
      if(typeof m.namespace!=='string'||!m.namespace.trim()||!Array.isArray(m.items?.includes)) throw Error('Expected namespace and items.includes');
      if(modules.some(x=>x.namespace===m.namespace)) throw Error('Duplicate namespace');
      for(const i of m.items.includes) {
        if(typeof i.path!=='string'||!i.path.startsWith('/sitecore/')||i.rules || !['ItemAndDescendants','SingleItem','DescendantsOnly',undefined].includes(i.scope)) throw Error('Unsupported include path/rules/scope');
        if(i.database && i.database!=='master') throw Error('Only master database supported');
      }
      modules.push({namespace:m.namespace,includes:m.items.includes});
    } catch(e) { diagnostics.push({file:path.relative(modulesRoot,file),error:e.message}); }
  }
  if(!modules.length) diagnostics.push({error:'No module configs'});
  const items=[];
  for(const file of walk(itemsRoot).filter(f=>/\.ya?ml$/i.test(f))) {
    try {
      const bytes=consume(file,'items');
      const {data,id,template,warnings:itemWarnings}=readItem(file,bytes);
      const relativeFile=path.relative(itemsRoot,file);
      for(const message of itemWarnings) warnings.push({file:relativeFile,message});
      // Sitecore item paths are case-insensitive. Keep the captured path intact
      // for evidence and output, but compare normalized keys for ownership.
      const itemPathKey=data.Path.toLowerCase();
      const matches=modules.filter(m=>m.includes.some(i=>{
        const includePathKey=i.path.toLowerCase();
        return (i.scope!=='DescendantsOnly'&&itemPathKey===includePathKey) ||
          (i.scope!=='SingleItem'&&itemPathKey.startsWith(includePathKey+'/'));
      }
      ));
      if(matches.length!==1) throw Error(`Expected exactly one namespace, found ${matches.length}`);
      const dependencies=[{id:template,kind:'template'}];
      const softReferences=[];
      if(data.Parent) dependencies.push({id:guid(data.Parent),kind:'parent'});
      function fields(v) {
        if(!v||typeof v!=='object') return;
        if(v.ID && typeof v.Value==='string') {
          const kind=guid(v.ID)===baseTemplateFieldId?'base-template':'field-reference';
          for(const match of v.Value.matchAll(/\{?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\}?/gi)) {
            const reference={id:guid(match[0]),kind};
            if(kind==='base-template') dependencies.push(reference);
            else softReferences.push(reference);
          }
        }
        for(const child of Object.values(v)) if(typeof child==='object') fields(child);
      }
      fields(data);
      const unique=references=>[...new Map(references
        .filter(reference=>reference.id!=='00000000-0000-0000-0000-000000000000')
        .map(reference=>[reference.id+'|'+reference.kind,reference])).values()]
        .sort((a,b)=>cmp(a.id+a.kind,b.id+b.kind));
      items.push({file:relativeFile,sha256:hash(bytes),id,path:data.Path,template,namespace:matches[0].namespace,dependencies:unique(dependencies),softReferences:unique(softReferences)});
    } catch(e) { diagnostics.push({file:path.relative(itemsRoot,file),error:e.message}); }
  }
  for(const key of ['id','path']) {
    const seen=new Set(); for(const i of items) { const value=i[key].toLowerCase(); if(seen.has(value)) diagnostics.push({file:i.file,error:`Duplicate ${key}: ${i[key]}`}); seen.add(value); }
  }
  if(!items.length) diagnostics.push({error:'No serialized items'});
  const ids=new Set(items.map(i=>i.id));
  const missingReferences=items.flatMap(i=>i.dependencies.filter(d=>!ids.has(d.id)).map(d=>({item:i.id,...d}))).sort((a,b)=>cmp(a.item,b.item)||cmp(a.id,b.id)||cmp(a.kind,b.kind));
  const softReferences=items.flatMap(i=>i.softReferences.map(reference=>({item:i.id,...reference}))).sort((a,b)=>cmp(a.item,b.item)||cmp(a.id,b.id)||cmp(a.kind,b.kind));
  inputManifest.files.sort((a,b)=>cmp(a.role,b.role)||cmp(a.path,b.path));
  return {version:1,valid:!diagnostics.length,inputManifest,modules:modules.sort((a,b)=>cmp(a.namespace,b.namespace)).map(m=>({...m,count:items.filter(i=>i.namespace===m.namespace).length})),items,diagnostics,warnings,missingReferences,softReferences};
}
export function verifyManifest(manifest) {
  for(const [role,root] of Object.entries(manifest.roots)) {
    const paths=walk(root).filter(f=>role==='items'?/\.ya?ml$/i.test(f):f.endsWith('.module.json')).map(f=>path.relative(root,f)).sort(cmp);
    const entries=manifest.files.filter(e=>e.role===role);
    if(JSON.stringify(paths)!==JSON.stringify(entries.map(e=>e.path))) throw Error(`Input file set changed: ${role}`);
    for(const entry of entries) if(hash(readBytes(path.join(root,entry.path)))!==entry.sha256) throw Error(`Input changed: ${role}/${entry.path}`);
  }
}
