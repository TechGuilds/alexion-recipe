import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchLayouts,
  layoutEndpoint,
  parseArgs,
  processExitCode,
  parseSitemapUrls,
  scopeDiscoveredUrls,
  validateParams,
} from '../scripts/capture/fetch-layouts.mjs';

test('bounded capture consumes the connector-injected key and preserves route failures', async t => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fetch-layouts-'));
  const previousKey = process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousKey === undefined) delete process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;
    else process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
    rmSync(outputDir, { recursive: true, force: true });
  });
  process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = 'connector-secret';
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(String(url));
    if (new URL(url).searchParams.get('item') === '/missing') return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ sitecore: { route: new URL(url).searchParams.get('item') } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await fetchLayouts({
    layoutServiceUrl: 'https://cm.test',
    siteName: 'website',
    outputDir,
    routes: ['/missing', '/home'],
    maxUrls: 3,
  });
  assert.equal(result.successCount, 2, 'homepage and /home are captured');
  assert.equal(result.errorCount, 1, 'the missing route remains explicit evidence');
  assert.equal(result.maxUrlsApplied, false);
  assert.equal(seen.every(url => new URL(url).searchParams.get('sc_apikey') === 'connector-secret'), true);
  assert.ok(readFileSync(join(outputDir, 'home', 'index.json'), 'utf8').includes('/'));
});

test('partial capture remains a successful process result while zero successes fail', () => {
  assert.equal(processExitCode({ successCount: 24, errorCount: 2 }), 0);
  assert.equal(processExitCode({ successCount: 0, errorCount: 25 }), 1);
});

test('layout endpoint keeps an explicit Layout Service path and derives the JSS endpoint', () => {
  assert.equal(
    layoutEndpoint('https://cm.example.test'),
    'https://cm.example.test/sitecore/api/layout/render/jss',
  );
  assert.equal(
    layoutEndpoint('https://cm.example.test/sitecore/api/layout/render/jss/'),
    'https://cm.example.test/sitecore/api/layout/render/jss',
  );
});

test('sitemap parsing deduplicates by pathname, matching the historical collector', () => {
  const urls = parseSitemapUrls(`
    <url><loc>https://www.example.test/</loc></url>
    <url><loc>https://www.example.test/about?source=one</loc></url>
    <url><loc>https://www.example.test/about?source=two</loc></url>
  `);
  assert.deepEqual(urls, ['https://www.example.test/', 'https://www.example.test/about?source=one']);
});

test('parameter validation rejects credentials and accepts connector-safe scope', () => {
  assert.throws(
    () => validateParams({ layoutServiceUrl: 'https://cm.test', siteName: 'website', outputDir: '/evidence', apiKey: 'secret' }),
    /Credentials must not be placed in params/,
  );
  const params = validateParams({
    layoutServiceUrl: 'https://cm.test',
    siteName: 'website',
    outputDir: '/evidence/mock-layouts',
    routes: ['/home'],
  });
  assert.equal(params.language, 'en');
  assert.equal(params.startIndex, 1);
  assert.equal(params.maxUrls, 25);
  assert.equal(validateParams({
    layoutServiceUrl: 'https://cm.test',
    siteName: 'website',
    outputDir: '/evidence/mock-layouts',
    maxUrls: 0,
  }).maxUrls, undefined);
});

test('CLI requires a parameter file and exposes help without loading credentials', () => {
  assert.deepEqual(parseArgs(['--params', '/tmp/params.json']), { paramsPath: '/tmp/params.json' });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs([]), /Missing --params/);
});

test('scope metadata preserves full sitemap size and marks capped samples', () => {
  const scoped = scopeDiscoveredUrls([
    'https://cm.test/about',
    'https://cm.test/about?duplicate=1',
    'https://cm.test/contact',
  ], 'https://cm.test', 2);
  assert.deepEqual(scoped.urls.map(url => new URL(url).pathname), ['/', '/about']);
  assert.equal(scoped.discoveredUrlCount, 3);
  assert.equal(scoped.maxUrlsApplied, true);

  const complete = scopeDiscoveredUrls([
    'https://cm.test/',
    'https://cm.test/about',
  ], 'https://cm.test', undefined);
  assert.equal(complete.discoveredUrlCount, 2);
  assert.equal(complete.urls.length, 2);
  assert.equal(complete.maxUrlsApplied, false);
});


