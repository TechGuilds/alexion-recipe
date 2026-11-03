import { readFile, writeFile, mkdir, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { requireSchema } from './lib/schema.mjs';
import { createCoverage, requiredFields } from './lib/coverage.mjs';
import { openSnapshot, createSnapshotWriter, fieldKey, contextKey } from './lib/snapshot.mjs';
import {
  readJSON,
  readArtifactJSON,
  readJSONLines,
  freshDirectory,
  normalizeId,
  fail,
  hash,
  jsonBytes,
  writeNewJSON,
  isMain,
  errorReport,
} from './lib/files.mjs';

const same = (a, b) => normalizeId(a) === normalizeId(b);
const stamp = () => new Date().toISOString();

async function* evidenceRecords(base, evidence, scope) {
  if (evidence.format === 'discovery-summary') return;
  if (evidence.format === 'snapshot-json' || evidence.format === 'snapshot-manifest') {
    const artifact = await readArtifactJSON(base, evidence);
    const snapshot = await openSnapshot(artifact.path);
    for (const key of ['scopeId', 'instanceId', 'database'])
      if (snapshot.header[key] !== scope[key])
        throw fail('identity', evidence.path, 'Snapshot identity differs from scope');
    if (snapshot.manifest && snapshot.manifest.sourceStateId !== scope.sourceStateId)
      throw fail('source-state', evidence.path, 'Snapshot state differs from scope');
    if (Date.parse(snapshot.header.capturedAt) !== Date.parse(evidence.capturedAt))
      throw fail('provenance', evidence.path, 'Evidence capture time differs from snapshot');
    yield* snapshot.records();
    return;
  }
  if (evidence.format === 'discovery-items-jsonl') {
    for await (const row of readJSONLines(base, evidence)) {
      const spec = scope.items.find((s) => same(s.id, row.id));
      if (!spec) continue;
      // Native Discovery rows use names and omit parent ID. Only adapt when the
      // approved scope supplies field IDs/storage/names and verified parent ID.
      if (!spec.parentId || !row.fields || !Number.isInteger(Number(row.version))) continue;
      const fields = spec.fields
        .filter(
          (f) =>
            f.name &&
            spec.fields.filter((other) => other.name === f.name).length === 1 &&
            Object.hasOwn(row.fields, f.name) &&
            typeof row.fields[f.name] === 'string',
        )
        .map((f) => ({
          fieldId: f.fieldId,
          storage: f.storage,
          value: row.fields[f.name],
          ...(f.fieldType ? { fieldType: f.fieldType } : {}),
          ...(f.storage === 'shared' ? {} : { language: row.language }),
          ...(f.storage === 'versioned' ? { version: Number(row.version) } : {}),
        }));
      yield {
        kind: 'item',
        data: {
          id: row.id,
          parentId: spec.parentId,
          path: row.path,
          name: row.name,
          templateId: row.templateId,
          versions: [{ language: row.language, version: Number(row.version) }],
          fields,
          references: [],
        },
      };
    }
    return;
  }
  let header = false,
    complete = false,
    captureId,
    written = 0,
    errors = 0;
  for await (const row of readJSONLines(base, evidence)) {
    if (row.kind === 'header') {
      requireSchema('captureHeader', row.data);
      if (header) throw fail('capture', evidence.path, 'Repeated capture header');
      for (const key of ['scopeId', 'instanceId', 'database', 'sourceStateId'])
        if (row.data[key] !== scope[key])
          throw fail('identity', evidence.path, 'Capture identity differs from scope');
      if (typeof row.data.requestId !== 'string' || !row.data.requestId.trim())
        throw fail('capture', evidence.path, 'Capture header requires a request ID');
      if (
        !Number.isFinite(Date.parse(row.data.capturedAt)) ||
        Date.parse(row.data.capturedAt) !== Date.parse(evidence.capturedAt)
      )
        throw fail('provenance', evidence.path, 'Evidence capture time differs from capture header');
      captureId = row.data.requestId;
      header = true;
    } else if (row.kind === 'complete') {
      requireSchema('captureCompletion', row.data);
      if (row.data.partial !== (row.data.errors > 0 || row.data.limited))
        throw fail('capture', evidence.path, 'Capture partial/limit flags disagree');
      if (
        !header ||
        complete ||
        row.data.requestId !== captureId ||
        row.data.written !== written ||
        row.data.errors !== errors
      )
        throw fail('capture', evidence.path, 'Invalid capture completion/counts');
      complete = true;
    } else if (row.kind === 'error') {
      if (!header || complete) throw fail('capture', evidence.path, 'Error outside capture envelope');
      errors++;
    } else {
      if (!header || complete) throw fail('capture', evidence.path, 'Capture data outside terminal envelope');
      written++;
      yield requireSchema('snapshotRecord', row);
    }
  }
  if (!header || !complete)
    throw fail('capture', evidence.path, 'Capture has no terminal header/completion evidence');
}

function mergeValues(before, incoming, key, path) {
  const values = new Map(before.map((v) => [key(v), v]));
  for (const value of incoming) {
    const previous = values.get(key(value));
    const fieldType = previous?.fieldType ?? value.fieldType;
    const canonical = (row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(fieldType ? { ...row, fieldType: row.fieldType ?? fieldType } : row)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [
              k,
              k === 'fieldId' || k === 'fieldType'
                ? normalizeId(v)
                : k === 'targetSourceIds'
                  ? v.map(normalizeId)
                  : v,
            ]),
        ),
      );
    if (previous && canonical(previous) !== canonical(value))
      throw fail('conflict', path, 'Conflicting values from source evidence');
    values.set(key(value), fieldType ? { ...value, fieldType } : value);
  }
  return [...values.values()];
}

