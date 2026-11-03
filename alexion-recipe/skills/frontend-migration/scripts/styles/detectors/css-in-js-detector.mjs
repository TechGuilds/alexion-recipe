/**
 * CSS-in-JS Detector
 *
 * Detects CSS-in-JS libraries (Styled Components, Emotion, etc.) in a codebase.
 * These libraries allow writing CSS directly in JavaScript/TypeScript.
 *
 * Detection criteria:
 * 1. Package.json dependencies (styled-components, @emotion/*, etc.)
 * 2. Styled component definitions: styled.div``, styled(Component)``
 * 3. css`` tagged templates
 * 4. ThemeProvider usage
 * 5. JSS (react-jss) patterns
 *
 * @packageDocumentation
 */
/**
 * CSS-in-JS library dependencies
 */
const CSS_IN_JS_DEPENDENCIES = {
  styledComponents: ['styled-components', '@types/styled-components'],
  emotion: ['@emotion/react', '@emotion/styled', '@emotion/css', '@emotion/core'],
  jss: ['react-jss', 'jss', 'jss-preset-default'],
  stitches: ['@stitches/react', '@stitches/core'],
  linaria: ['@linaria/core', '@linaria/react'],
  vanilla: ['@vanilla-extract/css', '@vanilla-extract/webpack-plugin'],
};
/**
 * Styled Components patterns
 */
const STYLED_COMPONENTS_PATTERNS = [
  /import\s+styled\s+from\s+['"]styled-components['"]/g,
  /import\s+\{[^}]*styled[^}]*\}\s+from\s+['"]styled-components['"]/g,
  /const\s+\w+\s*=\s*styled\.\w+`/g,
  /const\s+\w+\s*=\s*styled\(\w+\)`/g,
  /styled\.\w+`[^`]*`/g,
  /styled\.\w+<[^>]+>`/g,
];
/**
 * Emotion import patterns (strict — must reference @emotion/*).
 * These alone are sufficient to count as Emotion usage.
 */
const EMOTION_IMPORT_PATTERNS = [
  /import\s+\{[^}]*css[^}]*\}\s+from\s+['"]@emotion\/react['"]/g,
  /import\s+styled\s+from\s+['"]@emotion\/styled['"]/g,
  /import\s+\{[^}]*\}\s+from\s+['"]@emotion\/(react|styled|css|core)['"]/g,
];
/**
 * Generic CSS-in-JS shape patterns. These are ambiguous on their own —
 * `css\`\`` and `css({})` are used by linaria, goober, and ad-hoc helpers too —
 * so they only count toward Emotion when the project also has an @emotion/* dep.
 */
const EMOTION_SHAPE_PATTERNS = [/css`[^`]*`/g, /css\(\{/g, /jsx\s*=\s*\{css`/g];
/**
 * JSS patterns
 */
