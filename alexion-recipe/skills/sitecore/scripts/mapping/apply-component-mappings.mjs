#!/usr/bin/env node
// Explicit local staging; does not overwrite raw captures or publish target content.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { absolutePath, isMain, readBound, verifyComponentMigrationPlanEvidence, writeFreshOutput } from './cli-files.mjs';
import { exact, sha256 } from './component-mapping.mjs';
import { routeFile } from '../capture/rendering-coverage.mjs';
import { mapLayoutForTarget } from './map-layout-for-target.mjs';

export function applyComponentMappings(options) {
  exact(options, ['mappingPlanFile', 'mappingPlanSha256', 'layoutFile', 'layoutSha256', 'route', 'outputDir'], 'mapping application');
  routeFile(options.route);
  const boundPlan = readBound({ plan: options.mappingPlanFile, 'plan-sha256': options.mappingPlanSha256 }, 'plan');
  const plan = verifyComponentMigrationPlanEvidence(boundPlan.value);
  const captured = readBound({ layout: options.layoutFile, 'layout-sha256': options.layoutSha256 }, 'layout');
  const mapped = mapLayoutForTarget(captured.value, options.route, plan);
  const outputFile = writeFreshOutput(options.outputDir, 'mapped-layout.json', mapped.layout);
  const result = { schemaVersion: 1, kind: 'derived-mapped-layout', route: options.route, sourceLayout: captured.reference, mappingPlan: boundPlan.reference, outputFile, sha256: sha256(readFileSync(outputFile)), appliedRequirementKeys: mapped.appliedRequirementKeys, warnings: mapped.warnings, implementationValidation: 'pending', visualValidation: 'pending' };
  writeFileSync(join(absolutePath(options.outputDir, 'outputDir'), 'mapping-result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}
if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--params') throw new Error('Usage: node apply-component-mappings.mjs --params <absolute-json-file>');
    const result = applyComponentMappings(JSON.parse(readFileSync(absolutePath(process.argv[3], 'params'), 'utf8')));
    console.log(result.outputFile);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
