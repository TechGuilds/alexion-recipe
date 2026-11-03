import { dirname } from 'node:path';
import {
  loadApplication,
  applicationIntent,
  applicationReadRequest,
  readApplicationState,
  stateIndex,
  observed,
  slot,
  normalizedRows,
  coveredImpact,
  contextKey,
  insideSite,
} from './lib/application-model.mjs';
import { id, equal, canonical, hash, jsonBytes, publish, cli, isMain } from './lib/common.mjs';

export function decodeTemplateMapping(raw) {
  if (!raw) return [];
  let value = raw;
  for (let n = 0; !value.includes('=') && n < 2; n++) value = decodeURIComponent(value.replaceAll('+', ' '));
  const entries = value.split('&').map((pair) => {
    const split = pair.indexOf('=');
    if (split < 1) throw Error('Unsupported TemplatesMapping serialization');
    const key = decodeURIComponent(pair.slice(0, split)),
      val = decodeURIComponent(pair.slice(split + 1));
    if (!/^\{?[a-f\d-]{36}\}?$/i.test(key) || !/^\{?[a-f\d-]{36}\}?$/i.test(val))
      throw Error('Non-GUID template association');
    return { templateId: id(key), designId: id(val) };
  });
  if (new Set(entries.map((row) => row.templateId)).size !== entries.length)
    throw Error('Duplicate template association');
  return entries.sort((a, b) => (a.templateId < b.templateId ? -1 : 1));
}
export function verifyOperationPost(operation, post) {
  if (!Array.isArray(post) || post.length !== operation.contexts.length)
    throw Error('Incomplete operation read-back');
  for (const desired of operation.contexts) {
    const row = post.find((row) => row.key === desired.query.key),
      actual = row?.item;
    if (
      !actual ||
      !actual.versionPresent ||
      id(actual.id) !== id(operation.itemId) ||
      id(actual.templateId) !== id(operation.templateId) ||
      actual.path !== operation.path
    )
      throw Error('Target identity read-back differs');
    if (!desired.before && operation.action === 'create') {
      const expectedContexts = operation.contexts
        .map((ctx) => contextKey(operation.itemId, ctx.query.language, ctx.query.version))
        .sort();
      if (
        !equal(
          actual.contexts.map((ctx) => contextKey(ctx.itemId, ctx.language, ctx.version)).sort(),
          expectedContexts,
        )
      )
        throw Error('New design language/version coverage differs');
    }
    for (const layout of desired.layouts) {
      const observedLayout = layout.final ? actual.final : actual.shared;
      if (
        !observedLayout ||
        id(observedLayout.layoutId) !== id(layout.layoutId) ||
        !equal(normalizedRows(observedLayout.renderings), normalizedRows(layout.renderings))
      )
        throw Error('Presentation occurrence/layout read-back differs');
    }
    for (const field of desired.fields) {
      const value = slot(actual, field.name);
      if (value.storage !== field.storage || id(value.id) !== id(field.fieldId))
        throw Error('Field metadata read-back differs');
      if (field.kind === 'mapping') {
        if (!equal(decodeTemplateMapping(value.value), field.mappings))
          throw Error('Template mappings read-back differs');
      } else if (field.name === 'PartialDesigns') {
        if (
          !equal(
            value.value ? value.value.split('|').map(id) : [],
            field.value ? field.value.split('|').map(id) : [],
          )
        )
          throw Error('Partial Design references read-back differ');
      } else if (['Page Design', 'Layout'].includes(field.name)) {
        if (id(value.value) !== id(field.value)) throw Error('Design association/layout read-back differs');
      } else if (value.value !== field.value) throw Error('Field value read-back differs');
    }
    if (desired.before) {
      if (!equal(actual.contexts, desired.before.contexts)) throw Error('Unexpected language/version change');
      const changed = new Set([
        ...desired.fields.map((field) => field.name),
        ...desired.layouts.map((layout) => (layout.final ? '__Final Renderings' : '__Renderings')),
      ]);
      for (const prior of desired.before.fields)
        if (
          !changed.has(prior.name) &&
          !actual.fields.some(
            (field) =>
              field.name === prior.name && field.rawValue === prior.rawValue && field.value === prior.value,
          )
        )
          throw Error('Unapproved presentation/material field changed');
      if (
        !equal(actual.sharedOther, desired.before.sharedOther) ||
        !equal(actual.finalOther, desired.before.finalOther)
      )
        throw Error('Another device changed');
    }
  }
  return true;
}
export async function buildApplication(inputPath) {
  const model = await loadApplication(inputPath),
    intent = applicationIntent(model),
    read = await applicationReadRequest(model, intent),
    { input, profile, cap } = model;
  const readEnvelope = {
    script: read.script,
    parameters: { RequestJson: jsonBytes(read.body), RequestSha256: read.sha256 },
    background: true,
    output: { mode: 'files' },
  };
  if (Buffer.byteLength(jsonBytes(readEnvelope)) > cap.maxRequestBytes)
    throw Error('Read request exceeds connector byte bound');
  if (!input.targetState)
    return {
      model,
      intent,
      read,
      report: {
        version: 1,
        scopeId: input.scopeId,
        ready: false,
        issues: [
          {
            code: 'target-read-required',
            message: 'Collect the exact bounded target read request before dry-run classification',
          },
        ],
        targetWrites: false,
      },
      outputs: {
        'presentation-read-request.json': read.body,
        'presentation-read-envelope.json': readEnvelope,
      },
    };
  const artifact = await readApplicationState(dirname(inputPath), input.targetState, read);
  model.refs.push({ path: artifact.path, sha256: artifact.sha256 });
  const state = artifact.value,
    index = stateIndex(state),
    issues = [],
    operations = [],
    mappingOps = new Map();
  const issue = (key, message) => issues.push({ code: 'application-conflict', key, message });
  const queryFor = (itemId, language, version) =>
    intent.queries.find((row) => row.key === contextKey(itemId, language, version));
  for (const material of intent.materials.values()) {
    const query = intent.queries.find((row) => row.key === material.key),
      actual = observed(index, query);
    if (!actual || !actual.versionPresent)
      throw Error('Target preview material item/version no longer exists');
    for (const field of material.fields)
      if (
        !actual.fields.some(
          (row) => id(row.id) === id(field.fieldId) && row.name === field.name && row.value === field.value,
        )
      )
        throw Error('Target material values changed after preview: ' + material.key);
  }
  for (const { plan, model: composition } of model.cohorts)
    for (const definition of composition.documents.target.renderings) {
      const actual = observed(index, queryFor(definition.id, plan.target.language, 1));
      if (!actual || actual.componentName !== definition.componentName)
        throw Error('Target component definition drift');
    }
  for (const marker of [profile.target.marker, profile.partialFolder, profile.pageFolder]) {
    const actual = observed(index, queryFor(marker.id, intent.languages[0], 1));
    if (!actual || actual.path !== marker.path || id(actual.templateId) !== id(marker.templateId))
      throw Error('Target site/folder identity changed');
  }
  const fieldFor = (actual, templateId, language, name) =>
    actual
      ? slot(actual, name)
      : state.templates
          .find((t) => id(t.id) === id(templateId) && t.language === language)
          ?.fields.find((f) => f.name === name);
  for (const [templateId, roleId] of [
    [profile.partialTemplateId, 'fd2059fd-6043-4dfe-8c04-e2437ce87634'],
    [profile.pageTemplateId, '1105b8f8-1e00-426b-bf1f-c840742d827b'],
  ])
    for (const language of intent.languages) {
      const definition = state.templates.find(
        (row) => id(row.id) === id(templateId) && row.language === language,
      );
      if (
        !definition ||
        (id(templateId) !== roleId && !definition.baseIds?.some((base) => id(base) === roleId))
      )
        issue(templateId, 'Target design template does not inherit the required SXA role');
    }
  for (const desired of intent.targets.values()) {
    try {
      const contexts = [],
        languageContexts =
          desired.kind === 'page'
            ? desired.layouts.map((layout) => ({
                language: layout.language,
                version: layout.version,
                layout,
              }))
            : desired.languages.map((language) => ({ language, version: 1 }));
      let path = desired.path,
        anyExists = false,
        allMatch = true;
      for (const ctx of languageContexts) {
        const query = queryFor(desired.itemId, ctx.language, ctx.version),
          before = observed(index, query);
        if (before) {
          anyExists = true;
          path ??= before.path;
          if (
            !insideSite(profile.target.rootPath, before.path) ||
            id(before.templateId) !== id(desired.templateId) ||
            (desired.path && before.path !== desired.path)
          )
            throw Error('Design/page ID or template/path conflict');
        } else if (desired.reuseOnly || desired.kind === 'page')
          throw Error('Required existing page/design is absent');
        const fields = [],
          layouts = [];
        const allowedTypes = {
          Signature: ['single-line text'],
          PartialDesigns: ['multilist', 'treelist', 'treelistex', 'multiroot treelist'],
          Layout: ['droplink', 'droptree', 'reference'],
          'Page Design': ['droplink', 'droptree', 'reference'],
          TemplatesMapping: ['name value list', 'lookup name lookup value list'],
        };
        const add = (name, value, kind = 'value') => {
          const meta = fieldFor(before, desired.templateId, ctx.language, name);
          if (!meta) throw Error('Target field metadata missing: ' + name);
          if (
            !allowedTypes[name]?.includes(meta.type.toLowerCase()) ||
            !['shared', 'unversioned', 'versioned'].includes(meta.storage)
          )
            throw Error('Unsupported target field type/storage: ' + name);
          if (meta.storage !== 'shared' && before && !before.versionPresent)
            throw Error('Target association language/version is absent');
          fields.push({
            name,
            fieldId: meta.id,
            storage: meta.storage,
            type: meta.type,
            kind,
            ...(kind === 'mapping' ? { mappings: value } : { value }),
          });
          return meta;
        };
        if (desired.kind === 'partial') {
          const meta = fieldFor(before, desired.templateId, ctx.language, '__Renderings');
          if (!meta || meta.storage !== 'shared' || meta.type.toLowerCase() !== 'layout')
            throw Error('Partial Design requires the shared Layout field');
          if (
            !before &&
            state.templates
              .find((t) => id(t.id) === id(desired.templateId) && t.language === ctx.language)
              ?.fields.find((f) => f.name === '__Final Renderings')?.value
          )
            throw Error('New Partial Design template has unsupported final-layout defaults');
          layouts.push(...desired.layouts);
          if (!desired.reuseOnly) add('Signature', desired.signature);
          else if (!slot(before, 'Signature').value) throw Error('Reused partial has no SXA signature');
        } else if (desired.kind === 'design') {
          add('PartialDesigns', desired.partialIds.join('|'));
          if (profile.pageDesignLayoutField) add(profile.pageDesignLayoutField, desired.layoutId);
        } else {
          if (!before?.versionPresent) throw Error('Exact page version is absent');
          layouts.push(ctx.layout);
          const name = 'Page Design',
            metadata = fieldFor(before, desired.templateId, ctx.language, name),
            value = ctx.layout.templateAssociation ? '' : ctx.layout.pageDesignId;
          if (!metadata) throw Error('Page Design field is missing');
          const finalMeta = slot(before, '__Final Renderings');
          if (finalMeta.storage !== 'versioned' || finalMeta.type.toLowerCase() !== 'layout')
            throw Error('Page requires a versioned final Layout field');
          if (
            (ctx.layout.templateAssociation || id(metadata.value) !== id(value)) &&
            (before.sharedOther?.length || before.finalOther?.length)
          )
            throw Error(
              'Page Design association affects other devices; separate reviewed device handling is required',
            );
          if (metadata.storage !== 'versioned')
            coveredImpact(
              before.contexts,
              model,
              intent,
              ctx.layout.pageDesignId,
              metadata.storage,
              ctx.language,
            );
          if (ctx.layout.templateAssociation && metadata.standardValue)
            throw Error(
              'Inherited Page Design would override the template mapping; choose a supported page-specific association',
            );
          add(name, value);
          if (ctx.layout.templateAssociation) {
            const folderQuery = queryFor(profile.pageFolder.id, ctx.language, 1),
              folder = observed(index, folderQuery),
              meta = slot(folder, 'TemplatesMapping'),
              key = meta.storage === 'shared' ? 'shared' : ctx.language;
            if (meta.storage === 'versioned')
              throw Error('Versioned TemplatesMapping requires a separately supported SXA adapter');
            if (!allowedTypes.TemplatesMapping.includes(meta.type.toLowerCase()))
              throw Error('Unsupported TemplatesMapping field type');
            const consumer = state.consumers.find((c) => id(c.templateId) === id(desired.templateId));
            if (!consumer?.complete) throw Error('Template association consumer coverage is incomplete');
            coveredImpact(
              consumer.contexts,
              model,
              intent,
              ctx.layout.pageDesignId,
              meta.storage,
              ctx.language,
            );
            if (!mappingOps.has(key))
              mappingOps.set(key, {
                before: folder,
                query: folderQuery,
                meta,
                entries: decodeTemplateMapping(meta.value),
              });
            const map = mappingOps.get(key),
              prior = map.entries.find((row) => row.templateId === id(desired.templateId));
            if (prior) prior.designId = id(ctx.layout.pageDesignId);
            else
              map.entries.push({ templateId: id(desired.templateId), designId: id(ctx.layout.pageDesignId) });
          }
        }
        const context = {
          query,
          before,
          fields,
          layouts: layouts.map((layout) => ({
            deviceId: layout.deviceId,
            final: layout.final,
            layoutId: layout.layoutId,
            renderings: layout.renderings,
          })),
        };
        try {
          verifyOperationPost({ ...desired, path: before?.path ?? path, contexts: [context] }, [
            { key: query.key, item: before },
          ]);
        } catch {
          allMatch = false;
        }
        if (desired.reuseOnly && !allMatch)
          throw Error('Explicitly reused design no longer matches approved composition');
        contexts.push(context);
      }
      if (desired.kind !== 'page' && anyExists && !allMatch && !desired.reuseOnly)
        throw Error(
          'Proposed design ID/path already exists with different content; no implicit overwrite/adoption',
        );
      const operation = {
        key: desired.key,
        kind: desired.kind,
        itemId: desired.itemId,
        path,
        templateId: desired.templateId,
        action: allMatch ? 'reuse' : anyExists ? 'update' : 'create',
        languages: desired.languages,
        contexts,
      };
      // Shared/unversioned values cannot disagree across reviewed contexts.
      const writes = new Map();
      for (const ctx of contexts)
        for (const field of ctx.fields) {
          const key =
            id(field.fieldId) +
            (field.storage === 'shared'
              ? ''
              : '|' + ctx.query.language + (field.storage === 'versioned' ? '|' + ctx.query.version : ''));
          if (writes.has(key) && !equal(writes.get(key), field))
            throw Error('Conflicting shared association values');
          writes.set(key, field);
        }
      operation.operationId = 'pres-op-' + hash(canonical(operation)).slice(0, 24);
      operations.push(operation);
    } catch (error) {
      issue(desired.key, error.message);
    }
  }
  if (mappingOps.size) {
    const contexts = [...mappingOps.values()].flatMap((row) =>
      (row.meta.storage === 'shared'
        ? intent.languages.map((language) => {
            const query = queryFor(profile.pageFolder.id, language, 1),
              before = observed(index, query);
            const meta = slot(before, 'TemplatesMapping');
            if (
              meta.storage !== 'shared' ||
              id(meta.id) !== id(row.meta.id) ||
              !equal(decodeTemplateMapping(meta.value), decodeTemplateMapping(row.meta.value))
            )
              throw Error('Shared template mapping observations disagree across languages');
            return { ...row, query, before };
          })
        : [row]
      ).map((context) => ({
        query: context.query,
        before: context.before,
        layouts: [],
        fields: [
          {
            name: 'TemplatesMapping',
            fieldId: row.meta.id,
            storage: row.meta.storage,
            type: row.meta.type,
            kind: 'mapping',
            mappings: row.entries.sort((a, b) => (a.templateId < b.templateId ? -1 : 1)),
          },
        ],
      })),
    );
    const operation = {
      key: 'template-mappings',
      kind: 'mapping',
      itemId: profile.pageFolder.id,
      path: profile.pageFolder.path,
      templateId: profile.pageFolder.templateId,
      action: 'update',
      languages: [],
      contexts,
    };
    try {
      verifyOperationPost(
        operation,
        contexts.map((ctx) => ({ key: ctx.query.key, item: ctx.before })),
      );
      operation.action = 'reuse';
    } catch {}
    operation.operationId = 'pres-op-' + hash(canonical(operation)).slice(0, 24);
    operations.push(operation);
  }
  const batchSize = input.maxOperationsPerBatch ?? 10,
    mutations = operations.filter((op) => op.action !== 'reuse'),
    batches = [];
  if (!issues.length)
    for (let offset = 0; offset < mutations.length; offset += batchSize)
      batches.push({
        id: 'presentation-batch-' + (batches.length + 1),
        operationIds: mutations.slice(offset, offset + batchSize).map((op) => op.operationId),
        dependsOn: batches.length ? [batches.at(-1).id] : [],
      });
  const plan = {
    version: 1,
    kind: 'presentation-application-plan',
    scopeId: input.scopeId,
    taskId: input.taskId,
    applicationInputSha256: model.inputSha256,
    profileSha256: input.profile.sha256,
    readRequestSha256: read.sha256,
    target: profile.target,
    operations,
    batches,
    guards: state.queries,
    templates: state.templates,
    issues,
    ready: !issues.length,
    targetWrites: false,
    mutationApprovalRequired: true,
  };
  return {
    model,
    intent,
    read,
    state,
    plan,
    report: {
      version: 1,
      scopeId: input.scopeId,
      ready: plan.ready,
      issues,
      changes: operations.map((op) => ({
        itemId: op.itemId,
        path: op.path,
        action: op.action,
        kind: op.kind,
      })),
      batches: batches.length,
      targetWrites: false,
    },
    outputs: {
      'presentation-read-request.json': read.body,
      'presentation-read-envelope.json': readEnvelope,
      'application-plan.json': plan,
    },
  };
}
export async function planPresentationApplication(inputPath, outputPath) {
  const result = await buildApplication(inputPath);
  await publish(
    outputPath,
    { ...result.outputs, 'application-report.json': result.report },
    result.model.refs,
  );
  return result.report;
}
if (isMain(import.meta.url)) await cli(planPresentationApplication);
