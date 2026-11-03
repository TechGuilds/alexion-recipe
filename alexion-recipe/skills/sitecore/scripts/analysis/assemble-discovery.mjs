#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveSxaInputs } from './derive-sxa-inputs.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const asArray = value => Array.isArray(value) ? value : [];
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a non-empty string');
  return value;
};
const sorted = values => [...new Set([...values].filter(value => typeof value === 'string' && value))].sort();
const pick = (record, lower, upper) => record?.[lower] ?? record?.[upper];

async function readScoped(base, relativePath) {
  text(relativePath, 'evidence path');
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe evidence path: ' + relativePath);
  }
  let current = await realpath(base);
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    current = resolve(current, part);
    const stat = await lstat(current);
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error('Unsafe evidence file: ' + relativePath);
  }
  return readFile(current);
}

async function readJSON(base, path) {
  try { return JSON.parse(await readScoped(base, path)); }
  catch (error) { throw new Error(path + ': ' + error.message); }
}

function parseJSONL(bytes, path) {
  const source = bytes.toString('utf8');
  const rows = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  }
  return rows;
}

function validateManifest(manifest, path) {
  // The remote SPE envelope carries kind. stagePowershellOutput deliberately
  // writes a transport manifest with completed status instead, preserving the
  // golden summary and verified file sizes. Accept both without altering bytes.
  const remote = manifest?.kind === 'kajoo-export' && (manifest.status === undefined || manifest.status === 'completed');
  const transferred = manifest?.kind === undefined && manifest?.status === 'completed';
  if (!manifest || (!remote && !transferred) || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.summary || typeof manifest.summary !== 'object') {
    throw new Error(path + ': invalid remote export or completed transfer manifest');
  }
  if (typeof manifest.summary.partial !== 'boolean' || typeof manifest.summary.limited !== 'boolean' ||
      !Number.isSafeInteger(manifest.summary.errorCount) || manifest.summary.errorCount < 0) throw new Error(path + ': manifest completeness flags partial, limited and errorCount are required');
  return manifest;
}

function validateManifestFile(manifest, manifestPath, recordsPath, bytes) {
  const name = basename(recordsPath);
  const entry = manifest.files.find(file => file?.name === name || (typeof file?.path === 'string' && file.path.replaceAll('\\', '/').endsWith('/' + name)));
  if (!entry) throw new Error(`${manifestPath}: does not declare ${name}`);
  const declaredSize = entry.size ?? entry.bytes;
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) throw new Error(`${manifestPath}: ${name} has no valid byte size`);
  if (declaredSize !== bytes.length) throw new Error(`${manifestPath}: ${name} byte size does not match the retained evidence`);
}

function completeness(manifest) {
  return manifest.summary.partial || manifest.summary.limited || manifest.summary.errorCount > 0 ? 'partial' : 'complete';
}

const batches = spec => Array.isArray(spec) ? spec : [spec];
const identity = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const recordKey = (row, device = false) => JSON.stringify([identity(row.id), row.language, String(row.version), ...(device ? [identity(row.deviceId)] : [])]);

// Shared evidence reader for identity records and relationship records alike.
// Consumers add operation/scope/record validation; byte and path checks stay here.
export async function readExport(base, spec) {
  const bytes = await readScoped(base, spec.records);
  const manifestBytes = await readScoped(base, spec.manifest);
  const manifest = validateManifest(JSON.parse(manifestBytes), spec.manifest);
  validateManifestFile(manifest, spec.manifest, spec.records, bytes);
  return {
    records: parseJSONL(bytes, spec.records), manifest,
    provenance: { ...spec, sha256: hash(bytes), manifestSha256: hash(manifestBytes), scope: manifest.summary.scope, completeness: completeness(manifest) },
  };
}

function validatePresentationScope(rows, actual, expected) {
  const nonemptySubset = (values, allowed, normalize = String) => Array.isArray(values) && values.length > 0 && values.every(value => allowed.map(normalize).includes(normalize(value)));
  const versionMatches = actual && (expected.versions.includes(actual.version) || expected.versions.includes('*') && /^[1-9][0-9]*$/.test(actual.version));
  if (!actual || actual.database !== expected.database || !versionMatches ||
      !nonemptySubset(actual.languages, expected.languages) || !nonemptySubset(actual.devices, expected.devices, identity) ||
      rows.length && (!Array.isArray(actual.itemPaths) || !actual.itemPaths.length)) throw new Error('presentation: capture scope does not match assembly scope');
  for (const row of rows) {
    if (!actual.languages.includes(row.language) || !actual.devices.map(identity).includes(identity(row.deviceId)) ||
        !actual.itemPaths.some(path => typeof path === 'string' && path.toLowerCase() === row.path?.toLowerCase()) ||
        /^[1-9][0-9]*$/.test(actual.version) && String(row.version) !== actual.version ||
        !Array.isArray(row.shared) || !Array.isArray(row.final)) throw new Error('presentation: record scope or resolved shared/final arrays invalid');
  }
}

