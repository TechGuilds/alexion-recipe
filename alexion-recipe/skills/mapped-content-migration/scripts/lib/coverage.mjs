import { requireSchema } from './schema.mjs';
import { normalizeId, fail } from './files.mjs';
import { fieldKey, contextKey } from './snapshot.mjs';

export function requiredFields(specs, versions) {
  return specs.flatMap((spec) =>
    spec.storage === 'shared'
      ? [{ ...spec }]
      : spec.storage === 'unversioned'
        ? [...new Set(versions.map((v) => v.language))].map((language) => ({ ...spec, language }))
        : versions.map((v) => ({ ...spec, ...v })),
  );
}
export function checkScope(scope) {
  requireSchema('captureScope', scope);
  const seen = new Set();
  const pathValid = (p) =>
    /^\/sitecore\/[^\\:*?\[\]\x00-\x1f]+$/.test(p) && !/(^|\/)\.\.?($|\/)|\/\/|\/$/.test(p);
  if (scope.rootPaths.some((p) => !pathValid(p)))
    throw fail('scope', 'scope.rootPaths', 'Unsafe source root');
  for (const item of scope.items) {
    if (!pathValid(item.path)) throw fail('scope', item.id, 'Unsafe explicit source path');
    if (seen.has(normalizeId(item.id)))
      throw fail('scope', 'scope.items', 'Repeated source item in approved scope');
    seen.add(normalizeId(item.id));
    if (
      !scope.rootPaths.some(
        (root) =>
          item.path.toLowerCase().startsWith(root.toLowerCase() + '/') ||
          item.path.toLowerCase() === root.toLowerCase(),
      )
    )
      throw fail('scope', item.id, 'Source item is outside approved roots');
    if (item.versions.some((v) => !scope.languages.includes(v.language)))
      throw fail('scope', item.id, 'Item language is outside approved scope');
    if (
      new Set(requiredFields(item.fields, item.versions).map(fieldKey)).size !==
      requiredFields(item.fields, item.versions).length
    )
      throw fail('scope', item.id, 'Repeated field requirement');
  }
  if (new Set(scope.renderingInstances.map(contextKey)).size !== scope.renderingInstances.length)
    throw fail('scope', 'scope.renderingInstances', 'Repeated rendering requirement');
  for (const context of scope.renderingInstances) {
    if (
      !scope.languages.includes(context.language) ||
      !scope.items.some(
        (i) =>
          normalizeId(i.id) === normalizeId(context.pageId) &&
          i.versions.some((v) => v.language === context.language && v.version === context.version),
      )
    )
      throw fail('scope', context.instanceId, 'Rendering context requires its approved page version');
    if (context.parameters.length && !context.parameterTemplateId)
      throw fail('scope', context.instanceId, 'Parameter values require a parameter template ID');
  }
}

