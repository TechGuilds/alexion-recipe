// Maintainer utility: run from the repository root BEFORE changing original analyzers.
// Golden execution retains all original methods; imports are supplied in-memory.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const base = 'packages/kajoo-recipes/recipes/sitecore-migration-v2/skills/frontend-migration/scripts/layouts/';
const sources = {
  base: 'packages/kajoo-code-analysis/src/analyzers/layout-analyzer.ts',
  jss: 'packages/kajoo-sitecore/src/code/analysis/sitecore-layout-analyzer.ts',
  sdk: 'packages/kajoo-sitecore/src/code/analysis/content-sdk-layout-analyzer.ts',
  service: 'packages/kajoo-runtime/src/code-analysis/layout-analysis.service.ts',
};
function evaluate(name, dependencies = {}) {
  const source = fs.readFileSync(sources[name], 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require,exports){${output}\n})`, { console })(id => {
    if (id in dependencies) return dependencies[id];
    if (id.includes('component-map-scanner')) return {}; // unused factory-only dependency
    return require(id);
  }, exports);
  return exports;
}
function add(path, text) {
  execFileSync('apply_patch', ['*** Begin Patch\n*** Add File: ' + path + '\n' + text.trimEnd().split('\n').map(l => '+' + l).join('\n') + '\n*** End Patch\n']);
}
(async () => {
  const { cases } = await import('./fixtures/cases.mjs');
  const deps = { '@kajoo/kajoo-code-analysis': evaluate('base') };
  const { SitecoreLayoutAnalyzer } = evaluate('jss', deps);
  const { ContentSdkLayoutAnalyzer } = evaluate('sdk', deps);
  const { LayoutAnalysisService } = evaluate('service', deps);
  const service = new LayoutAnalysisService({});
  const golden = {};
  for (const [name, fixture] of Object.entries(cases)) {
    const analyzer = fixture.framework === 'jss' ? new SitecoreLayoutAnalyzer() : new ContentSdkLayoutAnalyzer();
    const analysis = await analyzer.analyze(fixture.files, '/project');
    analysis.seoPatterns = { ...service.detectSEOPatterns(fixture.files), ...analysis.seoPatterns };
    golden[name] = analyzer.normalizePaths(analysis, '/project');
  }
  add(base + 'fixtures/golden.json', JSON.stringify(golden, null, 2));
  add(base + 'fixtures/provenance.json', JSON.stringify(Object.fromEntries(Object.values(sources).map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')])), null, 2));
  console.log('Captured original TypeScript outputs for ' + Object.keys(golden).join(', '));
})();
