#!/usr/bin/env node
// Derive closure facts and serialization inputs from retained SPE exports.
// Compatibility judgments and Discovery acceptance remain separate assessments.
import { createHash } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExport } from './assemble-discovery.mjs';
import { deriveDependencySeeds } from './prepare-dependency-request.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...new Set(values)].sort();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const guid = value => {
  const text = String(value ?? '').replace(/^\{|\}$/g, '').toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(text)) throw Error('Invalid dependency identity: ' + value);
  return text;
};
const key = row => JSON.stringify([guid(row.id), row.language, String(row.version)]);
const targetKey = edge => key({ id: edge.targetId, language: edge.language, version: edge.version });
const identity = row => ({ id: row.id, language: row.language, version: row.version });
const kinds = new Set(['content', 'datasource', 'template', 'rendering', 'layout', 'placeholder', 'branch', 'resolver', 'sxa']);
const baselineAreas = ['Email', 'Analytics', 'Marketing Automation', 'Marketing Control Panel', 'xDB', 'List Management'].map(name => '/sitecore/templates/System/' + name);
const pathWithin = (path, root) => path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(root.toLowerCase() + '/');
const sameSet = (a, b, normalize = String) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(sorted(a.map(normalize))) === JSON.stringify(sorted(b.map(normalize)));

function validateScope(actual, expected) {
  if (!actual || actual.operation !== 'inspect-dependencies' || actual.database !== expected.database || actual.version !== expected.version ||
      !sameSet(actual.languages, expected.languages) || !sameSet(actual.devices, expected.devices, guid) || !Array.isArray(actual.seeds) || actual.seeds.length === 0 ||
      !Number.isSafeInteger(actual.remainingRequests) || actual.remainingRequests < 0) throw Error('Dependency export scope does not match requested scope');
}

async function reconcileScope(base, expectations, scope, nodesByKey) {
  const inputs = [], missing = [], roots = new Set(), renderingScopes = [], latestVersions = new Map();
  for (const kind of ['inventory', 'renderings']) {
    const spec = expectations?.[kind], batches = Array.isArray(spec) ? spec : spec ? [spec] : [];
    if (!batches.length) { missing.push({ code: 'expected-capture-missing', kind }); continue; }
    for (const batch of batches) {
      const capture = await readExport(base, batch), summary = capture.manifest.summary, actual = summary.scope;
      inputs.push({ kind, ...capture.provenance });
      if (!actual || actual.database !== scope.database || actual.version !== scope.version || !sameSet(actual.languages, scope.languages)) throw Error('Expected capture scope mismatch');
      const declaredRoots = kind === 'inventory' ? [actual.sitePath] : actual.itemPaths;
      if (!Array.isArray(declaredRoots) || !declaredRoots.length || declaredRoots.some(path => typeof path !== 'string' || !path.startsWith('/sitecore/')) ||
          kind === 'inventory' && (!scope.siteRoot || actual.sitePath?.toLowerCase() !== scope.siteRoot.toLowerCase() || actual.includesRoot !== true)) throw Error('Expected capture root scope missing or mismatched');
      if (kind === 'renderings') {
        if (typeof actual.recurse !== 'boolean' || declaredRoots.some(path => !pathWithin(path, '/sitecore/layout/Renderings'))) throw Error('Expected rendering root scope missing or mismatched');
        renderingScopes.push(...declaredRoots.map(reference => ({ reference, recursive: actual.recurse })));
      }
      if (typeof summary.limited !== 'boolean' || !Number.isSafeInteger(summary.errorCount) || summary.errorCount < 0 || summary.visited !== capture.records.length) throw Error('Expected capture flags/counts do not match retained records');
      if (summary.partial || summary.limited || summary.errorCount) missing.push({ code: 'expected-capture-partial', kind, manifest: batch.manifest });
      for (const row of capture.records) {
        if (typeof row.path !== 'string' || !declaredRoots.some(path => pathWithin(row.path, path)) || !scope.languages.includes(row.language) ||
            !/^[1-9][0-9]*$/.test(String(row.version)) ||
            kind === 'renderings' && !actual.recurse && !declaredRoots.some(path => row.path.toLowerCase() === path.toLowerCase())) throw Error('Expected capture record outside scope or version');
        if (/^[1-9][0-9]*$/.test(scope.version) && String(row.version) !== scope.version) throw Error('Expected capture version outside requested scope');
        const latestKey = JSON.stringify([kind, guid(row.id), row.language]);
        if (scope.version === 'latest' && latestVersions.has(latestKey) && latestVersions.get(latestKey) !== String(row.version)) throw Error('Conflicting latest versions in expected capture');
        latestVersions.set(latestKey, String(row.version));
        if (kind === 'inventory' && row.path.toLowerCase() === scope.siteRoot.toLowerCase()) roots.add(row.language);
        const retained = nodesByKey.get(key(row));
        if (!retained || retained.path.toLowerCase() !== row.path.toLowerCase()) missing.push({ code: 'expected-identity-missing-or-changed', kind, ...identity(row), path: row.path });
      }
    }
  }
  for (const language of scope.languages) if (!roots.has(language)) missing.push({ code: 'expected-inventory-root-missing', language });
  return { complete: missing.length === 0, missing, inputs, expectedSeeds: missing.some(row => row.code === 'expected-capture-missing') ? null : deriveDependencySeeds(scope.siteRoot, renderingScopes) };
}

