import { indexTargetState, canonical, canonicalItem, queryKey } from './target-state.mjs';
import { normalizeId, fail } from './files.mjs';
import { fieldKey } from './snapshot.mjs';
import { parentPath } from './transform-paths.mjs';

export const same = (a, b) => normalizeId(a) === normalizeId(b);
export function assertObservation(actual, expected, label) {
  if (
    !actual ||
    actual.exists !== expected.exists ||
    actual.lookup !== expected.lookup ||
    !same(actual.value, expected.value)
  )
    throw fail('target-drift', label, 'Target existence or lookup identity differs from reviewed state');
  if (expected.exists && canonical(canonicalItem(actual.item)) !== canonical(canonicalItem(expected.item)))
    throw fail('target-drift', label, 'Target identity, captured versions or field values changed');
}
export function expectedPost(operation, actual, structuralLanguage) {
  const before = actual?.exists ? actual.item : undefined;
  const fields = new Map((before?.fields ?? []).map((f) => [fieldKey(f), f]));
  for (const f of operation.fields) {
    const { value, ...selector } = f;
    fields.set(fieldKey(f), { ...selector, present: true, value });
  }
  const versions = new Map((before?.versions ?? []).map((v) => [`${v.language}|${v.version}`, v]));
  for (const v of operation.versionsToCreate) versions.set(`${v.language}|${v.version}`, v);
  if (operation.action === 'create' && operation.kind === 'folder')
    versions.set(`${structuralLanguage}|1`, { language: structuralLanguage, version: 1 });
  return {
    id: operation.targetItemId,
    templateId: operation.templateId,
    path: operation.targetPath,
    versionsComplete: true,
    versions: [...versions.values()],
    fields: [...fields.values()],
  };
}
export function assertContiguousVersions(operation, actual) {
  const before = actual?.exists ? actual.item.versions : [];
  const languages = [...new Set(operation.versionsToCreate.map((v) => v.language))];
  for (const language of languages) {
    const existing = before.filter((v) => v.language === language).map((v) => v.version),
      wanted = operation.versionsToCreate
        .filter((v) => v.language === language)
        .map((v) => v.version)
        .sort((a, b) => a - b);
    const max = Math.max(0, ...existing);
    if (wanted.some((v, i) => v !== max + i + 1))
      throw fail(
        'version-gap',
        operation.targetPath,
        'Only exact contiguous version appends are supported; review version policy before mutation',
      );
  }
  if (
    operation.action === 'create' &&
    operation.kind === 'content' &&
    !operation.versionsToCreate.some((v) => v.version === 1)
  )
    throw fail(
      'version-gap',
      operation.targetPath,
      'New content requires an explicitly approved initial language/version',
    );
}

export function selectExecutionGuards({ batchPlan, dryRun, batch, evidence, baseline, checkpoint, marker }) {
  const current = indexTargetState(evidence),
    initial = indexTargetState(baseline);
  const rows = new Map(dryRun.rows.map((r) => [normalizeId(r.targetPath), r]));
  const previous = checkpoint.operations.filter((o) => o.batchPlanSha256 === dryRun.batchPlanSha256);
  const latest = new Map(previous.map((o) => [normalizeId(o.targetItemId), o]));
  const needed = new Map(),
    knownSuccess = [],
    pending = [];
  const remember = (prior) => {
    if (prior?.status === 'success' && !knownSuccess.some((o) => o.operationId === prior.operationId))
      knownSuccess.push({
        operationId: prior.operationId,
        targetItemId: prior.targetItemId,
        targetPath: prior.targetPath,
        templateId: prior.templateId,
        post: prior.post,
      });
  };
  const add = (lookup, value) => {
    const key = queryKey(lookup, value);
    if (needed.has(key)) return;
    const prior =
      lookup === 'id'
        ? latest.get(normalizeId(value))
        : [...latest.values()].find((o) => same(o.targetPath, value));
    const original = initial.get(key);
    const expected =
      prior?.status === 'success' && prior.post
        ? { lookup, value, exists: true, item: prior.post }
        : original;
    if (!expected)
      throw fail('target-evidence', value, 'Missing original or verified dependency observation');
    const actual = current.get(key);
    assertObservation(actual, expected, value);
    needed.set(key, actual);
  };
  for (const operation of batch.operations) {
    const prior = latest.get(normalizeId(operation.targetItemId));
    if (prior?.mutated && prior.status !== 'success')
      throw fail(
        'partial-effect',
        operation.targetPath,
        'Partial effects require fresh target comparison and a reviewed new plan',
      );
    add('id', operation.targetItemId);
    add('path', operation.targetPath);
    let parent = parentPath(operation.targetPath);
    const visited = new Set();
    while (rows.has(normalizeId(parent))) {
      if (visited.has(normalizeId(parent))) throw fail('parent-cycle', parent, 'Planned parent cycle');
      visited.add(normalizeId(parent));
      const row = rows.get(normalizeId(parent));
      const inBatch = batch.operations.some((o) => same(o.targetItemId, row.targetItemId));
      const done = latest.get(normalizeId(row.targetItemId));
      if (!inBatch && row.action !== 'reuse' && done?.status !== 'success')
        throw fail('dependency', parent, 'Parent batch has not completed successfully');
      add('id', row.targetItemId);
      add('path', row.targetPath);
      parent = row.parentPath;
      if (!inBatch) remember(done);
    }
    if (parent !== evidence.rootPath || current.has(queryKey('path', parent))) add('path', parent);
    for (const dependency of operation.dependsOn)
      if (!batch.operations.some((o) => o.operationId === dependency)) {
        const done = previous.findLast((o) => o.operationId === dependency);
        if (done?.status !== 'success')
          throw fail('dependency', dependency, 'Required operation is not confirmed successful');
        add('id', done.targetItemId);
        add('path', done.targetPath);
        remember(done);
      }
    if (prior?.status === 'success') remember(prior);
    else {
      const actual = current.get(queryKey('id', operation.targetItemId));
      assertContiguousVersions(operation, actual);
      pending.push({
        ...operation,
        expectedPost: expectedPost(operation, actual, marker.structuralLanguage),
      });
    }
  }
  const rootQuery = current.get(queryKey('path', evidence.rootPath));
  if (
    !rootQuery?.exists ||
    !same(rootQuery.item.id, marker.id) ||
    !same(rootQuery.item.templateId, marker.templateId)
  )
    throw fail(
      'target-marker',
      evidence.rootPath,
      'Current exact target-root marker observation is required',
    );
  needed.set(queryKey('path', evidence.rootPath), rootQuery);
  return { guards: [...needed.values()], operations: pending, knownSuccess };
}
