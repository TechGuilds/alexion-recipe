import path from 'node:path';
import { normalizePath, parseFiles, sourceFile, traverse } from './parser.mjs';

const coordinate = node => ({ line: node.loc.start.line, column: node.loc.start.column + 1 });
const nameOf = node => node?.name ?? node?.value ?? null;
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];
const key = value => `./${path.posix.normalize(value).replace(/^\.\//, '')}`;

function resolver(files, configs) {
  const names = new Set(files.map(file => file.path));
  function resolveCandidate(candidate) {
    if (candidate.startsWith('../') || path.posix.isAbsolute(candidate)) return null;
    const stem = candidate.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
    const choices = [candidate, ...(stem !== candidate ? extensions.map(ext => stem + ext) : []),
      ...extensions.map(ext => candidate + ext), ...extensions.map(ext => `${candidate}/index${ext}`)];
    return choices.map(key).find(name => names.has(name)) ?? null;
  }
  return (from, specifier) => {
    if (specifier === null) return { status: 'computed', target: null };
    if (specifier.startsWith('.')) {
      const target = resolveCandidate(path.posix.join(path.posix.dirname(from), specifier));
      return { status: target ? 'resolved' : 'unresolved', target, resolution: 'relative-file-candidate' };
    }
    const config = configs.find(c => from.startsWith(c.directory));
    if (config) {
      for (const [alias, values] of Object.entries(config.options.paths ?? {})) {
        const [prefix, suffix = ''] = alias.split('*');
        const match = alias.includes('*') ? specifier.startsWith(prefix) && specifier.endsWith(suffix) : specifier === alias;
        if (!match || !Array.isArray(values)) continue;
        const wildcard = alias.includes('*') ? specifier.slice(prefix.length, specifier.length - suffix.length || undefined) : '';
        for (const value of values) {
          if (typeof value !== 'string') continue;
          const target = resolveCandidate(path.posix.join(config.directory, config.options.baseUrl ?? '.', value.replace('*', wildcard)));
          if (target) return { status: 'resolved', target, resolution: 'tsconfig-path-candidate' };
        }
        return { status: 'unresolved', target: null, resolution: 'tsconfig-path-candidate' };
      }
      if (typeof config.options.baseUrl === 'string') {
        const target = resolveCandidate(path.posix.join(config.directory, config.options.baseUrl, specifier));
        if (target) return { status: 'resolved', target, resolution: 'base-url-candidate' };
      }
    }
    return { status: specifier.startsWith('/') ? 'unresolved' : 'external', target: null };
  };
}

function containsJSX(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') return true;
  return Object.entries(node).some(([key, value]) => key !== 'loc' && key !== 'tokens' &&
    (Array.isArray(value) ? value.some(containsJSX) : containsJSX(value)));
}

