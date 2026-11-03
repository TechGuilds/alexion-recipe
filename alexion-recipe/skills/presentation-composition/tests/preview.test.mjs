import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, guid } from './fixture.mjs';
import { buildPreview, selectPages } from '../scripts/prepare-presentation-preview.mjs';
import { verifyPreview } from '../scripts/review-presentation-preview.mjs';
import { installPresentationPreview } from '../scripts/install-presentation-preview.mjs';
import { hash, jsonBytes } from '../scripts/lib/common.mjs';

async function review(f, preview, choice = 'verified') {
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZyHAAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(join(f.base, 'browser.png'), image);
  const evidence = await f.put('browser.json', {
    scopeId: 'demo',
    pageId: guid(41),
    route: '/',
    previewManifestSha256: preview.manifest.sha256,
    status: 'rendered',
    checks: [{ name: 'Components rendered', passed: true }],
    errors: [],
    screenshot: { path: 'browser.png', sha256: hash(image) },
  });
  const decision = await f.put('decision.json', {
    id: 'preview-review',
    taskId: 'preview-review',
    kind: 'verification',
    scopeId: 'demo',
    entityId: guid(41),
    choice,
    rationale: 'Reviewed page',
    userResponse: choice === 'verified' ? 'Verified' : 'Needs review',
    at: '2026-01-01T00:00:00Z',
    inputs: [preview.manifest, evidence],
  });
  const request = await f.put('review-input.json', {
    version: 1,
    scopeId: 'demo',
    taskId: 'preview-review',
    previewInput: preview.request,
    previewManifest: preview.manifest,
    decisions: [decision],
    browserEvidence: [evidence],
  });
  return { request, evidence, decision };
}
async function foundation(f, preview) {
  const root = join(f.base, 'app');
  await mkdir(join(root, 'src'), { recursive: true });
  const layout = '<script src="/mock-preview/navigation.js" />',
    loader = 'read /mock-layouts route/index.json';
  await writeFile(join(root, 'src/layout.tsx'), layout);
  await writeFile(join(root, 'src/loader.ts'), loader);
  const proof = await f.put('foundation-check.json', { framework: 'synthetic test foundation' });
  const artifact = await f.put('foundation.json', {
    version: 1,
    scopeId: 'demo',
    targetRoot: await realpath(root),
    ready: true,
    mockEnabled: true,
    routeContract: 'single-context',
    siteName: 'target-site',
    language: 'en',
    framework: 'content-sdk',
    loader: { path: 'src/loader.ts', sha256: hash(loader) },
    layout: { path: 'src/layout.tsx', sha256: hash(layout) },
    evidence: proof,
  });
  const request = {
    version: 1,
    scopeId: 'demo',
    taskId: 'preview',
    previewInput: preview.request,
    previewManifest: preview.manifest,
    targetRoot: root,
    foundationEvidence: artifact,
  };
  return { root, request };
}
test('preview uses current target fields, preserves rendering repeats and emits navigation without source field substitution', async (t) => {
  const f = await fixture(t),
    result = await f.preview();
  assert.equal(result.report.ready, true);
  assert.equal(result.value.approved, false);
  const payload = JSON.parse(
    await readFile(join(f.base, 'preview/public/mock-layouts/home/index.json'), 'utf8'),
  );
  const rows = payload.sitecore.route.placeholders['headless-main'];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].componentName, 'Banner');
  assert.equal(rows[0].fields.Heading.value, 'Actual target banner');
  assert.equal(rows[1].fields.Heading.value, 'Actual target promo');
  assert.equal(payload.sitecore.route.fields.Title.value, 'Actual target page');
  assert.deepEqual(
    JSON.parse(await readFile(join(f.base, 'preview/public/mock-preview/routes.json'), 'utf8')),
    { routes: ['/'] },
  );
});
test('preview supports nested target placeholders rather than flattening children', async (t) => {
  const f = await fixture(t, (d) => {
    d.source.pages[0].effective[1].parentUid = guid(50);
    d.source.pages[0].effective[1].placeholder = 'inner';
    d.mapping.placeholders.push({
      source: { key: 'inner', id: guid(82) },
      target: { key: 'content', id: guid(83) },
    });
    d.target.placeholders.push({
      key: 'content',
      allowedRenderingIds: [guid(60)],
      ownerRenderingIds: [guid(60)],
    });
  });
  const preview = await f.preview();
  assert.equal(preview.report.ready, true);
  const payload = JSON.parse(
    await readFile(join(f.base, 'preview/public/mock-layouts/home/index.json'), 'utf8'),
  );
  assert.equal(
    payload.sitecore.route.placeholders['headless-main'][0].placeholders.content[0].fields.Heading.value,
    'Actual target promo',
  );
});
test('minimum pages and missing rendering/variant coverage block installation-ready output', async (t) => {
  const f = await fixture(t);
  const result = await f.preview(2);
  assert.equal(result.report.ready, false);
  await assert.rejects(access(join(f.base, 'preview/public/mock-layouts/home/index.json')));
  const other = await fixture(t, (d) =>
    d.rules.requiredCoverage.push({ renderingId: guid(60), variant: 'missing' }),
  );
  const gap = await other.preview();
  assert.equal(gap.report.ready, false);
  assert.ok(gap.value.issues.some((i) => i.code === 'coverage-gap'));
  assert.deepEqual(
    selectPages(
      [
        { route: '/a', coverage: ['a'] },
        { route: '/b', coverage: ['a', 'b'] },
      ],
      ['a', 'b'],
      1,
    ).selectedRoutes,
    ['/b'],
  );
});
test('resolver-backed components require exact captured target data and parameter binding', async (t) => {
  const f = await fixture(t, (d) => (d.target.renderings[0].dataMode = 'resolver'));
  const result = await f.preview();
  assert.equal(result.report.ready, false);
  const reads = JSON.parse(await readFile(join(f.base, 'preview/target-read-requirements.json'), 'utf8'));
  assert.equal(reads.requirements.length, 1);
  assert.equal(reads.requirements[0].datasourceId, guid(43));
  const ok = await fixture(t, (d) => {
    d.target.renderings[0].dataMode = 'resolver';
    d.targetData.resolverData = [50, 51].map((uid, index) => ({
      pageId: guid(41),
      renderingUid: guid(uid),
      renderingId: guid(60),
      datasourceId: guid(43 + index),
      parametersSha256: hash('{}'),
      fields: { Resolved: { value: 'Target resolver' } },
    }));
  });
  assert.equal((await ok.preview()).report.ready, true);
});
test('human review requires current browser evidence and coverage; pause and rejection remain blockers', async (t) => {
  for (const choice of ['verified', 'not-verified', 'pause']) {
    const f = await fixture(t),
      preview = await f.preview(),
      input = await review(f, preview, choice),
      { report } = await verifyPreview(join(f.base, input.request.path));
    assert.equal(report.ready, choice === 'verified');
    assert.equal(report.applyAuthorized, false);
    assert.equal(report.workflowAdvanced, false);
  }
});
test('rehashed forged plans, stale screenshots and changed preview files cannot pass review', async (t) => {
  const f = await fixture(t),
    preview = await f.preview(),
    input = await review(f, preview);
  await writeFile(join(f.base, 'browser.png'), 'not an image');
  await assert.rejects(verifyPreview(join(f.base, input.request.path)), /screenshot/);
  const g = await fixture(t),
    p = await g.preview(),
    r = await review(g, p);
  await writeFile(join(g.base, 'preview/public/mock-layouts/home/index.json'), '{}');
  await assert.rejects(verifyPreview(join(g.base, r.request.path)), /stage/);
  const h = await fixture(t),
    composed = await h.compose();
  const forged = structuredClone(composed.value);
  forged.pages[0].renderings = [];
  const planRef = await h.put('forged.json', forged);
  const request = await h.put('preview.json', {
    version: 1,
    scopeId: 'demo',
    compositionInput: h.inputRef,
    compositionPlan: planRef,
    minimumPages: 1,
  });
  await assert.rejects(buildPreview(join(h.base, request.path)), /canonical/);
});
test('preview app installation is plan-first, approval-bound, backed up and read back without Sitecore writes', async (t) => {
  const f = await fixture(t),
    preview = await f.preview(),
    app = await foundation(f, preview);
  await mkdir(join(app.root, 'public/mock-preview'), { recursive: true });
  await writeFile(join(app.root, 'public/mock-preview/routes.json'), '{"routes":["/old"]}');
  const first = await f.put('install-input.json', app.request);
  const planned = await installPresentationPreview(join(f.base, first.path), join(f.base, 'install-plan'));
  assert.equal(planned.installed, false);
  assert.equal(
    await readFile(join(app.root, 'public/mock-preview/routes.json'), 'utf8'),
    '{"routes":["/old"]}',
  );
  const reviewRef = {
    path: 'install-plan/preview-install-review.json',
    sha256: hash(await readFile(join(f.base, 'install-plan/preview-install-review.json'))),
  };
  const approval = await f.put('install-approval.json', {
    id: 'preview-files',
    kind: 'mutation',
    scopeId: 'demo',
    taskId: 'preview',
    choice: 'approve',
    rationale: 'Preview files only',
    userResponse: 'Approve these files',
    at: '2026-01-01T00:00:00Z',
    inputs: [reviewRef],
  });
  const next = await f.put('install-approved.json', { ...app.request, review: reviewRef, approval });
  const applied = await installPresentationPreview(join(f.base, next.path), join(f.base, 'install-result'));
  assert.equal(applied.installed, true);
  assert.equal(applied.targetSitecoreWrites, false);
  const replaced = applied.results.find((r) => r.action === 'replace');
  assert.ok(replaced.backup);
  assert.equal(await readFile(join(app.root, replaced.backup), 'utf8'), '{"routes":["/old"]}');
  assert.equal(
    JSON.parse(await readFile(join(app.root, 'public/mock-preview/routes.json'), 'utf8')).routes[0],
    '/',
  );
});
test('CLI cannot invent target execution flags and preview foundation drift blocks installation', async (t) => {
  const script = fileURLToPath(new URL('../scripts/compose-presentation.mjs', import.meta.url));
  const bad = spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const f = await fixture(t),
    preview = await f.preview(),
    app = await foundation(f, preview),
    request = await f.put('install.json', app.request);
  await writeFile(join(app.root, 'src/loader.ts'), 'changed');
  await assert.rejects(installPresentationPreview(join(f.base, request.path), join(f.base, 'out')), /drift/);
});

