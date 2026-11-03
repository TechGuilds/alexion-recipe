// Structural/integrity validation never grants human approval or visual validation.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateLocalSchema } from './json-schema.mjs';
import { canonicalId, sha256, validateComponentMappingDecision, validateComponentMappings, validateSourceMappingInventory, validateTargetRenderingInventory } from '../mapping/component-mapping.mjs';
import { validateComponentMigrationPlan } from '../mapping/component-migration-plan.mjs';
import { routeFile, validateCapturePlan, validateOutcomeIdentity } from '../capture/rendering-coverage.mjs';

export const sitecoreArtifactKinds = Object.freeze(['rendering-capture-plan', 'rendering-mapping-inventory', 'rendering-coverage-report', 'target-rendering-inventory', 'component-mappings', 'component-migration-plan', 'component-examples', 'capture-result', 'mock-preview-routes', 'mock-preview-deployment']);
function unique(values, label) { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`); }
function capturePlan(plan) {
  if ((plan.scope === 'approved') !== (plan.draft === false)) throw new Error('Capture plan scope/draft mismatch');
  const { schemaVersion: _schemaVersion, fingerprint, ...body } = plan;
  if (fingerprint !== sha256(JSON.stringify(body))) throw new Error('Capture plan fingerprint mismatch');
  // Reuse runtime identity checks after integrity validation. This local copy is
  // only a structural probe: it does not approve a draft or make it executable.
  const structural = { ...plan, scope: 'approved', draft: false };
  const { schemaVersion: _v, fingerprint: _f, ...structuralBody } = structural;
  validateCapturePlan({ ...structural, fingerprint: sha256(JSON.stringify(structuralBody)) });
  if (plan.totalRequirements !== plan.requirements.length || plan.totalRenderings !== new Set(plan.requirements.map(r => canonicalId(r.renderingId))).size) throw new Error('Capture plan totals mismatch');
  for (const r of plan.requirements) if (r.key !== `${canonicalId(r.renderingId)}:variant:${r.variantId ? canonicalId(r.variantId) : 'default'}`) throw new Error('Capture requirement identity mismatch');
}
export function validateSitecoreArtifactSync(kind, value, options = {}) {
  if (!sitecoreArtifactKinds.includes(kind)) throw new Error(`Unknown Sitecore artifact kind: ${kind}`);
  validateLocalSchema(`${kind}.schema.json`, value);
  if (kind === 'rendering-capture-plan') capturePlan(value);
  if (kind === 'rendering-mapping-inventory') validateSourceMappingInventory(value);
  if (kind === 'target-rendering-inventory') validateTargetRenderingInventory(value);
  if (kind === 'component-migration-plan') validateComponentMigrationPlan(value, options);
  if (kind === 'component-mappings') {
    unique(value.decisions.map(d => JSON.stringify([canonicalId(d.sourceRenderingId), d.configurationKey ?? null])), 'mapping decision');
    value.decisions.forEach(validateComponentMappingDecision);
    if (options.sourceInventory !== undefined || options.targetInventory !== undefined) validateComponentMappings(value, options);
  }
  if (['rendering-coverage-report', 'capture-result'].includes(kind) && options.capturePlan !== undefined) {
    capturePlan(options.capturePlan);
    if (options.capturePlan.scope !== 'approved') throw new Error('Capture evidence requires an approved capture plan');
    if (value.capturePlanFingerprint !== options.capturePlan.fingerprint) throw new Error('Capture plan fingerprint is stale');
    for (const outcome of value.outcomes) validateOutcomeIdentity(options.capturePlan, outcome);
  }
  if (kind === 'rendering-coverage-report') {
    unique(value.requirements.map(r => r.key), 'coverage requirement');
    if (value.total !== value.requirements.length || value.captured !== value.requirements.filter(r => r.status === 'captured').length) throw new Error('Coverage totals mismatch');
    for (const r of value.requirements) if ((r.status === 'captured') !== r.examples.some(e => e.status === 'captured') && !r.definitionOnly) throw new Error('Coverage captured status differs from examples');
  }
  if (kind === 'capture-result') {
    const counted = status => value.outcomes.filter(o => o.status === status).length;
    if (value.successCount !== counted('captured') || value.errorCount !== counted('failed') || value.attemptedUrls !== value.outcomes.filter(o => o.status !== 'skipped').length || value.skippedCount < counted('skipped')) throw new Error('Capture result counts mismatch');
    for (const outcome of value.outcomes) {
      routeFile(outcome.route);
      if (outcome.status === 'captured' && (!outcome.layoutFile || !outcome.sha256)) throw new Error('Captured outcome requires layoutFile and sha256');
      if (outcome.status === 'failed' && !outcome.reason) throw new Error('Failed outcome requires a reason');
    }
  }
  if (kind === 'component-examples') {
    unique(value.examples.map(e => e.requirementKey), 'component example');
    for (const example of value.examples) {
      routeFile(example.route);
      if (example.relativeFile !== `${example.route.slice(1)}/index.json`) throw new Error('Synthetic example path mismatch');
      if (example.sourceRenderingId !== example.sourceConfiguration.renderingId || example.variantId !== example.sourceConfiguration.variantId || example.layout._migrationExample.requirementKey !== example.requirementKey || example.layout._migrationExample.sourceFingerprint !== value.sourceInventory.fingerprint) throw new Error('Synthetic example identity mismatch');
    }
  }
  if (kind === 'mock-preview-routes' || kind === 'mock-preview-deployment') {
    unique(value.routes, 'preview route');
    if (value.routes.some(route => !route.startsWith('/') || route.startsWith('//') || /[\\?#\x00-\x20]/.test(route) || route.split('/').some(part => part === '..' || part === '.'))) throw new Error('Unsafe preview route');
  }
  if (kind === 'mock-preview-deployment') {
    unique(value.files.map(ref => ref.path), 'deployment path');
    unique(value.captures.map(c => c.route), 'deployment capture');
    if (JSON.stringify([...value.routes].sort()) !== JSON.stringify(value.captures.map(c => c.route).sort())) throw new Error('Deployment routes differ from captures');
    for (const ref of value.files) if (!ref.path.startsWith('public/') || /[\\\x00-\x20]/.test(ref.path) || ref.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe deployment path');
    for (const capture of value.captures) {
      const file = value.files.find(ref => ref.path === `public/mock-layouts/${routeFile(capture.route)}`);
      if (file?.sha256 !== capture.sha256) throw new Error('Deployment capture hash mismatch');
      if (capture.kind === 'synthetic-component-example' && (capture.synthetic !== true || capture.visualValidation !== 'pending' || !capture.requirementKey)) throw new Error('Synthetic deployment evidence must remain pending');
    }
  }
  return value;
}
export async function validateSitecoreArtifact(kind, value, options = {}) { return validateSitecoreArtifactSync(kind, value, options); }
export function validateSitecoreArtifactFileSync({ kind, file, sha256: expected, ...options }) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('file must be an explicit absolute path');
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('sha256 must be an explicit SHA-256 digest');
  const bytes = readFileSync(file);
  if (sha256(bytes) !== expected) throw new Error('Artifact file SHA-256 mismatch');
  return validateSitecoreArtifactSync(kind, JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), options);
}
export async function validateSitecoreArtifactFile(options) { return validateSitecoreArtifactFileSync(options); }
