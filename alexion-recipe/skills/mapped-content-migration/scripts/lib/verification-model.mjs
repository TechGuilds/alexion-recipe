import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  readJSON,
  readArtifactJSON,
  scopedPath,
  normalizeId,
  fail,
  hash,
  jsonBytes,
  MAX_JSON_BYTES,
} from './files.mjs';
import { requireSchema } from './schema.mjs';
import { transformContent } from '../transform-content.mjs';
import { planContent } from '../plan-content.mjs';
import { openSnapshot, fieldKey } from './snapshot.mjs';
import { identityKey, parentPath, inside } from './transform-paths.mjs';
import { canonical, indexTargetState, queryKey } from './target-state.mjs';
import { rewriteReference } from './reference-rewrite.mjs';
import { readExecutionState } from './execution-state.mjs';
import { validateInputFile } from '../validate-inputs.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const selectors = (fields) =>
  fields.map(({ fieldId, storage, language, version }) => ({
    fieldId,
    storage,
    ...(language ? { language } : {}),
    ...(version ? { version } : {}),
  }));
export const boundedVerification = (value) => {
  if (Buffer.byteLength(jsonBytes(value)) > MAX_JSON_BYTES)
    throw fail(
      'verification-size',
      'verification',
      'Verification artifact exceeds 16 MiB; reduce the approved audit scope',
    );
  return value;
};

