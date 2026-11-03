#!/usr/bin/env node
// Native Node only. Read approved evidence; prepare a fresh tree, never edit an app.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonicalId, routeFile, sha256, validateCapturePlan, validateOutcomeIdentity } from '../capture/rendering-coverage.mjs';
import { verifyComponentMigrationPlanEvidence } from '../mapping/cli-files.mjs';
import { mapLayoutForTarget } from '../mapping/map-layout-for-target.mjs';
import { buildComponentExamples } from '../capture/build-component-examples.mjs';

const assetFile = fileURLToPath(new URL('../../assets/mock-preview/navigation.template.txt', import.meta.url));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const json = (bytes) => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path`);
  return resolve(value);
}
function verifiedFile(ref, label) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`${label} must declare path and sha256`);
  const path = absolute(ref.path, `${label}.path`);
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file`);
  const bytes = readFileSync(path);
  if (!/^[a-f0-9]{64}$/.test(ref.sha256 ?? '') || sha256(bytes) !== ref.sha256) throw new Error(`${label} SHA256 mismatch`);
  return { path, sha256: ref.sha256, bytes };
}
function references(value, label, required = false) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && !value.length)) throw new Error(`Declare ${label} explicitly`);
  const refs = value.map((ref) => verifiedFile(ref, label)).sort((a, b) => compare(a.path, b.path));
  if (new Set(refs.map((ref) => ref.path)).size !== refs.length) throw new Error(`${label} must be unique`);
  return refs;
}
function inside(root, file) {
  const rel = relative(root, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
function newOutput(value, sourceFiles) {
  const path = absolute(value, 'outputDir');
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || readdirSync(path).length)) throw new Error('outputDir must be new or empty');
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (resolve(realpathSync(ancestor)) !== ancestor) throw new Error('outputDir must not use symbolic link ancestors');
  if (sourceFiles.some((file) => path === file || inside(path, file))) throw new Error('outputDir must not contain input files');
  return path;
}