// Iterative SCC detection avoids stack overflow for deep base-template chains.
function cycles(nodes, edges, relations, family) {
  const byKey = new Map(nodes.map(row => [key(row), row]));
  const ids = sorted(byKey.keys()), forward = new Map(ids.map(id => [id, new Set()])), reverse = new Map(ids.map(id => [id, new Set()]));
  for (const edge of edges) if (edge.status === 'resolved' && edge.consumer && relations.has(edge.relation) && forward.has(key(edge.consumer)) && forward.has(targetKey(edge))) {
    forward.get(key(edge.consumer)).add(targetKey(edge)); reverse.get(targetKey(edge)).add(key(edge.consumer));
  }
  const visited = new Set(), order = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    const stack = [[start, false]];
    while (stack.length) {
      const [current, finished] = stack.pop();
      if (finished) { order.push(current); continue; }
      if (visited.has(current)) continue;
      visited.add(current); stack.push([current, true]);
      for (const next of forward.get(current)) if (!visited.has(next)) stack.push([next, false]);
    }
  }
  const assigned = new Set(), result = [];
  for (const start of order.reverse()) {
    if (assigned.has(start)) continue;
    const stack = [start], members = [];
    while (stack.length) {
      const current = stack.pop();
      if (assigned.has(current)) continue;
      assigned.add(current); members.push(current);
      for (const next of reverse.get(current)) if (!assigned.has(next)) stack.push(next);
    }
    if (members.length > 1 || forward.get(start).has(start)) result.push({ family, ids: sorted(members.map(value => byKey.get(value).id)), members: members.sort().map(value => identity(byKey.get(value))) });
  }
  return result.sort((a, b) => compare(a.ids[0], b.ids[0]));
}

