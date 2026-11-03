#!/usr/bin/env node
// Isolated synthetic evidence only. Native Node; never edits source pages or contacts a CMS.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateComponentMigrationPlan } from '../mapping/component-migration-plan.mjs';
import { transformMappedRendering } from '../mapping/mapped-rendering.mjs';
import { validateSourceMappingInventory } from '../mapping/component-mapping.mjs';
import { verifyComponentMigrationPlanEvidence } from '../mapping/cli-files.mjs';

const canonical = (value) => value.replace(/[{}-]/g, '').toLowerCase();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const variants = new Set(['fieldnames', 'renderingvariant', 'variantid']);
const own = (value, key) => Object.hasOwn(value, key);
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object`);
  return value;
}
function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonblank string`);
  return value;
}
function jsonTree(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const entry of value) jsonTree(entry, label); return; }
  record(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`${label} contains reserved key: ${key}`);
    jsonTree(entry, label);
  }
}
function parameters(value, label) {
  record(value, label);
  const keys = new Set();
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key) || !key.trim() || typeof entry !== 'string') throw new Error(`${label} must contain safe string parameters`);
    if (keys.has(key.toLowerCase())) throw new Error(`${label} contains duplicate parameter casing: ${key}`);
    keys.add(key.toLowerCase());
  }
  return value;
}
function fixture(value) {
  record(value, 'fixture');
  const allowed = new Set(['requirementKey', 'fields', 'parameters', 'placeholder', 'datasource', 'unresolvedDependencies']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown fixture property: ${key}`);
  nonblank(value.requirementKey, 'fixture.requirementKey');
  record(value.fields, 'fixture.fields');
  jsonTree(value.fields, 'fixture.fields');
  if (own(value, 'parameters')) parameters(value.parameters, 'fixture.parameters');
  if (own(value, 'placeholder')) { nonblank(value.placeholder, 'fixture.placeholder'); if (forbidden.has(value.placeholder)) throw new Error('Reserved fixture placeholder'); }
  if (own(value, 'datasource') && typeof value.datasource !== 'string') throw new Error('fixture.datasource must be a string');
  if (own(value, 'unresolvedDependencies') && (!Array.isArray(value.unresolvedDependencies) || value.unresolvedDependencies.some((d) => typeof d !== 'string' || !d.trim()))) throw new Error('fixture.unresolvedDependencies must contain nonblank strings');
  return value;
}
function requirements(source) {
  validateSourceMappingInventory(source);
  if (source.schemaVersion !== 2 || !Array.isArray(source.renderings) || !Array.isArray(source.requirements)) throw new Error('Expected schemaVersion 2 source mapping inventory');
  nonblank(source.fingerprint, 'source fingerprint');
  const renderings = new Map();
  for (const r of source.renderings) {
    const id = canonical(nonblank(r.renderingId, 'renderingId'));
    if (renderings.has(id)) throw new Error(`Duplicate rendering ID: ${id}`);
    renderings.set(id, r);
  }
  const rows = new Map();
  for (const r of source.requirements) {
    nonblank(r.key, 'requirement key');
    if (rows.has(r.key)) throw new Error(`Duplicate requirement key: ${r.key}`);
    rows.set(r.key, r);
  }
  // Discovery can omit a default definition when a rendering has variant definitions.
  // Make that target addressable, but never select it automatically.
  for (const [id, rendering] of renderings) {
    const targets = [null, ...(rendering.variants ?? []).map((v) => v.variantId).filter(Boolean)];
    for (const variantId of targets) {
      if ([...rows.values()].some((r) => canonical(r.renderingId) === id && (r.variantId ? canonical(r.variantId) : null) === (variantId ? canonical(variantId) : null))) continue;
      const configurationKey = variantId ? `variant:${canonical(variantId)}` : 'definition';
      const key = `${id}:${configurationKey}`;
      if (rows.has(key)) throw new Error(`Conflicting synthetic requirement key: ${key}`);
      rows.set(key, { key, renderingId: id, renderingName: rendering.name, configurationKey, variantId: variantId ? canonical(variantId) : null, parameters: {}, definitionOnly: true });
    }
  }
  return { rows, renderings };
}
function dependencyWarnings(source, rendering, r) {
  const deps = rendering.dependencies ?? {};
  const warnings = [];
  if (deps.datasourceTemplateReference && !deps.datasourceTemplateId && !(deps.datasourceTemplateIds ?? []).length) warnings.push('Unresolved datasource template');
  if (deps.parametersTemplateReference && !deps.parametersTemplateId) warnings.push('Unresolved parameters template');
  if (deps.resolverReference) warnings.push(`Runtime datasource resolver: ${deps.resolverReference}`);
  if (deps.componentQuery) warnings.push('Runtime component query requires representative resolved context');
  if (deps.placeholderSettingsReferences || deps.layoutServicePlaceholders) warnings.push('Nested placeholder dependencies require representative child layouts');
  if (r.variantId && !(source.variants ?? []).some((v) => v.variantId && canonical(v.variantId) === canonical(r.variantId) && (v.renderingIds ?? []).some((id) => canonical(id) === canonical(r.renderingId)))) warnings.push('Variant definition or rendering association is unresolved');
  for (const reference of source.metadata?.unresolvedReferences ?? []) {
    if (!reference || typeof reference !== 'object') continue;
    const referenceId = reference.renderingId ?? reference.rendering_id ?? reference.source_item_id;
    const referencePath = reference.rendering_path ?? reference.source_item_path;
    const affected = (typeof referenceId === 'string' && canonical(referenceId) === canonical(r.renderingId)) || (typeof referencePath === 'string' && typeof rendering.path === 'string' && referencePath.toLowerCase() === rendering.path.toLowerCase());
    if (affected) warnings.push(`Unresolved source dependency: ${JSON.stringify(reference)}`);
  }
  return warnings;
}

/** Explicitly selected unused definitions only; output is never source/target visual proof. */
export function buildComponentExamples(source, options = {}) {
  const { rows, renderings } = requirements(source);
  const selected = options.selectedRequirementKeys ?? [];
  if (!Array.isArray(selected) || selected.some((key) => typeof key !== 'string' || !key.trim()) || new Set(selected).size !== selected.length) throw new Error('selectedRequirementKeys must be unique nonblank strings');
  if (!Array.isArray(options.fixtures ?? [])) throw new Error('fixtures must be an array');
  const fixtures = new Map();
  for (const raw of options.fixtures ?? []) {
    const f = fixture(raw);
    if (!selected.includes(f.requirementKey)) throw new Error(`Fixture has no selected eligible requirement: ${f.requirementKey}`);
    if (fixtures.has(f.requirementKey)) throw new Error(`Duplicate fixture: ${f.requirementKey}`);
    fixtures.set(f.requirementKey, f);
  }
  const language = nonblank(options.language ?? source.metadata?.source?.language ?? 'en', 'language');
  const plan = options.mappingPlan;
  if (selected.length) {
    validateComponentMigrationPlan(plan, { requireApproval: true });
    if (plan.approval?.status !== 'approved' || !plan.approval.decisionId || plan.sourceFingerprint !== source.fingerprint) throw new Error('An approved mapping plan bound to the source inventory is required');
  }
  return [...selected].sort().map((key) => {
    const r = rows.get(key);
    if (!r) throw new Error(`Unknown selected requirement: ${key}`);
    const rendering = renderings.get(canonical(r.renderingId));
    const variant = rendering?.variants?.find((v) => (v.variantId ? canonical(v.variantId) : null) === (r.variantId ? canonical(r.variantId) : null));
    const observedConfiguration = source.requirements.some((row) => canonical(row.renderingId) === canonical(r.renderingId) && (row.variantId ? canonical(row.variantId) : null) === (r.variantId ? canonical(r.variantId) : null) && row.sourceOccurrences?.length);
    const unused = !observedConfiguration && (r.variantId ? variant?.usageStatus === 'unused' : rendering?.usage?.status === 'unused' || (rendering?.usage?.status === 'used' && rendering.usage.countsComplete === true && variant?.usageStatus !== 'used'));
    if (!rendering || source.metadata?.completeness?.pageUsage !== true || rendering.usage?.countsComplete !== true || rendering.usage?.status === 'unknown' || r.definitionOnly !== true || r.sourceOccurrences?.length || !unused) throw new Error(`Selected requirement is not a certified unused definition: ${key}`);
    const sourceParameters = parameters(r.parameters ?? {}, 'source parameters');
    const entries = plan.entries.filter((entry) => entry.key === key);
    if (entries.length !== 1 || entries[0].confirmed !== true || !['reuse-target', 'implement-missing'].includes(entries[0].action)) throw new Error(`Selected requirement lacks an eligible approved mapping disposition: ${key}`);
    const entry = entries[0];
    if (canonical(entry.sourceRenderingId) !== canonical(r.renderingId) || (entry.variantId ? canonical(entry.variantId) : null) !== (r.variantId ? canonical(r.variantId) : null)) throw new Error(`Approved mapping identity differs from selected requirement: ${key}`);
    const f = fixtures.get(key);
    const sourceKeys = new Set(Object.keys(sourceParameters).map((k) => k.toLowerCase()));
    const hasVariant = [...sourceKeys].some((k) => variants.has(k));
    const params = Object.fromEntries([
      ...Object.entries(f?.parameters ?? {}).filter(([k]) => !sourceKeys.has(k.toLowerCase()) && !variants.has(k.toLowerCase())),
      ...Object.entries(sourceParameters),
      ...(r.variantId && !hasVariant ? [['FieldNames', r.variantId]] : []),
    ]);
    const unresolvedDependencies = [...new Set([...dependencyWarnings(source, rendering, r), ...(f?.unresolvedDependencies ?? [])])].sort();
    const status = !f ? 'fixture-required' : unresolvedDependencies.length ? 'dependency-required' : 'layout-ready';
    const token = digest(key).slice(0, 32);
    const uid = `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`;
    const route = `/__migration_examples/${token}`;
    const sourceConfiguration = { renderingId: r.renderingId, componentName: rendering.componentName ?? r.renderingName ?? rendering.name, configurationKey: r.configurationKey, fields: structuredClone(f?.fields ?? {}), parameters: params, placeholder: f?.placeholder ?? 'main', datasource: f?.datasource ?? '', variantId: r.variantId ?? null };
    const preview = entry.action === 'reuse-target' ? transformMappedRendering(sourceConfiguration, entry, { plan }) : sourceConfiguration;
    return {
      requirementKey: key, sourceRenderingId: r.renderingId, variantId: r.variantId ?? null,
      sourceConfiguration, mappingAction: entry.action,
      route, relativeFile: `${route.slice(1)}/index.json`, status, synthetic: true, visualValidation: 'pending', unresolvedDependencies,
      reason: !f ? 'Representative fixture fields and runtime context are required before preview.' : unresolvedDependencies.length ? `Requires: ${unresolvedDependencies.join(', ')}` : 'Synthetic layout ready for preview; implementation and appearance still require validation.',
      layout: {
        _migrationExample: { synthetic: true, requirementKey: key, sourceFingerprint: source.fingerprint, visualValidation: 'pending' },
        sitecore: {
          context: { pageEditing: false, language },
          route: { itemId: uid, name: `Example: ${rendering.name}`, fields: {}, placeholders: Object.fromEntries([[preview.placeholder, [{ uid, renderingId: preview.renderingId, componentName: preview.componentName, dataSource: preview.datasource, params: preview.parameters, fields: preview.fields }]]]) },
        },
      },
    };
  });
}

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path`);
  return resolve(value);
}
function readBound(file, hash, label) {
  const path = absolute(file, `${label}File`);
  if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error(`${label}Sha256 must be a SHA256 digest`);
  const bytes = readFileSync(path);
  if (digest(bytes) !== hash) throw new Error(`${label} SHA256 mismatch`);
  return { path, sha256: hash, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) };
}
function contains(parent, child) { const rel = relative(parent, child); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); }
function freshOutput(value, inputs) {
  const output = absolute(value, 'outputDir');
  if (existsSync(output)) throw new Error('outputDir must be a fresh nonexistent directory');
  const parent = dirname(output);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw new Error('outputDir parent must exist');
  if (resolve(realpathSync(parent)) !== resolve(parent)) throw new Error('outputDir must not traverse symbolic links');
  if (inputs.some((input) => contains(output, input))) throw new Error('outputDir cannot contain source evidence');
  return output;
}

