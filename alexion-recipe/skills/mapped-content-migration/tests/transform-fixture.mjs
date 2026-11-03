import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { example, bytes, hash, id } from './fixture-factory.mjs';
import { transformContent } from '../scripts/transform-content.mjs';
import { prepareSourceSnapshot } from '../scripts/prepare-source-snapshot.mjs';
export async function setup(change = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mapped-transform-'));
  const d = await example(); delete d.itemPlan; delete d.identityMap;
  // Existing parent evidence is explicit; no inferred folder templates.
  for (const [index, path] of ['/sitecore/content/Site', '/sitecore/content/Site/Migrated', '/sitecore/content/Site/Migrated/Product Page', '/sitecore/content/Site/Migrated/HeroBanner Datasource', '/sitecore/content/Site/Migrated/HeroBanner Parameters'].entries())
    d.targetInventory.items.push({ id: id(800 + index), path, templateId: d.targetInventory.templates[0].id });
  change(d);
  const scope = { version: 1, scopeId: d.sourceSnapshot.scopeId, instanceId: d.sourceSnapshot.instanceId, database: d.sourceSnapshot.database, sourceStateId: 'reviewed', rootPaths: d.sourceSnapshot.rootPaths, languages: d.sourceSnapshot.languages,
    items: d.sourceSnapshot.items.map(i => ({ id: i.id, parentId: i.parentId, path: i.path, templateId: i.templateId, versions: i.versions, fields: i.fields.map(f => ({ fieldId: f.fieldId, storage: f.storage, ...(i.references.find(r => r.fieldId === f.fieldId) ? { referenceKind: i.references.find(r => r.fieldId === f.fieldId).kind } : {}) })) })),
    renderingInstances: d.sourceSnapshot.renderingInstances.map(r => ({ ...r, parameters: r.parameters.map(f => ({ fieldId: f.fieldId, storage: f.storage })) })) };
  const binding = { version: 1, scopeId: scope.scopeId, mappingRevision: 'test' };
  for (const name of ['mapping', 'sourceSnapshot', 'targetInventory', 'destinationPlan']) {
    await writeFile(join(dir, name + '.json'), bytes(d[name]));
    binding[name] = { path: name + '.json', sha256: hash(bytes(d[name])) };
  }
  const preparation = { version: 1, scope, evidence: [{ ...binding.sourceSnapshot, format: 'snapshot-json', sourceStateId: scope.sourceStateId, capturedAt: d.sourceSnapshot.capturedAt, scopeId: scope.scopeId, instanceId: scope.instanceId, database: scope.database }] };
  await writeFile(join(dir, 'prepare.json'), bytes(preparation));
  await prepareSourceSnapshot(join(dir, 'prepare.json'), join(dir, 'snapshot'));
  binding.sourceSnapshot = { path: 'snapshot/source-snapshot.json', sha256: hash(await readFile(join(dir, 'snapshot/source-snapshot.json'))) };
  await writeFile(join(dir, 'migration.json'), bytes(binding));
  const validation = { version: 1, scope, snapshot: binding.sourceSnapshot };
  await writeFile(join(dir, 'coverage.json'), bytes(validation));
  const request = { version: 1, migrationInput: { path: 'migration.json', sha256: hash(bytes(binding)) }, snapshotValidation: { path: 'coverage.json', sha256: hash(bytes(validation)) } };
  await writeFile(join(dir, 'transform.json'), bytes(request));
  return { dir, d, binding, input: join(dir, 'transform.json'), output: join(dir, 'output'), async run() { return transformContent(this.input, this.output); }, async cleanup() { await rm(dir, { recursive: true, force: true }); } };
}