const JSS_PATTERNS = [
  /import\s+\{[^}]*createUseStyles[^}]*\}\s+from\s+['"]react-jss['"]/g,
  /createUseStyles\(\{/g,
  /makeStyles\(\{/g,
  /useStyles\(\)/g,
];
/**
 * ThemeProvider patterns (common across libraries)
 */
const THEME_PROVIDER_PATTERNS = [/<ThemeProvider/g, /import\s+\{[^}]*ThemeProvider[^}]*\}/g];
/**
 * Template literal styling patterns
 */
const TEMPLATE_LITERAL_PATTERNS = [/styled\.\w+`[\s\S]*?`/g, /css`[\s\S]*?`/g];
/**
 * Detects CSS-in-JS library usage
 *
 * @param files - Array of file contents with paths and content
 * @returns Detection result with confidence score and evidence
 *
 * @example
 * ```typescript
 * const files = [
 *   { path: 'package.json', content: '{"dependencies": {"styled-components": "^5.3.0"}}' },
 *   { path: 'src/Button.tsx', content: 'const Button = styled.button`color: blue;`' }
 * ];
 * const result = detectCssInJs(files);
 * // result.confidence ~0.85 (high confidence for dependency + styled usage)
 * ```
 */
export function detectCssInJs(files) {
  const evidence = [];
  let dependencyScore = 0;
  let usageScore = 0;
  let themeScore = 0;
  const detectedLibraries = new Set();
  // Find package.json for dependency checking
  const packageJson = files.find((f) => f.path.endsWith('package.json'));
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      // Check for each CSS-in-JS library
      Object.entries(CSS_IN_JS_DEPENDENCIES).forEach(([libName, deps]) => {
        const foundDeps = deps.filter((dep) => dep in allDeps);
        if (foundDeps.length > 0) {
          detectedLibraries.add(libName);
          foundDeps.forEach((dep) => {
            evidence.push(`package.json: ${dep}@${allDeps[dep]}`);
          });
        }
      });
      if (detectedLibraries.size > 0) {
        dependencyScore = 0.5;
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  }
  // Check code files for CSS-in-JS patterns. Scope to JS/TS source only —
  // Razor (.cshtml) and C# (.cs) files contain the substring `css` in HTML
  // attribute names (class, css-class, etc.) and produce false positives.
  const codeFiles = files.filter((f) => /\.(jsx?|tsx?|mjs)$/.test(f.path));
  const emotionPackagePresent = detectedLibraries.has('emotion');
  let styledCount = 0;
  let emotionImportCount = 0;
  let emotionShapeCount = 0;
  let jssCount = 0;
  let themeCount = 0;
  codeFiles.forEach((file) => {
    // Styled Components patterns
    STYLED_COMPONENTS_PATTERNS.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        styledCount += matches.length;
      }
    });
    // Emotion strict imports — always count.
    EMOTION_IMPORT_PATTERNS.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        emotionImportCount += matches.length;
      }
    });
    // Emotion-shape patterns — only count when an @emotion/* dep is present.
    // Without that anchor, css``/css({}) is more likely linaria, goober, or
    // an ad-hoc helper.
    if (emotionPackagePresent) {
      EMOTION_SHAPE_PATTERNS.forEach((pattern) => {
        const matches = file.content.match(pattern);
        if (matches) {
          emotionShapeCount += matches.length;
        }
      });
    }
    // JSS patterns
    JSS_PATTERNS.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        jssCount += matches.length;
      }
    });
    // ThemeProvider patterns
    THEME_PROVIDER_PATTERNS.forEach((pattern) => {
      const matches = file.content.match(pattern);
      if (matches) {
        themeCount += matches.length;
      }
    });
  });
  const emotionCount = emotionImportCount + emotionShapeCount;
  const totalUsage = styledCount + emotionCount + jssCount;
  if (totalUsage > 0) {
    usageScore = Math.min(0.4, totalUsage * 0.02); // Cap at 0.4
    if (styledCount > 0) {
      evidence.push(`${styledCount} styled component definition(s)`);
    }
    if (emotionCount > 0) {
      const breakdown =
        emotionShapeCount > 0
          ? `${emotionImportCount} import(s), ${emotionShapeCount} tagged-template/call(s)`
          : `${emotionImportCount} import(s)`;
      evidence.push(`${emotionCount} Emotion usage(s) (${breakdown})`);
    }
    if (jssCount > 0) {
      evidence.push(`${jssCount} JSS usage(s) (createUseStyles/makeStyles)`);
    }
  }
  if (themeCount > 0) {
    themeScore = Math.min(0.1, themeCount * 0.05); // Cap at 0.1
    evidence.push(`${themeCount} ThemeProvider usage(s)`);
  }
  // Add library summary
  if (detectedLibraries.size > 0) {
    const libNames = Array.from(detectedLibraries).map((lib) => {
      switch (lib) {
        case 'styledComponents':
          return 'Styled Components';
        case 'emotion':
          return 'Emotion';
        case 'jss':
          return 'JSS';
        case 'stitches':
          return 'Stitches';
        case 'linaria':
          return 'Linaria';
        case 'vanilla':
          return 'Vanilla Extract';
        default:
          return lib;
      }
    });
    evidence.push(`Libraries: ${libNames.join(', ')}`);
  }
  // Calculate total confidence
  const confidence = Math.min(1.0, dependencyScore + usageScore + themeScore);
  return {
    type: 'styled-components',
    confidence,
    evidence,
  };
}
