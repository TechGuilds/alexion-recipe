import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readJSON, readJSONLines, scopedPath, fail, normalizeId, writeNewJSON } from './files.mjs';
import { requireSchema } from './schema.mjs';

export const contextKey = (row) =>
  [row.pageId, row.deviceId, row.language, row.version, row.instanceId].map(normalizeId).join('|');
export const fieldKey = (row) =>
  [row.fieldId, row.language ?? '', row.version ?? ''].map(normalizeId).join('|');
export const headerOf = (snapshot) =>
  Object.fromEntries(
    ['version', 'scopeId', 'instanceId', 'database', 'capturedAt', 'rootPaths', 'languages'].map((k) => [
      k,
      snapshot[k],
    ]),
  );

/** Each pass buffers at most one legacy document or one bounded JSONL record. */
export async function openSnapshot(path) {
  const { value, sha256 } = await readJSON(path);
  if (!Number.isFinite(Date.parse(value.capturedAt)))
    throw fail('timestamp', path, 'Snapshot requires a valid capture time');
  if (value.format !== 'source-snapshot-manifest') {
    requireSchema('sourceSnapshot', value);
    return {
      header: headerOf(value),
      sha256,
      manifest: null,
      async *records() {
        for (const item of value.items) yield { kind: 'item', data: item };
        for (const row of value.renderingInstances) yield { kind: 'renderingInstance', data: row };
      },
    };
  }
  requireSchema('snapshotManifest', value);
  if (!Number.isFinite(Date.parse(value.preparedAt)))
    throw fail('timestamp', path, 'Manifest requires a valid preparation time');
  requireSchema('snapshotHeader', headerOf(value));
  return {
    header: headerOf(value),
    sha256,
    manifest: value,
    async *records() {
      let itemCount = 0,
        renderingCount = 0;
      const paths = new Set(),
        ids = new Set(),
        contexts = new Set();
      for (const part of value.parts) {
        if (paths.has(part.path)) throw fail('duplicate', part.path, 'Repeated snapshot part');
        paths.add(part.path);
        if (
          part.bytes > value.maxPartBytes ||
          part.itemCount + part.renderingInstanceCount > value.maxRecordsPerPart
        )
          throw fail('part-limit', part.path, 'Snapshot part exceeds declared limits');
        await scopedPath(dirname(path), part.path);
        let items = 0,
          renderings = 0;
        for await (const record of readJSONLines(dirname(path), part, value.maxPartBytes)) {
          requireSchema('snapshotRecord', record);
          const key = record.kind === 'item' ? normalizeId(record.data.id) : contextKey(record.data);
          const seen = record.kind === 'item' ? ids : contexts;
          if (seen.has(key))
            throw fail('duplicate', part.path, 'Duplicate source record across snapshot parts');
          seen.add(key);
          if (record.kind === 'item') items++;
          else renderings++;
          if (items + renderings > value.maxRecordsPerPart)
            throw fail('part-limit', part.path, 'Actual record count exceeds the part limit');
          yield record;
        }
        if (items !== part.itemCount || renderings !== part.renderingInstanceCount)
          throw fail('part-count', part.path, 'Snapshot part counts differ');
        itemCount += items;
        renderingCount += renderings;
      }
      if (itemCount !== value.itemCount || renderingCount !== value.renderingInstanceCount)
        throw fail('snapshot-count', path, 'Snapshot total counts differ');
    },
  };
}

export async function snapshotIndex(snapshot) {
  const items = new Map(),
    contexts = [],
    seenContexts = new Set(),
    paths = new Set();
  for await (const record of snapshot.records()) {
    const data = record.data;
    if (record.kind === 'item') {
      const key = normalizeId(data.id);
      if (items.has(key)) throw fail('duplicate', 'sourceSnapshot', 'Duplicate source item');
      if (paths.has(normalizeId(data.path)))
        throw fail('duplicate', 'sourceSnapshot', 'Duplicate source path');
      paths.add(normalizeId(data.path));
      // Keep only identity/version metadata, not content values.
      items.set(key, { ...data, fields: [], references: [] });
    } else {
      const key = contextKey(data);
      if (seenContexts.has(key)) throw fail('duplicate', 'sourceSnapshot', 'Duplicate rendering context');
      seenContexts.add(key);
      contexts.push({ ...data, parameters: [] });
    }
  }
  return { items, contexts };
}

export async function createSnapshotWriter(
  directory,
  header,
  { maxPartBytes = 4 * 1024 * 1024, maxRecordsPerPart = 200 } = {},
) {
  const parts = [];
  let active,
    itemCount = 0,
    renderingInstanceCount = 0;
  const close = async () => {
    if (!active) return;
    await active.file.close();
    parts.push({
      path: active.path,
      sha256: active.digest.digest('hex'),
      bytes: active.bytes,
      itemCount: active.items,
      renderingInstanceCount: active.renderings,
    });
    active = null;
  };
  return {
    async add(record) {
      requireSchema('snapshotRecord', record);
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > maxPartBytes)
        throw fail(
          'record-size',
          'sourceSnapshot',
          'One record exceeds maxPartBytes; reduce captured fields or increase the approved limit',
        );
      if (
        active &&
        (active.bytes + bytes.length > maxPartBytes || active.items + active.renderings >= maxRecordsPerPart)
      )
        await close();
      if (!active) {
        const path = `part-${String(parts.length + 1).padStart(6, '0')}.jsonl`;
        active = {
          path,
          file: await open(join(directory, path), 'wx'),
          digest: createHash('sha256'),
          bytes: 0,
          items: 0,
          renderings: 0,
        };
      }
      await active.file.writeFile(bytes);
      active.digest.update(bytes);
      active.bytes += bytes.length;
      if (record.kind === 'item') {
        active.items++;
        itemCount++;
      } else {
        active.renderings++;
        renderingInstanceCount++;
      }
    },
    async finish(extra) {
      await close();
      const manifest = {
        ...header,
        version: 1,
        format: 'source-snapshot-manifest',
        maxPartBytes,
        maxRecordsPerPart,
        itemCount,
        renderingInstanceCount,
        parts,
        ...extra,
      };
      requireSchema('snapshotManifest', manifest);
      await writeNewJSON(join(directory, 'source-snapshot.json'), manifest);
      return manifest;
    },
    async dispose() {
      await close();
    },
  };
}
