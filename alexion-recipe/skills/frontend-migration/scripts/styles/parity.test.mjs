import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeFiles } from './core.mjs';
import {
  mergeMvcStyleReferences,
  extractHeadlessStyleReferences,
  overlayHeadlessStyleReferences,
  mergeHeadlessStyleReferences,
} from './domain.mjs';
import { cases, mvcCases, headlessCases } from './fixtures/cases.mjs';

// Captured from the original TypeScript implementations before extraction.
// Compare serialized reports: optional undefined values are omitted by the CLI.
const golden = JSON.parse(
  await readFile(new URL('./fixtures/golden.json', import.meta.url), 'utf8'),
);
const serialized = (value) => JSON.parse(JSON.stringify(value));
for (const [name, files] of Object.entries(cases)) {
  test(`analyzer oracle parity: ${name}`, async () => {
    const { parseWarnings, ...analysis } = await analyzeFiles(files);
    assert.deepEqual(serialized(analysis), golden.core[name]);
  });
}
for (const [name, refs] of Object.entries(mvcCases)) {
  test(`MVC oracle parity: ${name}`, async () => {
    const base = await analyzeFiles([]);
    const before = structuredClone(base);
    assert.deepEqual(serialized(mergeMvcStyleReferences(base, refs)), golden.mvc[name]);
    assert.deepEqual(base, before);
  });
}
for (const [name, files] of Object.entries(headlessCases)) {
  test(`headless oracle parity: ${name}`, async () => {
    const refs = extractHeadlessStyleReferences(files);
    assert.deepEqual(serialized(refs), golden.headless[name].refs);
    const base = await analyzeFiles([]);
    const before = structuredClone(base);
    assert.deepEqual(
      serialized(overlayHeadlessStyleReferences(base, refs)),
      golden.headless[name].analysis,
    );
    assert.deepEqual(base, before);
  });
}
test('Babel parses multiline TSX imports with evidence and skips comments/dynamic imports', async () => {
  const result = await analyzeFiles(cases.imports);
  assert.deepEqual(
    result.cssImports.map(({ path, line }) => [path, line]),
    [
      ['./Card.module.scss', 2],
      ['./theme.css', 4],
      ['./all.less', 5],
      ['./global.css', 6],
    ],
  );
  assert.equal(result.cssImports[1].raw, "import renamed from './theme.css';");
});
test('parse failures are surfaced without discarding valid-file evidence', async () => {
  const analysis = await analyzeFiles(cases.imports);
  assert.equal(analysis.parseWarnings.length, 1);
  assert.equal(analysis.parseWarnings[0].file, 'broken.tsx');
  assert.match(analysis.parseWarnings[0].message, /Unexpected token/);
  assert.equal(analysis.cssImports.length, 4);
  assert.equal((await analyzeFiles([])).parseWarnings, undefined);
});
test('Babel recovered parse errors are surfaced with imports retained', async () => {
  const analysis = await analyzeFiles([
    { path: 'recover.ts', content: "import './site.css'; export { missing };", size: 39 },
  ]);
  assert.equal(analysis.parseWarnings[0].file, 'recover.ts');
  assert.match(analysis.parseWarnings[0].message, /not defined/);
  assert.equal(analysis.cssImports[0].path, './site.css');
});
test('parent CLI mergeHeadlessStyleReferences alias preserves overlay behavior', () => {
  assert.equal(mergeHeadlessStyleReferences, overlayHeadlessStyleReferences);
});
