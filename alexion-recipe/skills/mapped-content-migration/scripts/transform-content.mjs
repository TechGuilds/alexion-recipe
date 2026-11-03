import { dirname, join } from 'node:path';
import { requireSchema } from './lib/schema.mjs';
import { openSnapshot, snapshotIndex, fieldKey, contextKey } from './lib/snapshot.mjs';
import { createCoverage } from './lib/coverage.mjs';
import { validateInputFile, validateDocuments } from './validate-inputs.mjs';
import { transformFields } from './lib/transform-fields.mjs';
import { createOwnershipResolver } from './lib/ownership.mjs';
import { inside, parentPath, identityKey, plannedId, resolvePath } from './lib/transform-paths.mjs';
import {
  readJSON,
  readArtifactJSON,
  scopedPath,
  normalizeId,
  fail,
  freshDirectory,
  writeNewJSON,
  jsonBytes,
  hash,
  MAX_JSON_BYTES,
  isMain,
  errorReport,
} from './lib/files.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const sorted = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const bounded = (value) => {
  if (Buffer.byteLength(jsonBytes(value)) > MAX_JSON_BYTES)
    throw fail(
      'output-size',
      'item-plan',
      'Generated JSON exceeds 16 MiB; request a smaller approved transformation scope',
    );
  return value;
};

