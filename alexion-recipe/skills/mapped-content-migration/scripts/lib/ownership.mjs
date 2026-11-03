import { normalizeId } from './files.mjs';
import { fieldKey } from './snapshot.mjs';
import { referenceFormatMatches } from './field-compatibility.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const edgeKey = (child, owner, field) => [child, owner, field].map(normalizeId).join('|');

/** Derive ownership only from direct occurrences or explicit approved rules. */
export async function createOwnershipResolver(snapshot, index, destination, pages, issue) {
  const rules = new Map((destination.ownershipRules ?? []).map((r) => [normalizeId(r.sourceItemId), r]));
  const references = new Set(),
    cache = new Map();
  const referenceRules = [...rules.values()].filter((r) => r.via === 'source-reference');
  if (referenceRules.length)
    for await (const record of snapshot.records()) {
      if (record.kind !== 'item') continue;
      for (const rule of referenceRules.filter((r) => same(r.ownerItemId, record.data.id))) {
        for (const ref of record.data.references.filter(
          (r) => same(r.fieldId, rule.fieldId) && r.targetSourceIds.some((id) => same(id, rule.sourceItemId)),
        )) {
          const field = record.data.fields.find((f) => fieldKey(f) === fieldKey(ref));
          if (field && referenceFormatMatches(ref, field.value, field.fieldType ?? ''))
            references.add(edgeKey(rule.sourceItemId, rule.ownerItemId, rule.fieldId));
        }
      }
    }
  function resolve(id, active = new Set()) {
    const key = normalizeId(id);
    if (active.has(key)) {
      issue('ownership-cycle', `Ownership rules form a cycle at ${id}`);
      return [];
    }
    if (cache.has(key)) return cache.get(key);
    const source = index.items.get(key);
    if (!source) {
      issue('ownership-source', `Missing captured ownership item ${id}`);
      return [];
    }
    const direct = pages.has(key)
      ? [key]
      : [
          ...new Set(
            index.contexts
              .filter((c) => same(c.datasourceId, id) && pages.has(normalizeId(c.pageId)))
              .map((c) => normalizeId(c.pageId)),
          ),
        ].sort();
    const rule = rules.get(key);
    if (!rule) {
      cache.set(key, direct);
      return direct;
    }
    active = new Set(active);
    active.add(key);
    let derived = [];
    if (rule.via === 'explicit-pages') {
      if (rule.pageIds.some((p) => !pages.has(normalizeId(p))))
        issue('ownership-page', `Ownership for ${id} selects an excluded, missing or unsupported page`);
      else derived = [...new Set(rule.pageIds.map(normalizeId))].sort();
    } else if (rule.via === 'source-ancestor') {
      let parent = source.parentId,
        found = false;
      const visited = new Set([key]);
      while (parent) {
        const p = normalizeId(parent);
        if (visited.has(p)) break;
        visited.add(p);
        if (same(parent, rule.ancestorItemId)) {
          found = index.items.has(p);
          break;
        }
        parent = index.items.get(p)?.parentId;
      }
      if (!found)
        issue(
          'ownership-ancestor',
          `Captured parent chain does not prove ancestor ${rule.ancestorItemId} for ${id}`,
        );
      else derived = resolve(rule.ancestorItemId, active);
    } else {
      if (!references.has(edgeKey(id, rule.ownerItemId, rule.fieldId)))
        issue(
          'ownership-reference',
          `Missing supported captured reference from ${rule.ownerItemId} to ${id}`,
        );
      else derived = resolve(rule.ownerItemId, active);
    }
    derived = [...new Set(derived)].sort();
    if (direct.length && JSON.stringify([...direct].sort()) !== JSON.stringify(derived)) {
      issue('ownership-conflict', `Explicit ownership for ${id} disagrees with captured consuming pages`);
      derived = [];
    }
    if (!derived.length)
      issue('ownership-unresolved', `No approved consuming page could be resolved for ${id}`);
    cache.set(key, derived);
    return derived;
  }
  return (source) => resolve(source.id);
}
