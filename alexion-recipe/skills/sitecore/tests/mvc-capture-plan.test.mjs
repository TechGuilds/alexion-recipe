import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleMvcCaptures } from '../scripts/capture/assemble-mvc-captures.mjs';
import { sha256 } from '../scripts/capture/rendering-coverage.mjs';
import { processCaptureResults } from '../scripts/capture/process-capture-results.mjs';

const uid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const childUid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture(t, { hashes = true, renderings } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mvc-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const page = { route: '/Articles', itemId: '{1234}', itemPath: '/sitecore/content/Test/Home/Articles', language: 'en', requirementKeys: ['r'] };
  const body = { identity: 'rendering-variant', scope: 'approved', draft: false, selectedPages: [page], requirements: [{ key: 'r', renderingId: 'rendering-parent', variantId: 'variant-1', alternatives: [page] }] };
  const plan = { schemaVersion: 1, fingerprint: sha256(JSON.stringify(body)), ...body };
  const rawRoot = join(root, 'raw');
  mkdirSync(join(rawRoot, 'Articles'), { recursive: true });
  const inputs = {
    'page.json': { Page: { Id: page.itemId, Path: page.itemPath, Language: page.language, Name: 'Articles', FieldsJson: '{"Title":{"value":"Articles"}}' }, Renderings: renderings ?? [{ UniqueID: `{${uid}}`, ItemID: 'rendering-parent', Placeholder: '/main', Datasource: 'ds', Parameters: 'FieldNames=variant-1&Style=wide' }, { UniqueID: childUid, ItemID: 'rendering-child', Placeholder: `/main/content-{${uid}}-0`, Datasource: null }] },
    'names.json': { 'rendering-parent': 'Container', 'rendering-child': 'Text' },
    'fields.json': { ds: '{"Text":{"value":"Content"}}' },
  };
  const rawHashes = {};
  for (const [filename, value] of Object.entries(inputs)) {
    const bytes = `\uFEFF${JSON.stringify(value)}`;
    writeFileSync(join(rawRoot, 'Articles', filename), bytes);
    rawHashes[filename] = sha256(bytes);
  }
  const manifest = { selection: 'discovery-plan', capturePlanFingerprint: plan.fingerprint, language: 'en', siteName: 'test', routes: [{ route: page.route, itemId: page.itemId, itemPath: page.itemPath, language: page.language, normalized: 'Articles', ...(hashes ? { hashes: rawHashes } : {}) }] };
  const options = { rawRoot, capturePlanFile: join(root, 'plan.json'), manifestFile: join(root, 'manifest.json'), outputDir: join(root, 'layouts'), resultFile: join(root, 'result.json') };
  writeFileSync(options.capturePlanFile, JSON.stringify(plan));
  writeFileSync(options.manifestFile, JSON.stringify(manifest));
  return { root, page, plan, manifest, options, inputs };
}

test('portable MVC assembly retains nested placeholders, fields, parameters and stable IDs', (t) => {
  const f = fixture(t);
  const result = assembleMvcCaptures(f.options);
  assert.equal(result.selection, 'discovery-plan');
  assert.equal(result.capturePlanFingerprint, f.plan.fingerprint);
  assert.equal(result.successCount, 1);
  assert.equal(result.rawHashesVerified, true);
  const outcome = result.outcomes[0];
  const bytes = readFileSync(outcome.layoutFile);
  assert.equal(outcome.sha256, sha256(bytes));
  const layout = JSON.parse(bytes);
  const parent = layout.sitecore.route.placeholders.main[0];
  assert.equal(parent.uid, uid);
  assert.equal(parent.renderingId, 'rendering-parent');
  assert.deepEqual(parent.params, { FieldNames: 'variant-1', Style: 'wide' });
  assert.equal(parent.fields.Text.value, 'Content');
  assert.equal(parent.placeholders['content-0'][0].renderingId, 'rendering-child');
  assert.deepEqual(Object.keys(layout.sitecore.route.placeholders), ['main']);
  assert.deepEqual(JSON.parse(readFileSync(f.options.resultFile)), result);
  const verified = processCaptureResults({ capturePlanFile: f.options.capturePlanFile, captureResultFiles: [f.options.resultFile] });
  assert.equal(verified.report.requirements[0].status, 'captured');
  assert.throws(() => assembleMvcCaptures(f.options), /must be new/);
});

