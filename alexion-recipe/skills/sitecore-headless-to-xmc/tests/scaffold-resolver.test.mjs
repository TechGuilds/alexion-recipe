import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => {
 const p = spawnSync(process.execPath, [path.join(skill, 'scripts', 'scaffold-resolver.mjs'), ...args], {encoding:'utf8'});
 return {code:p.status, data: p.stdout ? JSON.parse(p.stdout) : null};
};
const fixture = t => { const root=mkdtempSync(path.join(tmpdir(),'scaffold-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; };

test('plan is read only; apply is repeatable and preserves custom registrations', t => {
 const root=fixture(t), target=path.join(root,'app');
 let p=run('--target',target,'--dry-run');
 assert.equal(p.code,0); assert.ok(p.data.files.length>=8); assert.equal(existsSync(target),false);
 p=run('--target',target,'--apply'); assert.equal(p.code,0);
 const registry=path.join(target,'src/lib/server/resolver-registry.ts');
 writeFileSync(registry,'// custom registration ID abc\n');
 p=run('--target',target,'--apply'); assert.equal(p.code,2);
 assert.equal(readFileSync(registry,'utf8'),'// custom registration ID abc\n');
 const conflict=p.data.files.find(f=>f.path.endsWith('resolver-registry.ts'));
 p=run('--target',target,'--apply','--overwrite',conflict.path+':'+conflict.beforeHash);
 assert.equal(p.code,0);
 assert.equal(readFileSync(path.join(target,p.data.files.find(f=>f.backup).backup),'utf8'),'// custom registration ID abc\n');
 assert.equal(run('--target',target,'--apply').data.files.every(f=>f.action==='unchanged'),true);
});
test('rejects overlapping source, symlinks and stale overwrite approval before writes',t=>{
 const root=fixture(t), target=path.join(root,'app'); mkdirSync(target);
 assert.equal(run('--target',target,'--source',root,'--apply').code,1);
 try { symlinkSync(root,path.join(target,'src')); }
 catch (error) {
  if (process.platform === 'win32' && error?.code === 'EPERM') {
   t.skip('Windows host has no symlink privilege; exercised in Unix-capable CI.');
   return;
  }
  throw error;
 }
 assert.equal(run('--target',target,'--apply').code,1);
 assert.equal(existsSync(path.join(target,'sitecore.config.ts')),false);
});
test('copied resolver skill is self contained and missing mock client stays explicit',t=>{
 const root=fixture(t), copy=path.join(root,'skill'); cpSync(skill,copy,{recursive:true});
 const p=spawnSync(process.execPath,[path.join(copy,'scripts/scaffold-resolver.mjs'),'--target',path.join(root,'app'),'--apply'],{encoding:'utf8'});
 assert.equal(p.status,0); assert.ok(JSON.parse(p.stdout).unresolved.some(s=>s.includes('mock-sitecore-client')));
});
test('unsupported route is unchanged and import-only integration is unresolved',t=>{
 const root=fixture(t), target=path.join(root,'app'), route='src/app/[[...path]]/page.tsx';
 mkdirSync(path.dirname(path.join(target,route)),{recursive:true});
 const original="import { applyResolverStrategy } from '@/lib/server/resolver-strategy';\nexport default function Page() { return null; }";
 writeFileSync(path.join(target,route),original);
 const p=run('--target',target,'--apply'); assert.equal(p.code,0);
 assert.ok(p.data.unresolved.some(s=>s.includes('route')));
 assert.equal(readFileSync(path.join(target,route),'utf8'),original);
});

test('stale approvals reject all writes and non-target approvals are invalid',t=>{
 const root=fixture(t),target=path.join(root,'app');
 assert.equal(run('--target',target,'--apply').code,0);
 const rel='src/lib/server/resolver-registry.ts',file=path.join(target,rel);
 writeFileSync(file,'first');
 const p=run('--target',target);
 const digest=p.data.files.find(f=>f.path===rel).beforeHash;
 writeFileSync(file,'second');
 const rejected=run('--target',target,'--apply','--overwrite',rel+':'+digest);
 assert.equal(rejected.code,1);assert.match(rejected.data.error,/Stale/);
 assert.equal(readFileSync(file,'utf8'),'second');
 assert.equal(run('--target',target,'--apply','--overwrite','unknown:'+digest).code,1);
});
test('every bundled golden asset reaches its intended output without substitutions',t=>{
 const root=fixture(t),target=path.join(root,'app');
 const p=run('--target',target,'--apply');assert.equal(p.code,0);
 const manifest=JSON.parse(readFileSync(path.join(skill,'assets/resolver-framework/manifest.json'),'utf8'));
 for(const f of manifest.files)assert.deepEqual(readFileSync(path.join(target,f.target)),readFileSync(path.join(skill,'assets/resolver-framework',f.asset)));
});
test('explicit supported routes require approval then patch both import and live enrichment',t=>{
 for(const route of ['src/app/[site]/[locale]/[[...path]]/page.tsx','src/app/[[...path]]/page.tsx','src/app/[...path]/page.tsx']){
  const target=path.join(fixture(t),'app');mkdirSync(path.dirname(path.join(target,route)),{recursive:true});
  const original="import client from '@/lib/sitecore-client';\nexport default async function Page({ params }) {\n const { locale, site, path } = await params;\n let page = await client.getPage(path);\n if (!page) { return notFound(); }\n return page;\n}\n";
  writeFileSync(path.join(target,route),original);
  let p=run('--target',target,'--route',route,'--apply'); assert.equal(p.code,2);
  assert.equal(readFileSync(path.join(target,route),'utf8'),original);
  const f=p.data.files.find(f=>f.path===route);
  p=run('--target',target,'--route',route,'--apply','--overwrite',route+':'+f.beforeHash);assert.equal(p.code,0);
  assert.equal(p.data.route.outcome,'patched');
  const patched=readFileSync(path.join(target,route),'utf8');
  assert.match(patched,/page = await applyResolverStrategy\(page/);
  assert.match(patched,/USE_MOCK_LAYOUT_SERVICE !== 'true'/);
  assert.ok(patched.indexOf('page = await applyResolverStrategy')<patched.indexOf('if (!page)'));
  assert.equal(run('--target',target,'--route',route).data.route.outcome,'already-integrated');
 }
});
test('component generation normalizes names and corrects final-location imports, rejects collisions',t=>{
 const root=fixture(t),target=path.join(root,'app');
 assert.equal(run('--target',target,'--component','Corporate Navigation=corporateNavigation','--apply').code,0);
 assert.ok(existsSync(path.join(target,'src/lib/server/resolvers/corporateNavigation.resolver.ts')), 'registry discovers only *.resolver.ts');
 const stub=readFileSync(path.join(target,'src/lib/server/resolvers/corporateNavigation.resolver.ts'),'utf8');
 assert.match(stub,/componentName: 'CorporateNavigation'/);assert.match(stub,/from '\.\.\/resolver-adapter.types'/);
 const p=run('--target',path.join(root,'other'),'--component','A B=a','--component','AB=b','--apply');
 assert.equal(p.code,1);assert.match(p.data.error,/collision/);assert.equal(existsSync(path.join(root,'other')),false);
 assert.equal(run('--target',target,'--component','Bad=../../escape','--apply').code,1);
});
test('mutated template is rejected before target creation in a copied skill',t=>{
 const root=fixture(t),copy=path.join(root,'skill'),target=path.join(root,'app');cpSync(skill,copy,{recursive:true});
 writeFileSync(path.join(copy,'assets/resolver-framework/sitecore-client.template.txt'),'corrupt');
 const p=spawnSync(process.execPath,[path.join(copy,'scripts/scaffold-resolver.mjs'),'--target',target,'--apply'],{encoding:'utf8'});
 assert.equal(p.status,1);assert.match(JSON.parse(p.stdout).error,/hash mismatch/);assert.equal(existsSync(target),false);
});
test('canonical template hashes allow normal checkout line-ending conversion only',t=>{
 const root=fixture(t),copy=path.join(root,'skill'),target=path.join(root,'app');cpSync(skill,copy,{recursive:true});
 const asset=path.join(copy,'assets/resolver-framework/layout-normalizer.template.txt');
 const lf=readFileSync(asset,'utf8').replace(/\r\n/g,'\n');
 writeFileSync(asset,lf.replace(/\n/g,'\r\n'));
 const p=spawnSync(process.execPath,[path.join(copy,'scripts/scaffold-resolver.mjs'),'--target',target,'--apply'],{encoding:'utf8'});
 assert.equal(p.status,0);assert.ok(JSON.parse(p.stdout).files.length>0);
});
test('route comments cannot spoof resolver bindings',t=>{
 const target=path.join(fixture(t),'app'),route='src/app/[[...path]]/page.tsx';
 mkdirSync(path.dirname(path.join(target,route)),{recursive:true});
 const original="export default async function Page() {\n // const { locale, site, path } = await params;\n // let page = await client.getPage(path);\n if (!page) { return notFound(); }\n}\n";
 writeFileSync(path.join(target,route),original);
 const p=run('--target',target,'--route',route);
 assert.equal(p.data.route.outcome,'unresolved');
});
