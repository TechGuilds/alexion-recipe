#!/usr/bin/env node
import { buildComponentMigrationPlan } from './component-migration-plan.mjs';
import { isMain, parseArgs, readBound, writeFreshOutput } from './cli-files.mjs';

export function buildMigrationPlan(args) {
  const options = parseArgs(args, ['source', 'source-sha256', 'target', 'target-sha256', 'manifest', 'manifest-sha256', 'decisions', 'decisions-sha256', 'coverage', 'coverage-sha256', 'scope-id', 'output-dir']);
  const source = readBound(options, 'source'), target = readBound(options, 'target'), manifest = readBound(options, 'manifest'), decisions = readBound(options, 'decisions'), coverage = readBound(options, 'coverage', false);
  const plan = buildComponentMigrationPlan(source.value, target.value, manifest.value, { decisions: decisions.value, approvalEvidence: { path: decisions.reference.path, sha256: decisions.reference.sha256 }, inputFiles: [source.reference, target.reference, manifest.reference, ...(coverage ? [coverage.reference] : [])], scopeId: options['scope-id'], coverageReport: coverage?.value });
  return writeFreshOutput(options['output-dir'], 'component-migration-plan.json', plan);
}
if (isMain(import.meta.url)) {
  try { console.log(buildMigrationPlan(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
