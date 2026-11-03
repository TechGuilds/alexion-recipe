/**
 * SASS/SCSS Detector
 *
 * Detects SASS/SCSS preprocessor usage in a codebase.
 * Optimized for organized SASS folder structures (Feature/Foundation/Project).
 *
 * Detection criteria:
 * 1. Package.json dependencies (sass, node-sass, sass-loader)
 * 2. .scss/.sass files present
 * 3. SASS imports (@import, @use, @forward)
 * 4. SASS features (variables, mixins, nesting)
 * 5. Organized folder structure (Feature/, Foundation/, Project/)
 *
 * @packageDocumentation
 */
/**
 * SASS-specific import patterns
 */
const SASS_IMPORT_PATTERNS = [
  /@import\s+['"][^'"]+['"]/g, // @import "path"
  /@use\s+['"][^'"]+['"]/g, // @use "path"
  /@forward\s+['"][^'"]+['"]/g, // @forward "path"
  /@import\s+['"][^'"]+['"]\s+as\s+\w+/g, // @use "path" as name
];
/**
 * SASS-specific feature patterns
 */
const SASS_FEATURE_PATTERNS = [
  /\$[\w-]+\s*:/g, // Variables: $primary-color: #fff
  /@mixin\s+[\w-]+/g, // Mixins: @mixin button-style
  /@include\s+[\w-]+/g, // Include mixin: @include button-style
  /@function\s+[\w-]+/g, // Functions: @function calculate-rem
  /@extend\s+[.%][\w-]+/g, // Extend: @extend .btn
  /@if\s+/g, // Conditionals: @if $theme == dark
  /@each\s+/g, // Loops: @each $color in $colors
  /@for\s+/g, // For loops: @for $i from 1 through 10
  /&[\s:.\[\-]/g, // Nesting with parent: &:hover, &.active
];
/**
 * Common SASS package dependencies
 */
const SASS_DEPENDENCIES = [
  'sass',
  'node-sass',
  'sass-loader',
  'dart-sass',
  'fibers', // Often used with node-sass for performance
];
/**
 * Common organized SASS folder structures
 * (matches patterns like assets/styling/{Feature,Foundation,Project})
 */
const SASS_FOLDER_PATTERNS = [
  /[\\/](Feature|Features)[\\/]/i,
  /[\\/](Foundation|Foundations|Base)[\\/]/i,
  /[\\/](Project|Projects|Theme|Themes)[\\/]/i,
  /[\\/](Component|Components)[\\/]/i,
  /[\\/](Layout|Layouts)[\\/]/i,
  /[\\/](Utility|Utilities|Utils)[\\/]/i,
  /[\\/](Mixin|Mixins)[\\/]/i,
  /[\\/](Variable|Variables)[\\/]/i,
  /[\\/]styles?[\\/]/i,
  /[\\/]scss[\\/]/i,
  /[\\/]sass[\\/]/i,
];
/**
 * Detects SASS/SCSS preprocessor usage
 *
 * @param files - Array of file contents with paths and content
 * @returns Detection result with confidence score and evidence
 *
 * @example
 * ```typescript
 * const files = [
 *   { path: 'package.json', content: '{"dependencies": {"sass": "^1.50.0"}}' },
 *   { path: 'src/styles/main.scss', content: '$primary: #007bff; .btn { color: $primary; }' }
 * ];
 * const result = detectSass(files);
 * // result.confidence ~0.9 (high confidence for sass dependency + .scss files + SASS features)
 * ```
 */
export function detectSass(files) {
  const evidence = [];
  let dependencyScore = 0;
  let fileScore = 0;
  let importScore = 0;
  let featureScore = 0;
  let structureScore = 0;
  // Find package.json for dependency checking
  const packageJson = files.find((f) => f.path.endsWith('package.json'));
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      const foundDeps = SASS_DEPENDENCIES.filter((dep) => dep in allDeps);
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
  // Filter SASS/SCSS files
  const sassFiles = files.filter((f) => f.path.endsWith('.scss') || f.path.endsWith('.sass'));
  if (sassFiles.length > 0) {
    fileScore = Math.min(0.3, sassFiles.length * 0.05); // Cap at 0.3
    evidence.push(`Found ${sassFiles.length} SASS file(s)`);
    // Check for main entry points
    const mainFiles = sassFiles.filter((f) =>
      f.path.match(/[\\/](index|main|app|global|styles)\.(scss|sass)$/i),
    );
    if (mainFiles.length > 0) {
      evidence.push(`Main SASS entry: ${mainFiles[0].path}`);
      structureScore += 0.05;
    }
    // Analyze SASS file contents
    let importCount = 0;
    let featureCount = 0;
    const structureFolders = new Set();
    sassFiles.forEach((file) => {
      // Count imports
      SASS_IMPORT_PATTERNS.forEach((pattern) => {
        const matches = file.content.match(pattern);
        if (matches) {
          importCount += matches.length;
        }
      });
      // Count SASS features
      SASS_FEATURE_PATTERNS.forEach((pattern) => {
        const matches = file.content.match(pattern);
        if (matches) {
          featureCount += matches.length;
        }
      });
      // Check folder structure
      SASS_FOLDER_PATTERNS.forEach((pattern) => {
        if (pattern.test(file.path)) {
          const match = file.path.match(pattern);
          if (match) {
            structureFolders.add(match[0]);
          }
        }
      });
    });
    if (importCount > 0) {
      importScore = Math.min(0.2, importCount * 0.02); // Cap at 0.2
      evidence.push(`${importCount} SASS import(s) (@import/@use/@forward)`);
    }
    if (featureCount > 0) {
      featureScore = Math.min(0.3, featureCount * 0.01); // Cap at 0.3
      evidence.push(`${featureCount} SASS feature(s) (variables/mixins/nesting)`);
    }
    if (structureFolders.size > 0) {
      structureScore += Math.min(0.15, structureFolders.size * 0.05); // Cap at 0.15
      evidence.push(`Organized structure: ${Array.from(structureFolders).join(', ')}`);
    }
  }
  // Calculate total confidence
  const confidence = Math.min(
    1.0,
    dependencyScore + fileScore + importScore + featureScore + structureScore,
  );
  // Detect SASS entry points (@import, @use, @forward statements)
  const entryPoints = [];
  const sassEntryPointFiles = files.filter((f) => /\.(scss|sass)$/i.test(f.path));
  for (const file of sassEntryPointFiles) {
    const lines = file.content.split('\n');
    lines.forEach((lineContent, index) => {
      // Match @import statements (but exclude Bootstrap-specific, handled by bootstrap-detector)
      const importRegex = /@import\s+(?:url\()?['"]([^'"]+)['"](\))?\s*;?/g;
      let match;
      while ((match = importRegex.exec(lineContent)) !== null) {
        // Only include non-Bootstrap imports to avoid duplication
        if (!match[1].includes('bootstrap')) {
          entryPoints.push({
            type: 'import',
            path: match[1],
            file: file.path,
            line: index + 1,
            raw: match[0],
          });
        }
      }
      // Match @use statements
      const useRegex = /@use\s+['"]([^'"]+)['"](?:\s+as\s+\w+)?;?/g;
      while ((match = useRegex.exec(lineContent)) !== null) {
        if (!match[1].includes('bootstrap')) {
          entryPoints.push({
            type: 'use',
            path: match[1],
            file: file.path,
            line: index + 1,
            raw: match[0],
          });
        }
      }
      // Match @forward statements
      const forwardRegex = /@forward\s+['"]([^'"]+)['"]\s*;?/g;
      while ((match = forwardRegex.exec(lineContent)) !== null) {
        if (!match[1].includes('bootstrap')) {
          entryPoints.push({
            type: 'forward',
            path: match[1],
            file: file.path,
            line: index + 1,
            raw: match[0],
          });
        }
      }
    });
  }
  return {
    type: 'sass',
    confidence,
    evidence,
    entryPoints: entryPoints.length > 0 ? entryPoints : undefined,
  };
}
