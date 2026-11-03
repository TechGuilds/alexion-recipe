import { fieldKey } from './snapshot.mjs';
import { requiredFields } from './coverage.mjs';
import { normalizeId } from './files.mjs';
import { referenceFormatMatches, checkTypeCompatibility } from './field-compatibility.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const referenceTypes = new Set([
  'general link',
  'general link with search',
  'internal link',
  'droplink',
  'droptree',
  'grouped droplink',
  'multilist',
  'multilist with search',
  'checklist',
  'treelist',
  'treelistex',
  'image',
  'file',
]);
export function transformFields(source, group, template, issue, compatibility = []) {
  const fields = [],
    references = [],
    seen = new Set();
  for (const rule of group.fields) {
    if (rule.action === 'remove') continue;
    const definition = template.fields.find((f) => same(f.id, rule.tfid));
    if (!definition || !same(definition.declaringTemplateId, rule.targetTemplateId)) continue;
    const selectors = requiredFields(
      [{ fieldId: definition.id, storage: definition.storage }],
      source.versions,
    );
    const values =
      rule.action === 'set'
        ? selectors.map((s) => ({ ...s, value: rule.value }))
        : source.fields.filter((f) => same(f.fieldId, rule.sfid));
    if (!values.length) {
      issue('missing-value', `Missing mapped source field ${rule.sfid}`);
      continue;
    }
    if (values.some((f) => f.storage !== definition.storage)) {
      issue('storage', `Field ${rule.tfid} requires an explicit storage conversion rule`);
      continue;
    }
    for (const selector of selectors) {
      const value = values.find((v) => fieldKey({ ...v, fieldId: definition.id }) === fieldKey(selector));
      if (!value) {
        issue('missing-value', `Missing language/version value for ${rule.sfid ?? rule.tfid}`);
        continue;
      }
      const output = { ...selector, value: value.value },
        key = fieldKey(output);
      if (rule.action === 'map')
        checkTypeCompatibility(value, definition, rule, source.templateId, template.id, compatibility, issue);
      if (seen.has(key)) {
        issue('field-conflict', `Several mapping rows write ${rule.tfid}`);
        continue;
      }
      seen.add(key);
      fields.push(output);
      if (
        rule.action === 'set' &&
        referenceTypes.has(definition.type.trim().toLowerCase()) &&
        value.value !== ''
      )
        issue(
          'reference-evidence',
          `Nonempty constant for reference field ${rule.tfid} lacks approved target reference evidence`,
        );
      if (rule.action === 'map') {
        const refs = source.references.filter(
          (r) => same(r.fieldId, rule.sfid) && fieldKey({ ...r, fieldId: definition.id }) === key,
        );
        if (!refs.length && referenceTypes.has(definition.type.trim().toLowerCase()) && value.value !== '')
          issue(
            'reference-evidence',
            `Mapped reference field ${rule.sfid} requires captured reference evidence`,
          );
        if (refs.length > 1) issue('reference-conflict', `Several reference records describe ${rule.sfid}`);
        if (refs.length && !referenceFormatMatches(refs[0], value.value, definition.type))
          issue(
            'reference-format',
            `Reference kind/value does not fit ${definition.type}; an implemented conversion is required`,
          );
        if (refs.length)
          references.push({
            ...refs[0],
            fieldId: definition.id,
            sourceFieldId: rule.sfid,
            rawValue: value.value,
          });
      }
    }
  }
  fields.sort((a, b) => fieldKey(a).localeCompare(fieldKey(b)));
  return { fields, references };
}
