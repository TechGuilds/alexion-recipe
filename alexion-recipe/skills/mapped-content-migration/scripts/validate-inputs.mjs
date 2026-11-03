import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './lib/schema.mjs';
import { openSnapshot, snapshotIndex } from './lib/snapshot.mjs';
import { scopedPath, readJSON, readArtifactJSON } from './lib/files.mjs';
export { validateSchema } from './lib/schema.mjs';
const names = [
  'mapping',
  'sourceSnapshot',
  'targetInventory',
  'destinationPlan',
  'itemPlan',
  'identityMap',
  'migrationInput',
];
const norm = (value) => (value == null ? undefined : String(value).toLowerCase());
const same = (a, b) => norm(a) === norm(b);
const issue = (code, path, message) => ({ code, path, message });
const inside = (root, path) => same(root, path) || norm(path).startsWith(norm(root) + '/');
const cleanPath = (path) =>
  typeof path === 'string' &&
  path.startsWith('/sitecore/') &&
  !/[\\\u0000-\u001f]/.test(path) &&
  !path
    .split('/')
    .slice(1)
    .some((p) => !p || p === '.' || p === '..');
const identityKey = (e) =>
  [
    e.sourceItemId,
    e.outputKey,
    e.pageId ?? '',
    e.renderingInstanceId ?? '',
    e.deviceId ?? '',
    e.language ?? '',
    e.version ?? '',
  ]
    .map(norm)
    .join('|');
const fieldKey = (f) => [norm(f.fieldId), f.language ?? '', f.version ?? ''].join('|');

