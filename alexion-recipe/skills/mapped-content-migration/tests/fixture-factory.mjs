// Maintainer tool. From this directory: node fixture-factory.mjs --write-fixtures
// It deliberately overwrites the companion JSON fixtures and refreshes their SHA-256 bindings in
// migration-input.json, and preserves fixtures/sitecore-mapping.json. Normal tests and the validator
// never rewrite these files. Review the regenerated diff and run the full tests afterwards.
// Never point fixture generation at migration evidence.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fixtures = new URL('./fixtures/', import.meta.url);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const bytes = value => JSON.stringify(value, null, 2) + '\n';
export const id = n => `{00000000-0000-4000-8000-${String(n).padStart(12, '0')}}`;

// All companion evidence here is synthetic. It illustrates the supplied mapping,
// not a claim about a real Sitecore instance or target field types.
export async function example() {
  const mapping = JSON.parse(await readFile(new URL('sitecore-mapping.json', fixtures), 'utf8'));
  const templates = new Map();
  for (const group of mapping.templates) for (const ref of group.target) {
    if (!templates.has(ref.templateId)) templates.set(ref.templateId, {
      id: ref.templateId, name: ref.templateName, path: ref.path,
      kind: ref.templateName.includes('Parameters') ? 'parameters' : ref.templateName.includes('Datasource') ? 'datasource' : 'content',
      baseTemplateIds: ref.baseTemplates.map(b => b.baseTemplateId), fields: [],
    });
    const template = templates.get(ref.templateId);
    for (const field of group.fields.filter(f => f.action !== 'remove')) {
      if (field.targetTemplateId !== ref.templateId && !template.baseTemplateIds.includes(field.targetTemplateId)) continue;
      if (!template.fields.some(f => f.id === field.tfid)) template.fields.push({
        id: field.tfid, name: field.to, declaringTemplateId: field.targetTemplateId, type: 'Single-Line Text', storage: 'versioned',
      });
    }
  }
  const folderTemplate = { id: id(1), name: 'Data Folder', path: '/sitecore/templates/Project/Site/Data Folder', kind: 'folder', baseTemplateIds: [], fields: [] };
  const targetInventory = {
    version: 1, scopeId: 'fixture-site', instanceId: 'fixture-target', database: 'master', capturedAt: '2026-10-27T08:00:00Z',
    rootPaths: ['/sitecore/templates/Project/Site', '/sitecore/templates/Feature/Site', '/sitecore/content/Site'],
    templates: [...templates.values(), folderTemplate], items: [],
    renderings: mapping.renderings.flatMap(g => g.target.map(r => ({ id: r.renderingId, name: r.renderingName, path: r.path }))),
    placeholders: mapping.placeholders.map(p => p.target),
  };
  const product = mapping.templates.find(t => t.source[0].templateName === 'Product Page');
  const banner = mapping.templates.find(t => t.source[0].templateName === 'HeroBanner Datasource');
  const parameters = mapping.templates.find(t => t.source[0].templateName === 'HeroBanner Parameters');
  const fieldValues = group => group.fields.filter(f => f.action === 'map').map(f => ({
    fieldId: f.sfid, value: `Example ${f.from}`, fieldType: 'Single-Line Text', storage: 'versioned', language: 'en', version: 1,
  }));
  const sourceSnapshot = {
    version: 1, scopeId: 'fixture-site', instanceId: 'fixture-source', database: 'master', capturedAt: '2026-10-27T08:00:00Z',
    rootPaths: ['/sitecore/content/Legacy'], languages: ['en'],
    items: [product, banner].map((g, i) => ({
      id: id(10 + i), parentId: id(9), templateId: g.source[0].templateId, name: i ? 'Banner A' : 'Page A',
      path: i ? '/sitecore/content/Legacy/Shared/Banner A' : '/sitecore/content/Legacy/Page A',
      versions: [{ language: 'en', version: 1 }], fields: fieldValues(g), references: [],
    })),
    renderingInstances: [{
      instanceId: id(20), pageId: id(10), renderingId: mapping.renderings[0].source[0].renderingId, datasourceId: id(11),
      parameterTemplateId: parameters.source[0].templateId, language: 'en', version: 1, deviceId: id(21), parameters: fieldValues(parameters),
    }],
  };
  const rules = mapping.templates.flatMap(g => g.source.flatMap(s => g.target.map((t, index) => {
    const kind = templates.get(t.templateId).kind;
    return {
      sourceTemplateId: s.templateId, targetTemplateId: t.templateId, outputKey: kind === 'parameters' ? 'parameters' : kind === 'datasource' ? 'banner-data' : `item-${index}`,
      kind: kind === 'content' ? 'page' : kind, scope: kind === 'parameters' ? 'rendering-instance' : 'global',
      identity: s.templateName.includes('Parameters') ? 'rendering-instance' : 'source-item',
      ...(kind === 'parameters' ? {} : { pathPattern: `/sitecore/content/Site/Migrated/${s.templateName}/{sourceName}-${index}` }),
      existingItem: 'create-only', collision: 'block',
    };
  })));
  const brandRule = rules.find(r => r.sourceTemplateId === product.source[0].templateId && r.targetTemplateId === product.target[1].templateId);
  brandRule.kind = 'datasource'; brandRule.scope = 'page-local'; brandRule.identity = 'source-item-and-page';
  brandRule.pathPattern = '{targetPagePath}/Data/Brands/{sourceName}'; brandRule.folderRuleKey = 'brands';
  const destinationPlan = {
    version: 1, scopeId: 'fixture-site', targetRootPath: '/sitecore/content/Site', rules,
    folders: [{ key: 'brands', segments: [{ name: 'Data', templateId: id(1) }, { name: 'Brands', templateId: id(1) }] }],
    referenceRules: [], exclusions: [],
  };
  const identity = { sourceItemId: id(10), outputKey: 'item-0', targetItemId: id(100), targetPath: '/sitecore/content/Site/Migrated/Product Page/Page A-0' };
  const brandIdentity = {
    sourceItemId: id(10), outputKey: brandRule.outputKey, pageId: id(10), targetItemId: id(101),
    targetPath: identity.targetPath + '/Data/Brands/Page A',
  };
  const bannerIdentity = {
    sourceItemId: id(11), outputKey: 'banner-data', targetItemId: id(102),
    targetPath: '/sitecore/content/Site/Migrated/HeroBanner Datasource/Banner A-0',
  };
  const plannedFields = (group, targetId, sourceItem) => {
    const ref = group.target.find(t => t.templateId === targetId);
    return group.fields.filter(f => f.action === 'map' && (f.targetTemplateId === targetId || ref.baseTemplates.some(b => b.baseTemplateId === f.targetTemplateId))).map(f => ({
      fieldId: f.tfid, value: sourceItem.fields.find(s => s.fieldId === f.sfid).value, storage: 'versioned', language: 'en', version: 1,
    }));
  };
  const inputs = Object.fromEntries(Object.entries({ mapping, sourceSnapshot, targetInventory, destinationPlan }).map(([k, v]) => [k, hash(bytes(v))]));
  const itemPlan = {
    version: 1, scopeId: 'fixture-site', mappingRevision: 'example-1', inputs,
    items: [
      { identity, templateId: product.target[0].templateId, action: 'create', fields: plannedFields(product, product.target[0].templateId, sourceSnapshot.items[0]), relationships: [] },
      { identity: brandIdentity, templateId: product.target[1].templateId, action: 'create', fields: plannedFields(product, product.target[1].templateId, sourceSnapshot.items[0]), relationships: [] },
      { identity: bannerIdentity, templateId: banner.target[0].templateId, action: 'create', fields: plannedFields(banner, banner.target[0].templateId, sourceSnapshot.items[1]), relationships: [] },
    ], issues: [],
  };
  const identityMap = {
    version: 1, scopeId: 'fixture-site', mappingRevision: 'example-1', sourceInstanceId: sourceSnapshot.instanceId,
    targetInstanceId: targetInventory.instanceId, entries: [identity, brandIdentity, bannerIdentity],
  };
  return { mapping, sourceSnapshot, targetInventory, destinationPlan, itemPlan, identityMap };
}

