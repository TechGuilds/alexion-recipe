import { readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readJSON, readArtifactJSON, scopedPath, hash, jsonBytes, freshDirectory, writeNewJSON, isMain } from './lib/files.mjs';
import { validate as cmsValidate } from '../../cms-migration/scripts/contracts.mjs';

// Decimal MB, deliberately independent of Node/PowerShell's binary MiB shorthand.
export const MAX_MEDIA_PACKAGE_BYTES = 100_000_000;
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
const equal = (a, b) => canonical(a) === canonical(b);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const guid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const text = value => typeof value === 'string' && !!value.trim();
const unique = (rows, key, label) => check(new Set(rows.map(key)).size === rows.length, `Duplicate ${label}`);
function keys(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  check(required.every(key => Object.hasOwn(value, key)), 'Missing required media properties: ' + required.filter(key => !Object.hasOwn(value, key)).join(', '));
  check(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unexpected media property');
}
export function mediaPath(path) {
  check(typeof path === 'string' && /^\/sitecore\/media library(?:\/[^\\:*?\[\]\u0000-\u001f]+)*$/.test(path) && !path.endsWith('/') && !path.includes('//') && !path.split('/').some(part => part === '.' || part === '..'), 'Expected an absolute Media Library path');
  return path;
}
function tuple(value) {
  keys(value, ['instanceId', 'connectorId', 'database', 'rootPath', 'deployment', 'marker']);
  check(text(value.instanceId) && text(value.connectorId) && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value.database), 'Invalid media platform identity');
  check(value.database.toLowerCase() === 'master', 'Media migration requires the master authoring database');
  check(value.rootPath === '/sitecore/media library', 'Media root must be /sitecore/media library');
  check(['XP', 'XM'].includes(value.deployment), 'The .update media adapter supports verified XP/XM targets only; SitecoreAI needs a different adapter');
  keys(value.marker, ['id', 'path', 'templateId']);
  check(guid(value.marker.id) && guid(value.marker.templateId) && /^\/sitecore(?:\/[^\\\u0000-\u001f]+)+$/.test(value.marker.path), 'Invalid platform marker');
}
function scope(value) {
  keys(value, ['kind', 'version', 'scopeId', 'source', 'target', 'selectors', 'maxPackageBytes']);
  check(value.kind === 'media-scope' && value.version === 1 && text(value.scopeId), 'Invalid media scope');
  tuple(value.source); tuple(value.target);
  check(value.maxPackageBytes === MAX_MEDIA_PACKAGE_BYTES, 'The approved package limit is 100 MB (100000000 bytes)');
  check(Array.isArray(value.selectors) && value.selectors.length > 0 && value.selectors.length <= 100, 'Select 1..100 approved Media Library paths');
  for (const row of value.selectors) { keys(row, ['path', 'includeDescendants']); mediaPath(row.path); check(typeof row.includeDescendants === 'boolean', 'Explicit descendant selection required'); }
  unique(value.selectors, row => row.path.toLowerCase(), 'media scope path');
}
function fresh(value, label, at = Date.now()) {
  const start = Date.parse(value.capturedAt ?? value.verifiedAt), end = Date.parse(value.expiresAt);
  check(Number.isFinite(at) && at <= Date.now() && Number.isFinite(start) && Number.isFinite(end) && start <= at && end > at && end > start, `Missing, expired or future ${label}`);
}
export function validateMediaItems(items) {
  check(Array.isArray(items) && items.length <= 5000, 'Media inventory must be bounded to 5000 items per attempt');
  unique(items, item => item.id, 'media ID'); unique(items, item => item.path.toLowerCase(), 'media path');
  for (const item of items) {
    keys(item, ['id', 'path', 'templateId', 'parentId', 'isFolder', 'fields', 'blobs']);
    check(guid(item.id) && guid(item.templateId) && guid(item.parentId) && typeof item.isFolder === 'boolean', 'Invalid media item identity');
    mediaPath(item.path); check(item.path !== '/sitecore/media library', 'Do not package the built-in Media Library root');
    check(Array.isArray(item.fields) && Array.isArray(item.blobs), 'Explicit fields and binaries required');
    unique(item.fields, field => `${field.id}/${field.language}/${field.version}`, 'field context');
    unique(item.blobs, blob => `${blob.language}/${blob.version}`, 'binary context');
    for (const field of item.fields) {
      keys(field, ['id', 'language', 'version', 'value']);
      check(guid(field.id) && typeof field.language === 'string' && Number.isInteger(field.version) && field.version >= 0 && typeof field.value === 'string', 'Invalid raw metadata field');
    }
    for (const blob of item.blobs) {
      keys(blob, ['language', 'version', 'bytes', 'sha256']);
      check(text(blob.language) && Number.isInteger(blob.version) && blob.version >= 1 && Number.isSafeInteger(blob.bytes) && blob.bytes >= 0 && sha(blob.sha256), 'Invalid original binary observation');
    }
    check(item.isFolder ? item.blobs.length === 0 : item.blobs.length > 0, 'Media assets require original binary observations; folders cannot carry binaries');
  }
  return items;
}
export function compareMedia(expected, observed) {
  validateMediaItems(expected); validateMediaItems(observed);
  return expected.map(item => {
    const byId = observed.find(row => row.id === item.id), byPath = observed.find(row => row.path.toLowerCase() === item.path.toLowerCase());
    if ((byPath && byPath.id !== item.id) || (byId && (byId.path !== item.path || byId.templateId !== item.templateId))) return { id: item.id, action: 'conflict' };
    return { id: item.id, action: !byId ? 'create' : equal(item, byId) ? 'reuse' : 'update' };
  });
}
// Planning estimate only; the SPE builder enforces the actual archive byte limit.
export function groupMediaItems(items, limit = MAX_MEDIA_PACKAGE_BYTES) {
  validateMediaItems(items);
  check(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_MEDIA_PACKAGE_BYTES, 'Invalid package grouping limit');
  const groups = []; let group = [], size = 0;
  for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
    const estimate = Buffer.byteLength(jsonBytes(item)) + item.blobs.reduce((sum, blob) => sum + blob.bytes, 0);
    // A large source binary may compress; the actual one-item package decides readiness.
    if (group.length && size + estimate > limit) { groups.push(group); group = []; size = 0; }
    group.push(item.id); size += estimate;
  }
  if (group.length) groups.push(group);
  return groups;
}
async function decision(base, ref, scopeId, kind, choice, required, taskId) {
  const record = (await readArtifactJSON(base, ref)).value;
  await cmsValidate('decision', record);
  check(record.scopeId === scopeId && record.kind === kind && record.choice === choice && text(record.userResponse) && Number.isFinite(Date.parse(record.at)) && Date.parse(record.at) <= Date.now(), 'An explicit current human media decision is required');
  if (taskId) check(record.taskId === taskId, 'Media decision belongs to another task');
  check(record.inputs.some(input => input.path === required.path && input.sha256 === required.sha256), 'Media decision does not bind the exact reviewed artifact');
  unique(record.inputs, row => row.path, 'decision input');
  for (const input of record.inputs) await readArtifactJSON(base, input);
  return record;
}
function inventory(value, target, scopeId, expectedRequest, allowMissing = false) {
  check(value.kind === 'media-inventory' && value.version === 1 && value.scopeId === scopeId && value.complete === true && equal(value.target, target), 'Incomplete or mismatched media inventory');
  check(sha(value.requestSha256) && text(value.requestId), 'Media capture provenance is missing');
  if (expectedRequest) check(value.requestSha256 === expectedRequest.sha256 && value.requestId === expectedRequest.value.requestId, 'Media capture does not match the exact read request');
  validateMediaItems(value.items);
  check(Array.isArray(value.missingIds) && Array.isArray(value.collisions) && Array.isArray(value.unresolvedOperations), 'Explicit observation gaps and unresolved operation history required');
  check(value.unresolvedOperations.length === 0, 'Unresolved media installation requires reconciliation before readiness');
  if (!allowMissing) check(!(value.missingIds?.length) && !(value.collisions?.length) && value.items.length > 0, 'Source media capture contains gaps or conflicts');
}
async function requestEnvelope(action, input, target, extra) {
  const script = await readFile(new URL('./media-package.ps1', import.meta.url), 'utf8');
  const request = { kind: 'media-request', version: 1, scopeId: input.scopeId, taskId: input.taskId, attemptId: input.attemptId, action, target, capabilities: input.capabilities, ...extra };
  request.requestId = 'media-' + hash(canonical(request)).slice(0, 24);
  const requestJson = jsonBytes(request), requestSha256 = hash(requestJson);
  check(Buffer.byteLength(requestJson) <= 8 * 1024 * 1024, 'Media connector request exceeds 8 MiB; use a smaller approved media scope');
  return { value: request, sha256: requestSha256, envelope: { version: 1, role: ['capture', 'package'].includes(action) ? 'source' : 'target', connectorId: target.connectorId, script, scriptSha256: hash(script), parameters: { RequestJson: requestJson, RequestSha256: requestSha256 } } };
}
async function binaryFile(base, descriptor, expected) {
  check(descriptor && sha(descriptor.sha256), 'Missing package file descriptor');
  const path = await scopedPath(base, descriptor.path), stat = await lstat(path);
  check(stat.size > 0 && stat.size <= MAX_MEDIA_PACKAGE_BYTES && stat.size === expected.bytes && descriptor.sha256 === expected.sha256, 'Package exceeds 100 MB or differs from the manifest size/hash');
  const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk);
  check(digest.digest('hex') === expected.sha256, 'Downloaded package bytes differ from the manifest');
  return path;
}
async function approvedScope(input, base, historical) {
  keys(input, ['version', 'action', 'scopeId', 'taskId', 'attemptId', 'scopeArtifact', 'mediaDecision', 'scopeDecision', 'capabilities'], ['sourceInventory', 'sourceCaptureRequest', 'packageManifest', 'packageFiles', 'targetInventory', 'inspectionRequest', 'packageTransports', 'packageId', 'review', 'approval', 'verificationInventory', 'verificationRequest', 'receipts']);
  check(input.version === 1 && ['capture', 'prepare', 'install', 'verify'].includes(input.action) && text(input.scopeId) && text(input.taskId), 'Invalid media operation input');
  check(input.scopeId.length <= 256 && !/[\u0000-\u001f]/.test(input.scopeId) && /^[a-zA-Z0-9_-]{1,100}$/.test(input.attemptId), 'Explicit bounded media scope and attempt identity required');
  const selected = (await readArtifactJSON(base, input.scopeArtifact)).value; scope(selected);
  check(selected.scopeId === input.scopeId, 'Media scope differs from the task');
  await decision(base, input.mediaDecision, input.scopeId, 'scope', 'migrate-media', input.scopeArtifact);
  await decision(base, input.scopeDecision, input.scopeId, 'scope', 'approve', input.scopeArtifact, 'content.media-prepare');
  check(input.capabilities && input.capabilities.speRead === true && input.capabilities.fileTransfer === true && input.capabilities.stableReadWindow === true, 'Verified read, stable-window and file-transfer capabilities required');
  fresh(input.capabilities, 'media capabilities', historical ? Date.parse(input.capabilities.verifiedAt) : Date.now());
  return selected;
}
async function sourceEvidence(input, base, selected) {
  check(input.sourceInventory && input.sourceCaptureRequest, 'Source inventory and exact capture request are required');
  const original = await readArtifactJSON(base, input.sourceInventory), capture = await readArtifactJSON(base, input.sourceCaptureRequest);
  inventory(original.value, selected.source, input.scopeId, capture);
  check(capture.value.action === 'capture' && equal(capture.value.selectors, selected.selectors) && equal(original.value.selectors, selected.selectors), 'Source capture scope differs from the approved paths');
  check(equal(capture.value.target, selected.source) && capture.value.scopeId === input.scopeId, 'Source request identity differs');
  for (const item of original.value.items) check(selected.selectors.some(selector =>
    item.path === selector.path || (selector.includeDescendants && item.path.startsWith(selector.path + '/')) ||
    (item.isFolder && selector.path.startsWith(item.path + '/'))), 'Source inventory includes media outside the approved scope and required ancestors');
  return original;
}
async function manifestEvidence(input, base, selected, original) {
  check(input.packageManifest, 'A source package manifest is required');
  const artifact = await readArtifactJSON(base, input.packageManifest), manifest = artifact.value;
  check(manifest.kind === 'media-package-manifest' && manifest.version === 1 && manifest.scopeId === input.scopeId && equal(manifest.source, selected.source) && manifest.sourceInventorySha256 === original.sha256 && manifest.maxPackageBytes === MAX_MEDIA_PACKAGE_BYTES, 'Package manifest differs from approved source evidence');
  check(equal(manifest.items, original.value.items), 'Package manifest does not preserve the exact media inventory');
  check(Array.isArray(manifest.packages) && manifest.packages.length > 0, 'No complete media packages were produced');
  unique(manifest.packages, row => row.id, 'package ID'); unique(manifest.packages, row => row.order, 'package order');
  const ids = [];
  for (const p of manifest.packages) {
    check(text(p.id) && text(p.path) && p.path.endsWith('.update') && !/[\\/]/.test(p.path) && Number.isSafeInteger(p.bytes) && p.bytes > 0 && p.bytes <= MAX_MEDIA_PACKAGE_BYTES && sha(p.sha256) && Number.isInteger(p.order) && p.order >= 1 && Array.isArray(p.itemIds) && p.itemIds.length > 0, 'Invalid or oversized media package');
    ids.push(...p.itemIds);
  }
  unique(ids, id => id, 'packaged media item');
  check(equal([...ids].sort(), original.value.items.map(item => item.id).sort()), 'Package membership is incomplete or includes unapproved media');
  check(equal(manifest.packages.map(p => p.order).sort((a,b) => a-b), manifest.packages.map((_,i) => i+1)), 'Package order must be contiguous');
  const owner = new Map(manifest.packages.flatMap(p => p.itemIds.map(id => [id, p.order])));
  for (const item of manifest.items) if (owner.has(item.parentId)) check(owner.get(item.parentId) <= owner.get(item.id), 'Media packages violate parent dependency order');
  check(Array.isArray(input.packageFiles) && input.packageFiles.length === manifest.packages.length, 'Download every source package before installation');
  unique(input.packageFiles, row => row.packageId, 'downloaded package');
  for (const p of manifest.packages) await binaryFile(base, input.packageFiles.find(row => row.packageId === p.id), p);
  return artifact;
}
function transferred(input, manifest) {
  check(Array.isArray(input.packageTransports) && input.packageTransports.length === manifest.packages.length, 'Verified target package transfer descriptors required');
  unique(input.packageTransports, row => row.id, 'transferred package');
  return manifest.packages.map(p => {
    const transferred = input.packageTransports.find(row => row.id === p.id);
    check(transferred && transferred.sha256 === p.sha256 && transferred.bytes === p.bytes && equal(transferred.itemIds, p.itemIds) && transferred.order === p.order && text(transferred.serverPath), 'Target package transport differs from the source manifest');
    return { ...p, serverPath: transferred.serverPath };
  });
}

