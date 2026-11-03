#!/usr/bin/env node
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { scan, prepareOutput } from './field-access/scan.mjs';

const usage = `Usage: node analyze-field-access.mjs --root <source-directory> --output <new-report.json>
  --revision <label> optional caller-supplied revision (not independently verified)
  --max-files <positive-integer> default: 1000
  --max-file-bytes <positive-integer> default: 2097152
Read-only static detection of Sitecore field access (fields.X, fields['X'],
props.fields.X, props.fields['X'], dot or optional-chained), GraphQL-wrapping
(.jsonValue/.jss) and field type, plus DAM asset access (.asset/.files) and
blind-spot flags for patterns this cannot resolve (getFieldValue(...) calls,
fields destructuring, dynamic field names) — see references/data-flow-to-props.md.
Install field-access dependencies with npm ci --workspaces=false --ignore-scripts.
Output must be outside source, and must not exist. No LSP or application execution required.
`;

function options(argv) {
  const opts = { 'max-files': 1000, 'max-file-bytes': 2097152 };
  const allowed = new Set(['root', 'output', 'revision', 'max-files', 'max-file-bytes']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
    opts[key] = argv[i + 1];
  }
  if (!opts.root || !opts.output) throw new Error('--root and --output are required');
  for (const key of ['max-files', 'max-file-bytes']) {
    opts[key] = Number(opts[key]);
    if (!Number.isSafeInteger(opts[key]) || opts[key] < 1) throw new Error(`Invalid --${key}`);
  }
  return opts;
}

async function run(opts) {
  const root = await realpath(path.resolve(opts.root));
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected source directory');
  const output = await prepareOutput(opts.output, root);
  const { files, info } = await scan(root, opts);
  const { inventory } = await import('./field-access/core.mjs');
  const analysis = inventory(files, { rootPath: root });
  for (const warning of analysis.parseWarnings) {
    info.complete = false;
    info.omissions.push({ file: warning.file, reason: 'parse-error', message: warning.message });
  }
  const report = {
    scope: { root: '.', revision: opts.revision ?? null, revisionSource: 'caller-supplied', extensions: 'JS/TS (including JSX, TSX, CJS, MJS, CTS, MTS)',
      excludedDirectories: ['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.turbo', 'out', '.cache'],
      maxFiles: opts['max-files'], maxFileBytes: opts['max-file-bytes'] },
    ...analysis, graphComplete: analysis.graphComplete && info.complete, scan: info,
  };
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await handle.close(); }
  const fieldAccessCount = analysis.files.reduce((n, f) => n + f.fieldAccess.length, 0);
  const blindSpotCount = analysis.files.reduce((n, f) => n + f.blindSpots.length, 0);
  return { success: true, destination: output, complete: info.complete, graphComplete: report.graphComplete, filesRead: info.filesRead, fieldAccess: fieldAccessCount, blindSpots: blindSpotCount };
}

if (process.argv.slice(2).includes('--help')) process.stdout.write(usage);
else {
  try { process.stdout.write(`${JSON.stringify(await run(options(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`); process.exitCode = 1; }
}
