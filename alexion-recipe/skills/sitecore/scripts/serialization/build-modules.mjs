import { args, required, safe, separate, cmp, hash, readBytes, writeReport, run } from './core.mjs';
import { fileURLToPath } from 'node:url';

// Compiles a flat, approved Discovery item list into deterministic Sitecore
// CLI module configs. Each discovered item is a SingleItem include, so exactly
// one namespace owns it. Broad descendant scopes and generated exclusion rules
// would make ownership ambiguous; explicit reviewed input is safer and makes
// the inspection and transfer manifests comparable.
//
// Platform-looking paths are warnings only. Exclusion is a scope decision with
// evidence and approval, never a downstream automatic rewrite of the module.

const OOTB_MODULE_NAMES = [
  'experience accelerator', 'jss experience accelerator',
  'headless services', 'javascript services',
];

function validatePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/sitecore/')) throw Error(`Expected an absolute /sitecore/... path: ${p}`);
  if (p.slice(1).split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) throw Error(`Unsafe or malformed path: ${p}`);
}

function toTitleCase(kind) {
  const withSpaces = kind.replace(/([A-Z])/g, ' $1').trim();
  return withSpaces.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

function sanitizeForNamespace(str) {
  return str.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Derives a coarse kind from the path's root segment when the item omits one. */
function inferKind(path) {
  const [, root] = path.split('/').filter(Boolean);
  const known = { content: 'content', templates: 'template', layout: 'rendering', system: 'system' };
  return known[(root ?? '').toLowerCase()] ?? 'other';
}

/**
 * Grouping key = kind + up to 3 path segments after the root, mirroring the
 * historical compiler's organizational scheme (e.g. Templates.Project.MySite).
 * Purely for module naming/organization — has no bearing on overlap safety,
 * since every include is SingleItem regardless of which group it lands in.
 */
function groupingKey(path, kind) {
  const parts = path.split('/').filter(Boolean);
  if ((parts[0] ?? '').toLowerCase() !== 'sitecore') return toTitleCase(kind);
  const known = new Set(['content', 'templates', 'layout', 'system']);
  const root = (parts[1] ?? '').toLowerCase();
  if (!known.has(root)) return toTitleCase(kind);
  // A single leftover segment is just the site root under content/templates/etc
  // (e.g. /sitecore/content/Home) — no meaningful sub-grouping, so don't nest it.
  const sub = parts.slice(2, 5).map(sanitizeForNamespace).filter(Boolean);
  return sub.length >= 2 ? `${toTitleCase(kind)}.${sub.join('.')}` : toTitleCase(kind);
}

function ootbWarning(path) {
  const lower = path.toLowerCase();
  const hit = OOTB_MODULE_NAMES.find((name) => lower.includes('/' + name.replace(/ /g, ' ')) || lower.includes('/' + name.replace(/ /g, '-')));
  return hit ? { path, matched: hit } : null;
}

function buildFromIncludes(includes, legacyItems) {
  const byNamespace = new Map();
  const warnings = [];
  const seenPaths = new Set();
  const duplicates = [];

  for (const item of includes) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw Error('Each item must be an object');
    const keys = Object.keys(item);
    if (keys.some((k) => !['path', 'kind', 'scope'].includes(k))) throw Error(`Item has unsupported fields: ${keys.join(', ')}`);
    validatePath(item.path);
    if (item.kind !== undefined && typeof item.kind !== 'string') throw Error(`item.kind must be a string: ${item.path}`);
    if (item.scope !== undefined && !['SingleItem', 'ItemAndDescendants', 'DescendantsOnly'].includes(item.scope)) throw Error(`Unsupported item scope: ${item.scope}`);

    const key = item.path.toLowerCase();
    if (seenPaths.has(key)) { duplicates.push(item.path); continue; }
    seenPaths.add(key);

    const kind = item.kind ?? inferKind(item.path);
    const scope = item.scope ?? (legacyItems ? 'SingleItem' : 'ItemAndDescendants');
    const namespace = groupingKey(item.path, kind);
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
    byNamespace.get(namespace).push({ path: item.path, scope });

    const warning = ootbWarning(item.path);
    if (warning) warnings.push(warning);
  }

  const modules = [...byNamespace.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([namespace, entries]) => ({
      namespace,
      items: {
        path: namespace,
        includes: entries.sort((left, right) => cmp(left.path, right.path)).map(({ path, scope }) => ({
          // The CLI requires an include name in addition to its exact path.
          // A path-derived digest stays stable without display-name collisions.
          name: `item-${hash(path).slice(0, 16)}`,
          path,
          scope,
        })),
      },
    }));

  return { modules, warnings: warnings.sort((a, b) => cmp(a.path, b.path)), duplicates: duplicates.sort(cmp) };
}

/** Backwards-compatible builder for exact Discovery item bindings. */
export function buildModules(items) {
  return buildFromIncludes(items, true);
}

/** Builder for the canonical folder/item scope emitted by Discovery planning. */
export function buildModulesFromIncludes(includes) {
  return buildFromIncludes(includes, false);
}

function main() {
  const a = args(['input', 'output-root']);
  required(a, 'input', 'output-root');
  const inputPath = safe(a.input);
  const outputRoot = safe(a['output-root']);
  separate(inputPath, outputRoot);

  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(inputPath)));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Expected module input object');
  const isExactItems = Array.isArray(parsed.items) && Object.keys(parsed).every((key) => key === 'items');
  const isCanonicalScope = parsed.version === 1 && parsed.status === 'complete' && Array.isArray(parsed.includes);
  if (!isExactItems && !isCanonicalScope) throw Error('Expected { items: [{ path, kind? }, ...] } or a complete canonical serialization scope');
  const entries = isExactItems ? parsed.items : parsed.includes;
  if (!entries.length) throw Error('module input must be non-empty');

  const { modules, warnings, duplicates } = isExactItems ? buildModules(entries) : buildModulesFromIncludes(entries);

  for (const m of modules) {
    writeReport(outputRoot, `${sanitizeForNamespace(m.namespace)}.module.json`, { namespace: m.namespace, items: m.items }, [inputPath]);
  }
  writeReport(outputRoot, 'build-modules.json', {
    version: 1, moduleCount: modules.length,
    namespaces: modules.map((m) => ({ namespace: m.namespace, itemCount: m.items.includes.length })),
    itemCount: entries.length - duplicates.length, duplicates, ootbWarnings: warnings,
  }, [inputPath]);

  if (duplicates.length || warnings.length) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run(main);