export async function readBatches(base, spec, kind, expectedScope) {
  const records = new Map(), provenance = [];
  let partial = false;
  for (const batch of batches(spec)) {
    const { records: rows, manifest, provenance: source } = await readExport(base, batch);
    if (kind === 'presentation' && expectedScope) validatePresentationScope(rows, manifest.summary.scope, expectedScope);
    partial ||= completeness(manifest) !== 'complete';
    provenance.push(source);
    for (const row of rows) {
      if (!row.id || !row.language || !row.version || (kind === 'presentation' && !row.deviceId)) throw new Error(kind + ': missing record identity/language/version/device');
      const key = recordKey(row, kind === 'presentation');
      if (records.has(key) && JSON.stringify(records.get(key)) !== JSON.stringify(row)) throw new Error('conflicting ' + kind + ' records for ' + key);
      records.set(key, row);
    }
  }
  return { records: [...records.values()], manifest: { summary: { partial } }, provenance };
}

function reconcilePresentation(items, pages, devices) {
  const expected = new Map();
  for (const item of items.filter(row => row.hasPresentation === true)) for (const deviceId of devices) {
    const row = { id: item.id, path: item.path, language: item.language, version: item.version, deviceId };
    expected.set(recordKey(row, true), row);
  }
  const actual = new Set(pages.map(row => recordKey(row, true)));
  return {
    expectedPresentationRecords: expected.size,
    visitedPresentationRecords: actual.size,
    missing: [...expected].filter(([key]) => !actual.has(key)).map(([, row]) => row),
    unexpected: pages.filter(row => !expected.has(recordKey(row, true))).map(({ id, path, language, version, deviceId }) => ({ id, path, language, version, deviceId })),
    unknownPresentationFlags: items.filter(row => typeof row.hasPresentation !== 'boolean').map(row => ({ id: row.id, path: row.path })),
  };
}

const dependencySections = ['templates', 'datasources', 'layoutsPlaceholders', 'branches', 'resolvers', 'sxa', 'compatibility', 'duplicates'];

async function readDependencyAudit(base, spec) {
  if (!spec) return { version: 1, complete: false, sections: {}, evidence: [], missing: dependencySections };
  const bytes = await readScoped(base, spec.records);
  const audit = JSON.parse(bytes);
  if (audit.version !== 1 || !audit.sections || Array.isArray(audit.sections)) throw new Error('dependencyAudit requires version 1 and sections');
  const evidence = new Map(), missing = [], incomplete = [];
  for (const key of dependencySections) {
    const section = audit.sections[key];
    const paths = asArray(section?.evidence);
    if (!section || !['complete', 'not-applicable', 'partial', 'failed', 'unavailable'].includes(section.status) || !paths.length ||
      !Array.isArray(section.findings) || (section.status === 'not-applicable' && !section.reason)) missing.push(key);
    else if (!['complete', 'not-applicable'].includes(section.status)) incomplete.push(key);
    for (const path of paths) if (!evidence.has(path)) {
      const file = await readScoped(base, path);
      evidence.set(path, { path, bytes: file.length, sha256: hash(file) });
    }
  }
  return { ...audit, assessed: missing.length === 0, complete: missing.length === 0 && incomplete.length === 0, missing, incomplete,
    source: { records: spec.records, sha256: hash(bytes) }, evidence: [...evidence.values()] };
}

function validateInput(input) {
  if (!input || input.version !== 1) throw new Error('Discovery assembly input version must be 1');
  for (const key of ['source', 'scope', 'exports']) if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) throw new Error(key + ' is required');
  if (input.expectations !== undefined && (!input.expectations || typeof input.expectations !== 'object' || Array.isArray(input.expectations) || typeof input.expectations.allowEmptyContent !== 'boolean')) throw new Error('expectations.allowEmptyContent must be boolean when supplied');
  text(input.source.connectorId, 'source.connectorId');
  text(input.source.identity, 'source.identity');
  text(input.source.capturedAt, 'source.capturedAt');
  if (Number.isNaN(Date.parse(input.source.capturedAt))) throw new Error('source.capturedAt must be a valid timestamp');
  text(input.scope.siteRoot, 'scope.siteRoot');
  text(input.scope.database, 'scope.database');
  for (const key of ['languages', 'versions', 'devices']) if (!Array.isArray(input.scope[key]) || input.scope[key].length === 0 || input.scope[key].some(value => typeof value !== 'string' || !value)) throw new Error('scope.' + key + ' must be non-empty');
  for (const key of ['items', 'renderings', 'presentation']) {
    const value = input.exports[key];
    if (!value || typeof value !== 'object') throw new Error('exports.' + key + ' is required');
    if (!batches(value).length) throw new Error('exports.' + key + ' requires at least one manifest-backed batch');
    for (const batch of batches(value)) {
      text(batch?.records, `exports.${key}.records`);
      text(batch?.manifest, `exports.${key}.manifest`);
    }
  }
  return input;
}

