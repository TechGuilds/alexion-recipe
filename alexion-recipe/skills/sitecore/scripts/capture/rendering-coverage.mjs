// Native Node only. Capture presence is rendering + variant; placement differences are diagnostics.
import { createHash } from 'node:crypto';

export const canonicalId = (value) => typeof value === 'string' ? value.replace(/[{}-]/g, '').toLowerCase() : '';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export function routeFile(route) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\?#%\x00-\x20:]/.test(route)) throw new Error(`Unsafe capture route: ${route}`);
  const parts = route.slice(1).split('/');
  if (route !== '/' && parts.some((p) => !p || p === '.' || p === '..' || /[<>"|*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe capture route: ${route}`);
  return `${route === '/' ? 'home' : route.slice(1)}/index.json`;
}
export function planPages(plan) {
  return [...plan.selectedPages, ...plan.requirements.flatMap((r) => r.alternatives ?? [])];
}
export function samePage(a, b) {
  return a.route === b.route && canonicalId(a.itemId) === canonicalId(b.itemId) && (a.itemPath ?? '') === (b.itemPath ?? '') && (a.language ?? '') === (b.language ?? '');
}
export function validateOutcomeIdentity(plan, outcome) {
  const page = planPages(plan).find((p) => p.route === outcome?.route);
  if (!page || !['captured', 'failed', 'skipped'].includes(outcome.status)) throw new Error('Unapproved capture result route/status');
  if (outcome.itemId && page.itemId && canonicalId(outcome.itemId) !== canonicalId(page.itemId)) throw new Error('Capture result item identity mismatch');
  if ((outcome.itemPath && page.itemPath && outcome.itemPath !== page.itemPath) || (outcome.language && page.language && outcome.language !== page.language)) throw new Error('Capture result source identity mismatch');
  return page;
}
export function validateCapturePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.identity !== 'rendering-variant' || plan.scope !== 'approved' || plan.draft !== false) throw new Error('Capture requires an approved, non-draft rendering-variant plan');
  const { schemaVersion: _version, fingerprint, ...body } = plan;
  if (typeof fingerprint !== 'string' || sha256(JSON.stringify(body)) !== fingerprint) throw new Error('Capture plan fingerprint mismatch');
  if (!Array.isArray(plan.selectedPages) || !Array.isArray(plan.requirements)) throw new Error('Malformed capture plan');
  const keys = new Set();
  for (const r of plan.requirements) {
    if (!r.key || !canonicalId(r.renderingId) || keys.has(r.key) || !Array.isArray(r.alternatives)) throw new Error('Malformed rendering requirement');
    keys.add(r.key);
  }
  const paths = new Map();
  for (const page of planPages(plan)) {
    const file = routeFile(page.route).toLowerCase();
    const prior = paths.get(file);
    if (prior && !samePage(prior, page)) throw new Error(`Capture route/output collision: ${page.route}`);
    paths.set(file, page);
  }
  const selected = new Set();
  for (const page of plan.selectedPages) {
    if (selected.has(page.route) || !Array.isArray(page.requirementKeys) || page.requirementKeys.some((key) => !keys.has(key))) throw new Error('Malformed selected page requirements');
    selected.add(page.route);
  }
  return plan;
}

export function capturedPlacements(layout) {
  const root = layout?.sitecore?.route ?? layout?.route ?? layout;
  const result = [];
  function visit(node, placeholder = null) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const params = typeof node.params === 'string' ? Object.fromEntries(new URLSearchParams(node.params)) : node.params ?? {};
    const variants = Object.entries(params).filter(([key]) => ['fieldnames', 'renderingvariant', 'variantid'].includes(key.toLowerCase())).map(([, value]) => value).filter((v) => v !== '');
    if (node.variantId) variants.push(node.variantId);
    if (node.uid || node.renderingId || node.componentName) result.push({ uid: node.uid, renderingId: node.renderingId, componentName: node.componentName, variantIds: [...new Set(variants.map(canonicalId))], params, placeholder: node.sourcePlaceholder ?? placeholder, datasource: node.dataSource ?? node.datasource });
    for (const [key, children] of Object.entries(node.placeholders ?? {})) if (Array.isArray(children)) for (const child of children) visit(child, placeholder ? `${placeholder}/${key}` : key);
  }
  visit(root);
  return result;
}

