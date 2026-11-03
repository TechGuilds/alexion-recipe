import { dirname, join } from 'node:path';
import { requireSchema } from './lib/schema.mjs';
import {
  readJSON,
  readArtifactJSON,
  scopedPath,
  normalizeId,
  fail,
  hash,
  jsonBytes,
  MAX_JSON_BYTES,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
} from './lib/files.mjs';
import { validateInputFile, validateDocuments } from './validate-inputs.mjs';
import { validateSnapshotFile } from './validate-snapshot.mjs';
import { openSnapshot, snapshotIndex, fieldKey } from './lib/snapshot.mjs';
import { identityKey, inside } from './lib/transform-paths.mjs';
import { canonical } from './lib/target-state.mjs';
import { planChanges } from './lib/dry-run.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const bounded = (value) => {
  if (Buffer.byteLength(jsonBytes(value)) > MAX_JSON_BYTES)
    throw fail('output-size', 'dry-run', 'Generated JSON exceeds 16 MiB; request a smaller approved scope');
  return value;
};

export async function planContent(inputPath, outputPath) {
  const request = await readJSON(inputPath);
  requireSchema('planInput', request.value);
  const artifacts = {},
    base = dirname(inputPath);
  for (const name of ['transformInput', 'itemPlan', 'identityMap', 'transformReport', 'targetState'])
    artifacts[name] = await readArtifactJSON(base, request.value[name]);
  const transform = artifacts.transformInput;
  requireSchema('transformInput', transform.value);
  const migration = await readArtifactJSON(dirname(transform.path), transform.value.migrationInput),
    binding = migration.value;
  if (!(await validateInputFile(migration.path)).valid)
    throw fail('input-validation', 'migrationInput', 'Original transformation inputs no longer validate');
  if (binding.itemPlan)
    throw fail('input-plan', 'migrationInput', 'Use the original transformation manifest');
  const documents = {};
  for (const name of ['mapping', 'targetInventory', 'destinationPlan'])
    documents[name] = (await readArtifactJSON(dirname(migration.path), binding[name])).value;
  const snapshotPath = await scopedPath(dirname(migration.path), binding.sourceSnapshot.path),
    snapshot = await openSnapshot(snapshotPath);
  const coverage = await readArtifactJSON(dirname(transform.path), transform.value.snapshotValidation);
  requireSchema('validateSnapshotInput', coverage.value);
  if (
    snapshot.sha256 !== binding.sourceSnapshot.sha256 ||
    coverage.value.snapshot.sha256 !== snapshot.sha256 ||
    (await scopedPath(dirname(coverage.path), coverage.value.snapshot.path)) !== snapshotPath ||
    !(await validateSnapshotFile(snapshotPath, coverage.value.scope)).ready
  )
    throw fail('coverage', 'sourceSnapshot', 'Prepared source coverage or binding is incomplete');
  const plan = artifacts.itemPlan.value,
    identities = artifacts.identityMap.value,
    report = artifacts.transformReport.value,
    evidence = artifacts.targetState.value;
  requireSchema('itemPlan', plan);
  requireSchema('identityMap', identities);
  requireSchema('targetState', evidence);
  if (
    report.version !== 1 ||
    report.ready !== true ||
    report.proposedIdentitiesOnly !== true ||
    report.scopeId !== binding.scopeId ||
    report.transformRequestSha256 !== transform.sha256 ||
    report.migrationInputSha256 !== migration.sha256 ||
    report.snapshotValidationSha256 !== coverage.sha256 ||
    report.itemPlanSha256 !== artifacts.itemPlan.sha256 ||
    report.identityMapSha256 !== artifacts.identityMap.sha256
  )
    throw fail(
      'transform-binding',
      'transformReport',
      'Require a ready transformation report bound to the exact request, plan and proposed identities; regenerate older reports',
    );
  if (
    !Array.isArray(report.issues) ||
    !Array.isArray(report.referenceDependencies) ||
    !Array.isArray(report.exclusions) ||
    !Array.isArray(report.deferredParameters) ||
    report.issues.some((i) => i.severity === 'error') ||
    canonical(report.issues) !== canonical(plan.issues) ||
    plan.items.some((i) => ['conflict', 'exclude'].includes(i.action))
  )
    throw fail('transform-conflict', 'itemPlan', 'Transformation has conflicts or incomplete reporting');
  const index = await snapshotIndex(snapshot);
  const validation = validateDocuments(
    {
      ...documents,
      sourceSnapshot: { ...snapshot.header, items: [], renderingInstances: [] },
      itemPlan: plan,
      identityMap: identities,
    },
    binding,
    index,
  );
  if (!validation.valid) throw fail('plan-validation', 'itemPlan', JSON.stringify(validation.errors));
  if (plan.items.some((i) => !i.versions?.length || !i.parentPath))
    throw fail('plan-format', 'itemPlan', 'Regenerate the plan with explicit versions and parents');
  if (
    identities.entries.length !== plan.items.length ||
    plan.items.some((i) => !identities.entries.some((e) => canonical(e) === canonical(i.identity)))
  )
    throw fail('identity-binding', 'identityMap', 'Proposed identities do not exactly cover plan outputs');
  const target = documents.targetInventory,
    destination = documents.destinationPlan;
  if (
    evidence.scopeId !== binding.scopeId ||
    evidence.instanceId !== target.instanceId ||
    evidence.database !== target.database ||
    !same(evidence.rootPath, destination.targetRootPath) ||
    !target.rootPaths.some((root) => inside(root, evidence.rootPath))
  )
    throw fail('target-identity', 'targetState', 'Target observation scope/instance/database/root differs');
  const policies = new Map();
  for (const row of plan.items) {
    const source = index.items.get(normalizeId(row.identity.sourceItemId));
    const context = index.contexts.find(
      (c) =>
        same(c.instanceId, row.identity.renderingInstanceId) &&
        same(c.pageId, row.identity.pageId) &&
        same(c.deviceId, row.identity.deviceId) &&
        c.language === row.identity.language &&
        c.version === row.identity.version,
    );
    const rule = destination.rules.find(
      (r) =>
        same(r.sourceTemplateId, source?.templateId ?? context?.parameterTemplateId) &&
        r.outputKey === row.identity.outputKey &&
        r.kind !== 'parameters',
    );
    if (!rule || rule.branchId)
      throw fail('destination-rule', row.identity.targetPath, 'Missing supported destination rule');
    policies.set(normalizeId(row.identity.targetPath), rule.existingItem);
    const definition = target.templates.find((t) => same(t.id, row.templateId));
    for (const field of row.fields) {
      const actual = definition.fields.find((f) => same(f.id, field.fieldId));
      if (/^__(?:final\s*)?renderings$/i.test(actual.name))
        throw fail(
          'presentation-field',
          row.identity.targetPath,
          'Content planning cannot assign presentation',
        );
    }
  }
  for (const ref of report.referenceDependencies) {
    const owner = plan.items.find((i) => identityKey(i.identity) === identityKey(ref.owner));
    const field = owner?.fields.find((f) => fieldKey(f) === fieldKey(ref));
    const relation = owner?.relationships.find((r) => fieldKey(r) === fieldKey(ref));
    if (
      !owner ||
      canonical(owner.identity) !== canonical(ref.owner) ||
      !field ||
      field.value !== ref.rawValue ||
      ref.status !== 'planned' ||
      !relation ||
      canonical(relation.targets) !== canonical(ref.targets)
    )
      throw fail(
        'reference-binding',
        'transformReport',
        'Reference dependency differs from planned field/relationship',
      );
  }
  const result = planChanges({ plan, report, evidence, policies, limits: request.value });
  const inputs = Object.fromEntries(
    ['transformInput', 'itemPlan', 'identityMap', 'transformReport', 'targetState'].map((k) => [
      k,
      request.value[k].sha256,
    ]),
  );
  const header = {
    version: 1,
    scopeId: binding.scopeId,
    mappingRevision: binding.mappingRevision,
    sourceInstanceId: snapshot.header.instanceId,
    targetInstanceId: evidence.instanceId,
    database: evidence.database,
    targetRootPath: evidence.rootPath,
    targetStateId: evidence.targetStateId,
    targetCapturedAt: evidence.capturedAt,
    plannerRequestSha256: request.sha256,
    inputs,
  };
  const preconditions = result.rows.map((r) => ({
    targetItemId: r.targetItemId,
    targetPath: r.targetPath,
    parentPath: r.parentPath,
    beforeFingerprint: r.beforeFingerprint,
  }));
  const batchPlan = bounded({
    ...header,
    ready: result.ready,
    reviewOnly: true,
    maxItemsPerBatch: request.value.maxItemsPerBatch ?? 50,
    maxBatchBytes: request.value.maxBatchBytes ?? 1024 * 1024,
    preconditions,
    batches: result.batches,
    referencesPending: result.referencesPending,
  });
  requireSchema('batchPlan', batchPlan);
  const summary = Object.fromEntries(
    ['create', 'update', 'reuse', 'conflict'].map((action) => [
      action,
      result.rows.filter((r) => r.action === action).length,
    ]),
  );
  summary.exclude = result.exclusions.length;
  const dryRun = bounded({
    ...header,
    ready: result.ready,
    requiresApproval: true,
    executionAvailable: false,
    batchPlanSha256: hash(jsonBytes(batchPlan)),
    summary,
    ...result,
  });
  const requirements = bounded({
    version: 1,
    scopeId: binding.scopeId,
    instanceId: evidence.instanceId,
    database: evidence.database,
    rootPath: evidence.rootPath,
    targetStateId: evidence.targetStateId,
    valueMode: 'effective',
    gaps: result.gaps,
  });
  // Recheck exact file descriptors; no prior report can silently bless drift.
  for (const name of Object.keys(artifacts)) await readArtifactJSON(base, request.value[name]);
  await readArtifactJSON(dirname(transform.path), transform.value.migrationInput);
  await readArtifactJSON(dirname(transform.path), transform.value.snapshotValidation);
  if (
    (await readJSON(inputPath)).sha256 !== request.sha256 ||
    !(await validateInputFile(migration.path)).valid
  )
    throw fail('input-drift', 'planInput', 'Inputs changed during planning');
  const output = await freshDirectory(outputPath);
  for (const [name, value] of [
    ['dry-run.json', dryRun],
    ['batch-plan.json', batchPlan],
    ['target-read-requirements.json', requirements],
  ])
    await writeNewJSON(join(output, name), value);
  return {
    ready: result.ready,
    summary,
    issues: result.issues,
    gapCount: result.gaps.length,
    batchCount: result.batches.length,
    requiresApproval: true,
    executionAvailable: false,
    outputs: {
      dryRun: { path: 'dry-run.json', sha256: hash(jsonBytes(dryRun)) },
      batchPlan: { path: 'batch-plan.json', sha256: hash(jsonBytes(batchPlan)) },
      readRequirements: { path: 'target-read-requirements.json', sha256: hash(jsonBytes(requirements)) },
    },
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output')
      throw fail(
        'usage',
        'arguments',
        'Usage: node plan-content.mjs --input plan-input.json --output NEW_DIRECTORY',
      );
    const result = await planContent(args[1], args[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