test('raw hashes are optional evidence and never claimed when absent', (t) => {
  const f = fixture(t, { hashes: false });
  const result = assembleMvcCaptures(f.options);
  assert.equal(result.successCount, 1);
  assert.equal(result.rawHashesVerified, false);
});

test('tampered inputs fail without a captured layout', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.options.rawRoot, 'Articles', 'fields.json'), '{}');
  const result = assembleMvcCaptures(f.options);
  assert.equal(result.errorCount, 1);
  assert.match(result.outcomes[0].reason, /hash mismatch/);
  assert.equal(result.outcomes[0].layoutFile, undefined);
});

test('raw page identity is checked even without raw hashes', (t) => {
  const f = fixture(t, { hashes: false });
  f.inputs['page.json'].Page.Id = 'other-item';
  writeFileSync(join(f.options.rawRoot, 'Articles', 'page.json'), JSON.stringify(f.inputs['page.json']));
  assert.match(assembleMvcCaptures(f.options).outcomes[0].reason, /ID mismatch/);
});

test('draft, stale fingerprint, unknown route, and malformed explicit caps are rejected', (t) => {
  const f = fixture(t);
  assert.throws(() => assembleMvcCaptures({ ...f.options, maxUrls: -1 }), /nonnegative/);
  assert.throws(() => assembleMvcCaptures({ ...f.options, routePlan: [{ ...f.page, route: '/unexpected' }] }), /unknown/);
  f.manifest.capturePlanFingerprint = 'stale';
  writeFileSync(f.options.manifestFile, JSON.stringify(f.manifest));
  assert.throws(() => assembleMvcCaptures(f.options), /fingerprint/);
  f.plan.draft = true;
  writeFileSync(f.options.capturePlanFile, JSON.stringify(f.plan));
  assert.throws(() => assembleMvcCaptures(f.options), /approved/);
});

test('unresolved nested placements fail instead of flattening into route placeholders', (t) => {
  const f = fixture(t, { renderings: [{ UniqueID: childUid, ItemID: 'rendering-child', Placeholder: `/main/content-{${uid}}-0` }] });
  assert.match(assembleMvcCaptures(f.options).outcomes[0].reason, /Unresolved nested/);
});

test('failed and skipped source outcomes survive assembly', (t) => {
  const f = fixture(t);
  f.manifest.routes = [];
  f.manifest.outcomes = [{ ...f.page, status: 'skipped', reason: 'Item unresolved' }];
  writeFileSync(f.options.manifestFile, JSON.stringify(f.manifest));
  const result = assembleMvcCaptures(f.options);
  assert.equal(result.successCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.outcomes[0].reason, 'Item unresolved');
});

test('MVC PowerShell helpers reject malformed/empty planned input without Sitecore calls', () => {
  const script = fileURLToPath(new URL('../scripts/capture/capture-mock-layouts.ps1', import.meta.url));
  const ps = `
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
    if($errors.Count) { throw ($errors | Out-String) }
    $fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-RoutePlan'},$true)
    Invoke-Expression $fn.Extent.Text
    $language='en'
    foreach($bad in @('broken','{}','[]','[{"route":"/a"}]','[{"route":"/../bad","itemPath":"/sitecore/a"}]','[{"route":"//host","itemPath":"/sitecore/a"}]')) {
      $rejected=$false; try { ConvertTo-RoutePlan $bad | Out-Null } catch { $rejected=$true }; if(-not $rejected) { throw "Accepted unsafe input $bad" }
    }
    $good=ConvertTo-RoutePlan '[{"route":"/Articles","itemPath":"/sitecore/content/Articles","itemId":"id","language":"en"}]'
    if($good.Count -ne 1 -or $good[0].route -cne '/Articles' -or $good[0].itemId -ne 'id') { throw 'Lost planned identity' }
  `;
  const run = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
});

