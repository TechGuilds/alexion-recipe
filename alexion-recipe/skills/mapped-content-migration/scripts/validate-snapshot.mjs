import { dirname } from 'node:path';
import { openSnapshot } from './lib/snapshot.mjs';
import { createCoverage } from './lib/coverage.mjs';
import { readJSON, scopedPath, isMain, errorReport, fail } from './lib/files.mjs';
import { requireSchema } from './lib/schema.mjs';

export async function validateSnapshotFile(path, scope) {
  try {
    const coverage = createCoverage(scope),
      snapshot = await openSnapshot(path);
    for (const key of ['scopeId', 'instanceId', 'database'])
      if (snapshot.header[key] !== scope[key])
        throw fail('identity', key, 'Snapshot identity differs from approved scope');
    for (const key of ['rootPaths', 'languages'])
      if (JSON.stringify([...snapshot.header[key]].sort()) !== JSON.stringify([...scope[key]].sort()))
        throw fail('scope', key, 'Snapshot roots/languages differ from approved scope');
    if (!snapshot.manifest || snapshot.manifest.sourceStateId !== scope.sourceStateId)
      throw fail(
        'source-state',
        path,
        'Coverage requires a partitioned manifest bound to the approved source state',
      );
    for await (const record of snapshot.records()) coverage.add(record);
    const result = coverage.report();
    if (snapshot.manifest.complete !== result.ready)
      throw fail('coverage-flag', path, 'Snapshot complete flag disagrees with actual coverage');
    return { valid: true, ...result, errors: [] };
  } catch (error) {
    return { ...errorReport(error), ready: false };
  }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--input')
      throw fail('usage', 'arguments', 'Expected --input validation-request.json');
    const inputPath = process.argv[3],
      { value } = await readJSON(inputPath);
    requireSchema('validateSnapshotInput', value);
    const snapshotPath = await scopedPath(dirname(inputPath), value.snapshot.path),
      snapshot = await openSnapshot(snapshotPath);
    if (snapshot.sha256 !== value.snapshot.sha256)
      throw fail('hash', value.snapshot.path, 'Snapshot manifest hash differs');
    const result = await validateSnapshotFile(snapshotPath, value.scope);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error)));
    process.exitCode = 1;
  }
}
