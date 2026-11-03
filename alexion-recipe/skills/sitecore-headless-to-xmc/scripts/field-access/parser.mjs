import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import path from 'node:path';

// Self-contained copy of the same parsing approach as
// frontend-migration/scripts/layouts/parser.mjs — kept separate rather than
// cross-imported so this skill packages standalone (see scaffold-resolver's
// "sibling packaging" note in assets/resolver-framework/README.md).
export const traverse = (ast, visitors) => (traverseModule.default || traverseModule)(ast, { noScope: true, ...visitors });
export const sourceFile = name => /\.(?:[cm]?[jt]sx?)$/i.test(name);

export function normalizePath(file, rootPath) {
  const portable = file.replaceAll('\\', '/');
  const root = rootPath.replaceAll('\\', '/').replace(/\/$/, '');
  const relative = portable.startsWith(`${root}/`) ? portable.slice(root.length + 1) : portable;
  return path.posix.isAbsolute(relative) ? relative : `./${path.posix.normalize(relative).replace(/^\.\//, '')}`;
}

// No evaluation, filesystem reads, or application configuration execution.
export function parseSource(content, { recovery = true } = {}) {
  return parse(content, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript'], errorRecovery: recovery });
}

export function parseFiles(files, { rootPath, recovery = true }) {
  const parsed = new Map();
  const parseWarnings = [];
  for (const file of files) {
    const name = normalizePath(file.path, rootPath);
    if (!sourceFile(name)) continue;
    const warn = error => parseWarnings.push({ file: name, code: 'JS_PARSE_ERROR', message: error.message, ...(error.loc ? { line: error.loc.line, column: error.loc.column + 1 } : {}) });
    try {
      const ast = parseSource(file.content, { recovery });
      parsed.set(file.content, ast);
      for (const error of ast.errors ?? []) warn(error);
    } catch (error) { parsed.set(file.content, error); warn(error); }
  }
  return { parsed, parseWarnings };
}
