import { hash, normalizeId, fail } from './files.mjs';

export const inside = (root, path) =>
  normalizeId(path) === normalizeId(root) || normalizeId(path).startsWith(normalizeId(root) + '/');
export const parentPath = (path) => path.slice(0, path.lastIndexOf('/'));
export const identityKey = (i) =>
  [
    i.sourceItemId,
    i.outputKey,
    i.pageId ?? '',
    i.renderingInstanceId ?? '',
    i.deviceId ?? '',
    i.language ?? '',
    i.version ?? '',
  ]
    .map(normalizeId)
    .join('|');
/** Deterministic UUIDv8 from the migration namespace and logical identity. */
export function plannedId(namespace, key) {
  const hex = hash(JSON.stringify([namespace, key]))
    .slice(0, 32)
    .split('');
  hex[12] = '8';
  hex[16] = '8';
  const s = hex.join('');
  return `{${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}}`;
}
export function safeName(name) {
  const value = name.replace(/[\\/:*?"<>|{}\[\]\x00-\x1f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!value || value === '.' || value === '..')
    throw fail('name', 'source.name', 'Source name cannot form a safe destination segment');
  return value;
}
export function resolvePath(rule, sourceName, pagePath, root) {
  if (rule.pathPattern.includes('{targetPagePath}') && !pagePath)
    throw fail('page-owner', rule.outputKey, 'Destination needs an unambiguous target page');
  const path = rule.pathPattern
    .replaceAll('{sourceName}', safeName(sourceName))
    .replaceAll('{outputKey}', safeName(rule.outputKey))
    .replaceAll('{targetPagePath}', pagePath ?? '');
  if (
    !path.startsWith('/sitecore/') ||
    /[{}\\:*?"<>|\[\]\x00-\x1f]/.test(path) ||
    path
      .split('/')
      .slice(1)
      .some((p) => !p || p === '.' || p === '..') ||
    !inside(root, path)
  )
    throw fail('path', rule.outputKey, 'Resolved destination is unsafe or outside the approved target root');
  return path;
}