// Deliberately opt-in: tests never rewrite fixtures or the supplied mapping.
if (process.argv.includes('--write-fixtures') && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const documents = await example();
  const names = { mapping: 'sitecore-mapping', sourceSnapshot: 'source-snapshot', targetInventory: 'target-inventory', destinationPlan: 'destination-plan', itemPlan: 'item-plan', identityMap: 'identity-map' };
  const manifest = { version: 1, scopeId: 'fixture-site', mappingRevision: 'example-1' };
  for (const [key, name] of Object.entries(names)) {
    const file = new URL(name + '.json', fixtures);
    if (key !== 'mapping') await writeFile(file, bytes(documents[key]));
    manifest[key] = { path: name + '.json', sha256: hash(await readFile(file)) };
  }
  // Bind optional output evidence to the actual preserved raw mapping bytes.
  documents.itemPlan.inputs = Object.fromEntries(Object.keys(documents.itemPlan.inputs).map(k => [k, manifest[k].sha256]));
  await writeFile(new URL('item-plan.json', fixtures), bytes(documents.itemPlan));
  manifest.itemPlan.sha256 = hash(await readFile(new URL('item-plan.json', fixtures)));
  await writeFile(new URL('migration-input.json', fixtures), bytes(manifest));
  const source = documents.sourceSnapshot;
  const scope = {
    version: 1, scopeId: source.scopeId, instanceId: source.instanceId, database: source.database, sourceStateId: 'fixture-source-state',
    rootPaths: source.rootPaths, languages: source.languages,
    items: source.items.map(i => ({ id: i.id, path: i.path, parentId: i.parentId, templateId: i.templateId, versions: i.versions, fields: i.fields.map(f => ({ fieldId: f.fieldId, storage: f.storage })) })),
    renderingInstances: source.renderingInstances.map(r => ({ ...r, parameters: r.parameters.map(f => ({ fieldId: f.fieldId, storage: f.storage })) })),
  };
  const preparation = { version: 1, scope, evidence: [{ ...manifest.sourceSnapshot, format: 'snapshot-json', sourceStateId: scope.sourceStateId,
    capturedAt: source.capturedAt, scopeId: source.scopeId, instanceId: source.instanceId, database: source.database }], maxPartBytes: 4096, maxRecordsPerPart: 1 };
  await writeFile(new URL('source-preparation.json', fixtures), bytes(preparation));
  const records = [...source.items.map(data => ({ kind: 'item', data })), ...source.renderingInstances.map(data => ({ kind: 'renderingInstance', data }))];
  const parts = [];
  for (const [index, record] of records.entries()) {
    const path = `snapshot-part-${index + 1}.jsonl`, content = JSON.stringify(record) + '\n';
    await writeFile(new URL(path, fixtures), content);
    parts.push({ path, sha256: hash(content), bytes: Buffer.byteLength(content), itemCount: record.kind === 'item' ? 1 : 0, renderingInstanceCount: record.kind === 'renderingInstance' ? 1 : 0 });
  }
  const { items, renderingInstances, ...header } = source;
  const partitioned = { ...header, format: 'source-snapshot-manifest', sourceStateId: scope.sourceStateId, preparedAt: source.capturedAt, complete: true,
    maxPartBytes: 4096, maxRecordsPerPart: 1, itemCount: items.length, renderingInstanceCount: renderingInstances.length, parts,
    requestSha256: hash(bytes(preparation)), provenance: [{ ...manifest.sourceSnapshot, format: 'snapshot-json', sourceStateId: scope.sourceStateId, capturedAt: source.capturedAt, status: 'reused' }] };
  await writeFile(new URL('source-snapshot-manifest.json', fixtures), bytes(partitioned));
  const snapshot = { path: 'source-snapshot-manifest.json', sha256: hash(bytes(partitioned)) };
  await writeFile(new URL('snapshot-validation.json', fixtures), bytes({ version: 1, scope, snapshot }));
  const partitionedPlan = structuredClone(documents.itemPlan); partitionedPlan.inputs.sourceSnapshot = snapshot.sha256;
  await writeFile(new URL('item-plan-partitioned.json', fixtures), bytes(partitionedPlan));
  const partitionedInput = { ...manifest, sourceSnapshot: snapshot, itemPlan: { path: 'item-plan-partitioned.json', sha256: hash(bytes(partitionedPlan)) } };
  await writeFile(new URL('migration-input-partitioned.json', fixtures), bytes(partitionedInput));
}
