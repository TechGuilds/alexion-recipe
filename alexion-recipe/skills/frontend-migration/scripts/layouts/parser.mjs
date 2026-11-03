import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import path from 'node:path';

export const traverse = (ast, visitors) => (traverseModule.default || traverseModule)(ast, { noScope: true, ...visitors });
export const sourceFile = name => /\.(?:[cm]?[jt]sx?)$/i.test(name);
export function normalizePath(file, rootPath) {
  const portable = file.replaceAll('\\', '/');
  const root = rootPath.replaceAll('\\', '/').replace(/\/$/, '');
  const relative = portable.startsWith(`${root}/`) ? portable.slice(root.length + 1) : portable;
  return path.posix.isAbsolute(relative) ? relative : `./${path.posix.normalize(relative).replace(/^\.\//, '')}`;
}

// No evaluation, filesystem reads, or application configuration execution.
export function parseSource(content, { recovery = true, filePath = '' } = {}) {
  // Angle-bracket assertions in plain TypeScript are not JSX elements.
  const plainTS = /\.[cm]?ts$/i.test(filePath);
  const typescript = ['typescript', { disallowAmbiguousJSXLike: /\.[cm]ts$/i.test(filePath) }];
  return parse(content, { sourceType: 'unambiguous', plugins: [...(plainTS ? [] : ['jsx']), typescript], errorRecovery: recovery });
}

export function parseFiles(files, { rootPath, recovery = true }) {
  const parsed = new Map();
  const parseWarnings = [];
  for (const file of files) {
    const name = normalizePath(file.path, rootPath);
    const code = sourceFile(name) ? 'JS_PARSE_ERROR' : 'JSON_PARSE_ERROR';
    const warn = error => parseWarnings.push({ file: name, code, message: error.message, ...(error.loc ? { line: error.loc.line, column: error.loc.column + 1 } : {}) });
    try {
      if (sourceFile(name)) {
        const ast = parseSource(file.content, { recovery, filePath: name });
        parsed.set(name, ast);
        for (const error of ast.errors ?? []) warn(error);
      } else if (/\.json$/i.test(name)) JSON.parse(file.content);
    } catch (error) { parsed.set(name, error); warn(error); }
  }
  return { parsed, parseWarnings };
}
