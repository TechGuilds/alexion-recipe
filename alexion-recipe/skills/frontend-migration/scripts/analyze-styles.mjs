#!/usr/bin/env node
// Native filesystem entry point; detector algorithms live beside the skill.
import { lstat, realpath, open } from 'node:fs/promises';
import { scan, readBounded, prepareOutput } from './analysis-files.mjs';
import path from 'node:path';

const usage = `Usage: node analyze-styles.mjs --root <code-directory> --output <new-report.json>
  --source-kind generic|headless|mvc  (default: generic)
  --mvc-analysis <raw-roslyn.json>    optional, MVC only; result.styleReferences
  --max-files <positive-integer>     default: 1000
  --max-file-bytes <positive-integer> default: 2097152
Writes full JSON evidence to a new file outside the input tree. Returns a compact
JSON summary. Partial scans have complete:false. No workflow or memory writes.
Install detector dependencies in scripts/styles before running (see its package.json).
`;

function options(argv) {
  const result = { 'source-kind': 'generic', 'max-files': 1000, 'max-file-bytes': 2097152 };
  const allowed = new Set(['root', 'output', 'source-kind', 'mvc-analysis', 'max-files', 'max-file-bytes']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
    result[key] = argv[i + 1];
  }
  if (!result.root || !result.output) throw new Error('--root and --output are required');
  if (!['generic', 'headless', 'mvc'].includes(result['source-kind'])) throw new Error('Invalid --source-kind');
  if (result['mvc-analysis'] && result['source-kind'] !== 'mvc') throw new Error('--mvc-analysis requires --source-kind mvc');
  for (const key of ['max-files', 'max-file-bytes']) {
    result[key] = Number(result[key]);
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error(`Invalid --${key}: expected a positive integer`);
  }
  return result;
}

// Validate the Roslyn fields consumed by mvc.mjs before they become evidence.
// Older artifacts omit cross-cutting arrays and unconsumed producer metadata.
// Known metadata is type-checked when supplied; unknown extensions are allowed.
function validateMvcStyleReferences(refs) {
  const fail = (field, expected) => { throw new Error(`Invalid MVC artifact: ${field}: expected ${expected}`); };
  const string = (value, field) => { if (typeof value !== 'string') fail(field, 'string'); };
  const boolean = (value, field) => { if (typeof value !== 'boolean') fail(field, 'boolean'); };
  const line = (value, field) => { if (!Number.isSafeInteger(value) || value < 1) fail(field, 'positive integer line number'); };
  const optional = validate => (value, field) => { if (value !== undefined) validate(value, field); };
  const nullableString = optional((value, field) => { if (value !== null) string(value, field); });
  const array = validate => (value, field) => {
    if (!Array.isArray(value)) fail(field, 'array');
    value.forEach((item, index) => validate(item, `${field}[${index}]`));
  };
  const record = fields => (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'object');
    for (const [key, validate] of Object.entries(fields)) validate(value[key], `${field}.${key}`);
  };
  const strings = array(string);
  record({
    bundleConfigs: array(record({
      filePath: optional(string),
      bundles: array(record({ virtualPath: string, includes: strings, bundleType: optional(string) })),
    })),
    razorStyleRefs: array(record({ filePath: string, linkTags: strings, stylesRenders: strings, hasStylesSection: boolean })),
    buildToolFiles: optional(strings),
    razorBodyClasses: optional(array(record({ filePath: string, expression: string, staticClasses: strings, conditionHint: nullableString }))),
    razorInlineStyleAttrs: optional(array(record({ filePath: string, lineNumber: line, tag: string, expression: string, viewModelProperty: nullableString }))),
    cssStringViewModelProps: optional(array(record({ filePath: optional(string), className: optional(string), propertyName: string, consumedByView: nullableString }))),
  })(refs, 'result.styleReferences');
}

async function run(opts) {
  const root = await realpath(path.resolve(opts.root));
  if (!(await lstat(root)).isDirectory()) throw new Error('--root must be a directory');
  // Validate write location before spending time on analysis; file itself uses exclusive creation.
  const output = await prepareOutput(opts.output, root);
  const { files, info } = await scan(root, opts);
  const { analyzeFiles } = await import('./styles/core.mjs');
  const { mergeMvcStyleReferences, extractHeadlessStyleReferences, mergeHeadlessStyleReferences } = await import('./styles/domain.mjs');
  let analysis = await analyzeFiles(files);
  for (const warning of analysis.parseWarnings ?? []) {
    info.complete = false;
    info.omissions.push({ file: warning.file, reason: 'parse-error', message: warning.message });
  }
  if (opts['source-kind'] === 'mvc') {
    let refs;
    if (opts['mvc-analysis']) {
      const raw = JSON.parse(await readBounded(path.resolve(opts['mvc-analysis']), opts['max-file-bytes']));
      refs = raw?.result?.styleReferences;
      validateMvcStyleReferences(refs);
    } else {
      info.complete = false;
      info.omissions.push({ reason: 'mvc-evidence-unavailable' });
    }
    analysis = mergeMvcStyleReferences(analysis, refs);
  } else if (opts['source-kind'] === 'headless') {
    analysis = mergeHeadlessStyleReferences(analysis, extractHeadlessStyleReferences(files.filter(f => /\.[jt]sx$/i.test(f.path))));
  }
  const report = { ...analysis, scan: { ...info, sourceKind: opts['source-kind'], maxFiles: opts['max-files'], maxFileBytes: opts['max-file-bytes'] } };
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await handle.close(); }
  const crossCutting = Object.fromEntries(['externalStylesheets', 'serverInjectedBodyClasses', 'dynamicStyleAttributes', 'externallyCoupledPartials'].map(key => [key, analysis[key]?.length ?? 0]));
  return { success: true, destination: output, complete: info.complete, filesRead: info.filesRead, filesMatched: info.filesMatched, primarySystem: analysis.primarySystem, confidence: analysis.confidence, crossCutting };
}

if (process.argv.slice(2).includes('--help')) {
  process.stdout.write(usage);
} else {
  try { process.stdout.write(`${JSON.stringify(await run(options(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`); process.exitCode = 1; }
}
