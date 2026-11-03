import test from 'node:test';
import assert from 'node:assert/strict';
import { inventory } from './core.mjs';

function analyze(content, path = './Component.tsx') {
  const result = inventory([{ path, content }], { rootPath: '.' });
  return result.files[0];
}

test('detects fields.X (dot notation)', () => {
  const f = analyze(`function C() { return fields.heading; }`);
  assert.deepEqual(f.fieldAccess.map((r) => [r.field, r.pattern]), [['heading', 'fields.heading']]);
});

test("detects fields['X'] (bracket notation)", () => {
  const f = analyze(`function C() { return fields['Hat Title']; }`);
  assert.deepEqual(f.fieldAccess.map((r) => [r.field, r.pattern]), [['Hat Title', "fields['Hat Title']"]]);
});

test('detects props.fields.X (dot notation)', () => {
  const f = analyze(`function C(props) { return props.fields.title; }`);
  assert.deepEqual(f.fieldAccess.map((r) => [r.field, r.pattern]), [['title', 'props.fields.title']]);
});

test("detects props.fields['X'] (bracket notation)", () => {
  const f = analyze(`function C(props) { return props.fields['Hat Title']; }`);
  assert.deepEqual(f.fieldAccess.map((r) => [r.field, r.pattern]), [['Hat Title', "props.fields['Hat Title']"]]);
});

test('detects optional-chained field access (fields?.heading)', () => {
  const f = analyze(`function C() { return fields?.heading; }`);
  assert.equal(f.fieldAccess.length, 1);
  assert.equal(f.fieldAccess[0].field, 'heading');
  assert.equal(f.fieldAccess[0].hasOptionalChaining, true);
});

test('marks hasOptionalChaining when the child access chains, even if the fields. access itself does not', () => {
  const f = analyze(`function C() { return fields.heading?.value; }`);
  assert.equal(f.fieldAccess[0].hasOptionalChaining, true);
});

test('infers field type from the nearest member-chain suffix', () => {
  const f = analyze(`function C() { return <img src={fields.image.src} />; }`);
  assert.equal(f.fieldAccess[0].fieldType, 'src');
});

test('takes the FIRST type suffix walking outward (fields.image.value.src -> "value", not "src")', () => {
  const f = analyze(`function C() { return <img src={fields.image.value.src} />; }`);
  assert.equal(f.fieldAccess[0].fieldType, 'value');
});

test('defaults field type to other when no known suffix is present', () => {
  const f = analyze(`function C() { return fields.raw; }`);
  assert.equal(f.fieldAccess[0].fieldType, 'other');
});

test('detects GraphQL wrapping via .jsonValue', () => {
  const f = analyze(`function C() { return fields.heading.jsonValue.value; }`);
  assert.equal(f.fieldAccess[0].isGraphQLWrapped, true);
});

test('detects GraphQL wrapping via .jss', () => {
  const f = analyze(`function C() { return fields.heading.jss.value; }`);
  assert.equal(f.fieldAccess[0].isGraphQLWrapped, true);
});

test('plain field access is not GraphQL-wrapped', () => {
  const f = analyze(`function C() { return fields.heading.value; }`);
  assert.equal(f.fieldAccess[0].isGraphQLWrapped, false);
});

test('records line/column for each access', () => {
  const f = analyze(`function C() {\n  return fields.heading;\n}`);
  assert.equal(f.fieldAccess[0].line, 2);
});

test('deduplicates nothing — every access site is its own row (line matters for the Gate-1 table)', () => {
  const f = analyze(`function C() { const a = fields.heading; const b = fields.heading; }`);
  assert.equal(f.fieldAccess.length, 2);
});

test('a bare `fields` reference with no property access produces no row', () => {
  const f = analyze(`function C(fields) { return fields; }`);
  assert.equal(f.fieldAccess.length, 0);
});

// --- DAM assets (ported from dam-assets.ts) ---

test('detects .asset access on a field and records the field name', () => {
  const f = analyze(`function C() { return fields.document.asset; }`);
  assert.equal(f.damAssets.hasDamAssets, true);
  assert.deepEqual(f.damAssets.fields, ['document']);
});

