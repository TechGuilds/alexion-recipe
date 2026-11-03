#!/usr/bin/env node

/*
 * Deterministic Sitecore Discovery synthesis.
 *
 * This is deliberately a local, draft-only join. It consumes the terminal
 * evidence already produced by discovery.content and discovery.code, produces
 * a stable rendering inventory and the collector's page-aware coverage order,
 * and never queries a connector, scans a repository, writes workflow state, or
 * creates Kajoo project records. The coordinator remains responsible for user
 * grouping and workflow-plan approval.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfigurationRoutes } from './rendering-configurations.mjs';
import { buildRenderingCapturePlan } from './build-rendering-capture-plan.mjs';
import { buildSourceMappingInventory } from './build-rendering-mapping-inventory.mjs';

const CONTENT_REQUIRED = [
  'task-result.json',
  'discovery-manifest.json',
  'rendering-details.json',
  'rendering-page-mapping.json',
  'coverage-plan.json',
  'serialization-config.json',
  'sxa-conversion-inputs.json',
  'xp-only-template-audit.json',
];

const safeRelative = value => {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe relative path: ' + String(value));
  }
  return value;
};

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalId = value => typeof value === 'string' ? value.replace(/[{}]/g, '').toLowerCase() : null;
const normalizedName = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const asArray = value => Array.isArray(value) ? value : [];

function arrayAlias(value, aliases, label) {
  const found = aliases.filter(alias => Array.isArray(value?.[alias]));
  if (!found.length) throw new Error(`${label} does not contain a recognized array (${aliases.join(', ')})`);
  const populated = found.filter(alias => value[alias].length > 0);
  if (populated.length > 1) throw new Error(`${label} has ambiguous populated arrays (${populated.join(', ')})`);
  return value[populated[0] ?? found[0]];
}

function firstValue(value, aliases) {
  for (const alias of aliases) {
    if (value?.[alias] !== undefined && value?.[alias] !== null) return value[alias];
  }
  return null;
}

async function resolveScoped(base, path) {
  safeRelative(path);
  let current = await realpath(base);
  for (const [index, part] of path.split('/').entries()) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Unsafe scoped path: ' + path);
    }
  }
  return current;
}

async function readScoped(base, path) {
  const file = await resolveScoped(base, path);
  const bytes = await readFile(file);
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  try {
    return { bytes, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`Invalid JSON in ${path} after UTF-8 BOM normalization`, { cause: error });
  }
}

async function maybeReadScoped(base, path) {
  try { return await readScoped(base, path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}

function requireSuccess(taskResult, taskId) {
  if ((taskResult.workflowKey ?? taskResult.taskId) !== taskId || taskResult.outcome !== 'success') {
    throw new Error(`Expected successful ${taskId} task result`);
  }
}

function sameScope(input, manifest) {
  const scope = manifest?.scope ?? {};
  const actualRoot = scope.siteRootPath ?? scope.siteRoot ?? null;
  const actualLanguage = Array.isArray(scope.languages) ? scope.languages[0] : scope.language ?? null;
  return actualRoot === input.siteRootPath && scope.database === input.database && actualLanguage === input.language;
}

function fileReference(root, name, bytes) {
  return { path: `${root}/${name}`, sha256: sha256(bytes), bytes: bytes.length };
}

function collectCodeNames(report) {
  const names = new Set();
  const add = value => { if (typeof value === 'string' && value.trim()) names.add(normalizedName(value)); };
  for (const key of ['components', 'componentCandidates', 'exports', 'runtimeComponents']) {
    for (const row of asArray(report?.[key])) {
      if (typeof row === 'string') add(row);
      else if (row && typeof row === 'object') for (const field of ['name', 'componentName', 'exportName', 'displayName']) add(row[field]);
    }
  }
  return names;
}

function resolverReferences(rendering) {
  const fields = rendering?.fields && typeof rendering.fields === 'object' ? rendering.fields : {};
  const nested = Object.entries(fields)
    .filter(([key, value]) => /resolver/i.test(key) && typeof value === 'string' && value.trim())
    .map(([field, value]) => ({ field, value }));
  const direct = ['renderingContentsResolver', 'rendering_contents_resolver', 'resolver']
    .filter(field => typeof rendering?.[field] === 'string' && rendering[field].trim())
    .map(field => ({ field, value: rendering[field] }));
  return [...nested, ...direct].filter((reference, index, values) =>
    values.findIndex(other => other.field === reference.field && other.value === reference.value) === index);
}

function coverageRoutes(coverage) {
  return arrayAlias(coverage, ['routes', 'coveragePlan', 'coverage_plan'], 'Coverage plan').map(route => ({
    route: route.route ?? null,
    itemId: firstValue(route, ['itemId', 'item_id']),
    itemPath: firstValue(route, ['itemPath', 'item_path']),
    language: route.language ?? null,
    version: route.version ?? null,
    versionScope: firstValue(route, ['versionScope', 'version_scope']),
    deviceId: firstValue(route, ['deviceId', 'device_id']),
    renderingIds: asArray(firstValue(route, ['renderingIds', 'rendering_ids'])),
    renderingNames: asArray(firstValue(route, ['renderingNames', 'rendering_names', 'renderings'])),
    cumulativeCoverage: firstValue(route, ['cumulativeCoverage', 'cumulative_coverage']),
  }));
}

function coverageCompleteness(coverage, routes) {
  if (typeof coverage?.completeness === 'string') return coverage.completeness;
  const uncovered = firstValue(coverage, ['renderingsUncovered', 'renderings_uncovered']);
  if (Number.isFinite(Number(uncovered))) return Number(uncovered) === 0 ? 'complete' : 'partial';
  return routes.length ? 'partial' : 'unavailable';
}

function taskResultReference(root, taskResultBytes) {
  return fileReference(root, 'task-result.json', taskResultBytes);
}

function verifyFile(bytes, entry, path) {
  if (!entry || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '') || sha256(bytes) !== entry.sha256.toLowerCase()) {
    throw new Error('Evidence hash mismatch or missing hash: ' + path);
  }
  if ((entry.size ?? entry.bytes) !== bytes.length) throw new Error('Evidence size mismatch: ' + path);
}

async function selectReport(base, root, declared, candidates, label) {
  const paths = declared === undefined ? candidates : [safeRelative(declared)];
  const found = [];
  for (const path of paths) {
    const result = await maybeReadScoped(base, `${root}/${path}`);
    if (result) found.push({ path, ...result });
  }
  if (found.length > 1) throw new Error('Ambiguous ' + label + '; declare its relative path');
  return found[0] ?? null;
}

async function readContent(base, root, evidence) {
  const values = {};
  const files = {};
  const task = await readScoped(base, `${root}/task-result.json`);
  requireSuccess(task.value, 'discovery.content');
  values['task-result.json'] = task.value;
  files['task-result.json'] = taskResultReference(root, task.bytes);
  const selected = await selectReport(base, root, evidence.contentManifest, ['discovery-manifest.json', 'discovery-evidence-manifest.json'], 'content manifest');
  if (!selected) throw new Error('Content manifest is missing');
  const manifest = requireObject(selected.value, 'Content manifest');
  if (manifest.discoveryReady !== true || manifest.synthesisReady !== true) throw new Error('Content manifest is not synthesis-ready');
  const wholeSite = manifest.collector === 'xp-discovery-v3';
  if (wholeSite && (manifest.terminalSuccess !== true || !Array.isArray(manifest.gaps) || manifest.gaps.length)) throw new Error('Whole-site content manifest has terminal evidence gaps');
  values['discovery-manifest.json'] = manifest;
  files['discovery-manifest.json'] = fileReference(root, selected.path, selected.bytes);
  const filesRoot = evidence.contentFilesRoot === undefined ? (wholeSite ? 'collector-files' : null) : evidence.contentFilesRoot === null ? null : safeRelative(evidence.contentFilesRoot);
  const reportRoot = filesRoot ? `${root}/${filesRoot}` : root;
  for (const name of CONTENT_REQUIRED.filter(name => !['task-result.json', 'discovery-manifest.json'].includes(name) && !(wholeSite && name === 'coverage-plan.json'))) {
    const result = await readScoped(base, `${reportRoot}/${name}`);
    if (wholeSite) {
      const entries = asArray(manifest.files).filter(entry => entry.name === name);
      if (entries.length !== 1) throw new Error('Missing or duplicate whole-site manifest entry: ' + name);
      verifyFile(result.bytes, entries[0], `${reportRoot}/${name}`);
    } else if (Array.isArray(manifest.outputs)) {
      verifyFile(result.bytes, manifest.outputs.find(entry => entry.path === name), `${reportRoot}/${name}`);
    }
    values[name] = result.value;
    files[name] = fileReference(reportRoot, name, result.bytes);
  }
  // Consume only declared optional evidence; never enumerate unrelated files.
  const optional = ['rendering-instances.jsonl', 'rendering-variants.json', 'rendering-usage.jsonl', 'template-definitions.json', 'placeholder-settings.json', 'metadata-stats.json'];
  for (const name of optional) {
    const entry = wholeSite
      ? asArray(manifest.files).find(item => item.name === name)
      : asArray(manifest.outputs).find(item => item.path === name);
    if (!entry) {
      if (manifest.renderingEvidence?.version === 2 && ['rendering-instances.jsonl', 'rendering-variants.json'].includes(name))
        throw new Error('Enhanced discovery is missing declared evidence: ' + name);
      continue;
    }
    const file = await resolveScoped(base, `${reportRoot}/${name}`);
    const bytes = await readFile(file);
    verifyFile(bytes, entry, `${reportRoot}/${name}`);
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    values[name] = name.endsWith('.jsonl') ? text : JSON.parse(text);
    files[name] = fileReference(reportRoot, name, bytes);
  }
  if (wholeSite) {
    values['coverage-plan.json'] = values['rendering-page-mapping.json'];
    files['coverage-plan.json'] = files['rendering-page-mapping.json'];
  }
  return { root, values, files };
}

async function readCode(base, root, evidence) {
  if (root === null) return { status: 'not-provided', files: [], componentNames: new Set(), report: null };
  const task = await readScoped(base, `${root}/task-result.json`);
  if ((task.value.workflowKey ?? task.value.taskId) !== 'discovery.code') throw new Error('Code task result has the wrong task ID');
  if (task.value.outcome !== 'success') return {
    status: task.value.outcome,
    files: [taskResultReference(root, task.bytes)],
    componentNames: new Set(),
    report: null,
  };
  const files = [taskResultReference(root, task.bytes)];
  const source = await selectReport(base, root, evidence.codeSourceReport, ['reports/source.json', 'source-analysis.json'], 'code source report');
  if (!source) throw new Error('Successful code Discovery is missing its source report');
  const coverage = await selectReport(base, root, evidence.codeCoverageReport, ['reports/component-route-coverage.json', 'component-route-coverage.json'], 'code coverage report');
  const manifest = await maybeReadScoped(base, `${root}/manifest.json`);
  if (manifest) files.push(fileReference(root, 'manifest.json', manifest.bytes));
  for (const report of [source, coverage].filter(Boolean)) {
    if (manifest) verifyFile(report.bytes, manifest.value.files?.[report.path], `${root}/${report.path}`);
    files.push(fileReference(root, report.path, report.bytes));
  }
  return {
    status: 'success',
    files,
    componentNames: new Set([...collectCodeNames(source?.value), ...collectCodeNames(coverage?.value)]),
    report: { source: source?.value ?? null, coverage: coverage?.value ?? null },
  };
}

function phaseInputs({ content, code, inventory, resolverCandidates }) {
  const serialization = content.values['serialization-config.json'];
  const sxa = content.values['sxa-conversion-inputs.json'];
  const includes = asArray(serialization?.includes);
  const sxaStatus = sxa?.status ?? sxa?.completeness ?? 'unavailable';
  return {
    version: 1,
    candidates: [
      {
        id: 'code-migration',
        status: code.status === 'success' ? 'applicable' : 'unresolved',
        reason: code.status === 'success' ? 'Completed code Discovery evidence is available.' : 'Code Discovery did not complete successfully.',
      },
      {
        id: 'content-migration',
        status: includes.length ? 'applicable' : 'unresolved',
        reason: includes.length ? 'Content Discovery retained serialization include paths.' : 'Serialization include paths are unavailable.',
      },
      {
        id: 'sxa-conversion',
        status: ['complete', 'partial'].includes(sxaStatus) ? 'candidate' : sxaStatus === 'not-applicable' ? 'not-applicable' : 'unresolved',
        reason: ['complete', 'partial'].includes(sxaStatus) ? 'Sitecore presentation evidence contains SXA conversion inputs.' : sxaStatus === 'not-applicable' ? 'No applicable SXA conversion inputs were retained.' : 'SXA conversion-input status is unavailable.',
      },
      {
        id: 'resolver-adapters',
        status: resolverCandidates.length ? 'candidate' : 'not-applicable',
        reason: resolverCandidates.length ? 'Rendering definitions reference resolver fields.' : 'No resolver references were retained in rendering definitions.',
      },
    ],
    counts: { renderings: inventory.length, resolverCandidates: resolverCandidates.length, serializationIncludes: includes.length },
    note: 'Candidates are planning inputs only. They do not create workflow phases or authorize implementation.',
  };
}

async function writeOutput(target, name, value, outputs) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  await writeFile(resolve(target, name), bytes, { flag: 'wx', mode: 0o600 });
  outputs.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
}

/**
 * Builds draft-only synthesis evidence from declared, completed Discovery outputs.
 * All paths in input are relative to the input file's parent directory.
 */
