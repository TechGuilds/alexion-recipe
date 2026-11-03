import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyPreview } from '../review-presentation-preview.mjs';
import { buildComposition } from '../compose-presentation.mjs';
import {
  requireSchema,
  readJSON,
  readArtifactJSON,
  id,
  equal,
  canonical,
  hash,
  jsonBytes,
  plannedUid,
  recheck,
  unique,
} from './common.mjs';
import { scopedPath } from '../../../cms-migration/scripts/lib/files.mjs';

export const contextKey = (itemId, language, version) => id(itemId) + '|' + language + '|' + version;
export const insideSite = (root, path) =>
  path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(root.toLowerCase() + '/');
export const normalizedRows = (rows) =>
  rows.map((row) => ({
    uid: id(row.uid),
    renderingId: id(row.renderingId),
    placeholder: row.placeholder,
    parameters: row.parameters,
    datasourceId: row.datasourceId ? id(row.datasourceId) : null,
  }));
export function slot(item, name) {
  const rows = item?.fields?.filter((field) => field.name === name) ?? [];
  if (rows.length !== 1) throw Error('Missing or ambiguous target field: ' + name);
  return rows[0];
}
export async function applicationSources() {
  const common = await readFile(new URL('./presentation-target-common.ps1', import.meta.url), 'utf8');
  return {
    collector:
      common + '\n' + (await readFile(new URL('../capture-presentation-state.ps1', import.meta.url), 'utf8')),
    writer: common + '\n' + (await readFile(new URL('../execute-presentation.ps1', import.meta.url), 'utf8')),
  };
}
export async function loadApplication(inputPath) {
  const staged = await readJSON(inputPath),
    input = requireSchema('applicationInput', staged.value),
    base = dirname(inputPath);
  const profileArtifact = await readArtifactJSON(base, input.profile),
    capabilitiesArtifact = await readArtifactJSON(base, input.capabilities);
  const profile = requireSchema('applicationProfile', profileArtifact.value),
    cap = requireSchema('applicationCapabilities', capabilitiesArtifact.value);
  const refs = [
    { path: inputPath, sha256: staged.sha256 },
    { path: profileArtifact.path, sha256: profileArtifact.sha256 },
    { path: capabilitiesArtifact.path, sha256: capabilitiesArtifact.sha256 },
  ];
  if (
    profile.scopeId !== input.scopeId ||
    cap.scopeId !== input.scopeId ||
    !['instanceId', 'database', 'connectorId'].every((key) => profile.target[key] === cap[key]) ||
    cap.database.toLowerCase() === 'web'
  )
    throw Error('Application capability/target scope differs or is not authoring');
  if (
    !Number.isFinite(Date.parse(cap.verifiedAt)) ||
    Date.parse(cap.verifiedAt) > Date.now() ||
    !Number.isFinite(Date.parse(cap.expiresAt)) ||
    Date.parse(cap.expiresAt) <= Date.now()
  )
    throw Error('Application capability window is invalid or expired');
  const root = profile.target.rootPath;
  if (
    !/^\/sitecore\/content\/[^\\:*?\[\]\x00-\x1f]+$/.test(root) ||
    /(^|\/)\.\.?($|\/)|\/\/|\/$/.test(root) ||
    profile.target.marker.path !== root
  )
    throw Error('An exact target site marker/root is required');
  for (const folder of [profile.partialFolder, profile.pageFolder])
    if (
      !insideSite(root, folder.path) ||
      folder.path === root ||
      /(^|\/)\.\.?($|\/)|\/\/|\/$/.test(folder.path)
    )
      throw Error('Design folders must be explicitly inside the target site');
  if (
    profile.partialFolder.path !== root + '/Presentation/Partial Designs' ||
    profile.pageFolder.path !== root + '/Presentation/Page Designs'
  )
    throw Error('This adapter requires the standard SXA design folder locations');
  const cohorts = [];
  unique(input.reviewInputs, (ref) => ref.path, 'preview review input');
  for (const ref of input.reviewInputs) {
    const artifact = await readArtifactJSON(base, ref),
      review = await verifyPreview(artifact.path);
    if (!review.report.ready || review.report.scopeId !== input.scopeId)
      throw Error('Every application context requires a current successful human preview review');
    const preview = await readArtifactJSON(dirname(artifact.path), artifact.value.previewInput);
    const composition = await readArtifactJSON(dirname(preview.path), preview.value.compositionInput);
    const rebuilt = await buildComposition(composition.path),
      target = rebuilt.plan.target;
    if (target.instanceId !== profile.target.instanceId || target.database !== profile.target.database)
      throw Error('Preview review belongs to another target');
    if (
      cohorts.length &&
      (target.siteName !== cohorts[0].plan.target.siteName ||
        id(target.deviceId) !== id(cohorts[0].plan.target.deviceId))
    )
      throw Error('Application reviews must select one explicit target site/device');
    if (
      rebuilt.plan.source.instanceId === target.instanceId &&
      profile.sourceRoots.some((source) => insideSite(source, root) || insideSite(root, source))
    )
      throw Error('Source/target write roots overlap on the same instance');
    refs.push(...review.refs, ...rebuilt.model.refs, { path: artifact.path, sha256: artifact.sha256 });
    cohorts.push(rebuilt);
  }
  for (const [artifact, document] of [
    [profileArtifact, profile],
    [capabilitiesArtifact, cap],
  ])
    for (const ref of document.evidence) {
      const path = await scopedPath(dirname(artifact.path), ref.path),
        bytes = await readFile(path);
      if (bytes.length > 16 * 1024 * 1024 || hash(bytes) !== ref.sha256)
        throw Error('Application capability/profile evidence is stale');
      refs.push({ path, sha256: ref.sha256 });
    }
  return { inputPath, input, inputSha256: staged.sha256, profile, cap, cohorts, refs };
}
export function applicationIntent(model) {
  const { profile, cohorts } = model,
    targets = new Map(),
    queries = new Map(),
    materials = new Map(),
    consumers = new Set(),
    approvedContexts = new Map();
  const addQuery = (itemId, path, language, version, materialFields = []) => {
    const key = contextKey(itemId, language, version),
      prior = queries.get(key);
    if (prior && prior.path && path && prior.path !== path) throw Error('Contradictory target paths');
    queries.set(key, {
      key,
      id: itemId,
      path: prior?.path ?? path ?? null,
      language,
      version,
      materialFieldIds: [...new Set([...(prior?.materialFieldIds ?? []), ...materialFields].map(id))].sort(),
    });
  };
  const put = (key, value) => {
    const prior = targets.get(key);
    if (
      prior &&
      (!equal(prior.layouts, value.layouts) ||
        !equal(prior.partialIds, value.partialIds) ||
        prior.signature !== value.signature ||
        prior.templateId !== value.templateId ||
        prior.path !== value.path)
    )
      throw Error('Shared design differs across approved contexts: ' + key);
    if (prior) prior.languages = [...new Set([...prior.languages, ...value.languages])].sort();
    else targets.set(key, value);
    return targets.get(key);
  };
  function rows(owner, renderings) {
    return renderings.map((row) => {
      const paths = profile.placeholderPaths.filter((p) => p.owner === owner && id(p.uid) === id(row.uid));
      if (paths.length > 1 || (row.parentUid && paths.length !== 1))
        throw Error(
          'Nested rendering needs one approved physical placeholder path: ' + owner + '/' + row.uid,
        );
      const placeholder = paths[0]?.path ?? row.placeholder;
      if (
        /[\x00-\x1f\\]/.test(placeholder) ||
        placeholder.includes('..') ||
        (row.parentUid && !placeholder.endsWith('/' + row.placeholder))
      )
        throw Error('Unsupported physical placeholder path');
      return {
        uid: row.uid,
        renderingId: row.renderingId,
        placeholder,
        parameters: row.parameters,
        datasourceId: row.datasourceId,
      };
    });
  }
  for (const { plan, model: source } of cohorts) {
    const ctx = plan.target,
      defs = source.documents.target;
    for (const page of plan.pages) {
      const key = contextKey(page.targetPageId, ctx.language, ctx.itemVersion);
      if (approvedContexts.has(key)) throw Error('Repeated approved page context');
      approvedContexts.set(key, { page, ctx });
      if (
        !insideSite(
          profile.target.rootPath,
          source.documents.targetData.items.find((item) => id(item.id) === id(page.targetPageId)).path,
        )
      )
        throw Error('Page lies outside the approved target site');
    }
    for (const partial of plan.partialDesigns) {
      const itemId =
          partial.reuseId ??
          plannedUid(model.input.scopeId + '|' + id(profile.target.marker.id) + '|partial|' + partial.key),
        path = partial.reuseId ? null : profile.partialFolder.path + '/' + partial.name;
      if (/[\\/:*?\[\]\x00-\x1f]/.test(partial.name) || ['.', '..'].includes(partial.name))
        throw Error('Design name is not an approved direct child name');
      put('partial:' + partial.key, {
        key: 'partial:' + partial.key,
        kind: 'partial',
        itemId,
        path,
        templateId: profile.partialTemplateId,
        reuseOnly: !!partial.reuseId,
        languages: [ctx.language],
        signature: 'sxa-' + id(itemId).replaceAll('-', ''),
        layouts: [
          {
            deviceId: ctx.deviceId,
            final: false,
            layoutId: profile.partialLayoutId,
            renderings: rows('partial:' + partial.key, partial.renderings),
          },
        ],
      });
      addQuery(itemId, path, ctx.language, 1);
    }
    for (const design of plan.pageDesigns) {
      const itemId =
          design.reuseId ??
          plannedUid(model.input.scopeId + '|' + id(profile.target.marker.id) + '|design|' + design.key),
        path = design.reuseId ? null : profile.pageFolder.path + '/' + design.name;
      if (/[\\/:*?\[\]\x00-\x1f]/.test(design.name) || ['.', '..'].includes(design.name))
        throw Error('Design name is not an approved direct child name');
      put('design:' + design.key, {
        key: 'design:' + design.key,
        kind: 'design',
        itemId,
        path,
        templateId: profile.pageTemplateId,
        reuseOnly: !!design.reuseId,
        languages: [ctx.language],
        partialIds: design.partialKeys.map((key) => targets.get('partial:' + key).itemId),
        layoutId: design.layoutId,
        layouts: [],
      });
      addQuery(itemId, path, ctx.language, 1);
    }
    for (const page of plan.pages) {
      const item = source.documents.targetData.items.find((item) => id(item.id) === id(page.targetPageId)),
        key = 'page:' + id(page.targetPageId),
        design = targets.get('design:' + page.pageDesignKey);
      const action = {
        language: ctx.language,
        version: ctx.itemVersion,
        deviceId: ctx.deviceId,
        final: true,
        layoutId: plan.pageDesigns.find((d) => d.key === page.pageDesignKey).layoutId,
        renderings: rows(key, page.renderings),
        pageDesignId: design.itemId,
        templateAssociation: page.templateAssociation,
      };
      if (targets.has(key)) targets.get(key).layouts.push(action);
      else
        targets.set(key, {
          key,
          kind: 'page',
          itemId: page.targetPageId,
          path: item.path,
          templateId: item.templateId,
          reuseOnly: false,
          languages: [],
          layouts: [action],
        });
      addQuery(item.id, item.path, ctx.language, ctx.itemVersion);
      if (page.templateAssociation) consumers.add(id(page.targetTemplateId));
    }
    for (const item of source.documents.targetData.items) {
      if (
        !item.rawFields ||
        Object.keys(item.fields).some((name) => !item.rawFields.some((field) => field.name === name))
      )
        throw Error(
          'Application needs original raw field observations for every target preview field: ' + item.id,
        );
      unique(item.rawFields, (row) => id(row.fieldId), 'raw preview field');
      const key = contextKey(item.id, ctx.language, ctx.itemVersion),
        prior = materials.get(key);
      if (prior && !equal(prior.fields, item.rawFields))
        throw Error('Target material evidence disagrees between reviews');
      materials.set(key, { key, fields: item.rawFields });
      addQuery(
        item.id,
        item.path,
        ctx.language,
        ctx.itemVersion,
        item.rawFields.map((field) => field.fieldId),
      );
    }
    for (const render of defs.renderings) addQuery(render.id, null, ctx.language, 1);
    for (const layoutId of [...defs.layouts, profile.partialLayoutId])
      addQuery(layoutId, null, ctx.language, 1);
    for (const marker of [profile.target.marker, profile.partialFolder, profile.pageFolder])
      addQuery(marker.id, marker.path, ctx.language, 1);
  }
  unique([...targets.values()], (target) => id(target.itemId), 'target application identity');
  unique(
    [...targets.values()].filter((target) => target.path),
    (target) => target.path.toLowerCase(),
    'target application destination',
  );
  return {
    targets,
    queries: [...queries.values()],
    materials,
    approvedContexts,
    consumerTemplateIds: [...consumers],
    languages: [...new Set(cohorts.map((row) => row.plan.target.language))].sort(),
  };
}
export async function applicationReadRequest(model, intent) {
  const sources = await applicationSources();
  if (intent.queries.length > model.cap.maxReadItems)
    throw Error('Application read scope exceeds the approved item bound');
  const body = {
    version: 1,
    kind: 'presentation-read-request',
    scopeId: model.input.scopeId,
    target: model.profile.target,
    queries: intent.queries,
    templateIds: [model.profile.partialTemplateId, model.profile.pageTemplateId],
    consumerTemplateIds: intent.consumerTemplateIds,
    languages: intent.languages,
    deviceId: model.cohorts[0].plan.target.deviceId,
    capabilities: model.cap,
    collectorSha256: hash(sources.collector),
  };
  return { body, sha256: hash(jsonBytes(body)), script: sources.collector };
}
export async function readApplicationState(base, descriptor, request) {
  const artifact = await readArtifactJSON(base, descriptor),
    state = requireSchema('presentationState', artifact.value);
  if (
    state.version !== 1 ||
    state.kind !== 'presentation-target-state' ||
    state.scopeId !== request.body.scopeId ||
    state.requestSha256 !== request.sha256 ||
    state.collectorSha256 !== request.body.collectorSha256 ||
    !equal(state.target, request.body.target) ||
    state.complete !== true ||
    !Array.isArray(state.errors) ||
    state.errors.length ||
    !Array.isArray(state.queries) ||
    !Array.isArray(state.templates) ||
    !Array.isArray(state.consumers) ||
    !Number.isFinite(Date.parse(state.capturedAt)) ||
    Date.parse(state.capturedAt) > Date.now() ||
    Date.parse(state.capturedAt) < Date.parse(request.body.capabilities.verifiedAt) ||
    Date.parse(request.body.capabilities.expiresAt) <= Date.now()
  )
    throw Error('Incomplete, stale or mismatched target presentation read-back');
  if (Buffer.byteLength(jsonBytes(state)) > request.body.capabilities.maxCaptureBytes)
    throw Error('Target capture exceeds approved byte bound');
  unique(state.queries, (row) => row.key, 'target state query');
  for (const row of state.queries)
    for (const item of [row.byId, row.byPath])
      if (item) {
        if (!Array.isArray(item.contexts) || item.contexts.length > request.body.capabilities.maxContexts)
          throw Error('Target observation context bound exceeded');
        unique(
          item.contexts,
          (ctx) => contextKey(ctx.itemId, ctx.language, ctx.version),
          'observed item context',
        );
        unique(item.fields ?? [], (field) => id(field.id), 'observed item field');
      }
  for (const consumer of state.consumers)
    if (!Array.isArray(consumer.contexts) || consumer.contexts.length > request.body.capabilities.maxContexts)
      throw Error('Target consumer context bound exceeded');
  unique(state.templates, (row) => id(row.id) + '|' + row.language, 'target template metadata');
  unique(state.consumers, (row) => id(row.templateId), 'target consumer scan');
  if (
    state.queries.length !== request.body.queries.length ||
    request.body.queries.some(
      (query) => !state.queries.some((row) => row.key === query.key && equal(row.query, query)),
    )
  )
    throw Error('Target read-back query scope differs');
  return artifact;
}
export function stateIndex(state) {
  return new Map(state.queries.map((row) => [row.key, row]));
}
export function observed(index, query) {
  const row = index.get(query.key);
  if (!row) throw Error('Target observation is absent: ' + query.key);
  if (row.byId && id(row.byId.id) !== id(query.id)) throw Error('Target ID observation differs');
  if (query.path && (!!row.byId !== !!row.byPath || (row.byPath && !equal(row.byId, row.byPath))))
    throw Error('Target ID/path collision');
  return row.byId;
}
export function coveredImpact(contexts, model, intent, expectedDesignId, storage, language) {
  for (const ctx of contexts) {
    if (storage === 'unversioned' && ctx.language !== language) continue;
    const reviewed = intent.approvedContexts.get(contextKey(ctx.itemId, ctx.language, ctx.version));
    if (
      !reviewed ||
      id(intent.targets.get('design:' + reviewed.page.pageDesignKey).itemId) !== id(expectedDesignId)
    )
      throw Error('Shared association affects an unreviewed or differently designed page context');
  }
}