test('detects .files access on a field', () => {
  const f = analyze(`function C() { return fields.document.files; }`);
  assert.equal(f.damAssets.hasDamAssets, true);
  assert.deepEqual(f.damAssets.fields, ['document']);
});

test('no DAM access reports hasDamAssets: false with an empty fields list', () => {
  const f = analyze(`function C() { return fields.heading.value; }`);
  assert.deepEqual(f.damAssets, { hasDamAssets: false, fields: [] });
});

test('.asset/.files on a plain ImageField (.value.src) is NOT flagged as DAM — regular images are not DAM usage', () => {
  const f = analyze(`function C() { return fields.image.value.src; }`);
  assert.equal(f.damAssets.hasDamAssets, false);
});

// --- Blind spots (the exact patterns data-flow-to-props.md tells the agent to read manually) ---

test('flags getFieldValue(fields, "X") as a blind spot and extracts the literal field name', () => {
  const f = analyze(`function C() { return getFieldValue(fields, 'title'); }`);
  assert.equal(f.blindSpots.length, 1);
  assert.deepEqual(f.blindSpots[0], { kind: 'getFieldValue-call', helper: 'getFieldValue', field: 'title', line: 1, column: f.blindSpots[0].column });
});

test('flags getFieldImageSrc(fields, "X") — any getField* helper, not just getFieldValue', () => {
  const f = analyze(`function C() { return getFieldImageSrc(fields, 'image'); }`);
  assert.equal(f.blindSpots[0].helper, 'getFieldImageSrc');
});

test('flags getFieldValue(props.fields, "X") the same as getFieldValue(fields, "X")', () => {
  const f = analyze(`function C(props) { return getFieldValue(props.fields, 'title'); }`);
  assert.equal(f.blindSpots.length, 1);
});

test('does not flag an unrelated getField*-named call on a non-fields argument', () => {
  const f = analyze(`function C() { return getFieldValue(other, 'title'); }`);
  assert.equal(f.blindSpots.length, 0);
});

test('flags destructured field access (const { X } = fields) and lists the destructured names', () => {
  const f = analyze(`function C() { const { Title, Image } = fields; return Title; }`);
  assert.equal(f.blindSpots.length, 1);
  assert.deepEqual(f.blindSpots[0].kind, 'fields-destructuring');
  assert.deepEqual(f.blindSpots[0].fields, ['Title', 'Image']);
});

test('flags destructured props.fields access', () => {
  const f = analyze(`function C(props) { const { Title } = props.fields; return Title; }`);
  assert.equal(f.blindSpots[0].kind, 'fields-destructuring');
});

test('flags a dynamic/computed field name (fields[variable])', () => {
  const f = analyze(`function C(name) { return fields[name]; }`);
  assert.equal(f.blindSpots.length, 1);
  assert.equal(f.blindSpots[0].kind, 'dynamic-field-name');
});

test('a computed string-literal key is a normal detected access, not a dynamic-name blind spot', () => {
  const f = analyze(`function C() { return fields['heading']; }`);
  assert.equal(f.blindSpots.length, 0);
  assert.equal(f.fieldAccess.length, 1);
});

test('a component with real field access but zero direct rows (all destructured) still surfaces the blind spot, matching the "Fields Accessed: 0 on a complex component" doc warning', () => {
  const f = analyze(`function C() { const { Title, Body, Image } = fields; return <div>{Title}</div>; }`);
  assert.equal(f.fieldAccess.length, 0);
  assert.equal(f.blindSpots.length, 1);
  assert.equal(f.blindSpots[0].fields.length, 3);
});

// --- Multi-file / parse-error handling ---

test('reports parseWarnings and parsed:false for unparseable files without failing the whole run', () => {
  const result = inventory([{ path: './Broken.tsx', content: 'function C( { return <div>' }], { rootPath: '.' });
  assert.equal(result.files[0].parsed, false);
  assert.equal(result.graphComplete, false);
  assert.ok(result.parseWarnings.length >= 1);
});

test('non-source files (e.g. .json) are excluded from the file list entirely', () => {
  const result = inventory([{ path: './data.json', content: '{}' }, { path: './C.tsx', content: 'fields.x' }], { rootPath: '.' });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, './C.tsx');
});
