const guid = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const norm = (x) => String(x).trim().toLowerCase();
const lists = new Set(['multilist', 'multilist with search', 'checklist', 'treelist', 'treelistex']);
const singles = new Set(['internal link', 'droplink', 'droptree', 'grouped droplink']);
const xmlCodePoint = (n) =>
  n === 9 ||
  n === 10 ||
  n === 13 ||
  (n >= 32 && n <= 0xd7ff) ||
  (n >= 0xe000 && n <= 0xfffd) ||
  (n >= 0x10000 && n <= 0x10ffff);
function validXmlAttribute(value) {
  if (
    [...value].some((c) => !xmlCodePoint(c.codePointAt(0))) ||
    value.includes('<') ||
    /&(?!amp;|lt;|gt;|apos;|quot;|#\d+;|#x[0-9a-fA-F]+;)/.test(value)
  )
    return false;
  return [...value.matchAll(/&#(x[0-9a-fA-F]+|\d+);/g)].every((m) =>
    xmlCodePoint(m[1][0] === 'x' ? parseInt(m[1].slice(1), 16) : Number(m[1])),
  );
}
export const referenceKindForType = (type) => {
  const t = norm(type);
  return t === 'image' || t === 'file'
    ? 'media'
    : t === 'general link' || t === 'general link with search'
      ? 'link'
      : lists.has(t)
        ? 'list'
        : singles.has(t)
          ? 'datasource'
          : undefined;
};

/** Conservative accepted forms; no conversion, XML rewriting or HTML parsing. */
export function referenceFormatMatches(ref, value, targetType) {
  const expected = referenceKindForType(targetType),
    ids = ref.targetSourceIds.map(norm);
  if (
    expected &&
    ref.kind !== expected &&
    !(['datasource', 'list'].includes(expected) && ['datasource', 'list'].includes(ref.kind))
  )
    return false;
  if (value === '') return ids.length === 0;
  if (ref.kind === 'list' || ref.kind === 'datasource') {
    const tokens = value.split('|');
    return (
      ((expected !== 'datasource' && ref.kind !== 'datasource') || tokens.length === 1) &&
      tokens.every((t) => guid.test(t)) &&
      tokens.length === ids.length &&
      tokens.every((t, i) => norm(t) === ids[i])
    );
  }
  const tag = ref.kind === 'link' ? 'link' : norm(targetType) === 'file' ? 'file' : 'image';
  const match = value.match(
    new RegExp(
      `^\\s*<${tag}((?:\\s+[a-zA-Z_][a-zA-Z0-9_.-]*\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*\\/>\\s*$`,
      'i',
    ),
  );
  if (!match) return false;
  const attributes = [...match[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
  if (
    new Set(attributes.map((a) => a[1])).size !== attributes.length ||
    attributes.some((a) => !validXmlAttribute(a[2] ?? a[3]))
  )
    return false;
  const name = ref.kind === 'link' ? 'id' : 'mediaid',
    id = attributes.find((a) => a[1] === name);
  const target = id?.[2] ?? id?.[3] ?? '';
  return target === '' ? ids.length === 0 : guid.test(target) && ids.length === 1 && norm(target) === ids[0];
}

export function checkTypeCompatibility(
  value,
  definition,
  rule,
  sourceTemplateId,
  targetTemplateId,
  decisions,
  issue,
) {
  const decision = decisions.find(
    (d) =>
      norm(d.sourceTemplateId) === norm(sourceTemplateId) &&
      norm(d.sourceFieldId) === norm(rule.sfid) &&
      norm(d.targetTemplateId) === norm(targetTemplateId) &&
      norm(d.targetFieldId) === norm(definition.id),
  );
  if (
    decision &&
    (norm(decision.targetType) !== norm(definition.type) ||
      (value.fieldType && norm(decision.sourceType) !== norm(value.fieldType)))
  ) {
    issue('field-type', 'Compatibility decision disagrees with captured field types');
    return;
  }
  if (!value.fieldType && !decision)
    issue(
      'field-type-evidence',
      `Missing source type or approved raw-compatibility decision for ${rule.sfid}`,
    );
  else if (norm(value.fieldType ?? decision.sourceType) !== norm(definition.type) && !decision)
    issue('field-type', `Unsupported field-type conversion to ${definition.type}`);
}
