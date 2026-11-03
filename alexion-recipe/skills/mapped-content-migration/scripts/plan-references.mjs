import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { requireSchema } from './lib/schema.mjs';
import {
  readJSON,
  readArtifactJSON,
  hash,
  jsonBytes,
  normalizeId,
  fail,
  MAX_JSON_BYTES,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
} from './lib/files.mjs';
import { identityKey, inside } from './lib/transform-paths.mjs';
import { canonical, indexTargetState, queryKey } from './lib/target-state.mjs';
import { fieldKey } from './lib/snapshot.mjs';
import { planChanges } from './lib/dry-run.mjs';
import { rewriteReference } from './lib/reference-rewrite.mjs';
import { planContent } from './plan-content.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const bounded = (value) => {
  if (Buffer.byteLength(jsonBytes(value)) > MAX_JSON_BYTES)
    throw fail('output-size', 'references', 'Reference output exceeds 16 MiB; reduce the approved scope');
  return value;
};

/** Revalidate original content inputs; planning remains deterministic and local. */
export async function loadReferenceContext(inputPath) {
  const request = await readJSON(inputPath);
  requireSchema('referencePlanInput', request.value);
  const base = dirname(inputPath),
    artifacts = {};
  for (const name of ['contentPlanInput', 'checkpoint', 'targetState', 'existingTargetState'])
    if (request.value[name]) artifacts[name] = await readArtifactJSON(base, request.value[name]);
  requireSchema('executionCheckpoint', artifacts.checkpoint.value);
  requireSchema('targetState', artifacts.targetState.value);
  const initial = artifacts.contentPlanInput,
    contentBase = dirname(initial.path),
    content = {};
  requireSchema('planInput', initial.value);
  for (const name of ['itemPlan', 'identityMap', 'transformReport', 'transformInput'])
    content[name] = await readArtifactJSON(contentBase, initial.value[name]);
  const migration = await readArtifactJSON(
    dirname(content.transformInput.path),
    content.transformInput.value.migrationInput,
  );
  for (const name of ['mapping', 'targetInventory', 'destinationPlan'])
    content[name] = await readArtifactJSON(dirname(migration.path), migration.value[name]);
  const scratch = await mkdtemp(join(tmpdir(), 'reference-content-replay-'));
  let contentReview;
  try {
    const result = await planContent(initial.path, join(scratch, 'review'));
    if (!result.ready) throw fail('content-plan', 'contentPlanInput', 'Original content plan is not ready');
    contentReview = (await readJSON(join(scratch, 'review/dry-run.json'))).value;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { request, artifacts, content, migration, contentReview };
}

export async function planReferences(inputPath, outputPath) {
  const context = await loadReferenceContext(inputPath),
    { request, artifacts, content, migration, contentReview } = context;
  const plan = content.itemPlan.value,
    report = content.transformReport.value,
    destination = content.destinationPlan.value,
    inventory = content.targetInventory.value;
  const evidence = artifacts.targetState.value,
    checkpoint = artifacts.checkpoint.value,
    queries = indexTargetState(evidence);
  if (
    evidence.scopeId !== plan.scopeId ||
    evidence.instanceId !== inventory.instanceId ||
    evidence.database !== inventory.database ||
    !same(evidence.rootPath, destination.targetRootPath)
  )
    throw fail('target-identity', 'targetState', 'Reference observations differ from the approved target');
  for (const [key, value] of [
    ['scopeId', plan.scopeId],
    ['targetInstanceId', inventory.instanceId],
    ['database', inventory.database],
    ['rootPath', destination.targetRootPath],
  ])
    if (checkpoint[key] !== value)
      throw fail('checkpoint-scope', key, 'Identity checkpoint belongs to another target scope');
  if (checkpoint.active)
    throw fail('pending-job', 'checkpoint', 'Reconcile the pending job before reference planning');
  let external;
  if (artifacts.existingTargetState) {
    const state = artifacts.existingTargetState.value;
    requireSchema('targetState', state);
    if (
      state.scopeId !== plan.scopeId ||
      state.instanceId !== inventory.instanceId ||
      state.database !== inventory.database ||
      state.rootPath !== '/sitecore'
    )
      throw fail(
        'target-identity',
        'existingTargetState',
        'Existing reference observations must use this target and read-only /sitecore root',
      );
    external = indexTargetState(state);
  }
  const issues = [],
    gaps = new Map(),
    guards = new Map(),
    bindings = new Map(),
    owners = new Map(),
    updates = [];
  const issue = (code, message, targetPath = evidence.rootPath) => issues.push({ code, message, targetPath });
  function observe(binding, lookup, readOnly = false) {
    const value = lookup === 'id' ? binding.targetItemId : binding.targetPath,
      key = queryKey(lookup, value),
      index = readOnly ? external : queries;
    const query = index?.get(key);
    if (!query) {
      gaps.set((readOnly ? 'existing|' : '') + key, {
        lookup,
        value,
        ...(readOnly ? { existingTarget: true } : {}),
      });
      return;
    }
    if (!query.exists) {
      issue('missing-target', `Required target does not exist: ${value}`, binding.targetPath);
      return;
    }
    if (
      !same(query.item.id, binding.targetItemId) ||
      !same(query.item.path, binding.targetPath) ||
      !same(query.item.templateId, binding.templateId)
    ) {
      issue('target-identity', 'Reference target ID/path/template differs', binding.targetPath);
      return;
    }
    if (guards.has(key) && canonical(guards.get(key)) !== canonical(query)) {
      issue('target-state', 'Reference observations contradict each other', binding.targetPath);
      return;
    }
    guards.set(key, query);
    return query.item;
  }
  function plannedBinding(identity) {
    const item = plan.items.find((i) => identityKey(i.identity) === identityKey(identity));
    if (!item || canonical(item.identity) !== canonical(identity)) {
      issue('identity-binding', 'Reference identity is absent from the approved item plan');
      return;
    }
    const binding = {
      identity,
      sourceItemId: identity.sourceItemId,
      targetItemId: identity.targetItemId,
      targetPath: identity.targetPath,
      templateId: item.templateId,
      existing: false,
    };
    const actual = observe(binding, 'id');
    observe(binding, 'path');
    const saved = checkpoint.identities.find((e) => identityKey(e.identity) === identityKey(identity));
    if (saved) {
      if (
        !['success', 'reused'].includes(saved.status) ||
        canonical(saved.identity) !== canonical(identity)
      ) {
        issue('identity-status', 'Reference identity is partial, failed or changed', identity.targetPath);
        return;
      }
    } else if (
      !contentReview.rows.some((r) => same(r.targetItemId, identity.targetItemId) && r.action === 'reuse')
    ) {
      issue(
        'unconfirmed-identity',
        'Target identity has no verified execution or approved reuse evidence',
        identity.targetPath,
      );
      return;
    }
    if (actual) {
      if (
        item.versions.some(
          (v) => !actual.versions.some((a) => a.language === v.language && a.version === v.version),
        )
      )
        issue('version', 'Required target language/version is absent', identity.targetPath);
      const deferred = new Set(
        report.referenceDependencies
          .filter((r) => identityKey(r.owner) === identityKey(identity))
          .map(fieldKey),
      );
      for (const field of item.fields.filter((f) => !deferred.has(fieldKey(f)))) {
        const observed = actual.fields.find((f) => fieldKey(f) === fieldKey(field));
        if (!observed)
          gaps.set('field|' + identity.targetItemId + '|' + fieldKey(field), {
            lookup: 'field',
            value: identity.targetItemId,
            field: {
              fieldId: field.fieldId,
              storage: field.storage,
              ...(field.language ? { language: field.language } : {}),
              ...(field.version ? { version: field.version } : {}),
            },
          });
        else if (!observed.present || observed.value !== field.value)
          issue(
            'content-drift',
            'Initial mapped content values differ from the approved plan',
            identity.targetPath,
          );
      }
    }
    bindings.set(identityKey(identity), binding);
    return { binding, item, actual };
  }
  for (const ref of report.referenceDependencies) {
    const owner = plannedBinding(ref.owner);
    if (!owner) continue;
    const definition = inventory.templates
      .find((t) => same(t.id, owner.item.templateId))
      ?.fields.find((f) => same(f.id, ref.fieldId));
    const sourceField = owner.item.fields.find((f) => fieldKey(f) === fieldKey(ref));
    if (
      !definition ||
      definition.storage !== sourceField?.storage ||
      /^__(?:final\s*)?renderings$/i.test(definition.name)
    ) {
      issue(
        'reference-field',
        'Reference field is incompatible or belongs to presentation',
        owner.binding.targetPath,
      );
      continue;
    }
    const selected = [],
      choice = destination.referenceRules.find(
        (r) => same(r.sourceTemplateId, ref.sourceTemplateId) && same(r.sourceFieldId, ref.sourceFieldId),
      );
    for (const sourceId of ref.targetSourceIds) {
      const candidates = plan.items.filter(
        (i) =>
          same(i.identity.sourceItemId, sourceId) &&
          (!choice || i.identity.outputKey === choice.targetOutputKey) &&
          (!i.identity.pageId || same(i.identity.pageId, ref.owner.pageId ?? ref.owner.sourceItemId)),
      );
      const explicit = destination.existingReferenceTargets?.find((t) => same(t.sourceItemId, sourceId));
      let binding;
      if (candidates.length === 1 && !explicit) {
        const chosen = plannedBinding(candidates[0].identity);
        binding = chosen?.binding;
        if (!ref.targets.some((t) => canonical(t) === canonical(candidates[0].identity)))
          issue(
            'reference-choice',
            'Dependency does not select the approved target output',
            owner.binding.targetPath,
          );
      } else if (!candidates.length && explicit) {
        binding = { ...explicit, existing: true };
        observe(binding, 'id', true);
        observe(binding, 'path', true);
        bindings.set('existing|' + normalizeId(sourceId), binding);
        if (!(ref.existingTargets ?? []).some((t) => canonical(t) === canonical(explicit)))
          issue(
            'reference-choice',
            'Existing dependency differs from the approved binding',
            owner.binding.targetPath,
          );
      } else
        issue(
          'reference-choice',
          `Reference needs exactly one approved output for ${sourceId}`,
          owner.binding.targetPath,
        );
      if (binding) {
        if (ref.kind === 'media' && !inside('/sitecore/media library', binding.targetPath))
          issue(
            'media-target',
            'Media references require an existing target media-library item',
            binding.targetPath,
          );
        selected.push(binding.targetItemId);
      }
    }
    if (selected.length !== ref.targetSourceIds.length) continue;
    let value;
    try {
      value = rewriteReference(ref, ref.rawValue, definition.type, selected);
    } catch (error) {
      issue(error.code ?? 'reference-format', error.message, owner.binding.targetPath);
      continue;
    }
    const { fieldId, language, version } = ref,
      storage = definition.storage,
      field = { fieldId, storage, ...(language ? { language } : {}), ...(version ? { version } : {}), value };
    if (
      storage === 'versioned' &&
      owner.actual &&
      !owner.actual.versions.some((v) => v.language === language && v.version === version)
    ) {
      issue('version', 'Reference writes cannot create a missing version', owner.binding.targetPath);
      continue;
    }
    const key = identityKey(owner.item.identity);
    if (!owners.has(key)) owners.set(key, { ...owner.item, action: 'update', fields: [], relationships: [] });
    const row = owners.get(key);
    if (row.fields.some((f) => fieldKey(f) === fieldKey(field))) {
      issue(
        'reference-conflict',
        'Several dependencies write the same field selector',
        owner.binding.targetPath,
      );
      continue;
    }
    row.fields.push(field);
    updates.push({
      owner: ref.owner,
      ...field,
      sourceIds: ref.targetSourceIds,
      targetIds: selected,
      kind: ref.kind,
    });
  }
  const result = planChanges({
    plan: { items: [...owners.values()], structures: [] },
    report: {
      referenceDependencies: [],
      exclusions: report.exclusions,
      deferredParameters: report.deferredParameters,
    },
    evidence,
    policies: new Map([...owners.values()].map((i) => [normalizeId(i.identity.targetPath), 'update'])),
    limits: request.value,
  });
  for (const gap of result.gaps) gaps.set(canonical(gap), gap);
  issues.push(...result.issues);
  for (const operation of result.batches.flatMap((b) => b.operations))
    if (operation.action !== 'update' || operation.versionsToCreate.length)
      issue(
        'reference-operation',
        'References may only update existing fields and versions',
        operation.targetPath,
      );
  const ready = !issues.length && !gaps.size;
  const inputs = { ...contentReview.inputs, targetState: request.value.targetState.sha256 };
  const header = {
    version: 1,
    scopeId: plan.scopeId,
    mappingRevision: plan.mappingRevision,
    sourceInstanceId: contentReview.sourceInstanceId,
    targetInstanceId: inventory.instanceId,
    database: inventory.database,
    targetRootPath: evidence.rootPath,
    targetStateId: evidence.targetStateId,
    targetCapturedAt: evidence.capturedAt,
    plannerRequestSha256: request.sha256,
    inputs,
  };
  const batchPlan = bounded({
    ...header,
    ready,
    reviewOnly: true,
    maxItemsPerBatch: request.value.maxItemsPerBatch ?? 50,
    maxBatchBytes: request.value.maxBatchBytes ?? 1048576,
    preconditions: result.rows.map((r) => ({
      targetItemId: r.targetItemId,
      targetPath: r.targetPath,
      parentPath: r.parentPath,
      beforeFingerprint: r.beforeFingerprint,
    })),
    batches: ready ? result.batches : [],
    referencesPending: !ready,
  });
  requireSchema('batchPlan', batchPlan);
  // Several approved source aliases may reuse the same existing target. One physical guard pair suffices.
  const physicalBindings = new Map();
  for (const binding of bindings.values()) {
    const key = normalizeId(binding.targetItemId);
    if (!physicalBindings.has(key) || binding.identity) physicalBindings.set(key, binding);
  }
  const referenceBindings = [...physicalBindings.values()],
    referenceGuards = [...guards.values()];
  const dryRun = bounded({
    ...header,
    ...result,
    ready,
    batches: batchPlan.batches,
    gaps: [...gaps.values()],
    issues,
    requiresApproval: true,
    executionAvailable: false,
    batchPlanSha256: hash(jsonBytes(batchPlan)),
    referenceDependencies: [],
    referenceUpdates: updates,
    referenceBindings,
    referenceGuards,
    identityCheckpointSha256: artifacts.checkpoint.sha256,
    referencesPending: !ready,
    summary: {
      update: result.rows.filter((r) => r.action === 'update').length,
      reuse: result.rows.filter((r) => r.action === 'reuse').length,
      conflict: issues.length,
    },
  });
  for (const [name, artifact] of Object.entries(artifacts))
    await readArtifactJSON(dirname(inputPath), request.value[name]);
  // Recheck nested content artifacts as well as the source snapshot before publishing.
  const repeat = await loadReferenceContext(inputPath);
  if (repeat.request.sha256 !== request.sha256 || repeat.migration.sha256 !== migration.sha256)
    throw fail('input-drift', 'referencePlanInput', 'Inputs changed during reference planning');
  const output = await freshDirectory(outputPath),
    requirements = {
      version: 1,
      scopeId: plan.scopeId,
      instanceId: evidence.instanceId,
      database: evidence.database,
      rootPath: evidence.rootPath,
      valueMode: 'effective',
      gaps: [...gaps.values()],
    };
  const referenceReport = bounded({
    version: 1,
    scopeId: plan.scopeId,
    ready,
    operationKind: 'references',
    referencePlanInputSha256: request.sha256,
    identityCheckpointSha256: artifacts.checkpoint.sha256,
    batchPlanSha256: hash(jsonBytes(batchPlan)),
    updates,
    bindings: referenceBindings,
    issues,
    gaps: [...gaps.values()],
    presentationAssignmentsExcluded: true,
  });
  for (const [name, value] of [
    ['batch-plan.json', batchPlan],
    ['dry-run.json', dryRun],
    ['target-read-requirements.json', requirements],
    ['reference-report.json', referenceReport],
  ])
    await writeNewJSON(join(output, name), bounded(value));
  return {
    ready,
    requiresApproval: true,
    executionAvailable: false,
    referenceFieldCount: updates.length,
    gapCount: gaps.size,
    issues,
    batchCount: batchPlan.batches.length,
    outputs: {
      batchPlan: { path: 'batch-plan.json', sha256: hash(jsonBytes(batchPlan)) },
      dryRun: { path: 'dry-run.json', sha256: hash(jsonBytes(dryRun)) },
      referenceReport: { path: 'reference-report.json', sha256: hash(jsonBytes(referenceReport)) },
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
        'Usage: node plan-references.mjs --input reference-plan-input.json --output NEW_DIRECTORY',
      );
    const result = await planReferences(args[1], args[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
