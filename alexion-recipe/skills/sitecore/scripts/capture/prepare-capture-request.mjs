#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCapturePlan, validateOutcomeIdentity, planPages, samePage } from './rendering-coverage.mjs';

export function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path`);
  return resolve(value);
}
export function budget(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}
export function assertNewOutput(path) {
  absolutePath(path, 'outputDir');
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || readdirSync(path).length)) throw new Error('outputDir must be new or empty and owned by this request');
}
/** Prepare only: credentials are connector environment variables, never serialized. */
export function prepareCaptureRequest(options) {
  const capturePlanFile = absolutePath(options.capturePlanFile, 'capturePlanFile');
  const plan = validateCapturePlan(JSON.parse(readFileSync(capturePlanFile, 'utf8')));
  const outputDir = absolutePath(options.outputDir, 'outputDir');
  assertNewOutput(outputDir);
  if (options.routes || options.routePlan) throw new Error('Explicit routes cannot be mixed with an approved capture plan');
  if (Object.keys(options).some((key) => /secret|password|credential|apikey|token/i.test(key))) throw new Error('Credentials must not appear in capture request preparation');
  if (!['headless', 'mvc'].includes(options.mode ?? 'headless')) throw new Error('mode must be headless or mvc');
  const maxUrls = budget(options.maxUrls, 'maxUrls');
  const totalMaxUrls = budget(options.totalMaxUrls, 'totalMaxUrls', maxUrls ?? 0);
  const previousCaptureResultFiles = options.previousCaptureResultFiles ?? [];
  if (!Array.isArray(previousCaptureResultFiles) || new Set(previousCaptureResultFiles).size !== previousCaptureResultFiles.length) throw new Error('previousCaptureResultFiles must be unique');
  let previousAttempts = 0;
  const previouslyAttempted = new Set();
  const inheritedLimits = [];
  for (const file of previousCaptureResultFiles) {
    const result = JSON.parse(readFileSync(absolutePath(file, 'previousCaptureResultFile'), 'utf8'));
    if (result.capturePlanFingerprint !== plan.fingerprint || result.selection !== 'discovery-plan' || !Array.isArray(result.outcomes)) throw new Error('Previous capture result does not belong to approved plan');
    for (const prior of result.previousCaptureResultFiles ?? []) if (!previousCaptureResultFiles.includes(prior)) throw new Error('Recovery requires every previous capture result manifest');
    previousAttempts += result.outcomes.filter((o) => o.status !== 'skipped').length;
    for (const outcome of result.outcomes) { validateOutcomeIdentity(plan, outcome); if (outcome.status !== 'skipped') previouslyAttempted.add(outcome.route); }
    if (result.totalMaxUrls !== undefined) inheritedLimits.push(budget(result.totalMaxUrls, 'totalMaxUrls'));
  }
  const limits = [totalMaxUrls, ...inheritedLimits].filter((n) => n > 0);
  const overallLimit = limits.length ? Math.min(...limits) : 0;
  let pages = options.capturePages ?? plan.selectedPages;
  if (!Array.isArray(pages) || pages.some((p) => !planPages(plan).some((candidate) => samePage(candidate, p)))) throw new Error('capturePages must contain exact approved page identities');
  if (previousCaptureResultFiles.length && (!options.capturePages || pages.some((p) => previouslyAttempted.has(p.route)))) throw new Error('Recovery capturePages must be explicit unattempted approved pages');
  if (new Set(pages.map((p) => p.route)).size !== pages.length) throw new Error('Duplicate capturePages');
  if (maxUrls > 0) pages = pages.slice(0, maxUrls);
  if (overallLimit > 0 && previousAttempts + pages.length > overallLimit) throw new Error('Capture request exceeds overall maxUrls budget');
  const identity = (p) => Object.fromEntries(['route', 'itemPath', 'itemId', 'language'].filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  const request = { capturePlanFile, outputDir };
  if (options.mappingInventoryFile || options.mappingInventorySha256) {
    request.mappingInventoryFile = absolutePath(options.mappingInventoryFile, 'mappingInventoryFile');
    if (!/^[a-f0-9]{64}$/.test(options.mappingInventorySha256 ?? '')) throw new Error('mappingInventorySha256 must be a SHA256 digest');
    request.mappingInventorySha256 = options.mappingInventorySha256;
  }
  for (const key of ['layoutServiceUrl', 'graphqlUrl', 'siteName', 'language', 'timeoutMs', 'maxResponseBytes', 'captureResultFile']) if (options[key] !== undefined) request[key] = options[key];
  for (const key of ['layoutServiceUrl', 'graphqlUrl']) if (request[key]) {
    const url = new URL(request[key]);
    if (url.username || url.password || [...url.searchParams.keys()].some((name) => /secret|password|credential|apikey|token|sc_apikey/i.test(name))) throw new Error('Network URLs must not contain credentials');
  }
  if (request.captureResultFile) {
    request.captureResultFile = absolutePath(request.captureResultFile, 'captureResultFile');
    const rel = relative(outputDir, request.captureResultFile);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)) || existsSync(request.captureResultFile)) throw new Error('captureResultFile must be a new file outside outputDir');
  }
  if (options.mode === 'mvc') {
    if (pages.some((p) => !p.itemPath)) throw new Error('MVC routePlan requires source itemPath for every page');
    request.routePlan = pages.map(identity);
    request.selection = 'discovery-plan';
    request.capturePlanFingerprint = plan.fingerprint;
  } else if (options.capturePages) request.capturePages = pages.map(identity);
  if (maxUrls > 0) request.maxUrls = maxUrls;
  request.totalMaxUrls = overallLimit;
  if (previousCaptureResultFiles.length) request.previousCaptureResultFiles = previousCaptureResultFiles.map((p) => absolutePath(p, 'previousCaptureResultFile'));
  return request;
}

export function cliArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--params' || argv[2] !== '--output') throw new Error('Usage: node prepare-capture-request.mjs --params <json-file> --output <new-request-file>');
  return { params: argv[1], output: absolutePath(argv[3], 'output') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = cliArgs(process.argv.slice(2));
    const request = prepareCaptureRequest(JSON.parse(readFileSync(args.params, 'utf8')));
    writeFileSync(args.output, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' });
    console.log(args.output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
