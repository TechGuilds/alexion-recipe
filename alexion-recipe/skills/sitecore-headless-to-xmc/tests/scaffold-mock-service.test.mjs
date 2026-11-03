import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => {
 const p = spawnSync(process.execPath, [path.join(skill, 'scripts', 'scaffold-mock-service.mjs'), ...args], {encoding:'utf8'});
 return {code:p.status, data: p.stdout ? JSON.parse(p.stdout) : null};
};
const fixture = t => { const root=mkdtempSync(path.join(tmpdir(),'scaffold-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; };

test('mock scaffold preserves env values comments IDs and only proposes missing keys',t=>{
 const root=fixture(t), target=path.join(root,'app'); mkdirSync(target);
 const env='# keep\nSITECORE_EDGE_CONTEXT_ID=secret-id\nUSE_MOCK_LAYOUT_SERVICE=false\nMOCK_LAYOUT_DEBUG=true\n';
 writeFileSync(path.join(target,'.env.local'),env);
 let p=run('--target',target,'--apply'); assert.equal(p.code,2);
 assert.equal(readFileSync(path.join(target,'.env.local'),'utf8'),env);
 const f=p.data.files.find(f=>f.path==='.env.local');
 p=run('--target',target,'--apply','--overwrite','.env.local:'+f.beforeHash); assert.equal(p.code,0);
 assert.ok(readFileSync(path.join(target,'.env.local'),'utf8').startsWith(env));
 assert.ok(!JSON.stringify(p.data).includes('secret-id'));
 assert.ok(existsSync(path.join(target,'public/mock-dictionary')));
 assert.ok(existsSync(path.join(target,'src/components/content-sdk/RawFieldHtml.tsx')));
});
test('copied pair skill includes mock and resolver assets by default',t=>{
 const root=fixture(t), copy=path.join(root,'pair'); cpSync(skill,copy,{recursive:true});
 const p=spawnSync(process.execPath,[path.join(copy,'scripts/scaffold-mock-service.mjs'),'--target',path.join(root,'app'),'--apply'],{encoding:'utf8'});
 assert.equal(p.status,0); assert.equal(JSON.parse(p.stdout).files.length,17);
});
test('copied pair skill supports explicitly supplied resolver assets',t=>{
 const root=fixture(t), copy=path.join(root,'pair'); cpSync(skill,copy,{recursive:true});
 const assets=path.resolve(skill,'assets/resolver-framework');
 const p=spawnSync(process.execPath,[path.join(copy,'scripts/scaffold-mock-service.mjs'),'--target',path.join(root,'app'),'--resolver-assets',assets,'--apply'],{encoding:'utf8'});
 assert.equal(p.status,0); assert.equal(JSON.parse(p.stdout).files.length,17);
});


test('preview navigation installs public assets and proposes one mock-only root-layout hook', t => {
 const root=fixture(t), target=path.join(root,'app'); mkdirSync(path.join(target,'src/app'),{recursive:true});
 const source='export default function Root({children}) { return <html><body>{children}</body></html>; }\n';
 writeFileSync(path.join(target,'src/app/layout.tsx'),source);
 let p=run('--target',target,'--apply'); assert.equal(p.code,2,'existing layout needs reviewed overwrite');
 assert.equal(readFileSync(path.join(target,'src/app/layout.tsx'),'utf8'),source);
 const edit=p.data.files.find(f=>f.path==='src/app/layout.tsx'); assert.ok(edit);
 p=run('--target',target,'--apply','--overwrite','src/app/layout.tsx:'+edit.beforeHash); assert.equal(p.code,0);
 const layout=readFileSync(path.join(target,'src/app/layout.tsx'),'utf8');
 assert.ok(layout.includes('kajoo-mock-preview-navigation')); assert.ok(layout.includes("process.env.USE_MOCK_LAYOUT_SERVICE === 'true'"));
 assert.ok(layout.includes('/mock-preview/navigation.js'));
 assert.ok(existsSync(path.join(target,'public/mock-preview/navigation.js')));
 assert.deepEqual(JSON.parse(readFileSync(path.join(target,'public/mock-preview/routes.json'))),{routes:[]});
 p=run('--target',target,'--apply'); assert.equal(p.code,0);
 assert.equal(readFileSync(path.join(target,'src/app/layout.tsx'),'utf8'),layout);
 assert.equal(p.data.preview.layout.outcome,'already-integrated');
});

test('preview scaffold leaves unsupported root layouts unresolved without a partial patch', t => {
 const root=fixture(t), target=path.join(root,'app'); mkdirSync(path.join(target,'src/app'),{recursive:true});
 const source='export default () => <div>No document body</div>;'; writeFileSync(path.join(target,'src/app/layout.tsx'),source);
 const p=run('--target',target,'--apply'); assert.equal(p.code,0);
 assert.equal(readFileSync(path.join(target,'src/app/layout.tsx'),'utf8'),source);
 assert.equal(p.data.preview.layout.outcome,'unresolved');
 assert.ok(p.data.unresolved.some(x=>x.includes('preview')));
});


test('mock client resolves the exact case-sensitive captured route', () => {
 const template=readFileSync(path.join(skill,'assets/mock-layout-service/mock-sitecore-client.template.txt'),'utf8');
 const snippet=template.slice(template.indexOf('    const pathStr ='),template.indexOf("    debug('getPage called:'"));
 const normalize=new Function('path','debug',snippet+'\nreturn normalizedPath;');
 assert.equal(normalize('/Articles',()=>{}),'Articles');
 assert.equal(normalize('/',()=>{}),'home');
 assert.equal(normalize('/Some%20Page',()=>{}),'Some-Page');
 assert.equal(normalize('/articles/index',()=>{}),'articles/index');
 assert.equal(normalize('/news.json',()=>{}),'news.json');
 assert.equal(normalize('/page.css',()=>{}),'page.css');
});