const normalizeOccurrence = (page, occurrence, layout) => ({
  pageId: page.id,
  pagePath: page.path,
  language: page.language,
  version: page.version,
  deviceId: page.deviceId,
  layout,
  index: occurrence.index,
  uid: occurrence.uid,
  // SPE may return a presentation occurrence with no resolvable Sitecore
  // rendering ItemID. Preserve the occurrence, but never invent an identity.
  renderingId: String(occurrence.renderingId ?? '').trim() || null,
  placeholder: occurrence.placeholder ?? '',
  datasource: occurrence.datasource ?? '',
  parameters: occurrence.parameters ?? '',
});

function validateCoverageScope(records, actual, expected) {
  const sameSet = (values, allowed, normalize = value => value) => Array.isArray(values) && values.length > 0 &&
    values.every(value => typeof value === 'string' && value) &&
    JSON.stringify(sorted(values.map(normalize))) === JSON.stringify(sorted(allowed.map(normalize)));
  const positiveVersion = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
  if (!actual || actual.operation !== 'analyze-rendering-coverage' ||
      typeof actual.sitePath !== 'string' || actual.sitePath.toLowerCase() !== expected.siteRoot.toLowerCase() || actual.database !== expected.database ||
      expected.versions.length !== 1 || actual.version !== expected.versions[0] ||
      !/^(latest|\*|[1-9][0-9]*)$/.test(actual.version) ||
      !sameSet(actual.languages, expected.languages) || !sameSet(actual.devices, expected.devices, identity)) {
    throw new Error('coverage: capture scope does not match assembly scope; select a matching retained export or correct the coverage request scope');
  }
  const devices = new Set(actual.devices.map(identity));
  const siteRoot = actual.sitePath.toLowerCase();
  for (const row of records) {
    const type = String(pick(row, 'type', 'Type') ?? '').toLowerCase();
    const route = type === 'coverage';
    // Routes retain actual item versions; the other records use group scope.
    // With Version="*", every group is one actual numeric version.
    const versionScope = route ? row?.versionScope : row?.version;
    if (!row || !['frequency', 'coverage', 'uncovered', 'meta'].includes(type) ||
        !actual.languages.includes(row.language) || !devices.has(identity(row.deviceId)) ||
        (actual.version === '*' ? !positiveVersion(versionScope) : versionScope !== actual.version) ||
        (route && (!positiveVersion(row.version) || versionScope !== 'latest' && row.version !== versionScope))) {
      throw new Error('coverage: record scope does not match capture scope; recover a matching export without relabeling retained records');
    }
    if (route) {
      const itemPath = pick(row, 'itemPath', 'ItemPath');
      if (typeof itemPath !== 'string' || !/^\/sitecore\/[^\\:*?\[\]\p{Cc}]+$/iu.test(itemPath) ||
          /(^|\/)\.\.?($|\/)|\/\/|\/$/.test(itemPath) ||
          !(itemPath.toLowerCase() === siteRoot || itemPath.toLowerCase().startsWith(siteRoot + '/'))) {
        throw new Error('coverage: route item path is outside capture scope; recover a matching export without rewriting source paths');
      }
    }
  }
}

