#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExport } from './assemble-discovery.mjs';
import { prepareRequest } from '../prepare-request.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const itemPath = value => typeof value === 'string' && /^\/sitecore\/[^\\:*?\[\]\p{Cc}]+$/iu.test(value) && !/(^|\/)\.\.?($|\/)|\/\/|\/$/.test(value);
const inside = (path, root) => path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(root.toLowerCase() + '/');
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const normalize = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const recordKey = row => JSON.stringify([normalize(row.id), row.language, String(row.version)]);

export function deriveDependencySeeds(siteRoot, renderingScopes) {
  const seeds = new Map();
  function seed(reference, kind, recursive, optional = false) {
    if (!itemPath(reference)) throw Error('Invalid dependency root scope');
    const key = reference.toLowerCase(), old = seeds.get(key);
    if (old && old.kind !== kind) throw Error('Conflicting dependency seed kinds');
    seeds.set(key, { reference, kind, recursive: recursive || old?.recursive || false, optional: old ? optional && old.optional : optional });
  }
  for (const { reference, recursive } of renderingScopes) seed(reference, 'rendering', recursive);
  seed(siteRoot, 'content', true);
  seed(siteRoot.slice(0, siteRoot.lastIndexOf('/')), 'content', false);
  seed(siteRoot + '/Presentation', 'sxa', true, true);
  seed('/sitecore/layout/Placeholder Settings', 'placeholder', true, true);
  return [...seeds.values()].sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
}

/** No network calls. Derive bounded read roots from retained scope, not names. */
export async function prepareDependencyRequest(input, { base, output }) {
  if (input?.version !== 1 || !input.scope || !input.inventory || !input.renderings) throw Error('version 1, scope, inventory and renderings required');
  const { scope } = input;
  if (!itemPath(scope.siteRoot) || !/^\/sitecore\/content\//i.test(scope.siteRoot) || !scope.database ||
      !Array.isArray(scope.languages) || !scope.languages.length || !Array.isArray(scope.versions) || scope.versions.length !== 1 ||
      !Array.isArray(scope.devices) || !scope.devices.length) throw Error('Explicit source site/database/language/version/device scope required');
  const renderingScopes = [], inputs = [], inventory = new Map(), renderings = new Map(), latestVersions = new Map();
  for (const [kind, spec] of [['inventory', input.inventory], ['renderings', input.renderings]]) {
    const batches = Array.isArray(spec) ? spec : [spec];
    if (!batches.length) throw Error('At least one retained ' + kind + ' export required');
    for (const batch of batches) {
      const capture = await readExport(base, batch), summary = capture.manifest.summary, captured = summary.scope;
      if (typeof summary.limited !== 'boolean' || !Number.isSafeInteger(summary.errorCount) || summary.errorCount < 0) throw Error('Capture completeness flags required');
      if (!Number.isSafeInteger(summary.visited) || summary.visited !== capture.records.length) throw Error('Capture record count does not match retained rows');
      if (summary.partial || summary.limited || summary.errorCount) throw Error('Recover partial ' + kind + ' before dependency preparation');
      if (!captured || captured.database !== scope.database || captured.version !== scope.versions[0] || !sameSet(captured.languages, scope.languages)) throw Error('Capture scope mismatch');
      let roots;
      if (kind === 'inventory') {
        if (captured.sitePath?.toLowerCase() !== scope.siteRoot.toLowerCase() || captured.includesRoot !== true) throw Error('Inventory root scope mismatch');
        roots = [captured.sitePath];
      } else {
        roots = captured.itemPaths;
        if (!Array.isArray(roots) || !roots.length || roots.some(path => !itemPath(path) || !inside(path, '/sitecore/layout/Renderings')) || typeof captured.recurse !== 'boolean') throw Error('Rendering root scope required');
        for (const root of roots) renderingScopes.push({ reference: root, recursive: captured.recurse });
      }
      for (const row of capture.records) {
        if (!itemPath(row.path) || !roots.some(root => inside(row.path, root)) || !scope.languages.includes(row.language) || !row.id || !/^[1-9][0-9]*$/.test(String(row.version))) throw Error('Captured identity outside requested scope');
        if (kind === 'renderings' && !captured.recurse && !roots.some(root => root.toLowerCase() === row.path.toLowerCase())) throw Error('Rendering row outside nonrecursive scope');
        if (!['latest', '*'].includes(scope.versions[0]) && String(row.version) !== scope.versions[0]) throw Error('Captured version outside requested scope');
        const latestKey = JSON.stringify([kind, normalize(row.id), row.language]);
        if (scope.versions[0] === 'latest' && latestVersions.has(latestKey) && latestVersions.get(latestKey) !== String(row.version)) throw Error('Conflicting latest versions in captured scope');
        latestVersions.set(latestKey, String(row.version));
        const rows = kind === 'inventory' ? inventory : renderings;
        const identity = { id: row.id, path: row.path, language: row.language, version: String(row.version) }, key = recordKey(row);
        if (rows.has(key) && JSON.stringify(rows.get(key)) !== JSON.stringify(identity)) throw Error('Conflicting captured identity scope');
        rows.set(key, identity);
      }
      inputs.push({ kind, ...capture.provenance });
    }
  }
  for (const language of scope.languages) if (![...inventory.values()].some(row => row.path.toLowerCase() === scope.siteRoot.toLowerCase() && row.language === language)) throw Error('Inventory does not contain requested root/language scope');
  // These are read-only probes of known Sitecore conventions, not assumptions
  // of SXA presence. Absence is retained; access/script failure stays partial.
  const expectedSeeds = deriveDependencySeeds(scope.siteRoot, renderingScopes);
  const request = await prepareRequest({ operation: 'inspect-dependencies', background: true, parameters: {
    Seeds: expectedSeeds,
    Database: scope.database, Languages: scope.languages, Version: scope.versions[0], Devices: scope.devices, MaxItems: input.maxItems ?? 20000,
  } });
  await mkdir(output, { recursive: false, mode: 0o700 });
  const bytes = JSON.stringify(request, null, 2) + '\n';
  await writeFile(join(output, 'dependencies-request.json'), bytes, { flag: 'wx', mode: 0o600 });
  const result = { version: 1, scope, inputs, expectedSeeds, request: { path: 'dependencies-request.json', sha256: hash(bytes) },
    expectedInventoryIdentities: [...inventory].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row),
    expectedRenderingIdentities: [...renderings].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row),
    limitations: ['Global placeholder settings are bounded by MaxItems; a limit requires recovery, never silent truncation.', 'This request prepares collection only; compare returned identities to this manifest before accepting closure.'] };
  await writeFile(join(output, 'dependency-request-manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw Error('Usage: prepare-dependency-request.mjs --input <input.json> --output <new-directory>');
    const path = resolve(args[1]);
    console.log(JSON.stringify(await prepareDependencyRequest(JSON.parse(await readFile(path, 'utf8')), { base: dirname(path), output: resolve(args[3]) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
