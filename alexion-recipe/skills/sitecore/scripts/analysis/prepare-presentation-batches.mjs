#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBatches } from './assemble-discovery.mjs';
import { prepareRequest } from '../prepare-request.mjs';

const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => String(value).replace(/[{}]/g, '').toLowerCase();
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const itemPath = value => typeof value === 'string' && /^\/sitecore\/[^\\:*?\[\]\p{Cc}]+$/iu.test(value) && !/(^|\/)\.\.?($|\/)|\/\/|\/$/.test(value);

/** Prepare exact tool requests; no remote execution, credentials or workflow writes. */
export async function preparePresentationBatches(input, { base, output }) {
  if (input?.version !== 1 || !input.inventory || !input.scope) throw new Error('version 1, inventory and scope are required');
  if (Array.isArray(input.inventory) && input.inventory.length === 0) throw new Error('Inventory requires at least one retained export');
  const { scope } = input;
  const batchSize = input.batchSize ?? 200;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('batchSize must be 1..200');
  if (!itemPath(scope.siteRoot) || typeof scope.database !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(scope.database)) throw new Error('Invalid site/database scope');
  for (const key of ['languages', 'versions', 'devices']) {
    if (!Array.isArray(scope[key]) || !scope[key].length || scope[key].some(v => typeof v !== 'string' || !v.trim())) throw new Error('Invalid scope.' + key);
  }
  if (scope.devices.some(v => !/^(?:\{[0-9a-f-]{36}\}|[0-9a-f-]{36})$/i.test(v) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(normalize(v)))) throw new Error('Devices must be explicit GUIDs');
  if (scope.versions.length !== 1 || !/^(latest|\*|[1-9][0-9]*)$/.test(scope.versions[0])) throw new Error('scope.versions must select latest, *, or one explicit version');
  const inventory = await readBatches(base, input.inventory, 'items');
  if (inventory.manifest.summary.partial) throw new Error('Inventory is partial; recover it before preparing full presentation batches');
  for (const evidence of inventory.provenance) {
    const captured = evidence.scope;
    if (!captured || captured.sitePath?.toLowerCase() !== scope.siteRoot.toLowerCase() || captured.database !== scope.database || !sameSet(captured.languages, scope.languages) || captured.version !== scope.versions[0]) throw new Error('Inventory manifest scope does not match requested scope');
  }
  const identities = new Set(), groups = new Map(), pathOwners = new Map(), latestVersions = new Map();
  for (const row of inventory.records) {
    if (!itemPath(row.path) || !(row.path.toLowerCase() === scope.siteRoot.toLowerCase() || row.path.toLowerCase().startsWith(scope.siteRoot.toLowerCase() + '/')) || !scope.languages.includes(row.language)) throw new Error('Inventory row outside requested scope');
    if (typeof row.hasPresentation !== 'boolean') throw new Error('Inventory has an unknown presentation flag');
    if (!/^[1-9][0-9]*$/.test(String(row.version))) throw new Error('Inventory row must have an actual positive version');
    if (scope.versions[0] !== '*' && scope.versions[0] !== 'latest' && String(row.version) !== scope.versions[0]) throw new Error('Inventory row version outside requested scope');
    const pathKey = row.path.toLowerCase(), owner = normalize(row.id);
    if (pathOwners.has(pathKey) && pathOwners.get(pathKey) !== owner) throw new Error('Ambiguous item path maps to multiple IDs; resolve the path lookup before batching');
    pathOwners.set(pathKey, owner);
    const latestKey = JSON.stringify([owner, row.language]);
    if (scope.versions[0] === 'latest' && latestVersions.has(latestKey) && latestVersions.get(latestKey) !== String(row.version)) throw new Error('Inventory contains multiple latest versions for one item/language');
    latestVersions.set(latestKey, String(row.version));
    if (!row.hasPresentation) continue;
    const identity = JSON.stringify([normalize(row.id), row.language, String(row.version)]);
    identities.add(identity);
    // One language/version selection per request avoids collecting non-page
    // siblings or exhausting MaxItems before the intended presentation tuples.
    const version = scope.versions[0] === '*' ? String(row.version) : scope.versions[0];
    const key = JSON.stringify([row.language, version]);
    if (!groups.has(key)) groups.set(key, { language: row.language, version, paths: new Map() });
    groups.get(key).paths.set(pathKey, row.path);
  }
  // Never rebuild paths from names/URLs. Keep inventoried punctuation and casing.
  const requests = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const ordered = [...group.paths.values()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (let index = 0; index < ordered.length; index += batchSize) {
      const subset = ordered.slice(index, index + batchSize);
      const request = await prepareRequest({ operation: 'inspect-presentation', background: true, parameters: {
        ItemPaths: subset, Database: scope.database, Languages: [group.language],
        Version: group.version, Devices: scope.devices,
        MaxItems: subset.length,
      } });
      requests.push({ name: `presentation-${String(requests.length + 1).padStart(4, '0')}.json`, request });
    }
  }
  // Project-scoped scratch parents may not exist on the first run. Keep the
  // final batch directory exclusive so retries cannot overwrite retained requests.
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { recursive: false, mode: 0o700 });
  const batches = [];
  for (const entry of requests) {
    const bytes = JSON.stringify(entry.request, null, 2) + '\n';
    await writeFile(join(output, entry.name), bytes, { flag: 'wx', mode: 0o600 });
    batches.push({ request: entry.name, sha256: fingerprint(bytes), itemPaths: entry.request.parameters.ItemPaths.length, language: entry.request.parameters.Languages[0], version: entry.request.parameters.Version });
  }
  const result = { version: 1, scope, inventory: inventory.provenance, expectedPresentationRecords: identities.size * new Set(scope.devices.map(normalize)).size, batches };
  await writeFile(join(output, 'batch-manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node prepare-presentation-batches.mjs --input /absolute/input.json --output /absolute/new-directory\nInput: {version:1, inventory:{records,manifest}, scope:{siteRoot,database,languages,versions,devices}, batchSize?:200}. Inventory paths are relative to input.json. Output: exact run-powershell-script requests and batch-manifest.json.');
    return;
  }
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('Expected --input file --output fresh-directory');
  console.log(JSON.stringify(await preparePresentationBatches(JSON.parse(await readFile(args[1], 'utf8')), { base: dirname(resolve(args[1])), output: resolve(args[3]) })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