/** Hash-bound reviewed plan gate. Writes only to a newly created isolated directory. */
export function writeComponentExamples(options) {
  record(options, 'options');
  const allowed = new Set(['sourceInventoryFile', 'sourceInventorySha256', 'mappingPlanFile', 'mappingPlanSha256', 'fixturesFile', 'fixturesSha256', 'fixtures', 'selectedRequirementKeys', 'language', 'outputDir']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown example option: ${key}`);
  const source = readBound(options.sourceInventoryFile, options.sourceInventorySha256, 'sourceInventory');
  const boundPlan = readBound(options.mappingPlanFile, options.mappingPlanSha256, 'mappingPlan');
  const plan = verifyComponentMigrationPlanEvidence(boundPlan.value);
  if (plan.approval?.status !== 'approved' || !plan.approval.decisionId) throw new Error('A user-reviewed approved mapping plan is required');
  if (plan.sourceFingerprint !== source.value.fingerprint || !plan.inputFiles?.some((input) => input.role === 'source' && resolve(input.path) === source.path && input.sha256 === source.sha256)) throw new Error('Approved mapping plan does not bind the supplied source inventory');
  if (!Array.isArray(options.selectedRequirementKeys) || !options.selectedRequirementKeys.length) throw new Error('Explicit selectedRequirementKeys are required');
  for (const key of options.selectedRequirementKeys) {
    const entries = plan.entries.filter((entry) => entry.key === key);
    if (entries.length !== 1 || entries[0].confirmed !== true || !['reuse-target', 'implement-missing'].includes(entries[0].action)) throw new Error(`Selected requirement lacks an eligible approved mapping disposition: ${key}`);
  }
  let fixtures = options.fixtures ?? [];
  const inputs = [source.path, boundPlan.path, plan.approvalEvidence.path, ...plan.inputFiles.map((i) => i.path)];
  if (options.fixturesFile !== undefined || options.fixturesSha256 !== undefined) {
    if (options.fixtures !== undefined) throw new Error('Use fixtures or fixturesFile, not both');
    const bound = readBound(options.fixturesFile, options.fixturesSha256, 'fixtures');
    fixtures = bound.value;
    inputs.push(bound.path);
  }
  const examples = buildComponentExamples(source.value, { selectedRequirementKeys: options.selectedRequirementKeys, fixtures, language: options.language, mappingPlan: plan });
  const outputDir = freshOutput(options.outputDir, inputs);
  const manifest = { schemaVersion: 1, kind: 'synthetic-component-examples', synthetic: true, visualValidation: 'pending', sourceInventory: { path: source.path, sha256: source.sha256, fingerprint: source.value.fingerprint }, mappingPlan: { path: boundPlan.path, sha256: boundPlan.sha256, fingerprint: plan.fingerprint, decisionId: plan.approval.decisionId }, examples };
  // mkdir is exclusive: concurrent requests cannot reuse or overwrite another run.
  mkdirSync(outputDir);
  for (const example of examples) {
    const file = resolve(outputDir, example.relativeFile);
    if (!contains(outputDir, file)) throw new Error('Example path escapes outputDir');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(example.layout, null, 2)}\n`, { flag: 'wx' });
  }
  writeFileSync(resolve(outputDir, 'component-examples.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--params') throw new Error('Usage: node build-component-examples.mjs --params <absolute-json-file>');
    const params = absolute(process.argv[3], 'params');
    const options = JSON.parse(readFileSync(params, 'utf8').replace(/^\uFEFF/, ''));
    writeComponentExamples(options);
    console.log(resolve(options.outputDir, 'component-examples.json'));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