/** Read-only structural and cross-document validation; valid is NOT write approval. */
export function validateDocuments(documents, binding, sourceIndex) {
  const errors = [];
  for (const name of names.filter((n) => n !== 'migrationInput')) {
    if (['itemPlan', 'identityMap'].includes(name) && documents[name] === undefined) continue;
    errors.push(...validateSchema(name, documents[name]));
  }
  if (errors.length) return { valid: false, errors };
  const {
    mapping,
    sourceSnapshot: source,
    targetInventory: target,
    destinationPlan: destination,
    itemPlan,
    identityMap,
  } = documents;
  const add = (code, path, message) => errors.push(issue(code, path, message));
  const unique = (rows, key, path) => {
    const seen = new Set();
    rows.forEach((row, i) => {
      const k = key(row);
      if (seen.has(k)) add('duplicate', `${path}[${i}]`, 'Duplicate identity');
      seen.add(k);
    });
  };
  const scopeId = binding?.scopeId ?? source.scopeId;
  for (const [name, doc] of Object.entries(documents))
    if (name !== 'mapping' && doc.scopeId !== scopeId) add('scope', name, 'Migration scope differs');
  if (binding)
    for (const doc of [itemPlan, identityMap].filter(Boolean))
      if (doc.mappingRevision !== binding.mappingRevision)
        add('mapping-revision', 'mappingRevision', 'Output belongs to another mapping revision');
  if (itemPlan && identityMap && itemPlan.mappingRevision !== identityMap.mappingRevision)
    add('mapping-revision', 'mappingRevision', 'Output revisions differ');

  for (const [name, rows] of Object.entries({
    'source.items': source.items,
    'target.templates': target.templates,
    'target.items': target.items,
    'target.renderings': target.renderings,
    'target.placeholders': target.placeholders,
  })) {
    unique(rows, (r) => norm(r.id), name);
    if (rows.some((r) => r.path))
      unique(
        rows.filter((r) => r.path),
        (r) => norm(r.path),
        name + '.paths',
      );
    rows.forEach((r, i) => {
      if (r.path && !cleanPath(r.path)) add('path', `${name}[${i}]`, 'Unsafe item path');
    });
  }
  for (const [name, paths] of [
    ['source.rootPaths', source.rootPaths],
    ['target.rootPaths', target.rootPaths],
  ])
    paths.forEach((p, i) => {
      if (!cleanPath(p)) add('path', `${name}[${i}]`, 'Unsafe root path');
    });
  for (const [name, doc] of [
    ['source', source],
    ['target', target],
  ])
    if (
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(doc.capturedAt) ||
      !Number.isFinite(Date.parse(doc.capturedAt))
    )
      add('timestamp', `${name}.capturedAt`, 'Expected an ISO timestamp with timezone');

  const templateById = new Map(target.templates.map((t) => [norm(t.id), t]));
  const sourceById = sourceIndex?.items ?? new Map(source.items.map((t) => [norm(t.id), t]));
  const allContexts = sourceIndex?.contexts ?? source.renderingInstances;
  const mappingBySource = new Map();
  const declaringByField = new Map();
  unique(
    mapping.templates.flatMap((g) => g.source),
    (r) => norm(r.templateId),
    'mapping.templates.source',
  );
  unique(
    mapping.renderings.flatMap((g) => g.source),
    (r) => norm(r.renderingId),
    'mapping.renderings.source',
  );
  unique(mapping.placeholders, (r) => norm(r.source.id), 'mapping.placeholders.source');
  for (const [index, group] of mapping.templates.entries()) {
    const path = `mapping.templates[${index}]`;
    group.source.forEach((s) => mappingBySource.set(norm(s.templateId), group));
    const removed = new Set(group.fields.filter((f) => f.action === 'remove').map((f) => norm(f.sfid)));
    if (group.fields.some((f) => f.action === 'map' && removed.has(norm(f.sfid))))
      add('mapping-action', path, 'A source field cannot be both mapped and removed');
    unique(
      group.fields.filter((f) => f.action === 'remove'),
      (f) => norm(f.sfid),
      path + '.removedFields',
    );
    unique(group.target, (r) => norm(r.templateId), path + '.target');
    for (const ref of [...group.source, ...group.target])
      if (!cleanPath(ref.path)) add('path', path, 'Unsafe template path');
    for (const ref of group.target) {
      const actual = templateById.get(norm(ref.templateId));
      if (!actual) add('target-template', path, 'Mapped target template is absent');
      else if (actual.name !== ref.templateName || !same(actual.path, ref.path))
        add('target-template', path, 'Mapped template identity disagrees with target evidence');
    }
    for (const [i, field] of group.fields.entries()) {
      if (field.action === 'remove') continue;
      const fp = `${path}.fields[${i}]`;
      const owners = group.target.filter(
        (t) =>
          same(t.templateId, field.targetTemplateId) ||
          t.baseTemplates.some((b) => same(b.baseTemplateId, field.targetTemplateId)),
      );
      if (owners.length !== 1) {
        add('field-owner', fp, 'Field must belong to exactly one mapped target item template');
        continue;
      }
      const owner = owners[0];
      const declaredName = same(owner.templateId, field.targetTemplateId)
        ? owner.templateName
        : owner.baseTemplates.find((b) => same(b.baseTemplateId, field.targetTemplateId)).baseTemplateName;
      if (declaredName !== field.targetTemplate)
        add('field-owner', fp, 'Declaring-template name disagrees with ID');
      const prior = declaringByField.get(norm(field.tfid));
      if (prior && !same(prior, field.targetTemplateId))
        add('field-owner', fp, 'Target field has conflicting declaring templates');
      declaringByField.set(norm(field.tfid), field.targetTemplateId);
      const actual = templateById.get(norm(owner.templateId))?.fields.find((f) => same(f.id, field.tfid));
      if (!actual) add('target-field', fp, 'Mapped field is absent from effective target template fields');
      else if (!same(actual.declaringTemplateId, field.targetTemplateId) || actual.name !== field.to)
        add('field-owner', fp, 'Target field identity disagrees with evidence');
    }
  }
  for (const template of target.templates) {
    unique(template.fields, (f) => norm(f.id), `target.templates.${template.id}.fields`);
    for (const field of template.fields)
      if (
        !same(field.declaringTemplateId, template.id) &&
        !template.baseTemplateIds.some((b) => same(b, field.declaringTemplateId))
      )
        add(
          'field-owner',
          `target.templates.${template.id}`,
          'Effective field declares an unrelated template',
        );
  }
  for (const group of mapping.renderings)
    for (const r of group.target) {
      const actual = target.renderings.find((a) => same(a.id, r.renderingId));
      if (!actual || actual.name !== r.renderingName || !same(actual.path, r.path))
        add('target-rendering', 'mapping.renderings', 'Target rendering is missing or differs from evidence');
    }
  for (const p of mapping.placeholders)
    if (!target.placeholders.some((a) => same(a.id, p.target.id) && a.key === p.target.key))
      add(
        'target-placeholder',
        'mapping.placeholders',
        'Target placeholder is missing or differs from evidence',
      );

  const versions = (item) => item.versions.map((v) => `${v.language}|${v.version}`);
  function fieldScopes(fields, item, path) {
    unique(fields, fieldKey, path);
    for (const [i, f] of fields.entries()) {
      const valid =
        f.storage === 'shared'
          ? f.language === undefined && f.version === undefined
          : f.storage === 'unversioned'
            ? !!f.language && f.version === undefined && source.languages.includes(f.language)
            : !!f.language &&
              source.languages.includes(f.language) &&
              versions(item).includes(`${f.language}|${f.version}`);
      if (!valid)
        add(
          'field-scope',
          `${path}[${i}]`,
          'Field language/version does not match its storage or captured versions',
        );
    }
  }
  for (const [i, item] of source.items.entries()) {
    unique(item.versions, (v) => `${v.language}|${v.version}`, `source.items[${i}].versions`);
    if (item.versions.some((v) => !source.languages.includes(v.language)))
      add('field-scope', `source.items[${i}]`, 'Item language is outside captured scope');
    if (!source.rootPaths.some((root) => inside(root, item.path)))
      add('path', `source.items[${i}]`, 'Source item is outside snapshot roots');
    fieldScopes(item.fields, item, `source.items[${i}].fields`);
    if (
      !mappingBySource.has(norm(item.templateId)) &&
      !destination.exclusions.some((e) => same(e.sourceItemId, item.id))
    )
      add('source-template', `source.items[${i}]`, 'Source template has no mapping or item exclusion');
  }
  unique(
    source.renderingInstances,
    (r) => [r.pageId, r.deviceId, r.language, r.version, r.instanceId].map(norm).join('|'),
    'source.renderingInstances',
  );
  for (const [i, r] of source.renderingInstances.entries()) {
    const page = sourceById.get(norm(r.pageId));
    if (!page || !versions(page).includes(`${r.language}|${r.version}`))
      add('rendering-context', `source.renderingInstances[${i}]`, 'Rendering page/version is not captured');
    if (r.parameters.length && !r.parameterTemplateId)
      add(
        'rendering-context',
        `source.renderingInstances[${i}]`,
        'Parameter values require a parameter template ID',
      );
    if (r.parameterTemplateId && !mappingBySource.has(norm(r.parameterTemplateId)))
      add('rendering-context', `source.renderingInstances[${i}]`, 'Parameter template has no mapping');
    fieldScopes(
      r.parameters,
      { versions: [{ language: r.language, version: r.version }] },
      `source.renderingInstances[${i}].parameters`,
    );
  }

  if (!cleanPath(destination.targetRootPath)) add('path', 'destination.targetRootPath', 'Unsafe target root');
  unique(destination.rules, (r) => `${norm(r.sourceTemplateId)}|${norm(r.outputKey)}`, 'destination.rules');
  unique(
    destination.rules,
    (r) => `${norm(r.sourceTemplateId)}|${norm(r.targetTemplateId)}`,
    'destination.templatePairs',
  );
  unique(destination.folders, (r) => r.key, 'destination.folders');
  for (const folder of destination.folders)
    for (const segment of folder.segments) {
      if (/[\\/{}\u0000-\u001f]/.test(segment.name) || ['.', '..'].includes(segment.name))
        add('path', 'destination.folders', 'Unsafe folder segment');
      if (templateById.get(norm(segment.templateId))?.kind !== 'folder')
        add('folder-template', 'destination.folders', 'Folder segment requires a discovered folder template');
    }
  for (const [i, rule] of destination.rules.entries()) {
    const p = `destination.rules[${i}]`;
    const group = mappingBySource.get(norm(rule.sourceTemplateId));
    if (!group?.target.some((t) => same(t.templateId, rule.targetTemplateId)))
      add('destination-template', p, 'Rule must select an explicitly mapped target item template');
    const targetTemplate = templateById.get(norm(rule.targetTemplateId));
    if (!targetTemplate) add('target-template', p, 'Destination template is absent');
    if (rule.kind === 'parameters') {
      if (
        rule.pathPattern ||
        rule.folderRuleKey ||
        rule.branchId ||
        rule.scope !== 'rendering-instance' ||
        rule.identity !== 'rendering-instance' ||
        targetTemplate?.kind !== 'parameters'
      )
        add('parameter-item', p, 'Parameter values require rendering-instance scope and no item/folder path');
    } else {
      if (targetTemplate?.kind === 'parameters')
        add('parameter-item', p, 'Parameter template cannot create a content item');
      const pattern = rule.pathPattern ?? '';
      const expanded = pattern
        .replace('{targetPagePath}', destination.targetRootPath)
        .replaceAll('{sourceName}', 'Example')
        .replaceAll('{outputKey}', 'output');
      if (!cleanPath(expanded) || /[{}]/.test(expanded) || !inside(destination.targetRootPath, expanded))
        add('path', p, 'Destination must be inside target root and use supported placeholders');
      if (
        rule.scope === 'page-local' &&
        (rule.identity === 'source-item' ||
          !pattern.startsWith('{targetPagePath}/') ||
          (!rule.folderRuleKey && !rule.branchId))
      )
        add(
          'destination-scope',
          p,
          'Page-local data requires page/instance identity, page-relative path and folder or branch rule',
        );
      if (
        rule.scope === 'global' &&
        (rule.identity === 'source-item-and-page' || pattern.includes('{targetPagePath}'))
      )
        add('destination-scope', p, 'Global data cannot depend on a consuming page');
      if (rule.folderRuleKey && !destination.folders.some((f) => f.key === rule.folderRuleKey))
        add('folder-template', p, 'Folder rule is absent');
      if (rule.branchId && templateById.get(norm(rule.branchId))?.kind !== 'branch')
        add('branch', p, 'Branch definition is absent');
    }
  }
  for (const group of mapping.templates)
    for (const s of group.source)
      for (const t of group.target) {
        if (
          !destination.rules.some(
            (r) => same(r.sourceTemplateId, s.templateId) && same(r.targetTemplateId, t.templateId),
          )
        )
          add(
            'destination-missing',
            'destination.rules',
            'Each mapped source/target template pair needs an explicit destination or parameter rule',
          );
      }
  unique(
    destination.referenceRules,
    (r) => `${norm(r.sourceTemplateId)}|${norm(r.sourceFieldId)}`,
    'destination.referenceRules',
  );
  unique(destination.ownershipRules ?? [], (r) => norm(r.sourceItemId), 'destination.ownershipRules');
  for (const rule of destination.ownershipRules ?? []) {
    if (!sourceById.has(norm(rule.sourceItemId)))
      add('ownership-source', 'destination.ownershipRules', 'Ownership item is not captured');
    if (rule.via === 'explicit-pages') {
      unique(rule.pageIds, (p) => norm(p), 'destination.ownershipRules.pages');
      if (rule.pageIds.some((p) => !sourceById.has(norm(p))))
        add('ownership-page', 'destination.ownershipRules', 'Named consuming page is not captured');
    } else if (!sourceById.has(norm(rule.via === 'source-ancestor' ? rule.ancestorItemId : rule.ownerItemId)))
      add('ownership-source', 'destination.ownershipRules', 'Owning source item is not captured');
  }
  unique(
    destination.fieldCompatibility ?? [],
    (r) => [r.sourceTemplateId, r.sourceFieldId, r.targetTemplateId, r.targetFieldId].map(norm).join('|'),
    'destination.fieldCompatibility',
  );
  for (const decision of destination.fieldCompatibility ?? []) {
    const group = mappingBySource.get(norm(decision.sourceTemplateId));
    const template = templateById.get(norm(decision.targetTemplateId)),
      field = template?.fields.find((f) => same(f.id, decision.targetFieldId));
    if (
      !group?.target.some((t) => same(t.templateId, decision.targetTemplateId)) ||
      !group.fields.some(
        (f) =>
          f.action === 'map' && same(f.sfid, decision.sourceFieldId) && same(f.tfid, decision.targetFieldId),
      ) ||
      !field ||
      norm(field.type) !== norm(decision.targetType)
    )
      add(
        'field-compatibility',
        'destination.fieldCompatibility',
        'Decision must select an actual mapped field pair and verified target type',
      );
  }
  for (const rule of destination.referenceRules) {
    const group = mappingBySource.get(norm(rule.sourceTemplateId));
    if (!group?.fields.some((f) => f.action === 'map' && same(f.sfid, rule.sourceFieldId)))
      add('reference-rule', 'destination.referenceRules', 'Reference rule must select a mapped source field');
    if (!destination.rules.some((r) => r.outputKey === rule.targetOutputKey))
      add('reference-rule', 'destination.referenceRules', 'Referenced output key is unknown');
  }
  unique(
    destination.existingReferenceTargets ?? [],
    (r) => norm(r.sourceItemId),
    'destination.existingReferenceTargets',
  );
  for (const binding of destination.existingReferenceTargets ?? []) {
    const actual = target.items.find((i) => same(i.id, binding.targetItemId));
    if (
      !cleanPath(binding.targetPath) ||
      !['/sitecore/content', '/sitecore/media library'].some((root) => inside(root, binding.targetPath)) ||
      !actual ||
      !same(actual.path, binding.targetPath) ||
      !same(actual.templateId, binding.templateId)
    )
      add(
        'reference-target',
        'destination.existingReferenceTargets',
        'Existing reference binding must identify an explicitly inventoried content or media-library item and template',
      );
  }

  function checkIdentity(entry, path) {
    const sourceItem = sourceById.get(norm(entry.sourceItemId));
    const context = allContexts.find(
      (r) =>
        same(r.instanceId, entry.renderingInstanceId) &&
        same(r.pageId, entry.pageId) &&
        same(r.deviceId, entry.deviceId) &&
        r.language === entry.language &&
        r.version === entry.version,
    );
    const sourceTemplateId =
      sourceItem?.templateId ??
      (context && same(context.instanceId, entry.sourceItemId) ? context.parameterTemplateId : undefined);
    const rule = destination.rules.find(
      (r) =>
        same(r.sourceTemplateId, sourceTemplateId) &&
        r.outputKey === entry.outputKey &&
        r.kind !== 'parameters',
    );
    if (!rule)
      add(
        'identity-rule',
        path,
        'Identity must select a captured source item/context and content output rule',
      );
    if (!cleanPath(entry.targetPath) || !inside(destination.targetRootPath, entry.targetPath))
      add('path', path, 'Target identity is outside the approved root');
    if (entry.pageId && !sourceById.has(norm(entry.pageId)))
      add('identity-rule', path, 'Identity page is not captured');
    if (rule?.identity === 'source-item-and-page' && !entry.pageId)
      add('identity-rule', path, 'Local identity requires pageId');
    if (rule?.identity === 'rendering-instance' && (!entry.pageId || !context))
      add(
        'identity-rule',
        path,
        'Rendering identity requires captured page, occurrence, device, language and version context',
      );
    if (
      rule?.identity !== 'rendering-instance' &&
      (entry.renderingInstanceId || entry.deviceId || entry.language || entry.version)
    )
      add('identity-rule', path, 'Only rendering-instance identity can carry occurrence selectors');
    if (rule?.identity === 'source-item' && entry.pageId)
      add('identity-rule', path, 'Shared source identity cannot vary by page');
    return rule;
  }
  if (identityMap) {
    if (
      identityMap.sourceInstanceId !== source.instanceId ||
      identityMap.targetInstanceId !== target.instanceId
    )
      add('identity-instance', 'identityMap', 'Identity map belongs to other instances');
    unique(identityMap.entries, identityKey, 'identityMap.entries');
    unique(identityMap.entries, (e) => norm(e.targetItemId), 'identityMap.targetIds');
    unique(identityMap.entries, (e) => norm(e.targetPath), 'identityMap.targetPaths');
    identityMap.entries.forEach((e, i) => checkIdentity(e, `identityMap.entries[${i}]`));
  }
  if (itemPlan) {
    const structures = itemPlan.structures ?? [];
    unique(structures, (s) => norm(s.targetItemId), 'itemPlan.structures.ids');
    unique(structures, (s) => norm(s.targetPath), 'itemPlan.structures.paths');
    for (const structure of structures) {
      if (templateById.get(norm(structure.templateId))?.kind !== 'folder')
        add('folder-template', 'itemPlan.structures', 'Structure requires an existing folder template');
      if (
        !cleanPath(structure.targetPath) ||
        !inside(destination.targetRootPath, structure.targetPath) ||
        structure.parentPath !== structure.targetPath.slice(0, structure.targetPath.lastIndexOf('/'))
      )
        add('path', 'itemPlan.structures', 'Unsafe structural destination or parent');
      if (
        itemPlan.items.some(
          (i) =>
            same(i.identity.targetItemId, structure.targetItemId) ||
            same(i.identity.targetPath, structure.targetPath),
        )
      )
        add('duplicate', 'itemPlan.structures', 'Folder conflicts with a content output');
    }
    if (binding)
      for (const key of ['mapping', 'sourceSnapshot', 'targetInventory', 'destinationPlan'])
        if (itemPlan.inputs[key] !== binding[key].sha256)
          add('input-binding', 'itemPlan.inputs.' + key, 'Plan input hash differs from staged input');
    unique(itemPlan.items, (r) => identityKey(r.identity), 'itemPlan.items');
    unique(itemPlan.items, (r) => norm(r.identity.targetItemId), 'itemPlan.targetIds');
    unique(itemPlan.items, (r) => norm(r.identity.targetPath), 'itemPlan.targetPaths');
    for (const [i, row] of itemPlan.items.entries()) {
      const p = `itemPlan.items[${i}]`;
      const rule = checkIdentity(row.identity, p + '.identity');
      if (
        row.parentPath !== undefined &&
        row.parentPath !== row.identity.targetPath.slice(0, row.identity.targetPath.lastIndexOf('/'))
      )
        add('path', p + '.parentPath', 'Parent disagrees with item path');
      const template = templateById.get(norm(row.templateId));
      if (!template) add('target-template', p, 'Output template is absent');
      if (rule && !same(rule.targetTemplateId, row.templateId))
        add('identity-rule', p, 'Output template disagrees with destination rule');
      const sourceItem = sourceById.get(norm(row.identity.sourceItemId));
      const occurrence = allContexts.find(
        (r) =>
          same(r.instanceId, row.identity.renderingInstanceId) &&
          same(r.pageId, row.identity.pageId) &&
          same(r.deviceId, row.identity.deviceId) &&
          r.language === row.identity.language &&
          r.version === row.identity.version,
      );
      if (row.versions) {
        const allowedVersions =
          sourceItem?.versions ??
          (occurrence ? [{ language: occurrence.language, version: occurrence.version }] : []);
        unique(row.versions, (v) => `${v.language}|${v.version}`, p + '.versions');
        if (
          row.versions.some(
            (v) => !allowedVersions.some((a) => a.language === v.language && a.version === v.version),
          )
        )
          add('field-scope', p + '.versions', 'Output version was not captured');
      }
      fieldScopes(
        row.fields,
        sourceItem ?? {
          versions: occurrence ? [{ language: occurrence.language, version: occurrence.version }] : [],
        },
        p + '.fields',
      );
      for (const f of row.fields) {
        const actual = template?.fields.find((a) => same(a.id, f.fieldId));
        if (!actual) add('target-field', p, 'Output field is absent');
        else if (actual.storage !== f.storage)
          add('field-scope', p, 'Output field storage disagrees with target evidence');
      }
      for (const relation of row.relationships) {
        if (!template?.fields.some((f) => same(f.id, relation.fieldId)))
          add('target-field', p, 'Relationship field is absent');
        for (const ref of relation.targets) {
          checkIdentity(ref, p + '.relationships');
          if (
            ![...(identityMap?.entries ?? []), ...itemPlan.items.map((r) => r.identity)].some(
              (e) =>
                identityKey(e) === identityKey(ref) &&
                same(e.targetItemId, ref.targetItemId) &&
                same(e.targetPath, ref.targetPath),
            )
          )
            add('relationship', p, 'Relationship target has no matching identity binding');
        }
      }
      const saved = identityMap?.entries.find((e) => identityKey(e) === identityKey(row.identity));
      if (
        saved &&
        (!same(saved.targetItemId, row.identity.targetItemId) ||
          !same(saved.targetPath, row.identity.targetPath))
      )
        add('identity-rule', p, 'Output conflicts with saved identity');
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    summary: {
      sourceItems: source.items.length,
      targetTemplates: target.templates.length,
      destinationRules: destination.rules.length,
    },
  };
}

async function readArtifact(base, descriptor) {
  return (await readArtifactJSON(base, descriptor)).value;
}

export async function validateInputFile(inputPath) {
  try {
    const input = await realpath(resolve(inputPath));
    const binding = (await readJSON(input)).value;
    const inputErrors = validateSchema('migrationInput', binding);
    if (inputErrors.length) return { valid: false, errors: inputErrors };
    const documents = {};
    for (const name of names.filter((n) => !['migrationInput', 'sourceSnapshot'].includes(n)))
      if (binding[name]) documents[name] = await readArtifact(dirname(input), binding[name]);
    const sourcePath = await scopedPath(dirname(input), binding.sourceSnapshot.path);
    const snapshot = await openSnapshot(sourcePath);
    if (snapshot.sha256 !== binding.sourceSnapshot.sha256)
      throw issue('hash', binding.sourceSnapshot.path, 'Snapshot manifest differs from its declared SHA-256');
    const index = await snapshotIndex(snapshot);
    const errors = [];
    const baseDocuments = { ...documents };
    delete baseDocuments.itemPlan;
    delete baseDocuments.identityMap;
    for await (const record of snapshot.records()) {
      const sourceSnapshot = {
        ...snapshot.header,
        items: record.kind === 'item' ? [record.data] : [],
        renderingInstances: record.kind === 'renderingInstance' ? [record.data] : [],
      };
      const result = validateDocuments({ ...baseDocuments, sourceSnapshot }, binding, index);
      errors.push(...result.errors);
      if (errors.length >= 100) break;
    }
    const final = validateDocuments(
      { ...documents, sourceSnapshot: { ...snapshot.header, items: [], renderingInstances: [] } },
      binding,
      index,
    );
    errors.push(...final.errors);
    return {
      valid: errors.length === 0,
      errors,
      summary: { ...final.summary, sourceItems: index.items.size },
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        error?.code && error?.path && error?.message
          ? { code: error.code, path: error.path, message: error.message }
          : issue('input', 'manifest', 'Cannot load input JSON or referenced artifacts'),
      ],
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result =
    args.length === 2 && args[0] === '--input'
      ? await validateInputFile(args[1])
      : {
          valid: false,
          errors: [
            issue('usage', 'arguments', 'Usage: node validate-inputs.mjs --input migration-input.json'),
          ],
        };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