export function inventory(files, { rootPath }) {
  const input = files.map(file => ({ ...file, path: normalizePath(file.path, rootPath) }));
  const { parsed, parseWarnings } = parseFiles(input, { rootPath });
  const packages = [], configs = [], limitations = [];
  for (const file of input.filter(file => /\.json$/i.test(file.path))) {
    let data;
    try { data = JSON.parse(file.content); } catch { continue; }
    if (file.path.endsWith('/package.json')) packages.push({ file: file.path, name: data?.name ?? null,
      dependencies: data?.dependencies ?? {}, devDependencies: data?.devDependencies ?? {}, peerDependencies: data?.peerDependencies ?? {} });
    if (/\/(?:tsconfig|jsconfig)\.json$/.test(file.path)) {
      configs.push({ directory: `${path.posix.dirname(file.path)}/`, options: data?.compilerOptions ?? {} });
      if (data?.extends || data?.references) limitations.push({ file: file.path, reason: 'config-inheritance-not-resolved' });
    }
  }
  configs.sort((a, b) => b.directory.length - a.directory.length);
  const resolve = resolver(input, configs);
  const records = [], edges = [], components = [];
  for (const file of input.filter(file => sourceFile(file.path))) {
    const ast = parsed.get(file.path);
    const record = { path: file.path, imports: [], exports: [], jsxElements: [], parsed: !(ast instanceof Error) };
    records.push(record);
    if (!record.parsed) continue;
    const edge = (node, kind, specifier, bindings = []) => {
      const result = { file: file.path, kind, specifier, bindings, ...coordinate(node), ...resolve(file.path, specifier), evidence: 'static-syntax' };
      edges.push(result);
      if (kind !== 're-export') record.imports.push(result);
    };
    const exported = (node, name, local = name) => record.exports.push({ name, local, ...coordinate(node) });
    const component = (node, name) => {
      if (name && (name === 'default' || /^[A-Z]/.test(name)) && containsJSX(node)) components.push({ file: file.path, name, ...coordinate(node), evidence: 'jsx-component-candidate' });
    };
    traverse(ast, {
      ImportDeclaration({ node }) {
        edge(node, 'import', node.source.value, node.specifiers.map(s => ({ local: s.local.name, imported: nameOf(s.imported) ?? (s.type === 'ImportDefaultSpecifier' ? 'default' : '*'), typeOnly: node.importKind === 'type' || s.importKind === 'type' })));
      },
      TSImportEqualsDeclaration({ node }) {
        if (node.moduleReference.type === 'TSExternalModuleReference') edge(node, 'require', nameOf(node.moduleReference.expression), [{ local: node.id.name, imported: '*' }]);
      },
      ExportNamedDeclaration({ node }) {
        if (node.source) edge(node, 're-export', node.source.value);
        for (const s of node.specifiers) exported(s, nameOf(s.exported), nameOf(s.local));
        const declaration = node.declaration;
        if (declaration?.id) exported(declaration, nameOf(declaration.id));
        for (const d of declaration?.declarations ?? []) {
          // Babel's binding identifiers also cover destructured exports.
          const walk = n => {
            if (!n) return;
            if (n.type === 'Identifier') exported(d, n.name);
            else if (n.type === 'ObjectPattern') n.properties.forEach(p => walk(p.value ?? p.argument));
            else if (n.type === 'ArrayPattern') n.elements.forEach(walk);
            else if (n.type === 'RestElement') walk(n.argument);
            else if (n.type === 'AssignmentPattern') walk(n.left);
          };
          walk(d.id);
        }
      },
      ExportAllDeclaration({ node }) { edge(node, 're-export', node.source.value); exported(node, '*'); },
      ExportDefaultDeclaration({ node }) {
        exported(node, 'default', nameOf(node.declaration.id ?? node.declaration));
        if (!node.declaration.id) component(node.declaration, 'default');
      },
      FunctionDeclaration({ node }) { component(node, node.id?.name); },
      ClassDeclaration({ node }) { component(node, node.id?.name); },
      VariableDeclarator({ node }) { component(node, node.id?.name); },
      JSXOpeningElement({ node }) {
        const jsxName = n => n.type === 'JSXMemberExpression' ? `${jsxName(n.object)}.${jsxName(n.property)}` : n.name;
        record.jsxElements.push({ name: jsxName(node.name), ...coordinate(node) });
      },
      CallExpression({ node }) {
        const dynamic = node.callee.type === 'Import';
        const requireCall = node.callee.type === 'Identifier' && node.callee.name === 'require';
        if (dynamic || requireCall) edge(node, dynamic ? 'dynamic-import' : 'require', node.arguments[0]?.type === 'StringLiteral' ? node.arguments[0].value : null);
      },
      AssignmentExpression({ node }) {
        const left = node.left;
        if (left.type !== 'MemberExpression') return;
        if (left.object.name === 'module' && nameOf(left.property) === 'exports') exported(node, 'module.exports');
        else if (left.object.name === 'exports') exported(node, nameOf(left.property));
        else if (left.object.type === 'MemberExpression' && left.object.object.name === 'module' && nameOf(left.object.property) === 'exports') exported(node, nameOf(left.property));
      },
    });
  }
  return { files: records, components, edges, packages, parseWarnings, limitations,
    graphComplete: parseWarnings.length === 0 && limitations.length === 0 && edges.every(e => ['resolved', 'external'].includes(e.status)) };
}