function reverseConsumers(nodes, edges) {
  const incoming = new Map(nodes.map(row => [key(row), new Set()]));
  const byKey = new Map(nodes.map(row => [key(row), row]));
  // child/catalog containment is discovery scope, not semantic consumption.
  const containment = new Set(['child', 'seed', 'template-module', 'resolver-catalog', 'module-settings', 'module-branch']);
  for (const edge of edges) if (edge.status === 'resolved' && edge.consumer && !containment.has(edge.relation) && incoming.has(targetKey(edge)) && byKey.has(key(edge.consumer))) incoming.get(targetKey(edge)).add(key(edge.consumer));
  return sorted(nodes.filter(row => ['template', 'branch', 'resolver', 'sxa', 'datasource'].includes(row.kind)).map(key)).map(id => {
    const seen = new Set([id]), stack = [...incoming.get(id)], consumers = new Set();
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      if (['content', 'datasource', 'rendering'].includes(byKey.get(next).kind)) consumers.add(next);
      for (const parent of incoming.get(next) ?? []) if (!seen.has(parent)) stack.push(parent);
    }
    const contentItemKeys = sorted([...consumers].filter(value => ['content', 'datasource'].includes(byKey.get(value).kind)));
    const renderingKeys = sorted([...consumers].filter(value => byKey.get(value).kind === 'rendering'));
    return { ...identity(byKey.get(id)), directConsumers: sorted(incoming.get(id)).map(value => identity(byKey.get(value))),
      contentItemConsumers: contentItemKeys.map(value => identity(byKey.get(value))),
      renderingConsumers: renderingKeys.map(value => identity(byKey.get(value))),
      contentItemIds: sorted(contentItemKeys.map(value => byKey.get(value).id)),
      renderingIds: sorted(renderingKeys.map(value => byKey.get(value).id)) };
  });
}

