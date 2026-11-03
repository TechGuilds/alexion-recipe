#!/usr/bin/env node
/**
 * Read-only component-to-route usage analysis for captured Sitecore layouts.
 *
 * This is the recipe-owned all-routes usage producer:
 * it consumes the already captured hierarchical route/index.json files and
 * writes a fresh report. It never calls Sitecore, mutates a project or treats
 * a partial/capped capture as exhaustive.
 */
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = `Usage: node analyze-usage.mjs --layouts <captured-layouts> --output <new-report.json>
  --all-routes                 analyze every captured route (required for route coverage)
  --route <prefix>             analyze one route or a trailing-slash prefix
  --placeholder <name>         include only an exact placeholder key
  --max-files <positive-int>   default: 10000
  The input is read-only; output must be a new file outside the input tree.
`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim();

function options(argv) {
  const result = { 'max-files': 10000, 'all-routes': false };
  const allowed = new Set(['layouts', 'output', 'all-routes', 'route', 'placeholder', 'max-files']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-routes') { result['all-routes'] = true; continue; }
    if (!arg.startsWith('--') || !allowed.has(arg.slice(2)) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${arg}`);
    result[arg.slice(2)] = argv[++i];
  }
  if (!result.layouts || !result.output) throw new Error('--layouts and --output are required');
  result['max-files'] = Number(result['max-files']);
  if (!Number.isSafeInteger(result['max-files']) || result['max-files'] < 1) throw new Error('--max-files must be a positive integer');
  if (result.route !== undefined && (!nonEmpty(result.route) || !result.route.startsWith('/'))) throw new Error('--route must be an absolute route prefix');
  if (result.placeholder !== undefined && !nonEmpty(result.placeholder)) throw new Error('--placeholder must be non-empty');
  if (result.route && result['all-routes']) throw new Error('--route and --all-routes are mutually exclusive');
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function files(root, limit) {
  const result = [];
  async function visit(current) {
    if (result.length >= limit) return;
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= limit) break;
      const full = path.join(current, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await visit(full);
      else if (stat.isFile() && entry.name === 'index.json') result.push(full);
    }
  }
  await visit(root);
  return result;
}

function routeFromFile(root, file) {
  const relative = path.posix.normalize(path.relative(root, file).replaceAll(path.sep, '/') );
  const directory = path.posix.dirname(relative).replace(/^\.?\//, '');
  return !directory || directory === 'home' ? '/' : `/${directory}`;
}

function routeMatches(route, filter) {
  if (!filter) return true;
  if (route === filter) return true;
  const prefix = filter.endsWith('/') ? filter : `${filter}/`;
  return route.startsWith(prefix);
}

function componentIdentity(node) {
  if (!object(node)) return null;
  const name = [node.componentName, node.renderingName, node.renderingId, node.id].find(nonEmpty);
  if (!name) return null;
  return { name: String(name), path: nonEmpty(node.componentPath) ? String(node.componentPath) : null };
}

function collect(nodes, route, placeholder, records, occurrences, warnings, parentPlaceholder = null) {
  if (!Array.isArray(nodes)) return;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const identity = componentIdentity(node);
    if (!identity) { warnings.push({ route, placeholder: parentPlaceholder, index, reason: 'component-identity-unavailable' }); }
    else if (!placeholder || placeholder === parentPlaceholder) {
      const key = identity.name;
      let record = records.get(key);
      if (!record) { record = { componentName: key, componentPath: identity.path, routes: new Set(), occurrences: 0 }; records.set(key, record); }
      if (!record.componentPath && identity.path) record.componentPath = identity.path;
      record.routes.add(route);
      record.occurrences += 1;
      occurrences.push({ route, placeholder: parentPlaceholder, index, uid: nonEmpty(node.uid) ? String(node.uid) : null, componentName: key });
    }
    if (object(node?.placeholders)) {
      for (const [childPlaceholder, children] of Object.entries(node.placeholders)) collect(children, route, placeholder, records, occurrences, warnings, childPlaceholder);
    }
  }
}

async function run(opts) {
  const root = await realpath(path.resolve(opts.layouts));
  if (!(await lstat(root)).isDirectory()) throw new Error('--layouts must be a directory');
  const output = path.resolve(opts.output);
  if (inside(root, output)) throw new Error('Output must be outside the captured layouts tree');
  const candidates = await files(root, opts['max-files'] + 1);
  const capped = candidates.length > opts['max-files'];
  const selected = candidates.slice(0, opts['max-files']);
  const records = new Map(), occurrences = [], warnings = [], omissions = [];
  const routes = [];
  for (const file of selected) {
    const route = routeFromFile(root, file);
    if (!routeMatches(route, opts.route)) continue;
    try {
      const input = await open(file, 'r');
      let source;
      try { source = await input.readFile('utf8'); } finally { await input.close(); }
      const parsed = JSON.parse(source);
      const placeholders = parsed?.sitecore?.route?.placeholders;
      if (!object(placeholders)) throw new Error('route-placeholders-unavailable');
      routes.push(route);
      for (const [placeholder, nodes] of Object.entries(placeholders)) collect(nodes, route, opts.placeholder, records, occurrences, warnings, placeholder);
    } catch (error) { omissions.push({ route, file: path.relative(root, file).replaceAll(path.sep, '/'), reason: error.message }); }
  }
  const uniqueRoutes = [...new Set(routes)].sort();
  const complete = !capped && omissions.length === 0 && warnings.length === 0;
  const authoritative = Boolean(opts['all-routes'] && complete);
  const frequencies = [...records.values()].map(record => ({ componentName: record.componentName, componentPath: record.componentPath, routes: [...record.routes].sort(), routeCount: record.routes.size, occurrenceCount: record.occurrences, isGlobal: authoritative && record.routes.size >= uniqueRoutes.length * 0.8 })).sort((a, b) => b.routeCount - a.routeCount || a.componentName.localeCompare(b.componentName));
  const report = { version: 1, scope: { layoutsRoot: '.', route: opts.route ?? null, placeholder: opts.placeholder ?? null, allRoutesRequested: opts['all-routes'], maxFiles: opts['max-files'] }, coverage: { totalRoutes: uniqueRoutes.length, routesRead: uniqueRoutes.length, filesRead: selected.length, complete, authoritative, capped, omissions, warnings }, frequencies, occurrences };
  await mkdir(path.dirname(output), { recursive: true });
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await handle.close(); }
  return { success: true, destination: output, complete, authoritative, totalRoutes: uniqueRoutes.length, totalComponents: frequencies.length, occurrences: occurrences.length, omissions: omissions.length, warnings: warnings.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).includes('--help')) process.stdout.write(usage);
  else { try { process.stdout.write(`${JSON.stringify(await run(options(process.argv.slice(2))))}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`); process.exitCode = 1; } }
}

export { collect, routeFromFile, run };
