import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildPreview } from './prepare-presentation-preview.mjs';
import {
  decisionInputs,
  requireSchema,
  readJSON,
  readArtifactJSON,
  equal,
  id,
  hash,
  publish,
  cli,
  isMain,
  recheck,
} from './lib/common.mjs';
import { scopedPath } from '../../cms-migration/scripts/lib/files.mjs';

export async function verifyPreview(inputPath) {
  const staged = await readJSON(inputPath),
    input = requireSchema('reviewInput', staged.value),
    base = dirname(inputPath);
  const previewInput = await readArtifactJSON(base, input.previewInput),
    saved = await readArtifactJSON(base, input.previewManifest);
  const rebuilt = await buildPreview(previewInput.path),
    manifest = rebuilt.manifest;
  if (!manifest.ready || !equal(saved.value, manifest) || manifest.scopeId !== input.scopeId)
    throw Error('Preview is incomplete or differs from current canonical inputs');
  const refs = [
    ...rebuilt.refs,
    { path: inputPath, sha256: staged.sha256 },
    { path: saved.path, sha256: saved.sha256 },
  ];
  for (const file of manifest.files) {
    const path = await scopedPath(dirname(saved.path), file.path);
    const bytes = await readFile(path);
    if (hash(bytes) !== file.sha256 || !bytes.equals(rebuilt.files.get(file.path)))
      throw Error('Preview files differ from the reviewed stage');
    refs.push({ path, sha256: file.sha256 });
  }
  const evidence = new Map(),
    decisions = new Map(),
    issues = [];
  for (const ref of input.browserEvidence) {
    const artifact = await readArtifactJSON(base, ref),
      row = requireSchema('browserEvidence', artifact.value);
    if (
      row.scopeId !== input.scopeId ||
      row.previewManifestSha256 !== saved.sha256 ||
      row.status !== 'rendered' ||
      !Array.isArray(row.checks) ||
      !row.checks.length ||
      row.checks.some((c) => c.passed !== true) ||
      !Array.isArray(row.errors) ||
      row.errors.length ||
      !manifest.pages.some((p) => id(p.pageId) === id(row.pageId) && p.route === row.route)
    )
      throw Error('Browser evidence does not prove a successful render of this preview');
    if (evidence.has(id(row.pageId))) throw Error('Repeated browser page evidence');
    const imagePath = await scopedPath(dirname(artifact.path), row.screenshot?.path),
      bytes = await readFile(imagePath);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      jpeg = bytes[0] === 255 && bytes[1] === 216;
    if ((!png && !jpeg) || bytes.length > 8 * 1024 * 1024 || hash(bytes) !== row.screenshot.sha256)
      throw Error('Invalid or stale browser screenshot evidence');
    refs.push(
      { path: artifact.path, sha256: ref.sha256 },
      { path: imagePath, sha256: row.screenshot.sha256 },
    );
    evidence.set(id(row.pageId), { row, ref });
  }
  for (const ref of input.decisions) {
    const artifact = await readArtifactJSON(base, ref),
      decision = artifact.value,
      key = id(decision.entityId);
    refs.push(...(await decisionInputs(decision, base)));
    if (
      decision.taskId !== input.taskId ||
      decision.kind !== 'verification' ||
      decision.scopeId !== input.scopeId ||
      !decision.userResponse?.trim() ||
      !['verified', 'not-verified', 'pause'].includes(decision.choice) ||
      !Number.isFinite(Date.parse(decision.at)) ||
      Date.parse(decision.at) > Date.now() ||
      !evidence.has(key) ||
      !Array.isArray(decision.inputs) ||
      ![input.previewManifest, evidence.get(key).ref].every((wanted) =>
        decision.inputs.some((row) => equal(row, wanted)),
      )
    )
      throw Error('Human verification must bind the current preview and actual browser evidence');
    if (decisions.has(key)) throw Error('Repeated human page decision');
    decisions.set(key, decision);
    refs.push({ path: artifact.path, sha256: ref.sha256 });
    if (decision.choice !== 'verified')
      issues.push({ code: 'human-review', pageId: decision.entityId, choice: decision.choice });
  }
  const reviewed = manifest.pages.filter((p) => decisions.get(id(p.pageId))?.choice === 'verified'),
    covered = new Set(reviewed.flatMap((p) => p.coverage));
  if (reviewed.length < manifest.minimumPages)
    issues.push({ code: 'minimum-reviewed-pages', required: manifest.minimumPages, actual: reviewed.length });
  const missing = manifest.requiredCoverage.filter((key) => !covered.has(key));
  if (missing.length) issues.push({ code: 'unreviewed-coverage', keys: missing });
  await recheck(refs);
  return {
    report: {
      version: 1,
      scopeId: input.scopeId,
      ready: issues.length === 0,
      reviewedPageIds: reviewed.map((p) => p.pageId),
      covered: [...covered].sort(),
      missing,
      issues,
      previewManifestSha256: saved.sha256,
      targetWrites: false,
      workflowAdvanced: false,
      applyAuthorized: false,
    },
    refs,
  };
}
export async function reviewPresentationPreview(inputPath, outputPath) {
  const { report, refs } = await verifyPreview(inputPath);
  await publish(outputPath, { 'preview-review.json': report }, refs);
  return report;
}
if (isMain(import.meta.url)) await cli(reviewPresentationPreview);
