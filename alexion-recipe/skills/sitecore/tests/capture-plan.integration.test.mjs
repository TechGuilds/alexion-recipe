import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareCaptureRequest } from '../scripts/capture/prepare-capture-request.mjs';
import { processCaptureResults } from '../scripts/capture/process-capture-results.mjs';
import { sha256 } from '../scripts/capture/rendering-coverage.mjs';
import { fixture, layout } from './capture-fixtures.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'v3-capture-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capturePlanFile = join(dir, 'plan.json'); writeFileSync(capturePlanFile, JSON.stringify(fixture()));
  return { dir, capturePlanFile };
}
test('requests preserve exact MVC identity and explicit headless caps with no route fallback', (t) => {
  const { dir, capturePlanFile } = setup(t);
  const options = { capturePlanFile, outputDir: join(dir, 'layouts'), layoutServiceUrl: 'https://source/layout', siteName: 'Site' };
  assert.equal(prepareCaptureRequest(options).maxUrls, undefined);
  assert.equal(prepareCaptureRequest({ ...options, maxUrls: 0 }).maxUrls, undefined);
  assert.equal(prepareCaptureRequest({ ...options, maxUrls: 1 }).maxUrls, 1);
  assert.deepEqual(prepareCaptureRequest({ ...options, mode: 'mvc' }).routePlan, fixture().requirements[0].alternatives.slice(0, 1));
  assert.equal(prepareCaptureRequest({ ...options, mode: 'mvc' }).selection, 'discovery-plan');
  assert.equal(prepareCaptureRequest({ ...options, mode: 'mvc' }).capturePlanFingerprint, fixture().fingerprint);
  assert.throws(() => prepareCaptureRequest({ ...options, routes: ['/extra'] }), /mixed/);
  assert.throws(() => prepareCaptureRequest({ ...options, apiKey: 'secret' }), /Credentials/);
  assert.throws(() => prepareCaptureRequest({ ...options, capturePages: [{ route: '/other' }] }), /approved/);
  mkdirSync(options.outputDir); writeFileSync(join(options.outputDir, 'existing'), 'data');
  assert.throws(() => prepareCaptureRequest(options), /new or empty/);
});
test('processor reads declared route-owned hash-verified evidence only and retains lineage budget', (t) => {
  const { dir, capturePlanFile } = setup(t);
  const outputDir = join(dir, 'layouts'); mkdirSync(join(outputDir, 'primary'), { recursive: true });
  const layoutFile = join(outputDir, 'primary', 'index.json'); const bytes = JSON.stringify(layout()); writeFileSync(layoutFile, bytes);
  const resultFile = join(dir, 'result.json');
  const result = { capturePlanFingerprint: fixture().fingerprint, selection: 'discovery-plan', totalMaxUrls: 1, outputDir, outcomes: [{ route: '/primary', status: 'captured', layoutFile, sha256: sha256(bytes) }] };
  writeFileSync(resultFile, JSON.stringify(result));
  const processed = processCaptureResults({ capturePlanFile, captureResultFiles: [resultFile] });
  assert.equal(processed.report.captured, 1); assert.equal(processed.report.recovery.totalMaxUrls, 1);
  writeFileSync(layoutFile, JSON.stringify(layout({ variant: 'wrong' })));
  assert.throws(() => processCaptureResults({ capturePlanFile, captureResultFiles: [resultFile] }), /SHA256/);
  result.outcomes[0].layoutFile = join(dir, 'unrelated.json'); writeFileSync(resultFile, JSON.stringify(result));
  assert.throws(() => processCaptureResults({ capturePlanFile, captureResultFiles: [resultFile] }), /path/);
});
test('copied helpers execute using only native Node, with exclusive output files', (t) => {
  const { dir, capturePlanFile } = setup(t);
  const source = join(dirname(fileURLToPath(import.meta.url)), '../scripts/capture');
  const portable = join(dir, 'portable'); mkdirSync(portable);
  for (const file of ['prepare-capture-request.mjs', 'process-capture-results.mjs', 'rendering-coverage.mjs']) cpSync(join(source, file), join(portable, file));
  const params = join(dir, 'params.json'), request = join(dir, 'request.json');
  writeFileSync(params, JSON.stringify({ capturePlanFile, outputDir: join(dir, 'layouts') }));
  const run = () => spawnSync(process.execPath, [join(portable, 'prepare-capture-request.mjs'), '--params', params, '--output', request], { encoding: 'utf8', cwd: dir });
  assert.equal(run().status, 0); assert.equal(JSON.parse(readFileSync(request)).capturePlanFile, capturePlanFile);
  assert.notEqual(run().status, 0);
  const layouts = join(dir, 'failed-layouts'); mkdirSync(layouts);
  const resultFile = join(dir, 'failed.json'); writeFileSync(resultFile, JSON.stringify({ capturePlanFingerprint: fixture().fingerprint, selection: 'discovery-plan', outputDir: layouts, outcomes: [{ route: '/primary', status: 'failed', reason: 'network failed' }] }));
  writeFileSync(params, JSON.stringify({ capturePlanFile, captureResultFiles: [resultFile], outputDir: join(dir, 'reports') }));
  const processed = spawnSync(process.execPath, [join(portable, 'process-capture-results.mjs'), '--params', params], { encoding: 'utf8', cwd: dir });
  assert.equal(processed.status, 0, processed.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'reports', 'next-capture-request.json'))).capturePages[0].route, '/alternate');
});
test('recovery lineage prevents dropping history or enlarging the original overall budget', (t) => {
  const { dir, capturePlanFile } = setup(t);
  const outputDir = join(dir, 'layouts'); mkdirSync(outputDir);
  const first = join(dir, 'first.json'), second = join(dir, 'second.json');
  const base = { capturePlanFingerprint: fixture().fingerprint, selection: 'discovery-plan', outputDir, totalMaxUrls: 1 };
  writeFileSync(first, JSON.stringify({ ...base, outcomes: [{ route: '/primary', status: 'failed' }] }));
  assert.throws(() => prepareCaptureRequest({ capturePlanFile, outputDir: join(dir, 'next'), capturePages: [fixture().requirements[0].alternatives[1]], maxUrls: 1, totalMaxUrls: 100, previousCaptureResultFiles: [first] }), /overall/);
  writeFileSync(second, JSON.stringify({ ...base, previousCaptureResultFiles: [first], outcomes: [{ route: '/alternate', status: 'failed' }] }));
  assert.throws(() => processCaptureResults({ capturePlanFile, captureResultFiles: [second] }), /every previous/);
  assert.throws(() => processCaptureResults({ capturePlanFile, captureResultFiles: [first, second], maxUrls: 100 }), /overall/);
});
test('processor verifies explicit mapping bytes before using their page-local UIDs', (t) => {
  const { dir, capturePlanFile } = setup(t);
  const outputDir = join(dir, 'layouts'); mkdirSync(join(outputDir, 'primary'), { recursive: true });
  const captured = layout(); delete captured.sitecore.route.placeholders.root[0].placeholders.main[0].renderingId;
  const bytes = JSON.stringify(captured), layoutFile = join(outputDir, 'primary', 'index.json'); writeFileSync(layoutFile, bytes);
  const resultFile = join(dir, 'result.json'); writeFileSync(resultFile, JSON.stringify({ capturePlanFingerprint: fixture().fingerprint, selection: 'discovery-plan', outputDir, outcomes: [{ route: '/primary', status: 'captured', layoutFile, sha256: sha256(bytes) }] }));
  const mappingInventoryFile = join(dir, 'mapping.json');
  const inventory = { requirements: [{ renderingId: 'hero-id', variantId: 'large', sourceOccurrences: [{ route: '/primary', itemId: '{AAAA}', language: 'en', instanceId: 'u1' }] }], renderings: [{ renderingId: 'unused-id', path: '/sitecore/layout/Unused', usage: { status: 'unused' } }] };
  const mappingBytes = JSON.stringify(inventory); writeFileSync(mappingInventoryFile, mappingBytes);
  const options = { capturePlanFile, captureResultFiles: [resultFile], mappingInventoryFile, mappingInventorySha256: sha256(mappingBytes) };
  const processed = processCaptureResults(options);
  assert.equal(processed.report.captured, 1); assert.equal(processed.report.mappingOnlyDefinitions[0].renderingId, 'unused-id');
  assert.throws(() => processCaptureResults({ ...options, mappingInventorySha256: '0'.repeat(64) }), /SHA256/);
  const stale = JSON.stringify({ ...inventory, sourceDiscoveryFingerprint: 'stale' }); writeFileSync(mappingInventoryFile, stale);
  assert.throws(() => processCaptureResults({ ...options, mappingInventorySha256: sha256(stale) }), /source discovery/);
});
test('skipped manifests retain diagnostics without consuming cumulative network budget', (t) => {
  const { dir, capturePlanFile } = setup(t);
  const outputDir = join(dir, 'layouts'); mkdirSync(outputDir);
  const resultFile = join(dir, 'skipped.json'); writeFileSync(resultFile, JSON.stringify({ capturePlanFingerprint: fixture().fingerprint, selection: 'discovery-plan', totalMaxUrls: 1, outputDir, outcomes: [{ route: '/primary', status: 'skipped', reason: 'not attempted' }] }));
  const processed = processCaptureResults({ capturePlanFile, captureResultFiles: [resultFile] });
  assert.equal(processed.report.outcomes.length, 1); assert.equal(processed.nextRequest.capturePages[0].route, '/primary');
  assert.equal(prepareCaptureRequest({ ...processed.nextRequest, outputDir: join(dir, 'resumed') }).capturePages[0].route, '/primary');
});
