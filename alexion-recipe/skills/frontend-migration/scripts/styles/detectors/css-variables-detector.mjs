/**
 * CSS Variables (Custom Properties) Detector
 *
 * Detects CSS custom properties (--variables) usage in a codebase.
 * CSS Variables provide native design token support.
 *
 * Detection criteria:
 * 1. CSS variable definitions: --primary-color: #007bff
 * 2. CSS variable usage: var(--primary-color)
 * 3. :root or theme files with organized variables
 * 4. Design token patterns (color, spacing, typography)
 *
 * @packageDocumentation
 */
/**
 * CSS variable definition pattern
 */
const CSS_VARIABLE_DEFINITION_PATTERN = /--[\w-]+\s*:/g;
/**
 * CSS variable usage pattern
 */
const CSS_VARIABLE_USAGE_PATTERN = /var\s*\(\s*--[\w-]+/g;
/**
 * Common CSS variable naming patterns for design tokens
 */
const DESIGN_TOKEN_PATTERNS = {
  color:
    /--(?:color|bg|background|text|border|primary|secondary|accent|success|error|warning|info)-/gi,
  spacing: /--(?:space|spacing|margin|padding|gap|inset)-/gi,
  typography: /--(?:font|text|heading|body|size|weight|line-height)-/gi,
  sizing: /--(?:width|height|size|max|min)-/gi,
  shadow: /--(?:shadow|elevation)-/gi,
  radius: /--(?:radius|rounded|border-radius)-/gi,
  timing: /--(?:duration|timing|transition|animation)-/gi,
  zIndex: /--(?:z-index|layer|stack)-/gi,
};
/**
 * Common theme file patterns
 */
const THEME_FILE_PATTERNS = [
  /[\\/](theme|themes)[\\/]/i,
  /[\\/](variable|variables)[\\/]/i,
  /[\\/](token|tokens)[\\/]/i,
  /[\\/]variables\.(css|scss|sass)$/i,
  /[\\/]theme\.(css|scss|sass)$/i,
  /[\\/]tokens\.(css|scss|sass)$/i,
  /[\\/]:root\./i,
];
/**
 * :root selector pattern (where CSS variables are typically defined)
 */
const ROOT_SELECTOR_PATTERN = /:root\s*\{/g;
/**
 * Detects CSS custom properties (variables) usage
 *
 * @param files - Array of file contents with paths and content
 * @returns Detection result with confidence score and evidence
 *
 * @example
 * ```typescript
 * const files = [
 *   { path: 'src/styles/variables.css', content: ':root { --primary-color: #007bff; }' },
 *   { path: 'src/Button.css', content: '.button { color: var(--primary-color); }' }
 * ];
 * const result = detectCssVariables(files);
 * // result.confidence ~0.8 (high confidence for variable definitions + usage)
 * ```
 */
export function detectCssVariables(files) {
  const evidence = [];
  let definitionScore = 0;
  let usageScore = 0;
  let themeScore = 0;
  let tokenScore = 0;
  // Filter CSS/SCSS/SASS files
  const styleFiles = files.filter((f) => f.path.match(/\.(css|scss|sass)$/));
  // Track variable definitions and usage
  let definitionCount = 0;
  let usageCount = 0;
  let rootSelectorCount = 0;
  const uniqueVariables = new Set();
  const tokenCategories = new Set();
  styleFiles.forEach((file) => {
    // Count variable definitions
    const definitions = file.content.match(CSS_VARIABLE_DEFINITION_PATTERN);
    if (definitions) {
      definitionCount += definitions.length;
      definitions.forEach((def) => {
        // Extract variable name: "--primary-color:" -> "primary-color"
        const varName = def.match(/--[\w-]+/)?.[0];
        if (varName) {
          uniqueVariables.add(varName);
        }
      });
    }
    // Count variable usage
    const usage = file.content.match(CSS_VARIABLE_USAGE_PATTERN);
    if (usage) {
      usageCount += usage.length;
    }
    // Count :root selectors
    const rootSelectors = file.content.match(ROOT_SELECTOR_PATTERN);
    if (rootSelectors) {
      rootSelectorCount += rootSelectors.length;
    }
    // Detect design token categories
    Object.entries(DESIGN_TOKEN_PATTERNS).forEach(([category, pattern]) => {
      if (pattern.test(file.content)) {
        tokenCategories.add(category);
      }
    });
    // Check if this is a theme/token file
    if (THEME_FILE_PATTERNS.some((pattern) => pattern.test(file.path))) {
      themeScore = 0.2;
      evidence.push(`Theme file: ${file.path}`);
    }
  });
  // Check code files for CSS variable usage in inline styles or style props
  const codeFiles = files.filter((f) => f.path.match(/\.(jsx?|tsx?)$/));
  codeFiles.forEach((file) => {
    const inlineUsage = file.content.match(CSS_VARIABLE_USAGE_PATTERN);
    if (inlineUsage) {
      usageCount += inlineUsage.length;
    }
  });
  // Calculate scores
  if (definitionCount > 0) {
    definitionScore = Math.min(0.4, definitionCount * 0.02); // Cap at 0.4
    evidence.push(`${definitionCount} CSS variable definition(s)`);
    evidence.push(`${uniqueVariables.size} unique variable(s)`);
  }
  if (usageCount > 0) {
    usageScore = Math.min(0.3, usageCount * 0.01); // Cap at 0.3
    evidence.push(`${usageCount} var() usage(s)`);
  }
  if (rootSelectorCount > 0) {
    evidence.push(`${rootSelectorCount} :root selector(s)`);
  }
  if (tokenCategories.size > 0) {
    tokenScore = Math.min(0.3, tokenCategories.size * 0.05); // Cap at 0.3
    const categories = Array.from(tokenCategories).join(', ');
    evidence.push(`Design token categories: ${categories}`);
  }
  // Check for organized structure (multiple theme files)
  const themeFileCount = styleFiles.filter((f) =>
    THEME_FILE_PATTERNS.some((pattern) => pattern.test(f.path)),
  ).length;
  if (themeFileCount > 1) {
    evidence.push(`${themeFileCount} theme/token file(s)`);
  }
  // Calculate total confidence
  const confidence = Math.min(1.0, definitionScore + usageScore + themeScore + tokenScore);
  return {
    type: 'plain-css',
    confidence,
    evidence,
  };
}
