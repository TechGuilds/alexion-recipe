#!/usr/bin/env node
// Converts retained style-analysis evidence into a bounded, reviewable handoff.
// It never scans application roots or mutates source/target applications.
import { createHash } from 'node:crypto';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { prepareOutput, readBounded } from './analysis-files.mjs';

const usage = `Usage: node plan-style-foundation.mjs \
  --source-analysis <styles-source.json> \
  --source-root <source-application-directory> \
  --target-root <target-application-directory> \
  --output <new-style-foundation-plan.json> \
  [--target-analysis <styles-target.json>]

Creates a deterministic handoff from retained style-analysis reports. It does not
scan source/target applications, install dependencies, copy assets, or edit code.
The output must be new and outside both application roots.
`;

const analysisLimit = 8 * 1024 * 1024;

function options(argv) {
  const result = {};
  const allowed = new Set(['source-analysis', 'target-analysis', 'source-root', 'target-root', 'output']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2);
    const value = argv[index + 1];
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || !value || value.startsWith('--')) {
      throw new Error(`Invalid option: ${argv[index] ?? ''}`);
    }
    result[key] = value;
  }
  for (const key of ['source-analysis', 'source-root', 'target-root', 'output']) {
    if (!result[key]) throw new Error(`--${key} is required`);
  }
  return result;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`Invalid analysis report: ${field} must be an array`);
  return value;
}

function requireRecord(value, field) {
  if (!isRecord(value)) throw new Error(`Invalid analysis report: ${field} must be an object`);
  return value;
}

function validateString(value, field) {
  if (typeof value !== 'string') throw new Error(`Invalid analysis report: ${field} must be a string`);
  return value;
}

function validateReport(report, label) {
  requireRecord(report, label);
  const scan = requireRecord(report.scan, `${label}.scan`);
  if (typeof scan.complete !== 'boolean') throw new Error(`Invalid analysis report: ${label}.scan.complete must be a boolean`);
  requireArray(scan.omissions ?? [], `${label}.scan.omissions`);
  validateString(report.primarySystem, `${label}.primarySystem`);
  if (typeof report.confidence !== 'number') throw new Error(`Invalid analysis report: ${label}.confidence must be a number`);
  requireArray(report.secondarySystems, `${label}.secondarySystems`).forEach((value, index) => validateString(value, `${label}.secondarySystems[${index}]`));
  requireArray(report.configFiles, `${label}.configFiles`).forEach((entry, index) => validateString(requireRecord(entry, `${label}.configFiles[${index}]`).path, `${label}.configFiles[${index}].path`));
  requireArray(report.cssImports, `${label}.cssImports`).forEach((entry, index) => {
    const item = requireRecord(entry, `${label}.cssImports[${index}]`);
    validateString(item.type, `${label}.cssImports[${index}].type`);
    validateString(item.file, `${label}.cssImports[${index}].file`);
    validateString(item.path, `${label}.cssImports[${index}].path`);
    if (!Number.isSafeInteger(item.line) || item.line < 1) throw new Error(`Invalid analysis report: ${label}.cssImports[${index}].line must be a positive integer`);
  });
  const dependencies = requireRecord(report.dependencies, `${label}.dependencies`);
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const values = requireRecord(dependencies[section], `${label}.dependencies.${section}`);
    for (const [name, version] of Object.entries(values)) {
      validateString(name, `${label}.dependencies.${section} name`);
      validateString(version, `${label}.dependencies.${section}.${name}`);
    }
  }
  requireRecord(report.cssFiles, `${label}.cssFiles`);
  return report;
}

