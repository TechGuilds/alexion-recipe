import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildVerificationModel, boundedVerification } from './lib/verification-model.mjs';
import {
  readJSON,
  readArtifactJSON,
  hash,
  jsonBytes,
  normalizeId,
  fail,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
  MAX_JSON_BYTES,
} from './lib/files.mjs';
import { requireSchema } from './lib/schema.mjs';
import { queryKey, canonical } from './lib/target-state.mjs';
import { fieldKey } from './lib/snapshot.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const versionKey = (v) => v.language + '|' + v.version;
const fieldScope = (f) =>
  f.storage === 'shared'
    ? f.language === undefined && f.version === undefined
    : f.storage === 'unversioned'
      ? !!f.language && f.version === undefined
      : !!f.language && Number.isInteger(f.version) && f.version > 0;
export const verificationReaderSource = () =>
  readFile(new URL('./capture-target.ps1', import.meta.url), 'utf8');

/** Deterministic full request set: retries retain the original request/group hashes. */
export function planVerificationRequests(model, script) {
  const { expected, expectedSha256, request, cap } = model,
    collectorSha256 = hash(script),
    groups = [];
  const capabilities = Object.fromEntries(
    [
      'speRead',
      'fileDownload',
      'stableReadWindow',
      'verifiedAt',
      'expiresAt',
      'maxCaptureBytes',
      'maxRequestBytes',
    ].map((k) => [k, cap[k]]),
  );
  const make = (queries) => {
    const body = {
      version: 1,
      expectedSha256,
      collectorSha256,
      readbackId: request.readbackId,
      scopeId: expected.scopeId,
      target: expected.target,
      capabilities,
      queries,
      maxBytes: cap.maxCaptureBytes,
    };
    const requestId = 'verify-' + hash(jsonBytes(body)).slice(0, 24);
    const value = { ...body, requestId };
    requireSchema('verificationRequest', value);
    const requestJson = jsonBytes(value),
      requestSha256 = hash(requestJson);
    return {
      requestId,
      requestSha256,
      request: value,
      envelope: {
        script,
        parameters: { RequestJson: requestJson, RequestSha256: requestSha256 },
        background: true,
        output: { mode: 'files' },
      },
    };
  };
  let current = [];
  const max = request.maxQueriesPerRequest ?? 50;
  for (const query of expected.queries) {
    const next = [...current, query];
    if (next.length > max || Buffer.byteLength(jsonBytes(make(next).envelope)) > cap.maxRequestBytes) {
      if (current.length) groups.push(make(current));
      current = [];
    }
    const one = make([...current, query]);
    if (Buffer.byteLength(jsonBytes(one.envelope)) > cap.maxRequestBytes)
      throw fail(
        'verification-request-size',
        query.value,
        'One exact read query exceeds the verified connector limit',
      );
    current.push(query);
  }
  if (current.length) groups.push(make(current));
  return groups;
}

function canonicalObserved(item) {
  return {
    ...item,
    id: normalizeId(item.id),
    templateId: normalizeId(item.templateId),
    parentId: normalizeId(item.parentId),
    path: normalizeId(item.path),
    versions: [...item.versions].sort((a, b) => versionKey(a).localeCompare(versionKey(b))),
    fields: item.fields
      .map((f) => ({ ...f, fieldId: normalizeId(f.fieldId) }))
      .sort((a, b) => fieldKey(a).localeCompare(fieldKey(b))),
  };
}

