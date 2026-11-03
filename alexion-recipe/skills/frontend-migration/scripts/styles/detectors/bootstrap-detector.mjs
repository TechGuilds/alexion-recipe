/**
 * Bootstrap Detector
 *
 * Detects Bootstrap usage in React/JavaScript applications.
 * Looks for Bootstrap class patterns, components, and dependencies.
 */
/**
 * Common Bootstrap class patterns
 */
const BOOTSTRAP_CLASS_PATTERNS = [
  // Grid system
  /\bcontainer(-fluid|-sm|-md|-lg|-xl|-xxl)?\b/,
  /\brow\b/,
  /\bcol(-\d+)?(-sm|-md|-lg|-xl|-xxl)?(-\d+)?\b/,
  // Utilities
  /\b(m|p)[trblxy]?-\d+\b/, // margin/padding utilities
  /\bd-(none|inline|block|flex|grid)\b/,
  /\btext-(left|center|right|justify|primary|secondary|success|danger|warning|info)\b/,
  /\bbg-(primary|secondary|success|danger|warning|info|light|dark)\b/,
  // Components
  /\bbtn(-primary|-secondary|-success|-danger|-warning|-info|-light|-dark|-link|-outline-\w+)?\b/,
  /\bcard(-body|-header|-footer|-title|-text)?\b/,
  /\bnavbar(-brand|-nav|-toggler|-collapse)?\b/,
  /\bmodal(-dialog|-content|-header|-body|-footer)?\b/,
  /\balert(-primary|-secondary|-success|-danger|-warning|-info)?\b/,
  /\bbadge(-primary|-secondary|-success|-danger|-warning|-info)?\b/,
  /\bform-(control|group|label|text|check)\b/,
  /\btable(-striped|-bordered|-hover|-sm)?\b/,
];
/**
 * React-Bootstrap component imports
 */
const REACT_BOOTSTRAP_IMPORTS = [
  'Button',
  'Card',
  'Modal',
  'Navbar',
  'Nav',
  'Container',
  'Row',
  'Col',
  'Alert',
  'Badge',
  'Breadcrumb',
  'Carousel',
  'Dropdown',
  'Form',
  'ListGroup',
  'Pagination',
  'Table',
  'Tabs',
  'Toast',
];
/**
 * Detect Bootstrap usage in application
 *
 * @param files - Files to analyze (JS/JSX/TS/TSX and package.json)
 * @returns Detection result with confidence and evidence
 */
