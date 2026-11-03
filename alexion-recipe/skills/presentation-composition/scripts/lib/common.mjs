import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Ajv from '../../../cms-migration/scripts/lib/vendor/ajv.mjs';
import { validate as cmsSchema } from '../../../cms-migration/scripts/contracts.mjs';
import { validateSchema as contentSchema } from '../../../mapped-content-migration/scripts/lib/schema.mjs';
export {
  hash,
  jsonBytes,
  readJSON,
  readArtifactJSON,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
} from '../../../cms-migration/scripts/lib/files.mjs';
import {
  hash,
  jsonBytes,
  readJSON,
  readArtifactJSON,
  scopedPath,
  MAX_JSON_BYTES,
  freshDirectory,
  writeNewJSON,
} from '../../../cms-migration/scripts/lib/files.mjs';

export const definitions = JSON.parse(
  readFileSync(new URL('../../contracts/definitions.schema.json', import.meta.url), 'utf8'),
);
export const websiteDefinitions = JSON.parse(
  readFileSync(new URL('../../contracts/website.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(definitions);
ajv.addSchema(websiteDefinitions);
const validators = new Map();
export function requireSchema(name, value) {
  if (!Object.hasOwn(definitions.$defs, name)) throw Error('Unknown presentation contract: ' + name);
  if (!validators.has(name)) validators.set(name, ajv.compile({ $ref: definitions.$id + '#/$defs/' + name }));
  const validate = validators.get(name);
  if (!validate(value)) throw Error(name + ': ' + ajv.errorsText(validate.errors));
  return value;
}
export const id = (value) => String(value).replace(/[{}]/g, '').toLowerCase();
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  return Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sort(value[key])]),
        )
      : value;
}
export const equal = (a, b) => canonical(a) === canonical(b);
export function unique(rows, key, label) {
  const values = rows.map(key);
  if (new Set(values).size !== values.length) throw Error('Repeated ' + label);
}
export function routeFile(route) {
  if (typeof route !== 'string' || !route.startsWith('/') || /[\\?#%\x00-\x20:<>"|*]/.test(route))
    throw Error('Unsafe route: ' + route);
  const parts = route === '/' ? ['home'] : route.slice(1).split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw Error('Unsafe route: ' + route);
  return parts.join('/') + '/index.json';
}
export function plannedUid(seed) {
  const bytes = hash(seed).slice(0, 32).split('');
  bytes[12] = '5';
  bytes[16] = '8';
  const s = bytes.join('');
  return `{${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}}`;
}
export async function decisionInputs(decision, base) {
  await cmsSchema('decision', decision);
  unique(decision.inputs, (row) => row.path, 'decision input path');
  const refs = [];
  for (const ref of decision.inputs) {
    const path = await scopedPath(base, ref.path),
      bytes = await readFile(path);
    if (bytes.length > MAX_JSON_BYTES || hash(bytes) !== ref.sha256)
      throw Error('Decision input is stale: ' + ref.path);
    refs.push({ path, sha256: ref.sha256 });
  }
  return refs;
}
export async function loadComposition(inputPath) {
  const request = await readJSON(inputPath),
    input = requireSchema('compositionInput', request.value),
    base = dirname(inputPath);
  const artifacts = {},
    refs = [{ path: inputPath, sha256: request.sha256 }];
  for (const role of [
    'source',
    'target',
    'mapping',
    'rules',
    'identities',
    'targetData',
    'mappingApproval',
  ]) {
    artifacts[role] = await readArtifactJSON(base, input[role]);
    refs.push({ path: artifacts[role].path, sha256: input[role].sha256 });
  }
  const documents = Object.fromEntries(Object.entries(artifacts).map(([key, a]) => [key, a.value]));
  for (const [role, schema] of Object.entries({
    source: 'source',
    target: 'target',
    rules: 'rules',
    identities: 'identities',
    targetData: 'data',
  })) {
    requireSchema(schema, documents[role]);
    if (documents[role].scopeId !== input.scopeId) throw Error('Wrong ' + role + ' scope');
  }
  if (contentSchema('mapping', documents.mapping).length) throw Error('Invalid approved Sitecore mapping');
  const { source, target, targetData: data, identities, mappingApproval: approval } = documents;
  if (
    target.instanceId !== data.instanceId ||
    identities.targetInstanceId !== target.instanceId ||
    target.database !== data.database ||
    identities.database !== target.database ||
    target.stateId !== data.stateId
  )
    throw Error('Target data/definition/identity cohort differs');
  for (const key of ['siteName', 'language', 'itemVersion', 'deviceId'])
    if (key === 'deviceId' ? id(target[key]) !== id(data[key]) : target[key] !== data[key])
      throw Error('Target context differs: ' + key);
  if (source.language !== target.language || source.itemVersion !== target.itemVersion)
    throw Error('Language/version conversion requires an explicit supported adapter');
  const captured = Date.parse(data.capturedAt),
    expires = Date.parse(data.expiresAt);
  if (
    !Number.isFinite(captured) ||
    !Number.isFinite(expires) ||
    captured > Date.now() ||
    expires <= Date.now() ||
    expires <= captured
  )
    throw Error('Target preview data is stale or has invalid capture times');
  refs.push(...(await decisionInputs(approval, base)));
  const choices = ['mapping', 'rules'].map((role) => input[role]);
  if (
    approval.kind !== 'mapping' ||
    approval.choice !== 'approve' ||
    approval.scopeId !== input.scopeId ||
    !approval.userResponse?.trim() ||
    !Number.isFinite(Date.parse(approval.at)) ||
    Date.parse(approval.at) > Date.now() ||
    !Array.isArray(approval.inputs) ||
    choices.some((ref) => !approval.inputs.some((row) => equal(row, ref))) ||
    approval.inputs.some((ref) => !Object.values(input).some((row) => equal(row, ref)))
  )
    throw Error('Mapping approval must bind current mapping and composition rules');
  for (const role of ['source', 'target', 'targetData', 'identities'])
    for (const ref of documents[role].evidence) {
      const path = await scopedPath(dirname(artifacts[role].path), ref.path),
        bytes = await readFile(path);
      if (bytes.length > MAX_JSON_BYTES || hash(bytes) !== ref.sha256)
        throw Error('Stale ' + role + ' capture evidence');
      refs.push({ path, sha256: ref.sha256 });
    }
  return { input, documents, artifacts, refs, inputPath, inputSha256: request.sha256 };
}
export async function recheck(refs) {
  for (const ref of refs) {
    const bytes = await readFile(ref.path);
    if (bytes.length > MAX_JSON_BYTES || hash(bytes) !== ref.sha256)
      throw Error('Input changed during operation: ' + ref.path);
  }
}
export async function publish(outputPath, outputs, refs) {
  await recheck(refs);
  for (const value of Object.values(outputs))
    if (Buffer.byteLength(jsonBytes(value)) > MAX_JSON_BYTES)
      throw Error('Output exceeds JSON byte limit; reduce the explicit scope');
  const output = await freshDirectory(outputPath);
  for (const [name, value] of Object.entries(outputs)) await writeNewJSON(join(output, name), value);
}
export async function cli(operation) {
  try {
    const args = process.argv.slice(2),
      options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (
        !['--input', '--output'].includes(args[i]) ||
        options[args[i]] ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw Error('Use --input request.json --output fresh-directory');
      options[args[i]] = args[i + 1];
    }
    if (!options['--input'] || !options['--output'])
      throw Error('Use --input request.json --output fresh-directory');
    const report = await operation(options['--input'], options['--output']);
    console.log(JSON.stringify(report));
    process.exitCode = report.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ ready: false, errors: [error.message] }));
    process.exitCode = 1;
  }
}