/** Local transformation only. Never submits jobs or writes target content. */
export async function transformContent(inputPath, outputPath) {
  const request = await readJSON(inputPath);
  requireSchema('transformInput', request.value);
  const base = dirname(inputPath),
    input = await readArtifactJSON(base, request.value.migrationInput);
  const validation = await validateInputFile(input.path);
  if (!validation.valid) throw fail('input-validation', 'migrationInput', JSON.stringify(validation.errors));
  const binding = input.value;
  if (binding.itemPlan)
    throw fail(
      'input-plan',
      'migrationInput.itemPlan',
      'Transformation requires source inputs, not a previous item plan',
    );
  const artifactBase = dirname(input.path),
    documents = {};
  for (const name of ['mapping', 'targetInventory', 'destinationPlan', 'identityMap'])
    if (binding[name]) documents[name] = (await readArtifactJSON(artifactBase, binding[name])).value;
  const snapshotPath = await scopedPath(artifactBase, binding.sourceSnapshot.path),
    snapshot = await openSnapshot(snapshotPath);
  if (!snapshot.manifest)
    throw fail(
      'source-state',
      'sourceSnapshot',
      'Prepare a partitioned source snapshot with source-state provenance before transforming',
    );
  if (snapshot.sha256 !== binding.sourceSnapshot.sha256)
    throw fail('hash', 'sourceSnapshot', 'Source descriptor changed');
  const coverageRequest = await readArtifactJSON(base, request.value.snapshotValidation);
  requireSchema('validateSnapshotInput', coverageRequest.value);
  const coverageSource = await scopedPath(dirname(coverageRequest.path), coverageRequest.value.snapshot.path);
  if (coverageRequest.value.snapshot.sha256 !== snapshot.sha256 || coverageSource !== snapshotPath)
    throw fail(
      'coverage-binding',
      'snapshotValidation',
      'Coverage must select the exact transformation snapshot',
    );
  const scope = coverageRequest.value.scope;
  for (const key of ['scopeId', 'instanceId', 'database'])
    if (scope[key] !== snapshot.header[key])
      throw fail('coverage-binding', key, 'Coverage identity differs from source');
  if (
    JSON.stringify(sorted([...scope.rootPaths])) !== JSON.stringify(sorted([...snapshot.header.rootPaths])) ||
    JSON.stringify(sorted([...scope.languages])) !== JSON.stringify(sorted([...snapshot.header.languages]))
  )
    throw fail('coverage-binding', 'scope', 'Coverage roots/languages differ from source');
  if (
    snapshot.manifest &&
    (!snapshot.manifest.complete || snapshot.manifest.sourceStateId !== scope.sourceStateId)
  )
    throw fail(
      'coverage-binding',
      'sourceSnapshot',
      'Source manifest is incomplete or from another source state',
    );
  const coverage = createCoverage(scope);
  for await (const record of snapshot.records()) coverage.add(record);
  if (!coverage.report().ready)
    throw fail('coverage', 'sourceSnapshot', 'Required source coverage is incomplete');
  const index = await snapshotIndex(snapshot),
    { mapping, targetInventory: target, destinationPlan: destination } = documents;
  if (!target.rootPaths.some((root) => inside(root, destination.targetRootPath)))
    throw fail(
      'target-scope',
      'destinationPlan.targetRootPath',
      'Destination root is outside target inventory scope',
    );
  const namespace = [
    binding.scopeId,
    snapshot.header.instanceId,
    target.instanceId,
    target.database,
    destination.targetRootPath,
  ].map(normalizeId);
  const groups = new Map(
    mapping.templates.flatMap((g) => g.source.map((s) => [normalizeId(s.templateId), g])),
  );
  const templates = new Map(target.templates.map((t) => [normalizeId(t.id), t]));
  const saved = new Map((documents.identityMap?.entries ?? []).map((i) => [identityKey(i), i]));
  const excluded = new Map(destination.exclusions.map((e) => [normalizeId(e.sourceItemId), e.reason]));
  const issues = [],
    items = [],
    structures = new Map(),
    pendingReferences = [],
    deferredParameters = [],
    exclusions = [],
    pages = new Map();
  const issue = (code, message, severity = 'error') => issues.push({ code, message, severity });
  const rulesFor = (templateId) => destination.rules.filter((r) => same(r.sourceTemplateId, templateId));
  const pageRule = (item) => rulesFor(item.templateId).filter((r) => r.kind === 'page');
  for (const item of index.items.values()) {
    if (excluded.has(normalizeId(item.id))) continue;
    const rules = pageRule(item);
    if (
      rules.length === 1 &&
      rules[0].identity === 'source-item' &&
      !rules[0].pathPattern.includes('{targetPagePath}')
    ) {
      try {
        pages.set(
          normalizeId(item.id),
          resolvePath(rules[0], item.name, undefined, destination.targetRootPath),
        );
      } catch (e) {
        issue(e.code, e.message);
      }
    } else if (rules.length) issue('page-rule', `Page ${item.id} needs one source-item page destination`);
  }
  const owners = await createOwnershipResolver(snapshot, index, destination, pages, issue);
  function identityFor(source, rule, pageId, context) {
    const identity = { sourceItemId: source.id, outputKey: rule.outputKey };
    if (rule.identity === 'source-item-and-page') identity.pageId = pageId;
    if (rule.identity === 'rendering-instance') {
      if (!context)
        throw fail('rendering-context', rule.outputKey, 'Rendering identity requires an explicit occurrence');
      Object.assign(identity, {
        pageId: context.pageId,
        renderingInstanceId: context.instanceId,
        deviceId: context.deviceId,
        language: context.language,
        version: context.version,
      });
    }
    identity.targetPath = resolvePath(
      rule,
      source.name,
      pages.get(normalizeId(pageId)),
      destination.targetRootPath,
    );
    identity.targetItemId = plannedId(namespace, identityKey(identity));
    const prior = saved.get(identityKey(identity));
    if (prior) {
      if (!same(prior.targetPath, identity.targetPath))
        throw fail(
          'identity-drift',
          rule.outputKey,
          'Saved destination differs; review mapping/path changes before rerunning',
        );
      identity.targetItemId = prior.targetItemId;
    }
    return identity;
  }
  let generatedBytes = 0;
  function addOutput(source, rule, pageId, context) {
    const start = issues.length;
    if (rule.branchId) {
      issue(
        'branch-unsupported',
        `Output ${source.id}/${rule.outputKey} needs branch child topology absent from current inventory`,
      );
      return;
    }
    let identity;
    try {
      identity = identityFor(source, rule, pageId, context);
    } catch (e) {
      issue(e.code ?? 'destination', e.message);
      return;
    }
    const template = templates.get(normalizeId(rule.targetTemplateId));
    const scopedIssue = (code, message) => issue(code, `${source.id}/${rule.outputKey}: ${message}`);
    const transformed = transformFields(
      source,
      groups.get(normalizeId(source.templateId)),
      template,
      scopedIssue,
      destination.fieldCompatibility ?? [],
    );
    // Presentation fields are always owned by Presentation Composition.
    for (const field of transformed.fields) {
      const definition = template.fields.find((f) => same(f.id, field.fieldId));
      if (/^__(?:final\s*)?renderings$/i.test(definition.name))
        scopedIssue('presentation-field', 'Content transformation cannot assign presentation');
    }
    const existing = target.items.find((t) => same(t.path, identity.targetPath));
    let action = rule.existingItem === 'create-only' ? 'create' : rule.existingItem;
    if (existing) {
      if (!same(existing.templateId, rule.targetTemplateId) || rule.existingItem === 'create-only')
        scopedIssue('collision', `Target path already exists: ${identity.targetPath}`);
      else if (saved.has(identityKey(identity)) && !same(existing.id, identity.targetItemId))
        scopedIssue('identity-drift', 'Existing target differs from saved identity');
      else identity.targetItemId = existing.id;
    } else if (rule.existingItem === 'reuse')
      scopedIssue('missing-reuse', `Reuse target is absent from supplied evidence: ${identity.targetPath}`);
    else if (rule.existingItem === 'update') action = 'create';
    const idOccupant = target.items.find((t) => same(t.id, identity.targetItemId));
    if (idOccupant && !same(idOccupant.path, identity.targetPath))
      scopedIssue('collision', 'Planned ID belongs to another target path');
    if (rule.folderRuleKey) {
      const folder = destination.folders.find((f) => f.key === rule.folderRuleKey);
      const suffix = '/' + folder.segments.map((s) => s.name).join('/');
      let path = parentPath(identity.targetPath);
      if (!path.endsWith(suffix))
        scopedIssue('folder-path', 'Folder rule segments disagree with the destination parent');
      else {
        path = path.slice(0, -suffix.length);
        for (const segment of folder.segments) {
          if (/[\\/:*?"<>|{}\[\]\x00-\x1f]/.test(segment.name) || /^[.\s]+$/.test(segment.name)) {
            scopedIssue('folder-path', 'Unsafe folder name');
            break;
          }
          path += '/' + segment.name;
          const prior = structures.get(normalizeId(path));
          const actual = target.items.find((i) => same(i.path, path));
          if (
            (prior && !same(prior.templateId, segment.templateId)) ||
            (actual && !same(actual.templateId, segment.templateId))
          )
            scopedIssue('folder-conflict', `Incompatible folder at ${path}`);
          else
            structures.set(normalizeId(path), {
              targetPath: path,
              targetItemId: actual?.id ?? plannedId(namespace, 'folder|' + normalizeId(path)),
              templateId: segment.templateId,
              parentPath: parentPath(path),
              action: actual ? 'reuse' : 'create',
            });
        }
      }
    }
    const item = {
      identity,
      templateId: rule.targetTemplateId,
      action: issues.length === start ? action : 'conflict',
      versions: sorted([...source.versions]),
      parentPath: parentPath(identity.targetPath),
      fields: transformed.fields,
      relationships: [],
    };
    items.push(item);
    for (const ref of transformed.references)
      pendingReferences.push({ owner: identity, sourceTemplateId: source.templateId, ...ref });
    generatedBytes += Buffer.byteLength(jsonBytes(item));
    if (generatedBytes > MAX_JSON_BYTES)
      throw fail(
        'output-size',
        'item-plan',
        'Generated items exceed 16 MiB; request a smaller approved transformation scope',
      );
  }
  // Source values are streamed. Only the bounded generated plan retains values.
  for await (const record of snapshot.records()) {
    const source = record.data;
    if (record.kind === 'item') {
      if (excluded.has(normalizeId(source.id))) {
        exclusions.push({ sourceItemId: source.id, reason: excluded.get(normalizeId(source.id)) });
        continue;
      }
      for (const rule of rulesFor(source.templateId).filter((r) => r.kind === 'parameters')) {
        const contexts = index.contexts.filter(
          (c) =>
            (same(c.datasourceId, source.id) || same(c.pageId, source.id)) &&
            !excluded.has(normalizeId(c.pageId)),
        );
        if (!contexts.length)
          issue(
            'parameter-context',
            `Parameter mapping for ${source.id} needs a captured consuming occurrence`,
          );
        for (const context of contexts)
          deferredParameters.push({
            sourceItemId: source.id,
            context: contextKey(context),
            targetTemplateId: rule.targetTemplateId,
            outputKey: rule.outputKey,
          });
      }
      for (const rule of rulesFor(source.templateId).filter((r) => r.kind !== 'parameters')) {
        if (rule.identity === 'rendering-instance') {
          const contexts = index.contexts.filter(
            (c) => same(c.datasourceId, source.id) && !excluded.has(normalizeId(c.pageId)),
          );
          if (!contexts.length)
            issue('rendering-context', `No captured occurrence for ${source.id}/${rule.outputKey}`);
          for (const context of contexts) addOutput(source, rule, context.pageId, context);
        } else if (
          rule.identity === 'source-item-and-page' ||
          rule.pathPattern.includes('{targetPagePath}')
        ) {
          const pages = owners(source);
          if (!pages.length)
            issue('page-owner', `No captured consuming page for ${source.id}/${rule.outputKey}`);
          for (const pageId of pages) addOutput(source, rule, pageId);
        } else addOutput(source, rule);
      }
    } else {
      if (excluded.has(normalizeId(source.pageId)) || !source.parameterTemplateId) continue;
      const synthetic = {
        id: source.instanceId,
        templateId: source.parameterTemplateId,
        name: source.instanceId.replace(/[{}]/g, ''),
        versions: [{ language: source.language, version: source.version }],
        fields: source.parameters,
        references: [],
      };
      for (const rule of rulesFor(source.parameterTemplateId)) {
        if (rule.kind === 'parameters') {
          deferredParameters.push({
            context: contextKey(source),
            targetTemplateId: rule.targetTemplateId,
            outputKey: rule.outputKey,
          });
          continue;
        }
        if (rule.identity !== 'rendering-instance') {
          issue('parameter-identity', 'Parameter-derived content requires full rendering-instance identity');
          continue;
        }
        addOutput(synthetic, rule, source.pageId, source);
      }
    }
  }
  const identities = new Map(),
    paths = new Map(),
    ids = new Map();
  for (const item of items) {
    const i = item.identity,
      key = identityKey(i);
    for (const [map, value] of [
      [identities, key],
      [paths, normalizeId(i.targetPath)],
      [ids, normalizeId(i.targetItemId)],
    ]) {
      if (map.has(value)) {
        item.action = 'conflict';
        map.get(value).action = 'conflict';
        issue('collision', `Several outputs select ${i.targetPath}`);
      }
      map.set(value, item);
    }
    if (structures.has(normalizeId(i.targetPath))) {
      item.action = 'conflict';
      issue('folder-conflict', `Content and folder select ${i.targetPath}`);
    }
  }
  const parentPaths = new Set([
    ...paths.keys(),
    ...structures.keys(),
    ...target.items.map((i) => normalizeId(i.path)),
  ]);
  const structureIds = new Set();
  for (const structure of structures.values()) {
    const id = normalizeId(structure.targetItemId);
    if (
      ids.has(id) ||
      structureIds.has(id) ||
      target.items.some((i) => same(i.id, id) && !same(i.path, structure.targetPath))
    )
      issue('folder-conflict', `Structural ID conflicts at ${structure.targetPath}`);
    structureIds.add(id);
  }
  for (const row of [
    ...items.map((i) => ({ path: i.identity.targetPath, parent: i.parentPath })),
    ...[...structures.values()].map((s) => ({ path: s.targetPath, parent: s.parentPath })),
  ]) {
    if (!inside(destination.targetRootPath, row.path) || !parentPaths.has(normalizeId(row.parent)))
      issue('missing-parent', `No explicit target item or folder rule supplies parent ${row.parent}`);
  }
  const referenceDependencies = [];
  for (const ref of pendingReferences) {
    const choice = destination.referenceRules.find(
      (r) => same(r.sourceTemplateId, ref.sourceTemplateId) && same(r.sourceFieldId, ref.sourceFieldId),
    );
    const targets = [],
      existingTargets = [];
    for (const id of ref.targetSourceIds) {
      let candidates = items.filter(
        (i) =>
          same(i.identity.sourceItemId, id) &&
          i.action !== 'conflict' &&
          (!choice || i.identity.outputKey === choice.targetOutputKey),
      );
      candidates = candidates.filter(
        (i) => !i.identity.pageId || same(i.identity.pageId, ref.owner.pageId ?? ref.owner.sourceItemId),
      );
      const existing = destination.existingReferenceTargets?.find((t) => same(t.sourceItemId, id));
      if (existing && !candidates.length) existingTargets.push(existing);
      else if (candidates.length !== 1 || existing)
        issue(
          'reference-dependency',
          `Reference ${ref.sourceFieldId} from ${ref.owner.sourceItemId} needs one approved output for ${id}`,
        );
      else targets.push(candidates[0].identity);
    }
    const complete = targets.length + existingTargets.length === ref.targetSourceIds.length;
    referenceDependencies.push({
      ...ref,
      targets,
      ...(existingTargets.length ? { existingTargets } : {}),
      status: complete ? 'planned' : 'unresolved',
    });
    if (complete)
      identities.get(identityKey(ref.owner)).relationships.push({
        fieldId: ref.fieldId,
        ...(ref.language ? { language: ref.language } : {}),
        ...(ref.version ? { version: ref.version } : {}),
        targets,
      });
  }
  if (pendingReferences.length)
    issue(
      'reference-resolution-required',
      'Raw source reference values are retained; a later approved resolver must rewrite and verify them before target completion',
      'warning',
    );
  const plan = {
    version: 1,
    scopeId: binding.scopeId,
    mappingRevision: binding.mappingRevision,
    inputs: Object.fromEntries(
      ['mapping', 'sourceSnapshot', 'targetInventory', 'destinationPlan'].map((k) => [k, binding[k].sha256]),
    ),
    items: items.sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity))),
    structures: [...structures.values()].sort((a, b) => a.targetPath.localeCompare(b.targetPath)),
    issues: sorted(issues),
  };
  const identityMap = {
    version: 1,
    scopeId: binding.scopeId,
    mappingRevision: binding.mappingRevision,
    sourceInstanceId: snapshot.header.instanceId,
    targetInstanceId: target.instanceId,
    entries: plan.items.filter((i) => i.action !== 'conflict').map((i) => i.identity),
  };
  requireSchema('itemPlan', plan);
  requireSchema('identityMap', identityMap);
  // Full relational validation is meaningful only for conflict-free proposed plans.
  if (!issues.some((i) => i.severity === 'error')) {
    const check = validateDocuments(
      {
        ...documents,
        sourceSnapshot: { ...snapshot.header, items: [], renderingInstances: [] },
        itemPlan: plan,
        identityMap,
      },
      binding,
      index,
    );
    if (!check.valid) throw fail('output-validation', 'itemPlan', JSON.stringify(check.errors));
  }
  const report = bounded({
    version: 1,
    scopeId: binding.scopeId,
    ready: !issues.some((i) => i.severity === 'error'),
    transformRequestSha256: request.sha256,
    migrationInputSha256: input.sha256,
    snapshotValidationSha256: coverageRequest.sha256,
    itemPlanSha256: hash(jsonBytes(plan)),
    identityMapSha256: hash(jsonBytes(identityMap)),
    proposedIdentitiesOnly: true,
    exclusions: sorted(exclusions),
    deferredParameters: sorted(deferredParameters),
    referenceDependencies: sorted(referenceDependencies),
    issues: plan.issues,
    itemCount: items.length,
    structureCount: structures.size,
  });
  // Recheck all descriptors before publishing local output evidence.
  await readArtifactJSON(base, request.value.migrationInput);
  await readArtifactJSON(base, request.value.snapshotValidation);
  if ((await readJSON(inputPath)).sha256 !== request.sha256)
    throw fail('input-drift', 'transformInput', 'Transformation request changed while processing');
  if (!(await validateInputFile(input.path)).valid)
    throw fail('input-drift', 'migrationInput', 'Inputs changed while transforming');
  const output = await freshDirectory(outputPath);
  for (const [name, value] of [
    ['item-plan.json', plan],
    ['proposed-identity-map.json', identityMap],
    ['transform-report.json', report],
  ])
    await writeNewJSON(join(output, name), bounded(value));
  return {
    ...report,
    outputs: {
      itemPlan: { path: 'item-plan.json', sha256: hash(jsonBytes(plan)) },
      identityMap: { path: 'proposed-identity-map.json', sha256: hash(jsonBytes(identityMap)) },
    },
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output')
      throw fail(
        'usage',
        'arguments',
        'Usage: node transform-content.mjs --input transform-input.json --output NEW_DIRECTORY',
      );
    const result = await transformContent(args[1], args[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
