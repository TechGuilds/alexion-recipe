// Portable, strict evidence readers. Unknown properties are omitted, as in the source schemas.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string';
const nonempty = (value) => string(value) && value.length > 0;
const nullableString = (value) => value === null || string(value);
const fields = (value) => record(value) && Object.values(value).every(string);

function instance(value) {
  if (!record(value)) throw new Error('Expected instance');
  const result = {};
  for (const key of ['renderingId', 'renderingName', 'instanceId', 'pageId', 'itemPath', 'language', 'deviceId', 'placeholder', 'datasource', 'parameters', 'variantId']) {
    const validate = ['renderingId', 'itemPath'].includes(key) ? nonempty
      : ['instanceId', 'deviceId', 'placeholder', 'datasource', 'parameters', 'variantId'].includes(key) ? nullableString : string;
    if (!validate(value[key])) throw new Error(`Invalid ${key}`);
    result[key] = value[key];
  }
  return result;
}

export function parseRenderingInstances(raw) {
  if (raw == null) return null;
  try {
    const source = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '').trim() : raw;
    const rows = typeof source === 'string'
      ? source.startsWith('[') ? JSON.parse(source)
        : source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : source;
    if (!Array.isArray(rows)) throw new Error('Expected array');
    return rows.map(instance);
  } catch {
    throw new Error('Invalid rendering-instances evidence; rerun source discovery.');
  }
}

export function parseRenderingVariants(raw) {
  if (raw == null) return [];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw;
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.variants)) throw new Error('Expected variants');
    return value.variants.map((variant) => {
      if (!record(variant) || !nonempty(variant.id) || !string(variant.name) || !string(variant.path)
        || !Array.isArray(variant.renderingIds) || !variant.renderingIds.every(string)
        || !fields(variant.fields) || typeof variant.observed !== 'boolean' || !Array.isArray(variant.nodes)) throw new Error('Invalid variant');
      const nodes = variant.nodes.map((node) => {
        if (!record(node) || !string(node.path) || !string(node.template) || !fields(node.fields)) throw new Error('Invalid node');
        return { path: node.path, template: node.template, fields: { ...node.fields } };
      });
      return { id: variant.id, name: variant.name, path: variant.path, renderingIds: [...variant.renderingIds], fields: { ...variant.fields }, nodes, observed: variant.observed };
    });
  } catch {
    throw new Error('Invalid rendering-variants evidence; rerun source discovery.');
  }
}

export function canonicalRenderingId(id) {
  return id.replace(/[{}-]/g, '').toLowerCase();
}

/** Only website paths may become capture/output routes. Never guess from item names. */
export function normalizeEvidenceRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  let route;
  try { route = decodeURIComponent(value); } catch { return null; }
  if (/[\\?#\x00-\x1f]/.test(route) || route.includes('//')
    || route.split('/').some((part) => part === '.' || part === '..')
    || /^\/sitecore(?:\/|$)/i.test(route)) return null;
  return (route.length > 1 ? route.replace(/\/+$/, '') : route).toLowerCase();
}