/** Rebuild expected values from source/mapping, never from writer afterstates. */
export async function buildVerificationModel(inputPath) {
  const input = await readJSON(inputPath);
  requireSchema('verificationInput', input.value);
  const request = input.value,
    base = dirname(inputPath),
    artifacts = {};
  for (const name of ['contentPlanInput', 'checkpoint', 'capabilities'])
    artifacts[name] = await readArtifactJSON(base, request[name]);
  const contentInput = artifacts.contentPlanInput;
  requireSchema('planInput', contentInput.value);
  requireSchema('executionCheckpoint', artifacts.checkpoint.value);
  requireSchema('verificationCapabilities', artifacts.capabilities.value);
  const journalDirectory = dirname(artifacts.checkpoint.path);
  if ((await readExecutionState(journalDirectory)).sha256 !== artifacts.checkpoint.sha256)
    throw fail(
      'verification-checkpoint-stale',
      'checkpoint',
      'Audit must select the current immutable checkpoint from the actual journal head',
    );
  const original = {};
  for (const name of ['transformInput', 'itemPlan', 'identityMap', 'transformReport', 'targetState'])
    original[name] = await readArtifactJSON(dirname(contentInput.path), contentInput.value[name]);
  const migration = await readArtifactJSON(
      dirname(original.transformInput.path),
      original.transformInput.value.migrationInput,
    ),
    binding = migration.value,
    documents = {};
  for (const name of ['mapping', 'targetInventory', 'destinationPlan'])
    documents[name] = (await readArtifactJSON(dirname(migration.path), binding[name])).value;
  const scratch = await mkdtemp(join(tmpdir(), 'verification-transform-'));
  let plan, report, initialReview;
  try {
    const rebuilt = await transformContent(original.transformInput.path, join(scratch, 'rebuilt'));
    if (!rebuilt.ready)
      throw fail(
        'verification-source',
        'transformInput',
        'Source-derived transformation has unresolved errors',
      );
    for (const [name, file] of [
      ['itemPlan', 'item-plan.json'],
      ['identityMap', 'proposed-identity-map.json'],
      ['transformReport', 'transform-report.json'],
    ])
      if ((await readJSON(join(scratch, 'rebuilt', file))).sha256 !== original[name].sha256)
        throw fail(
          'verification-provenance',
          name,
          'Saved transformation differs from independently rebuilt source/mapping output',
        );
    plan = (await readJSON(join(scratch, 'rebuilt/item-plan.json'))).value;
    report = rebuilt;
    const planned = await planContent(contentInput.path, join(scratch, 'initial-plan'));
    if (!planned.ready)
      throw fail(
        'verification-plan',
        'contentPlanInput',
        'Original approved content comparison has unresolved conflicts or gaps',
      );
    initialReview = (await readJSON(join(scratch, 'initial-plan/dry-run.json'))).value;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const inventory = documents.targetInventory,
    destination = documents.destinationPlan,
    checkpoint = artifacts.checkpoint.value,
    cap = artifacts.capabilities.value,
    baseline = indexTargetState(original.targetState.value);
  for (const [key, value] of [
    ['scopeId', binding.scopeId],
    ['instanceId', inventory.instanceId],
    ['database', inventory.database],
    ['rootPath', destination.targetRootPath],
  ])
    if (cap[key] !== value || original.targetState.value[key] !== value)
      throw fail('verification-target', key, 'Audit capability or baseline differs from the approved target');
  for (const [key, value] of [
    ['scopeId', binding.scopeId],
    ['targetInstanceId', inventory.instanceId],
    ['database', inventory.database],
    ['rootPath', destination.targetRootPath],
    ['connectorId', cap.connectorId],
  ])
    if (checkpoint[key] !== value)
      throw fail('verification-checkpoint', key, 'Audit checkpoint belongs to another target scope');
  const verifiedAt = Date.parse(cap.verifiedAt),
    expiresAt = Date.parse(cap.expiresAt);
  if (
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(expiresAt) ||
    verifiedAt > Date.now() ||
    expiresAt <= verifiedAt ||
    expiresAt <= Date.now()
  )
    throw fail('verification-window', 'capabilities', 'A current verified stable read window is required');
  await readArtifactJSON(dirname(artifacts.capabilities.path), cap.evidence);
  const marker = inventory.items.find((i) => same(i.path, destination.targetRootPath));
  if (
    cap.marker.path !== destination.targetRootPath ||
    !marker ||
    !same(marker.id, cap.marker.id) ||
    !same(marker.templateId, cap.marker.templateId)
  )
    throw fail(
      'verification-marker',
      'capabilities',
      'Read capability must bind the exact inventoried target root marker',
    );
  const snapshotPath = await scopedPath(dirname(migration.path), binding.sourceSnapshot.path),
    snapshot = await openSnapshot(snapshotPath);
  if (!snapshot.header.languages.includes(request.structuralLanguage))
    throw fail(
      'verification-language',
      'structuralLanguage',
      'Structural language is outside the agreed source scope',
    );
  const issues = [],
    dependencies = new Map(),
    nodes = [],
    expectedById = new Map(),
    querySpecs = new Map();
  const issue = (code, message, targetPath) =>
    issues.push({ code, message, ...(targetPath ? { targetPath } : {}) });
  if (checkpoint.active)
    issue('pending-job', 'A reserved, submitted or unknown write must be reconciled before audit completion');
  for await (const record of snapshot.records())
    if (
      record.kind === 'item' &&
      !plan.items.some((i) => same(i.identity.sourceItemId, record.data.id)) &&
      !report.exclusions.some((e) => same(e.sourceItemId, record.data.id)) &&
      !destination.rules.some(
        (r) => same(r.sourceTemplateId, record.data.templateId) && r.kind === 'parameters',
      )
    )
      issue('unmapped-source', `Captured source item has no output or approved exclusion: ${record.data.id}`);
  for (const item of plan.items) {
    const fields = item.fields.map((f) => ({ ...f })),
      template = inventory.templates.find((t) => same(t.id, item.templateId));
    for (const field of fields) {
      const definition = template?.fields.find((f) => same(f.id, field.fieldId));
      if (!definition)
        throw fail('verification-field', item.identity.targetPath, 'Expected field lacks target metadata');
      field.fieldType = definition.type;
    }
    const before = baseline.get(queryKey('id', item.identity.targetItemId));
    const versions = new Map(
      [...(before?.exists ? before.item.versions : []), ...item.versions].map((v) => [
        v.language + '|' + v.version,
        v,
      ]),
    );
    const node = {
      kind: 'content',
      identity: item.identity,
      sourceItemId: item.identity.sourceItemId,
      targetItemId: item.identity.targetItemId,
      targetPath: item.identity.targetPath,
      templateId: item.templateId,
      parentPath: item.parentPath,
      fields,
      versions: [...versions.values()],
      historyIssues: [],
      reused: false,
    };
    nodes.push(node);
    expectedById.set(normalizeId(node.targetItemId), node);
  }
  for (const structure of plan.structures ?? []) {
    const before = baseline.get(queryKey('id', structure.targetItemId));
    const node = {
      kind: 'folder',
      ...structure,
      fields: [],
      versions: before?.exists
        ? before.item.versions
        : [{ language: request.structuralLanguage, version: 1 }],
      historyIssues: [],
      reused:
        !!before?.exists &&
        same(before.item.path, structure.targetPath) &&
        same(before.item.templateId, structure.templateId),
    };
    nodes.push(node);
    expectedById.set(normalizeId(node.targetItemId), node);
  }
  for (const ref of report.referenceDependencies) {
    const owner = expectedById.get(normalizeId(ref.owner.targetItemId)),
      field = owner?.fields.find((f) => fieldKey(f) === fieldKey(ref));
    if (!owner || !field)
      throw fail(
        'verification-reference',
        'referenceDependencies',
        'Reference owner field is absent from canonical transformation',
      );
    const targets = [];
    for (const sourceId of ref.targetSourceIds) {
      const chosen = ref.targets.filter((t) => same(t.sourceItemId, sourceId));
      const unique = [...new Map(chosen.map((t) => [identityKey(t), t])).values()];
      const existing = destination.existingReferenceTargets?.find((t) => same(t.sourceItemId, sourceId));
      if (unique.length === 1 && !existing) {
        const target = expectedById.get(normalizeId(unique[0].targetItemId));
        if (!target || canonical(target.identity) !== canonical(unique[0]))
          throw fail(
            'verification-reference',
            'targets',
            'Canonical reference has no matching planned output',
          );
        targets.push(target.targetItemId);
        dependencies.set(normalizeId(target.targetItemId), {
          targetItemId: target.targetItemId,
          targetPath: target.targetPath,
          templateId: target.templateId,
        });
      } else if (!unique.length && existing) {
        targets.push(existing.targetItemId);
        dependencies.set(normalizeId(existing.targetItemId), {
          targetItemId: existing.targetItemId,
          targetPath: existing.targetPath,
          templateId: existing.templateId,
        });
      } else
        throw fail(
          'verification-reference',
          'targets',
          'Reference needs exactly one approved output or existing binding',
        );
    }
    try {
      field.value = rewriteReference(ref, ref.rawValue, field.fieldType, targets);
    } catch (error) {
      issue(error.code ?? 'reference-format', error.message, owner.targetPath);
    }
  }
  for (const node of nodes) {
    const parent =
      nodes.find((n) => same(n.targetPath, node.parentPath)) ??
      inventory.items.find((i) => same(i.path, node.parentPath));
    node.parentId = parent?.targetItemId ?? parent?.id;
    if (!node.parentId)
      issue(
        'missing-parent',
        'Expected parent identity is not supplied by the approved plan or target inventory',
        node.targetPath,
      );
    else
      dependencies.set(normalizeId(node.parentId), {
        targetItemId: node.parentId,
        targetPath: node.parentPath,
        templateId: parent.templateId,
      });
    const latest = checkpoint.operations.findLast((o) => same(o.targetItemId, node.targetItemId));
    if (latest && latest.status !== 'success')
      node.historyIssues.push({
        code: 'execution-' + latest.status,
        message: 'Latest recorded operation is ' + latest.status + '; preserve and reconcile its outcome',
      });
    if (node.identity) {
      const saved = checkpoint.identities.find((e) => identityKey(e.identity) === identityKey(node.identity));
      const before = baseline.get(queryKey('id', node.targetItemId));
      const unchanged =
        before?.exists &&
        same(before.item.id, node.targetItemId) &&
        same(before.item.path, node.targetPath) &&
        same(before.item.templateId, node.templateId) &&
        node.versions.length === before.item.versions.length &&
        node.versions.every((v) =>
          before.item.versions.some((p) => p.language === v.language && p.version === v.version),
        ) &&
        node.fields.every((f) =>
          before.item.fields.some(
            (v) => fieldKey(v) === fieldKey(f) && v.present && v.value === f.value && v.storage === f.storage,
          ),
        );
      if (saved) {
        if (
          !['success', 'reused'].includes(saved.status) ||
          canonical(saved.identity) !== canonical(node.identity) ||
          saved.mappingRevision !== plan.mappingRevision
        )
          node.historyIssues.push({
            code: 'identity-history',
            message: 'Verified identity is partial, changed or belongs to a different mapping revision',
          });
        node.reused = saved.status === 'reused';
      } else if (
        unchanged &&
        initialReview.rows.some((r) => same(r.targetItemId, node.targetItemId) && r.action === 'reuse')
      )
        node.reused = true;
      else
        node.historyIssues.push({
          code: 'unconfirmed-identity',
          message: 'Planned identity has neither confirmed migration nor unchanged baseline reuse evidence',
        });
    } else if (!latest && !node.reused)
      node.historyIssues.push({
        code: 'unconfirmed-structure',
        message: 'Planned folder has no confirmed creation or baseline reuse evidence',
      });
  }
  dependencies.set(normalizeId(cap.marker.id), {
    targetItemId: cap.marker.id,
    targetPath: cap.marker.path,
    templateId: cap.marker.templateId,
  });
  function addQuery(node) {
    for (const lookup of ['id', 'path']) {
      const value = lookup === 'id' ? node.targetItemId : node.targetPath,
        key = queryKey(lookup, value),
        fields = selectors(node.fields ?? []);
      if (querySpecs.has(key)) {
        const prior = querySpecs.get(key);
        for (const f of fields)
          if (!prior.fields.some((p) => fieldKey(p) === fieldKey(f))) prior.fields.push(f);
      } else querySpecs.set(key, { lookup, value, fields });
    }
  }
  for (const node of nodes) addQuery(node);
  for (const dependency of dependencies.values()) addQuery(dependency);
  const queries = [...querySpecs.values()]
    .map((q) => ({ ...q, fields: q.fields.sort((a, b) => fieldKey(a).localeCompare(fieldKey(b))) }))
    .sort((a, b) => queryKey(a.lookup, a.value).localeCompare(queryKey(b.lookup, b.value)));
  const expected = boundedVerification({
    version: 1,
    scopeId: binding.scopeId,
    mappingRevision: binding.mappingRevision,
    sourceInstanceId: snapshot.header.instanceId,
    target: {
      instanceId: inventory.instanceId,
      database: inventory.database,
      rootPath: destination.targetRootPath,
      connectorId: cap.connectorId,
      marker: cap.marker,
    },
    structuralLanguage: request.structuralLanguage,
    inputs: {
      contentPlanInput: artifacts.contentPlanInput.sha256,
      migrationInput: migration.sha256,
      itemPlan: original.itemPlan.sha256,
      identityMap: original.identityMap.sha256,
      transformReport: original.transformReport.sha256,
      checkpoint: artifacts.checkpoint.sha256,
    },
    items: nodes.map(({ historyIssues, reused, ...node }) => node),
    dependencies: [...dependencies.values()],
    exclusions: report.exclusions,
    deferredParameters: report.deferredParameters,
    queries,
  });
  return {
    input,
    request,
    artifacts,
    expected,
    expectedSha256: hash(jsonBytes(expected)),
    nodes,
    issues,
    checkpoint,
    cap,
    baseline,
    async recheck() {
      if ((await readExecutionState(journalDirectory)).sha256 !== artifacts.checkpoint.sha256)
        throw fail(
          'verification-checkpoint-stale',
          'checkpoint',
          'Journal changed during the independent audit; collect a new bound read-back',
        );
      for (const name of Object.keys(original))
        await readArtifactJSON(dirname(contentInput.path), contentInput.value[name]);
      await readArtifactJSON(
        dirname(original.transformInput.path),
        original.transformInput.value.migrationInput,
      );
      await readArtifactJSON(
        dirname(original.transformInput.path),
        original.transformInput.value.snapshotValidation,
      );
      if (!(await validateInputFile(migration.path)).valid)
        throw fail(
          'verification-drift',
          'migrationInput',
          'Source, mapping or other nested migration evidence changed during the audit',
        );
    },
  };
}