export async function prepareSourceSnapshot(inputPath, outputPath) {
  const { value: request, sha256: requestSha256 } = await readJSON(inputPath);
  requireSchema('prepareSourceInput', request);
  const scope = request.scope,
    coverage = createCoverage(scope);
  const output = await freshDirectory(outputPath),
    spool = join(output, 'records');
  await mkdir(spool);
  const itemSpecs = new Map(scope.items.map((i) => [normalizeId(i.id), i])),
    contextSpecs = new Map(scope.renderingInstances.map((c) => [contextKey(c), c]));
  const records = new Map(),
    provenance = [];
  for (const evidence of request.evidence) {
    for (const key of ['scopeId', 'instanceId', 'database'])
      if (evidence[key] !== scope[key])
        throw fail('identity', evidence.path, 'Source evidence identity differs from approved scope');
    const status =
      evidence.sourceStateId !== scope.sourceStateId
        ? 'stale'
        : evidence.format === 'discovery-summary'
          ? 'unsupported'
          : evidence.format === 'capture-jsonl'
            ? 'capture'
            : 'reused';
    provenance.push({
      path: evidence.path,
      sha256: evidence.sha256,
      format: evidence.format,
      sourceStateId: evidence.sourceStateId,
      capturedAt: evidence.capturedAt,
      status,
    });
    if (status === 'stale' || status === 'unsupported') continue;
    for await (const record of evidenceRecords(dirname(inputPath), evidence, scope)) {
      requireSchema('snapshotRecord', record);
      const item = record.kind === 'item',
        spec = item ? itemSpecs.get(normalizeId(record.data.id)) : contextSpecs.get(contextKey(record.data));
      if (!spec) continue;
      const key =
        (item ? 'item|' : 'context|') + (item ? normalizeId(record.data.id) : contextKey(record.data));
      const file = records.get(key) ?? join(spool, hash(key) + '.json');
      let data = structuredClone(record.data);
      if (item) {
        data.versions = data.versions.filter((v) =>
          spec.versions.some((s) => s.language === v.language && s.version === v.version),
        );
        const requestedKeys = new Set(requiredFields(spec.fields, spec.versions).map(fieldKey));
        data.fields = data.fields.filter(
          (f) =>
            spec.fields.some((s) => same(s.fieldId, f.fieldId) && s.storage === f.storage) &&
            requestedKeys.has(fieldKey(f)),
        );
        data.references = data.references.filter((r) => requestedKeys.has(fieldKey(r)));
        if (!data.versions.length) continue;
      } else
        data.parameters = data.parameters.filter((f) =>
          spec.parameters.some((s) => same(s.fieldId, f.fieldId) && s.storage === f.storage),
        );
      for (const values of item ? [data.fields, data.references] : [data.parameters]) {
        if (new Set(values.map(fieldKey)).size !== values.length)
          throw fail('duplicate', evidence.path, 'Repeated field or reference tuple in source record');
      }
      if (records.has(key)) {
        const previous = (await readJSON(file)).value.data;
        const stable = item
          ? ['id', 'parentId', 'templateId', 'path', 'name']
          : [
              'pageId',
              'instanceId',
              'renderingId',
              'deviceId',
              'language',
              'version',
              'datasourceId',
              'parameterTemplateId',
            ];
        if (stable.some((k) => (/id$/i.test(k) ? !same(previous[k], data[k]) : previous[k] !== data[k])))
          throw fail('conflict', evidence.path, 'Conflicting source identity metadata');
        if (item) {
          data.fields = mergeValues(previous.fields, data.fields, fieldKey, data.id);
          data.versions = mergeValues(
            previous.versions,
            data.versions,
            (v) => `${v.language}|${v.version}`,
            data.id,
          );
          data.references = mergeValues(previous.references, data.references, fieldKey, data.id);
        } else data.parameters = mergeValues(previous.parameters, data.parameters, fieldKey, data.instanceId);
      }
      await writeFile(file, jsonBytes({ kind: record.kind, data }));
      records.set(key, file);
    }
  }
  const writer = await createSnapshotWriter(
    output,
    {
      version: 1,
      scopeId: scope.scopeId,
      instanceId: scope.instanceId,
      database: scope.database,
      sourceStateId: scope.sourceStateId,
      capturedAt:
        provenance
          .filter((p) => ['reused', 'capture'].includes(p.status))
          .map((p) => p.capturedAt)
          .sort()
          .at(-1) ?? stamp(),
      rootPaths: scope.rootPaths,
      languages: scope.languages,
    },
    request,
  );
  try {
    for (const key of [...records.keys()].sort()) {
      const record = (await readJSON(records.get(key))).value;
      coverage.add(record);
      await writer.add(record);
    }
    const report = coverage.report(),
      captureRequests = [];
    const maxItems = request.maxItemsPerCapture ?? 50,
      maxContexts = request.maxContextsPerCapture ?? 50;
    const pending = [],
      rows = [];
    for (const missing of report.missingItems) {
      const { metadataMissing, missingVersions, missingFieldValues, ...spec } = missing;
      const groups = new Map();
      for (const [index, version] of spec.versions.entries()) {
        const fields = spec.fields.filter((f) =>
          missingFieldValues.some(
            (m) =>
              same(m.fieldId, f.fieldId) &&
              (m.storage === 'shared'
                ? index === 0
                : m.storage === 'unversioned'
                  ? m.language === version.language &&
                    spec.versions.findIndex((v) => v.language === version.language) === index
                  : m.language === version.language && m.version === version.version),
          ),
        );
        if (
          !metadataMissing &&
          !fields.length &&
          !missingVersions.some((v) => v.language === version.language && v.version === version.version)
        )
          continue;
        const key = JSON.stringify(fields);
        if (!groups.has(key)) groups.set(key, { ...spec, fields, versions: [] });
        groups.get(key).versions.push(version);
      }
      rows.push(...groups.values());
    }
    let batch = [];
    for (const row of rows) {
      if (batch.length >= maxItems || batch.some((other) => same(other.id, row.id))) {
        pending.push({ items: batch, renderingInstances: [] });
        batch = [];
      }
      batch.push(row);
    }
    if (batch.length) pending.push({ items: batch, renderingInstances: [] });
    for (let i = 0; i < report.missingContexts.length; i += maxContexts)
      pending.push({ items: [], renderingInstances: report.missingContexts.slice(i, i + maxContexts) });
    if (pending.length) await mkdir(join(output, 'requests'));
    const script = await readFile(new URL('./capture-source.ps1', import.meta.url), 'utf8');
    for (const batch of pending) {
      const payload = {
        version: 1,
        requestId: 'capture-' + hash(jsonBytes({ scope, batch })).slice(0, 24),
        scope: { ...scope, ...batch },
        maxResponseBytes: request.maxPartBytes ?? 4 * 1024 * 1024,
      };
      requireSchema('captureRequest', payload);
      const envelope = {
        script,
        parameters: { Request: payload },
        background: true,
        output: { mode: 'files' },
      };
      const path = `requests/${payload.requestId}.json`;
      await writeNewJSON(join(output, path), envelope);
      captureRequests.push({ path, sha256: hash(jsonBytes(envelope)), requestId: payload.requestId });
    }
    await writer.finish({
      complete: report.ready,
      preparedAt: stamp(),
      sourceStateId: scope.sourceStateId,
      requestSha256,
      provenance,
    });
    const result = {
      valid: true,
      ...report,
      reusedItems: report.capturedItems,
      captureRequests,
      sourceSnapshot: 'source-snapshot.json',
    };
    await writeNewJSON(join(output, 'coverage.json'), result);
    for (const file of records.values()) await unlink(file);
    await rmdir(spool);
    return result;
  } finally {
    await writer.dispose();
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output')
      throw fail('usage', 'arguments', 'Expected --input request.json --output NEW_DIRECTORY');
    const result = await prepareSourceSnapshot(args[1], args[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error)));
    process.exitCode = 1;
  }
}
