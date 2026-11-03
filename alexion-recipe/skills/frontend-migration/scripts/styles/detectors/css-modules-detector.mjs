/**
 * CSS Modules Detector
 *
 * Detects CSS Modules usage in a codebase.
 * CSS Modules provide scoped CSS by transforming class names at build time.
 *
 * Detection criteria:
 * 1. .module.css/.module.scss/.module.sass files present
 * 2. Import patterns: import styles from './Component.module.css'
 * 3. Usage patterns: className={styles.button}
 * 4. Build tool configuration (webpack css-loader, Next.js, Vite)
 *
 * @packageDocumentation
 */
/**
 * CSS Modules file patterns
 */
const CSS_MODULE_FILE_PATTERNS = [
  /\.module\.css$/,
  /\.module\.scss$/,
  /\.module\.sass$/,
  /\.module\.less$/,
];
/**
 * CSS Modules import patterns
 */
const CSS_MODULE_IMPORT_PATTERNS = [
  /import\s+\w+\s+from\s+['"][^'"]*\.module\.(css|scss|sass|less)['"]/g,
  /import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*\.module\.(css|scss|sass|less)['"]/g,
  /require\s*\(\s*['"][^'"]*\.module\.(css|scss|sass|less)['"]\s*\)/g,
];
/**
 * CSS Modules usage patterns in JSX/TSX
 * Looks for styles.* or className={styles.*}
 */
const CSS_MODULE_USAGE_PATTERNS = [
  /className\s*=\s*\{\s*styles\.\w+/g,
  /className\s*=\s*\{`[^`]*\$\{styles\.\w+\}/g,
  /className\s*=\s*\{\s*clsx\([^)]*styles\./g,
  /className\s*=\s*\{\s*classnames\([^)]*styles\./g,
  /\bstyles\.\w+/g, // General styles.* access
];
/**
 * Build tool configurations that indicate CSS Modules support
 */
const CSS_MODULES_BUILD_CONFIG = {
  webpack: [/css-loader/, /modules:\s*true/, /modules:\s*\{/],
  nextjs: [
    /next\.config\.(js|ts|mjs)/,
    // Next.js has CSS Modules built-in
  ],
  vite: [
    /vite\.config\.(js|ts)/,
    /\.module\.css/, // Vite has CSS Modules built-in
  ],
};
/**
 * Detects CSS Modules usage
 *
 * @param files - Array of file contents with paths and content
 * @returns Detection result with confidence score and evidence
 *
 * @example
 * ```typescript
 * const files = [
 *   { path: 'src/Button.module.css', content: '.button { color: blue; }' },
 *   { path: 'src/Button.tsx', content: 'import styles from "./Button.module.css"; <button className={styles.button}>' }
 * ];
 * const result = detectCssModules(files);
 * // result.confidence ~0.9 (high confidence for .module.css files + imports + usage)
 * ```
 */
export function detectCssModules(files) {
  const evidence = [];
  let fileScore = 0;
  let importScore = 0;
  let usageScore = 0;
  let configScore = 0;
  // Check for .module.css files
  const moduleFiles = files.filter((f) =>
    CSS_MODULE_FILE_PATTERNS.some((pattern) => pattern.test(f.path)),
  );
  if (moduleFiles.length > 0) {
    fileScore = Math.min(0.4, moduleFiles.length * 0.1); // Cap at 0.4
    evidence.push(`Found ${moduleFiles.length} CSS Module file(s)`);
    // Track file types
    const cssCount = moduleFiles.filter((f) => f.path.endsWith('.module.css')).length;
    const scssCount = moduleFiles.filter((f) => f.path.endsWith('.module.scss')).length;
    const sassCount = moduleFiles.filter((f) => f.path.endsWith('.module.sass')).length;
    if (cssCount > 0) evidence.push(`${cssCount} .module.css file(s)`);
    if (scssCount > 0) evidence.push(`${scssCount} .module.scss file(s)`);
    if (sassCount > 0) evidence.push(`${sassCount} .module.sass file(s)`);
  }
  // Check for CSS Modules import patterns in code files
  const codeFiles = files.filter((f) => f.path.match(/\.(jsx?|tsx?)$/));
  let importCount = 0;
  codeFiles.forEach((file) => {
    CSS_MODULE_IMPORT_PATTERNS.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        importCount += matches.length;
      }
    });
  });
  if (importCount > 0) {
    importScore = Math.min(0.3, importCount * 0.05); // Cap at 0.3
    evidence.push(`${importCount} CSS Module import(s)`);
  }
  // Check for CSS Modules usage patterns (styles.className)
  let usageCount = 0;
  const stylesObjectUsed = new Set();
  codeFiles.forEach((file) => {
    CSS_MODULE_USAGE_PATTERNS.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        usageCount += matches.length;
        // Extract styles object name (usually 'styles', but could be different)
        matches.forEach((match) => {
          const objectMatch = match.match(/(\w+)\.\w+/);
          if (objectMatch) {
            stylesObjectUsed.add(objectMatch[1]);
          }
        });
      }
    });
  });
  if (usageCount > 0) {
    usageScore = Math.min(0.3, usageCount * 0.01); // Cap at 0.3
    evidence.push(`${usageCount} CSS Module usage(s) (styles.className)`);
    if (stylesObjectUsed.size > 1) {
      evidence.push(`Multiple import names: ${Array.from(stylesObjectUsed).join(', ')}`);
    }
  }
  // Check for build tool configuration
  const configFiles = files.filter(
    (f) =>
      f.path.match(/webpack\.config\.(js|ts)/) ||
      f.path.match(/next\.config\.(js|ts|mjs)/) ||
      f.path.match(/vite\.config\.(js|ts)/),
  );
  configFiles.forEach((file) => {
    if (file.path.includes('webpack')) {
      if (CSS_MODULES_BUILD_CONFIG.webpack.some((pattern) => pattern.test(file.content))) {
        configScore = 0.2;
        evidence.push('Webpack css-loader with modules: true');
      }
    } else if (file.path.includes('next.config')) {
      configScore = 0.1; // Next.js has built-in CSS Modules support
      evidence.push('Next.js (built-in CSS Modules support)');
    } else if (file.path.includes('vite.config')) {
      configScore = 0.1; // Vite has built-in CSS Modules support
      evidence.push('Vite (built-in CSS Modules support)');
    }
  });
  // Calculate total confidence
  const confidence = Math.min(1.0, fileScore + importScore + usageScore + configScore);
  return {
    type: 'css-modules',
    confidence,
    evidence,
  };
}
