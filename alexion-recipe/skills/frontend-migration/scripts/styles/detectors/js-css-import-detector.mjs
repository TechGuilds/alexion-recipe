/**
 * JavaScript/TypeScript CSS Import Detector
 *
 * Uses Babel AST to robustly detect CSS imports in JS/TS files.
 * More reliable than regex as it handles:
 * - Multi-line imports
 * - Comments
 * - String concatenation
 * - Side-effect imports
 */
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
// Babel traverse is CommonJS; native Node ESM exposes its exports object.
const traverse = traverseModule.default ?? traverseModule;
/**
 * Detect CSS imports in JavaScript/TypeScript files using AST parsing
 *
 * @param files - JS/TS files to scan
 * @returns Array of CSS import statements found
 */
export function detectJSCSSImports(files, parseWarnings = []) {
  const imports = [];
  const jsFiles = files.filter(
    (f) => /\.(js|jsx|ts|tsx|mts|cts|mjs|cjs)$/i.test(f.path) && !f.path.includes('node_modules'),
  );
  for (const file of jsFiles) {
    try {
      // Parse with Babel (supports modern JS/TS)
      const ast = parse(file.content, {
        sourceType: 'module',
        plugins: [...(/\.[cm]?ts$/i.test(file.path) ? [] : ['jsx']),
          ['typescript', { disallowAmbiguousJSXLike: /\.[cm]ts$/i.test(file.path) }],
          'decorators-legacy', 'classProperties', 'objectRestSpread'],
        errorRecovery: true, // Continue parsing even with errors
      });
      for (const error of ast.errors ?? []) {
        parseWarnings.push({ file: file.path, message: error.message });
      }
      // Traverse AST and find ImportDeclaration nodes
      traverse(ast, {
        ImportDeclaration(path) {
          const importPath = path.node.source.value;
          // Check if importing a CSS file
          if (/\.(css|scss|sass|less)$/i.test(importPath)) {
            const line = path.node.loc?.start.line || 1;
            // Reconstruct the import statement
            let raw = `import '${importPath}';`;
            if (path.node.specifiers.length > 0) {
              const specifiers = path.node.specifiers
                .map((spec) => {
                  if (spec.type === 'ImportDefaultSpecifier') {
                    return spec.local.name;
                  }
                  return spec.local.name;
                })
                .join(', ');
              raw = `import ${specifiers} from '${importPath}';`;
            }
            imports.push({
              type: 'js-import',
              path: importPath,
              file: file.path,
              line,
              raw,
            });
          }
        },
      });
    } catch (err) {
      parseWarnings.push({
        file: file.path,
        message: err instanceof Error ? err.message : String(err),
      });
      // Parse error - skip this file
      // Could be non-JS content, syntax errors, etc.
      continue;
    }
  }
  return imports;
}
