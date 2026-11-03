import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRenderingCapturePlan } from '../scripts/analysis/build-rendering-capture-plan.mjs';
import { fetchLayouts } from '../scripts/capture/fetch-layouts.mjs';
import { sha256 } from '../scripts/capture/rendering-coverage.mjs';
import { preparePreviewNavigation } from '../scripts/preview/prepare-preview-navigation.mjs';
import { validateSitecoreArtifactSync } from '../scripts/contracts/sitecore-artifacts.mjs';

const skills = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function setup(t) {
 const root=mkdtempSync(join(tmpdir(),'preview-scaffold-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const pair=join(root,'pair'); cpSync(join(skills,'sitecore-headless-to-xmc'),pair,{recursive:true});
 const run=(...args)=>{if(args.includes('--preview-stage')&&!args.includes('--preview-stage-sha256'))args.push('--preview-stage-sha256',sha256(readFileSync(join(args[args.indexOf('--preview-stage')+1],'deployment-manifest.json'))));const result=spawnSync(process.execPath,[join(pair,'scripts/scaffold-mock-service.mjs'),...args],{encoding:'utf8',cwd:root});return {status:result.status,data:JSON.parse(result.stdout||'{}')};};
 return {root,pair,run};
}
async function capturedStage(t,f) {
 const plan=buildRenderingCapturePlan([{route:'/Articles',itemId:'page1',itemPath:'/sitecore/content/Test/Articles',language:'en',requirements:[{key:'r1:config',renderingId:'r1',renderingName:'Article',variantId:null,configurationKey:'config',parameters:{},sourceOccurrences:[]}]}],{includedRenderingIds:['r1']});
 const capturePlanFile=join(f.root,'plan.json'); writeFileSync(capturePlanFile,JSON.stringify(plan));
 const oldFetch=globalThis.fetch,oldKey=process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;
 t.after(()=>{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;else process.env.SOURCE_SITECORE_GRAPHQL_API_KEY=oldKey;});
 process.env.SOURCE_SITECORE_GRAPHQL_API_KEY='test-secret';
 globalThis.fetch=async()=>new Response(JSON.stringify({sitecore:{context:{language:'en'},route:{itemId:'page1',name:'Articles',fields:{},placeholders:{main:[{componentName:'Article',renderingId:'r1',params:{},fields:{}}]}}}}));
 const capture=await fetchLayouts({capturePlanFile,layoutServiceUrl:'https://source.test',siteName:'site',outputDir:join(f.root,'capture')});
 validateSitecoreArtifactSync('rendering-capture-plan',plan);validateSitecoreArtifactSync('capture-result',capture,{capturePlan:plan});
 const outputDir=join(f.root,'stage');
 const manifest=preparePreviewNavigation({capturePlanFile,capturePlanSha256:sha256(readFileSync(capturePlanFile)),captureResultFiles:[{path:capture.captureResultFile,sha256:sha256(readFileSync(capture.captureResultFile))}],outputDir});
 validateSitecoreArtifactSync('mock-preview-deployment',manifest);
 validateSitecoreArtifactSync('mock-preview-routes',JSON.parse(readFileSync(join(outputDir,'public/mock-preview/routes.json'))));
 return {outputDir,manifest,capture};
}

test('verified captures reach copied scaffold with exact routes and a gated navigation hook',async t=>{
 const f=setup(t),stage=await capturedStage(t,f),app=join(f.root,'app');
 mkdirSync(join(app,'src/app'),{recursive:true});writeFileSync(join(app,'src/app/layout.tsx'),'export default function Root({children}) { return <html><body>{children}</body></html>; }');
 mkdirSync(join(app,'public/mock-layouts/stale'),{recursive:true});writeFileSync(join(app,'public/mock-layouts/stale/index.json'),'old layout');
 let planned=f.run('--target',app,'--preview-stage',stage.outputDir,'--dry-run');assert.equal(planned.status,2);
 const approvals=planned.data.files.filter(x=>x.action==='conflict').flatMap(x=>['--overwrite',`${x.path}:${x.beforeHash}`]);
 const applied=f.run('--target',app,'--preview-stage',stage.outputDir,'--apply',...approvals);assert.equal(applied.status,0,JSON.stringify(applied.data));
 assert.deepEqual(JSON.parse(readFileSync(join(app,'public/mock-preview/routes.json'))),{routes:['/Articles']});
 assert.deepEqual(readFileSync(join(app,'public/mock-layouts/Articles/index.json')),readFileSync(stage.capture.outcomes[0].layoutFile));
 assert.equal(readFileSync(join(app,'public/mock-layouts/stale/index.json'),'utf8'),'old layout','unlisted existing files are preserved but never indexed');
 assert.equal(applied.data.preview.layout.outcome,'patched');
 const again=f.run('--target',app,'--preview-stage',stage.outputDir,'--apply');assert.equal(again.status,0);
 assert.equal(again.data.preview.layout.outcome,'already-integrated');
});

test('stale evidence or route-index tampering rejects preview installation before app writes',async t=>{
 const f=setup(t),stage=await capturedStage(t,f);
 const indexFile=join(stage.outputDir,'public/mock-preview/routes.json');
 writeFileSync(indexFile,JSON.stringify({routes:['/not-selected']}));
 const badApp=join(f.root,'bad-app');let rejected=f.run('--target',badApp,'--preview-stage',stage.outputDir,'--apply');
 assert.equal(rejected.status,1);assert.equal(existsSync(badApp),false);
 writeFileSync(indexFile,JSON.stringify({routes:['/Articles']}));
 const manifestFile=join(stage.outputDir,'deployment-manifest.json');const manifest=JSON.parse(readFileSync(manifestFile));
 manifest.files.find(x=>x.path==='public/mock-preview/routes.json').sha256=sha256(readFileSync(indexFile));writeFileSync(manifestFile,JSON.stringify(manifest));
 writeFileSync(stage.capture.outcomes[0].layoutFile,'changed');
 rejected=f.run('--target',badApp,'--preview-stage',stage.outputDir,'--apply');
 assert.equal(rejected.status,1);assert.equal(existsSync(badApp),false);
});


test('a coherently edited stage cannot introduce pages absent from the approved capture results',async t=>{
 const f=setup(t),stage=await capturedStage(t,f),badApp=join(f.root,'unapproved-app');
 const file=join(stage.outputDir,'deployment-manifest.json'),manifest=JSON.parse(readFileSync(file));
 const original=manifest.captures[0],extra='public/mock-layouts/unapproved/index.json';
 mkdirSync(join(stage.outputDir,'public/mock-layouts/unapproved'),{recursive:true});
 writeFileSync(join(stage.outputDir,extra),readFileSync(original.layoutFile));
 manifest.routes.push('/unapproved');manifest.captures.push({...original,route:'/unapproved'});
 manifest.files.push({path:extra,sha256:original.sha256});
 const indexFile=join(stage.outputDir,'public/mock-preview/routes.json');writeFileSync(indexFile,JSON.stringify({routes:manifest.routes}));
 manifest.files.find(x=>x.path==='public/mock-preview/routes.json').sha256=sha256(readFileSync(indexFile));writeFileSync(file,JSON.stringify(manifest));
 const rejected=f.run('--target',badApp,'--preview-stage',stage.outputDir,'--apply');
 assert.equal(rejected.status,1,JSON.stringify(rejected.data));assert.match(rejected.data.error,/declared approved capture/);
 assert.equal(existsSync(badApp),false);
});
