import fs from 'node:fs';
import path from 'node:path';
import {isScalar} from 'yaml';
import {args,required,inspect,writeReport,run,guid,safe,separate,walk,readItem,readBytes,hash,verifyManifest,cmp} from './core.mjs';
run(()=>{
  const a=args(['items-root','modules-root','target-root','output-root','from','to','apply','approval']);
  required(a,'items-root','modules-root','target-root','output-root','from','to');
  if(a.apply&&!a.approval?.trim()) throw Error('--apply requires --approval decision reference');
  const source=safe(a['items-root']),target=safe(a['target-root']),output=safe(a['output-root']),modules=safe(a['modules-root']);
  for(const input of [source,modules]) {separate(input,target);separate(input,output);} separate(target,output);
  if(fs.existsSync(target)) throw Error('Target must not exist; use a fresh separate copy');
  if(fs.existsSync(path.join(output,'remap.json'))) throw Error('Report already exists');
  const from=guid(a.from),to=guid(a.to); if(from===to) throw Error('from and to must differ');
  const input=inspect(source,modules); if(!input.valid) throw Error(`Invalid capture: ${JSON.stringify(input.diagnostics)}`);
  const files=walk(source);
  if(files.some(f=>! /\.ya?ml$/i.test(f))) throw Error('Source copy accepts only serialized YAML files; keep CLI configuration and credentials outside items-root');
  const edits=[],otherOccurrences=[];
  for(const item of input.items) {
    const bytes=readBytes(path.join(source,item.file));
    if(hash(bytes)!==item.sha256) throw Error(`Source changed during inspection: ${item.file}`);
    const {text,doc,template}=readItem(path.join(source,item.file),bytes);
    const node=doc.get('Template',true);
    if(!isScalar(node)||!node.range) throw Error(`Unsupported Template scalar: ${item.file}`);
    for(const m of text.matchAll(/\{?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\}?|\b[\da-f]{32}\b/gi)) {
      if(guid(m[0])===from && !(m.index>=node.range[0]&&m.index<node.range[1])) otherOccurrences.push({file:item.file,item:item.id,offset:m.index,value:m[0]});
    }
    if(template!==from) continue;
    const before=text.slice(node.range[0],node.range[1]);
    const after=JSON.stringify(to);
    const updated=text.slice(0,node.range[0])+after+text.slice(node.range[1]);
    edits.push({file:item.file,item:item.id,path:item.path,sourceSha256:item.sha256,before,after,updated,backup:a.apply?path.join(target,'.serialization-backup',item.file+'.bak'):null});
  }
  const report={version:1,mode:a.apply?'apply':'dryrun',approval:a.approval??null,from,to,targetTemplateCaptured:input.items.some(i=>i.id===to),missingReferences:input.missingReferences,edits:edits.map(({updated,...e})=>e),otherOccurrences,backupRoot:a.apply?path.join(target,'.serialization-backup'):null,validation:'local YAML/header only; target template compatibility and transfer unverified'};
  report.inputManifest=input.inputManifest;
  report.targetRoot=target;
  report.producedFiles=[];
  const record=(file,kind,sourcePath,expected)=>{
    const bytes=readBytes(file),sha256=hash(bytes);
    report.producedFiles.push({path:path.relative(target,file),kind,sourcePath,sha256,bytes:bytes.length});
    if(sha256!==expected) throw Error(`Produced file hash mismatch: ${file}`);
  };
  verifyManifest(input.inputManifest);
  if(a.apply) {
    if(!edits.length) throw Error('No matching template headers to apply');
    // Claim a new directory exclusively. Never overwrite an existing target or backup.
    fs.mkdirSync(path.dirname(target),{recursive:true}); fs.mkdirSync(target);
    try {
      if(files.some(f=>path.relative(source,f).split(path.sep)[0]==='.serialization-backup')) throw Error('Reserved backup path in source');
      for(const file of files) {
        const rel=path.relative(source,file),dest=path.join(target,rel);
        safe(dest);fs.mkdirSync(path.dirname(dest),{recursive:true});
        const edit=edits.find(e=>e.file===rel);
        const bytes=readBytes(file),expected=input.items.find(i=>i.file===rel).sha256;
        if(hash(bytes)!==expected) throw Error(`Source changed before copy: ${rel}`);
        if(edit) {
          const backup=path.join(target,'.serialization-backup',rel+'.bak');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,bytes,{flag:'wx'});
          record(backup,'backup',rel,expected);
          fs.writeFileSync(dest,edit.updated,{flag:'wx'});
          record(dest,'edit',rel,hash(edit.updated));
          if(readItem(dest).template!==to) throw Error(`Post-write validation failed: ${rel}`);
        } else { fs.writeFileSync(dest,bytes,{flag:'wx'});record(dest,'copy',rel,expected); }
      }
      verifyManifest(input.inputManifest);
      report.status='complete';
    } catch(e) {report.status='partial-failure';report.error=e.message;process.exitCode=2;}
  }
  report.producedFiles.sort((a,b)=>cmp(a.path,b.path));
  writeReport(output,'remap.json',report,[source,modules,target]);
});