function coverageRecords(records) {
  const frequencies = [], routes = [], uncovered = [], metadata = { scopes: [] };
  for (const record of records) {
    const type = String(pick(record, 'type', 'Type') ?? '').toLowerCase();
    const scope = Object.fromEntries(['language', 'version', 'versionScope', 'deviceId'].filter(key => record[key] !== undefined).map(key => [key, record[key]]));
    if (type === 'frequency') frequencies.push({
      ...scope,
      renderingId: pick(record, 'renderingId', 'RenderingId'),
      name: pick(record, 'name', 'Name'),
      pageCount: Number(pick(record, 'pageCount', 'PageCount') ?? 0),
      isGlobal: Boolean(pick(record, 'isGlobal', 'IsGlobal')),
    });
    if (type === 'coverage') routes.push({
      ...scope,
      itemId: pick(record, 'itemId', 'ItemId') ?? null,
      route: pick(record, 'route', 'Route') ?? null,
      itemPath: pick(record, 'itemPath', 'ItemPath') ?? null,
      renderingIds: asArray(pick(record, 'renderingIds', 'RenderingIds')),
      renderingNames: asArray(pick(record, 'renderingNames', 'RenderingNames')),
      cumulativeCoverage: Number(pick(record, 'cumulativeCoverage', 'CumulativeCoverage') ?? 0),
    });
    if (type === 'uncovered') uncovered.push({ ...scope, renderingId: pick(record, 'renderingId', 'RenderingId') ?? null, name: pick(record, 'name', 'Name') ?? null });
    if (type === 'meta') metadata.scopes.push({
      ...scope, basis: record.basis ?? null,
      totalPages: Number(pick(record, 'totalPages', 'TotalPages') ?? 0),
      globalThreshold: Number(pick(record, 'globalThreshold', 'GlobalThreshold') ?? 0),
    });
  }
  // Preserve the single-scope projection; never overwrite one language or
  // device with the last group or present their sum as a unique page count.
  if (metadata.scopes.length === 1) Object.assign(metadata, metadata.scopes[0]);
  // The producer emits greedy coverage order; cumulativeCoverage depends on it.
  frequencies.sort((a, b) => String(a.renderingId).localeCompare(String(b.renderingId)));
  return { frequencies, routes, uncovered, metadata };
}

async function writeOutput(output, name, value, outputs) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  outputs.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
}

