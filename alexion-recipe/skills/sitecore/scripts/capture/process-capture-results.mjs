#!/usr/bin/env node
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { absolutePath, assertNewOutput, budget } from './prepare-capture-request.mjs';
import { validateCapturePlan, validateOutcomeIdentity, routeFile, sha256, buildRenderingCoverageReport } from './rendering-coverage.mjs';

/** Bounded local recovery preparation; never starts network requests or polls SPE. */
export function selectRecoveryPages(plan, report, options = {}) {
  const maxAlternativePages = budget(options.maxAlternativePages, 'maxAlternativePages', 5);
  const maxAlternativesPerRequirement = budget(options.maxAlternativesPerRequirement, 'maxAlternativesPerRequirement', 1);
  const maxUrls = budget(options.maxUrls, 'maxUrls', 0);
  const outcomes = report.outcomes;
  const attemptedOutcomes = outcomes.filter((o) => o.status !== 'skipped');
  const attempted = new Set(outcomes.map((o) => o.route));
  const selected = new Set(plan.selectedPages.map((p) => p.route));
  const previousAlternatives = new Set(attemptedOutcomes.filter((o) => !selected.has(o.route)).map((o) => o.route));
  let remaining = Math.max(0, maxAlternativePages - previousAlternatives.size);
  if (maxUrls > 0) remaining = Math.min(remaining, Math.max(0, maxUrls - attemptedOutcomes.length));
  const pages = [];
  const pending = report.requirements.filter((r) => !['captured', 'mapping-only'].includes(r.status));
  // Resume planned pages that never made a network attempt before choosing alternatives.
  const networkAttempted = new Set(attemptedOutcomes.map((o) => o.route));
  const pendingKeys = new Set(pending.map((r) => r.key));
  const resumedPages = plan.selectedPages.filter((p) => !networkAttempted.has(p.route) && p.requirementKeys.some((key) => pendingKeys.has(key)));
  const resumeRoom = maxUrls > 0 ? Math.max(0, maxUrls - attemptedOutcomes.length) : resumedPages.length;
  for (const page of resumedPages.slice(0, resumeRoom)) { pages.push(page); attempted.add(page.route); }
  const resumedKeys = new Set(pages.flatMap((p) => p.requirementKeys ?? []));
  if (maxUrls > 0) remaining = Math.min(remaining, Math.max(0, maxUrls - attemptedOutcomes.length - pages.length));
  const counts = new Map(pending.map((r) => [r.key, r.alternatives.filter((p) => previousAlternatives.has(p.route)).length]));
  for (const r of pending) {
    if (!remaining) break;
    if (resumedKeys.has(r.key)) continue;
    if ((counts.get(r.key) ?? 0) >= maxAlternativesPerRequirement) continue;
    const page = r.alternatives.find((p) => !attempted.has(p.route) && !selected.has(p.route));
    if (!page) continue;
    pages.push(page); attempted.add(page.route); remaining--;
    for (const other of pending) if (other.alternatives.some((p) => p.route === page.route)) counts.set(other.key, (counts.get(other.key) ?? 0) + 1);
  }
  return { pages, maxAlternativePages, maxAlternativesPerRequirement, totalMaxUrls: maxUrls, previousAttempts: attemptedOutcomes.length, skippedPages: outcomes.length - attemptedOutcomes.length, resumedPages: pages.filter((p) => selected.has(p.route)).length, stoppedReason: !pending.length ? 'coverage-complete' : !pages.length ? (maxUrls > 0 && attemptedOutcomes.length >= maxUrls ? 'page-budget' : 'no-eligible-alternatives') : 'request-prepared' };
}

