#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSitecoreArtifactFileSync } from './contracts/sitecore-artifacts.mjs';

export function validateArtifactArgs(args) {
  if (args.length === 2 && args[0] === '--params') {
    if (!isAbsolute(args[1])) throw new Error('--params requires an absolute JSON file path');
    const options = JSON.parse(readFileSync(args[1], 'utf8').replace(/^\uFEFF/, ''));
    const allowed = ['kind', 'file', 'sha256', 'sourceInventory', 'targetInventory', 'capturePlan', 'requireApproval', 'currentInputs', 'currentDecisions', 'currentApprovalEvidence'];
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !allowed.includes(k))) throw new Error('Unknown or malformed artifact validation params');
    return options;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--kind', '--file', '--sha256'].includes(flag) || !args[i + 1] || Object.hasOwn(options, flag.slice(2))) throw new Error('Usage: node validate-sitecore-artifact.mjs --kind <kind> --file <absolute-json> --sha256 <digest>');
    options[flag.slice(2)] = args[i + 1];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = validateArtifactArgs(process.argv.slice(2));
    validateSitecoreArtifactFileSync(options);
    console.log(JSON.stringify({ valid: true, kind: options.kind, file: options.file, sha256: options.sha256, validation: 'structure-and-integrity' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