test('approved plan captures all selected pages without homepage or default 25 cap', async t => {
  const { createHash } = await import('node:crypto');
  const { processCaptureResults } = await import('../scripts/capture/process-capture-results.mjs');
  const root = mkdtempSync(join(tmpdir(), 'planned-fetch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pages = Array.from({ length: 30 }, (_, i) => ({ route: `/article-${i}`, itemId: `item-${i}`, itemPath: `/sitecore/content/Article${i}`, language: 'en', requirementKeys: [`r${i}`] }));
  const body = { identity: 'rendering-variant', scope: 'approved', draft: false, selectedPages: pages, requirements: pages.map((p, i) => ({ key: `r${i}`, renderingId: `rendering-${i}`, variantId: null, alternatives: [p] })), warnings: [] };
  const plan = { schemaVersion: 1, fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body };
  const capturePlanFile = join(root, 'plan.json'); writeFileSync(capturePlanFile, JSON.stringify(plan));
  const oldFetch = globalThis.fetch, oldKey = process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.SOURCE_SITECORE_GRAPHQL_API_KEY; else process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = oldKey; });
  process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = 'secret';
  const seen = [];
  globalThis.fetch = async url => {
    const route = new URL(url).searchParams.get('item'); seen.push(route);
    const i = Number(route.split('-').pop());
    return new Response(JSON.stringify({ sitecore: { route: { itemId: `item-${i}`, placeholders: { main: [{ renderingId: `rendering-${i}` }] } } } }));
  };
  const params = { capturePlanFile, layoutServiceUrl: 'https://cm.test', siteName: 'website', outputDir: join(root, 'full') };
  const result = await fetchLayouts(params);
  assert.equal(result.successCount, 30); assert.equal(seen.length, 30); assert.equal(seen.includes('/'), false);
  assert.equal(result.maxUrls, null); assert.equal(JSON.stringify(result).includes('secret'), false);
  const { report } = processCaptureResults({ capturePlanFile, captureResultFiles: [result.captureResultFile] });
  assert.equal(report.captured, 30);
  await assert.rejects(fetchLayouts(params), /new or empty/);
  seen.length = 0;
  const capped = await fetchLayouts({ ...params, outputDir: join(root, 'capped'), maxUrls: 3 });
  assert.equal(capped.attemptedUrls, 3); assert.equal(seen.length, 3);
  assert.equal(capped.totalMaxUrls, 3);
  const bad = { ...plan, draft: true }; writeFileSync(capturePlanFile, JSON.stringify(bad));
  await assert.rejects(fetchLayouts({ ...params, outputDir: join(root, 'bad') }), /approved/);
  assert.equal(seen.length, 3, 'invalid plans never make network requests');
});

test('plan capture retains 404 and wrong-item failures without caching them as successes', async t => {
  const { createHash } = await import('node:crypto');
  const root = mkdtempSync(join(tmpdir(), 'failed-fetch-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const page = { route: '/example', itemId: 'expected', requirementKeys: ['r'] };
  const body = { identity: 'rendering-variant', scope: 'approved', draft: false, selectedPages: [page], requirements: [{ key: 'r', renderingId: 'r', variantId: null, alternatives: [page] }] };
  const capturePlanFile = join(root, 'plan.json'); writeFileSync(capturePlanFile, JSON.stringify({ schemaVersion: 1, fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body }));
  const oldFetch = globalThis.fetch, oldKey = process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.SOURCE_SITECORE_GRAPHQL_API_KEY; else process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = oldKey; });
  process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = 'secret';
  for (const [name, response] of [['404', new Response('missing', { status: 404 })], ['wrong', new Response(JSON.stringify({ sitecore: { route: { itemId: 'other', placeholders: {} } } }))], ['missing-id', new Response(JSON.stringify({ sitecore: { route: { placeholders: {} } } }))]]) {
    globalThis.fetch = async () => response;
    const result = await fetchLayouts({ capturePlanFile, layoutServiceUrl: 'https://cm.test', siteName: 'website', outputDir: join(root, name) });
    assert.equal(result.successCount, 0); assert.equal(result.outcomes[0].status, 'failed');
    assert.equal(result.outcomes[0].itemId, 'expected');
  }
});


test('headless recovery captures only a prepared alternative and retains the failed page', async t => {
  const { fixture } = await import('./capture-fixtures.mjs');
  const { processCaptureResults } = await import('../scripts/capture/process-capture-results.mjs');
  const root = mkdtempSync(join(tmpdir(), 'recovery-fetch-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const capturePlanFile = join(root, 'plan.json'); writeFileSync(capturePlanFile, JSON.stringify(fixture()));
  const previousFetch = globalThis.fetch, previousKey = process.env.SOURCE_SITECORE_GRAPHQL_API_KEY;
  t.after(() => { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.SOURCE_SITECORE_GRAPHQL_API_KEY; else process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = previousKey; });
  process.env.SOURCE_SITECORE_GRAPHQL_API_KEY = 'secret';
  const seen = [];
  globalThis.fetch = async url => {
    const route = new URL(url).searchParams.get('item'); seen.push(route);
    if (route === '/primary') return new Response('missing', { status: 404 });
    return new Response(JSON.stringify({ sitecore: { route: { itemId: '{BBBB}', placeholders: { main: [{ renderingId: 'hero-id', params: { FieldNames: 'large' } }] } } } }));
  };
  const params = { capturePlanFile, layoutServiceUrl: 'https://cm.test', siteName: 'website' };
  const first = await fetchLayouts({ ...params, outputDir: join(root, 'first'), maxUrls: 2 });
  const recovery = processCaptureResults({ capturePlanFile, captureResultFiles: [first.captureResultFile] });
  assert.equal(recovery.nextRequest.capturePages[0].route, '/alternate');
  const second = await fetchLayouts({ ...params, ...recovery.nextRequest, outputDir: join(root, 'second') });
  assert.deepEqual(seen, ['/primary', '/alternate']);
  const final = processCaptureResults({ capturePlanFile, captureResultFiles: [first.captureResultFile, second.captureResultFile] });
  assert.equal(final.report.captured, 1); assert.equal(final.nextRequest, null);
  assert.equal(final.report.outcomes[0].reason, 'HTTP 404');
  assert.equal(final.report.outcomes.length, 2);
});
