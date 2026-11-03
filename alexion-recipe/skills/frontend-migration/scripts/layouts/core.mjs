import { SitecoreLayoutAnalyzer } from './jss.mjs';
import { ContentSdkLayoutAnalyzer } from './content-sdk.mjs';
import { normalizePath, parseFiles, parseSource } from './parser.mjs';

// Static text signals retain the original service's SEO evidence, even for
// malformed files. parseWarnings separately identifies incomplete AST evidence.
function seo(files) {
  const text = files.map(file => file.content).join('\n');
  return {
    usesHelmet: /react-helmet|<Helmet/i.test(text),
    hasCanonicalUrl: /canonical|rel=['"]canonical['"]/i.test(text),
    hasOpenGraphTags: /og:|property=['"]og:/i.test(text),
    hasStructuredData: /application\/ld\+json|schema\.org/i.test(text),
    hasRobotsMeta: /robots|noindex|nofollow/i.test(text),
  };
}

export async function analyzeFiles(files, { framework, rootPath }) {
  if (!['jss', 'content-sdk'].includes(framework)) throw new Error('Unsupported framework');
  if (typeof rootPath !== 'string' || !rootPath) throw new Error('rootPath is required');
  const input = files.map(file => ({ ...file, path: normalizePath(file.path, rootPath) }));
  const { parsed, parseWarnings } = parseFiles(input, { rootPath, recovery: framework === 'content-sdk' });
  const analyzer = framework === 'jss' ? new SitecoreLayoutAnalyzer() : new ContentSdkLayoutAnalyzer();
  analyzer.normalizePath = file => normalizePath(file, rootPath);
  analyzer.parseToAST = (content, filePath) => {
    const key = normalizePath(filePath, rootPath);
    if (!parsed.has(key)) parsed.set(key, parseSource(content, { filePath, recovery: framework === 'content-sdk' }));
    const ast = parsed.get(key);
    if (ast instanceof Error) throw ast;
    return ast;
  };
  const result = await analyzer.analyze(input, rootPath);
  result.seoPatterns = { ...seo(input), ...result.seoPatterns };
  return { ...analyzer.normalizePaths(result, rootPath), parseWarnings };
}
