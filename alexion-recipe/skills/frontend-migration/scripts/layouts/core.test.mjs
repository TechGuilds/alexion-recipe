import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cases } from './fixtures/cases.mjs';
const core = await import('./core.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('/layouts/core.mjs')) return {};
  throw error;
});
const golden = JSON.parse(await readFile(new URL('./fixtures/golden.json', import.meta.url)));
test('JSS Next.js layouts retain the React evidence without treating commented factory mappings as active', async () => {
  const files = cases.jss.files.map(file => ({ ...file,
    content: file.content.replaceAll('@sitecore-jss/sitecore-jss-react', '@sitecore-jss/sitecore-jss-nextjs')
      + (file.path.endsWith('LayoutFactory.js') ? '\n// LayoutFactory.set("example-id", layouts.UnusedLayout);' : ''),
  }));
  const result = await core.analyzeFiles(files, { framework: 'jss', rootPath: '/project' });
  assert.deepEqual(result.parseWarnings, []);
  assert.deepEqual(result.layouts.map(layout => layout.name), ['MainLayout', 'DefaultLayout']);
  assert.deepEqual(result.allPlaceholders, ['fallback', 'main']);
  assert.deepEqual(result.layoutFactory.mappings.map(mapping => mapping.layoutId), ['main-id', 'default']);
  assert.equal(result.layoutFactory.mappings[0].filePath, './src/layouts/MainLayout.jsx');
  assert.ok(result.entryPoints.some(entry => entry.path === './src/AppRoot.jsx'));
});
for (const [name, fixture] of Object.entries(cases)) {
  test(`preserves original ${name} layout and framework evidence`, async () => {
    assert.equal(typeof core.analyzeFiles, 'function', 'pure analyzer API must exist');
    const before = structuredClone(fixture.files);
    const result = await core.analyzeFiles(fixture.files, { framework: fixture.framework, rootPath: '/project' });
    assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'parseWarnings')))), golden[name]);
    assert.deepEqual(result.parseWarnings, []);
    assert.deepEqual(fixture.files, before);
  });
}
for (const framework of ['jss', 'content-sdk']) {
  test(`${framework} reports malformed JS and JSON while preserving good-file analysis and partial signals`, async () => {
    assert.equal(typeof core.analyzeFiles, 'function');
    const fixture = framework === 'jss' ? cases.jss : cases.contentSdk;
    const files = [...fixture.files,
      { path: '/project/src/Broken.tsx', content: 'export const broken = <; // react-helmet', size: 0 },
      { path: '/project/bad.json', content: '{', size: 1 },
    ];
    const result = await core.analyzeFiles(files, { framework, rootPath: '/project' });
    assert.deepEqual(result.layouts, (await core.analyzeFiles(fixture.files, { framework, rootPath: '/project' })).layouts);
    assert.equal(result.seoPatterns.usesHelmet, true);
    assert.deepEqual(result.parseWarnings.map(w => [w.file, w.code]), [['./src/Broken.tsx', 'JS_PARSE_ERROR'], ['./bad.json', 'JSON_PARSE_ERROR']]);
    assert.ok(result.parseWarnings.every(w => typeof w.message === 'string' && w.message.length));
  });
}
test('Content SDK reports recoverable parser errors and retains recovered evidence', async () => {
  assert.equal(typeof core.analyzeFiles, 'function');
  const files = [{ path: '/project/src/Layout.tsx', content: 'const x = 1; const x = 2; export function Layout(){ return <div id="recovered"/>; }' }];
  const analysis = await core.analyzeFiles(files, { framework: 'content-sdk', rootPath: '/project' });
  assert.equal(analysis.parseWarnings[0].code, 'JS_PARSE_ERROR');
  assert.equal(analysis.layouts[0].structuralElements[0].id, 'recovered');
});
test('rejects unsupported frameworks', async () => {
  assert.equal(typeof core.analyzeFiles, 'function');
  await assert.rejects(() => core.analyzeFiles([], { framework: 'other', rootPath: '/project' }), /framework/);
});
