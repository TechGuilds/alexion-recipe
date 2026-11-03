/**
 * Tailwind CSS Detector
 *
 * Detects Tailwind CSS usage in a codebase.
 * Useful for future Next.js migrations.
 *
 * Detection criteria:
 * 1. Package.json dependencies (tailwindcss, @tailwindcss/*, autoprefixer)
 * 2. tailwind.config.js/ts presence
 * 3. Tailwind utility class patterns in JSX
 * 4. @tailwind directives in CSS
 * 5. JIT mode indicators
 *
 * @packageDocumentation
 */
/**
 * Tailwind utility class patterns
 * These patterns are designed to avoid false positives with Bootstrap 4/5 utilities
 */
const TAILWIND_CLASS_PATTERNS = [
  // Tailwind-specific responsive variants (colon syntax is unique to Tailwind)
  /\b(sm|md|lg|xl|2xl):(flex|block|hidden|grid|inline)/,
  /\b(sm|md|lg|xl|2xl):[a-z-]+/,
  // Tailwind state variants (colon syntax)
  /\b(hover|focus|active|disabled|group-hover|group-focus|focus-within):/,
  // Dark mode (Tailwind-specific)
  /\bdark:[a-z-]+/,
  // Tailwind flex utilities (WITHOUT Bootstrap's flex- prefix for sub-properties)
  // Tailwind: flex-col, flex-row; Bootstrap: flex-column, flex-row (different)
  /\bflex-col\b/, // Tailwind uses "col", Bootstrap uses "column"
  /\bflex-(shrink|grow)-\d+\b/, // Tailwind pattern
  // Tailwind justify/items (WITHOUT Bootstrap's -content/-items suffix)
  /\bjustify-(start|end|center|between|around|evenly)\b/, // NOT justify-content-*
  /\bitems-(start|end|center|baseline|stretch)\b/, // NOT align-items-*
  // Tailwind gap/space utilities (Tailwind-specific)
  /\bgap-(x-|y-)?\d+\b/,
  /\bspace-(x|y)-\d+\b/,
  // Tailwind arbitrary values (square bracket syntax)
  /\[[^\]]+\]/,
  // Tailwind-specific sizing patterns (fractions are Tailwind)
  /\b(w|h)-\d+\/\d+\b/, // w-1/2, h-3/4, etc.
  /\b(w|h)-(screen|full|min|max|fit)\b/,
  // Tailwind color pattern with numeric suffixes (Tailwind-specific)
  /\b(text|bg|border)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
  // Tailwind typography (Bootstrap uses different class names)
  /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/,
  /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/,
  // Tailwind position utilities (standalone, not Bootstrap's position-relative pattern)
  /\b(?<!\bposition-)(absolute|relative|fixed|sticky)(?!\s)/, // NOT position-absolute
  // Tailwind inset utilities
  /\b(inset|top|right|bottom|left)-(auto|0|\d+)\b/,
  // Tailwind rounded with Tailwind-specific suffixes
  /\brounded-(none|sm|md|lg|xl|2xl|3xl|full)\b/,
  // Tailwind shadows
  /\bshadow-(sm|md|lg|xl|2xl|inner|none)\b/,
  // Tailwind opacity
  /\bopacity-\d+\b/,
  // Tailwind ring utilities (Tailwind-specific)
  /\bring(-\d+|-inset|-offset)?\b/,
  // Tailwind transform utilities
  /\b(scale|rotate|translate|skew)-(x|y)?-\d+\b/,
];
/**
 * Tailwind-specific dependencies. `autoprefixer` and `postcss` are deliberately
 * excluded — they are generic PostCSS plugins that ship with countless setups
 * (including raw SCSS pipelines) and previously caused a 50% false-positive
 * confidence score for projects that never used Tailwind.
 */
const TAILWIND_DEPENDENCIES = [
  'tailwindcss',
  '@tailwindcss/typography',
  '@tailwindcss/forms',
  '@tailwindcss/aspect-ratio',
  '@tailwindcss/line-clamp',
  '@tailwindcss/container-queries',
];
/**
 * Tailwind directive patterns in CSS files
 */
const TAILWIND_DIRECTIVES = [
  /@tailwind\s+(base|components|utilities)/g,
  /@apply\s+/g,
  /@layer\s+(base|components|utilities)/g,
  /@config\s+/g,
];
/**
 * Tailwind config file patterns
 */
const TAILWIND_CONFIG_PATTERNS = [
  /tailwind\.config\.(js|ts|cjs|mjs)$/,
  /tailwind\.config\.(js|ts)$/,
];
/**
 * Detects Tailwind CSS usage
 *
 * @param files - Array of file contents with paths and content
 * @returns Detection result with confidence score and evidence
 *
 * @example
 * ```typescript
 * const files = [
 *   { path: 'package.json', content: '{"dependencies": {"tailwindcss": "^3.0.0"}}' },
 *   { path: 'tailwind.config.js', content: 'module.exports = { content: ["./src/**"] }' },
 *   { path: 'src/Button.tsx', content: '<button className="px-4 py-2 bg-blue-500">Click</button>' }
 * ];
 * const result = detectTailwind(files);
 * // result.confidence ~0.95 (high confidence for dependency + config + utility classes)
 * ```
 */
