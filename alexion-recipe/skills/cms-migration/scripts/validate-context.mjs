import { cli, isMain } from './contracts.mjs';

// The context file is durable, agent-written and read by every agent, so it must never hold a credential.
const SECRET_KEY = /(api[-_ ]?key|secret|token|password|passwd|pwd|credential|authorization|bearer|private[-_ ]?key)/i;
const SECRET_VALUE = [
  [/:\/\/[^\s/?#]*@/, 'a URL with embedded credentials'],
  [/[?&](sc_apikey|api_?key|apikey|access_token|token|key|secret)=/i, 'a URL with a credential parameter'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i, 'an authorization header value'],
];

function findSecrets(value, path, found) {
  if (typeof value === 'string') {
    for (const [pattern, label] of SECRET_VALUE) if (pattern.test(value)) found.push(`${path} looks like ${label}`);
  } else if (Array.isArray(value)) value.forEach((item, i) => findSecrets(item, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) found.push(`${path}.${key} is a credential-like field name`);
      findSecrets(child, `${path}.${key}`, found);
    }
  }
}

const normalize = path => path.replace(/\/+$/, '') || '/';
const inside = (parent, child) => child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');

/** Roots that would let a task escape or mix migration state into a repository the migration commits to. */
function checkRoots(roots = {}, errors) {
  for (const [name, value] of Object.entries(roots)) {
    if (value.includes('\\') || value.includes('\0') || value.split('/').includes('..')) errors.push(`roots.${name} must be a clean absolute POSIX path`);
  }
  const { migration, source, target, app } = Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, normalize(v)]));
  if (app && target && !inside(target, app)) errors.push('roots.app must be inside roots.target (or equal to it for a single-app repository)');
  if (source && target && (inside(source, target) || inside(target, source))) errors.push('roots.source and roots.target must not contain each other');
  for (const repository of [['source', source], ['target', target]]) {
    if (migration && repository[1] && inside(repository[1], migration)) errors.push(`roots.migration must not be inside roots.${repository[0]}: migration files would join the repository`);
  }
}

/**
 * Fields Setup must still fill. These are the connector-readiness requirements: content connectors for the
 * chosen sides, source code for the source side, and the source site when source content is in scope.
 */
function missingFields(context) {
  const missing = new Set();
  const full = context.migration?.mode === 'full-migration';
  const need = (path, present) => { if (!present) missing.add(path); };
  need('scopeId', context.scopeId);
  need('migration.type', context.migration?.type);
  need('migration.mode', context.migration?.mode);
  need('roots.migration', context.roots?.migration);
  if (context.migration?.mode === 'discovery-only' && !context.migration?.discovery) missing.add('migration.discovery');
  const sides = full ? ['source', 'target'] : context.migration?.discovery?.sides ?? [];
  const surfaces = full ? ['content', 'code'] : context.migration?.discovery?.surfaces ?? [];
  for (const side of sides) for (const surface of surfaces) {
    if (surface === 'content') need(`connectors.${side}Content`, context.connectors?.[side + 'Content']);
    else {
      need(`roots.${side}`, context.roots?.[side]);
      if (side === 'target') {
        need('roots.app', context.roots?.app);
        need('connectors.targetCode', context.connectors?.targetCode);
        need('target.code.repoName', context.target?.code?.repoName);
        need('target.code.branch', context.target?.code?.branch);
      }
    }
  }
  if (sides.includes('source') && surfaces.includes('content')) {
    need('source.site.name', context.source?.site?.name);
    need('source.site.primaryLanguage', context.source?.site?.primaryLanguage);
  }
  if (sides.includes('source') && surfaces.includes('code')) {
    const code = context.source?.code;
    need('source.code.mode', code?.mode);
    if (code?.mode === 'connector') {
      need('connectors.sourceCode', context.connectors?.sourceCode);
      need('source.code.repoName', code.repoName);
      need('source.code.branch', code.branch);
    }
    if (code?.mode === 'git-url') need('source.code.gitUrl', code.gitUrl);
    if (code?.mode === 'upload') need('source.code.upload', code.upload);
  }
  return [...missing].sort();
}

/** Reads only the staged document; never writes it. Structure comes from context.schema.json. */
export async function validateContext(context) {
  const errors = [], warnings = [];
  checkRoots(context.roots, errors);
  findSecrets(context, 'context', errors);
  if (context.source?.code?.mode === 'git-url' && !context.source.code.gitUrl) errors.push('source.code.mode git-url requires source.code.gitUrl');
  const missing = missingFields(context);
  const complete = errors.length === 0 && missing.length === 0;
  return {
    valid: errors.length === 0, complete, missing, warnings, errors,
    summary: { complete, missing: missing.length, missingFields: missing, warnings: warnings.length },
  };
}
if (await isMain(import.meta.url)) await cli('validate-context', input => validateContext(input));