export function detectBootstrap(files) {
  const evidence = [];
  let classCount = 0;
  let componentCount = 0;
  // Check package.json for Bootstrap dependencies
  const packageJson = files.find((f) => f.path.endsWith('package.json'));
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      if (allDeps['bootstrap']) {
        evidence.push(`Package dependency: bootstrap@${allDeps['bootstrap']}`);
      }
      if (allDeps['react-bootstrap']) {
        evidence.push(`Package dependency: react-bootstrap@${allDeps['react-bootstrap']}`);
        componentCount += 10; // Strong indicator
      }
      if (allDeps['reactstrap']) {
        evidence.push(`Package dependency: reactstrap@${allDeps['reactstrap']}`);
        componentCount += 10; // Strong indicator
      }
      // Supporting dependencies
      if (allDeps['jquery'] && allDeps['popper.js']) {
        evidence.push('Bootstrap peer dependencies found (jquery, popper.js)');
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  }
  // Check JS/JSX/TS/TSX files for Bootstrap usage
  const codeFiles = files.filter((f) => /\.(jsx?|tsx?)$/.test(f.path));
  for (const file of codeFiles) {
    // Check for Bootstrap CSS import
    if (/import\s+['"]bootstrap\/dist\/css\/bootstrap(\.min)?\.css['"]/.test(file.content)) {
      evidence.push('Bootstrap CSS import found');
    }
    // Check for react-bootstrap imports
    const reactBootstrapImport = file.content.match(
      /import\s+\{([^}]+)\}\s+from\s+['"]react-bootstrap['"]/,
    );
    if (reactBootstrapImport) {
      const imports = reactBootstrapImport[1].split(',').map((s) => s.trim());
      const matchedComponents = imports.filter((imp) =>
        REACT_BOOTSTRAP_IMPORTS.some((comp) => imp.includes(comp)),
      );
      if (matchedComponents.length > 0) {
        componentCount += matchedComponents.length;
        evidence.push(
          `React-Bootstrap components: ${matchedComponents.slice(0, 5).join(', ')}${matchedComponents.length > 5 ? '...' : ''}`,
        );
      }
    }
    // Check for reactstrap imports
    const reactstrapImport = file.content.match(/import\s+\{([^}]+)\}\s+from\s+['"]reactstrap['"]/);
    if (reactstrapImport) {
      componentCount += 5;
      evidence.push('Reactstrap imports found');
    }
    // Check for Bootstrap class usage in className attributes
    const classNameMatches = file.content.match(/className=["']([^"']+)["']/g);
    if (classNameMatches) {
      for (const match of classNameMatches) {
        const classes = match.match(/["']([^"']+)["']/)?.[1] || '';
        for (const pattern of BOOTSTRAP_CLASS_PATTERNS) {
          if (pattern.test(classes)) {
            classCount++;
            break; // Count once per className attribute
          }
        }
      }
    }
    // Check for Bootstrap class usage in clsx/classnames calls
    const clsxMatches = file.content.match(/clsx\(([^)]+)\)|classnames\(([^)]+)\)/g);
    if (clsxMatches) {
      for (const match of clsxMatches) {
        for (const pattern of BOOTSTRAP_CLASS_PATTERNS) {
          if (pattern.test(match)) {
            classCount++;
            break;
          }
        }
      }
    }
  }
  if (classCount > 0) {
    evidence.push(`Bootstrap classes found in ${classCount} locations`);
  }
  // Calculate confidence based on evidence
  let confidence = 0;
  // Strong indicators
  if (evidence.some((e) => e.includes('react-bootstrap') || e.includes('reactstrap'))) {
    confidence += 0.5;
  }
  if (evidence.some((e) => e.includes('Package dependency: bootstrap'))) {
    confidence += 0.3;
  }
  // Class usage
  if (classCount > 50) {
    confidence += 0.4;
  } else if (classCount > 20) {
    confidence += 0.3;
  } else if (classCount > 5) {
    confidence += 0.2;
  }
  // Component usage
  if (componentCount > 20) {
    confidence += 0.3;
  } else if (componentCount > 10) {
    confidence += 0.2;
  } else if (componentCount > 0) {
    confidence += 0.1;
  }
  confidence = Math.min(confidence, 1.0);
  // REQUIRE package.json dependency or React-Bootstrap components for high confidence
  // Bootstrap dependency OR react-bootstrap/reactstrap components are PRIMARY indicators
  const hasPackageDependency = evidence.some(
    (e) =>
      e.includes('Package dependency: bootstrap') ||
      e.includes('react-bootstrap') ||
      e.includes('reactstrap'),
  );
  if (!hasPackageDependency && componentCount === 0) {
    // No package dependency AND no React-Bootstrap components - heavily penalize
    confidence = Math.min(confidence, 0.3); // Cap at 30% confidence
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson.content);
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
        };
        const hasTailwind = 'tailwindcss' in allDeps;
        if (hasTailwind) {
          // Tailwind detected but no Bootstrap - likely false positive from shared utilities
          // Shared patterns: m-4, pt-2, container, text-left, etc.
          confidence = Math.min(confidence, 0.15); // Even lower confidence
          evidence.push(
            '⚠️  No Bootstrap dependency found (likely false positive from Tailwind utilities)',
          );
        } else {
          evidence.push('⚠️  No Bootstrap dependency or components found (low confidence)');
        }
      } catch (e) {
        evidence.push('⚠️  No Bootstrap dependency or components found (low confidence)');
      }
    } else {
      evidence.push('⚠️  No package.json found (cannot verify Bootstrap installation)');
    }
  }
  // Detect Bootstrap entry points (@import statements in SASS/SCSS files)
  const entryPoints = [];
  const styleFiles = files.filter((f) => /\.(scss|sass|css)$/i.test(f.path));
  for (const file of styleFiles) {
    const lines = file.content.split('\n');
    lines.forEach((lineContent, index) => {
      // Match Bootstrap imports: @import '~bootstrap', @import 'bootstrap/scss/bootstrap', etc.
      const importRegex = /@import\s+(?:url\()?['"]([^'"]*bootstrap[^'"]*)['"](\))?\s*;?/g;
      let match;
      while ((match = importRegex.exec(lineContent)) !== null) {
        entryPoints.push({
          type: 'import',
          path: match[1],
          file: file.path,
          line: index + 1,
          raw: match[0],
        });
      }
      // Match @use for Dart Sass
      const useRegex = /@use\s+['"]([^'"]*bootstrap[^'"]*)['"](?:\s+as\s+\w+)?;?/g;
      while ((match = useRegex.exec(lineContent)) !== null) {
        entryPoints.push({
          type: 'use',
          path: match[1],
          file: file.path,
          line: index + 1,
          raw: match[0],
        });
      }
    });
  }
  return {
    type: 'bootstrap',
    confidence,
    evidence,
    entryPoints: entryPoints.length > 0 ? entryPoints : undefined,
    summaryHints:
      entryPoints.length > 0
        ? {
            warnings: [
              `Bootstrap imported via SASS (${entryPoints.length} location(s)) - requires migration`,
            ],
          }
        : undefined,
    metadata: {
      classUsageCount: classCount,
      componentUsageCount: componentCount,
    },
  };
}
