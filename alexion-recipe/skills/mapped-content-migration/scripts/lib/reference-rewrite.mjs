import { fail } from './files.mjs';
import { referenceFormatMatches, referenceKindForType } from './field-compatibility.mjs';

const guid = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const zero = '{00000000-0000-0000-0000-000000000000}';
const validId = (value) => typeof value === 'string' && guid.test(value) && value.toLowerCase() !== zero;
const kinds = new Set(['datasource', 'list', 'link', 'media']);

/** Rewrite only validated reference slots; preserve all surrounding raw bytes. */
export function rewriteReference(ref, rawValue, targetType, targetIds) {
  const reject = (message) => {
    throw fail('reference-rewrite', 'reference', message);
  };
  if (
    !ref ||
    !kinds.has(ref.kind) ||
    !Array.isArray(ref.targetSourceIds) ||
    !Array.isArray(targetIds) ||
    typeof rawValue !== 'string' ||
    typeof targetType !== 'string' ||
    !referenceKindForType(targetType)
  )
    reject('Expected a supported reference kind, raw string, field type and ordered IDs');
  if (
    ref.targetSourceIds.length !== targetIds.length ||
    !ref.targetSourceIds.every(validId) ||
    !targetIds.every(validId)
  )
    reject('Reference IDs must be nonzero braced GUIDs with matching source and target counts');
  if (!referenceFormatMatches(ref, rawValue, targetType))
    reject('Raw reference does not match the supported source format and ordered IDs');

  let rewritten = rawValue;
  if (targetIds.length) {
    if (ref.kind === 'list' || ref.kind === 'datasource') rewritten = targetIds.join('|');
    else {
      const name = ref.kind === 'link' ? 'id' : 'mediaid';
      // Match complete attributes, including quoted values, so GUIDs or names
      // embedded in another attribute cannot become replacement slots.
      const attribute = [
        ...rawValue.matchAll(/([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
      ].find((m) => m[1] === name);
      if (!attribute) reject('Validated reference has no supported ID attribute');
      const offset = attribute.index + attribute[0].search(/["']/) + 1;
      const length = (attribute[2] ?? attribute[3]).length;
      rewritten = rawValue.slice(0, offset) + targetIds[0] + rawValue.slice(offset + length);
    }
  }
  if (!referenceFormatMatches({ ...ref, targetSourceIds: targetIds }, rewritten, targetType))
    reject('Rewritten reference does not match the supported target format and ordered IDs');
  return rewritten;
}
