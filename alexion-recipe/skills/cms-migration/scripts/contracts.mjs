import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export const fingerprintInputs = inputs => digest(Buffer.from(JSON.stringify(
  [...inputs].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha256 }) => [path, sha256]),
), 'utf8'));
// The staged file's parent is the caller-selected read boundary. Canonicalize
// system aliases there, but never follow links inside that boundary.
function scopedParts(path) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe scoped path: ' + path);
  return path.split('/');
}
async function resolveScoped(base, path, finalKind) {
  let current = await realpath(base);
  const parts = scopedParts(path);
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    const stat = await lstat(current);
    const needsDirectory = i < parts.length - 1 || finalKind === 'directory';
    if (stat.isSymbolicLink() || (needsDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('Unsafe scoped ' + finalKind + ': ' + path);
  }
  return current;
}
export function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe ${label}: ${String(value)}`);
  }
  return value;
}
export async function readScoped(base, path) {
  const current = await resolveScoped(base, path, 'file');
  return readFile(current);
}
export const scopedDirectory = (base, path) => resolveScoped(base, path, 'directory');
export function templateForProfile(profileId) {
  if (typeof profileId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(profileId)) throw new Error('Invalid profile ID');
  return readJSON(new URL(`../assets/profiles/${profileId}/workflow.json`, import.meta.url));
}
export async function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    const [entry, modulePath] = await Promise.all([realpath(process.argv[1]), realpath(fileURLToPath(url))]);
    return process.platform === 'win32' ? entry.toLowerCase() === modulePath.toLowerCase() : entry === modulePath;
  } catch { return false; }
}
const schemaCache = new Map();
async function schema(name) {
  if (!schemaCache.has(name)) schemaCache.set(name, await readJSON(new URL('../assets/contracts/' + name, import.meta.url)));
  return schemaCache.get(name);
}

// Implements only the JSON Schema keywords used by our shipped contracts.
// The schemas are the runtime authority, so the CLI and external validators agree.
export async function validate(name, value) {
  async function walk(s, v, path) {
    if (s.$ref) return walk(await schema(s.$ref), v, path);
    if (s.anyOf) {
      for (const option of s.anyOf) { try { await walk(option, v, path); return; } catch {} }
      throw new Error(path + ': no matching contract');
    }
    const fail = message => { throw new Error(path + ': ' + message); };
    if ('const' in s && v !== s.const) fail('invalid constant');
    if (s.enum && !s.enum.includes(v)) fail('invalid value');
    if (s.type === 'null' && v !== null) fail('expected null');
    if (s.type === 'boolean' && typeof v !== 'boolean') fail('expected boolean');
    if (s.type === 'string') {
      if (typeof v !== 'string' || v.length < (s.minLength ?? 0) || (s.pattern && !new RegExp(s.pattern).test(v))) fail('invalid string');
    }
    if (s.type === 'array') {
      if (!Array.isArray(v) || v.length < (s.minItems ?? 0)) fail('invalid array');
      if (s.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length) fail('duplicate values');
      for (let i = 0; i < v.length; i++) await walk(s.items, v[i], path + '[' + i + ']');
    }
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected object');
      for (const key of s.required ?? []) if (!(key in v)) fail('missing ' + key);
      for (const key of Object.keys(v)) {
        if (s.properties?.[key]) await walk(s.properties[key], v[key], path + '.' + key);
        else if (s.additionalProperties === false) fail('unknown field ' + key);
      }
    }
  }
  await walk(await schema(name + '.schema.json'), value, name);
  return value;
}

export function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error('Duplicate ' + label);
}

async function planTasks(workflow, schemaName) {
  await validate(schemaName, workflow);
  unique(workflow.phases.map(p => p.id), 'phase IDs');
  const tasks = new Map(), phases = new Map();
  workflow.phases.forEach((phase, index) => phase.tasks.forEach(task => {
    if (tasks.has(task.id)) throw new Error('Duplicate task ID: ' + task.id);
    tasks.set(task.id, task); phases.set(task.id, index);
  }));
  const counts = new Map(), children = new Map([...tasks.keys()].map(id => [id, []]));
  for (const task of tasks.values()) {
    const optional = task.optionalDependsOn ?? [];
    if (optional.some(dep => task.dependsOn.includes(dep))) throw new Error(task.id + ': dependency cannot be both required and optional');
    const dependencies = [...task.dependsOn, ...optional];
    counts.set(task.id, dependencies.length);
    for (const dep of dependencies) {
      if (!tasks.has(dep)) throw new Error(task.id + ': missing dependency ' + dep);
      if (phases.get(dep) > phases.get(task.id)) throw new Error(task.id + ': dependency in later phase');
      children.get(dep).push(task.id);
    }
  }
  const ready = [...counts].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) for (const child of children.get(ready[i])) {
    counts.set(child, counts.get(child) - 1);
    if (counts.get(child) === 0) ready.push(child);
  }
  if (ready.length !== tasks.size) throw new Error('Dependency cycle');
  return tasks;
}

export const workflowTasks = workflow => planTasks(workflow, 'workflow');
export const workflowProposalTasks = proposal => planTasks(proposal, 'workflow-proposal');

export async function newPath(path) {
  const absolute = resolve(path);
  // Parent must already exist. Resolve it to catch aliases into source directories.
  const target = resolve(await realpath(dirname(absolute)), basename(absolute));
  try { await lstat(target); } catch (e) { if (e.code === 'ENOENT') return target; throw e; }
  throw new Error('Destination already exists: ' + target);
}
export function contains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
export async function writeNew(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

export async function cli(name, handler, extra = []) {
  try {
    const options = {};
    const booleanFlags = new Set(['dry-run', 'apply']);
    const allowed = new Set(['input', 'out', 'dry-run', ...extra]);
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i], key = arg.slice(2);
      if (!arg.startsWith('--') || !allowed.has(key) || key in options) throw new Error('Unknown or duplicate option: ' + arg);
      options[key] = booleanFlags.has(key) ? true : process.argv[++i];
      if (!options[key] || (typeof options[key] === 'string' && options[key].startsWith('--'))) throw new Error('Missing value: ' + arg);
    }
    if (!options.input) throw new Error('Usage: node ' + name + '.mjs --input staged.json [--out new-report.json]');
    if (options.apply && options['dry-run']) throw new Error('--apply conflicts with --dry-run');
    const inputPath = resolve(options.input), base = dirname(inputPath);
    const input = await validate(name + '-input', JSON.parse(await readScoped(base, basename(inputPath))));
    if (options.out) options.out = await newPath(options.out);
    const report = await handler(input, { base, options });
    if (options.out) await writeNew(options.out, report);
    console.log(JSON.stringify({ valid: report.valid !== false, ...(report.summary ?? {}), ...(options.out ? { output: options.out } : {}), errors: report.errors ?? [] }));
    process.exitCode = report.valid === false ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [error.message] }));
    process.exitCode = 1;
  }
}