/** Local planning only. Remote source/target operations run through the selected connector. */
export async function runMedia(input, { base, historical = false }) {
  const selected = await approvedScope(input, base, historical);
  const report = { version: 1, scopeId: input.scopeId, taskId: input.taskId, ready: false, targetWrites: false, workflowAdvanced: false, maxPackageBytes: MAX_MEDIA_PACKAGE_BYTES, issues: [] };
  const result = { report };
  if (input.action === 'capture') {
    check(input.taskId === 'content.media-prepare', 'Source capture belongs to media preparation');
    result.request = await requestEnvelope('capture', input, selected.source, { selectors: selected.selectors, maxItems: 5000 });
    return result;
  }
  const original = await sourceEvidence(input, base, selected);
  if (input.action === 'prepare') {
    check(input.taskId === 'content.media-prepare', 'Preparation belongs to content.media-prepare');
    if (!historical) fresh(original.value, 'source media inventory');
    result.plan = { version: 1, scopeId: input.scopeId, source: selected.source, target: selected.target, sourceInventorySha256: original.sha256, maxPackageBytes: MAX_MEDIA_PACKAGE_BYTES, groups: groupMediaItems(original.value.items), selectors: selected.selectors, itemIds: original.value.items.map(item => item.id), actualSizeCheckRequired: true };
    result.request = await requestEnvelope('package', input, selected.source, { source: selected.source, inventory: original.value, inventoryJson: await readFile(original.path, 'utf8'), items: original.value.items, selectors: selected.selectors, sourceInventorySha256: original.sha256, maxPackageBytes: MAX_MEDIA_PACKAGE_BYTES });
    if (!input.packageManifest) return result;
    const manifest = await manifestEvidence(input, base, selected, original);
    check(manifest.value.requestSha256 === result.request.sha256, 'Media package manifest does not match the exact source export request');
    fresh(original.value, 'source media inventory at package creation', Date.parse(manifest.value.completedAt));
    fresh(input.capabilities, 'source capabilities at package creation', Date.parse(manifest.value.completedAt));
    report.ready = true; report.mediaManifestSha256 = manifest.sha256; report.sourceInventorySha256 = original.sha256; report.packageCount = manifest.value.packages.length;
    return result;
  }
  check(input.taskId === 'content.media-install', 'Target media work belongs to content.media-install');
  const manifest = await manifestEvidence(input, base, selected, original), packages = transferred(input, manifest.value);
  const extra = { items: original.value.items, packages, sourceInventorySha256: original.sha256,
    manifestJson: await readFile(manifest.path, 'utf8'), manifestSha256: manifest.sha256 };
  result.request = await requestEnvelope(input.action === 'verify' ? 'verify' : 'inspect', input, selected.target, extra);
  if (input.action === 'verify') {
    if (!input.verificationInventory) return result;
    const readRequest = await readArtifactJSON(base, input.verificationRequest), observed = await readArtifactJSON(base, input.verificationInventory);
    check(readRequest.sha256 === result.request.sha256, 'Verification request differs from this canonical media scope');
    inventory(observed.value, selected.target, input.scopeId, readRequest, true);
    fresh(observed.value, 'independent target media capture', historical ? Date.parse(observed.value.capturedAt) : Date.now());
    fresh(input.capabilities, 'target capabilities at verification', Date.parse(observed.value.capturedAt));
    check(input.targetInventory && input.inspectionRequest, 'Retain the original target inspection to distinguish reuse from installation');
    const baseline = await readArtifactJSON(base, input.targetInventory), baselineRequest = await readArtifactJSON(base, input.inspectionRequest);
    inventory(baseline.value, selected.target, input.scopeId, baselineRequest, true);
    check(baselineRequest.value.action === 'inspect' && equal(baselineRequest.value.items, original.value.items) &&
      baselineRequest.value.manifestSha256 === manifest.sha256 && baselineRequest.value.sourceInventorySha256 === original.sha256,
    'Initial target inspection differs from the verified media manifest');
    const initialActions = compareMedia(original.value.items, baseline.value.items);
    check(Number.isFinite(Date.parse(manifest.value.completedAt)) && Date.parse(manifest.value.completedAt) <= Date.parse(baseline.value.capturedAt) &&
      Date.parse(baseline.value.capturedAt) <= Date.parse(observed.value.capturedAt), 'Media verification must follow package completion and the original target inspection');
    check(!initialActions.some(row => row.action === 'conflict') && !baseline.value.collisions?.length, 'Initial media conflicts remain unresolved');
    const receiptIds = new Set();
    for (const entry of input.receipts ?? []) {
      keys(entry, ['request', 'receipt']);
      const submitted = await readArtifactJSON(base, entry.request), receipt = (await readArtifactJSON(base, entry.receipt)).value;
      const request = submitted.value;
      check(request.action === 'install' && request.scopeId === input.scopeId && request.taskId === input.taskId && equal(request.target, selected.target) &&
        request.manifestSha256 === manifest.sha256 && request.sourceInventorySha256 === original.sha256 && sha(request.reviewSha256), 'Installation receipt request differs from this media migration');
      check(hash(request.reviewJson) === request.reviewSha256, 'Submitted media review integrity failure');
      const review = JSON.parse(request.reviewJson), p = packages.find(p => p.id === review.package?.id);
      check(p && review.package.sha256 === p.sha256 && review.package.bytes === p.bytes && equal(review.package.itemIds, p.itemIds) &&
        review.manifestSha256 === manifest.sha256 && review.sourceInventorySha256 === original.sha256 && equal(review.target, selected.target), 'Submitted media package review differs');
      await cmsValidate('decision', request.approval);
      check(request.approval.kind === 'mutation' && request.approval.choice === 'approve' && request.approval.scopeId === input.scopeId &&
        request.approval.taskId === input.taskId && text(request.approval.userResponse) && Number.isFinite(Date.parse(request.approval.at)) &&
        Date.parse(request.approval.at) <= Date.parse(receipt.completedAt) && request.approval.inputs.some(ref => ref.sha256 === request.reviewSha256), 'Submitted media installation lacks bound human approval');
      check(receipt.kind === 'media-install-receipt' && receipt.scopeId === input.scopeId && equal(receipt.target, selected.target) &&
        receipt.status === 'successful' && receipt.requestId === request.requestId && receipt.requestSha256 === submitted.sha256 &&
        receipt.reviewSha256 === request.reviewSha256 && receipt.manifestSha256 === manifest.sha256 &&
        receipt.sourceInventorySha256 === original.sha256 && receipt.operationId === review.operationId && receipt.packageId === p.id &&
        receipt.packageSha256 === p.sha256 && Number.isFinite(Date.parse(receipt.completedAt)) &&
        Date.parse(baseline.value.capturedAt) <= Date.parse(receipt.completedAt) && Date.parse(receipt.completedAt) <= Date.parse(observed.value.capturedAt), 'Missing, uncertain, stale or mismatched media installation receipt');
      check(!receiptIds.has(p.id), 'Duplicate media package receipt'); receiptIds.add(p.id);
    }
    for (const p of packages) if (initialActions.some(row => p.itemIds.includes(row.id) && row.action !== 'reuse'))
      check(receiptIds.has(p.id), 'Every package changing the initial target requires its successful approved installation receipt');
    const changes = compareMedia(original.value.items, observed.value.items);
    check(!(observed.value.missingIds?.length) && !(observed.value.collisions?.length), 'Independent media verification contains missing items or collisions');
    check(observed.value.sourceInventorySha256 === original.sha256, 'Target capture belongs to another media source');
    report.items = changes; report.ready = changes.every(item => item.action === 'reuse');
    report.mediaParity = report.ready; report.sourceInventorySha256 = original.sha256; report.mediaManifestSha256 = manifest.sha256;
    report.target = selected.target; report.verificationInventorySha256 = observed.sha256;
    report.identities = report.ready ? original.value.items.map(item => ({ sourceItemId: item.id, targetItemId: item.id, path: item.path, templateId: item.templateId })) : [];
    report.limitations = ['Authoring-database media parity only; publishing and public delivery are not performed.'];
    return result;
  }
  if (!input.targetInventory) return result;
  const readRequest = await readArtifactJSON(base, input.inspectionRequest), current = await readArtifactJSON(base, input.targetInventory);
  check(readRequest.sha256 === result.request.sha256, 'Target inspection request differs from the current media scope');
  inventory(current.value, selected.target, input.scopeId, readRequest, true); fresh(current.value, 'target media inspection');
  check(current.value.sourceInventorySha256 === original.sha256, 'Target inspection source differs');
  const actions = compareMedia(original.value.items, current.value.items);
  check(!actions.some(row => row.action === 'conflict') && !(current.value.collisions?.length), 'Target media ID/path/template collision; resolve before installation');
  result.plan = { version: 1, scopeId: input.scopeId, taskId: input.taskId, target: selected.target, sourceInventorySha256: original.sha256, mediaManifestSha256: manifest.sha256, targetInventorySha256: current.sha256, actions, packages };
  report.issues.push('Installation is not completion; collect independent target media verification after all packages.');
  if (!input.packageId) return result;
  const p = packages.find(p => p.id === input.packageId); check(p, 'Selected package is absent');
  if (p.itemIds.every(id => actions.find(row => row.id === id)?.action === 'reuse')) {
    report.issues.push('Selected package already matches the target; no installation request is emitted. Complete independent verification.');
    delete result.request; return result;
  }
  const earlier = new Set(packages.filter(row => row.order < p.order).flatMap(row => row.itemIds));
  check(actions.filter(row => earlier.has(row.id)).every(row => row.action === 'reuse'), 'Earlier media packages are not independently present and identical');
  const ids = new Set(p.itemIds), planSha256 = hash(jsonBytes(result.plan));
  result.review = { version: 1, scopeId: input.scopeId, taskId: input.taskId, target: selected.target, sourceInventorySha256: original.sha256, manifestSha256: manifest.sha256, planSha256, package: p, items: original.value.items.filter(item => ids.has(item.id)), currentItems: current.value.items.filter(item => ids.has(item.id)), missingIds: p.itemIds.filter(id => !current.value.items.some(item => item.id === id)), collisions: [], operationId: 'media-install-' + hash(canonical({ scope: input.scopeId, package: p.sha256, before: current.sha256 })).slice(0,24) };
  if (!input.review || !input.approval) { delete result.request; return result; }
  const review = await readArtifactJSON(base, input.review); check(equal(review.value, result.review), 'Media installation review is stale or differs from the exact plan');
  const approval = await decision(base, input.approval, input.scopeId, 'mutation', 'approve', input.review, input.taskId);
  result.request = await requestEnvelope('install', input, selected.target, { ...extra, reviewJson: await readFile(review.path, 'utf8'), reviewSha256: review.sha256, approval });
  return result;
}

