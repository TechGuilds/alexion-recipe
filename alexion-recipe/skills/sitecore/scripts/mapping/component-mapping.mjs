// Native Node only. Target records are explicit operator-supplied evidence; never scan by name.
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonicalId = value => {
  const id = requiredText(value, 'ID').replace(/[{}-]/g, '').toLowerCase();
  if (!id) throw new Error('ID must not be empty after canonicalization');
  return id;
};
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`);
  return value.trim();
}
export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
export function list(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
export function exact(value, keys, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} property: ${key}`);
}
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const mapNames = ['fieldMap', 'parameterMap', 'placeholderMap', 'datasourceMap'];
export const decisionKeys = ['sourceRenderingId', 'configurationKey', 'action', 'confirmed', 'targetRenderingId', 'targetComponent', 'targetVariant', 'targetDatasourceTemplateId', 'rationale', ...mapNames];
function ruleMap(value = {}, label) {
  object(value, label);
  const entries = Object.entries(value).map(([key, target]) => {
    if (!key || typeof target !== 'string' || !target) throw new Error(`${label} rules must be nonempty strings`);
    if (unsafe.has(key) || unsafe.has(target)) throw new Error(`${label} cannot contain prototype property names`);
    return [key, target];
  }).sort(([a], [b]) => compare(a, b));
  if (['fieldMap', 'parameterMap'].includes(label) && new Set(entries.map(([, target]) => target)).size !== entries.length) throw new Error(`Conflicting ${label}: duplicate transformation destinations`);
  return Object.fromEntries(entries);
}
const names = (value = []) => [...new Set(list(value, 'names').map(v => requiredText(v, 'name')))].sort(compare);

function targetContents(input) {
  exact(input, ['schemaVersion', 'targetInstance', 'siteName', 'renderings'], 'target inventory');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error('Unsupported target schemaVersion');
  const renderings = list(input.renderings, 'renderings').map(entry => {
    exact(entry, ['renderingId', 'componentName', 'path', 'datasourceTemplateId', 'fields', 'parameters', 'placeholders'], 'target rendering');
    return { renderingId: canonicalId(entry.renderingId), componentName: requiredText(entry.componentName, 'componentName'), path: requiredText(entry.path, 'path'),
      ...(entry.datasourceTemplateId !== undefined ? { datasourceTemplateId: canonicalId(entry.datasourceTemplateId) } : {}),
      fields: names(entry.fields), parameters: names(entry.parameters), placeholders: names(entry.placeholders) };
  }).sort((a, b) => compare(a.renderingId, b.renderingId));
  if (new Set(renderings.map(r => r.renderingId)).size !== renderings.length) throw new Error('Duplicate target rendering ID');
  return { schemaVersion: 1, targetInstance: requiredText(input.targetInstance, 'targetInstance'), ...(input.siteName !== undefined ? { siteName: requiredText(input.siteName, 'siteName') } : {}), renderings };
}
export function createTargetRenderingInventory(input) {
  const body = targetContents(input);
  return { ...body, fingerprint: sha256(JSON.stringify(body)) };
}
export function validateTargetRenderingInventory(input) {
  object(input, 'target inventory');
  const { fingerprint, ...body } = input;
  if (body.schemaVersion !== 1) throw new Error('Unsupported target schemaVersion');
  const normalized = targetContents(body);
  if (fingerprint !== sha256(JSON.stringify(normalized))) throw new Error('Target inventory fingerprint is stale or invalid');
  return { ...normalized, fingerprint };
}

export function validateSourceMappingInventory(input) {
  object(input, 'source inventory');
  const { fingerprint, generatedAt: _generatedAt, ...body } = input;
  if (body.schemaVersion !== 2) throw new Error('Source mapping inventory must use schemaVersion 2');
  if (fingerprint !== sha256(JSON.stringify(body))) throw new Error('Source mapping inventory fingerprint is stale or invalid');
  object(input.metadata, 'source metadata');
  const seen = new Set();
  for (const rendering of list(input.renderings, 'source renderings')) {
    const id = canonicalId(rendering.renderingId);
    if (seen.has(id)) throw new Error(`Duplicate source rendering ID: ${id}`);
    seen.add(id);
    requiredText(rendering.name, 'rendering name');
    const configurations = new Set();
    for (const c of list(rendering.configurations, 'source configurations')) {
      const key = requiredText(c.configurationKey, 'configurationKey');
      if (configurations.has(key)) throw new Error(`Duplicate source configuration: ${key}`);
      configurations.add(key);
    }
    const variants = list(rendering.variants, 'source rendering variants').map(v => v.variantId == null ? null : canonicalId(v.variantId));
    if (new Set(variants).size !== variants.length) throw new Error(`Duplicate source rendering variant: ${id}`);
  }
  const keys = new Set(), configurations = new Set();
  for (const r of list(input.requirements, 'source requirements')) {
    const id = canonicalId(r.renderingId), key = requiredText(r.key, 'requirement key'), config = requiredText(r.configurationKey, 'configurationKey');
    if (!seen.has(id)) throw new Error(`Source requirement rendering ID is absent: ${id}`);
    if (key !== `${id}:${config}`) throw new Error(`Source requirement key does not match its rendering/configuration: ${key}`);
    if (keys.has(key) || configurations.has(JSON.stringify([id, config]))) throw new Error(`Duplicate source requirement: ${key}`);
    keys.add(key); configurations.add(JSON.stringify([id, config]));
  }
  return input;
}