export async function verifyTarget(inputPath, outputPath) {
  const model = await buildVerificationModel(inputPath),
    { input, request, expected, expectedSha256, checkpoint, cap, nodes } = model;
  const script = await verificationReaderSource(),
    groups = planVerificationRequests(model, script),
    requests = new Map(groups.map((g) => [g.requestId, g]));
  const observed = new Map(),
    responseErrors = [],
    completeRequests = new Set(),
    requestResponses = new Map(),
    selectedFiles = new Set();
  let readbackBytes = 0;
  const addIssue = (code, message, targetPath) =>
    model.issues.push({ code, message, ...(targetPath ? { targetPath } : {}) });
  for (const descriptor of request.readbacks) {
    const fileKey = descriptor.path + '|' + descriptor.sha256;
    if (selectedFiles.has(fileKey)) continue;
    selectedFiles.add(fileKey);
    const artifact = await readArtifactJSON(dirname(inputPath), descriptor, cap.maxCaptureBytes);
    readbackBytes += artifact.bytes;
    if (readbackBytes > 4 * MAX_JSON_BYTES)
      throw fail(
        'verification-size',
        'readbacks',
        'Read-back values exceed the 64 MiB audit limit; reduce the approved audit scope',
      );
    const state = artifact.value;
    requireSchema('verificationState', state);
    const group = requests.get(state.requestId);
    if (
      !group ||
      state.requestSha256 !== group.requestSha256 ||
      state.expectedSha256 !== expectedSha256 ||
      state.collectorSha256 !== hash(script) ||
      state.targetStateId !== request.readbackId ||
      state.scopeId !== expected.scopeId ||
      state.instanceId !== cap.instanceId ||
      state.database !== cap.database ||
      state.rootPath !== '/sitecore'
    )
      throw fail(
        'verification-readback-binding',
        descriptor.path,
        'Read-back does not belong to this exact target, expected model, collector and audit request',
      );
    const capturedAt = Date.parse(state.capturedAt);
    if (
      !Number.isFinite(capturedAt) ||
      capturedAt < Date.parse(cap.verifiedAt) ||
      capturedAt > Date.parse(cap.expiresAt) ||
      capturedAt > Date.now()
    )
      throw fail(
        'verification-readback-time',
        descriptor.path,
        'Read-back is outside the verified stable audit window',
      );
    if (requestResponses.has(state.requestId)) {
      if (requestResponses.get(state.requestId) !== artifact.sha256)
        throw fail(
          'verification-duplicate',
          descriptor.path,
          'Select exactly one retained response per read request; do not mix capture attempts',
        );
      continue;
    }
    requestResponses.set(state.requestId, artifact.sha256);
    const keys = new Set();
    for (const query of state.queries) {
      const key = queryKey(query.lookup, query.value),
        selected = group.request.queries.find((q) => queryKey(q.lookup, q.value) === key);
      if (!selected || keys.has(key))
        throw fail('verification-query', descriptor.path, 'Unexpected or duplicate read-back query');
      keys.add(key);
      if (query.exists) {
        const item = query.item;
        if (!same(query.value, query.lookup === 'id' ? item.id : item.path))
          throw fail(
            'verification-query',
            descriptor.path,
            'Read-back result does not match its exact lookup',
          );
        if (
          !/^\/sitecore\/(?:content|media library)(?:\/|$)/i.test(item.path) ||
          /[\\{}:*?"<>|\[\]\x00-\x1f]/.test(item.path) ||
          item.path.split('/').some((p) => p === '.' || p === '..')
        )
          throw fail(
            'verification-query',
            descriptor.path,
            'Read-back returned an unsafe or unsupported content/media path',
          );
        if (
          new Set(item.versions.map(versionKey)).size !== item.versions.length ||
          new Set(item.fields.map(fieldKey)).size !== item.fields.length
        )
          throw fail('verification-query', descriptor.path, 'Repeated field/version observation');
        if (
          item.fields.some(
            (f) =>
              !fieldScope(f) ||
              !selected.fields.some((s) => fieldKey(s) === fieldKey(f) && s.storage === f.storage) ||
              (f.present &&
                f.storage === 'versioned' &&
                !item.versions.some((v) => v.language === f.language && v.version === f.version)),
          )
        )
          throw fail(
            'verification-field-scope',
            descriptor.path,
            'Read-back field storage/version is inconsistent with its selected query',
          );
        if (selected.fields.some((s) => !item.fields.some((f) => fieldKey(s) === fieldKey(f))))
          throw fail(
            'verification-incomplete',
            descriptor.path,
            'Read-back query silently omitted a selected field',
          );
      }
      if (observed.has(key) && canonical(observed.get(key)) !== canonical(query))
        throw fail('verification-query', descriptor.path, 'Conflicting read-back queries');
      observed.set(key, query);
    }
    if (state.complete && (state.errors.length || keys.size !== group.request.queries.length))
      throw fail(
        'verification-completion',
        descriptor.path,
        'Complete read-back has errors or missing queries',
      );
    if (!state.complete && !state.errors.length)
      throw fail(
        'verification-completion',
        descriptor.path,
        'Incomplete read-back requires an explicit error',
      );
    for (const error of state.errors) {
      const key = queryKey(error.lookup, error.value);
      if (!group.request.queries.some((q) => queryKey(q.lookup, q.value) === key))
        throw fail(
          'verification-error-scope',
          descriptor.path,
          'Capture error refers to a query outside its request',
        );
      responseErrors.push({ ...error, requestId: state.requestId });
    }
    if (state.complete) completeRequests.add(state.requestId);
  }
  const gaps = [];
  for (const group of groups)
    for (const query of group.request.queries)
      if (!observed.has(queryKey(query.lookup, query.value)))
        gaps.push({ lookup: query.lookup, value: query.value, requestId: group.requestId });
  // Pair lookups must describe the same item and selected scopes. Explicit absence is never a missing read.
  const physical = new Map();
  for (const query of observed.values())
    if (query.exists) {
      const id = normalizeId(query.item.id),
        value = canonical(canonicalObserved(query.item));
      if (physical.has(id) && physical.get(id) !== value)
        throw fail('verification-contradiction', 'readbacks', 'ID and path reads disagree about an item');
      physical.set(id, value);
    }
  for (const query of observed.values())
    if (
      !query.exists &&
      [...observed.values()].some(
        (other) => other.exists && same(query.value, query.lookup === 'id' ? other.item.id : other.item.path),
      )
    )
      throw fail(
        'verification-contradiction',
        'readbacks',
        'Target existence observations contradict each other',
      );
  const items = nodes.map((node) => {
    const differences = [],
      a = observed.get(queryKey('id', node.targetItemId)),
      b = observed.get(queryKey('path', node.targetPath));
    let incomplete = !a || !b;
    const difference = (code, message, field) =>
      differences.push({
        code,
        message,
        ...(field
          ? {
              fieldId: field.fieldId,
              ...(field.language ? { language: field.language } : {}),
              ...(field.version ? { version: field.version } : {}),
            }
          : {}),
      });
    if (!a || !b) difference('missing-read', 'Exact ID and path read-back are required');
    if ((a && !a.exists) || (b && !b.exists))
      difference('missing-item', 'Planned item or path is absent from the target');
    if (a?.exists) {
      const actual = a.item;
      if (
        !same(actual.id, node.targetItemId) ||
        !same(actual.path, node.targetPath) ||
        !same(actual.templateId, node.templateId)
      )
        difference('identity', 'Target ID, template or destination differs');
      if (node.parentId && !same(actual.parentId, node.parentId))
        difference('parent', 'Actual parent ID differs from the approved hierarchy');
      if (
        canonical([...actual.versions].sort((x, y) => versionKey(x).localeCompare(versionKey(y)))) !==
        canonical([...node.versions].sort((x, y) => versionKey(x).localeCompare(versionKey(y))))
      )
        difference(
          'versions',
          'Complete target languages/versions differ from agreed and preserved versions',
        );
      for (const field of node.fields) {
        const actualField = actual.fields.find((f) => fieldKey(f) === fieldKey(field));
        if (!actualField) {
          incomplete = true;
          difference('missing-field-read', 'A mapped field was not observed', field);
        } else if (!actualField.present) difference('missing-field', 'Mapped field is absent', field);
        else if (
          actualField.storage !== field.storage ||
          actualField.fieldType.trim().toLowerCase() !== field.fieldType.trim().toLowerCase()
        )
          difference('field-definition', 'Actual field storage/type differs', field);
        else if (actualField.value !== field.value)
          difference('field-value', 'Target value differs from source-derived transformed value', field);
      }
    }
    for (const history of node.historyIssues) differences.push(history);
    const actualDifferences = differences.some(
      (d) =>
        ![
          'missing-read',
          'missing-field-read',
          'execution-failed',
          'execution-skipped',
          'identity-history',
          'unconfirmed-identity',
          'unconfirmed-structure',
        ].includes(d.code),
    );
    const status = actualDifferences
      ? 'failed'
      : incomplete || node.historyIssues.length
        ? 'unverified'
        : node.reused
          ? 'reused'
          : 'success';
    return {
      kind: node.kind,
      targetItemId: node.targetItemId,
      targetPath: node.targetPath,
      templateId: node.templateId,
      ...(node.sourceItemId ? { sourceItemId: node.sourceItemId } : {}),
      status,
      differences,
    };
  });
  for (const dependency of expected.dependencies) {
    const id = observed.get(queryKey('id', dependency.targetItemId)),
      path = observed.get(queryKey('path', dependency.targetPath));
    if (
      id &&
      path &&
      (!id.exists ||
        !path.exists ||
        !same(id.item?.path ?? '', dependency.targetPath) ||
        !same(id.item?.templateId ?? '', dependency.templateId) ||
        !same(path.item?.id ?? '', dependency.targetItemId))
    )
      addIssue(
        'dependency',
        'Parent, root marker or reference target identity differs or is absent',
        dependency.targetPath,
      );
  }
  for (const error of responseErrors) addIssue('capture-error', `${error.requestId}: ${error.message}`);
  const contentParity =
    !gaps.length &&
    !items.some((i) => i.status === 'failed' || i.status === 'unverified') &&
    !model.issues.length &&
    completeRequests.size === groups.length;
  const summary = {
    success: items.filter((i) => i.status === 'success').length,
    reused: items.filter((i) => i.status === 'reused').length,
    failed: items.filter((i) => i.status === 'failed').length,
    unverified: items.filter((i) => i.status === 'unverified').length,
    excluded: expected.exclusions.length,
  };
  const report = boundedVerification({
    version: 1,
    scopeId: expected.scopeId,
    ready: contentParity,
    contentParity,
    requiresUserConfirmation: true,
    expectedSha256,
    verificationInputSha256: input.sha256,
    checkpointSha256: model.artifacts.checkpoint.sha256,
    readbackId: request.readbackId,
    summary,
    items,
    exclusions: expected.exclusions,
    executionOutcomes: checkpoint.operations.map(
      ({ operationId, targetItemId, status, mutated, operationKind, requestId }) => ({
        operationId,
        targetItemId,
        status,
        mutated,
        ...(operationKind ? { operationKind } : {}),
        requestId,
      }),
    ),
    issues: model.issues,
    gaps,
    readRequestCount: groups.length,
    completedRequestCount: completeRequests.size,
    boundaries: {
      presentationVerified: false,
      visualVerified: false,
      mediaBinariesVerified: false,
      unrelatedItemsEnumerated: false,
      workflowAdvanced: false,
    },
    deferredParameters: expected.deferredParameters,
  });
  requireSchema('verificationReport', report);
  for (const name of ['contentPlanInput', 'checkpoint', 'capabilities'])
    await readArtifactJSON(dirname(inputPath), request[name]);
  for (const descriptor of request.readbacks)
    await readArtifactJSON(dirname(inputPath), descriptor, cap.maxCaptureBytes);
  await readArtifactJSON(dirname(model.artifacts.capabilities.path), cap.evidence);
  await model.recheck();
  if (
    (await readJSON(inputPath)).sha256 !== input.sha256 ||
    hash(await verificationReaderSource()) !== hash(script) ||
    Date.parse(cap.expiresAt) <= Date.now()
  )
    throw fail(
      'verification-drift',
      'verificationInput',
      'Audit inputs, collector or stable read window changed during comparison',
    );
  const output = await freshDirectory(outputPath),
    needed = groups
      .filter((g) => !completeRequests.has(g.requestId))
      .map(({ requestId, requestSha256, envelope }) => ({ requestId, requestSha256, envelope }));
  for (const [name, value] of [
    ['verification-report.json', report],
    ['expected-content.json', expected],
    [
      'target-read-requirements.json',
      { version: 1, scopeId: expected.scopeId, readbackId: request.readbackId, expectedSha256, gaps },
    ],
    [
      'readback-requests.json',
      {
        version: 1,
        scopeId: expected.scopeId,
        readbackId: request.readbackId,
        expectedSha256,
        requests: needed,
      },
    ],
  ])
    await writeNewJSON(join(output, name), boundedVerification(value));
  return {
    ready: report.ready,
    contentParity,
    summary,
    readRequestCount: groups.length,
    outstandingRequestCount: needed.length,
    gapCount: gaps.length,
    requiresUserConfirmation: true,
    outputs: {
      report: { path: 'verification-report.json', sha256: hash(jsonBytes(report)) },
      expected: { path: 'expected-content.json', sha256: expectedSha256 },
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
        'Usage: node verify-target.mjs --input verification-input.json --output NEW_DIRECTORY',
      );
    const result = await verifyTarget(args[1], args[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
