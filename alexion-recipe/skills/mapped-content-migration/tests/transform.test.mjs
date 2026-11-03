import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bytes, hash, id } from './fixture-factory.mjs';
import { setup } from './transform-fixture.mjs';
import { transformContent } from '../scripts/transform-content.mjs';
import { prepareSourceSnapshot } from '../scripts/prepare-source-snapshot.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('reference kinds and raw value formats must fit the target field', async () => {
  const s=await setup(d=>{
    const item=d.sourceSnapshot.items[0],field=item.fields[0],g=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===item.templateId)),row=g.fields.find(f=>f.action==='map'&&f.sfid===field.fieldId);
    for(const t of d.targetInventory.templates){const f=t.fields.find(f=>f.id===row.tfid);if(f)f.type='Image';}
    field.value=d.sourceSnapshot.items[1].id;item.references.push({fieldId:field.fieldId,kind:'list',language:'en',version:1,targetSourceIds:[d.sourceSnapshot.items[1].id]});
    d.destinationPlan.referenceRules.push({sourceTemplateId:item.templateId,sourceFieldId:field.fieldId,targetOutputKey:'banner-data'});
  });
  try{const r=await s.run();assert.equal(r.ready,false);assert.ok(r.issues.some(i=>i.code==='reference-format'));}finally{await s.cleanup();}
});

test('source field types or exact approved compatibility decisions are required',async()=>{
  for(const approved of [false,true]){
    const s=await setup(d=>{const item=d.sourceSnapshot.items[0],g=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===item.templateId)),m=g.fields.find(f=>f.action==='map'&&f.sfid===item.fields[0].fieldId);delete item.fields[0].fieldType;if(approved){const t=d.targetInventory.templates.find(t=>t.fields.some(f=>f.id===m.tfid));d.destinationPlan.fieldCompatibility=[{sourceTemplateId:item.templateId,sourceFieldId:m.sfid,targetTemplateId:t.id,targetFieldId:m.tfid,sourceType:'Single-Line Text',targetType:'Single-Line Text',decision:'raw-compatible',reason:'Reviewed source definition and raw value format'}];}});
    try{const r=await s.run();assert.equal(r.ready,approved,JSON.stringify(r));if(!approved)assert.ok(r.issues.some(i=>i.code==='field-type-evidence'));}finally{await s.cleanup();}
  }
});

test('a source field may map to multiple distinct destinations without being treated as removed',async()=>{
  const s=await setup(d=>{const item=d.sourceSnapshot.items[0],g=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===item.templateId));const first=g.fields.find(f=>f.action==='map'&&f.sfid===item.fields[0].fieldId),second=g.fields.find(f=>f.action==='map'&&f.sfid===item.fields[1].fieldId);const removed={action:'remove',sfid:second.sfid,from:second.from};second.sfid=first.sfid;second.from=first.from;g.fields.push(removed);});
  try{assert.equal((await s.run()).ready,true);const p=JSON.parse(await readFile(join(s.output,'item-plan.json')));assert.equal(p.items.flatMap(i=>i.fields).filter(f=>f.value==='Example Product Name').length,2);}finally{await s.cleanup();}
});

test('compatible image references retain their XML and identity dependency',async()=>{
  const s=await setup(d=>{const item=d.sourceSnapshot.items[0],f=item.fields[0],g=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===item.templateId)),m=g.fields.find(m=>m.action==='map'&&m.sfid===f.fieldId);for(const t of d.targetInventory.templates){const target=t.fields.find(v=>v.id===m.tfid);if(target)target.type='Image';}f.fieldType='Image';f.value=`<image mediaid="${d.sourceSnapshot.items[1].id}" />`;item.references.push({fieldId:f.fieldId,kind:'media',targetSourceIds:[d.sourceSnapshot.items[1].id],language:'en',version:1});d.destinationPlan.referenceRules.push({sourceTemplateId:item.templateId,sourceFieldId:f.fieldId,targetOutputKey:'banner-data'});});
  try{assert.equal((await s.run()).ready,true);}finally{await s.cleanup();}
});

