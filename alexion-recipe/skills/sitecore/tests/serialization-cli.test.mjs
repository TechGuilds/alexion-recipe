import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original=fileURLToPath(new URL('../scripts/serialization/',import.meta.url));
const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'serialization-cli-'));
const copied=path.join(base,'copied-skill','scripts','serialization');
fs.cpSync(original,copied,{recursive:true,filter:p=>!p.includes('node_modules')});
// The focused suite must run offline. The workspace has the same major YAML
// dependency available, so expose it to the copied, repository-independent
// script fixture without running a package manager during tests.
const yaml=path.resolve(process.cwd(),'node_modules','yaml');
assert.ok(fs.existsSync(yaml),'workspace YAML dependency is required for this suite');
fs.mkdirSync(path.join(copied,'node_modules'),{recursive:true});
fs.symlinkSync(yaml,path.join(copied,'node_modules','yaml'),'junction');
const id=n=>`${String(n).padStart(8,'0')}-0000-0000-0000-000000000000`;
function fixture() {
  const root=fs.mkdtempSync(path.join(base,'case-')),items=path.join(root,'items'),modules=path.join(root,'modules');
  fs.mkdirSync(items);fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules,'x.module.json'),JSON.stringify({namespace:'Template.Foundation',items:{includes:[{name:'templates',path:'/sitecore/templates',scope:'ItemAndDescendants'}]}}));
  return {root,items,modules};
}
function item(f,n,template=id(99),extra='') {
  const text=`---\n# retained comment\nID: "${id(n)}"\nPath: /sitecore/templates/T${n}\nTemplate: "${template}" # header comment\n${extra}`;
  fs.writeFileSync(path.join(f.items,`${n}.yml`),text);return text;
}
function cli(f,name,extra=[],status=0) {
  const output=path.join(f.root,`report-${fs.readdirSync(f.root).length}`);
  const roots=name==='compile-task-scopes'?[]:['--items-root',f.items,'--modules-root',f.modules];
  const result=spawnSync(process.execPath,[path.join(copied,name+'.mjs'),...roots,'--output-root',output,...extra],{cwd:os.tmpdir(),encoding:'utf8'});
  assert.equal(result.status,status,result.stderr);
  const filename=({ 'inspect-items':'inspection','plan-batches':'plan','remap-templates':'remap','validate-transfer-plan':'transfer-preflight','compile-task-scopes':'task-scope-manifest'})[name];
  return fs.existsSync(path.join(output,filename+'.json'))?JSON.parse(fs.readFileSync(path.join(output,filename+'.json'),'utf8')):result;
}
function serialization(f,name,extra=[],env={},status=0) {
 const result=spawnSync(process.execPath,[path.join(copied,name+'.mjs'),...extra],{cwd:os.tmpdir(),encoding:'utf8',env:{...process.env,...env}});
 assert.equal(result.status,status,result.stderr);
 return result;
}
function coverageAudit(f,inspection,pathMap) {
 const output=path.join(f.root,`coverage-audit-${fs.readdirSync(f.root).length}`);
 const args=['--inspection-report',inspection,'--output-root',output,...(pathMap?['--target-path-map',pathMap]:[])];
 const result=spawnSync(process.execPath,[path.join(copied,'prepare-coverage-audit.mjs'),...args],{cwd:os.tmpdir(),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(fs.readFileSync(path.join(output,'content-coverage-audit-plan.json'),'utf8'));
}
test('copied skill inspects normalized IDs and preserves exact namespace',()=>{
 const f=fixture();item(f,1);const r=cli(f,'inspect-items');assert.equal(r.items[0].id,id(1));assert.equal(r.modules[0].namespace,'Template.Foundation');assert.equal(r.missingReferences[0].kind,'template');
});
test('copied inspection matches Sitecore include ownership without changing the source path casing',()=>{
 const f=fixture();
 const source=item(f,1).replace('/sitecore/templates/T1','/sitecore/Templates/T1');
 fs.writeFileSync(path.join(f.items,'1.yml'),source);
 const r=cli(f,'inspect-items');
 assert.equal(r.valid,true);
 assert.equal(r.items[0].path,'/sitecore/Templates/T1');
});
test('coverage audit preparation reuses inspection evidence for one target-root count plan',()=>{
 const f=fixture();
 fs.writeFileSync(path.join(f.modules,'content.module.json'),JSON.stringify({namespace:'Content.Project',items:{includes:[{name:'site',path:'/sitecore/content/Example',scope:'ItemAndDescendants'}]}}));
 fs.writeFileSync(path.join(f.items,'1.yml'),`ID: "${id(1)}"\nPath: /sitecore/templates/T1\nTemplate: "${id(99)}"\n`);
 fs.writeFileSync(path.join(f.items,'2.yml'),`ID: "${id(2)}"\nPath: /sitecore/content/Example/Home\nTemplate: "${id(99)}"\n`);
 fs.writeFileSync(path.join(f.items,'3.yml'),`ID: "${id(3)}"\nPath: /sitecore/content/Example/About\nTemplate: "${id(99)}"\n`);
 const inspectionRoot=path.join(f.root,'inspection');
 serialization(f,'inspect-items',['--items-root',f.items,'--modules-root',f.modules,'--output-root',inspectionRoot]);
 const pathMap=path.join(f.root,'target-path-map.json');
 fs.writeFileSync(pathMap,JSON.stringify({version:1,mappings:[{sourcePrefix:'/sitecore/content/Example',targetPrefix:'/sitecore/content/Tenant/Example'}]}));
 const first=coverageAudit(f,path.join(inspectionRoot,'inspection.json'),pathMap);
 const second=coverageAudit(f,path.join(inspectionRoot,'inspection.json'),pathMap);
 const content=first.targetIncludes.find(row=>row.namespace==='Content.Project');
 assert.deepEqual(content,{namespace:'Content.Project',sourcePath:'/sitecore/content/Example',targetPath:'/sitecore/content/Tenant/Example',scope:'ItemAndDescendants',expectedItemCount:2});
 assert.equal(first.expectedItemCount,3);
 assert.deepEqual(first,second);
 assert.deepEqual(first.expectedNamespaces,[{namespace:'Content.Project',expectedItemCount:2},{namespace:'Template.Foundation',expectedItemCount:1}]);
});
test('copied inspection accepts a Sitecore-generated percent-leading scalar as a warning',()=>{
 const f=fixture();
 item(f,1,id(99),`SharedFields:\n- ID: "${id(5)}"\n  Value: %n returned for '%q'\n`);
 const r=cli(f,'inspect-items');
 assert.equal(r.valid,true);
 assert.equal(r.warnings.length,1);
 assert.match(r.warnings[0].message,/directive indicator/i);
});
test('copied batch planning records ordinary field GUIDs without making them ordering edges',()=>{
 const f=fixture();
 fs.writeFileSync(path.join(f.modules,'x.module.json'),JSON.stringify({namespace:'A',items:{includes:[{name:'t1',path:'/sitecore/templates/T1',scope:'SingleItem'}]}}));
 fs.writeFileSync(path.join(f.modules,'y.module.json'),JSON.stringify({namespace:'B',items:{includes:[{name:'t2',path:'/sitecore/templates/T2',scope:'SingleItem'}]}}));
 item(f,1,'00000000-0000-0000-0000-000000000000');
 item(f,2,'00000000-0000-0000-0000-000000000000',`SharedFields:\n- ID: "${id(5)}"\n  Value: "{${id(1)}}"\n`);
 const r=cli(f,'plan-batches');
 assert.equal(r.ready,true);
 assert.deepEqual(r.batches.map(batch=>batch.namespaces),[['A','B']]);
 assert.deepEqual(r.missingReferences,[]);
 assert.deepEqual(r.softReferences,[{item:id(2),id:id(1),kind:'field-reference'}]);
});
test('copied plans bind every item and module byte including invalid inputs',()=>{
 const f=fixture();item(f,1);item(f,2);
 const first=cli(f,'plan-batches',[],2);
 assert.equal(first.inputManifest.files.length,3);
 assert.deepEqual(first.inputManifest.roots,{items:f.items,modules:f.modules});
 for(const entry of first.inputManifest.files) assert.equal(entry.sha256,hash(fs.readFileSync(path.join(first.inputManifest.roots[entry.role],entry.path))));
 assert.deepEqual(first,cli(f,'plan-batches',[],2));
 fs.appendFileSync(path.join(f.items,'2.yml'),'# changed bytes\n');
 const second=cli(f,'plan-batches',[],2);assert.notDeepEqual(first.inputManifest,second.inputManifest);assert.deepEqual(first.batches,second.batches);
 fs.appendFileSync(path.join(f.modules,'x.module.json'),'\n');
 const third=cli(f,'plan-batches',[],2);assert.notDeepEqual(second.inputManifest,third.inputManifest);
 fs.writeFileSync(path.join(f.items,'bad.yml'),'ID: [');
 assert.ok(cli(f,'inspect-items',[],2).inputManifest.files.some(e=>e.path==='bad.yml'));
});
test('copied remap manifests include unchanged copies, edits and exact backups',()=>{
 const f=fixture();item(f,1);item(f,2,id(98));const target=path.join(f.root,'target');
 const params=['--target-root',target,'--from',id(99),'--to',id(98)];
 const preview=cli(f,'remap-templates',params);
 assert.equal(preview.inputManifest.files.length,3);assert.deepEqual(preview.producedFiles,[]);
 const applied=cli(f,'remap-templates',[...params,'--apply','--approval','reviewed']);
 assert.deepEqual(applied.inputManifest,preview.inputManifest);
 assert.deepEqual(applied.producedFiles.map(e=>e.kind).sort(),['backup','copy','edit']);
 for(const entry of applied.producedFiles) assert.equal(entry.sha256,hash(fs.readFileSync(path.join(target,entry.path))));
 assert.equal(applied.producedFiles.find(e=>e.kind==='backup').sha256,hash(fs.readFileSync(path.join(f.items,'1.yml'))));
});
test('copied remap preserves a UTF-8 BOM and rejects malformed UTF-8',()=>{
 const f=fixture(),source='\ufeff'+item(f,1);fs.writeFileSync(path.join(f.items,'1.yml'),source);
 const target=path.join(f.root,'target');
 const r=cli(f,'remap-templates',['--target-root',target,'--from',id(99),'--to',id(98),'--apply','--approval','reviewed']);
 assert.equal(fs.readFileSync(path.join(target,'1.yml'),'utf8'),source.replace(`Template: "${id(99)}"`,`Template: "${id(98)}"`));
 assert.equal(r.inputManifest.files.find(e=>e.role==='items').sha256,hash(Buffer.from(source)));
 fs.appendFileSync(path.join(f.items,'1.yml'),Buffer.from([0xff])); assert.equal(cli(f,'inspect-items',[],2).valid,false);
});
test('copied inspection rejects module symlinks and item hardlinks',(t)=>{
 const f=fixture();item(f,1);const outside=path.join(f.root,'outside.module.json');fs.renameSync(path.join(f.modules,'x.module.json'),outside);
 try { fs.symlinkSync(outside,path.join(f.modules,'x.module.json')); } catch (error) { if (error.code==='EPERM') return t.skip('symlink creation is unavailable on this Windows host'); throw error; }
 cli(f,'inspect-items',[],1);
 fs.unlinkSync(path.join(f.modules,'x.module.json'));fs.renameSync(outside,path.join(f.modules,'x.module.json'));
 fs.linkSync(path.join(f.items,'1.yml'),path.join(f.root,'outside.yml'));
 assert.equal(cli(f,'inspect-items',[],2).valid,false);
});
test('malformed YAML, duplicates and missing Template fail with diagnostics',()=>{
 const f=fixture();item(f,1);fs.copyFileSync(path.join(f.items,'1.yml'),path.join(f.items,'duplicate.yml'));fs.writeFileSync(path.join(f.items,'bad.yml'),'ID: [');fs.writeFileSync(path.join(f.items,'missing.yml'),`ID: ${id(2)}\nPath: /sitecore/templates/Missing\n`);
 const r=cli(f,'inspect-items',[],2);assert.ok(r.diagnostics.some(x=>x.error.includes('Duplicate id')));assert.ok(r.diagnostics.length>=4);
});
test('cycles are reported including same-namespace inheritance',()=>{
 const f=fixture();item(f,1,id(2));item(f,2,id(1));const r=cli(f,'plan-batches',[],2);assert.deepEqual(r.itemCycles,[[id(1),id(2)]]);assert.equal(r.ready,false);
});
test('container and dependency ordering use exact names and deterministic batches',()=>{
 const f=fixture();fs.writeFileSync(path.join(f.modules,'x.module.json'),JSON.stringify({namespace:'Template.Foundation._containers',items:{includes:[{name:'t1',path:'/sitecore/templates/T1',scope:'SingleItem'}]}}));
 fs.writeFileSync(path.join(f.modules,'y.module.json'),JSON.stringify({namespace:'Template.Foundation',items:{includes:[{name:'t2',path:'/sitecore/templates/T2',scope:'SingleItem'}]}}));
 item(f,1);item(f,2,id(1));const r=cli(f,'plan-batches',['--batch-size','1'],2);assert.deepEqual(r.batches.map(b=>b.namespaces),[['Template.Foundation._containers'],['Template.Foundation']]);assert.deepEqual(r.batches[1].prerequisites,['Template.Foundation._containers']);assert.deepEqual(r,cli(f,'plan-batches',['--batch-size','1'],2));
});
test('dryrun and approved apply preserve source, fields, comments and backup bytes',()=>{
 const f=fixture();const source=item(f,1,id(99),`SharedFields:\n- ID: "${id(5)}"\n  Value: "{${id(99)}}"\n`);const unchanged=item(f,2,id(98));const target=path.join(f.root,'target');const params=['--target-root',target,'--from',id(99),'--to',id(98)];
 const preview=cli(f,'remap-templates',params);assert.equal(preview.edits.length,1);assert.equal(preview.otherOccurrences.length,1);assert.equal(fs.existsSync(target),false);
 cli(f,'remap-templates',[...params,'--apply'],1);assert.equal(fs.existsSync(target),false);
 const result=cli(f,'remap-templates',[...params,'--apply','--approval','decision-1']);assert.equal(result.status,'complete');
 assert.equal(fs.readFileSync(path.join(f.items,'1.yml'),'utf8'),source);assert.equal(fs.readFileSync(path.join(target,'.serialization-backup','1.yml.bak'),'utf8'),source);assert.equal(fs.readFileSync(path.join(target,'2.yml'),'utf8'),unchanged);
 assert.equal(fs.readFileSync(path.join(target,'1.yml'),'utf8'),source.replace(`Template: "${id(99)}"`,`Template: "${id(98)}"`));
 cli(f,'remap-templates',[...params,'--apply','--approval','decision-1'],1);
});
test('overlap, symlinks, auth files and duplicate options fail before copying',(t)=>{
 const f=fixture();item(f,1);const params=['--from',id(99),'--to',id(98)];
 cli(f,'remap-templates',[...params,'--target-root',path.join(f.items,'target')],1);
 const link=path.join(f.root,'link');
 try { fs.symlinkSync(f.items,link); } catch (error) { if (error.code==='EPERM') { t.diagnostic('symlink assertion skipped: unavailable on this Windows host'); } else throw error; }
 if (fs.existsSync(link)) cli(f,'remap-templates',[...params,'--target-root',path.join(link,'target')],1);
 fs.writeFileSync(path.join(f.items,'user.json'),'secret');cli(f,'remap-templates',[...params,'--target-root',path.join(f.root,'target'),'--apply','--approval','x'],1);assert.equal(fs.existsSync(path.join(f.root,'target')),false);
 cli(f,'inspect-items',['--items-root',f.items],1);
 try { fs.symlinkSync(path.join(f.items,'1.yml'),path.join(f.items,'link.yml')); }
 catch (error) { if (error.code==='EPERM') return t.diagnostic('file-symlink assertion skipped: unavailable on this Windows host'); throw error; }
 cli(f,'inspect-items',[],1);
});
test('dependency edges override name heuristics and cycles distinguish blocked dependents',()=>{
 const f=fixture();
 for(const [n,namespace] of [[1,'Template'],[2,'Content'],[3,'After']]) fs.writeFileSync(path.join(f.modules,`${n}.module.json`),JSON.stringify({namespace,items:{includes:[{name:`t${n}`,path:`/sitecore/templates/T${n}`,scope:'SingleItem'}]}}));
 fs.unlinkSync(path.join(f.modules,'x.module.json'));
 item(f,1,id(2));item(f,2);item(f,3,id(1));
 let r=cli(f,'plan-batches',[],2);assert.deepEqual(r.batches.map(b=>b.namespaces),[['Content'],['Template'],['After']]);
 item(f,2,id(1));r=cli(f,'plan-batches',[],2);assert.deepEqual(r.namespaceCycles,[['Content','Template']]);assert.deepEqual(r.blockedNamespaces,['After','Content','Template']);assert.deepEqual(r.batches,[]);
});
test('CRLF, base-template lists and ID headers survive header-only remapping',()=>{
 const f=fixture();let source=item(f,1,id(99),`SharedFields:\n- ID: "12c33f3f-86c5-43a5-aeb4-5598cec45116"\n  Value: "{${id(99)}}|{${id(98)}}"\n`).replaceAll('\n','\r\n');fs.writeFileSync(path.join(f.items,'1.yml'),source);
 const target=path.join(f.root,'target');const r=cli(f,'remap-templates',['--target-root',target,'--from',id(99),'--to',id(98),'--apply','--approval','approved']);
 assert.equal(r.otherOccurrences.length,1);assert.equal(fs.readFileSync(path.join(target,'1.yml'),'utf8'),source.replace(`Template: "${id(99)}"`,`Template: "${id(98)}"`));
 const inspection=cli(f,'inspect-items');assert.ok(inspection.items[0].dependencies.some(d=>d.kind==='base-template'));
});
test('exclusive report writes preserve existing evidence and numeric arguments are validated',()=>{
 const f=fixture();item(f,1);const output=path.join(f.root,'existing');fs.mkdirSync(output);fs.writeFileSync(path.join(output,'inspection.json'),'original');
 const r=spawnSync(process.execPath,[path.join(copied,'inspect-items.mjs'),'--items-root',f.items,'--modules-root',f.modules,'--output-root',output],{encoding:'utf8'});assert.equal(r.status,1);assert.equal(fs.readFileSync(path.join(output,'inspection.json'),'utf8'),'original');
 cli(f,'plan-batches',['--batch-size','NaN'],1);cli(f,'plan-batches',['--runtime-budget-seconds','0'],1);
});
test('duplicate YAML keys, path traversal and unsupported module rules produce diagnostics',()=>{
 const f=fixture();const text=item(f,1);fs.writeFileSync(path.join(f.items,'1.yml'),text+`ID: "${id(2)}"\n`);assert.equal(cli(f,'inspect-items',[],2).valid,false);
 fs.writeFileSync(path.join(f.items,'1.yml'),text.replace('/sitecore/templates/T1','/sitecore/../T1'));assert.ok(cli(f,'inspect-items',[],2).diagnostics.some(d=>d.error.includes('Invalid item Path')));
 fs.writeFileSync(path.join(f.modules,'x.module.json'),JSON.stringify({namespace:'X',items:{includes:[{name:'templates',path:'/sitecore/templates',rules:[]}]}}));assert.ok(cli(f,'inspect-items',[],2).diagnostics.some(d=>d.error.includes('Unsupported')));
});
test('transfer preflight requires one task owner and an ordered dependency closure',()=>{
 const f=fixture();
 item(f,1);item(f,2,id(1));
 fs.writeFileSync(path.join(f.modules,'x.module.json'),JSON.stringify({namespace:'Template.Foundation',items:{includes:[{name:'t1',path:'/sitecore/templates/T1',scope:'SingleItem'}]}}));
 fs.writeFileSync(path.join(f.modules,'y.module.json'),JSON.stringify({namespace:'Template.Project',items:{includes:[{name:'t2',path:'/sitecore/templates/T2',scope:'SingleItem'}]}}));
 const plan=path.join(f.root,'task-plan.json');
 const writePlan=value=>fs.writeFileSync(plan,JSON.stringify(value));
 const base={version:1,approvedExternalDependencies:[{id:id(99),decisionId:'decision.platform-template',rationale:'Approved platform prerequisite'}],tasks:[
   {id:'foundation',namespaces:['Template.Foundation'],dependsOn:[]},
   {id:'project',namespaces:['Template.Project'],dependsOn:['foundation']},
 ]};
 writePlan(base);
 let r=cli(f,'validate-transfer-plan',['--task-plan',plan]);
 assert.equal(r.ready,true);assert.deepEqual(r.taskCounts.map(x=>[x.id,x.itemCount]),[['foundation',1],['project',1]]);
 assert.deepEqual(r.crossTaskDependencyErrors,[]);
 writePlan({...base,tasks:[base.tasks[0],{...base.tasks[1],dependsOn:[]}]});
 r=cli(f,'validate-transfer-plan',['--task-plan',plan],2);
 assert.equal(r.ready,false);assert.equal(r.crossTaskDependencyErrors.length,1);
 writePlan({...base,tasks:[base.tasks[0],{...base.tasks[1],namespaces:['Template.Project','Template.Foundation']} ]});
 r=cli(f,'validate-transfer-plan',['--task-plan',plan],2);
 assert.equal(r.ready,false);assert.equal(r.ownershipOverlaps.length,1);
 writePlan({...base,tasks:[{...base.tasks[1],dependsOn:[]}]});
 r=cli(f,'validate-transfer-plan',['--task-plan',plan],2);
 assert.equal(r.ready,false);assert.equal(r.unassignedItems.length,1);
});
test('task-scope compiler rejects a user task label that omits a referenced content subtree',()=>{
 const f=fixture(),index=path.join(f.root,'dependency-index.json'),plan=path.join(f.root,'task-scope-plan.json');
 const page=id(1),template=id(2),featureInfo=id(3),heroSlides=id(4);
 const dependencyIndex={version:1,status:'complete',nodes:[
   {id:template,path:'/sitecore/templates/Project/Example/Page',kind:'template',language:'en',version:'1'},
   {id:page,path:'/sitecore/content/Example/Home',kind:'content',language:'en',version:'1'},
   {id:featureInfo,path:'/sitecore/content/Data/Carousel/Feature Info Blocks/Promo',kind:'datasource',language:'en',version:'1'},
   {id:heroSlides,path:'/sitecore/content/Data/Carousel/Hero Carousel Slides/Slide A',kind:'datasource',language:'en',version:'1'},
 ],edges:[
   {status:'resolved',consumer:{id:page,language:'en',version:'1'},targetId:template,language:'en',version:'1',relation:'item-template'},
   {status:'resolved',consumer:{id:page,language:'en',version:'1'},targetId:heroSlides,language:'en',version:'1',relation:'datasource'},
 ]};
 fs.writeFileSync(index,JSON.stringify(dependencyIndex));
 const base={version:1,tasks:[
   {id:'backbone',roots:['/sitecore/templates/Project/Example'],dependsOn:[]},
   {id:'site-root',roots:['/sitecore/content/Example'],dependsOn:['backbone','shared-carousel']},
   {id:'shared-carousel',roots:['/sitecore/content/Data/Carousel/Feature Info Blocks'],dependsOn:[]},
 ]};
 fs.writeFileSync(plan,JSON.stringify(base));
 fs.writeFileSync(index,JSON.stringify({...dependencyIndex,status:'partial'}));
 const incomplete=cli(f,'compile-task-scopes',['--dependency-index',index,'--task-scope-plan',plan],1);
 assert.match(incomplete.stderr,/status complete/i);
 fs.writeFileSync(index,JSON.stringify(dependencyIndex));
 let r=cli(f,'compile-task-scopes',['--dependency-index',index,'--task-scope-plan',plan],2);
 assert.equal(r.ready,false);
 assert.deepEqual(r.unassignedItems.map(row=>row.path),['/sitecore/content/Data/Carousel/Hero Carousel Slides/Slide A']);
 assert.equal(r.uncoveredDependencies.length,1);
 fs.writeFileSync(plan,JSON.stringify({...base,tasks:base.tasks.map(task=>task.id==='shared-carousel'?{...task,roots:[...task.roots,'/sitecore/content/Data/Carousel/Hero Carousel Slides']}:task)}));
 r=cli(f,'compile-task-scopes',['--dependency-index',index,'--task-scope-plan',plan]);
 assert.equal(r.ready,true);
 assert.equal(r.scopeItemCount,4);
 const scopePath=fs.readdirSync(f.root).map(name=>path.join(f.root,name,'scope-items.json')).filter(candidate=>fs.existsSync(candidate)).sort().at(-1);
 const scope=JSON.parse(fs.readFileSync(scopePath,'utf8'));
 assert.equal(scope.status,'complete');
 assert.equal(scope.items.length,4);
});
test('task-scope compiler accepts approved external prerequisites and non-owning audit tasks',()=>{
 const f=fixture(),index=path.join(f.root,'dependency-index.json'),plan=path.join(f.root,'task-scope-plan.json');
 const platformTemplate=id(21),page=id(22);
 fs.writeFileSync(index,JSON.stringify({version:1,status:'complete',nodes:[
   {id:platformTemplate,path:'/sitecore/templates/System/Folder',kind:'template',language:'en',version:'1'},
   {id:page,path:'/sitecore/content/Example/Home',kind:'content',language:'en',version:'1'},
 ],edges:[
   {status:'resolved',consumer:{id:page,language:'en',version:'1'},targetId:platformTemplate,language:'en',version:'1',relation:'item-template'},
 ]}));
 fs.writeFileSync(plan,JSON.stringify({version:1,tasks:[
   {id:'content.site-root',roots:['/sitecore/content/Example'],dependsOn:[]},
   {id:'content.audit',role:'audit',roots:[],dependsOn:['content.site-root']},
 ],approvedExternalDependencies:[{id:platformTemplate,decisionId:'decision.platform-template',rationale:'Target platform prerequisite is intentionally not transferred'}]}));
 const result=cli(f,'compile-task-scopes',['--dependency-index',index,'--task-scope-plan',plan]);
 assert.equal(result.ready,true);
 assert.deepEqual(result.unassignedItems,[]);
 assert.deepEqual(result.taskCounts.map(row=>[row.id,row.itemCount]),[['content.audit',0],['content.site-root',1]]);
 const scopePath=fs.readdirSync(f.root).map(name=>path.join(f.root,name,'scope-items.json')).filter(candidate=>fs.existsSync(candidate)).sort().at(-1);
 const scope=JSON.parse(fs.readFileSync(scopePath,'utf8'));
 assert.deepEqual(scope.items,[{path:'/sitecore/content/Example/Home',kind:'content'}]);
});
test('CLI project preparation copies validated modules without mutating their source',()=>{
 const f=fixture();const before=fs.readFileSync(path.join(f.modules,'x.module.json'));
 const project=path.join(f.root,'cli-project'),output=path.join(f.root,'prepare-report');
 serialization(f,'prepare-cli-project',['--modules-root',f.modules,'--project-root',project,'--output-root',output]);
 assert.deepEqual(fs.readFileSync(path.join(f.modules,'x.module.json')),before);
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'cli-project.json'),'utf8'));
 assert.equal(manifest.modules[0].namespace,'Template.Foundation');
 assert.equal(manifest.sitecoreJson.plugins[0],'Sitecore.DevEx.Extensibility.Serialization@6.0.23');
 assert.ok(fs.existsSync(path.join(project,'modules','Template.Foundation','Template.Foundation.module.json')));
 serialization(f,'prepare-cli-project',['--modules-root',f.modules,'--project-root',project,'--output-root',path.join(f.root,'duplicate')],{},1);
});
test('module generation emits a transfer-compatible relative serialization path',()=>{
 const f=fixture(),input=path.join(f.root,'discovery.json'),output=path.join(f.root,'generated');
 fs.writeFileSync(input,JSON.stringify({items:[{path:'/sitecore/templates/Project/Example',kind:'template'}]}));
 const result=spawnSync(process.execPath,[path.join(copied,'build-modules.mjs'),'--input',input,'--output-root',output],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const module=JSON.parse(fs.readFileSync(path.join(output,'Template.Project.Example.module.json'),'utf8'));
  assert.equal(module.items.path,module.namespace);
 assert.match(module.items.includes[0].name,/^item-[a-f0-9]{16}$/);
 assert.equal(module.items.includes[0].scope,'SingleItem');
});
test('CLI wrapper uses role-scoped credentials, exact namespaces, and redacts secrets',()=>{
 const f=fixture(),project=path.join(f.root,'cli-project'),prepared=path.join(f.root,'prepared');
 serialization(f,'prepare-cli-project',['--modules-root',f.modules,'--project-root',project,'--output-root',prepared]);
 const fakeScript=path.join(f.root,'fake-sitecore.mjs'),fakeCmd=path.join(f.root,'fake-sitecore.cmd'),log=path.join(f.root,'calls.jsonl');
 fs.writeFileSync(fakeScript,`import fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.FAKE_SITECORE_LOG,JSON.stringify(args)+'\\n');\nconsole.log(args[0]==='--version'?'6.0.23':process.argv.join(' '));\nif(args[0]===process.env.FAKE_SITECORE_FAIL) process.exit(7);\n`);
 fs.writeFileSync(fakeCmd,`@echo off\nnode "${fakeScript}" %*\n`);
 const env={
  SITECORE_CLI_BIN:fakeCmd,FAKE_SITECORE_LOG:log,
  SOURCE_SITECORE_MANAGEMENT_SERVICE_CM:'https://source.example/cm',SOURCE_SITECORE_MANAGEMENT_SERVICE_AUTHORITY:'https://identity.example',SOURCE_SITECORE_MANAGEMENT_SERVICE_CLIENT_ID:'source-id',SOURCE_SITECORE_MANAGEMENT_SERVICE_CLIENT_SECRET:'source-secret',
 };
 const output=path.join(f.root,'pull-report');
 const probe=path.join(f.root,'probe-report');
 serialization(f,'run-cli-serialization',['--project-root',project,'--role','source','--operation','probe','--output-root',probe],env);
 const probeResult=JSON.parse(fs.readFileSync(path.join(probe,'serialization-operation.json'),'utf8'));
 assert.deepEqual(probeResult.cli,{requiredMajor:6,detectedMajor:6});
 assert.equal(probeResult.projectManifest.length,2);
 serialization(f,'run-cli-serialization',['--project-root',project,'--role','source','--operation','pull','--include','Template.Foundation,Content.Project','--output-root',output],env);
 const report=fs.readFileSync(path.join(output,'serialization-operation.json'),'utf8');
 assert.doesNotMatch(report,/source-secret/);
 assert.match(report,/\[REDACTED\]/);
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.at(-1),['ser','pull','-n','source','--include','Template.Foundation','Content.Project']);
 assert.ok(calls.some(call=>call[0]==='login'&&call.includes('source-secret')));
 const targetEnv={
  ...env,
  TARGET_SITECORE_MANAGEMENT_SERVICE_CM:'https://target.example/cm',TARGET_SITECORE_MANAGEMENT_SERVICE_AUTHORITY:'https://target.identity.example',TARGET_SITECORE_MANAGEMENT_SERVICE_CLIENT_ID:'target-id',TARGET_SITECORE_MANAGEMENT_SERVICE_CLIENT_SECRET:'target-secret',
 };
 const targetOutput=path.join(f.root,'target-report');
 serialization(f,'run-cli-serialization',['--project-root',project,'--role','target','--operation','push','--include','Content.Project','--what-if','--output-root',targetOutput],targetEnv);
 const targetReport=fs.readFileSync(path.join(targetOutput,'serialization-operation.json'),'utf8');
 assert.doesNotMatch(targetReport,/target-secret/);
 const targetCalls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(targetCalls.at(-1),['ser','push','-n','target','--include','Content.Project','--what-if']);
 const validationOutput=path.join(f.root,'validation-report');
 serialization(f,'run-cli-serialization',['--project-root',project,'--role','target','--operation','validate','--output-root',validationOutput],{SITECORE_CLI_BIN:fakeCmd,FAKE_SITECORE_LOG:log});
 const validationCalls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(validationCalls.at(-1),['ser','validate']);
 assert.equal(validationCalls.filter(call=>call[0]==='init').length,1,'one prepared project is initialized once across its capture and target checks');
 assert.equal(validationCalls.filter(call=>call[0]==='login').length,2,'only pull and push authenticate');
 const failure=serialization(f,'run-cli-serialization',['--project-root',project,'--role','source','--operation','pull','--output-root',path.join(f.root,'failed-pull')],{...env,FAKE_SITECORE_FAIL:'ser'},7);
 assert.equal(failure.status,7);
 serialization(f,'run-cli-serialization',['--project-root',project,'--role','target','--operation','pull','--output-root',path.join(f.root,'wrong-role')],env,1);
});
test('CLI wrapper rejects missing connector credentials before it invokes the CLI',()=>{
 const f=fixture(),project=path.join(f.root,'cli-project'),prepared=path.join(f.root,'prepared');
 serialization(f,'prepare-cli-project',['--modules-root',f.modules,'--project-root',project,'--output-root',prepared]);
 const result=serialization(f,'run-cli-serialization',['--project-root',project,'--role','source','--operation','login','--output-root',path.join(f.root,'missing')],{},1);
 assert.match(result.stderr,/Missing source connector credential environment/);
});
