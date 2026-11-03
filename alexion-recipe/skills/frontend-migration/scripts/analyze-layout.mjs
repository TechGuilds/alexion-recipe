#!/usr/bin/env node
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { scan, prepareOutput, inside } from './analysis-files.mjs';

const usage = `Usage: node analyze-layout.mjs --root <code-directory> --framework jss|content-sdk --output <new-report.json>
  --layouts <mock-layouts-directory> optional captured source layouts, **/index.json
  --max-files <positive-integer> default: 1000 (per input tree)
  --max-file-bytes <positive-integer> default: 2097152
Writes JSON evidence outside all input trees; never overwrites an existing file.
Returns a compact summary; complete:false means input coverage needs attention.
Install parser dependencies from scripts/layouts with npm ci --workspaces=false.
This is static evidence, not proof of runtime rendering or migration completion.
`;

function options(argv) {
  const result = { 'max-files': 1000, 'max-file-bytes': 2097152 };
  const allowed = new Set(['root', 'framework', 'output', 'layouts', 'max-files', 'max-file-bytes']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
    result[key] = argv[i + 1];
  }
  if (!result.root || !result.output || !result.framework) throw new Error('--root, --framework and --output are required');
  if (!['jss', 'content-sdk'].includes(result.framework)) throw new Error('Invalid --framework');
  for (const key of ['max-files', 'max-file-bytes']) {
    result[key] = Number(result[key]);
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error(`Invalid --${key}: expected a positive integer`);
  }
  return result;
}

async function directory(input) {
  const root = await realpath(path.resolve(input));
  if (!(await lstat(root)).isDirectory()) throw new Error(`Expected directory: ${input}`);
  return root;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function distribution(root, opts) {
  const { files, info } = await scan(root, { ...opts, relevant: name => name === 'index.json' });
  const groups = new Map();
  let pagesAnalyzed = 0;
  const omit = (file, reason) => { info.complete = false; info.omissions.push({ file, reason }); };
  for (const file of files) {
    let route;
    try {
      route = JSON.parse(file.content)?.sitecore?.route;
      if (!object(route) || !object(route.placeholders) || !Object.values(route.placeholders).every(Array.isArray)
        || (route.layoutId !== undefined && typeof route.layoutId !== 'string')
        || (route.layoutFilePath !== undefined && typeof route.layoutFilePath !== 'string')) throw new Error('invalid-route');
    } catch { omit(file.path, 'invalid-layout-json'); continue; }
    const id = route.layoutId || 'unknown';
    if (id === 'unknown') omit(file.path, 'layout-id-unavailable');
    let group = groups.get(id);
    if (!group) { group = { routes: [], placeholders: new Set() }; groups.set(id, group); }
    if (route.layoutFilePath) {
      if (group.layoutFilePath && group.layoutFilePath !== route.layoutFilePath) omit(file.path, 'conflicting-layout-file-path');
      else group.layoutFilePath = route.layoutFilePath;
    }
    const relative = path.posix.dirname(file.path.replace(/^\.\//, ''));
    group.routes.push(relative === 'home' || relative === '.' ? '/' : `/${relative}`);
    for (const name of Object.keys(route.placeholders)) group.placeholders.add(name);
    pagesAnalyzed++;
  }
  const distributions = [...groups].map(([layoutId, group]) => ({
    layoutId,
    ...(group.layoutFilePath ? { layoutFilePath: group.layoutFilePath } : {}),
    pageCount: group.routes.length,
    rootPlaceholders: [...group.placeholders].sort(),
    sampleRoutes: group.routes.slice(0, 3),
  })).sort((a, b) => b.pageCount - a.pageCount || (a.layoutId < b.layoutId ? -1 : a.layoutId > b.layoutId ? 1 : 0));
  return { distributions, totalPages: info.filesMatched, pagesAnalyzed, uniqueLayouts: distributions.length, scan: info };
}

async function run(opts) {
  const root = await directory(opts.root);
  const layouts = opts.layouts ? await directory(opts.layouts) : undefined;
  // Check both input roots before creating any output parent.
  if ([root, layouts].filter(Boolean).some(input => inside(input, path.resolve(opts.output)))) throw new Error('Output must be outside all input trees');
  const output = await prepareOutput(opts.output, root);
  if (layouts) await prepareOutput(output, layouts);
  const { files, info } = await scan(root, { ...opts, relevant: name => /\.(?:[cm]?[jt]sx?|json)$/i.test(name) });
  const { analyzeFiles } = await import('./layouts/core.mjs');
  const analysis = await analyzeFiles(files, { framework: opts.framework, rootPath: root });
  for (const warning of analysis.parseWarnings ?? []) {
    info.complete = false;
    info.omissions.push({ file: warning.file, reason: 'parse-error', message: warning.message });
  }
  const layoutDistribution = layouts ? await distribution(layouts, opts) : undefined;
  if (layoutDistribution && !layoutDistribution.scan.complete) info.complete = false;
  const report = { ...analysis, ...(layoutDistribution ? { layoutDistribution } : {}), scan: { ...info, framework: opts.framework, maxFiles: opts['max-files'], maxFileBytes: opts['max-file-bytes'] } };
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await handle.close(); }
  return { success: true, destination: output, complete: info.complete, filesRead: info.filesRead, filesMatched: info.filesMatched, layoutCount: analysis.layouts?.length ?? 0, placeholders: analysis.allPlaceholders ?? [], layoutDistributionIncluded: Boolean(layoutDistribution) };
}

if (process.argv.slice(2).includes('--help')) process.stdout.write(usage);
else {
  try { process.stdout.write(`${JSON.stringify(await run(options(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`); process.exitCode = 1; }
}