async function reportAt(input, label) {
  const requested = path.resolve(input);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} analysis must be a regular file`);
  const resolved = await realpath(requested);
  const content = await readBounded(resolved, analysisLimit);
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`${label} analysis is not valid JSON`); }
  return {
    path: resolved,
    sha256: createHash('sha256').update(content).digest('hex'),
    report: validateReport(parsed, label),
  };
}

async function directoryAt(input, label) {
  const resolved = await realpath(path.resolve(input));
  if (!(await lstat(resolved)).isDirectory()) throw new Error(`${label} root must be a directory`);
  return resolved;
}

function stable(items, key) {
  return [...items].sort((left, right) => key(left).localeCompare(key(right)));
}

function imports(report) {
  const unique = new Map();
  for (const item of report.cssImports) {
    const normalized = { type: item.type, file: item.file, line: item.line, path: item.path, raw: typeof item.raw === 'string' ? item.raw : null };
    unique.set(`${normalized.file}\u0000${normalized.line}\u0000${normalized.path}\u0000${normalized.type}`, normalized);
  }
  return stable(unique.values(), item => `${item.file}\u0000${String(item.line).padStart(10, '0')}\u0000${item.path}\u0000${item.type}`);
}

function dependencies(report) {
  const values = [];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(report.dependencies[section])) values.push({ section, name, version });
  }
  return stable(values, item => `${item.name}\u0000${item.section}`);
}

function concerns(report) {
  const fields = ['externalStylesheets', 'serverInjectedBodyClasses', 'dynamicStyleAttributes'];
  return Object.fromEntries(fields.map(field => [field, Array.isArray(report[field]) ? report[field] : []]));
}

function limitations(source, target) {
  const values = [{
    code: 'runtime-import-order-unproven',
    detail: 'Static imports are deterministic candidates, not proof of runtime cascade order. Confirm the actual source layout entrypoint before applying target imports.',
  }, {
    code: 'fonts-icons-assets-not-inferred',
    detail: 'The style analyzer does not establish shared font, icon, or asset ownership. Inspect only the selected source layout and declared style candidates for those dependencies.',
  }];
  if (!source.report.scan.complete) values.push({ code: 'source-analysis-incomplete', omissions: source.report.scan.omissions });
  if (!target) values.push({ code: 'target-equivalence-unassessed', detail: 'No target style-analysis report was supplied; inspect the declared target entrypoint before deciding what to add.' });
  else if (!target.report.scan.complete) values.push({ code: 'target-analysis-incomplete', omissions: target.report.scan.omissions });
  return values;
}

function buildPlan(source, target) {
  const sourceImports = imports(source.report);
  const componentLocal = sourceImports.filter(item => /\.module\.(css|scss|sass|less)$/i.test(item.path));
  const global = sourceImports.filter(item => !/\.module\.(css|scss|sass|less)$/i.test(item.path));
  const sourceDependencies = dependencies(source.report);
  const targetNames = new Set(target ? dependencies(target.report).map(item => item.name) : []);
  const sourceOnly = sourceDependencies.filter(item => !targetNames.has(item.name));
  return {
    schemaVersion: 1,
    kind: 'style-foundation-plan',
    input: {
      source: { analysisPath: source.path, sha256: source.sha256, scanComplete: source.report.scan.complete },
      target: target ? { analysisPath: target.path, sha256: target.sha256, scanComplete: target.report.scan.complete } : null,
    },
    foundation: {
      sourceStyleSystem: { primary: source.report.primarySystem, confidence: source.report.confidence, secondary: stable(source.report.secondarySystems, value => value) },
      globalImportCandidates: global,
      configurationCandidates: stable(source.report.configFiles.map(item => ({ type: item.type ?? 'other', path: item.path })), item => `${item.type}\u0000${item.path}`),
      crossCutting: concerns(source.report),
    },
    componentLocal: {
      excludedImports: componentLocal,
      rule: 'CSS Module imports remain component-local unless an approved task explicitly changes their ownership.',
    },
    dependencies: {
      sourceDeclared: sourceDependencies,
      sourceOnly,
      targetEquivalence: target ? 'comparison-is-name-based; confirm versions and runtime use before changing packages' : 'not-assessed',
    },
    order: {
      observedStaticImports: sourceImports,
      requiresLayoutConfirmation: true,
      rule: 'Preserve the actual source layout cascade; this plan does not infer runtime import order from static discovery alone.',
    },
    limitations: limitations(source, target),
  };
}

async function run(opts) {
  const sourceRoot = await directoryAt(opts['source-root'], 'source');
  const targetRoot = await directoryAt(opts['target-root'], 'target');
  const output = await prepareOutput(opts.output, sourceRoot);
  await prepareOutput(output, targetRoot);
  const source = await reportAt(opts['source-analysis'], 'source');
  const target = opts['target-analysis'] ? await reportAt(opts['target-analysis'], 'target') : null;
  const plan = buildPlan(source, target);
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`); }
  finally { await handle.close(); }
  return {
    success: true,
    destination: output,
    globalImportCandidates: plan.foundation.globalImportCandidates.length,
    componentLocalImports: plan.componentLocal.excludedImports.length,
    sourceOnlyDependencies: plan.dependencies.sourceOnly.length,
    limitations: plan.limitations.map(item => item.code),
  };
}

if (process.argv.slice(2).includes('--help')) process.stdout.write(usage);
else {
  try { process.stdout.write(`${JSON.stringify(await run(options(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`); process.exitCode = 1; }
}
