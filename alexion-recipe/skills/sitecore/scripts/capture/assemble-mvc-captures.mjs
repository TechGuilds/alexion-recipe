#!/usr/bin/env node
// Assemble explicitly downloaded, already-extracted license-free MVC captures.
// Never downloads or extracts archives, and never loads Kajoo packages.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalId, planPages, routeFile, samePage, sha256, validateCapturePlan } from './rendering-coverage.mjs';
import { assembleLayoutEnvelope, normalizeUid } from './mvc-layout-envelope.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const object = (value, label) => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
};
function confinedFile(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Raw path escapes rawRoot');
  const real = realpathSync(absolute);
  const realRel = relative(root, real);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel) || !lstatSync(real).isFile()) throw new Error('Raw path must be a regular file within rawRoot');
  return absolute;
}
function noSymlinkAncestors(path) {
  for (let ancestor = resolve(path);; ancestor = dirname(ancestor)) {
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error('Output paths must not contain symbolic links');
    if (dirname(ancestor) === ancestor) break;
  }
}
function assertIdentity(expected, actual) {
  if (!expected.itemId && !expected.itemPath) throw new Error('Requested page has no stable item identity');
  if (expected.itemId && canonicalId(expected.itemId) !== canonicalId(actual.itemId)) throw new Error('Captured item ID mismatch');
  if (expected.itemPath && expected.itemPath !== actual.itemPath) throw new Error('Captured item path mismatch');
  if (expected.language && expected.language !== actual.language) throw new Error('Captured language mismatch');
}