export async function synthesizeDiscovery(input, { base, output }) {
  requireObject(input, 'Input');
  if (input.version !== 1) throw new Error('Unsupported synthesis input version');
  const scope = requireObject(input.scope, 'scope');
  for (const key of ['scopeId', 'siteRootPath', 'database', 'language']) {
    if (typeof scope[key] !== 'string' || !scope[key]) throw new Error('scope.' + key + ' is required');
  }
  const evidence = requireObject(input.evidence, 'evidence');
  const contentRoot = safeRelative(evidence.contentRoot);
  const codeRoot = evidence.codeRoot === null || evidence.codeRoot === undefined ? null : safeRelative(evidence.codeRoot);
  const content = await readContent(base, contentRoot, evidence);
  if (!sameScope(scope, content.values['discovery-manifest.json'])) throw new Error('Content manifest scope does not match synthesis input');
  const code = await readCode(base, codeRoot, evidence);

  const details = arrayAlias(content.values['rendering-details.json'], ['renderings', 'rendering_details'], 'Rendering details');
  const mappingRows = arrayAlias(content.values['rendering-page-mapping.json'], ['renderings', 'rendering_frequency'], 'Rendering page mapping');
  const mappings = new Map(mappingRows.map(row => [canonicalId(firstValue(row, ['renderingId', 'rendering_id', 'id'])), row]));
  const inventory = [];
  const resolverCandidates = [];
  const ids = new Set();
  for (const rendering of details) {
    const id = firstValue(rendering, ['id', 'renderingId', 'rendering_id', 'itemId', 'item_id']);
    const key = canonicalId(id);
    if (!key) throw new Error('Rendering details contain an entry without a stable ID');
    if (ids.has(key)) throw new Error('Duplicate rendering ID in rendering details: ' + id);
    ids.add(key);
    const mapping = mappings.get(key) ?? {};
    const resolverRefs = resolverReferences(rendering);
    const entity = {
      id,
      name: firstValue(rendering, ['name', 'renderingName', 'rendering_name']),
      path: rendering.path ?? null,
      templateName: firstValue(rendering, ['templateName', 'template_name']),
      occurrenceCount: firstValue(mapping, ['occurrenceCount', 'occurrence_count', 'pageCount', 'page_count']) ?? 0,
      pageIds: asArray(firstValue(mapping, ['pageIds', 'page_ids'])),
      pagePaths: asArray(firstValue(mapping, ['pagePaths', 'page_paths'])),
      routes: asArray(mapping.routes),
      codeEvidence: code.status === 'success' && code.componentNames.has(normalizedName(rendering.name)) ? 'exact-name-candidate' : 'unresolved',
      resolverReferences: resolverRefs,
    };
    inventory.push(entity);
    if (resolverRefs.length) resolverCandidates.push({ renderingId: id, renderingName: entity.name, references: resolverRefs });
  }
  inventory.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  resolverCandidates.sort((left, right) => String(left.renderingId).localeCompare(String(right.renderingId)));

  const contentManifest = content.values['discovery-manifest.json'];
  const coverage = content.values['coverage-plan.json'];
  const routes = coverageRoutes(coverage);
  const completeness = coverageCompleteness(coverage, routes);
  const coveragePlan = {
    version: 1,
    completeness,
    authoritative: completeness === 'complete',
    source: content.files['coverage-plan.json'],
    routes,
    note: 'Routes retain the source collector order. This is a draft planning aid, not a workflow or dispatch order.',
  };
  const unresolved = [
    ...asArray(contentManifest.unresolved).map(item => ({ owner: 'content-discovery', ...item })),
    ...(code.status === 'success' && completeness !== 'complete' ? [{ owner: 'code-discovery', code: 'route-coverage-partial', status: completeness }] : []),
    ...(code.status !== 'success' ? [{ owner: 'code-discovery', code: 'code-evidence-unavailable', status: code.status }] : []),
  ];
  const phases = phaseInputs({ content, code, inventory, resolverCandidates });
  const artifacts = Object.fromEntries(Object.entries(content.values).map(([name, value]) => [name.replace(/\.(jsonl|json)$/, ''), value]));
  if (code.status === 'success') artifacts['code-discovery-report'] = code.report?.source;
  const definitions = details.map(rendering => ({...rendering, id: firstValue(rendering, ['id','renderingId','rendering_id','itemId','item_id']), name: rendering.name ?? rendering.component_name ?? '', componentName: rendering.component_name ?? rendering.componentName ?? null}));
  // Existing route planning remains intact. This projection is draft evidence,
  // not user approval, a task list, or capture execution authority.
  const configurationRoutes = buildConfigurationRoutes(definitions, artifacts, routes.map(route => ({...route, renderings: route.renderingNames ?? route.renderings ?? []})));
  const capturePlan = buildRenderingCapturePlan(configurationRoutes, {evidenceWarnings: artifacts['rendering-instances'] == null ? ['Occurrence evidence unavailable: this draft does not establish rendering/variant capture coverage.'] : []});
  const mappingInventory = buildSourceMappingInventory({renderings: definitions, artifacts, entries: configurationRoutes, generatedAt: new Date().toISOString()});

  const target = resolve(output);
  try { await lstat(target); throw new Error('Output directory already exists: ' + target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await mkdir(target, { recursive: false, mode: 0o700 });

  const outputs = [];
  await writeOutput(target, 'rendering-inventory.json', { version: 1, entities: inventory }, outputs);
  await writeOutput(target, 'coverage-plan.json', coveragePlan, outputs);
  await writeOutput(target, 'rendering-capture-plan.json', capturePlan, outputs);
  await writeOutput(target, 'rendering-mapping-inventory.json', mappingInventory, outputs);
  await writeOutput(target, 'resolver-candidates.json', { version: 1, candidates: resolverCandidates }, outputs);
  await writeOutput(target, 'phase-inputs.json', phases, outputs);
  await writeOutput(target, 'unresolved.json', { version: 1, findings: unresolved }, outputs);
  const report = [
    '# Discovery synthesis report', '',
    `- Scope: ${scope.scopeId}`,
    `- Renderings: ${inventory.length}`,
    `- Page-aware coverage routes: ${coveragePlan.routes.length} (${coveragePlan.completeness})`,
    `- Resolver candidates: ${resolverCandidates.length}`,
    `- Code evidence: ${code.status}`,
    `- Unresolved findings: ${unresolved.length}`,
    '', '## Planning status', '',
    '| Workstream | Status | Reason |', '|---|---|---|',
    ...phases.candidates.map(item => `| ${item.id} | ${item.status} | ${item.reason} |`),
    '', 'This is a draft-only synthesis result. It does not activate workflow work, create project records, or authorize execution.', '',
  ].join('\n');
  const reportBytes = Buffer.from(report, 'utf8');
  await writeFile(resolve(target, 'discovery-synthesis-report.md'), reportBytes, { flag: 'wx', mode: 0o600 });
  outputs.push({ path: 'discovery-synthesis-report.md', sha256: sha256(reportBytes), bytes: reportBytes.length });
  const manifest = {
    version: 1,
    kind: 'sitecore-discovery-synthesis',
    scope,
    inputs: {
      content: Object.values(content.files),
      code: code.files,
    },
    counts: { renderings: inventory.length, coverageRoutes: coveragePlan.routes.length, resolverCandidates: resolverCandidates.length, unresolved: unresolved.length },
    outputs,
    draftOnly: true,
  };
  await writeOutput(target, 'synthesis-manifest.json', manifest, outputs);
  return { valid: true, summary: manifest.counts, output: target };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined || args[key.slice(2)]) throw new Error('Usage: node synthesize-discovery.mjs --input <input.json> --output <new-directory>');
    args[key.slice(2)] = value;
  }
  if (!args.input || !args.output || Object.keys(args).length !== 2) throw new Error('Usage: node synthesize-discovery.mjs --input <input.json> --output <new-directory>');
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseArgs(process.argv);
    const inputPath = resolve(args.input);
    const base = dirname(inputPath);
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const result = await synthesizeDiscovery(input, { base, output: args.output });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write((error.stack || error.message || String(error)) + '\n');
    process.exitCode = 1;
  }
}