function nestedDatasource(d, via='source-ancestor') {
  const parent=d.sourceSnapshot.items[1],group=d.mapping.templates.find(g=>g.source.some(t=>t.templateId===parent.templateId));
  const child={...structuredClone(parent),id:id(770),templateId:id(771),parentId:parent.id,name:'Slide 1',path:parent.path+'/Slide 1'};
  d.sourceSnapshot.items.push(child);
  d.mapping.templates.push({...structuredClone(group),source:[{...group.source[0],templateId:child.templateId,templateName:'Slide',path:'/sitecore/templates/Legacy/Slide'}]});
  d.destinationPlan.rules.push({sourceTemplateId:child.templateId,targetTemplateId:group.target[0].templateId,outputKey:'slide-data',kind:'datasource',scope:'page-local',identity:'source-item-and-page',pathPattern:'{targetPagePath}/Data/Brands/{sourceName}',folderRuleKey:'brands',existingItem:'create-only',collision:'block'});
  const page=d.sourceSnapshot.items[0];
  if(via==='source-reference'){
    page.fields[0].value=child.id;page.references.push({fieldId:page.fields[0].fieldId,kind:'list',language:'en',version:1,targetSourceIds:[child.id]});
    d.destinationPlan.referenceRules.push({sourceTemplateId:page.templateId,sourceFieldId:page.fields[0].fieldId,targetOutputKey:'slide-data'});
    d.destinationPlan.ownershipRules=[{sourceItemId:child.id,via,ownerItemId:page.id,fieldId:page.fields[0].fieldId}];
  }else if(via==='explicit-pages')d.destinationPlan.ownershipRules=[{sourceItemId:child.id,via,pageIds:[page.id]}];
  else d.destinationPlan.ownershipRules=[{sourceItemId:child.id,via,ancestorItemId:parent.id}];
  return child;
}

test('approved ancestor, reference and named-page ownership compose nested datasources',async()=>{
  for(const via of ['source-ancestor','source-reference','explicit-pages']){
    const s=await setup(d=>nestedDatasource(d,via));try{const r=await s.run();assert.equal(r.ready,true,JSON.stringify(r));const p=JSON.parse(await readFile(join(s.output,'item-plan.json')));const slide=p.items.find(i=>i.identity.outputKey==='slide-data');assert.equal(slide.identity.pageId.toLowerCase(),s.d.sourceSnapshot.items[0].id.toLowerCase());assert.match(slide.identity.targetPath,/Page A-0\/Data\/Brands\/Slide 1$/);}finally{await s.cleanup();}
  }
});

test('shared ancestor ownership makes one local child per approved consuming page',async()=>{
  const s=await setup(d=>{nestedDatasource(d);const page={...structuredClone(d.sourceSnapshot.items[0]),id:id(772),name:'Page B',path:'/sitecore/content/Legacy/Page B'};d.sourceSnapshot.items.push(page);d.sourceSnapshot.renderingInstances.push({...structuredClone(d.sourceSnapshot.renderingInstances[0]),pageId:page.id,instanceId:id(773)});});
  try{assert.equal((await s.run()).ready,true);const p=JSON.parse(await readFile(join(s.output,'item-plan.json')));assert.equal(p.items.filter(i=>i.identity.outputKey==='slide-data').length,2);assert.equal(p.items.filter(i=>i.identity.sourceItemId===s.d.sourceSnapshot.items[1].id).length,1);}finally{await s.cleanup();}
});

test('ownership without a proven ancestor chain is blocked',async()=>{
  const s=await setup(d=>{nestedDatasource(d);d.destinationPlan.ownershipRules[0].ancestorItemId=d.sourceSnapshot.items[0].id;});
  try{const r=await s.run();assert.equal(r.ready,false);assert.ok(r.issues.some(i=>i.code==='ownership-ancestor'));}finally{await s.cleanup();}
});

test('nested ownership is not inferred without an approved rule or missing reference proof',async()=>{
  for(const mode of ['no-rule','missing-reference']){
    const s=await setup(d=>{nestedDatasource(d,mode==='missing-reference'?'source-reference':'source-ancestor');if(mode==='no-rule')delete d.destinationPlan.ownershipRules;else d.sourceSnapshot.items[0].references=[];});
    try{const r=await s.run();assert.equal(r.ready,false);assert.ok(r.issues.some(i=>i.code===(mode==='no-rule'?'page-owner':'ownership-reference')));}finally{await s.cleanup();}
  }
});

