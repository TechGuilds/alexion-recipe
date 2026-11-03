// Deliberately small, fail-closed JSON Schema 2020-12 evaluator for these local contracts.
// Every keyword used by a schema is audited before data is accepted.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/contracts');
const keywords = new Set(['$schema', '$id', '$defs', 'title', 'description', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const', 'minLength', 'pattern', 'minimum']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validateLocalSchema(file, value, { directory = contractsDirectory } = {}) {
  const documents = new Map();
  const read = name => {
    if (!/^[a-z][a-z0-9-]*\.schema\.json$/.test(name) || basename(name) !== name) throw new Error('Only local contract schema filenames are allowed');
    if (!documents.has(name)) documents.set(name, JSON.parse(readFileSync(resolve(directory, name), 'utf8')));
    return documents.get(name);
  };
  function reference(ref, currentFile) {
    if (typeof ref !== 'string') throw new Error('Malformed schema $ref');
    const [name, fragment, ...extra] = ref.split('#');
    if (extra.length || (fragment && !fragment.startsWith('/'))) throw new Error('Unsupported schema reference');
    const targetFile = name || currentFile;
    let target = read(targetFile);
    for (const part of fragment?.slice(1).split('/') ?? []) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!record(target) || !Object.hasOwn(target, key)) throw new Error(`Unresolved schema reference: ${ref}`);
      target = target[key];
    }
    return [target, targetFile];
  }
  const audited = new Set();
  function audit(schema, currentFile) {
    if (typeof schema === 'boolean' || audited.has(schema)) return;
    if (!record(schema)) throw new Error('Malformed schema node');
    audited.add(schema);
    for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).every(t => types.has(t))) throw new Error('Unsupported schema type');
    if (schema.$schema !== undefined && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('Unsupported schema dialect');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string'))) throw new Error('Malformed required keyword');
    if (schema.pattern !== undefined) new RegExp(schema.pattern, 'u');
    if (schema.minLength !== undefined && (!Number.isInteger(schema.minLength) || schema.minLength < 0)) throw new Error('Malformed minLength keyword');
    if (schema.minimum !== undefined && !Number.isFinite(schema.minimum)) throw new Error('Malformed minimum keyword');
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error('Malformed enum keyword');
    for (const key of ['properties', '$defs']) if (schema[key] !== undefined) {
      if (!record(schema[key])) throw new Error(`Malformed ${key} keyword`);
      for (const child of Object.values(schema[key])) audit(child, currentFile);
    }
    for (const key of ['items', 'additionalProperties']) if (schema[key] !== undefined) audit(schema[key], currentFile);
    if (schema.anyOf !== undefined) {
      if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) throw new Error('Malformed anyOf keyword');
      for (const child of schema.anyOf) audit(child, currentFile);
    }
    if (schema.$ref !== undefined) audit(...reference(schema.$ref, currentFile));
  }
  const matches = (type, data) => type === 'null' ? data === null : type === 'object' ? record(data) : type === 'array' ? Array.isArray(data) : type === 'integer' ? Number.isInteger(data) : type === 'number' ? typeof data === 'number' && Number.isFinite(data) : typeof data === type;
  function check(schema, data, currentFile, path) {
    const fail = reason => { throw new Error(`${path}: ${reason}`); };
    if (schema === false) fail('value is forbidden');
    if (schema === true) return;
    if (schema.$ref !== undefined) { const [target, targetFile] = reference(schema.$ref, currentFile); check(target, data, targetFile, path); }
    if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => matches(t, data))) fail(`expected ${JSON.stringify(schema.type)}`);
    if (Object.hasOwn(schema, 'const') && !equal(schema.const, data)) fail(`expected constant ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some(v => equal(v, data))) fail('unknown enum value');
    if (schema.anyOf && !schema.anyOf.some(child => { try { check(child, data, currentFile, path); return true; } catch { return false; } })) fail('does not match any allowed shape');
    if (typeof data === 'string') {
      if (schema.minLength !== undefined && [...data].length < schema.minLength) fail('string is too short');
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(data)) fail('string does not match pattern');
    }
    if (typeof data === 'number' && schema.minimum !== undefined && data < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (Array.isArray(data) && schema.items !== undefined) data.forEach((item, i) => check(schema.items, item, currentFile, `${path}[${i}]`));
    if (record(data)) {
      for (const key of schema.required ?? []) if (!Object.hasOwn(data, key)) fail(`missing required property ${key}`);
      for (const [key, entry] of Object.entries(data)) {
        if (Object.hasOwn(schema.properties ?? {}, key)) check(schema.properties[key], entry, currentFile, `${path}.${key}`);
        else if (schema.additionalProperties === false) fail(`unknown property ${key}`);
        else if (schema.additionalProperties !== undefined) check(schema.additionalProperties, entry, currentFile, `${path}.${key}`);
      }
    }
  }
  const root = read(file);
  audit(root, file);
  check(root, value, file, '$');
  return value;
}