export async function processDependencies(input, { base, output }) {
  if (input?.version !== 1 || !input.scope || !input.exports || !['xmc', 'xp-headless', 'xp-mvc'].includes(input.targetFlavor)) throw Error('Dependency processing requires version 1, scope, exports and explicit targetFlavor');
  const scope = input.scope;
  if (!scope.database || !scope.version || !Array.isArray(scope.languages) || !scope.languages.length || !Array.isArray(scope.devices) || !scope.devices.length) throw Error('Explicit dependency scope is required');
  const itemBatch = await readExport(base, input.exports.items), edgeBatch = await readExport(base, input.exports.edges);
  // One export emits the paired node and edge streams. Cross-attempt joins are
  // unsafe unless an explicit reconciler proves their scope and remaining work.
  if (input.exports.items.manifest !== input.exports.edges.manifest || itemBatch.provenance.manifestSha256 !== edgeBatch.provenance.manifestSha256) throw Error('Dependency items and edges must share one retained export manifest');
  validateScope(itemBatch.manifest.summary.scope, scope);
  const summary = itemBatch.manifest.summary;
  if (typeof summary.limited !== 'boolean' || !Number.isSafeInteger(summary.errorCount) || summary.errorCount < 0 || !Number.isSafeInteger(summary.visited) || summary.visited < 0) throw Error('Dependency export completeness flags/counts are required');
  const nodesByKey = new Map(), gaps = [], latestVersions = new Map();
  for (const record of itemBatch.records) {
    if (!record || !kinds.has(record.kind) || !scope.languages.includes(record.language) || !/^\d+$/.test(String(record.version)) ||
        typeof record.path !== 'string' || !record.path.startsWith('/sitecore/') || record.path.split('/').some(part => part === '.' || part === '..') ||
        !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields) || !Array.isArray(record.fieldDefinitions)) throw Error('Invalid dependency node identity, scope or raw fields');
    if (/^\d+$/.test(scope.version) && String(record.version) !== scope.version &&
        !(String(record.version) === '0' && !pathWithin(record.path, '/sitecore/content'))) throw Error('Dependency record version outside requested scope');
    const normalized = { ...record, id: guid(record.id), version: String(record.version) }, identity = key(normalized);
    const latestKey = JSON.stringify([normalized.id, normalized.language]);
    if (scope.version === 'latest' && latestVersions.has(latestKey) && latestVersions.get(latestKey) !== normalized.version) throw Error('conflicting latest dependency versions');
    latestVersions.set(latestKey, normalized.version);
    if (nodesByKey.has(identity) && JSON.stringify(nodesByKey.get(identity)) !== JSON.stringify(normalized)) throw Error('conflicting dependency records for ' + identity);
    nodesByKey.set(identity, normalized);
  }
  const nodes = [...nodesByKey.values()].sort((a, b) => compare(key(a), key(b)));
  const reconciliation = await reconcileScope(base, input.expectations, scope, nodesByKey);
  gaps.push(...reconciliation.missing);
  const expectedSeedKeys = reconciliation.expectedSeeds?.map(row => JSON.stringify([row.reference.toLowerCase(), row.kind, row.recursive, row.optional]));
  const actualSeedKeys = summary.scope.seeds.map(row => JSON.stringify([String(row?.reference ?? '').toLowerCase(), row?.kind, row?.recursive, row?.optional]));
  const seedsReconciled = !!expectedSeedKeys && JSON.stringify(actualSeedKeys.sort()) === JSON.stringify(expectedSeedKeys.sort());
  if (expectedSeedKeys && !seedsReconciled) gaps.push({ code: 'seed-scope-mismatch', expected: reconciliation.expectedSeeds, actual: summary.scope.seeds });
  if (nodes.length !== summary.visited) gaps.push({ code: 'visited-count-mismatch', expected: summary.visited, retained: nodes.length });
  const edgeMap = new Map();
  for (const record of edgeBatch.records) {
    if (!record || !['resolved', 'dynamic', 'unresolved-expression', 'empty', 'missing', 'failed', 'available-outside-scope'].includes(record.status) || typeof record.required !== 'boolean' || !record.relation || !kinds.has(record.kind)) throw Error('Invalid dependency edge');
    const row = { ...record, consumer: record.consumer ? { ...record.consumer, id: guid(record.consumer.id), version: String(record.consumer.version) } : null };
    if (row.consumer && !nodesByKey.has(key(row.consumer))) gaps.push({ code: 'missing-consumer', consumer: row.consumer, relation: row.relation });
    if (row.status === 'resolved') {
      row.targetId = guid(row.targetId); row.version = String(row.version);
      if (row.consumer && row.consumer.language !== row.language) gaps.push({ code: 'cross-language-edge', consumer: row.consumer, target: { id: row.targetId, language: row.language, version: row.version }, relation: row.relation });
      if (!nodesByKey.has(key({ id: row.targetId, language: row.language, version: row.version }))) gaps.push({ code: 'missing-target', id: row.targetId, language: row.language, version: row.version, relation: row.relation });
    } else if (row.status === 'failed' || row.required && row.status === 'missing') gaps.push({ code: 'unread-reference', ...row });
    else if (row.status === 'available-outside-scope') gaps.push({ code: 'dependency-outside-requested-scope', ...row });
    edgeMap.set(JSON.stringify(row), row);
  }
  const edges = [...edgeMap.entries()].sort(([a], [b]) => compare(a, b)).map(([, row]) => row);
  const semanticEdges = edges.filter(row => row.status === 'resolved' && row.consumer && row.consumer.language === row.language &&
    nodesByKey.has(key(row.consumer)) && nodesByKey.has(targetKey(row)));
  const paths = new Map();
  for (const row of nodes) {
    const path = row.path.toLowerCase();
    if (!paths.has(path)) paths.set(path, { path: row.path, ids: new Set(), kinds: new Set() });
    paths.get(path).ids.add(row.id); paths.get(path).kinds.add(row.kind);
  }
  const duplicates = [...paths.values()].filter(row => row.ids.size > 1).map(row => ({ path: row.path, ids: sorted(row.ids) })).sort((a, b) => compare(a.path, b.path));
  const kindConflicts = [...paths.values()].filter(row => row.kinds.size > 1).map(row => ({ path: row.path, kinds: sorted(row.kinds) }));
  const collectionComplete = !summary.partial && !summary.limited && summary.errorCount === 0 && summary.scope.remainingRequests === 0 && !gaps.length;
  const serializationReady = collectionComplete && duplicates.length === 0 && kindConflicts.length === 0;
  const boundedComplete = !summary.limited && summary.scope.remainingRequests === 0 && nodes.length === summary.visited;
  const scopeReconciled = reconciliation.complete && seedsReconciled;
  const serializationPathsUsable = scopeReconciled && boundedComplete && duplicates.length === 0 && kindConflicts.length === 0;
  const consumers = reverseConsumers(nodes, semanticEdges);
  const index = { version: 1, status: collectionComplete ? 'complete' : 'partial', scope, nodes, edges, reverseConsumers: consumers, duplicates, kindConflicts,
    cycles: [...cycles(nodes, semanticEdges, new Set(['base-template']), 'template-inheritance'), ...cycles(nodes, semanticEdges, new Set(['page-design', 'partial-design', 'base-partial-design']), 'sxa-design')],
    findings: edges.filter(row => row.status !== 'resolved'), gaps,
    limitations: ['Closure is relative to the recorded seeds; verify seed coverage against inventory and rendering catalogs.', 'Path collision assessment is scoped to retained identities, not an instance-wide SQL duplicate scan.', 'Raw dependency collection does not prove runtime behavior or target compatibility.'] };
  const baseline = input.targetFlavor === 'xmc' ? baselineAreas : [];
  const consumerByIdentity = new Map(consumers.map(row => [key(row), row]));
  const review = { version: 1, status: 'requires-review', targetFlavor: input.targetFlavor, baselineAreas: baseline,
    candidates: nodes.filter(row => row.kind === 'template' && baseline.some(area => pathWithin(row.path, area))).map(row => ({ id: row.id, path: row.path, language: row.language, version: row.version, basis: 'target-policy-review', approvedExclusion: false,
      usedByItems: consumerByIdentity.get(key(row))?.contentItemIds ?? [], usedByRenderings: consumerByIdentity.get(key(row))?.renderingIds ?? [],
      usedByItemIdentities: consumerByIdentity.get(key(row))?.contentItemConsumers ?? [], usedByRenderingIdentities: consumerByIdentity.get(key(row))?.renderingConsumers ?? [],
      suggestedReplacements: [], reason: 'Observed dependency in an XMC baseline review area; path category alone does not establish incompatibility.' })),
    templateIds: sorted(nodes.filter(row => row.kind === 'template').map(row => row.id)),
    limitations: ['Review all captured template/base/branch dependencies against the selected target. This file is review input, not approved exclusions or completed classifications.'] };
  const parent = await realpath(dirname(resolve(output))), target = join(parent, basename(resolve(output)));
  await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code === 'EEXIST') throw Error('Output directory already exists: ' + target); throw error; });
  const outputs = [];
  async function emit(name, data) {
    const bytes = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    await writeFile(join(target, name), bytes, { flag: 'wx', mode: 0o600 });
    outputs.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  await emit('dependency-index.json', index);
  await emit('compatibility-review-input.json', review);
  if (serializationPathsUsable) {
    const dependencyIndex = outputs.find(file => file.path === 'dependency-index.json');
    await emit('serialization-items.json', {
      version: 1, status: serializationReady ? 'complete' : 'partial', scope,
      source: { dependencyManifestSha256: itemBatch.provenance.manifestSha256, dependencyIndexSha256: dependencyIndex.sha256 },
      items: [...paths.values()].map(row => ({ path: row.path, kind: [...row.kinds][0] })).sort((a, b) => compare(a.path, b.path)),
    });
  }
  const result = { version: 1, collectionComplete, boundedComplete, scopeReconciled, serializationReady, discoveryComplete: false, scope, nodeCount: nodes.length, edgeCount: edges.length, inputs: [itemBatch.provenance, edgeBatch.provenance, ...reconciliation.inputs], outputs };
  await emit('dependency-processing-manifest.json', { ...result, outputs: [...outputs] });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw Error('Usage: process-dependencies.mjs --input <input.json> --output <new-directory>');
    const inputPath = resolve(args[1]);
    const result = await processDependencies(JSON.parse(await readFile(inputPath, 'utf8')), { base: dirname(inputPath), output: resolve(args[3]) });
    console.log(JSON.stringify(result));
    // Partial collection is valid evidence, not a script/tool failure. Keep its
    // completeness flags in the result; reserve non-zero exit codes for invalid
    // input, corrupt evidence, or processor errors caught below.
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