/** Only successful, explicitly declared, hash-verified outcomes can enter this index. */
export function preparePreviewNavigation(options) {
  if (!options || typeof options !== 'object') throw new Error('Preview options are required');
  if (options.routes || options.layouts || options.layoutFiles || options.syntheticExamples || options.mappedOutputs) throw new Error('Only approved capture result manifests may declare preview layouts');
  const allowed = new Set(['capturePlanFile', 'capturePlanSha256', 'captureResultFiles', 'mappedLayoutFiles', 'componentExamplesFiles', 'outputDir']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown preview option: ${key}`);
  const planRef = verifiedFile({ path: options.capturePlanFile, sha256: options.capturePlanSha256 }, 'capturePlan');
  const plan = validateCapturePlan(json(planRef.bytes));
  const results = references(options.captureResultFiles, 'captureResultFiles', true);
  const resultPaths = new Set(results.map((ref) => ref.path));
  const layouts = new Map();
  const outcomes = [];
  const selected = new Set(plan.selectedPages.map((page) => page.route));
  const documents = new Map(results.map((ref) => [ref.path, json(ref.bytes)]));
  const visited = new Set();
  const visiting = new Set();
  function lineage(path) {
    if (visiting.has(path)) throw new Error('Capture recovery lineage contains a cycle');
    if (visited.has(path)) return;
    visiting.add(path);
    const previous = documents.get(path)?.previousCaptureResultFiles ?? [];
    if (!Array.isArray(previous)) throw new Error('Invalid recovery lineage');
    for (const file of previous) {
      const prior = absolute(file, 'previousCaptureResultFile');
      if (!resultPaths.has(prior)) throw new Error('Declare every previous capture result manifest');
      lineage(prior);
    }
    visiting.delete(path); visited.add(path);
  }
  for (const path of resultPaths) lineage(path);
  function priorSelectedAttempt(result) {
    return (result.previousCaptureResultFiles ?? []).some((path) => {
      const previous = documents.get(absolute(path, 'previousCaptureResultFile'));
      return previous.outcomes?.some((outcome) => selected.has(outcome.route) && ['captured', 'failed'].includes(outcome.status)) || priorSelectedAttempt(previous);
    });
  }
  for (const ref of results) {
    const result = documents.get(ref.path);
    if (result.selection !== 'discovery-plan' || result.capturePlanFingerprint !== plan.fingerprint || !Array.isArray(result.outcomes)) throw new Error('Capture result does not belong to the approved plan');
    if (result.outcomes.some((outcome) => !selected.has(outcome.route)) && (!selected.size || !priorSelectedAttempt(result))) throw new Error('Alternative pages require an explicit recovery result chain with a prior selected attempt');
    const captured = result.outcomes.filter((outcome) => outcome.status === 'captured');
    const root = captured.length ? realpathSync(absolute(result.outputDir, 'capture outputDir')) : null;
    for (const outcome of result.outcomes) {
      const page = validateOutcomeIdentity(plan, outcome);
      outcomes.push({ route: outcome.route, status: outcome.status, captureResultFile: ref.path });
      if (outcome.status !== 'captured') continue;
      const path = absolute(outcome.layoutFile, 'layoutFile');
      if (resolve(root, routeFile(outcome.route)) !== path) throw new Error('Captured layout path does not match approved route');
      const actual = realpathSync(path);
      if (!inside(root, actual)) throw new Error('Captured layout escapes outputDir');
      const bytes = readFileSync(actual);
      if (!/^[a-f0-9]{64}$/.test(outcome.sha256 ?? '') || sha256(bytes) !== outcome.sha256) throw new Error('Captured layout SHA256 mismatch');
      const layout = json(bytes);
      const route = layout?.sitecore?.route ?? layout?.route ?? layout;
      if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Captured layout has no route object');
      if (page.itemId && canonicalId(route.itemId ?? route.itemID) !== canonicalId(page.itemId)) throw new Error('Captured layout item identity mismatch');
      const language = layout?.sitecore?.context?.language ?? route.itemLanguage;
      if (page.language && language !== undefined && language !== page.language) throw new Error('Captured layout language mismatch');
      const prior = layouts.get(outcome.route);
      if (prior && prior.sha256 !== outcome.sha256) throw new Error('Conflicting captured layouts for the same route');
      layouts.set(outcome.route, { bytes, sha256: outcome.sha256, layoutFile: path, captureResultFile: ref.path, kind: 'captured' });
    }
  }
  const sourceFiles = [planRef.path, ...resultPaths, ...[...layouts.values()].map((layout) => layout.layoutFile)];
  const mappedRefs = references(options.mappedLayoutFiles, 'mappedLayoutFiles');
  const exampleRefs = references(options.componentExamplesFiles, 'componentExamplesFiles');
  const mappedRoutes = new Set();
  for (const ref of mappedRefs) {
    const result = json(ref.bytes);
    if (result.schemaVersion !== 1 || result.kind !== 'derived-mapped-layout') throw new Error('Expected a derived mapped layout manifest');
    const captured = layouts.get(result.route);
    if (!captured || mappedRoutes.has(result.route)) throw new Error('Mapped route must have one declared successful source capture');
    const source = verifiedFile(result.sourceLayout, 'mapped sourceLayout');
    if (source.path !== captured.layoutFile || source.sha256 !== captured.sha256) throw new Error('Mapped source layout does not match declared capture');
    const boundPlan = verifiedFile(result.mappingPlan, 'mappingPlan');
    const mappingPlan = verifyComponentMigrationPlanEvidence(json(boundPlan.bytes));
    const output = verifiedFile({ path: result.outputFile, sha256: result.sha256 }, 'mapped layout');
    if (!isDeepStrictEqual(json(output.bytes), mapLayoutForTarget(json(source.bytes), result.route, mappingPlan).layout)) throw new Error('Mapped layout does not match current approved mapping');
    layouts.set(result.route, { bytes: output.bytes, sha256: output.sha256, layoutFile: output.path, captureResultFile: captured.captureResultFile, kind: 'derived-mapped-layout', sourceLayout: { path: source.path, sha256: source.sha256 }, mappingPlan: { path: boundPlan.path, sha256: boundPlan.sha256 } });
    mappedRoutes.add(result.route);
    sourceFiles.push(ref.path, source.path, output.path, boundPlan.path, ...mappingPlan.inputFiles.map((input) => input.path), mappingPlan.approvalEvidence.path);
  }
  const excludedExamples = [];
  for (const ref of exampleRefs) {
    const result = json(ref.bytes);
    if (result.schemaVersion !== 1 || result.kind !== 'synthetic-component-examples' || result.synthetic !== true || !Array.isArray(result.examples)) throw new Error('Expected a synthetic component examples manifest');
    const source = verifiedFile(result.sourceInventory, 'example sourceInventory');
    const boundPlan = verifiedFile(result.mappingPlan, 'example mappingPlan');
    const mappingPlan = verifyComponentMigrationPlanEvidence(json(boundPlan.bytes));
    const inventory = json(source.bytes);
    if (source.sha256 !== mappingPlan.inputFiles.find((input) => input.role === 'source')?.sha256 || source.path !== resolve(mappingPlan.inputFiles.find((input) => input.role === 'source')?.path ?? '') || inventory.fingerprint !== mappingPlan.sourceFingerprint || result.mappingPlan.fingerprint !== mappingPlan.fingerprint || result.mappingPlan.decisionId !== mappingPlan.approval.decisionId) throw new Error('Example source does not match approved mapping plan');
    const keys = new Set();
    for (const example of result.examples) {
      if (!example || keys.has(example.requirementKey)) throw new Error('Duplicate or invalid synthetic example');
      keys.add(example.requirementKey);
      if (!['layout-ready', 'fixture-required', 'dependency-required'].includes(example.status)) throw new Error('Invalid synthetic example status');
      if (example.status !== 'layout-ready') {
        const [eligible] = buildComponentExamples(inventory, { selectedRequirementKeys: [example.requirementKey], mappingPlan });
        if (example.synthetic !== true || example.route !== eligible.route || example.relativeFile !== eligible.relativeFile) throw new Error('Invalid excluded synthetic example identity');
        excludedExamples.push({ route: example.route, requirementKey: example.requirementKey, status: example.status }); continue;
      }
      const configuration = example.sourceConfiguration;
      const [rebuilt] = buildComponentExamples(inventory, { selectedRequirementKeys: [example.requirementKey], fixtures: [{ requirementKey: example.requirementKey, fields: configuration?.fields, parameters: configuration?.parameters, placeholder: configuration?.placeholder, datasource: configuration?.datasource }], language: example.layout?.sitecore?.context?.language, mappingPlan });
      if (example.synthetic !== true || rebuilt.status !== 'layout-ready' || example.route !== rebuilt.route || example.relativeFile !== rebuilt.relativeFile || !isDeepStrictEqual(example.layout, rebuilt.layout)) throw new Error('Example does not match current approved synthetic layout');
      routeFile(example.route);
      if (layouts.has(example.route)) throw new Error('Synthetic example route collides with a preview route');
      const output = verifiedFile({ path: resolve(dirname(ref.path), example.relativeFile), sha256: sha256(jsonBytes(example.layout)) }, 'example layout');
      if (!inside(realpathSync(dirname(ref.path)), realpathSync(output.path)) || !isDeepStrictEqual(json(output.bytes), example.layout)) throw new Error('Example layout path or content mismatch');
      layouts.set(example.route, { bytes: output.bytes, sha256: output.sha256, layoutFile: output.path, kind: 'synthetic-component-example', synthetic: true, requirementKey: example.requirementKey, visualValidation: 'pending' });
      sourceFiles.push(output.path);
    }
    sourceFiles.push(ref.path, source.path, boundPlan.path, ...mappingPlan.inputFiles.map((input) => input.path), mappingPlan.approvalEvidence.path);
  }
  const outputDir = newOutput(options.outputDir, sourceFiles);
  const routes = [...layouts.keys()].sort(compare);
  const staged = new Map([
    ['public/mock-preview/navigation.js', readFileSync(assetFile)],
    ['public/mock-preview/routes.json', jsonBytes({ routes: routes.map((route) => route === '/' ? '/' : `/${route.slice(1).split('/').map(encodeURIComponent).join('/')}`) })],
    ...routes.map((route) => [`public/mock-layouts/${routeFile(route)}`, layouts.get(route).bytes]),
  ]);
  const files = [...staged].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })).sort((a, b) => compare(a.path, b.path));
  const manifest = {
    schemaVersion: 1,
    kind: 'mock-preview-deployment',
    capturePlanFingerprint: plan.fingerprint,
    capturePlan: { path: planRef.path, sha256: planRef.sha256 },
    captureResultFiles: results.map(({ path, sha256 }) => ({ path, sha256 })),
    inputs: [...new Set(sourceFiles)].sort(compare).map((path) => ({ path, sha256: sha256(readFileSync(path)) })),
    mappedLayoutFiles: mappedRefs.map(({ path, sha256 }) => ({ path, sha256 })),
    componentExamplesFiles: exampleRefs.map(({ path, sha256 }) => ({ path, sha256 })),
    files,
    routes,
    captures: routes.map((route) => ({ route, ...Object.fromEntries(Object.entries(layouts.get(route)).filter(([key]) => key !== 'bytes')) })),
    outcomes: outcomes.sort((a, b) => compare(a.route, b.route) || compare(a.captureResultFile, b.captureResultFile) || compare(a.status, b.status)),
    excludedExamples: excludedExamples.sort((a, b) => compare(a.route, b.route)),
    coverage: 'Capture availability only; rendering and variant coverage require the separate rendering coverage report.',
  };
  // Every input has been validated before creating any output. Never scan capture trees.
  for (const [path, bytes] of staged) {
    const target = join(outputDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  writeFileSync(join(outputDir, 'deployment-manifest.json'), jsonBytes(manifest), { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== '--params') throw new Error('Usage: node prepare-preview-navigation.mjs --params <json-file>');
    const options = JSON.parse(readFileSync(argv[1], 'utf8'));
    preparePreviewNavigation(options);
    console.log(options.outputDir);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
