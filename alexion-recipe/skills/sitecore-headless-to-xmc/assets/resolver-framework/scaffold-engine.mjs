import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validatePreviewEvidence } from './preview-stage-evidence.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Template manifests are generated from LF-normalized text. Git may legitimately
// materialize the same text as CRLF on Windows, so validate canonical text bytes
// while retaining the source bytes for the target output and overwrite hashes.
const templateHash = bytes => hash(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
const read = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const within = (a,b) => a === b || b.startsWith(a + path.sep);
function canonicalRoot(input) {
 let current=path.resolve(input); const missing=[];
 while(!fs.existsSync(current)) {
  try { if(fs.lstatSync(current).isSymbolicLink()) throw Error('Symlink root rejected'); } catch(e){if(e.code!=='ENOENT')throw e;}
  missing.unshift(path.basename(current)); current=path.dirname(current);
 }
 if(fs.lstatSync(current).isSymbolicLink()) throw Error('Symlink root rejected: '+current);
 return path.join(fs.realpathSync(current),...missing);
}
export function safePath(input) {
 const full=path.resolve(input);
 let p=path.parse(full).root;
 for (const part of full.slice(p.length).split(path.sep).filter(Boolean)) {
  p=path.join(p,part);
  try { if(fs.lstatSync(p).isSymbolicLink()) throw Error('Symlink path rejected: '+p); }
  catch(e) { if(e.code!=='ENOENT') throw e; }
 }
 return full;
}
export function options(argv) {
 const o={overwrite:[],component:[]};
 for(let i=0;i<argv.length;i++){
  const key=argv[i];
  if(['--apply','--dry-run','--plan','--help'].includes(key)){o[key.slice(2)]=true;continue;}
  if(!['--target','--source','--resolver-assets','--route','--layout','--preview-stage','--preview-stage-sha256','--overwrite','--component'].includes(key) || !argv[i+1] || argv[i+1].startsWith('--')) throw Error('Unknown or missing option: '+key);
  const value=argv[++i]; const name=key.slice(2);
  if(Array.isArray(o[name])) o[name].push(value);
  else if(o[name]!==undefined) throw Error('Duplicate option: '+key);
  else o[name]=value;
 }
 if(o.apply&&(o['dry-run']||o.plan)) throw Error('Choose --apply or --dry-run');
 if(!o.target&&!o.help) throw Error('--target is required');
 return o;
}
function relative(root, rel) {
 if(path.isAbsolute(rel)||rel.split(/[\\/]/).some(s=>s==='..'||s==='')||rel.includes('\\')) throw Error('Unsafe relative path: '+rel);
 const full=safePath(path.join(root,rel));
 if(!within(root,full)) throw Error('Path escapes root');
 return full;
}
export function scaffold(o, assetRoots, mock=false) {
 if (!mock && (o['preview-stage'] || o['preview-stage-sha256'] || o.layout)) throw Error('Preview integration requires the mock scaffold');
 const target=canonicalRoot(o.target);
 if(target===path.parse(target).root||target===os.homedir()) throw Error('Unsafe target root');
 const roots=assetRoots.map(canonicalRoot);
 for(const source of [...roots,...(o.source?[canonicalRoot(o.source)]:[])]) {
  if(within(source,target)||within(target,source)) throw Error('Source and target must not overlap');
 }
 const specs=[], provenance=[];
 for(const root of roots){
  const manifest=JSON.parse(fs.readFileSync(relative(root,'manifest.json'),'utf8'));
  for(const f of manifest.files){
   const bytes=fs.readFileSync(relative(root,f.asset));
   if(templateHash(bytes)!==f.sha256) throw Error('Template hash mismatch: '+f.asset);
   specs.push({path:f.target,bytes});
   provenance.push({path:f.target,asset:f.asset,sha256:f.sha256,commit:f.provenance?null:manifest.commit,...(f.provenance?{provenance:f.provenance}:{})});
  }
 }
 if(o['preview-stage-sha256']&&!o['preview-stage'])throw Error('--preview-stage-sha256 requires --preview-stage');
 const preview={stage:null,layout:{path:null,outcome:'unresolved'}};
 if(mock&&o['preview-stage']){
  const stage=canonicalRoot(o['preview-stage']);
  if(within(stage,target)||within(target,stage))throw Error('Preview stage and target must not overlap');
  const manifestFile=relative(stage,'deployment-manifest.json');
  const manifestBytes=fs.readFileSync(manifestFile);
  if(!/^[a-f0-9]{64}$/.test(o['preview-stage-sha256']??'')||hash(manifestBytes)!==o['preview-stage-sha256'])throw Error('Preview stage requires the reviewed deployment manifest SHA256');
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(manifest.schemaVersion!==1||manifest.kind!=='mock-preview-deployment'||!Array.isArray(manifest.files))throw Error('Invalid preview deployment manifest');
  if(!Array.isArray(manifest.routes)||new Set(manifest.routes).size!==manifest.routes.length)throw Error('Invalid preview manifest routes');
  const routeFile=route=>{
   if(typeof route!=='string'||!route.startsWith('/')||route.startsWith('//')||/[\\?#%\x00-\x20:<>"|*]/.test(route))throw Error('Unsafe preview route');
   const parts=route.slice(1).split('/');
   if(route!=='/'&&parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe preview route');
   return 'public/mock-layouts/'+(route==='/'?'home':route.slice(1))+'/index.json';
  };
  const expectedLayouts=new Set(manifest.routes.map(routeFile));
  if(new Set([...expectedLayouts].map(p=>p.toLowerCase())).size!==manifest.routes.length)throw Error('Preview route output collision');
  const verifyInput=ref=>{
   if(!ref||typeof ref.path!=='string'||!path.isAbsolute(ref.path)||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('Invalid preview input reference');
   const file=safePath(ref.path),stat=fs.statSync(file);
   if(!stat.isFile()||stat.nlink!==1||hash(fs.readFileSync(file))!==ref.sha256)throw Error('Stale preview input evidence');
  };
  if(!manifest.capturePlan||!Array.isArray(manifest.captureResultFiles)||!manifest.captureResultFiles.length)throw Error('Preview requires explicit capture provenance');
  if(!Array.isArray(manifest.inputs)||!manifest.inputs.length)throw Error('Preview requires complete current input provenance');
  for(const ref of [manifest.capturePlan,...manifest.captureResultFiles,...(manifest.mappedLayoutFiles??[]),...(manifest.componentExamplesFiles??[]),...manifest.inputs])verifyInput(ref);
  if(!Array.isArray(manifest.captures)||manifest.captures.length!==manifest.routes.length)throw Error('Invalid preview capture entries');
  if(new Set(manifest.captures.map(c=>c.route)).size!==manifest.routes.length||manifest.captures.some(c=>!manifest.routes.includes(c.route)))throw Error('Preview capture routes differ from selected routes');
  for(const capture of manifest.captures)verifyInput({path:capture.layoutFile,sha256:capture.sha256});
  validatePreviewEvidence(manifest,{readJSON:ref=>{verifyInput(ref);return JSON.parse(fs.readFileSync(ref.path,'utf8').replace(/^\uFEFF/,''));},hash,routeFile});
  const seenStage=new Set();
  for(const entry of manifest.files){
   if(!entry||typeof entry.path!=='string'||!(/^[a-f0-9]{64}$/).test(entry.sha256)||seenStage.has(entry.path.toLowerCase()))throw Error('Invalid or duplicate preview deployment file');
   seenStage.add(entry.path.toLowerCase());
   const isAsset=['public/mock-preview/navigation.js','public/mock-preview/routes.json'].includes(entry.path);
   if(!isAsset&&!/^public\/mock-layouts\/(?:[^/]+\/)+index\.json$/.test(entry.path))throw Error('Unexpected preview deployment path: '+entry.path);
   if(!isAsset&&!expectedLayouts.has(entry.path))throw Error('Preview layout is outside the selected route index');
   if(!isAsset&&manifest.captures.find(c=>routeFile(c.route)===entry.path)?.sha256!==entry.sha256)throw Error('Preview layout differs from verified capture');
   const bytes=fs.readFileSync(relative(stage,entry.path));
   if(hash(bytes)!==entry.sha256)throw Error('Stale preview deployment file: '+entry.path);
   const stat=fs.statSync(relative(stage,entry.path));if(!stat.isFile()||stat.nlink!==1)throw Error('Preview deployment file must be a regular, unlinked file');
   const existing=specs.find(f=>f.path===entry.path);
   if(entry.path==='public/mock-preview/navigation.js'&&(!existing||templateHash(bytes)!==templateHash(existing.bytes)))throw Error('Preview navigation must match the shipped asset');
   if(entry.path==='public/mock-preview/routes.json'){
    const index=JSON.parse(bytes.toString('utf8'));
    if(!index||Object.keys(index).length!==1||!Array.isArray(index.routes)||index.routes.some(r=>typeof r!=='string'||!r.startsWith('/')||r.startsWith('//')||/[?#\\]/.test(r)))throw Error('Invalid preview route index');
    const expected=manifest.routes.map(r=>r==='/'?'/':'/'+r.slice(1).split('/').map(encodeURIComponent).join('/'));
    if(JSON.stringify(index.routes)!==JSON.stringify(expected))throw Error('Preview route index differs from selected layouts');
   }
   if(existing)existing.bytes=bytes;else specs.push({path:entry.path,bytes});
   provenance.push({path:entry.path,sha256:entry.sha256,provenance:'verified-preview-stage'});
  }
  if([...expectedLayouts].some(p=>!seenStage.has(p.toLowerCase())))throw Error('Selected preview layout is missing from deployment');
  if(!seenStage.has('public/mock-preview/routes.json')||!seenStage.has('public/mock-preview/navigation.js'))throw Error('Preview deployment must include navigation and route index');
  preview.stage={manifestHash:hash(fs.readFileSync(manifestFile)),capturePlanFingerprint:manifest.capturePlanFingerprint??null,files:manifest.files.length};
 }
 const unresolved=['Installed Content SDK/Next API compatibility, build and browser parity are not verified.'];
 if(!mock){
  for(const dep of ['src/lib/mock-sitecore-client.ts','sitecore.config.ts'])
   if(!read(relative(target,dep))) unresolved.push('Missing dependency: '+dep+'; supply mock scaffold or reviewed client/config.');
 }
 const components=new Set(), identifiers=new Set();
 for(const entry of o.component){
  const parts=entry.split('=');
  const name=parts[0].replace(/\s/g,'');
  const id=parts[1];
  if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(name)||!/^[A-Za-z_$][\w$]*$/.test(id||'')) throw Error('Component must be Name=validIdentifier');
  if(components.has(name.toLowerCase())||identifiers.has(id.toLowerCase())) throw Error('Component normalization collision');
  components.add(name.toLowerCase());identifiers.add(id.toLowerCase());
  const stub=specs.find(f=>f.path.endsWith('resolver-adapter.stub.ts.template')).bytes.toString();
  specs.push({path:'src/lib/server/resolvers/'+id+'.resolver.ts',bytes:Buffer.from(stub.replaceAll('{{COMPONENT_NAME}}',name).replaceAll('{{COMPONENT_NAME_CAMEL}}',id).replace("from './resolver-adapter.types'","from '../resolver-adapter.types'"))});
  unresolved.push('Adapter '+name+' is an unresolved enrichment stub; verify registry discovery and field-level results.');
 }
 const envKeys=[];
 if(mock){
  const file=relative(target,'.env.local'), before=read(file)?.toString()||'';
  const defaults={USE_MOCK_LAYOUT_SERVICE:'true',MOCK_LAYOUT_DATA_PATH:'/mock-layouts',MOCK_DICTIONARY_DATA_PATH:'/mock-dictionary',MOCK_LAYOUT_DEBUG:'false',SITECORE_EDGE_CONTEXT_ID:''};
  let after=before;
  const newline=before.includes('\r\n')?'\r\n':'\n';
  for(const [key,value] of Object.entries(defaults)){
   if(!new RegExp('^\\s*(?:export\\s+)?'+key+'\\s*=','m').test(before)){
    if(after&&!after.endsWith('\n')) after+=newline;
    after+=key+'='+value+newline;envKeys.push(key);
   }
  }
  specs.push({path:'.env.local',bytes:Buffer.from(after)});
  unresolved.push('Mock fixtures/site scope, RawFieldHtml component-map exclusion and live mode remain unverified. Existing env values are preserved; enable mock mode explicitly if currently false.');
 }
 const routes=o.route?[o.route]:['src/app/[site]/[locale]/[[...path]]/page.tsx','src/app/[[...path]]/page.tsx','src/app/[...path]/page.tsx'];
 const route=routes.find(r=>read(relative(target,r)));
 let routeOutcome='unresolved';
 if(route){
  const content=read(relative(target,route)).toString();
  // Only an exact generated block is recognized. Arbitrary syntax requires review.
  const block="\n  // Native resolver integration\n  if (page && process.env.USE_MOCK_LAYOUT_SERVICE !== 'true') {\n    page = await applyResolverStrategy(page, {\n      locale, site, routePath: '/' + (path ?? []).join('/'),\n      resolverDebug: process.env.RESOLVER_DEBUG === 'true',\n    });\n  }\n";
  const imp="import { applyResolverStrategy } from '@/lib/server/resolver-strategy';\n";
  if(content.includes(block)&&content.includes(imp)) routeOutcome='already-integrated';
  else if(o.route){
   const anchor=/\n([ \t]*)if\s*\(\s*!page\s*\)\s*\{/g;
   const matches=[...content.matchAll(anchor)];
   const pos=matches[0]?.index??0, prefix=content.slice(0,pos);
   const binding=/\b(?:const|let)\s*\{([^}]+)\}\s*=\s*await\s+params\s*;/g;
   const names=[...prefix.matchAll(binding)].flatMap(m=>m[1].split(',').map(s=>s.trim()));
   const fetches=[...prefix.matchAll(/\blet\s+page\s*=\s*await\s+[\w.]+\([^;]*\)\s*;/g)];
   const simpleScope=/\basync\s+function\s+\w+\([^()]*\)\s*\{\s*(?:const|let)\s*\{[^}]+\}\s*=\s*await\s+params\s*;\s*let\s+page\s*=\s*await\s+[\w.]+\([^;]*\)\s*;\s*$/.test(prefix);
   if(matches.length===1 && fetches.length===1 && simpleScope && !/\/\*|\/\/|`/.test(prefix) && ['locale','site','path'].every(n=>names.includes(n)) && !/applyResolverStrategy|['"]use client['"]/.test(content)){
    const directive=content.match(/^(?:\s*['"]use (?:server|strict)['"];?\s*)*/)?.[0]||'';
    const bytes=Buffer.from(directive+imp+content.slice(directive.length,pos)+block+content.slice(pos));
    specs.push({path:route,bytes});routeOutcome='proposed';
   }
  }
 }
 if(routeOutcome==='unresolved') unresolved.push('route integration unresolved: select --route with supported mutable page fetch and locale/site/path bindings, or integrate manually; no partial patch written.');
 if(mock){
  const marker='{/* kajoo-mock-preview-navigation */}';
  const hook=[marker,"{process.env.USE_MOCK_LAYOUT_SERVICE === 'true' && (",'  <script src="/mock-preview/navigation.js" defer />',')}'].join('\n');
  const candidates=(o.layout?[o.layout]:['src/app/layout.tsx','app/layout.tsx']).filter(p=>read(relative(target,p)));
  if(candidates.length===1){
   const layout=candidates[0], content=read(relative(target,layout)).toString(), normalized=content.replace(/\r\n/g,'\n');
   preview.layout.path=layout;
   if(normalized.includes(hook))preview.layout.outcome='already-integrated';
   else if(!content.includes(marker)&&!content.includes('/mock-preview/navigation.js')&&!/['"]use client['"]/.test(content)&&(content.match(/<body(?:\s[^>]*)?>/g)||[]).length===1&&(content.match(/<\/body>/g)||[]).length===1){
    const nl=content.includes('\r\n')?'\r\n':'\n';
    const bytes=Buffer.from(content.replace('</body>',hook.replaceAll('\n',nl)+nl+'</body>'));
    specs.push({path:layout,bytes});preview.layout.outcome='proposed';
   }
  }
  if(preview.layout.outcome==='unresolved')unresolved.push('Mock preview layout integration unresolved: supply one supported server root layout with a body or use --layout; no partial patch written.');
 }
 const approvals=new Map();
 for(const entry of o.overwrite){
  const at=entry.lastIndexOf(':'); const rel=entry.slice(0,at), digest=entry.slice(at+1);
  relative(target,rel);
  if(at<1||!/^[a-f0-9]{64}$/.test(digest)||approvals.has(rel)) throw Error('Overwrite requires exact relative-path:beforeHash');
  approvals.set(rel,digest);
 }
 const seen=new Set();
 const files=specs.map(spec=>{
  if(seen.has(spec.path)) throw Error('Duplicate target: '+spec.path);
  seen.add(spec.path);
  const full=relative(target,spec.path), before=read(full);
  if(before && fs.statSync(full).nlink>1) throw Error('Hard-linked target rejected: '+spec.path);
  const beforeHash=before?hash(before):null, afterHash=hash(spec.bytes);
  const approved=approvals.get(spec.path);
  if(approved&&approved!==beforeHash) throw Error('Stale overwrite approval: '+spec.path);
  const action=beforeHash===afterHash?'unchanged':before?'conflict':'create';
  return {...spec,full,before,beforeHash,afterHash,action:action==='conflict'&&approved?'replace':action};
 });
 for(const rel of approvals.keys()) if(!seen.has(rel)) throw Error('Approval does not match planned file: '+rel);
 const directories=mock?['public/mock-layouts','public/mock-dictionary','public/mock-preview']:[];
 for(const dir of directories){const p=relative(target,dir);if(fs.existsSync(p)&&!fs.statSync(p).isDirectory())throw Error('Expected directory: '+dir);}
 if(o.apply){
  // Validate every destination before any write, including changed-since-plan checks.
  for(const f of files) if((read(f.full)?hash(read(f.full)):null)!==f.beforeHash)throw Error('Target changed during planning: '+f.path);
  for(const f of files){
   if(!['create','replace'].includes(f.action))continue;
   relative(target,f.path);
   fs.mkdirSync(path.dirname(f.full),{recursive:true});
   if(f.action==='replace'){
    let n=0;
    while(true){
     const backup=f.path+'.bak.'+f.beforeHash.slice(0,12)+'.'+n++;
     const dest=relative(target,backup);
     try{fs.writeFileSync(dest,f.before,{flag:'wx',mode:0o600});f.backup=backup;break;}
     catch(e){if(e.code!=='EEXIST')throw e;}
    }
    if(hash(fs.readFileSync(f.full))!==f.beforeHash)throw Error('Target changed before replacement: '+f.path);
    fs.writeFileSync(f.full,f.bytes);
   } else fs.writeFileSync(f.full,f.bytes,{flag:'wx',mode:f.path==='.env.local'?0o600:0o644});
  }
  for(const dir of directories)fs.mkdirSync(relative(target,dir),{recursive:true});
 }
 if(mock&&preview.layout.outcome==='proposed'&&o.apply)preview.layout.outcome=files.find(f=>f.path===preview.layout.path)?.action==='replace'?'patched':'conflict';
 return {...(mock?{preview}:{}),mode:o.apply?'apply':'plan',target,files:files.map(({path,action,beforeHash,afterHash,backup})=>({path,action,beforeHash,afterHash,...(backup?{backup}:{})})),directories,envKeys,provenance,route:{path:route||null,outcome:routeOutcome==='proposed'&&o.apply?(files.find(f=>f.path===route)?.action==='replace'?'patched':'conflict'):routeOutcome},unresolved};
}
export function output(result) {
 console.log(JSON.stringify(result,null,2));
 process.exitCode=result.files.some(f=>f.action==='conflict')?2:0;
}
