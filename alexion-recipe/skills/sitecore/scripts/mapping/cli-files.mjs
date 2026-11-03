// Shared filesystem boundary for portable mapping CLIs. No source/target content writes.
import { readFileSync, lstatSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './component-mapping.mjs';
import { buildComponentMigrationPlan, validateComponentMigrationPlan } from './component-migration-plan.mjs';

export function parseArgs(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith('--') || !allowed.includes(key.slice(2)) || options[key.slice(2)] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown, duplicate or incomplete option: ${key}`);
    options[key.slice(2)] = args[index + 1];
  }
  return options;
}
export function absolutePath(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${label} must be an explicit absolute path`);
  return resolve(path);
}
export function readBound(options, role, required = true) {
  const path = options[role], expected = options[`${role}-sha256`];
  if (!required && path === undefined && expected === undefined) return undefined;
  const fullPath = absolutePath(path, role);
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${role}-sha256 must be an explicit SHA-256 digest`);
  if (!lstatSync(fullPath).isFile()) throw new Error(`${role} must be a regular file`);
  const bytes = readFileSync(fullPath);
  if (sha256(bytes) !== expected) throw new Error(`${role} input file hash mismatch`);
  return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), reference: { role, path: fullPath, sha256: expected } };
}
export function writeFreshOutput(outputDir, fileName, value) {
  const path = absolutePath(outputDir, 'output-dir');
  if (existsSync(path)) throw new Error('output-dir must be a fresh, nonexistent directory');
  let current = dirname(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('output-dir ancestors cannot be symbolic links');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(path);
  const outputFile = join(path, fileName);
  writeFileSync(outputFile, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return outputFile;
}
export const isMain = url => process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;

/** Rebuild from current bytes so a recomputed plan checksum cannot manufacture approval. */
export function verifyComponentMigrationPlanEvidence(plan) {
  validateComponentMigrationPlan(plan, { requireApproval: true });
  if (!plan.approvalEvidence) throw new Error('Current keyed approval evidence file is required');
  const inputs = new Map();
  for (const ref of plan.inputFiles) inputs.set(ref.role, readBound({ [ref.role]: ref.path, [`${ref.role}-sha256`]: ref.sha256 }, ref.role));
  for (const role of ['source', 'target', 'manifest']) if (!inputs.has(role)) throw new Error(`Missing approved plan ${role} input`);
  const decisionFile = plan.approvalEvidence;
  const decisions = readBound({ decisions: decisionFile.path, 'decisions-sha256': decisionFile.sha256 }, 'decisions');
  const rebuilt = buildComponentMigrationPlan(inputs.get('source').value, inputs.get('target').value, inputs.get('manifest').value, { decisions: decisions.value, approvalEvidence: decisionFile, inputFiles: plan.inputFiles, scopeId: plan.approval.scopeId, coverageReport: inputs.get('coverage')?.value });
  validateComponentMigrationPlan(rebuilt, { requireApproval: true });
  if (rebuilt.fingerprint !== plan.fingerprint) throw new Error('Component migration plan does not match current approved input evidence');
  return rebuilt;
}