test('portable copied MVC CLI assembles without workspace packages', (t) => {
  const f = fixture(t);
  const scripts = join(f.root, 'copied');
  mkdirSync(scripts);
  for (const filename of ['assemble-mvc-captures.mjs', 'mvc-layout-envelope.mjs', 'rendering-coverage.mjs']) {
    copyFileSync(fileURLToPath(new URL(`../scripts/capture/${filename}`, import.meta.url)), join(scripts, filename));
  }
  const params = join(f.root, 'params.json');
  writeFileSync(params, JSON.stringify(f.options));
  const run = spawnSync(process.execPath, [join(scripts, 'assemble-mvc-captures.mjs'), '--params', params], { encoding: 'utf8', cwd: f.root });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).successCount, 1);
});

test('recovery refuses budget inflation and unknown/stale prior receipts', (t) => {
  const f = fixture(t);
  const alternate = { ...f.page, route: '/Other', itemId: 'other', itemPath: '/sitecore/content/Other' };
  f.plan.requirements[0].alternatives.push(alternate);
  const { schemaVersion, fingerprint, ...body } = f.plan;
  f.plan.fingerprint = sha256(JSON.stringify(body));
  f.manifest.capturePlanFingerprint = f.plan.fingerprint;
  writeFileSync(f.options.capturePlanFile, JSON.stringify(f.plan));
  writeFileSync(f.options.manifestFile, JSON.stringify(f.manifest));
  const priorFile = join(f.root, 'prior.json');
  const prior = { selection: 'discovery-plan', capturePlanFingerprint: f.plan.fingerprint, totalMaxUrls: 1, outcomes: [{ ...alternate, status: 'failed', reason: 'unresolved' }] };
  writeFileSync(priorFile, JSON.stringify(prior));
  assert.throws(() => assembleMvcCaptures({ ...f.options, totalMaxUrls: 4, previousCaptureResultFiles: [priorFile] }), /overall maxUrls/);
  prior.capturePlanFingerprint = 'stale';
  writeFileSync(priorFile, JSON.stringify(prior));
  assert.throws(() => assembleMvcCaptures({ ...f.options, previousCaptureResultFiles: [priorFile] }), /approved plan/);
});

test('attempt cap includes unresolved items and zero explicitly captures all selected pages', (t) => {
  const f = fixture(t);
  f.plan.selectedPages.push({ ...f.page, route: '/Other', itemId: 'other', itemPath: '/sitecore/content/Other' });
  const { schemaVersion, fingerprint, ...body } = f.plan;
  f.plan.fingerprint = sha256(JSON.stringify(body));
  f.manifest.capturePlanFingerprint = f.plan.fingerprint;
  f.manifest.routes = [];
  f.manifest.outcomes = [{ ...f.page, status: 'failed', reason: 'Item unresolved' }];
  writeFileSync(f.options.capturePlanFile, JSON.stringify(f.plan));
  writeFileSync(f.options.manifestFile, JSON.stringify(f.manifest));
  const capped = assembleMvcCaptures({ ...f.options, maxUrls: 1 });
  assert.equal(capped.attemptedUrls, 1);
  assert.equal(capped.errorCount, 1);
  assert.deepEqual(capped.unattemptedRoutes, ['/Other']);
  const all = assembleMvcCaptures({ ...f.options, maxUrls: 0, outputDir: join(f.root, 'all'), resultFile: join(f.root, 'all.json') });
  assert.equal(all.attemptedUrls, 2);
  assert.equal(all.errorCount, 2);
});

test('output and result paths reject symbolic link ancestors', (t) => {
  const f = fixture(t);
  const target = join(f.root, 'target');
  const link = join(f.root, 'link');
  mkdirSync(target);
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit test symlinks'); return; } throw error; }
  assert.throws(() => assembleMvcCaptures({ ...f.options, outputDir: join(link, 'output') }), /symbolic links/);
  assert.throws(() => assembleMvcCaptures({ ...f.options, resultFile: join(link, 'result.json') }), /symbolic links/);
});