/** Exhaustive mapping scope includes unused definitions/variants, independent of capture selection. */
export function sourceMappingRequirements(source) {
  validateSourceMappingInventory(source);
  const result = structuredClone(source.requirements);
  for (const rendering of source.renderings) {
    const id = canonicalId(rendering.renderingId);
    const rows = result.filter(r => canonicalId(r.renderingId) === id);
    if (!rows.some(r => r.variantId == null)) result.push({ key: `${id}:definition`, renderingId: id, renderingName: rendering.name, configurationKey: 'definition', variantId: null, parameters: {}, definitionOnly: true, sourceOccurrences: [], routes: [] });
    for (const variant of rendering.variants) {
      const variantId = variant.variantId == null ? null : canonicalId(variant.variantId);
      if (variantId === null || rows.some(r => r.variantId != null && canonicalId(r.variantId) === variantId)) continue;
      const configurationKey = `variant:${variantId}`;
      result.push({ key: `${id}:${configurationKey}`, renderingId: id, renderingName: rendering.name, configurationKey, variantId, parameters: {}, definitionOnly: true, sourceOccurrences: [], routes: [] });
    }
    for (const configuration of rendering.configurations) if (!result.some(r => canonicalId(r.renderingId) === id && r.configurationKey === configuration.configurationKey)) {
      result.push({ ...structuredClone(configuration), key: `${id}:${configuration.configurationKey}`, renderingId: id, renderingName: rendering.name, definitionOnly: true, sourceOccurrences: [], routes: [] });
    }
  }
  return result.sort((a, b) => compare(a.key, b.key));
}

export function validateComponentMappingDecision(input) {
  exact(input, decisionKeys, 'mapping decision');
  if (!['reuse-target', 'implement-missing', 'disregard'].includes(input.action)) throw new Error('Unknown mapping action');
  if (typeof input.confirmed !== 'boolean') throw new Error('Mapping confirmed must be boolean');
  const d = { sourceRenderingId: canonicalId(input.sourceRenderingId), ...(input.configurationKey !== undefined ? { configurationKey: requiredText(input.configurationKey, 'configurationKey') } : {}), action: input.action, confirmed: input.confirmed };
  for (const key of ['targetRenderingId', 'targetDatasourceTemplateId']) if (input[key] !== undefined) d[key] = canonicalId(input[key]);
  for (const key of ['targetComponent', 'targetVariant', 'rationale']) if (input[key] !== undefined) d[key] = requiredText(input[key], key);
  for (const key of mapNames) d[key] = ruleMap(input[key], key);
  if (d.action === 'reuse-target' && (!d.targetRenderingId || !d.targetComponent)) throw new Error('reuse-target requires targetRenderingId and targetComponent');
  if (d.action !== 'reuse-target' && (d.targetRenderingId || d.targetComponent || d.targetVariant || d.targetDatasourceTemplateId || mapNames.some(key => Object.keys(d[key]).length))) throw new Error(`${d.action} cannot specify target reuse details or transformation rules`);
  if (d.action === 'disregard' && !d.rationale) throw new Error('disregard requires an explicit scope rationale');
  return d;
}
function parseManifest(input) {
  exact(input, ['schemaVersion', 'sourceFingerprint', 'targetInventoryFingerprint', 'decisions'], 'mapping manifest');
  if (input.schemaVersion !== 1) throw new Error('Unsupported mapping schemaVersion');
  const decisions = list(input.decisions, 'mapping decisions').map(validateComponentMappingDecision).sort((a, b) => compare(JSON.stringify([a.sourceRenderingId, a.configurationKey ?? null]), JSON.stringify([b.sourceRenderingId, b.configurationKey ?? null])));
  const keys = decisions.map(d => JSON.stringify([d.sourceRenderingId, d.configurationKey ?? null]));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate mapping decision');
  return { schemaVersion: 1, sourceFingerprint: requiredText(input.sourceFingerprint, 'sourceFingerprint'), targetInventoryFingerprint: requiredText(input.targetInventoryFingerprint, 'targetInventoryFingerprint'), decisions };
}
export function validateComponentMappings(manifest, { sourceInventory, targetInventory }) {
  const source = validateSourceMappingInventory(sourceInventory), target = validateTargetRenderingInventory(targetInventory), parsed = parseManifest(manifest);
  if (parsed.sourceFingerprint !== source.fingerprint) throw new Error('Component mapping source fingerprint is stale');
  if (parsed.targetInventoryFingerprint !== target.fingerprint) throw new Error('Component mapping target inventory fingerprint is stale');
  const scope = sourceMappingRequirements(source);
  for (const decision of parsed.decisions) {
    const sourceId = decision.sourceRenderingId;
    if (!source.renderings.some(r => canonicalId(r.renderingId) === sourceId)) throw new Error(`Source rendering ID is absent from inventory: ${sourceId}`);
    if (decision.configurationKey !== undefined && !scope.some(r => canonicalId(r.renderingId) === sourceId && r.configurationKey === decision.configurationKey)) throw new Error(`Source configuration key is absent from inventory: ${decision.configurationKey}`);
    if (decision.action !== 'reuse-target') continue;
    const rendering = target.renderings.find(r => r.renderingId === decision.targetRenderingId);
    if (!rendering) throw new Error(`Target rendering ID is absent from inventory: ${decision.targetRenderingId}`);
    if (rendering.componentName !== decision.targetComponent) throw new Error('Target component name does not match inventory');
    if (decision.targetDatasourceTemplateId && decision.targetDatasourceTemplateId !== rendering.datasourceTemplateId) throw new Error('Target datasource template does not match inventory');
  }
  return parsed;
}
export function resolveComponentMapping(manifest, renderingId, configurationKey) {
  const parsed = parseManifest(manifest), id = canonicalId(renderingId);
  const candidates = parsed.decisions.filter(d => d.sourceRenderingId === id);
  return (configurationKey === undefined ? undefined : candidates.find(d => d.configurationKey === configurationKey)) ?? candidates.find(d => d.configurationKey === undefined);
}
