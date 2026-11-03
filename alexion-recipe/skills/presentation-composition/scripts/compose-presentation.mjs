import {
  loadComposition,
  requireSchema,
  id,
  unique,
  equal,
  canonical,
  jsonBytes,
  plannedUid,
  routeFile,
  publish,
  cli,
  isMain,
} from './lib/common.mjs';

const targetShape = (row) =>
  Object.fromEntries(
    ['uid', 'renderingId', 'placeholder', 'parameters', 'datasourceId', 'parentUid']
      .filter((key) => row[key] !== undefined)
      .map((key) => [key, row[key]]),
  );
const reusableShape = (rows) =>
  rows.map((row) => ({
    ...targetShape(row),
    uid: rows.findIndex((r) => id(r.uid) === id(row.uid)),
    renderingId: id(row.renderingId),
    datasourceId: row.datasourceId ? id(row.datasourceId) : null,
    ...(row.parentUid ? { parentUid: rows.findIndex((r) => id(r.uid) === id(row.parentUid)) } : {}),
  }));
const sameShape = (rows) =>
  rows.map((row) => ({
    ...targetShape(row),
    uid: id(row.uid),
    renderingId: id(row.renderingId),
    datasourceId: row.datasourceId ? id(row.datasourceId) : null,
    ...(row.parentUid ? { parentUid: id(row.parentUid) } : {}),
  }));