test('ownership cycles and disagreement with direct occurrence evidence are blocked',async()=>{
  for(const mode of ['cycle','conflict']){
    const s=await setup(d=>{const child=nestedDatasource(d,'explicit-pages');if(mode==='cycle'){
      child.fields[0].value=child.id;child.references=[{fieldId:child.fields[0].fieldId,kind:'list',targetSourceIds:[child.id],language:'en',version:1}];d.destinationPlan.ownershipRules=[{sourceItemId:child.id,via:'source-reference',ownerItemId:child.id,fieldId:child.fields[0].fieldId}];
    }else{
      const page={...structuredClone(d.sourceSnapshot.items[0]),id:id(775),name:'Page B',path:'/sitecore/content/Legacy/Page B'};d.sourceSnapshot.items.push(page);d.destinationPlan.ownershipRules[0].pageIds=[page.id];d.sourceSnapshot.renderingInstances.push({...structuredClone(d.sourceSnapshot.renderingInstances[0]),datasourceId:child.id,instanceId:id(776)});
    }});
    try{const r=await s.run();assert.equal(r.ready,false);assert.ok(r.issues.some(i=>i.code===(mode==='cycle'?'ownership-cycle':'ownership-conflict')),JSON.stringify(r));}finally{await s.cleanup();}
  }
});


test('deterministic transformation splits content and creates explicit local folders without changing inputs', async () => {
  const s = await setup();
  try {
    const before = await readFile(join(s.dir, 'sourceSnapshot.json'));
    const a = await s.run();
    assert.equal(a.ready, true, JSON.stringify(a));
    const plan = JSON.parse(await readFile(join(s.output, 'item-plan.json')));
    assert.equal(plan.items.length, 4); assert.equal(plan.structures.length, 2);
    const local = plan.items.find(i => i.identity.outputKey === 'item-1');
    assert.match(local.identity.targetPath, /Page A-0\/Data\/Brands\/Page A$/);
    assert.equal(local.identity.pageId, s.d.sourceSnapshot.items[0].id);
    assert.ok(plan.items.find(i => i.identity.outputKey === 'item-0').fields.some(f => f.value === 'Example Product Name'));
    const b = await transformContent(s.input, join(s.dir, 'repeat'));
    assert.equal(b.ready, true);
    assert.deepEqual(await readFile(join(s.output, 'item-plan.json')), await readFile(join(s.dir, 'repeat/item-plan.json')));
    assert.deepEqual(before, await readFile(join(s.dir, 'sourceSnapshot.json')));
    await assert.rejects(s.run());
  } finally { await s.cleanup(); }
});

test('map, constant and remove actions preserve empty values and inherited field ownership', async () => {
  const s = await setup(d => {
    d.sourceSnapshot.items[0].fields[0].value = '';
    const group = d.mapping.templates.find(g => g.source.some(s => s.templateId === d.sourceSnapshot.items[0].templateId));
    const mapped = group.fields.find(f => f.action === 'map' && f.sfid === d.sourceSnapshot.items[0].fields[1].fieldId);
    mapped.action = 'set'; mapped.value = 'Approved constant'; delete mapped.sfid; delete mapped.from;
    const removed = group.fields.find(f => f.action === 'map' && f.sfid === d.sourceSnapshot.items[0].fields[2].fieldId);
    group.fields[group.fields.indexOf(removed)] = { action: 'remove', sfid: removed.sfid, from: removed.from };
  });
  try {
    assert.equal((await s.run()).ready, true);
    const plan = JSON.parse(await readFile(join(s.output, 'item-plan.json')));
    const page = plan.items.find(i => i.identity.outputKey === 'item-0');
    assert.ok(page.fields.some(f => f.value === '')); assert.ok(page.fields.some(f => f.value === 'Approved constant'));
    assert.ok(!page.fields.some(f => f.value === 'Example Page Title'));
    assert.equal(plan.items.length, 4); // Inherited fields never create base-template items.
  } finally { await s.cleanup(); }
});

test('global data is reused across consumers and local data requires captured ownership', async () => {
  const s = await setup(d => {
    const second = structuredClone(d.sourceSnapshot.items[0]); second.id = id(77); second.name = 'Page B'; second.path = second.path.replace('Page A', 'Page B');
    d.sourceSnapshot.items.push(second);
    d.sourceSnapshot.renderingInstances.push({ ...structuredClone(d.sourceSnapshot.renderingInstances[0]), pageId: second.id });
  });
  try {
    const r = await s.run(); assert.equal(r.ready, false); // Same occurrence name would collide for parameter-derived outputs.
    const plan = JSON.parse(await readFile(join(s.output, 'item-plan.json')));
    assert.equal(plan.items.filter(i => i.identity.sourceItemId === s.d.sourceSnapshot.items[1].id).length, 1);
    assert.equal(plan.items.filter(i => i.identity.outputKey === 'item-1').length, 2);
  } finally { await s.cleanup(); }
});

