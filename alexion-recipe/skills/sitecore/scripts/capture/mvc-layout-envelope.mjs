// Portable adaptation of kajoo-sitecore/src/serialization/layout-envelope.ts.
// Native Node only; retains source rendering identity for coverage verification.
export const normalizeUid = (id) => String(id ?? '').replace(/[{}]/g, '').toLowerCase();

function parseParams(value) {
  if (!value) return undefined;
  return Object.fromEntries(String(value).split('&').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [decodeURIComponent(part), ''] : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function terminalKey(segment) {
  const uid = segment.match(/^(.+)-\{([0-9A-Fa-f-]+)\}(?:-(\d+))?$/);
  if (uid) return { key: uid[3] === undefined ? uid[1] : `${uid[1]}-${uid[3]}`, uid: normalizeUid(uid[2]) };
  const dynamic = segment.match(/^(.+)_dynamic_(.+)$/);
  return dynamic ? { key: dynamic[1], itemId: dynamic[2] } : { key: segment };
}

export function assembleLayoutEnvelope(args) {
  const fieldsByDs = new Map(Object.entries(args.fieldsByDatasource).map(([id, fields]) => [normalizeUid(id), fields]));
  const components = new Map();
  const itemIds = new Map();
  for (const rendering of args.renderings) {
    const uid = normalizeUid(rendering.UniqueID);
    if (!uid || components.has(uid)) throw new Error('Missing or duplicate rendering UniqueID');
    const dataSource = rendering.Datasource || undefined;
    const fields = fieldsByDs.get(normalizeUid(dataSource));
    components.set(uid, { uid, renderingId: rendering.RenderingId, componentName: rendering.RenderingName ?? 'Unknown', sourcePlaceholder: rendering.Placeholder, dataSource, fields, params: parseParams(rendering.Parameters), placeholders: {} });
    const itemId = fields?.ItemId?.value;
    if (typeof itemId === 'string' && itemId) {
      if (itemIds.has(itemId)) throw new Error(`Ambiguous dynamic placeholder parent: ${itemId}`);
      itemIds.set(itemId, uid);
    }
  }
  const roots = {};
  const placed = new Map();
  const parentOf = new Map();
  const remaining = [...args.renderings];
  while (remaining.length) {
    let progress = false;
    for (let index = 0; index < remaining.length;) {
      const rendering = remaining[index];
      const uid = normalizeUid(rendering.UniqueID);
      const raw = String(rendering.Placeholder ?? '').trim().replace(/^\/+/, '');
      const segments = raw.split('/');
      const hint = terminalKey(segments.at(-1));
      const container = segments.slice(0, -1).join('/');
      const parent = hint.uid ?? (hint.itemId ? itemIds.get(hint.itemId) : undefined) ?? (container ? placed.get(container) : undefined);
      let bucket;
      if (parent && components.has(parent)) {
        let ancestor = parent;
        while (ancestor) {
          if (ancestor === uid) throw new Error('Cyclic rendering placeholder relationship');
          ancestor = parentOf.get(ancestor);
        }
        parentOf.set(uid, parent);
        bucket = components.get(parent).placeholders;
      } else if (!container && !hint.uid && !hint.itemId) bucket = roots;
      else { index++; continue; }
      const key = hint.key || '__orphan';
      (bucket[key] ??= []).push(components.get(uid));
      // Multiple components in one static placeholder cannot identify a unique parent.
      placed.set(raw, placed.has(raw) ? null : uid);
      remaining.splice(index, 1);
      progress = true;
    }
    if (!progress) throw new Error(`Unresolved nested placeholders: ${remaining.map((r) => r.Placeholder).join(', ')}`);
  }
  for (const component of components.values()) if (!Object.keys(component.placeholders).length) delete component.placeholders;
  const { pageItemId: itemId, pageItemName: name, pageTemplateId: templateId, pageTemplateName: templateName, pageItemPath: itemPath, layoutId, layoutFilePath, pageFields: fields, siteName, language } = args;
  return { sitecore: { context: { pageEditing: false, site: { name: siteName }, language, itemId, itemPath }, route: { name, itemId, templateId, templateName, layoutId, layoutFilePath, fields, placeholders: roots } } };
}
