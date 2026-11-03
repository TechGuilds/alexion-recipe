import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = 'skills/sitecore/references/discovery/';
const profile = 'skills/cms-migration/references/profiles/sitecore/pipeline/';
const files = ['skills/sitecore/SKILL.md', ...['content-analysis', 'rendering-analysis', 'layout-and-usage', 'baseline-capture', 'baseline-delivery', 'discovery-script-inventory'].map(name => `${platform}${name}.md`), ...['discovery', 'preview-readiness', 'code-migration'].map(name => `${profile}${name}.md`)];
const read = path => readFileSync(resolve(root, path), 'utf8');

test('Sitecore guidance dispatches the approved rendering preview flow and native contracts', () => {
  const skill = read('skills/sitecore/SKILL.md');
  for (const link of ['references/discovery/rendering-preview-flow.md', 'assets/contracts/README.md', 'scripts/mapping/README.md', 'scripts/preview/README.md']) assert.ok(skill.includes(link), link);
  for (const path of files.filter(path => path !== 'skills/sitecore/SKILL.md')) assert.ok(read(path).includes('rendering-preview-flow.md'), path);
});

test('inventory instructions require rendering scope without silently broadening language', () => {
  const content = read(`${platform}content-analysis.md`);
  assert.match(content, /yes\/no/i);
  assert.match(content, /RenderingRootsJson/);
  assert.match(content, /omit[^\n]*RenderingRootsJson/);
  assert.match(content, /structural[^\n]*English/i);
  assert.match(read(`${platform}rendering-analysis.md`), /Headless Variants/);
  assert.doesNotMatch(files.map(read).join('\n'), /(?:up to 25|25-route|initial sample and post-synthesis pre-warm|fetch-layouts\.mjs` once[^\n]*before the analyzers)/i);
});

test('capture guidance derives approved plans then attempts delivery in requested Discovery', () => {
  const capture = read(`${platform}baseline-capture.md`);
  for (const term of ['buildRenderingCapturePlan', 'includedRenderingIds', 'maxUrls', 'all selected', 'zero executions']) assert.ok(capture.includes(term), term);
  assert.match(capture, /failures and retries/);
  const discovery = read(`${profile}discovery.md`);
  assert.match(discovery, /Static[^\n]*parallel/i);
  assert.match(discovery, /explicit[^\n]*defer[^\n]*owner/i);
  assert.match(discovery, /draft/i);
});

test('delivery instructions preserve route identities and reviewed stage installation', () => {
  const delivery = read(`${platform}baseline-delivery.md`);
  for (const term of ['case', 'suffix', 'home/index.json', 'captureResultFiles', 'mappedLayoutFiles', 'componentExamplesFiles', '--preview-stage-sha256', 'USE_MOCK_LAYOUT_SERVICE', 'public/mock-preview', 'SitecoreAI', 'JSS']) assert.ok(delivery.includes(term), term);
  assert.doesNotMatch(delivery, /everything lowercased|spaces replaced by/);
  const preview = read(`${profile}preview-readiness.md`);
  assert.match(preview, /Discovery[^\n]*delivery/i);
  assert.match(preview, /mapping/i);
});

test('owned Sitecore workflow documents have resolvable local links', () => {
  for (const path of [...files, `${platform}rendering-preview-flow.md`, 'skills/sitecore/scripts/analysis/README.md']) {
    for (const [, link] of read(path).matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(link) || link.includes('*')) continue;
      assert.ok(existsSync(resolve(dirname(resolve(root, path)), link.split('#')[0])), `${path}: ${link}`);
    }
  }
});