/** Coverage indexes contain keys and flags only, never content values. */
export function createCoverage(scope) {
  checkScope(scope);
  const items = new Map(
    scope.items.map((s) => [
      normalizeId(s.id),
      { spec: s, found: false, fields: new Set(), refs: new Set(), versions: new Set() },
    ]),
  );
  const contexts = new Map(
    scope.renderingInstances.map((s) => [contextKey(s), { spec: s, found: false, fields: new Set() }]),
  );
  const checkValues = (values, specs, versions, path) => {
    const seen = new Set();
    for (const value of values) {
      const key = fieldKey(value),
        spec = specs.find((s) => normalizeId(s.fieldId) === normalizeId(value.fieldId));
      if (seen.has(key)) throw fail('duplicate', path, 'Repeated field value');
      seen.add(key);
      if (
        !spec ||
        spec.storage !== value.storage ||
        !requiredFields([spec], versions).some((f) => fieldKey(f) === key)
      )
        throw fail('field-scope', path, 'Unexpected field or language/version/storage scope');
      if (spec.fieldType && spec.fieldType.toLowerCase() !== value.fieldType?.toLowerCase())
        throw fail('field-type', path, 'Field type differs from approved evidence');
    }
  };
  return {
    add(record) {
      requireSchema('snapshotRecord', record);
      const row = record.data;
      if (record.kind === 'item') {
        const state = items.get(normalizeId(row.id));
        if (!state) throw fail('scope', row.id, 'Unrequested item in prepared snapshot');
        if (
          normalizeId(row.templateId) !== normalizeId(state.spec.templateId) ||
          row.path !== state.spec.path ||
          (state.spec.parentId && normalizeId(row.parentId) !== normalizeId(state.spec.parentId))
        )
          throw fail('identity', row.id, 'Source evidence identity disagrees with approved scope');
        state.found = true;
        if (
          row.versions.some(
            (v) => !state.spec.versions.some((s) => s.language === v.language && s.version === v.version),
          )
        )
          throw fail('field-scope', row.id, 'Unexpected item version');
        checkValues(row.fields, state.spec.fields, state.spec.versions, row.id);
        row.versions.forEach((v) => state.versions.add(`${v.language}|${v.version}`));
        row.fields.forEach((f) => state.fields.add(fieldKey(f)));
        const referenceKeys = new Set();
        row.references.forEach((r) => {
          if (referenceKeys.has(fieldKey(r))) throw fail('duplicate', row.id, 'Repeated reference tuple');
          referenceKeys.add(fieldKey(r));
          const spec = state.spec.fields.find((s) => normalizeId(s.fieldId) === normalizeId(r.fieldId));
          if (
            !spec?.referenceKind ||
            spec.referenceKind !== r.kind ||
            !requiredFields([spec], state.spec.versions).some((f) => fieldKey(f) === fieldKey(r))
          )
            throw fail('reference-scope', row.id, 'Unexpected reference scope or kind');
          state.refs.add(fieldKey(r));
        });
      } else {
        const state = contexts.get(contextKey(row));
        if (!state) throw fail('scope', row.instanceId, 'Unrequested rendering context in prepared snapshot');
        if (
          normalizeId(row.renderingId) !== normalizeId(state.spec.renderingId) ||
          normalizeId(row.parameterTemplateId ?? '') !== normalizeId(state.spec.parameterTemplateId ?? '') ||
          normalizeId(row.datasourceId ?? '') !== normalizeId(state.spec.datasourceId ?? '')
        )
          throw fail('identity', row.instanceId, 'Rendering evidence identity disagrees with approved scope');
        state.found = true;
        checkValues(
          row.parameters,
          state.spec.parameters,
          [{ language: state.spec.language, version: state.spec.version }],
          row.instanceId,
        );
        row.parameters.forEach((f) => state.fields.add(fieldKey(f)));
      }
    },
    report() {
      const missingItems = [],
        missingContexts = [];
      for (const state of items.values()) {
        const missing = requiredFields(state.spec.fields, state.spec.versions).filter(
          (f) => !state.fields.has(fieldKey(f)) || (f.referenceKind && !state.refs.has(fieldKey(f))),
        );
        const versions = state.spec.versions.filter((v) => !state.versions.has(`${v.language}|${v.version}`));
        if (!state.found || missing.length || versions.length)
          missingItems.push({
            ...state.spec,
            fields: state.spec.fields.filter((f) =>
              missing.some((m) => normalizeId(m.fieldId) === normalizeId(f.fieldId)),
            ),
            metadataMissing: !state.found,
            missingVersions: versions,
            missingFieldValues: missing,
          });
      }
      for (const state of contexts.values()) {
        const missing = requiredFields(state.spec.parameters, [
          { language: state.spec.language, version: state.spec.version },
        ]).filter((f) => !state.fields.has(fieldKey(f)));
        if (!state.found || missing.length)
          missingContexts.push({
            ...state.spec,
            parameters: state.spec.parameters.filter((f) =>
              missing.some((m) => normalizeId(m.fieldId) === normalizeId(f.fieldId)),
            ),
          });
      }
      return {
        ready: !missingItems.length && !missingContexts.length,
        missingItems,
        missingContexts,
        requestedItems: items.size,
        capturedItems: [...items.values()].filter((s) => s.found).length,
        requestedContexts: contexts.size,
        capturedContexts: [...contexts.values()].filter((s) => s.found).length,
      };
    },
  };
}
