// Derive a mapped copy. Raw captures and their coverage evidence remain unchanged.
import { canonicalId, object } from './component-mapping.mjs';
import { validateComponentMigrationPlan } from './component-migration-plan.mjs';
import { transformMappedRendering } from './mapped-rendering.mjs';
import { normalizeRenderingParameters } from '../analysis/rendering-configurations.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const id = value => typeof value === 'string' && value.replace(/[{}-]/g, '').trim() ? canonicalId(value) : null;
const selectors = new Set(['fieldnames', 'renderingvariant', 'variantid']);
function renderingParameters(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    const entries = [...new URLSearchParams(value)];
    if (new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length) throw new Error('Ambiguous repeated rendering parameter');
    return Object.fromEntries(entries);
  }
  const params = object(value, 'rendering parameters');
  if (Object.values(params).some(v => typeof v !== 'string')) throw new Error('Rendering parameters must contain strings');
  return params;
}
const pathFor = (parent, key) => !parent || key.startsWith('/') || key.startsWith(`${parent}/`) ? key.replace(/^\//, '') : `${parent}/${key}`;

export function mapLayoutForTarget(layout, route, plan) {
  validateComponentMigrationPlan(plan, { requireApproval: true });
  const copy = structuredClone(layout), root = object(copy, 'layout');
  if (root._migrationMapping || root._migrationExample) throw new Error('Map raw source captures only; derived or synthetic layouts require their original evidence');
  const page = record(root.sitecore?.route) ?? record(root.route);
  if (!page || !record(page.placeholders)) throw new Error('Captured layout has no route placeholders');
  const pageId = id(page.itemId ?? page.itemID);
  const language = root.sitecore?.context?.language ?? page.itemLanguage;
  const warnings = [], applied = new Set();
  const visit = (container, sourceParent, targetParent) => {
    if (container.placeholders === undefined) return;
    const placeholders = object(container.placeholders, 'placeholders'), transformed = new Map();
    for (const [key, nodes] of Object.entries(placeholders)) {
      if (!Array.isArray(nodes)) throw new Error(`Invalid placeholder array: ${key}`);
      if (!nodes.length) transformed.set(key, transformed.get(key) ?? []);
      for (const value of nodes) {
        const node = object(value, 'rendering');
        const sourcePath = typeof node.sourcePlaceholder === 'string' ? node.sourcePlaceholder : pathFor(sourceParent, key);
        const params = renderingParameters(node.params);
        const normalized = normalizeRenderingParameters(new URLSearchParams(Object.entries(params)).toString());
        const variantValues = [...new Set([...Object.entries(params).filter(([k]) => selectors.has(k.toLowerCase())).map(([,v]) => id(v)), id(node.variantId)].filter(Boolean))];
        const variantId = variantValues[0] ?? null, renderingId = id(node.renderingId), uid = id(node.uid);
        const candidates = variantValues.length > 1 ? [] : plan.entries.filter(entry => {
          if ((entry.variantId ? id(entry.variantId) : null) !== variantId) return false;
          if (!Object.entries(entry.parameters ?? {}).every(([name, val]) => normalized[name] === val)) return false;
          const occurrences = entry.sourceOccurrences.filter(o => o.route === route && !o.routeIssue && pageId && id(o.itemId) === pageId && (!o.language || o.language === language));
          // A real page occurrence is mandatory, including when renderingId is supplied.
          return occurrences.some(o => (!uid || id(o.instanceId) === uid)) && (renderingId ? renderingId === entry.sourceRenderingId : uid && occurrences.some(o => id(o.instanceId) === uid));
        });
        let destination = key;
        if (candidates.length === 1) {
          const entry = candidates[0];
          if (entry.confirmed && entry.action === 'reuse-target') {
            const mapped = transformMappedRendering({ renderingId: entry.sourceRenderingId, componentName: node.componentName ?? entry.sourceComponent, configurationKey: entry.configurationKey, fields: record(node.fields) ?? {}, parameters: params, placeholder: sourcePath, datasource: typeof node.dataSource === 'string' ? node.dataSource : '', variantId }, entry, { plan });
            const target = mapped.placeholder.replace(/^\//, ''), parent = targetParent.replace(/^\//, '');
            if (mapped.placeholder !== sourcePath && parent && target.includes('/') && !target.startsWith(`${parent}/`)) throw new Error(`Target placeholder requires an explicit target composition: ${entry.key}`);
            if (mapped.placeholder !== sourcePath) destination = parent && target.startsWith(`${parent}/`) ? target.slice(parent.length + 1) : target;
            if (!destination) throw new Error('Mapped placeholder must not be empty');
            Object.assign(node, { renderingId: mapped.renderingId, componentName: mapped.componentName, fields: mapped.fields, params: mapped.parameters, dataSource: mapped.datasource });
            if (node.variantId !== undefined) node.variantId = mapped.variantId;
            delete node.sourcePlaceholder;
            applied.add(entry.key);
          } else warnings.push(`Source rendering retained (${entry.action}): ${entry.key}`);
        } else warnings.push(`No unambiguous page-local source configuration for ${String(node.componentName ?? node.uid ?? node.renderingId)}`);
        visit(node, pathFor(sourceParent, key), pathFor(targetParent, destination));
        if (!transformed.has(destination)) transformed.set(destination, []);
        transformed.get(destination).push(node);
      }
    }
    container.placeholders = Object.fromEntries(transformed);
  };
  visit(page, '', '');
  const appliedRequirementKeys = [...applied].sort();
  root._migrationMapping = { sourceFingerprint: plan.sourceFingerprint, targetInventoryFingerprint: plan.targetInventoryFingerprint, mappingPlanFingerprint: plan.fingerprint, appliedRequirementKeys };
  return { layout: copy, appliedRequirementKeys, warnings: [...new Set(warnings)].sort() };
}