export async function assembleDiscovery(rawInput, { base, output }) {
  const input = validateInput(structuredClone(rawInput));
  const canonicalBase = await realpath(base);
  const canonicalParent = await realpath(dirname(resolve(output)));
  const target = join(canonicalParent, basename(resolve(output)));
  await mkdir(target, { recursive: false, mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Output directory already exists: ' + target);
    throw error;
  });

  const branches = {};
  for (const key of ['items', 'renderings', 'presentation']) {
    branches[key] = await readBatches(canonicalBase, input.exports[key], key, input.exports.dependencies ? input.scope : undefined);
  }
  const allowEmpty = input.expectations?.allowEmptyContent === true;
  if (branches.items.records.length === 0 && !allowEmpty) throw new Error('items evidence is empty; explicitly validate zero-result scope before assembly');

  const usage = branches.presentation.records.flatMap(page => [
    ...asArray(page.shared).map(occurrence => normalizeOccurrence(page, occurrence, 'shared')),
    ...asArray(page.final).map(occurrence => normalizeOccurrence(page, occurrence, 'final')),
  ]).sort((a, b) => String(a.pagePath).localeCompare(String(b.pagePath)) || String(a.deviceId).localeCompare(String(b.deviceId)) || a.layout.localeCompare(b.layout) || Number(a.index) - Number(b.index));

  const detailById = new Map();
  for (const rendering of branches.renderings.records) {
    if (/folder$/i.test(rendering.templateName ?? '')) continue;
    if (!rendering.id) throw new Error('rendering record is missing id');
    detailById.set(recordKey(rendering), rendering);
  }
  const renderingDetails = [...detailById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const renderingDefinitionCount = new Set(renderingDetails.map(row => identity(row.id))).size;
  const unresolved = [];
  let dependencyGraph = null, dependencyProcessing = null, dependencyStatus = 'unavailable';
  if (input.exports.dependencies) {
    if (input.scope.versions.length !== 1) throw new Error('Dependency assembly requires one explicit version scope (latest, *, or a selected version)');
    // Recompute graph acceptance from original exports, never trust a hand-edited
    // derived index or an assessment's complete label. Dynamic import avoids an
    // initialization cycle with the processor's shared raw-export reader.
    const { processDependencies } = await import('./process-dependencies.mjs');
    dependencyProcessing = await processDependencies({
      version: 1, targetFlavor: input.exports.dependencies.targetFlavor,
      scope: { ...input.scope, version: input.scope.versions[0] },
      expectations: { inventory: input.exports.items, renderings: input.exports.renderings },
      exports: { items: input.exports.dependencies.items, edges: input.exports.dependencies.edges },
    }, { base: canonicalBase, output: join(target, 'dependencies') });
    dependencyGraph = JSON.parse(await readFile(join(target, 'dependencies/dependency-index.json'), 'utf8'));
    dependencyStatus = dependencyProcessing.collectionComplete ? 'complete' : 'partial';
  }
  if (dependencyStatus !== 'complete') unresolved.push({ code: 'dependency-collection-incomplete', status: dependencyStatus });
  const collectionCoverage = reconcilePresentation(branches.items.records, branches.presentation.records, input.scope.devices);
  if (collectionCoverage.missing.length || collectionCoverage.unexpected.length || collectionCoverage.unknownPresentationFlags.length) {
    branches.presentation.manifest.summary.partial = true;
    unresolved.push({ code: 'presentation-collection-incomplete', missing: collectionCoverage.missing.length, unexpected: collectionCoverage.unexpected.length, unknownPresentationFlags: collectionCoverage.unknownPresentationFlags.length });
  }
  const knownRenderings = new Set(renderingDetails.map(record => identity(record.id)));
  for (const occurrence of usage) {
    if (!occurrence.renderingId) unresolved.push({
      code: 'rendering-identity-unavailable', pageId: occurrence.pageId, pagePath: occurrence.pagePath,
      layout: occurrence.layout, index: occurrence.index, uid: occurrence.uid,
      placeholder: occurrence.placeholder, datasource: occurrence.datasource,
    });
    else if (!knownRenderings.has(identity(occurrence.renderingId))) unresolved.push({ code: 'missing-rendering-definition', renderingId: occurrence.renderingId, pageId: occurrence.pageId });
  }

  const mappingByRendering = new Map();
  const mappingKeys = new Map();
  for (const occurrence of usage) {
    if (!occurrence.renderingId) continue;
    const normalized = identity(occurrence.renderingId);
    const key = mappingKeys.get(normalized) ?? occurrence.renderingId;
    if (!mappingByRendering.has(key)) {
      mappingByRendering.set(key, { renderingId: key, pageIds: new Set(), pagePaths: new Set(), routes: new Set(), occurrenceCount: 0 });
      mappingKeys.set(normalized, key);
    }
    const row = mappingByRendering.get(key);
    row.pageIds.add(occurrence.pageId); row.pagePaths.add(occurrence.pagePath); row.occurrenceCount++;
  }

  let coverage = { frequencies: [], routes: [], uncovered: [], metadata: {} }, coverageStatus = 'unavailable', coverageProvenance = null;
  if (input.exports.coverage) {
    const { records, manifest, provenance } = await readExport(canonicalBase, input.exports.coverage);
    validateCoverageScope(records, manifest.summary.scope, input.scope);
    coverage = coverageRecords(records);
    coverageStatus = completeness(manifest);
    coverageProvenance = provenance;
    for (const route of coverage.routes) {
      for (const renderingId of route.renderingIds) {
        const key = mappingKeys.get(identity(renderingId)) ?? renderingId;
        if (!mappingByRendering.has(key)) {
          mappingByRendering.set(key, { renderingId: key, pageIds: new Set(), pagePaths: new Set(), routes: new Set(), occurrenceCount: 0 });
          mappingKeys.set(identity(renderingId), key);
        }
        if (route.route) mappingByRendering.get(key).routes.add(route.route);
      }
    }
  } else unresolved.push({ code: 'route-coverage-unavailable', reason: 'No connector-backed coverage export was supplied' });

  const sxaPages = branches.presentation.records.filter(page => page.sxa && (page.sxa.pageDesign || page.sxa.partialDesigns || page.sxa.basePartialDesign)).map(page => ({
    pageId: page.id, pagePath: page.path, language: page.language, version: page.version, deviceId: page.deviceId, ...page.sxa,
  })).sort((a, b) => String(a.pagePath).localeCompare(String(b.pagePath)));
  if (!dependencyGraph) for (const page of sxaPages.filter(page => !page.expanded)) unresolved.push({ code: 'sxa-design-unexpanded', pageId: page.pageId, pagePath: page.pagePath });
  const sxaInspected = branches.presentation.records.filter(page => page.sxa && ['pageDesign', 'partialDesigns', 'basePartialDesign'].every(key => Object.hasOwn(page.sxa, key))).length;
  const sxaStatus = branches.presentation.records.length && !sxaInspected ? 'unavailable'
    : sxaInspected !== branches.presentation.records.length || sxaPages.some(page => !page.expanded) ? 'partial' : completeness(branches.presentation.manifest);
  if (sxaInspected !== branches.presentation.records.length) {
    // Native SXA fields are required presentation capture, even when all three
    // selected values would be empty. A complete dependency graph cannot infer
    // whether a missing field was empty or failed to read.
    branches.presentation.manifest.summary.partial = true;
    unresolved.push({ code: 'sxa-fields-unavailable', inspected: sxaInspected, expected: branches.presentation.records.length });
  }

  const templateSource = input.exports.templateClassifications ? await readJSON(canonicalBase, input.exports.templateClassifications.records) : null;
  if (templateSource && !Array.isArray(templateSource.classifications)) throw new Error('templateClassifications requires { classifications: [...] }');
  const classifications = new Map(asArray(templateSource?.classifications).map(item => [String(item.templateId).toLowerCase(), item]));
  const templateAudit = [...new Map([
    ...asArray(templateSource?.classifications).map(item => [String(item.templateId).toLowerCase(), item]),
    ...branches.items.records.map(item => [String(item.templateId).toLowerCase(), { templateId: item.templateId, templateName: item.templateName }]),
  ]).values()].map(item => {
    const classification = classifications.get(String(item.templateId).toLowerCase());
    return { ...item, ...classification, classification: classification?.classification ?? 'unknown', reason: classification?.reason ?? 'No reviewed template classification evidence supplied' };
  }).sort((a, b) => String(a.templateId).localeCompare(String(b.templateId)));
  if (templateAudit.some(item => item.classification === 'unknown')) unresolved.push({ code: 'template-classification-incomplete', unknownCount: templateAudit.filter(item => item.classification === 'unknown').length });

  let serialization = { version: 1, status: 'unavailable', reason: 'No serialization plan supplied', modules: [], includes: [], suggestedExclusions: [] };
  if (input.exports.serialization) {
    const source = await readJSON(canonicalBase, input.exports.serialization.manifest);
    const modules = asArray(source.modules);
    const includes = sorted(modules.flatMap(module => asArray(module.includePaths)));
    const moduleEvidence = [];
    for (const module of modules) {
      const bytes = await readScoped(canonicalBase, module.configPath);
      const config = JSON.parse(bytes);
      const actualPaths = sorted(asArray(config.items?.includes).map(include => include.path));
      if (!config.namespace || JSON.stringify(actualPaths) !== JSON.stringify(sorted(asArray(module.includePaths)))) throw new Error(module.configPath + ': include paths do not match the retained module');
      moduleEvidence.push({ path: module.configPath, bytes: bytes.length, sha256: hash(bytes) });
    }
    serialization = {
      version: 1,
      status: source.status ?? (source.missingReferences?.length ? 'partial' : 'complete'),
      sourceDependencyManifestSha256: source.sourceDependencyManifestSha256 ?? null,
      sourceManifest: input.exports.serialization.manifest,
      scope: input.scope,
      modules,
      moduleEvidence,
      includes,
      itemCount: source.itemCount ?? null,
      templateCount: source.templateCount ?? null,
      missingReferences: asArray(source.missingReferences),
      suggestedExclusions: asArray(input.exports.serialization.suggestedExclusions),
    };
    if (serialization.status !== 'complete') unresolved.push({ code: 'serialization-incomplete', status: serialization.status, missingReferences: serialization.missingReferences.length });
  } else unresolved.push({ code: 'serialization-unavailable', reason: serialization.reason });

  const dependencyAudit = await readDependencyAudit(canonicalBase, input.exports.dependencyAudit);
  if (!dependencyAudit.complete) unresolved.push({ code: 'dependency-assessments-incomplete', missing: dependencyAudit.missing });
  const includedPaths = new Set(serialization.includes.map(path => path.toLowerCase()));
  const missingDependencyPaths = dependencyGraph ? sorted(dependencyGraph.nodes.map(row => row.path).filter(path => !includedPaths.has(path.toLowerCase()))) : [];
  if (missingDependencyPaths.length) unresolved.push({ code: 'serialization-dependencies-missing', paths: missingDependencyPaths });
  const dependencyItemManifest = dependencyProcessing?.inputs?.find(row => row.manifest === input.exports.dependencies?.items?.manifest);
  const serializedItemsWasProduced = dependencyProcessing?.outputs?.some(row => row.path === 'serialization-items.json') === true;
  const plannedDependencyPaths = sorted(serialization.includes.map(path => path.toLowerCase()));
  const capturedDependencyPaths = dependencyGraph ? sorted(dependencyGraph.nodes.map(row => row.path.toLowerCase())) : [];
  const serializationMatchesObservedGraph = JSON.stringify(plannedDependencyPaths) === JSON.stringify(capturedDependencyPaths);
  const partialSerializationProvenanceMatches = serializedItemsWasProduced && dependencyItemManifest?.manifestSha256 &&
    serialization.sourceDependencyManifestSha256 === dependencyItemManifest.manifestSha256 && serializationMatchesObservedGraph;
  if (serialization.status === 'partial' && !partialSerializationProvenanceMatches) unresolved.push({
    code: 'partial-serialization-provenance-mismatch',
    sourceManifestMatches: Boolean(dependencyItemManifest?.manifestSha256 && serialization.sourceDependencyManifestSha256 === dependencyItemManifest.manifestSha256),
    observedPathSetMatches: serializationMatchesObservedGraph,
    processorEmittedPathInventory: serializedItemsWasProduced,
  });
  const serializationReady = serialization.status === 'complete' &&
    !asArray(serialization.missingReferences).length && missingDependencyPaths.length === 0 &&
    (serialization.includes.length > 0 || (allowEmpty && branches.items.records.length === 0));
  const dependencySupplementalOnly = dependencyStatus !== 'complete' && dependencyProcessing?.scopeReconciled === true && dependencyProcessing?.boundedComplete === true;
  // Historical Discovery required a generated, non-empty serialization plan,
  // not proof that every supplemental reference could be resolved. Keep the
  // unresolved references in the report and reserve full serialization
  // readiness for a complete graph with exact path reconciliation.
  const coreSerializationReady = (serialization.includes.length > 0 || (allowEmpty && branches.items.records.length === 0)) &&
    (dependencySupplementalOnly
      ? serialization.status === 'partial' && partialSerializationProvenanceMatches
      : serialization.status === 'complete' && !asArray(serialization.missingReferences).length);
  if (!serialization.includes.length && serialization.status === 'complete' && !(allowEmpty && branches.items.records.length === 0)) unresolved.push({ code: 'serialization-includes-empty' });
  if (asArray(serialization.missingReferences).length) unresolved.push({ code: 'serialization-references-unresolved', count: serialization.missingReferences.length });

  const branchCompleteness = Object.fromEntries(Object.entries(branches).map(([key, value]) => [key, completeness(value.manifest)]));
  const coreCapturesComplete = Object.values(branchCompleteness).every(status => status === 'complete') &&
    (branches.items.records.length > 0 || allowEmpty) &&
    collectionCoverage.missing.length === 0 && collectionCoverage.unexpected.length === 0 && collectionCoverage.unknownPresentationFlags.length === 0 &&
    !unresolved.some(issue => issue.code === 'missing-rendering-definition') &&
    sxaInspected === branches.presentation.records.length &&
    coreSerializationReady;
  // A partial dependency graph may contain recoverable misses in supplemental
  // references outside the complete source inventory. Accept the historical
  // core collection only when its scope/seeds reconcile and traversal was not
  // truncated; keep all graph/serialization gaps visible and full deliverables
  // unready. Complete graphs still require exact serialization reconciliation.
  const discoveryReady = coreCapturesComplete && dependencyAudit.assessed &&
    (dependencySupplementalOnly || (dependencyProcessing?.collectionComplete === true && serializationReady));
  const sxaFacts = dependencyGraph ? deriveSxaInputs({
    presentation: branches.presentation.records, dependencies: dependencyGraph, scope: input.scope,
    completeness: { presentation: branchCompleteness.presentation, dependencies: dependencyStatus },
  }) : { version: 1, status: 'partial', completeness: sxaStatus, scope: 'direct-presentation-design-references', inspectedRecords: sxaInspected, pages: sxaPages };
  const overall = [...Object.values(branchCompleteness), coverageStatus, serialization.status].includes('partial') || unresolved.length ? 'partial' : 'complete';
  const outputs = [];
  if (dependencyProcessing) {
    outputs.push(...dependencyProcessing.outputs.map(file => ({ ...file, path: 'dependencies/' + file.path })));
  }
  await writeOutput(target, 'dependency-audit.json', dependencyAudit, outputs);
  await writeOutput(target, 'rendering-usage.jsonl', usage.map(row => JSON.stringify(row)).join('\n') + (usage.length ? '\n' : ''), outputs);
  await writeOutput(target, 'rendering-details.json', { version: 1, completeness: branchCompleteness.renderings, source: branches.renderings.provenance, renderings: renderingDetails }, outputs);
  await writeOutput(target, 'rendering-page-mapping.json', { version: 1, completeness: coverageStatus === 'complete' && branchCompleteness.presentation === 'complete' ? 'complete' : 'partial', renderings: [...mappingByRendering.values()].map(row => ({ renderingId: row.renderingId, pageIds: sorted(row.pageIds), pagePaths: sorted(row.pagePaths), routes: sorted(row.routes), occurrenceCount: row.occurrenceCount })).sort((a, b) => String(a.renderingId).localeCompare(String(b.renderingId))), source: { presentation: branches.presentation.provenance, coverage: coverageProvenance } }, outputs);
  await writeOutput(target, 'sxa-conversion-inputs.json', { ...sxaFacts, source: { presentation: branches.presentation.provenance, dependencies: dependencyProcessing?.inputs ?? [] } }, outputs);
  await writeOutput(target, 'xp-only-template-audit.json', { version: 1, completeness: templateAudit.every(item => item.classification !== 'unknown') ? branchCompleteness.items : 'partial', source: input.exports.templateClassifications?.records ?? branches.items.provenance, templates: templateAudit }, outputs);
  await writeOutput(target, 'serialization-config.json', serialization, outputs);
  await writeOutput(target, 'coverage-plan.json', { version: 1, completeness: coverageStatus, source: coverageProvenance, ...coverage }, outputs);
  const sharedOccurrences = usage.filter(row => row.layout === 'shared').length;
  const finalOccurrences = usage.filter(row => row.layout === 'final').length;
  const occurrenceMeaning = 'Shared and final view records may overlap; their sum is not a unique runtime rendering count. Final occurrence records are not raw XML deltas.';
  const report = [
    '# Content Discovery Report', '',
    `- Source: ${input.source.identity} (${input.source.connectorId})`,
    `- Site root: ${input.scope.siteRoot}`,
    `- Scope: ${input.scope.database}; languages ${input.scope.languages.join(', ')}; versions ${input.scope.versions.join(', ')}; devices ${input.scope.devices.join(', ')}`,
    `- Items: ${branches.items.records.length}`,
    `- Distinct rendering definitions: ${renderingDefinitionCount}`,
    `- Presentation records: ${branches.presentation.records.length}`,
    `- Expected item/language/version/device presentation records: ${collectionCoverage.expectedPresentationRecords}`,
    `- Missing presentation records: ${collectionCoverage.missing.length}`,
    `- Shared occurrence records: ${sharedOccurrences}`,
    `- Final occurrence records: ${finalOccurrences}`,
    `- Combined occurrence records: ${usage.length}`,
    `- Count interpretation: ${occurrenceMeaning}`,
    `- Coverage routes: ${coverage.routes.length}`,
    `- Overall completeness: ${overall}`,
    `- Historical Discovery acceptance: ${discoveryReady ? 'success with findings' : 'not ready'}`,
    '', '## Dependency assessments', '',
    '| Assessment | Collection status | Findings |', '|---|---|---|',
    ...dependencySections.map(key => `| ${key} | ${dependencyAudit.sections[key]?.status ?? 'unavailable'} | ${asArray(dependencyAudit.sections[key]?.findings).length} |`),
    '', `Serialization planning: ${serialization.status}; ${serialization.modules.length} modules; ${serialization.includes.length} include paths.`,
    '', '## Findings and collection gaps', '',
    'Assess these against the content-collection checklist; do not copy optional or later-work findings into failed task acceptance checks.',
    ...(unresolved.length ? unresolved.map(item => `- ${item.code}: ${JSON.stringify(item)}`) : ['- None']),
    '',
  ].join('\n');
  await writeOutput(target, 'content-discovery-report.md', report, outputs);
  const manifest = {
    kind: 'sitecore-discovery-evidence', version: 1,
    source: input.source, scope: input.scope,
    capturedAt: input.source.capturedAt,
    counts: { items: branches.items.records.length, renderingCatalogRecords: branches.renderings.records.length, renderingFolders: branches.renderings.records.filter(row => /folder$/i.test(row.templateName ?? '')).length, renderingDefinitions: renderingDefinitionCount, presentationRecords: branches.presentation.records.length, sharedOccurrences, finalOccurrences, renderingOccurrences: usage.length, coverageRoutes: coverage.routes.length, sxaPages: sxaPages.length, templates: templateAudit.length },
    countInterpretation: { renderingOccurrences: occurrenceMeaning },
    completeness: { ...branchCompleteness, dependencies: dependencyStatus, sxa: sxaFacts.status, coverage: coverageStatus, serialization: serialization.status, overall },
    discoveryReady,
    collectionCoverage,
    synthesisReady: Object.values(branchCompleteness).every(status => status === 'complete') &&
      (branches.items.records.length > 0 || allowEmpty) &&
      !unresolved.some(issue => issue.code === 'missing-rendering-definition'),
    inputs: Object.fromEntries(Object.entries(branches).map(([key, value]) => [key, value.provenance])),
    unresolved,
    outputs,
  };
  // A structural evidence check, not a substitute for the coordinator's semantic audit
  // or the worker's required Kajoo report publication/read-back.
  manifest.deliverablesReady = manifest.synthesisReady && dependencyAudit.complete && dependencyStatus === 'complete' && sxaFacts.status === 'complete' && serializationReady;
  await writeFile(join(target, 'discovery-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { valid: true, discoveryReady: manifest.discoveryReady, synthesisReady: manifest.synthesisReady, deliverablesReady: manifest.deliverablesReady, completeness: manifest.completeness, output: target, outputs: outputs.length + 1, unresolved: unresolved.length };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node assemble-discovery.mjs --input /absolute/staged.json --output /absolute/new-directory');
    return;
  }
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('Expected --input staged.json --output new-directory');
  const inputPath = resolve(args[1]);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  console.log(JSON.stringify(await assembleDiscovery(input, { base: dirname(inputPath), output: resolve(args[3]) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ valid: false, error: error.message })); process.exitCode = 1; });
}