test('repeated large target fields stop before building oversized preview payloads', async (t) => {
  const f = await fixture(t, (d) => {
    d.source.pages[0].effective[1].datasourceId = guid(30);
    d.targetData.items[1].fields.Heading.value = 'x'.repeat(8 * 1024 * 1024);
  });
  const preview = await f.preview();
  assert.equal(preview.report.ready, false);
  assert.ok(preview.value.issues.some((row) => row.message?.includes('byte budget')));
  await assert.rejects(access(join(f.base, 'preview/public/mock-layouts/home/index.json')));
});

test('external app edits invalidate prior preview installation approval', async (t) => {
  const f = await fixture(t),
    preview = await f.preview(),
    app = await foundation(f, preview);
  const first = await f.put('install-initial.json', app.request);
  await installPresentationPreview(join(f.base, first.path), join(f.base, 'plan'));
  const ref = {
    path: 'plan/preview-install-review.json',
    sha256: hash(await readFile(join(f.base, 'plan/preview-install-review.json'))),
  };
  const approval = await f.put('approval.json', {
    id: 'install',
    kind: 'mutation',
    scopeId: 'demo',
    taskId: 'preview',
    choice: 'approve',
    rationale: 'Reviewed',
    userResponse: 'Approve',
    at: '2026-01-01T00:00:00Z',
    inputs: [ref],
  });
  await mkdir(join(app.root, 'public/mock-preview'), { recursive: true });
  await writeFile(join(app.root, 'public/mock-preview/routes.json'), 'external edit');
  const next = await f.put('install-next.json', { ...app.request, review: ref, approval });
  await assert.rejects(installPresentationPreview(join(f.base, next.path), join(f.base, 'result')), /stale/);
  assert.equal(await readFile(join(app.root, 'public/mock-preview/routes.json'), 'utf8'), 'external edit');
});