export function assembleMvcCaptures(options) {
  options = { ...options, resultFile: options.resultFile ?? options.captureResultFile };
  for (const key of ['rawRoot', 'capturePlanFile', 'outputDir', 'resultFile']) if (typeof options[key] !== 'string' || !options[key].trim()) throw new Error(`${key} is required`);
  const plan = validateCapturePlan(json(options.capturePlanFile));
  const requested = options.routePlan ?? plan.selectedPages;
  if (!Array.isArray(requested) || !requested.length) throw new Error('A non-empty approved route plan is required');
  const seen = new Set();
  for (const page of requested) {
    const file = routeFile(page.route).toLowerCase();
    if (seen.has(file) || !planPages(plan).some((known) => samePage(known, page))) throw new Error(`Duplicate or unknown requested page: ${page.route}`);
    seen.add(file);
  }
  if (options.maxUrls !== undefined && (!Number.isSafeInteger(options.maxUrls) || options.maxUrls < 0)) throw new Error('maxUrls must be a nonnegative integer (0 means all)');
  const maxUrls = options.maxUrls > 0 ? options.maxUrls : requested.length;
  const previousCaptureResultFiles = options.previousCaptureResultFiles ?? [];
  if (!Array.isArray(previousCaptureResultFiles) || new Set(previousCaptureResultFiles).size !== previousCaptureResultFiles.length) throw new Error('previousCaptureResultFiles must be unique');
  const totalMaxUrls = options.totalMaxUrls ?? options.maxUrls ?? 0;
  if (!Number.isSafeInteger(totalMaxUrls) || totalMaxUrls < 0) throw new Error('totalMaxUrls must be a nonnegative integer');
  let previousAttempts = 0;
  const limits = totalMaxUrls > 0 ? [totalMaxUrls] : [];
  const priorRoutes = new Set();
  for (const file of previousCaptureResultFiles) {
    const prior = json(file);
    if (prior.selection !== 'discovery-plan' || prior.capturePlanFingerprint !== plan.fingerprint || !Array.isArray(prior.outcomes)) throw new Error('Previous capture result does not belong to approved plan');
    for (const ancestor of prior.previousCaptureResultFiles ?? []) if (!previousCaptureResultFiles.includes(ancestor)) throw new Error('Recovery requires every previous capture result manifest');
    if (prior.totalMaxUrls > 0) {
      if (!Number.isSafeInteger(prior.totalMaxUrls)) throw new Error('Invalid inherited totalMaxUrls');
      limits.push(prior.totalMaxUrls);
    }
    for (const outcome of prior.outcomes) {
      const known = planPages(plan).find((p) => p.route === outcome.route);
      if (!known || !['captured', 'failed', 'skipped'].includes(outcome.status)) throw new Error('Unapproved previous capture outcome');
      assertIdentity(known, outcome);
      if (outcome.status !== 'skipped') {
        priorRoutes.add(outcome.route);
        previousAttempts++;
      }
    }
  }
  if (requested.some((p) => priorRoutes.has(p.route))) throw new Error('Recovery requires unattempted approved alternatives');
  const overallLimit = limits.length ? Math.min(...limits) : 0;
  if (overallLimit && previousAttempts + Math.min(maxUrls, requested.length) > overallLimit) throw new Error('Capture request exceeds overall maxUrls budget');
  const manifestFiles = options.manifestFiles ?? (options.manifestFile ? [options.manifestFile] : []);
  if (!Array.isArray(manifestFiles) || !manifestFiles.length) throw new Error('Explicit manifestFile or manifestFiles is required');
  const manifests = manifestFiles.map(json);
  for (const manifest of manifests) {
    if (manifest.selection !== 'discovery-plan' || manifest.capturePlanFingerprint !== plan.fingerprint || !Array.isArray(manifest.routes)) throw new Error('Raw manifest must match the approved capture plan fingerprint');
  }
  const rawRoot = realpathSync(resolve(options.rawRoot));
  const outputDir = resolve(options.outputDir);
  const resultFile = resolve(options.resultFile);
  noSymlinkAncestors(outputDir);
  noSymlinkAncestors(resultFile);
  if (existsSync(outputDir) || existsSync(resultFile)) throw new Error('outputDir and resultFile must be new');
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir);
  // Reserve the result exclusively, including when it lives inside outputDir.
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, '', { flag: 'wx' });
  const outcomes = [];
  const unattemptedRoutes = requested.slice(maxUrls).map((page) => page.route);
  for (let index = 0; index < Math.min(maxUrls, requested.length); index++) {
    const page = requested[index];
    const base = { route: page.route, itemId: page.itemId, itemPath: page.itemPath, language: page.language };
    try {
      const matches = manifests.flatMap((manifest) => manifest.routes.filter((entry) => (entry.route ?? entry.url) === page.route).map((entry) => ({ manifest, entry })));
      if (!matches.length) {
        const sourceOutcome = manifests.flatMap((manifest) => manifest.outcomes ?? []).find((o) => o.route === page.route);
        if (sourceOutcome && ['failed', 'skipped'].includes(sourceOutcome.status)) {
          assertIdentity(page, sourceOutcome);
          if (sourceOutcome.reason === 'maxUrls limit reached') { unattemptedRoutes.push(page.route); continue; }
          outcomes.push({ ...base, status: sourceOutcome.status, reason: sourceOutcome.reason ?? 'Raw capture did not produce a route' });
          continue;
        }
      }
      if (matches.length !== 1) throw new Error(`Expected one raw manifest entry, found ${matches.length}`);
      const { manifest, entry } = matches[0];
      assertIdentity(page, { itemId: entry.itemId, itemPath: entry.itemPath ?? entry.path, language: entry.language ?? manifest.language });
      const folder = routeFile(page.route).replace(/\/index\.json$/, '');
      if (entry.normalized !== folder) throw new Error('Raw manifest route folder mismatch');
      let rawHashesVerified = true;
      const inputs = {};
      for (const name of ['page', 'names', 'fields']) {
        const filename = `${name}.json`;
        const bytes = readFileSync(confinedFile(rawRoot, `${folder}/${filename}`));
        const suppliedHash = entry.files?.[filename]?.sha256 ?? entry.hashes?.[filename];
        if (suppliedHash !== undefined) {
          if (typeof suppliedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(suppliedHash) || sha256(bytes) !== suppliedHash.toLowerCase()) throw new Error(`Raw file hash mismatch: ${filename}`);
        } else rawHashesVerified = false;
        inputs[name] = object(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), filename);
      }
      const snapshot = inputs.page;
      const source = object(snapshot.Page, 'Page');
      assertIdentity(page, { itemId: source.Id, itemPath: source.Path, language: source.Language });
      if (!Array.isArray(snapshot.Renderings)) throw new Error('Renderings must be an array');
      const names = new Map(Object.entries(inputs.names).map(([key, value]) => [normalizeUid(key), value]));
      const fields = Object.fromEntries(Object.entries(inputs.fields).map(([key, value]) => [key, object(value, 'Datasource fields')]));
      const renderings = snapshot.Renderings.map((r) => ({ ...r, RenderingId: r.RenderingId ?? r.ItemID, RenderingName: names.get(normalizeUid(r.RenderingId ?? r.ItemID)) ?? null }));
      if (renderings.some((r) => !canonicalId(r.RenderingId))) throw new Error('Rendering definition identity is missing');
      const layout = assembleLayoutEnvelope({ pageItemId: source.Id, pageItemName: source.Name, pageItemPath: source.Path, pageTemplateId: source.TemplateId, pageTemplateName: source.TemplateName, layoutId: source.LayoutId, layoutFilePath: source.LayoutFilePath, pageFields: object(source.FieldsJson, 'Page fields'), renderings, fieldsByDatasource: fields, siteName: manifest.siteName, language: source.Language });
      const layoutFile = resolve(outputDir, routeFile(page.route));
      mkdirSync(dirname(layoutFile), { recursive: true });
      const bytes = `${JSON.stringify(layout, null, 2)}\n`;
      writeFileSync(layoutFile, bytes, { flag: 'wx' });
      outcomes.push({ ...base, status: 'captured', layoutFile, sha256: sha256(bytes), rawHashesVerified });
    } catch (error) { outcomes.push({ ...base, status: 'failed', reason: error.message }); }
  }
  const result = { selection: 'discovery-plan', capturePlanFingerprint: plan.fingerprint, outputDir, outcomes, successCount: outcomes.filter((o) => o.status === 'captured').length, errorCount: outcomes.filter((o) => o.status === 'failed').length, skippedCount: outcomes.filter((o) => o.status === 'skipped').length, attemptedUrls: outcomes.filter((o) => o.status !== 'skipped').length, totalUrls: requested.length, maxUrls: options.maxUrls ?? null, totalMaxUrls: overallLimit, previousCaptureResultFiles, unattemptedRoutes, rawHashesVerified: outcomes.some((o) => o.status === 'captured') && outcomes.filter((o) => o.status === 'captured').every((o) => o.rawHashesVerified) };
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--params') throw new Error('Usage: node assemble-mvc-captures.mjs --params <json-file>');
    const result = assembleMvcCaptures(json(process.argv[3]));
    console.log(JSON.stringify(result, null, 2));
    // A partial run remains useful reporting evidence; zero captures is a failure.
    if (!result.successCount) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