test('references preserve raw values, order and explicit target output choices', async () => {
  const s = await setup(d => {
    const item = d.sourceSnapshot.items[0], field = item.fields[0];
    field.value = d.sourceSnapshot.items[1].id;
    item.references.push({ fieldId: field.fieldId, kind: 'list', targetSourceIds: [d.sourceSnapshot.items[1].id], language: 'en', version: 1 });
    d.destinationPlan.referenceRules.push({ sourceTemplateId: item.templateId, sourceFieldId: field.fieldId, targetOutputKey: 'banner-data' });
  });
  try {
    const result = await s.run(); assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(result.referenceDependencies.length, 1); assert.equal(result.referenceDependencies[0].status, 'planned');
    const plan = JSON.parse(await readFile(join(s.output, 'item-plan.json')));
    const page = plan.items.find(i => i.identity.outputKey === 'item-0');
    assert.equal(page.relationships[0].targets[0].sourceItemId, s.d.sourceSnapshot.items[1].id);
    assert.ok(page.fields.some(f => f.value === s.d.sourceSnapshot.items[1].id));
    assert.ok(result.issues.some(i => i.code === 'reference-resolution-required'));
  } finally { await s.cleanup(); }
});

test('unresolved external references block readiness instead of removing the link', async () => {
  const s = await setup(d => {
    const item = d.sourceSnapshot.items[0];
    item.references.push({ fieldId: item.fields[0].fieldId, kind: 'list', targetSourceIds: [id(999)], language: 'en', version: 1 });
  });
  try { const r = await s.run(); assert.equal(r.ready, false); assert.ok(r.issues.some(i => i.code === 'reference-dependency')); } finally { await s.cleanup(); }
});

test('partitioned source input uses the same transformation and complete coverage gates', async () => {
  const s = await setup();
  try {
    const coverage = JSON.parse(await readFile(join(s.dir, 'coverage.json')));
    const request = { version: 1, scope: coverage.scope, evidence: [{ ...s.binding.sourceSnapshot, format: 'snapshot-json', sourceStateId: 'reviewed', capturedAt: s.d.sourceSnapshot.capturedAt, scopeId: coverage.scope.scopeId, instanceId: coverage.scope.instanceId, database: coverage.scope.database }], maxRecordsPerPart: 1 };
    await writeFile(join(s.dir, 'preparation.json'), bytes(request));
    assert.equal((await prepareSourceSnapshot(join(s.dir, 'preparation.json'), join(s.dir, 'prepared'))).ready, true);
    const manifest = await readFile(join(s.dir, 'prepared/source-snapshot.json'));
    s.binding.sourceSnapshot = { path: 'prepared/source-snapshot.json', sha256: hash(manifest) }; coverage.snapshot = s.binding.sourceSnapshot;
    await writeFile(join(s.dir, 'migration.json'), bytes(s.binding)); await writeFile(join(s.dir, 'coverage.json'), bytes(coverage));
    const transform = { version: 1, migrationInput: { path: 'migration.json', sha256: hash(bytes(s.binding)) }, snapshotValidation: { path: 'coverage.json', sha256: hash(bytes(coverage)) } };
    await writeFile(s.input, bytes(transform));
    assert.equal((await s.run()).ready, true);
  } finally { await s.cleanup(); }
});

test('corrupt inputs and wrong coverage bindings fail before creating outputs', async () => {
  const s = await setup();
  try {
    await writeFile(join(s.dir, 'mapping.json'), '{}');
    await assert.rejects(s.run(), /input|hash|Artifact/i);
    await assert.rejects(readFile(join(s.output, 'item-plan.json')));
  } finally { await s.cleanup(); }
});

test('known reference field types require captured reference evidence', async () => {
  const s = await setup(d => {
    const source = d.sourceSnapshot.items[0];
    const group = d.mapping.templates.find(g => g.source.some(t => t.templateId === source.templateId));
    const row = group.fields.find(f => f.action === 'map' && f.sfid === source.fields[0].fieldId);
    for (const template of d.targetInventory.templates) { const field = template.fields.find(f => f.id === row.tfid); if (field) field.type = 'Multilist'; }
  });
  try { const r = await s.run(); assert.equal(r.ready, false); assert.ok(r.issues.some(i => i.code === 'reference-evidence')); } finally { await s.cleanup(); }
});

