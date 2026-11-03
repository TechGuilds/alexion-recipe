import { readFileSync } from 'node:fs';
import Ajv2020 from '../../../cms-migration/scripts/lib/vendor/ajv.mjs';

export const definitions = JSON.parse(
  readFileSync(new URL('../../contracts/definitions.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(definitions);
const validators = new Map();
export function validateSchema(name, value) {
  if (!Object.hasOwn(definitions.$defs, name))
    return [{ code: 'schema', path: name, message: 'Unknown contract' }];
  if (!validators.has(name)) validators.set(name, ajv.compile({ $ref: `${definitions.$id}#/$defs/${name}` }));
  const validate = validators.get(name);
  if (validate(value)) return [];
  return validate.errors.map((e) => ({
    code: 'schema',
    path: name + e.instancePath,
    message: `${e.message}${e.params.additionalProperty ? ': ' + e.params.additionalProperty : ''}`,
  }));
}
export function requireSchema(name, value) {
  const errors = validateSchema(name, value);
  if (errors.length)
    throw Object.assign(new Error(errors[0].message), { code: 'schema', path: errors[0].path });
  return value;
}