export async function mediaMigration(inputPath, outputPath) {
  const initial = await readJSON(inputPath), result = await runMedia(initial.value, { base: dirname(inputPath) });
  check((await readJSON(inputPath)).sha256 === initial.sha256, 'Media input changed during planning');
  result.report.inputSha256 = initial.sha256;
  const output = await freshDirectory(outputPath);
  const name = initial.value.action === 'verify' ? 'media-verification-report.json' : 'media-preparation-report.json';
  await writeNewJSON(join(output, name), result.report);
  if (result.plan) await writeNewJSON(join(output, 'media-plan.json'), result.plan);
  if (result.review) await writeNewJSON(join(output, 'media-installation-review.json'), result.review);
  if (result.request) { await writeNewJSON(join(output, 'media-request.json'), result.request.value); await writeNewJSON(join(output, 'media-connector-request.json'), result.request.envelope); }
  return result.report;
}

/** Reconstruct readiness from immutable inputs; never trust a worker-authored success flag. */
export async function validateMediaOutcome(operation, roles, outputs, packet) {
  const role = operation === 'media-prepare' ? 'mediaPreparationInput' : 'mediaInstallationInput', input = roles[role];
  check(input && input.value.scopeId === packet.scopeId && input.value.taskId === packet.task.id, 'Media outcome scope/task mismatch');
  check(input.value.action === (operation === 'media-prepare' ? 'prepare' : 'verify'), 'Media outcome requires package preparation or independent target verification');
  const replay = await runMedia(input.value, { base: dirname(input.path), historical: true });
  check(replay.report.ready, 'Media operation is not ready');
  replay.report.inputSha256 = input.sha256;
  const reportRole = operation === 'media-prepare' ? 'mediaPreparationReport' : 'mediaVerificationReport';
  check(equal(outputs.find(row => row.role === reportRole)?.value, replay.report), 'Media report differs from canonical replay');
  if (operation === 'media-prepare') check(outputs.find(row => row.role === 'mediaManifest')?.sha256 === replay.report.mediaManifestSha256, 'Media manifest output differs from the verified package manifest');
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    check(args.length === 4 && args[0] === '--input' && args[2] === '--output', 'Use --input request.json --output NEW_DIRECTORY');
    const report = await mediaMigration(args[1], args[3]); console.log(JSON.stringify(report)); process.exitCode = report.ready ? 0 : 2;
  } catch (error) { console.log(JSON.stringify({ ready: false, error: error.message })); process.exitCode = 1; }
}