export async function buildComposition(inputPath) {
  const model = await loadComposition(inputPath),
    { input, documents: d } = model;
  const { source, target, mapping, rules, identities, targetData: data } = d;
  const issues = [],
    issue = (code, message, pageId = null) => issues.push({ code, pageId, message });
  for (const [rows, key, label] of [
    [source.pages, (r) => id(r.id), 'source page'],
    [source.templates, (r) => id(r.id), 'source template'],
    [target.templates, (r) => id(r.id), 'target template'],
    [target.renderings, (r) => id(r.id), 'target rendering'],
    [target.placeholders, (r) => r.key, 'target placeholder'],
    [rules.pages, (r) => id(r.sourcePageId), 'page rule'],
    [rules.partialDesigns, (r) => r.key, 'partial key'],
    [rules.pageDesigns, (r) => r.key, 'page design key'],
    [rules.occurrences, (r) => id(r.sourcePageId) + '|' + id(r.sourceUid), 'occurrence rule'],
    [data.items, (r) => id(r.id), 'target item'],
    [data.items, (r) => r.path.toLowerCase(), 'target item path'],
    [source.parameterTemplates, (r) => id(r.id), 'source parameter template'],
    [target.partialDesigns, (r) => id(r.id), 'existing partial design'],
    [target.pageDesigns, (r) => id(r.id), 'existing page design'],
    [rules.partialDesigns, (r) => r.name.toLowerCase(), 'partial design name'],
    [rules.pageDesigns, (r) => r.name.toLowerCase(), 'page design name'],
    [
      identities.bindings,
      (r) =>
        [
          id(r.sourceItemId),
          r.sourcePageId ? id(r.sourcePageId) : '',
          r.sourceUid ? id(r.sourceUid) : '',
          r.outputKey,
        ].join('|'),
      'identity binding',
    ],
  ])
    unique(rows, key, label);
  const renders = new Map(target.renderings.map((r) => [id(r.id), r])),
    items = new Map(data.items.map((r) => [id(r.id), r]));
  const partials = new Map(
    rules.partialDesigns.map((r) => [r.key, { ...r, renderings: null, consumers: [] }]),
  );
  const designs = new Map(rules.pageDesigns.map((r) => [r.key, { ...r }]));
  let plannedBytes = 0;
  const reserve = (value) => {
    plannedBytes += Buffer.byteLength(jsonBytes(value));
    if (plannedBytes > 14 * 1024 * 1024)
      throw Error('Composition byte budget exceeded; reduce the explicit scope');
  };
  unique(
    rules.partialDesigns.filter((row) => row.reuseId),
    (row) => id(row.reuseId),
    'reused partial design',
  );
  const exclusions = [];
  const pages = [],
    usedRules = new Set(),
    assignments = new Map(),
    bindingsUsed = [];
  for (const rule of rules.occurrences)
    if (
      !source.pages.some(
        (p) =>
          id(p.id) === id(rule.sourcePageId) && p.effective.some((r) => id(r.uid) === id(rule.sourceUid)),
      )
    )
      issue('unknown-occurrence', 'Occurrence rule is outside the captured effective scope');
  function bind(sourceItemId, pageId, sourceUid, outputKey, expectedTargetId = null) {
    const candidates = identities.bindings.filter(
      (b) =>
        id(b.sourceItemId) === id(sourceItemId) &&
        (!b.sourcePageId || id(b.sourcePageId) === id(pageId)) &&
        (!b.sourceUid || id(b.sourceUid) === id(sourceUid)) &&
        (!outputKey || b.outputKey === outputKey) &&
        (!expectedTargetId || id(b.targetItemId) === id(expectedTargetId)),
    );
    if (candidates.length !== 1)
      throw Error('Missing or ambiguous verified target binding for ' + sourceItemId);
    const binding = candidates[0],
      actual = items.get(id(binding.targetItemId));
    if (!actual) throw Error('Target binding lacks current captured item fields: ' + binding.targetItemId);
    bindingsUsed.push(binding);
    return actual;
  }
  function parameters(occ, render, rule, datasource) {
    const result = Object.create(null),
      fields = render.parameterFields;
    unique(Object.keys(occ.parameters), id, 'source parameter field value');
    unique(fields, (f) => id(f.id), 'target parameter field');
    unique(fields, (f) => f.name, 'target parameter name');
    if (Object.keys(occ.parameters).length || occ.parameterTemplateId) {
      const groups = mapping.templates.filter((g) =>
        g.source.some((s) => id(s.templateId) === id(occ.parameterTemplateId)),
      );
      if (groups.length !== 1) throw Error('Missing or ambiguous parameter-template mapping');
      const src = source.parameterTemplates.find((t) => id(t.id) === id(occ.parameterTemplateId));
      if (!src) throw Error('Missing captured source parameter-template fields');
      const removed = new Set(
        groups[0].fields.filter((row) => row.action === 'remove').map((row) => id(row.sfid)),
      );
      if (groups[0].fields.some((row) => row.action === 'map' && removed.has(id(row.sfid))))
        throw Error('Source parameter cannot be both mapped and removed');
      const consumed = new Set();
      for (const row of groups[0].fields) {
        if (row.action === 'remove') {
          consumed.add(id(row.sfid));
          continue;
        }
        const field = fields.find(
          (f) => id(f.id) === id(row.tfid) && id(f.declaringTemplateId) === id(row.targetTemplateId),
        );
        if (!field) {
          const capturedKey =
            row.action === 'map' ? Object.keys(occ.parameters).find((key) => id(key) === id(row.sfid)) : null;
          const expected =
            row.action === 'set'
              ? row.value
              : capturedKey === undefined
                ? undefined
                : occ.parameters[capturedKey];
          const name =
            datasource &&
            Object.entries(datasource.fieldIds ?? {}).find(([key]) => id(key) === id(row.tfid))?.[1];
          const actual = name && datasource.fields[name];
          if (
            expected === undefined ||
            !datasource ||
            ![datasource.templateId, ...(datasource.baseTemplateIds ?? [])].some(
              (v) => id(v) === id(row.targetTemplateId),
            ) ||
            name !== row.to ||
            !equal(actual?.value ?? actual, expected)
          )
            throw Error(
              'Parameter-to-datasource mapping needs independently migrated matching target field evidence',
            );
          if (row.action === 'map') consumed.add(id(row.sfid));
          continue;
        }
        if (!render.parameterTemplateIds.some((v) => id(v) === id(row.targetTemplateId)))
          throw Error('Parameter destination is not declared by target rendering');
        if (Object.hasOwn(result, field.name)) throw Error('Conflicting writes to target parameter');
        if (row.action === 'set') result[field.name] = row.value;
        else {
          const capturedKey = Object.keys(occ.parameters).find((key) => id(key) === id(row.sfid)),
            from = src.fields.find((f) => id(f.id) === id(row.sfid));
          if (!from || from.type.toLowerCase() !== field.type.toLowerCase())
            throw Error('Parameter type conversion is unsupported');
          if (capturedKey === undefined)
            throw Error('Missing captured parameter value, including an explicit empty value');
          if (Object.hasOwn(result, field.name)) throw Error('Conflicting writes to target parameter');
          result[field.name] = occ.parameters[capturedKey];
          consumed.add(id(row.sfid));
        }
      }
      if (Object.keys(occ.parameters).some((key) => !consumed.has(id(key))))
        throw Error('Unmapped source rendering parameter');
    }
    for (const [name, value] of Object.entries(rule?.parameters ?? {})) {
      if (!fields.some((f) => f.name === name)) throw Error('Unknown explicitly assigned target parameter');
      result[name] = value;
    }
    return { ...result };
  }
  function validatePlacements(rows) {
    unique(rows, (r) => id(r.uid), 'rendering UID');
    for (const row of rows) {
      const render = renders.get(id(row.renderingId)),
        placeholder = target.placeholders.find((p) => p.key === row.placeholder);
      if (!render || !placeholder || !placeholder.allowedRenderingIds.some((v) => id(v) === id(render.id)))
        throw Error('Missing or incompatible target rendering/placeholder');
      if (render.variantParameter && !render.variants.includes(row.parameters[render.variantParameter]))
        throw Error('Unknown target rendering variant');
      if (Object.keys(row.parameters).some((name) => !render.parameterFields.some((f) => f.name === name)))
        throw Error('Unknown target rendering parameter');
      for (const [name, value] of Object.entries(row.parameters)) {
        const field = render.parameterFields.find((f) => f.name === name);
        if (
          (field.allowedValues && !field.allowedValues.includes(value)) ||
          ([
            'droplink',
            'multilist',
            'treelist',
            'treelistex',
            'checklist',
            'image',
            'file',
            'general link',
            'lookup',
          ].includes(field.type.toLowerCase()) &&
            !field.allowedValues?.includes(value))
        )
          throw Error(
            'Reference/choice parameter needs an explicitly allowed target value; no source GUID rewriting is inferred',
          );
      }

      if (row.datasourceId) {
        const ds = items.get(id(row.datasourceId));
        if (!ds || !render.datasourceTemplateIds.some((t) => id(t) === id(ds.templateId)))
          throw Error('Incompatible or uncaptured target datasource');
      }
      if (render.dataSource === 'datasource' && !row.datasourceId)
        throw Error('Target rendering requires a datasource');
      if (row.parentUid) {
        const parent = rows.find((r) => id(r.uid) === id(row.parentUid));
        if (!parent || !placeholder.ownerRenderingIds.some((v) => id(v) === id(parent.renderingId)))
          throw Error('Nested placeholder lacks a compatible parent in the same design');
        const seen = new Set([id(row.uid)]);
        let node = row;
        while (node.parentUid) {
          const key = id(node.parentUid);
          if (seen.has(key)) throw Error('Rendering parent cycle');
          seen.add(key);
          node = rows.find((r) => id(r.uid) === key);
          if (!node) throw Error('Missing rendering parent');
        }
      } else if (placeholder.ownerRenderingIds.length)
        throw Error('Nested target placeholder needs an explicit parent UID');
    }
  }
  for (const page of source.pages) {
    try {
      const rule = rules.pages.find((r) => id(r.sourcePageId) === id(page.id));
      if (!rule) throw Error('Missing approved page composition rule');
      usedRules.add(id(rule.sourcePageId));
      routeFile(rule.route);
      const targetPage = bind(page.id, page.id, null, null, rule.targetPageId);
      if (
        id(targetPage.id) !== id(rule.targetPageId) ||
        id(targetPage.templateId) !== id(rule.targetTemplateId)
      )
        throw Error('Page binding differs from approved target item/template');
      const template = target.templates.find((t) => id(t.id) === id(rule.targetTemplateId)),
        sourceTemplate = source.templates.find((t) => id(t.id) === id(page.templateId)),
        design = designs.get(rule.pageDesignKey);
      if (
        !template ||
        !sourceTemplate ||
        !design ||
        !target.layouts.some((v) => id(v) === id(design.layoutId))
      )
        throw Error('Missing source defaults or target template/design/layout evidence');
      const templateMap = mapping.templates.filter(
        (g) =>
          g.source.some((t) => id(t.templateId) === id(page.templateId)) &&
          g.target.some((t) => id(t.templateId) === id(rule.targetTemplateId)),
      );
      if (templateMap.length !== 1)
        throw Error('Page template choice is not an unambiguous approved mapping');
      unique(page.effective, (r) => id(r.uid), 'effective source UID');
      if (
        page.overrideUids.some(
          (uid) => ![...page.effective, ...sourceTemplate.defaults].some((o) => id(o.uid) === id(uid)),
        )
      )
        throw Error('Override provenance names an unknown source occurrence');
      for (const occ of page.effective) {
        if (
          occ.origin === 'template-default' &&
          !sourceTemplate.defaults.some((o) => id(o.uid) === id(occ.uid) && id(o.ownerId) === id(occ.ownerId))
        )
          throw Error('Template-default provenance is absent');
        if (
          occ.origin === 'page-override' &&
          (!page.overrideUids.some((uid) => id(uid) === id(occ.uid)) || id(occ.ownerId) !== id(page.id))
        )
          throw Error('Page override provenance is absent');
      }
      for (const occ of page.effective)
        if (
          occ.origin === 'partial-design' &&
          !source.partialDesigns.some(
            (design) =>
              id(design.id) === id(occ.ownerId) &&
              design.renderings.some((row) => id(row.uid) === id(occ.uid)),
          )
        )
          throw Error('Source Partial Design occurrence lacks inspected dependency evidence');
      if (rule.excludeDefaultUids.some((uid) => !template.defaults.some((o) => id(o.uid) === id(uid))))
        throw Error('Excluded target default UID is not present');
      reserve({
        defaults: template.defaults,
        defaultUids: sourceTemplate.defaults.map((row) => row.uid),
        overrideUids: page.overrideUids,
      });
      const local =
        rule.defaultPolicy === 'preserve'
          ? structuredClone(
              template.defaults.filter((o) => !rule.excludeDefaultUids.some((uid) => id(uid) === id(o.uid))),
            )
          : [];
      const grouped = new Map();
      for (const occ of page.effective) {
        const override = rules.occurrences.find(
          (r) => id(r.sourcePageId) === id(page.id) && id(r.sourceUid) === id(occ.uid),
        );
        if (override?.excludeReason) {
          exclusions.push({ sourcePageId: page.id, sourceUid: occ.uid, reason: override.excludeReason });
          continue;
        }
        const maps = mapping.renderings.filter((g) =>
          g.source.some((r) => id(r.renderingId) === id(occ.renderingId)),
        );
        if (maps.length !== 1) throw Error('Missing or ambiguous source rendering mapping');
        const targetRef = override?.targetRenderingId
          ? maps[0].target.find((r) => id(r.renderingId) === id(override.targetRenderingId))
          : maps[0].target.length === 1
            ? maps[0].target[0]
            : null;
        const render = targetRef && renders.get(id(targetRef.renderingId));
        if (!render || render.name !== targetRef.renderingName)
          throw Error('Ambiguous rendering output or target component identity differs');
        const placeholders = mapping.placeholders.filter((p) => p.source.key === occ.placeholder);
        if (!override?.placeholder && placeholders.length !== 1)
          throw Error(
            'Missing/ambiguous exact placeholder mapping; dynamic keys need an explicit occurrence rule',
          );
        const partialKey = override?.partialKey,
          bucket = partialKey ? (grouped.get(partialKey) ?? []) : local;
        if (partialKey && (!partials.has(partialKey) || !design.partialKeys.includes(partialKey)))
          throw Error('Partial Design is not part of the approved Page Design');
        const datasourceSourceId = override?.datasourceSourceId ?? occ.datasourceId;
        const datasource = datasourceSourceId
          ? bind(datasourceSourceId, page.id, occ.uid, override?.outputKey)
          : null;
        const row = {
          uid: partialKey ? plannedUid(partialKey + '|' + bucket.length + '|' + id(render.id)) : occ.uid,
          renderingId: render.id,
          placeholder: override?.placeholder ?? placeholders[0].target.key,
          parameters: parameters(occ, render, override, datasource),
          datasourceId: datasource?.id ?? null,
          sourceUid: occ.uid,
          sourceRenderingId: occ.renderingId,
          origin: occ.origin,
        };
        if (occ.parentUid) row.parentSourceUid = occ.parentUid;
        reserve(row);
        bucket.push(row);
        if (partialKey) grouped.set(partialKey, bucket);
      }
      for (const rows of [local, ...grouped.values()]) {
        for (const row of rows)
          if (row.parentSourceUid) {
            const parent = rows.find((r) => id(r.sourceUid) === id(row.parentSourceUid));
            if (!parent) throw Error('Parent and child are split across presentation owners');
            row.parentUid = parent.uid;
            delete row.parentSourceUid;
          }
        validatePlacements(rows);
      }
      for (const [key, rows] of grouped) {
        const partial = partials.get(key);
        if (partial.renderings && !equal(sameShape(partial.renderings), sameShape(rows)))
          throw Error(
            'Shared Partial Design differs between pages; approve separate designs or consistent datasource rules',
          );
        partial.renderings = rows;
        partial.consumers.push(targetPage.id);
      }
      if (rule.templateAssociation) {
        const prior = assignments.get(id(rule.targetTemplateId));
        if (prior && prior !== rule.pageDesignKey)
          throw Error('Conflicting template-to-Page Design associations');
        assignments.set(id(rule.targetTemplateId), rule.pageDesignKey);
      }
      pages.push({
        sourcePageId: page.id,
        targetPageId: targetPage.id,
        targetTemplateId: targetPage.templateId,
        route: rule.route,
        pageDesignKey: rule.pageDesignKey,
        templateAssociation: rule.templateAssociation,
        defaultPolicy: rule.defaultPolicy,
        removedDefaultUids: template.defaults
          .filter(
            (o) =>
              rule.defaultPolicy === 'replace' ||
              rule.excludeDefaultUids.some((uid) => id(uid) === id(o.uid)),
          )
          .map((o) => o.uid),
        sourceEvidence: {
          templateDefaultUids: sourceTemplate.defaults.map((o) => o.uid),
          overrideUids: page.overrideUids,
        },
        renderings: local,
      });
    } catch (error) {
      if (error.message.includes('byte budget')) throw error;
      issue('composition-conflict', error.message, page.id);
    }
  }
  if (rules.pages.some((r) => !usedRules.has(id(r.sourcePageId))))
    issue('unused-page-rule', 'Page rules do not exactly match the captured scope');
  unique(pages, (p) => routeFile(p.route).toLowerCase(), 'preview route/output');
  for (const partial of partials.values()) {
    const existing = partial.reuseId && target.partialDesigns.find((p) => id(p.id) === id(partial.reuseId));
    if (partial.reuseId && !existing)
      issue('missing-design', 'Reused Partial Design is not inventoried: ' + partial.key);
    if (partial.renderings === null) {
      reserve(existing?.renderings ?? []);
      partial.renderings = structuredClone(existing?.renderings ?? []);
    }
    try {
      validatePlacements(partial.renderings);
    } catch (error) {
      issue('partial-design', partial.key + ': ' + error.message);
    }
    if (existing && !equal(reusableShape(partial.renderings), reusableShape(existing.renderings)))
      issue('design-drift', 'Reused Partial Design differs: ' + partial.key);
    else if (existing) partial.renderings = structuredClone(existing.renderings);
  }
  for (const design of designs.values()) {
    if (!target.layouts.some((value) => id(value) === id(design.layoutId)))
      issue('design-layout', 'Unknown target layout: ' + design.key);
    if (
      new Set(design.partialKeys).size !== design.partialKeys.length ||
      design.partialKeys.some((key) => !partials.has(key))
    )
      issue('design-reference', 'Missing/repeated Partial Design key: ' + design.key);
    if (design.reuseId) {
      const existing = target.pageDesigns.find((p) => id(p.id) === id(design.reuseId));
      const partialIds = design.partialKeys.map((key) => partials.get(key)?.reuseId);
      if (
        !existing ||
        id(existing.layoutId) !== id(design.layoutId) ||
        partialIds.some((v) => !v) ||
        !equal(existing.partialIds.map(id), partialIds.map(id))
      )
        issue(
          'design-drift',
          'Reused Page Design differs or references proposed new partials: ' + design.key,
        );
    }
  }
  for (const requirement of rules.requiredCoverage)
    if (!renders.has(id(requirement.renderingId)))
      issue('coverage-definition', 'Required rendering is not in target definitions');
  const plan = {
    version: 1,
    kind: 'virtual-presentation-composition',
    scopeId: input.scopeId,
    compositionInputSha256: model.inputSha256,
    inputs: input,
    source: { instanceId: source.instanceId, stateId: source.stateId, deviceId: source.deviceId },
    target: {
      instanceId: target.instanceId,
      database: target.database,
      stateId: target.stateId,
      siteName: target.siteName,
      language: target.language,
      itemVersion: target.itemVersion,
      deviceId: target.deviceId,
    },
    pages,
    partialDesigns: [...partials.values()],
    pageDesigns: [...designs.values()],
    templateAssignments: [...assignments].map(([templateId, pageDesignKey]) => ({
      templateId,
      pageDesignKey,
    })),
    requiredCoverage: rules.requiredCoverage,
    bindingsUsed,
    exclusions,
    issues,
    ready: issues.length === 0,
    targetWrites: false,
    userApprovalRequired: true,
  };
  requireSchema('compositionPlan', plan);
  return { plan, model };
}
export async function composePresentation(inputPath, outputPath) {
  const { plan, model } = await buildComposition(inputPath);
  const report = {
    version: 1,
    scopeId: plan.scopeId,
    ready: plan.ready,
    issues: plan.issues,
    pages: plan.pages.length,
    targetWrites: false,
    userApprovalRequired: true,
  };
  await publish(outputPath, { 'composition-plan.json': plan, 'composition-report.json': report }, model.refs);
  return report;
}
if (isMain(import.meta.url)) await cli(composePresentation);
