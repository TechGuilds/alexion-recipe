import { normalizePath, parseFiles, sourceFile, traverse } from './parser.mjs';

const coordinate = node => ({ line: node.loc.start.line, column: node.loc.start.column + 1 });
const FIELD_TYPES = ['value', 'src', 'files', 'editable', 'href', 'text'];

// Preserves the field-access and DAM-analysis contract used by this skill.
// detectors/{field-access,dam-assets}.ts. Same four field-access shapes,
// same GraphQL-wrapping/field-type inference, same DAM (.asset/.files)
// detection — plus OptionalMemberExpression (fields?.heading), which the
// original's MemberExpression-only visitor missed, and explicit blind-spot
// flags for the exact patterns data-flow-to-props.md already tells the
// agent to fall back to manual reading for (getFieldValue(fields,'X') calls,
// `fields` destructuring, dynamic/computed field names) — turning a purely
// manual reminder into something this report can actually point at.

function isFieldsIdentifier(node) {
  return node?.type === 'Identifier' && node.name === 'fields';
}
function isPropsFieldsAccess(node) {
  return (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression')
    && node.object?.type === 'Identifier' && node.object.name === 'props'
    && node.property?.type === 'Identifier' && node.property.name === 'fields' && !node.computed;
}

/** Matches fields.X / fields['X'] / props.fields.X / props.fields['X'], dot or optional-chained. */
function fieldNameFromAccess(node) {
  const onFields = isFieldsIdentifier(node.object);
  const onPropsFields = isPropsFieldsAccess(node.object);
  if (!onFields && !onPropsFields) return null;
  const prefix = onFields ? 'fields' : 'props.fields';
  if (node.property?.type === 'Identifier' && !node.computed) {
    return { field: node.property.name, pattern: `${prefix}.${node.property.name}` };
  }
  if (node.property?.type === 'StringLiteral' && node.computed) {
    return { field: node.property.value, pattern: `${prefix}['${node.property.value}']` };
  }
  return null;
}

function fieldTypeAndWrap(path) {
  let isGraphQLWrapped = false;
  let fieldType;
  let current = path;
  while (current.parentPath) {
    const node = current.parentPath.node;
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && node.property?.type === 'Identifier') {
      const propName = node.property.name;
      if (propName === 'jsonValue' || propName === 'jss') isGraphQLWrapped = true;
      if (!fieldType && FIELD_TYPES.includes(propName)) fieldType = propName;
    }
    current = current.parentPath;
  }
  return { isGraphQLWrapped, fieldType: fieldType ?? 'other' };
}

/** getFieldValue(fields, 'X', ...) / getFieldValue(props.fields, 'X', ...) — string-arg helper calls the member-expression walk can't see into. */
function getFieldValueBlindSpot(node) {
  if (node.callee?.type !== 'Identifier' || !node.callee.name.startsWith('getField')) return null;
  const [fieldsArg, nameArg] = node.arguments;
  const onFields = isFieldsIdentifier(fieldsArg) || isPropsFieldsAccess(fieldsArg);
  if (!onFields) return null;
  return { kind: 'getFieldValue-call', helper: node.callee.name, field: nameArg?.type === 'StringLiteral' ? nameArg.value : null, ...coordinate(node) };
}

/** const { X } = fields / const { X } = props.fields — destructured access the member-expression walk can't see into. */
function destructuringBlindSpot(node) {
  const init = node.init;
  if (node.id?.type !== 'ObjectPattern' || !(isFieldsIdentifier(init) || isPropsFieldsAccess(init))) return null;
  const names = node.id.properties.filter((p) => p.type === 'ObjectProperty' && p.key?.type === 'Identifier').map((p) => p.key.name);
  return { kind: 'fields-destructuring', fields: names, ...coordinate(node) };
}

/** fields[dynamicExpr] / props.fields[dynamicExpr] — computed access with a non-literal key. */
function dynamicKeyBlindSpot(node) {
  const onFields = isFieldsIdentifier(node.object) || isPropsFieldsAccess(node.object);
  if (!onFields || !node.computed || node.property?.type === 'StringLiteral') return null;
  return { kind: 'dynamic-field-name', ...coordinate(node) };
}

function analyzeFile(ast) {
  const fieldAccess = [];
  const damAssets = { hasDamAssets: false, fields: [] };
  const blindSpots = [];

  traverse(ast, {
    'MemberExpression|OptionalMemberExpression'(path) {
      const { node } = path;
      const match = fieldNameFromAccess(node);
      if (match) {
        const hasOptionalChaining = node.type === 'OptionalMemberExpression' || path.parentPath?.node?.type === 'OptionalMemberExpression';
        const { isGraphQLWrapped, fieldType } = fieldTypeAndWrap(path);
        fieldAccess.push({ field: match.field, pattern: match.pattern, hasOptionalChaining, isGraphQLWrapped, fieldType, ...coordinate(node) });
        return;
      }
      // DAM asset access: X.asset / X.files where X is itself a fields.Y access (ported from dam-assets.ts).
      if (node.property?.type === 'Identifier' && (node.property.name === 'asset' || node.property.name === 'files')) {
        damAssets.hasDamAssets = true;
        if ((node.object.type === 'MemberExpression' || node.object.type === 'OptionalMemberExpression') && node.object.property?.type === 'Identifier') {
          const fieldName = node.object.property.name;
          if (!damAssets.fields.includes(fieldName)) damAssets.fields.push(fieldName);
        }
      }
      const dynamic = dynamicKeyBlindSpot(node);
      if (dynamic) blindSpots.push(dynamic);
    },
    CallExpression(path) {
      const hit = getFieldValueBlindSpot(path.node);
      if (hit) blindSpots.push(hit);
    },
    VariableDeclarator(path) {
      const hit = destructuringBlindSpot(path.node);
      if (hit) blindSpots.push(hit);
    },
  });

  return { fieldAccess, damAssets, blindSpots };
}

export function inventory(files, { rootPath }) {
  const input = files.map((file) => ({ ...file, path: normalizePath(file.path, rootPath) }));
  const { parsed, parseWarnings } = parseFiles(input, { rootPath });
  const records = [];
  for (const file of input.filter((f) => sourceFile(f.path))) {
    const ast = parsed.get(file.content);
    const record = { path: file.path, parsed: !(ast instanceof Error), fieldAccess: [], damAssets: { hasDamAssets: false, fields: [] }, blindSpots: [] };
    records.push(record);
    if (!record.parsed) continue;
    Object.assign(record, analyzeFile(ast));
  }
  return { files: records, parseWarnings, graphComplete: parseWarnings.length === 0 };
}
