import { indexTargetState, beforeFingerprint, canonical, queryKey } from './target-state.mjs';
import { normalizeId, hash, jsonBytes } from './files.mjs';
import { fieldKey } from './snapshot.mjs';
import { identityKey, parentPath, inside } from './transform-paths.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const versionKey = (v) => `${v.language}|${v.version}`;

/** Pure local comparison. A ready result is a review proposal, never approval. */
export function planChanges({ plan, report, evidence, policies, limits = {} }) {
  const maxItems = limits.maxItemsPerBatch ?? 50,
    maxBytes = limits.maxBatchBytes ?? 1024 * 1024;
  const queries = indexTargetState(evidence),
    gaps = new Map(),
    issues = [],
    rows = [];
  const nodes = [
    ...plan.items.map((i) => ({
      id: i.identity.targetItemId,
      path: i.identity.targetPath,
      templateId: i.templateId,
      parent: i.parentPath ?? parentPath(i.identity.targetPath),
      fields: i.fields,
      versions: i.versions ?? [],
      identity: i.identity,
      kind: 'content',
      policy: policies.get(normalizeId(i.identity.targetPath)),
      original: i,
    })),
    ...(plan.structures ?? []).map((s) => ({
      id: s.targetItemId,
      path: s.targetPath,
      templateId: s.templateId,
      parent: s.parentPath,
      fields: [],
      versions: [],
      kind: 'folder',
      policy: 'structural',
      original: s,
    })),
  ].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const byPath = new Map(nodes.map((n) => [normalizeId(n.path), n])),
    ids = new Set();
  const get = (lookup, value) => {
    const key = queryKey(lookup, value),
      query = queries.get(key);
    if (!query) gaps.set(key, { lookup, value });
    return query;
  };
  const refKeys = new Map();
  for (const ref of report.referenceDependencies ?? []) {
    const key = identityKey(ref.owner);
    if (!refKeys.has(key)) refKeys.set(key, new Set());
    refKeys.get(key).add(fieldKey(ref));
  }
  for (const node of nodes) {
    const localIssues = [],
      add = (code, message) => {
        const issue = { code, message, targetPath: node.path };
        localIssues.push(issue);
        issues.push(issue);
      };
    if (ids.has(normalizeId(node.id))) add('collision', 'Duplicate planned target ID');
    ids.add(normalizeId(node.id));
    if (!inside(evidence.rootPath, node.path) || node.parent !== parentPath(node.path))
      add('target-scope', 'Planned target/parent is outside the approved structure');
    if (!node.policy || ['exclude', 'conflict'].includes(node.original.action))
      add('plan-conflict', 'Output has no valid destination policy or contains a conflict');
    const pathQuery = get('path', node.path),
      idQuery = get('id', node.id);
    const plannedParent = byPath.get(normalizeId(node.parent));
    const parentQuery = plannedParent ? undefined : get('path', node.parent);
    if ((!plannedParent && !parentQuery) || !pathQuery || !idQuery)
      add('target-evidence', 'Required ID/path/parent lookup evidence is missing');
    if (parentQuery && !parentQuery.exists)
      add('missing-parent', 'No existing parent or planned parent supplies this destination');
    if (plannedParent && rows.find((r) => same(r.targetPath, node.parent))?.action === 'conflict')
      add('parent-conflict', 'Parent has unresolved planning conflicts');
    let action = 'conflict',
      changes = [],
      versionsToCreate = [];
    const deferred = node.identity ? (refKeys.get(identityKey(node.identity)) ?? new Set()) : new Set();
    const relationKeys = new Set((node.original.relationships ?? []).map(fieldKey));
    if ([...relationKeys].some((k) => !deferred.has(k)))
      add('reference-evidence', 'Relationship is missing from the bound transformation dependency report');
    const scalarFields = node.fields.filter((f) => !deferred.has(fieldKey(f)));
    const actual = pathQuery?.exists ? pathQuery.item : undefined;
    if (pathQuery && idQuery) {
      if (
        pathQuery.exists !== idQuery.exists ||
        (actual &&
          (!same(actual.id, node.id) ||
            !same(actual.templateId, node.templateId) ||
            !same(idQuery.item.path, node.path)))
      )
        add('identity-conflict', 'Target path/ID/template differs from the planned identity');
      else if (!actual) {
        if (node.policy === 'reuse') add('missing-reuse', 'Required reuse target does not exist');
        else {
          action = 'create';
          changes = scalarFields.map((after) => ({
            fieldId: after.fieldId,
            storage: after.storage,
            ...(after.language ? { language: after.language } : {}),
            ...(after.version ? { version: after.version } : {}),
            before: null,
            after: after.value,
          }));
          versionsToCreate = [...node.versions];
        }
      } else {
        if (node.policy === 'create-only')
          add('existing-create-only', 'Create-only destination already exists');
        versionsToCreate = node.versions.filter(
          (v) => !actual.versions.some((a) => versionKey(a) === versionKey(v)),
        );
        for (const field of scalarFields) {
          const observed = actual.fields.find((f) => fieldKey(f) === fieldKey(field));
          if (!observed) {
            gaps.set(`field|${node.id}|${fieldKey(field)}`, {
              lookup: 'field',
              value: node.id,
              field: {
                fieldId: field.fieldId,
                storage: field.storage,
                ...(field.language ? { language: field.language } : {}),
                ...(field.version ? { version: field.version } : {}),
              },
            });
            add('target-evidence', 'A required field observation is missing');
            continue;
          }
          if (observed.storage !== field.storage) {
            add('field-storage', 'Observed target field storage differs');
            continue;
          }
          if (!observed.present || observed.value !== field.value)
            changes.push({
              fieldId: field.fieldId,
              storage: field.storage,
              ...(field.language ? { language: field.language } : {}),
              ...(field.version ? { version: field.version } : {}),
              before: observed.present ? observed.value : null,
              after: field.value,
            });
        }
        if (node.policy === 'reuse' && (changes.length || versionsToCreate.length || deferred.size))
          add(
            'reuse-difference',
            'Reuse requires matching values/versions and separately verified references',
          );
        action = changes.length || versionsToCreate.length ? 'update' : 'reuse';
      }
    }
    if (localIssues.length) action = 'conflict';
    const usedQueries = [pathQuery, idQuery, parentQuery].filter(Boolean);
    const row = {
      kind: node.kind,
      targetItemId: node.id,
      targetPath: node.path,
      templateId: node.templateId,
      parentPath: node.parent,
      action,
      beforeFingerprint: usedQueries.length ? beforeFingerprint(evidence, usedQueries) : null,
      parentItemId: plannedParent?.id ?? parentQuery?.item?.id ?? null,
      changes,
      versionsToCreate,
      deferredFields: node.fields
        .filter((f) => deferred.has(fieldKey(f)))
        .map((f) => ({
          fieldId: f.fieldId,
          storage: f.storage,
          ...(f.language ? { language: f.language } : {}),
          ...(f.version ? { version: f.version } : {}),
        })),
      issues: localIssues,
    };
    rows.push(row);
  }
  if (byPath.size !== nodes.length)
    issues.push({
      code: 'collision',
      message: 'Duplicate planned target path',
      targetPath: evidence.rootPath,
    });
  const batches = [];
  if (!issues.length) {
    const operations = rows
      .filter((r) => ['create', 'update'].includes(r.action))
      .map((r) => ({
        operationId: 'op-' + hash(canonical([normalizeId(r.targetItemId), r.action])).slice(0, 24),
        kind: r.kind,
        action: r.action,
        targetItemId: r.targetItemId,
        targetPath: r.targetPath,
        templateId: r.templateId,
        parentItemId: r.parentItemId,
        beforeFingerprint: r.beforeFingerprint,
        versionsToCreate: r.versionsToCreate,
        fields: r.changes.map((c) => ({
          fieldId: c.fieldId,
          storage: c.storage,
          value: c.after,
          ...(c.language ? { language: c.language } : {}),
          ...(c.version ? { version: c.version } : {}),
        })),
        dependsOn: [],
      }));
    const byOperationPath = new Map(operations.map((o) => [normalizeId(o.targetPath), o]));
    for (const op of operations) {
      const parent = byOperationPath.get(normalizeId(parentPath(op.targetPath)));
      if (parent) op.dependsOn.push(parent.operationId);
    }
    let batch = { batchId: 'batch-0001', operations: [] };
    for (const op of operations) {
      const candidate = { ...batch, operations: [...batch.operations, op] };
      if (candidate.operations.length > maxItems || Buffer.byteLength(jsonBytes(candidate)) > maxBytes) {
        if (batch.operations.length) batches.push(batch);
        batch = { batchId: `batch-${String(batches.length + 1).padStart(4, '0')}`, operations: [] };
      }
      if (Buffer.byteLength(jsonBytes({ ...batch, operations: [op] })) > maxBytes) {
        issues.push({
          code: 'batch-size',
          message: 'One operation exceeds maxBatchBytes; review a smaller approved item/field scope',
          targetPath: op.targetPath,
        });
        break;
      }
      batch.operations.push(op);
    }
    if (batch.operations.length) batches.push(batch);
  }
  return {
    ready: issues.length === 0,
    rows,
    issues,
    gaps: [...gaps.values()],
    batches: issues.length ? [] : batches,
    exclusions: report.exclusions ?? [],
    referencesPending: (report.referenceDependencies?.length ?? 0) > 0,
    referenceDependencies: report.referenceDependencies ?? [],
    deferredParameters: report.deferredParameters ?? [],
  };
}
