import { requireSchema } from './schema.mjs';
import { normalizeId, fail, hash } from './files.mjs';
import { fieldKey } from './snapshot.mjs';
import { inside } from './transform-paths.mjs';

export const canonical = (value) => JSON.stringify(stable(value));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
export const queryKey = (lookup, value) => lookup + '|' + normalizeId(value);
export function canonicalItem(item) {
  return {
    ...item,
    id: normalizeId(item.id),
    templateId: normalizeId(item.templateId),
    path: normalizeId(item.path),
    versions: [...item.versions].sort((a, b) => canonical(a).localeCompare(canonical(b))),
    fields: item.fields
      .map((f) => ({ ...f, fieldId: normalizeId(f.fieldId) }))
      .sort((a, b) => fieldKey(a).localeCompare(fieldKey(b))),
  };
}
export function indexTargetState(evidence) {
  requireSchema('targetState', evidence);
  if (!Number.isFinite(Date.parse(evidence.capturedAt)) || !/(Z|[+-]\d\d:\d\d)$/.test(evidence.capturedAt))
    throw fail('timestamp', 'targetState', 'Expected a capture timestamp with timezone');
  const queries = new Map(),
    ids = new Map(),
    paths = new Map();
  for (const query of evidence.queries) {
    const key = queryKey(query.lookup, query.value);
    if (queries.has(key)) throw fail('duplicate', key, 'Repeated target lookup');
    queries.set(key, query);
    if (!query.exists) continue;
    const item = query.item;
    if (
      !inside(evidence.rootPath, item.path) ||
      /[\\{}:*?"<>|\[\]\x00-\x1f]/.test(item.path) ||
      item.path
        .split('/')
        .slice(1)
        .some((p) => !p || p === '.' || p === '..')
    )
      throw fail('target-scope', key, 'Target item is outside scope or has an unsafe path');
    if (normalizeId(query.value) !== normalizeId(query.lookup === 'id' ? item.id : item.path))
      throw fail('identity', key, 'Lookup identity differs from result');
    if (
      new Set(item.versions.map((v) => `${v.language}|${v.version}`)).size !== item.versions.length ||
      new Set(item.fields.map(fieldKey)).size !== item.fields.length
    )
      throw fail('duplicate', key, 'Repeated target field/version');
    for (const field of item.fields) {
      const valid =
        field.storage === 'shared'
          ? field.language === undefined && field.version === undefined
          : field.storage === 'unversioned'
            ? field.language !== undefined && field.version === undefined
            : field.language !== undefined && field.version !== undefined;
      if (
        !valid ||
        (field.present &&
          field.storage === 'versioned' &&
          !item.versions.some((v) => v.language === field.language && v.version === field.version))
      )
        throw fail('field-scope', key, 'Observed field storage/version is inconsistent');
    }
    const normalized = canonical(canonicalItem(item));
    for (const [map, value] of [
      [ids, normalizeId(item.id)],
      [paths, normalizeId(item.path)],
    ]) {
      if (map.has(value) && map.get(value) !== normalized)
        throw fail('target-state', key, 'Contradictory target observations');
      map.set(value, normalized);
    }
  }
  for (const query of evidence.queries)
    if (!query.exists && (query.lookup === 'id' ? ids : paths).has(normalizeId(query.value)))
      throw fail('target-state', query.value, 'Contradictory existence observations');
  return queries;
}
export function beforeFingerprint(evidence, queries) {
  return hash(
    canonical({
      instanceId: evidence.instanceId,
      database: evidence.database,
      rootPath: evidence.rootPath,
      targetStateId: evidence.targetStateId,
      queries: queries
        .map((q) => ({
          lookup: q.lookup,
          value: normalizeId(q.value),
          exists: q.exists,
          ...(q.exists ? { item: canonicalItem(q.item) } : {}),
        }))
        .sort((a, b) => queryKey(a.lookup, a.value).localeCompare(queryKey(b.lookup, b.value))),
    }),
  );
}
