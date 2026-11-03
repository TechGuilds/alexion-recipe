// Pure, scoped analysis of retained Sitecore presentation and dependency evidence.
// No runtime design flattening or target provisioning is implied by these facts.
const compare = (a, b) => String(a).localeCompare(String(b), 'en');
const sorted = values => [...values].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = value => {
  const bare = String(value ?? '').trim().replace(/^\{|\}$/g, '');
  return guidPattern.test(bare) ? `{${bare.toLowerCase()}}` : null;
};
const ident = row => ({ id: guid(row.id) ?? String(row.id), path: row.path ?? null, language: row.language, version: String(row.version) });
const identKey = row => JSON.stringify([guid(row.id) ?? row.id, row.language, String(row.version)]);
const selectedVersion = (row, scope) => (scope.versions?.includes('latest') || scope.version === 'latest') ? 'latest' : String(row.version);
const scopeKey = (row, scope) => JSON.stringify([row.language, guid(row.deviceId) ?? row.deviceId, selectedVersion(row, scope)]);
const scopeOf = (row, scope) => ({ language: row.language, deviceId: guid(row.deviceId) ?? row.deviceId, version: selectedVersion(row, scope) });
const field = (node, name) => Object.entries(node.fields ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';
const guidList = value => unique(String(value ?? '').split('|').map(guid).filter(Boolean)).sort(compare);
const normalSuffix = /^(.*)-\{([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}-(\d+)$/i;
const suspiciousSuffix = /-.+?-\d+$/;
const designRelations = new Set(['page-design', 'partial-design', 'base-partial-design']);
const sharedSlotPattern = /lockedtop|lockedbottom|lockedleft|lockedright|header|footer|headless-header|headless-footer|jss-header|jss-footer/i;
const compatibleVersion = (nodeVersion, selectedVersion) => selectedVersion === 'latest' || String(nodeVersion) === String(selectedVersion) || String(nodeVersion) === '0';

function segment(raw, findings, page) {
  const match = raw.match(normalSuffix);
  if (match && match[1]) return { raw, baseName: match[1], isDynamic: true, pattern: 'baseName-{GUID}-N', uid: guid(match[2]), index: Number(match[3]) };
  if (suspiciousSuffix.test(raw) && raw.includes('{')) findings.push({ code: 'malformed-dynamic-placeholder-suffix', rawSegment: raw, page });
  return { raw, baseName: raw, isDynamic: false, pattern: 'literal' };
}

function probe(edges) {
  if (!edges.length) return 'not-probed';
  if (edges.some(edge => edge.status === 'failed' || edge.status === 'dynamic' || edge.status === 'unresolved-expression')) return 'failed';
  if (edges.some(edge => edge.status === 'resolved')) return 'resolved';
  if (edges.every(edge => edge.status === 'missing' && edge.required === false)) return 'optional-missing';
  return 'failed';
}

/**
 * Derive deterministic Discovery facts from native inspect-presentation records and
 * process-dependencies dependency-index.json. Inputs are never mutated.
 */
export function deriveSxaInputs({ presentation, dependencies, scope, completeness }) {
  if (!Array.isArray(presentation) || !dependencies || !Array.isArray(dependencies.nodes) || !Array.isArray(dependencies.edges) || !scope || !completeness ||
      !['complete', 'partial'].includes(completeness.presentation) || !['complete', 'partial'].includes(completeness.dependencies)) {
    throw Error('Expected presentation[], dependency index, scope and explicit complete|partial flags');
  }
  const status = completeness.presentation === 'complete' && completeness.dependencies === 'complete' && dependencies.status === 'complete' ? 'complete' : 'partial';
  const findings = [];
  const nodes = sorted(dependencies.nodes).map(row => ({ ...row, id: guid(row.id) ?? row.id, parentId: guid(row.parentId) ?? row.parentId }));
  const edges = sorted(dependencies.edges);
  const settings = nodes.filter(row => row.kind === 'placeholder' && row.path?.toLowerCase().startsWith('/sitecore/layout/placeholder settings/'));
  const modulePath = /^\/sitecore\/layout\/Renderings\/(Feature|Foundation|Project)\/([^/]+)(?:\/|$)/i;
  const moduleNodes = nodes.filter(row => row.kind === 'rendering' && modulePath.test(row.path ?? ''));
  const renderings = moduleNodes.filter(row => !/folder$/i.test(row.templateName ?? ''));
  const scopes = new Map();
  for (const page of presentation) {
    const key = scopeKey(page, scope);
    if (!scopes.has(key)) scopes.set(key, { scope: scopeOf(page, scope), pages: new Map() });
    const group = scopes.get(key);
    const pk = identKey(page);
    if (group.pages.has(pk)) throw Error('Duplicate presentation record for one page/language/version/device: ' + pk);
    group.pages.set(pk, page);
  }
  const pageTemplates = [], placeholders = [], dynamicMap = new Map();
  for (const group of sorted([...scopes.values()])) {
    const pages = sorted([...group.pages.values()]);
    const templateMap = new Map(), slotMap = new Map();
    for (const page of pages) {
      const pageId = ident(page);
      const templateId = guid(page.templateId) ?? page.templateId;
      const tk = JSON.stringify([templateId, page.templateName]);
      if (!templateMap.has(tk)) templateMap.set(tk, { scope: group.scope, templateId, templateName: page.templateName ?? null, pages: [] });
      templateMap.get(tk).pages.push(pageId);
      for (const occurrence of page.final ?? []) {
        const rawKey = String(occurrence.placeholder ?? '');
        if (!rawKey) continue;
        const segments = rawKey.split('/').filter(Boolean).map(raw => segment(raw, findings, pageId));
        if (!slotMap.has(rawKey)) slotMap.set(rawKey, { scope: { ...group.scope, pageCount: pages.length }, rawKey, segments, pageMap: new Map(), renderMap: new Map(), occurrences: [] });
        const slot = slotMap.get(rawKey), renderingId = guid(occurrence.renderingId) ?? occurrence.renderingId;
        const occurrenceRef = { page: pageId, renderingId, uid: guid(occurrence.uid) ?? occurrence.uid ?? null, index: occurrence.index ?? null, rawKey };
        slot.occurrences.push(occurrenceRef);
        const pageKey = identKey(page);
        slot.pageMap.set(pageKey, { ...pageId, occurrenceCount: (slot.pageMap.get(pageKey)?.occurrenceCount ?? 0) + 1 });
        if (!slot.renderMap.has(renderingId)) slot.renderMap.set(renderingId, { renderingId, pages: new Map(), occurrences: [] });
        const rr = slot.renderMap.get(renderingId);
        rr.pages.set(pageKey, pageId); rr.occurrences.push(occurrenceRef);
        for (const seg of segments) {
          const baseKey = JSON.stringify([group.scope.language, group.scope.deviceId, group.scope.version, seg.baseName]);
          if (!dynamicMap.has(baseKey)) dynamicMap.set(baseKey, { scope: group.scope, baseName: seg.baseName, isDynamic: false, patterns: new Set(), rawKeys: new Set(), pages: new Map() });
          const base = dynamicMap.get(baseKey);
          base.isDynamic ||= seg.isDynamic; base.patterns.add(seg.pattern); base.rawKeys.add(rawKey); base.pages.set(pageKey, pageId);
        }
      }
    }
    pageTemplates.push(...sorted([...templateMap.values()].map(row => ({ ...row, pages: sorted(row.pages), pageCount: row.pages.length }))));
    for (const slot of slotMap.values()) {
      const renderRows = [...slot.renderMap.values()].map(row => ({ renderingId: row.renderingId, pages: sorted([...row.pages.values()]), pageCount: row.pages.size,
        occurrenceCount: row.occurrences.length, occurrences: sorted(row.occurrences), frequency: row.pages.size / pages.length,
        heuristicCandidate: row.pages.size / pages.length >= 0.8 }));
      const pageRows = sorted([...slot.pageMap.values()]);
      pageRows.sort((a, b) => b.occurrenceCount - a.occurrenceCount || compare(a.id, b.id) || compare(a.path, b.path));
      placeholders.push({ scope: slot.scope, rawKey: slot.rawKey, segments: slot.segments, parentPlaceholder: slot.segments.slice(0, -1).map(row => row.raw).join('/') || null,
        pageCount: slot.pageMap.size, occurrenceCount: slot.occurrences.length, pages: sorted([...slot.pageMap.values()]), occurrences: sorted(slot.occurrences),
        renderings: renderRows.sort((a, b) => compare(a.renderingId, b.renderingId)), representativePage: pageRows[0] ?? null,
        sharedSlotNameHeuristic: slot.segments.some(row => sharedSlotPattern.test(row.baseName)) });
    }
  }
  const dynamicPlaceholderBases = [];
  for (const base of dynamicMap.values()) {
    const matching = settings.filter(row => row.language === base.scope.language && compatibleVersion(row.version, base.scope.version) && String(field(row, 'Placeholder Key')).trim().toLowerCase() === base.baseName.toLowerCase());
    const settingRefs = matching.map(row => ({ ...ident(row), placeholderKey: field(row, 'Placeholder Key'), allowedControlsRaw: field(row, 'Allowed Controls') }));
    const allowedControls = matching.flatMap(row => guidList(field(row, 'Allowed Controls')).map(renderingId => ({ setting: ident(row), renderingId,
      edges: sorted(edges.filter(edge => edge.relation === 'allowed-rendering' && identKey(edge.consumer ?? {}) === identKey(row) && (guid(edge.targetId) ?? guid(edge.raw)) === renderingId)) })));
    const parentRenderings = renderings.filter(row => row.language === base.scope.language && compatibleVersion(row.version, base.scope.version) && guidList(field(row, 'Placeholders')).some(id => matching.some(setting => setting.id === id))).map(row => ({ ...ident(row), placeholdersRaw: field(row, 'Placeholders'), declaredSettingIds: guidList(field(row, 'Placeholders')).filter(id => matching.some(setting => setting.id === id)) }));
    dynamicPlaceholderBases.push({ scope: base.scope, baseName: base.baseName, isDynamic: base.isDynamic, patterns: [...base.patterns].sort(compare), rawKeys: [...base.rawKeys].sort(compare),
      pages: sorted([...base.pages.values()]), settings: sorted(settingRefs), allowedControls: sorted(allowedControls), parentRenderings: sorted(parentRenderings) });
  }
  const moduleMap = new Map();
  for (const rendering of moduleNodes) {
    const match = rendering.path.match(modulePath);
    const module = `${match[1]}/${match[2]}`;
    const moduleVersion = selectedVersion(rendering, scope);
    const key = JSON.stringify([module, rendering.language, moduleVersion]);
    if (!moduleMap.has(key)) moduleMap.set(key, { module, language: rendering.language, version: moduleVersion, renderings: [] });
    if (!/folder$/i.test(rendering.templateName ?? '')) moduleMap.get(key).renderings.push(ident(rendering));
  }
  const renderingModules = [];
  for (const entry of moduleMap.values()) {
    // The collector probes settings/branches when it first visits any node in a
    // module, including its Rendering Folder. Keep that probe provenance while
    // counting only executable definitions in entry.renderings.
    const probeConsumers = moduleNodes.filter(row => {
      const match = row.path.match(modulePath);
      return `${match[1]}/${match[2]}`.toLowerCase() === entry.module.toLowerCase() && row.language === entry.language && compatibleVersion(row.version, entry.version);
    });
    const moduleEdges = relation => edges.filter(edge => edge.relation === relation && probeConsumers.some(row => identKey(row) === identKey(edge.consumer ?? {})));
    const settingEdges = moduleEdges('module-settings'), branchEdges = moduleEdges('module-branch');
    const settingsProbe = probe(settingEdges), branchProbe = probe(branchEdges);
    const root = `/sitecore/system/Settings/${entry.module}`.toLowerCase();
    const roots = nodes.filter(row => row.path?.toLowerCase() === root && row.language === entry.language && compatibleVersion(row.version, entry.version) && settingEdges.some(edge => edge.status === 'resolved' && (guid(edge.targetId) ?? edge.targetId) === row.id));
    const setups = nodes.filter(row => row.templateName === 'HeadlessSiteSetupRoot' && roots.some(parent => parent.id === row.parentId) && row.language === entry.language && compatibleVersion(row.version, entry.version));
    const adds = nodes.filter(row => row.templateName === 'AddItem' && setups.some(parent => parent.id === row.parentId) && row.language === entry.language && compatibleVersion(row.version, entry.version));
    let registration = 'unknown';
    if (settingsProbe === 'resolved') registration = adds.length ? 'registered' : status === 'complete' ? 'partial' : 'unknown';
    else if (settingsProbe === 'optional-missing' && status === 'complete') registration = 'unregistered';
    if (registration === 'unregistered' || registration === 'partial') findings.push({ code: 'module-registration-missing', module: entry.module, language: entry.language, version: entry.version, registration });
    renderingModules.push({ ...entry, renderings: sorted(entry.renderings), settingsProbe, branchProbe, registration,
      settingsEdges: sorted(settingEdges), branchEdges: sorted(branchEdges), registrationChain: { settings: sorted(roots.map(ident)), headlessSiteSetupRoot: sorted(setups.map(ident)), addItem: sorted(adds.map(ident)) } });
  }
  const designReferences = sorted(edges.filter(edge => designRelations.has(edge.relation)).map(edge => ({ relation: edge.relation, status: edge.status, raw: edge.raw,
    consumer: edge.consumer, target: edge.status === 'resolved' ? { id: guid(edge.targetId) ?? edge.targetId, path: edge.targetPath ?? null, language: edge.language, version: String(edge.version) } : null })));
  return { version: 1, status, scope, pageTemplates: sorted(pageTemplates), placeholders: sorted(placeholders), dynamicPlaceholderBases: sorted(dynamicPlaceholderBases),
    renderingModules: sorted(renderingModules), designReferences, designCycles: sorted((dependencies.cycles ?? []).filter(row => row.family === 'sxa-design')),
    findings: sorted(unique(findings)), limitations: [
      'Frequency and candidates are scoped Discovery heuristics; no partial design is approved.',
      'Registration is assessed only from captured parent relationships and relevant probe/completeness evidence.',
      'Design references and cycles are direct graph facts; runtime expansion and target provisioning remain unassessed.'
    ] };
}
