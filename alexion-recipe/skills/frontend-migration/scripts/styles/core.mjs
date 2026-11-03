import { detectBootstrap } from './detectors/bootstrap-detector.mjs';
import { detectSass } from './detectors/sass-detector.mjs';
import { detectTailwind } from './detectors/tailwind-detector.mjs';
import { detectCssModules } from './detectors/css-modules-detector.mjs';
import { detectCssInJs } from './detectors/css-in-js-detector.mjs';
import { detectCssVariables } from './detectors/css-variables-detector.mjs';
import { detectJSCSSImports } from './detectors/js-css-import-detector.mjs';
class StyleAnalyzer {
  /**
   * Determine the primary style system from multiple detections
   *
   * Chooses the system with highest confidence score
   *
   * @param detections - Array of detection results
   * @returns Primary system type and confidence
   */
  determinePrimarySystem(detections) {
    // Filter out zero-confidence detections (no actual detection)
    const validDetections = detections.filter((d) => d.confidence > 0);
    if (validDetections.length === 0) {
      return { type: 'none', confidence: 1.0, evidence: ['No style system detected'] };
    }
    // Sort by confidence (highest first)
    const sorted = [...validDetections].sort((a, b) => b.confidence - a.confidence);
    const primary = sorted[0];
    return {
      type: primary.type,
      confidence: primary.confidence,
      evidence: primary.evidence,
    };
  }
  /**
   * Determine secondary style systems
   *
   * Returns systems with confidence > threshold that aren't the primary
   *
   * @param detections - Array of detection results
   * @param primaryType - Primary system type to exclude
   * @param threshold - Minimum confidence threshold (default: 0.3)
   * @returns Array of secondary system types
   */
  determineSecondarySystems(detections, primaryType, threshold = 0.3) {
    return detections
      .filter((d) => d.type !== primaryType && d.confidence >= threshold)
      .map((d) => d.type);
  }
  async analyze(files) {
    // Run all detectors in parallel
    const results = await Promise.all([
      Promise.resolve(detectBootstrap(files)),
      Promise.resolve(detectSass(files)),
      Promise.resolve(detectTailwind(files)),
      Promise.resolve(detectCssModules(files)),
      Promise.resolve(detectCssInJs(files)),
      Promise.resolve(detectCssVariables(files)),
    ]);
    // Determine primary and secondary systems
    const primaryResult = this.determinePrimarySystem(results);
    const secondarySystems = this.determineSecondarySystems(results, primaryResult.type);
    // Analyze CSS files
    const cssFileAnalysis = this.analyzeCssFiles(files);
    // Aggregate entry points from all detectors
    const parseWarnings = [];
    const cssImports = this.aggregateEntryPoints(results, files, parseWarnings);
    // Build analysis result
    const analysis = {
      primarySystem: primaryResult.type,
      confidence: primaryResult.confidence,
      evidence: primaryResult.evidence,
      secondarySystems,
      configFiles: this.findConfigFiles(files),
      dependencies: this.extractDependencies(files),
      globalStyles: [],
      cssImports,
      entryPoint: null,
      cssFiles: cssFileAnalysis,
      designTokens: {
        hasDesignTokens: false,
        tokenFiles: [],
        usingCSSVariables: false,
        cssVariableCount: 0,
      },
    };
    // Store detection results for evidence display (internal use)
    analysis.detectionResults = results;
    if (parseWarnings.length > 0) analysis.parseWarnings = parseWarnings;
    return analysis;
  }
  /**
   * Analyze CSS files and categorize them
   */
  analyzeCssFiles(files) {
    const cssFiles = files.filter((f) => /\.(css|scss|sass|less)$/i.test(f.path));
    const byType = {
      plain: 0,
      modules: 0,
      sass: 0,
      less: 0,
    };
    const allFiles = cssFiles.map((f) => {
      const size = f.content.length;
      let type;
      // Categorize by type
      if (f.path.includes('.module.')) {
        byType.modules++;
        type = 'module';
      } else if (/\.s[ca]ss$/i.test(f.path)) {
        byType.sass++;
        type = 'sass';
      } else if (/\.less$/i.test(f.path)) {
        byType.less++;
        type = 'less';
      } else {
        byType.plain++;
        type = 'plain';
      }
      return { path: f.path, size, type };
    });
    // Sort by size and get largest files
    const largestFiles = [...allFiles].sort((a, b) => b.size - a.size).slice(0, 10);
    return {
      total: cssFiles.length,
      byType,
      largestFiles,
    };
  }
  /**
   * Find style-related configuration files
   */
  findConfigFiles(files) {
    const configTypes = {
      'tailwind.config': 'tailwind',
      'postcss.config': 'postcss',
      'webpack.config': 'webpack',
      'next.config': 'other',
      'vite.config': 'vite',
    };
    const configPatterns = [
      /tailwind\.config\.(js|ts|cjs|mjs)$/,
      /postcss\.config\.(js|ts|cjs|mjs)$/,
      /\.babelrc$/,
      /webpack\.config\.(js|ts)$/,
      /next\.config\.(js|ts|mjs)$/,
      /vite\.config\.(js|ts)$/,
    ];
    return files
      .filter((f) => configPatterns.some((pattern) => pattern.test(f.path)))
      .map((f) => {
        let type = 'other';
        for (const [key, value] of Object.entries(configTypes)) {
          if (f.path.includes(key)) {
            type = value;
            break;
          }
        }
        return {
          type,
          path: f.path,
          exists: true,
          size: f.size,
        };
      });
  }
  /**
   * Extract style-related dependencies from package.json
   */
  extractDependencies(files) {
    const packageJson = files.find((f) => f.path.endsWith('package.json'));
    if (!packageJson) {
      return {
        dependencies: {},
        devDependencies: {},
        peerDependencies: {},
      };
    }
    try {
      const pkg = JSON.parse(packageJson.content);
      // Filter for style-related dependencies
      const styleDepKeywords = [
        'css',
        'sass',
        'scss',
        'less',
        'style',
        'styled',
        'tailwind',
        'bootstrap',
        'emotion',
        'postcss',
        'autoprefixer',
        'clsx',
        'classnames',
      ];
      const filterStyleDeps = (deps = {}) => {
        return Object.entries(deps)
          .filter(([name]) =>
            styleDepKeywords.some((keyword) => name.toLowerCase().includes(keyword)),
          )
          .reduce((acc, [name, version]) => {
            acc[name] = version;
            return acc;
          }, {});
      };
      return {
        dependencies: filterStyleDeps(pkg.dependencies),
        devDependencies: filterStyleDeps(pkg.devDependencies),
        peerDependencies: filterStyleDeps(pkg.peerDependencies),
      };
    } catch (e) {
      return {
        dependencies: {},
        devDependencies: {},
        peerDependencies: {},
      };
    }
  }
  /**
   * Aggregate CSS entry points from all detectors and add JS imports
   *
   * @param results - Detection results from all detectors
   * @param files - Files to scan for JS imports
   * @returns Combined array of all entry points found
   */
  aggregateEntryPoints(results, files, parseWarnings) {
    const allEntryPoints = [];
    // Collect entry points from all detectors
    for (const result of results) {
      if (result.entryPoints && result.entryPoints.length > 0) {
        allEntryPoints.push(...result.entryPoints);
      }
    }
    // Add JavaScript/TypeScript CSS imports using AST parsing
    try {
      const jsImports = detectJSCSSImports(files, parseWarnings);
      allEntryPoints.push(...jsImports);
    } catch (err) {
      // AST parsing failed - log but continue
      console.warn('[StyleAnalysis] Failed to detect JS CSS imports:', err);
    }
    return allEntryPoints;
  }
}
/** Analyze ordered { path, content, size } files without filesystem access.
 * Returns Promise<StyleSystemAnalysis>, including detectionResults and cssImports.
 * Paths and input ordering are preserved verbatim.
 * Optional parseWarnings: Array<{ file: string, message: string }> reports
 * skipped files and Babel recovery errors so callers can mark scans incomplete.
 */
export function analyzeFiles(files) {
  return new StyleAnalyzer().analyze(files);
}