export function detectTailwind(files) {
  const evidence = [];
  let dependencyScore = 0;
  let configScore = 0;
  let classScore = 0;
  let directiveScore = 0;
  // Find package.json for dependency checking
  const packageJson = files.find((f) => f.path.endsWith('package.json'));
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      const foundDeps = TAILWIND_DEPENDENCIES.filter((dep) => dep in allDeps);
      if (foundDeps.length > 0) {
        dependencyScore = 0.5;
        foundDeps.forEach((dep) => {
          evidence.push(`package.json: ${dep}@${allDeps[dep]}`);
        });
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  }
  // Check for Tailwind config file
  const configFile = files.find((f) =>
    TAILWIND_CONFIG_PATTERNS.some((pattern) => pattern.test(f.path)),
  );
  if (configFile) {
    configScore = 0.3;
    evidence.push(`Config file: ${configFile.path}`);
    // Check for JIT mode (Tailwind v3+ default)
    if (configFile.content.includes('mode:') || configFile.content.includes('jit')) {
      evidence.push('JIT mode detected');
    }
    // Check for custom theme configuration
    if (configFile.content.includes('theme:') && configFile.content.includes('extend:')) {
      evidence.push('Custom theme configuration');
    }
  }
  // Check for @tailwind directives in CSS files
  const cssFiles = files.filter(
    (f) => f.path.endsWith('.css') || f.path.endsWith('.scss') || f.path.endsWith('.sass'),
  );
  let directiveCount = 0;
  cssFiles.forEach((file) => {
    TAILWIND_DIRECTIVES.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        directiveCount += matches.length;
      }
    });
  });
  if (directiveCount > 0) {
    directiveScore = Math.min(0.2, directiveCount * 0.1); // Cap at 0.2
    evidence.push(`${directiveCount} Tailwind directive(s) (@tailwind/@apply/@layer)`);
  }
  // Check for Tailwind utility classes in code files
  const codeFiles = files.filter((f) => f.path.match(/\.(jsx?|tsx?|vue|svelte)$/));
  let classMatchCount = 0;
  const uniquePatterns = new Set();
  codeFiles.forEach((file) => {
    // Look for className attributes
    const classNameMatches = file.content.match(/className\s*=\s*[`"']([^`"']*)[`"']/g);
    if (classNameMatches) {
      classNameMatches.forEach((match) => {
        TAILWIND_CLASS_PATTERNS.forEach((pattern) => {
          if (pattern.test(match)) {
            classMatchCount++;
            uniquePatterns.add(pattern.source.substring(0, 20)); // Track pattern type
          }
        });
      });
    }
    // Look for clsx/classnames with Tailwind patterns
    const clsxMatches = file.content.match(/(clsx|classnames|cn)\s*\([^)]*\)/g);
    if (clsxMatches) {
      clsxMatches.forEach((match) => {
        TAILWIND_CLASS_PATTERNS.forEach((pattern) => {
          if (pattern.test(match)) {
            classMatchCount++;
          }
        });
      });
    }
  });
  if (classMatchCount > 0) {
    classScore = Math.min(0.4, classMatchCount * 0.01); // Cap at 0.4
    evidence.push(`${classMatchCount} Tailwind utility class usage(s)`);
    if (uniquePatterns.size > 5) {
      evidence.push(`Diverse utility patterns (${uniquePatterns.size} types)`);
    }
  }
  // Calculate total confidence
  let confidence = Math.min(1.0, dependencyScore + configScore + classScore + directiveScore);
  // Hard gate: a real Tailwind signal (dep, config, or @tailwind directive)
  // is required. Without one, utility-class matches alone are not enough —
  // they false-positive on Bootstrap, custom CSS, and arbitrary class names
  // that share Tailwind's vocabulary.
  const hasRealSignal = dependencyScore > 0 || configScore > 0 || directiveScore > 0;
  if (!hasRealSignal) {
    confidence = 0;
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson.content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const hasBootstrap = 'bootstrap' in allDeps || 'react-bootstrap' in allDeps;
        if (hasBootstrap) {
          evidence.push(
            'No Tailwind dependency, config, or @tailwind directive found (likely false positive from Bootstrap utilities)',
          );
        } else {
          evidence.push('No Tailwind dependency, config, or @tailwind directive found');
        }
      } catch (e) {
        evidence.push('No Tailwind dependency, config, or @tailwind directive found');
      }
    } else {
      evidence.push('No package.json found (cannot verify Tailwind installation)');
    }
  }
  // Detect Tailwind entry points (@tailwind directives in CSS files)
  const entryPoints = [];
  const cssEntryPointFiles = files.filter((f) => /\.(css|scss)$/i.test(f.path));
  for (const file of cssEntryPointFiles) {
    const lines = file.content.split('\n');
    lines.forEach((lineContent, index) => {
      // Match @tailwind directives: @tailwind base; @tailwind components; @tailwind utilities;
      const tailwindRegex = /@tailwind\s+(base|components|utilities|variants)\s*;?/g;
      let match;
      while ((match = tailwindRegex.exec(lineContent)) !== null) {
        entryPoints.push({
          type: 'tailwind',
          path: match[1], // 'base', 'components', 'utilities', or 'variants'
          file: file.path,
          line: index + 1,
          raw: match[0],
        });
      }
    });
  }
  return {
    type: 'tailwind',
    confidence,
    evidence,
    entryPoints: entryPoints.length > 0 ? entryPoints : undefined,
    summaryHints:
      entryPoints.length > 0
        ? {
            notes: [`Tailwind directives found (${entryPoints.length} directive(s))`],
          }
        : undefined,
  };
}
