#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const operations = Object.freeze({
  'discover-site': 'analysis/discover-site.ps1',
  'inspect-renderings': 'analysis/inspect-renderings.ps1',
  'inspect-presentation': 'analysis/inspect-presentation.ps1',
  'inspect-dependencies': 'analysis/inspect-dependencies.ps1',
  'analyze-rendering-coverage': 'analysis/analyze-rendering-coverage.ps1',
  'discover-layout-folders': 'analysis/hotfix-discover-layouts.ps1',
  'export-richtext': 'capture/export-richtext.ps1',
  'export-dictionary': 'capture/export-dictionary.ps1',
  'export-layouts': 'capture/export-layouts.ps1',
  'capture-mock-layouts': 'capture/capture-mock-layouts.ps1',
  'capture-mock-dictionary': 'capture/capture-mock-dictionary.ps1',
  'export-richtext-structures': 'capture/export-richtext-structures.ps1',
});

/** Compose only shipped golden samples. Authentication remains in the connector. */
export async function prepareRequest({ operation, parameters, background = true, destination }) {
  if (!Object.hasOwn(operations, operation)) throw new Error('Unknown golden operation');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('parameters must be an object');
  if (typeof background !== 'boolean') throw new Error('background must be boolean');
  if (destination !== undefined && (typeof destination !== 'string' || !destination || destination.startsWith('/') || /[\\:\0]/.test(destination) || destination.split('/').some(x => !x || x === '.' || x === '..'))) {
    throw new Error('destination must be a safe workspace-relative directory');
  }
  if (['inspect-presentation', 'analyze-rendering-coverage', 'inspect-dependencies'].includes(operation)) {
    const coverage = operation === 'analyze-rendering-coverage';
    const dependencies = operation === 'inspect-dependencies';
    const required = [...(dependencies ? ['Seeds'] : coverage ? ['SitePath', 'RenderingIds'] : ['ItemPaths']), 'Devices', 'Database', 'Languages', 'Version'];
    const optional = coverage ? ['MaxItems', 'RenderingNames'] : ['MaxItems'];
    for (const key of required) if (parameters[key] === undefined) throw new Error(`${key} is required for ${operation}`);
    for (const key of Object.keys(parameters)) if (![...required, ...optional].includes(key)) throw new Error(`Unknown ${operation} parameter: ` + key);
    for (const key of [...(dependencies ? [] : [coverage ? 'RenderingIds' : 'ItemPaths']), 'Devices', 'Languages']) {
      if (!Array.isArray(parameters[key]) || !parameters[key].length || parameters[key].some(value => typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be a non-empty string array`);
    }
    const paths = dependencies ? [] : coverage ? [parameters.SitePath] : parameters.ItemPaths;
    if (paths.some(value => typeof value !== 'string' || !/^\/sitecore\/[^\\:*?\[\]\p{Cc}]+$/iu.test(value) || /(^|\/)\.\.?($|\/)|\/\/|\/$/.test(value))) throw new Error(`${coverage ? 'SitePath' : 'ItemPaths'} must be explicit Sitecore paths without wildcards or traversal`);
    for (const key of coverage ? ['Devices', 'RenderingIds'] : ['Devices']) {
      if (parameters[key].some(value => !/^(?:\{[0-9a-f-]{36}\}|[0-9a-f-]{36})$/i.test(value) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.replace(/[{}]/g, '')))) throw new Error(`${key} must contain GUIDs`);
    }
    if (coverage && parameters.RenderingNames !== undefined && (!Array.isArray(parameters.RenderingNames) || parameters.RenderingNames.length !== parameters.RenderingIds.length || parameters.RenderingNames.some(value => typeof value !== 'string'))) throw new Error('RenderingNames must align with RenderingIds');
    if (typeof parameters.Database !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(parameters.Database)) throw new Error('Database must be an explicit database name');
    if (typeof parameters.Version !== 'string' || !/^(latest|\*|[1-9][0-9]*)$/.test(parameters.Version)) throw new Error('Version must be latest, *, or a positive version number');
    if (parameters.MaxItems !== undefined && (!Number.isInteger(parameters.MaxItems) || parameters.MaxItems < 1 || parameters.MaxItems > 2147483647)) throw new Error('MaxItems must be a positive 32-bit integer');
    if (dependencies) {
      const kinds = ['content', 'datasource', 'template', 'rendering', 'layout', 'placeholder', 'branch', 'resolver', 'sxa'];
      if (!Array.isArray(parameters.Seeds) || !parameters.Seeds.length) throw new Error('Seeds must be a non-empty array');
      for (const seed of parameters.Seeds) {
        if (!seed || typeof seed !== 'object' || Array.isArray(seed) || Object.keys(seed).some(key => !['reference', 'kind', 'recursive', 'optional'].includes(key)) || !kinds.includes(seed.kind)) throw new Error('Seeds require reference, supported kind and optional recursive/optional booleans');
        const value = seed.reference;
        const guid = typeof value === 'string' && /^(\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.test(value);
        const path = typeof value === 'string' && /^\/sitecore\/[^\\:*?\[\]\p{Cc}]+$/iu.test(value) && !/(^|\/)\.\.?($|\/)|\/\/|\/$/.test(value);
        if (!guid && !path) throw new Error('Seeds reference must be an explicit GUID or Sitecore item path');
        for (const key of ['recursive', 'optional']) if (seed[key] !== undefined && typeof seed[key] !== 'boolean') throw new Error(`Seeds ${key} must be boolean`);
      }
    }
  }
  const [common, entry] = await Promise.all([
    readFile(new URL('./remote-common.ps1', import.meta.url), 'utf8'),
    readFile(new URL(operations[operation], import.meta.url), 'utf8'),
  ]);
  // The tool injects structured parameters before evaluating this script. No eval
  // of parameter values and no remote dot-source of a local /mnt/skills path.
  const script = `${common}\ntry {\n${entry}\n} finally {\n foreach ($writer in $script:kajooWriters.Values) { $writer.Dispose() }\n}\n`;
  return { script, parameters, background, output: { mode: 'files', ...(destination === undefined ? {} : { destination }) } };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node prepare-request.mjs --input /absolute/request.json\nInput: {operation, parameters, background?:true, destination?:"migration/discovery"}. Output: run-powershell-script arguments. Submit through the selected source connector, never run SPE in local bash.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--input') throw new Error('Expected --input request.json (or --help)');
  console.log(JSON.stringify(await prepareRequest(JSON.parse(await readFile(args[1], 'utf8')))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
