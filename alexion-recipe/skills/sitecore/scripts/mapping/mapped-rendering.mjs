// Pure transformation of derived examples. Never rewrites source baseline evidence.
import { canonicalId, decisionKeys, object, validateComponentMappingDecision } from './component-mapping.mjs';
import { validateComponentMigrationPlan } from './component-migration-plan.mjs';

const mappedValue = (map, key) => Object.hasOwn(map, key) ? map[key] : key;
const isVariantSelector = key => ['fieldnames', 'renderingvariant', 'variantid'].includes(key.toLowerCase());
function renameKeys(values, map, label) {
  object(values, label);
  const result = new Map();
  for (const [key, value] of Object.entries(values)) {
    const target = mappedValue(map, key);
    if (result.has(target)) throw new Error(`Mapped ${label} collision at target key "${target}"`);
    result.set(target, value);
  }
  return Object.fromEntries(result);
}
const decisionFrom = value => validateComponentMappingDecision(Object.fromEntries(decisionKeys.filter(k => value[k] !== undefined).map(k => [k, value[k]])));

/** Callers verify current plan/input files before this pure operation. */
export function transformMappedRendering(input, mapping, { plan } = {}) {
  validateComponentMigrationPlan(plan, { requireApproval: true });
  const decision = decisionFrom(mapping);
  if (!decision.confirmed || decision.action !== 'reuse-target') throw new Error('Rendering transformation requires a confirmed reuse-target mapping');
  if (canonicalId(input.renderingId) !== decision.sourceRenderingId || (decision.configurationKey !== undefined && decision.configurationKey !== input.configurationKey)) throw new Error('Mapping does not match rendering source ID/configuration');
  const entry = plan.entries.find(e => e.sourceRenderingId === decision.sourceRenderingId && e.configurationKey === input.configurationKey);
  if (!entry || !entry.confirmed || entry.action !== 'reuse-target') throw new Error('Rendering transformation requires an approved matching plan entry');
  const expected = decisionFrom(entry);
  for (const key of decisionKeys.filter(key => !['configurationKey', 'rationale'].includes(key))) if (JSON.stringify(expected[key]) !== JSON.stringify(decision[key])) throw new Error('Rendering mapping does not match the approved plan entry');
  if (decision.targetVariant !== undefined) for (const [source, target] of Object.entries(decision.parameterMap)) if (isVariantSelector(source) !== isVariantSelector(target)) throw new Error('A parameter rule cannot repurpose a variant selector when targetVariant is specified');
  let parameters = renameKeys(input.parameters, decision.parameterMap, 'parameter');
  if (decision.targetVariant !== undefined) parameters = Object.fromEntries([...Object.entries(parameters).filter(([key]) => !isVariantSelector(key)), ['FieldNames', decision.targetVariant]]);
  return { ...structuredClone(input), renderingId: decision.targetRenderingId, componentName: decision.targetComponent, fields: structuredClone(renameKeys(input.fields, decision.fieldMap, 'field')), parameters, placeholder: mappedValue(decision.placeholderMap, input.placeholder), datasource: mappedValue(decision.datasourceMap, input.datasource), ...(decision.targetVariant !== undefined ? { variantId: decision.targetVariant } : {}), ...(decision.targetDatasourceTemplateId ? { targetDatasourceTemplateId: decision.targetDatasourceTemplateId } : {}) };
}