test('legacy source JSON cannot bypass prepared source-state provenance', async () => {
  const s = await setup();
  try {
    s.binding.sourceSnapshot = { path: 'sourceSnapshot.json', sha256: hash(bytes(s.d.sourceSnapshot)) };
    await writeFile(join(s.dir, 'migration.json'), bytes(s.binding));
    const request = JSON.parse(await readFile(s.input)); request.migrationInput.sha256 = hash(bytes(s.binding));
    await writeFile(s.input, bytes(request));
    await assert.rejects(s.run(), /source-state provenance/);
  } finally { await s.cleanup(); }
});

test('local datasource ownership is not guessed without presentation evidence', async () => {
  const s = await setup(d => {
    d.sourceSnapshot.renderingInstances = [];
    const rule = d.destinationPlan.rules.find(r => r.sourceTemplateId === d.sourceSnapshot.items[1].templateId);
    Object.assign(rule, { scope: 'page-local', identity: 'source-item-and-page', folderRuleKey: 'brands', pathPattern: '{targetPagePath}/Data/Brands/{sourceName}' });
  });
  try { const r = await s.run(); assert.equal(r.ready, false); assert.ok(r.issues.some(i => i.code === 'page-owner')); } finally { await s.cleanup(); }
});

test('approved existing-item intent preserves the target ID without claiming field equality', async () => {
  const s = await setup(d => {
    const source = d.sourceSnapshot.items[0];
    const rule = d.destinationPlan.rules.find(r => r.sourceTemplateId === source.templateId && r.kind === 'page');
    rule.existingItem = 'reuse';
    d.targetInventory.items.push({ id: id(990), templateId: rule.targetTemplateId, path: rule.pathPattern.replace('{sourceName}', source.name) });
  });
  try {
    assert.equal((await s.run()).ready, true);
    const plan = JSON.parse(await readFile(join(s.output, 'item-plan.json')));
    const page = plan.items.find(i => i.identity.outputKey === 'item-0');
    assert.equal(page.identity.targetItemId, id(990)); assert.equal(page.action, 'reuse');
  } finally { await s.cleanup(); }
});

test('CLI produces review artifacts and rejects unsupported write flags', async () => {
  const s = await setup();
  try {
    const script = fileURLToPath(new URL('../scripts/transform-content.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--input', s.input, '--output', s.output], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).proposedIdentitiesOnly, true);
    assert.equal(spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8' }).status, 1);
  } finally { await s.cleanup(); }
});

test('missing mapped values and storage conversion block affected outputs', async () => {
  for (const mode of ['missing', 'storage']) {
    const s = await setup(d => {
      if (mode === 'missing') d.sourceSnapshot.items[0].fields.shift();
      else d.targetInventory.templates.find(t => t.id === d.destinationPlan.rules.find(r => r.sourceTemplateId === d.sourceSnapshot.items[0].templateId).targetTemplateId).fields[0].storage = 'shared';
    });
    try { const r = await s.run(); assert.equal(r.ready, false); assert.ok(r.issues.some(i => /missing-value|storage/.test(i.code))); } finally { await s.cleanup(); }
  }
});

test('path collisions and branch expansion are reported rather than guessed', async () => {
  for (const mode of ['collision', 'branch']) {
    const s = await setup(d => {
      const rule = d.destinationPlan.rules.find(r => r.sourceTemplateId === d.sourceSnapshot.items[0].templateId && r.kind === 'page');
      if (mode === 'collision') d.targetInventory.items.push({ id: id(900), templateId: rule.targetTemplateId, path: rule.pathPattern.replace('{sourceName}', 'Page A') });
      else { const branch = { ...d.targetInventory.templates[0], id: id(901), name: 'Branch', path: '/sitecore/templates/Branches/Example', kind: 'branch', fields: [] }; d.targetInventory.templates.push(branch); rule.branchId = branch.id; }
    });
    try { const r = await s.run(); assert.equal(r.ready, false); assert.ok(r.issues.some(i => /collision|branch/.test(i.code))); } finally { await s.cleanup(); }
  }
});