export function processCaptureResults(options) {
  const capturePlanFile = absolutePath(options.capturePlanFile, 'capturePlanFile');
  const plan = validateCapturePlan(JSON.parse(readFileSync(capturePlanFile, 'utf8')));
  let mappingInventory;
  if (options.mappingInventoryFile || options.mappingInventorySha256) {
    const bytes = readFileSync(absolutePath(options.mappingInventoryFile, 'mappingInventoryFile'));
    if (!/^[a-f0-9]{64}$/.test(options.mappingInventorySha256 ?? '') || sha256(bytes) !== options.mappingInventorySha256) throw new Error('Mapping inventory SHA256 mismatch');
    mappingInventory = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(mappingInventory.requirements) || (mappingInventory.sourceDiscoveryFingerprint !== undefined && mappingInventory.sourceDiscoveryFingerprint !== plan.sourceDiscoveryFingerprint)) throw new Error('Mapping inventory does not match source discovery');
  }
  if (!Array.isArray(options.captureResultFiles) || !options.captureResultFiles.length || new Set(options.captureResultFiles).size !== options.captureResultFiles.length) throw new Error('Declare unique captureResultFiles explicitly');
  if (options.layouts || options.layoutFiles || options.layout || options.outcomes) throw new Error('Only capture result manifests may declare captured layouts');
  const outcomes = [];
  const declaredFiles = new Set(options.captureResultFiles.map((p) => absolutePath(p, 'captureResultFile')));
  const inheritedLimits = [];
  for (const filename of options.captureResultFiles) {
    const result = JSON.parse(readFileSync(absolutePath(filename, 'captureResultFile'), 'utf8'));
    if (result.capturePlanFingerprint !== plan.fingerprint || result.selection !== 'discovery-plan' || !Array.isArray(result.outcomes)) throw new Error('Capture result does not belong to the approved plan');
    if (result.totalMaxUrls !== undefined) inheritedLimits.push(budget(result.totalMaxUrls, 'totalMaxUrls'));
    for (const previous of result.previousCaptureResultFiles ?? []) if (!declaredFiles.has(absolutePath(previous, 'previousCaptureResultFile'))) throw new Error('Recovery processing requires every previous capture result manifest');
    const root = realpathSync(absolutePath(result.outputDir, 'capture outputDir'));
    for (const outcome of result.outcomes) {
      validateOutcomeIdentity(plan, outcome);
      const { layout: _untrustedLayout, ...verified } = outcome;
      if (outcome.status === 'captured') {
        const file = absolutePath(outcome.layoutFile, 'layoutFile');
        if (resolve(root, routeFile(outcome.route)) !== file) throw new Error('Captured layout path does not match approved route');
        const actual = realpathSync(file), rel = relative(root, actual);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Captured layout escapes outputDir');
        const bytes = readFileSync(actual);
        if (!/^[a-f0-9]{64}$/.test(outcome.sha256 ?? '') || sha256(bytes) !== outcome.sha256) throw new Error('Captured layout SHA256 mismatch');
        verified.layout = JSON.parse(bytes.toString('utf8'));
      }
      outcomes.push(verified);
    }
  }
  const report = buildRenderingCoverageReport(plan, outcomes, { mappingInventory });
  if (mappingInventory) report.mappingInventory = { file: absolutePath(options.mappingInventoryFile, 'mappingInventoryFile'), sha256: options.mappingInventorySha256, sourceDiscoveryFingerprint: mappingInventory.sourceDiscoveryFingerprint ?? null };
  const positiveLimits = [budget(options.maxUrls, 'maxUrls', 0), ...inheritedLimits].filter((n) => n > 0);
  const totalMaxUrls = positiveLimits.length ? Math.min(...positiveLimits) : 0;
  if (totalMaxUrls > 0 && outcomes.filter((o) => o.status !== 'skipped').length > totalMaxUrls) throw new Error('Capture attempts exceed overall maxUrls budget');
  const recovery = selectRecoveryPages(plan, report, { ...options, maxUrls: totalMaxUrls });
  report.recovery = recovery;
  const nextRequest = recovery.pages.length ? { capturePlanFile, capturePages: recovery.pages, maxUrls: recovery.pages.length, totalMaxUrls: recovery.totalMaxUrls, previousCaptureResultFiles: options.captureResultFiles.map((p) => absolutePath(p, 'captureResultFile')) } : null;
  if (nextRequest && mappingInventory) {
    nextRequest.mappingInventoryFile = absolutePath(options.mappingInventoryFile, 'mappingInventoryFile');
    nextRequest.mappingInventorySha256 = options.mappingInventorySha256;
  }
  if (options.outputDir) {
    const dir = absolutePath(options.outputDir, 'outputDir');
    assertNewOutput(dir); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rendering-coverage-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    if (nextRequest) writeFileSync(join(dir, 'next-capture-request.json'), `${JSON.stringify(nextRequest, null, 2)}\n`, { flag: 'wx' });
  }
  return { report, nextRequest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== '--params') throw new Error('Usage: node process-capture-results.mjs --params <json-file>');
    const options = JSON.parse(readFileSync(argv[1], 'utf8'));
    if (!options.outputDir) throw new Error('CLI requires explicit new outputDir');
    processCaptureResults(options); console.log(options.outputDir);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