function evidence(requirement, page, outcome) {
  if (!outcome || outcome.status === 'skipped') return { status: 'not-captured', reason: outcome?.reason ?? 'Selected page has not been attempted' };
  if (outcome.status !== 'captured') return { status: 'capture-failed', reason: outcome.reason ?? 'Capture failed' };
  const route = outcome.layout?.sitecore?.route ?? outcome.layout?.route ?? outcome.layout;
  const actualItem = route?.itemId ?? route?.itemID;
  if (page.itemId && (!actualItem || canonicalId(actualItem) !== canonicalId(page.itemId))) return { status: 'target-unverified', reason: 'Captured item identity missing or mismatched' };
  const placements = capturedPlacements(outcome.layout);
  const occurrences = (requirement.sourceOccurrences ?? []).filter((o) => !o.routeIssue && o.route === page.route && (!page.itemId || canonicalId(o.itemId) === canonicalId(page.itemId)) && (!page.language || o.language === page.language));
  const uids = occurrences.map((o) => canonicalId(o.instanceId)).filter(Boolean);
  const candidates = placements.filter((p) => canonicalId(p.renderingId) === canonicalId(requirement.renderingId) || (!p.renderingId && uids.includes(canonicalId(p.uid))));
  const variant = canonicalId(requirement.variantId);
  const matching = candidates.filter((p) => variant ? p.variantIds.length === 1 && p.variantIds[0] === variant : !p.variantIds.length);
  const match = matching.find((p) => uids.includes(canonicalId(p.uid))) ?? matching[0];
  if (!match) return { status: candidates.length ? 'target-absent' : 'target-unverified', reason: candidates.length ? 'Stable rendering found, expected variant absent' : 'No stable rendering identity evidence', capturedCandidates: placements.filter((p) => candidates.includes(p) || p.componentName === requirement.renderingName) };
  const compare = (o) => {
    const differences = {};
    if (o.placeholder && o.placeholder !== match.placeholder) differences.placeholder = { expected: o.placeholder, actual: match.placeholder ?? null };
    if (typeof o.datasource === 'string' && o.datasource !== (match.datasource ?? '')) differences.datasource = { expected: o.datasource, actual: match.datasource ?? null };
    const parameters = o.parameters ?? requirement.parameters;
    const actualParams = Object.fromEntries(Object.entries(match.params).map(([key, value]) => [key.toLowerCase(), value]));
    if (parameters && Object.entries(parameters).some(([key, value]) => !['fieldnames', 'renderingvariant', 'variantid'].includes(key.toLowerCase()) && actualParams[key.toLowerCase()] !== value)) differences.parameters = { expected: parameters, actual: match.params };
    return { expectedPlacement: o, differences };
  };
  const uidOccurrences = occurrences.filter((o) => canonicalId(o.instanceId) && canonicalId(o.instanceId) === canonicalId(match.uid));
  const comparisons = (uidOccurrences.length ? uidOccurrences : occurrences).map(compare).sort((a, b) => Object.keys(a.differences).length - Object.keys(b.differences).length);
  const comparison = comparisons[0];
  const warnings = Object.keys(comparison?.differences ?? {}).map((dimension) => `Source and captured ${dimension} differ`);
  return { status: 'captured', consistencyStatus: !occurrences.length ? 'not-evaluated' : warnings.length ? 'warning' : 'consistent', warnings, ...(comparison ?? {}), capturedPlacement: match };
}

/** Pure reporting. Filesystem callers must verify outcome.layout before calling. */
export function buildRenderingCoverageReport(plan, outcomes, context = {}) {
  validateCapturePlan(plan);
  if (context.mappingInventory?.sourceDiscoveryFingerprint !== undefined && context.mappingInventory.sourceDiscoveryFingerprint !== plan.sourceDiscoveryFingerprint) throw new Error('Mapping inventory does not match source discovery');
  const requirements = plan.requirements.map((original) => {
    const discovered = (context.mappingInventory?.requirements ?? []).filter((r) => canonicalId(r.renderingId) === canonicalId(original.renderingId) && canonicalId(r.variantId) === canonicalId(original.variantId));
    const r = { ...original, sourceOccurrences: [...new Map([...(original.sourceOccurrences ?? []), ...discovered.flatMap((source) => (source.sourceOccurrences ?? []).map((o) => ({ ...o, parameters: source.parameters })))].map((o) => [JSON.stringify(o), o])).values()] };
    const pages = [...new Map([...plan.selectedPages.filter((p) => p.requirementKeys.includes(r.key)), ...r.alternatives.filter((p) => outcomes.some((o) => o.route === p.route))].map((p) => [p.route, p])).values()];
    const examples = pages.flatMap((page) => {
      const attempts = outcomes.filter((o) => o.route === page.route);
      return (attempts.length ? attempts : [undefined]).map((o) => {
        const result = evidence(r, page, o);
        return { ...page, ...result, severity: result.status === 'capture-failed' ? 'error' : ['target-absent', 'target-unverified'].includes(result.status) || result.consistencyStatus === 'warning' ? 'warning' : 'info' };
      });
    });
    const status = r.definitionOnly ? 'mapping-only' : examples.some((e) => e.status === 'captured') ? 'captured' : examples.some((e) => e.status === 'target-absent') ? 'target-absent' : examples.some((e) => e.status === 'target-unverified') ? 'target-unverified' : examples.some((e) => e.status === 'capture-failed') ? 'capture-failed' : examples.length ? 'not-captured' : 'target-unverified';
    return { ...r, sourceOccurrences: r.sourceOccurrences ?? [], status, severity: status === 'capture-failed' ? 'error' : ['target-absent', 'target-unverified'].includes(status) || examples.some((e) => e.status === 'captured' && e.severity === 'warning') ? 'warning' : 'info', examples };
  });
  return { schemaVersion: 1, captureIdentity: 'rendering-variant', capturePlanFingerprint: plan.fingerprint, selection: 'discovery-plan', captured: requirements.filter((r) => r.status === 'captured').length, total: requirements.length, requirements, mappingOnlyDefinitions: (context.mappingInventory?.renderings ?? []).filter((r) => r.usage?.status === 'unused').map((r) => ({ ...r, status: 'mapping-only' })), warnings: plan.warnings ?? [], outcomes: outcomes.map(({ layout: _layout, ...o }) => o) };
}
