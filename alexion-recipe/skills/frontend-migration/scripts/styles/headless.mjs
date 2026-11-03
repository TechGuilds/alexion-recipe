/**
 * Headless (JSS / Content SDK / Next.js) JSX/TSX scanner for the three
 * cross-cutting `StyleSystemAnalysis` fields that the filesystem-only
 * scanner cannot see:
 *
 *   - `externalStylesheets[]` — `<link rel="stylesheet" href="…">`
 *   - `serverInjectedBodyClasses[]` — `<body className={…}>` expressions
 *   - `dynamicStyleAttributes[]` — JSX `style={…}` attributes
 *
 * The extractor is pure (in-memory `{ path, content }` files in,
 * structured findings out). File collection lives in the
 * `xpheadless2sai-migration-handler` so this module stays trivially
 * testable.
 *
 * The MVC equivalent is `merge-mvc-style-references.ts`; this file
 * mirrors its origin-classification and license-suspect heuristics so
 * that the resulting shape is uniform across migration flavors.
 */
// ── Regex patterns ─────────────────────────────────────────────────────
const LINK_TAG_RE = /<link\b([^>]*?)\/?>/gi;
const REL_STYLESHEET_RE = /\brel\s*=\s*["']stylesheet["']/i;
const HREF_LITERAL_RE = /\bhref\s*=\s*["']([^"']+)["']/i;
const BODY_OPEN_RE = /<body\b([^>]*)>/gi;
// Allow one nested level of braces so template literals like `${cond}` parse.
const CLASSNAME_EXPR_RE = /\bclassName\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/i;
const STYLE_ATTR_RE =
  /<([A-Za-z][A-Za-z0-9_.-]*)\b[^>]*?\bstyle\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gi;
const STRING_LITERAL_RE = /['"`]([^'"`\n]+)['"`]/g;
const PROPS_DOT_RE = /\bprops\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/;
// ── Classification helpers ─────────────────────────────────────────────
export function classifyHeadlessOrigin(href) {
  if (/^https?:\/\//i.test(href)) return 'cdn';
  if (
    href.startsWith('/') ||
    href.startsWith('~/') ||
    href.startsWith('./') ||
    href.startsWith('../')
  ) {
    return 'same-origin';
  }
  return 'unknown';
}
export function isHeadlessLicenseSuspected(href) {
  return (
    /kit\.fontawesome\.com/i.test(href) || /\/pro\//i.test(href) || /licens(?:e|ing)/i.test(href)
  );
}
/**
 * Extract the largest static string literal from a JSX expression. Used
 * to populate `BodyClassInjection.className` when a `className={…}`
 * expression contains a literal portion (e.g. `` `base ${cond}` `` →
 * `'base'`). Returns `undefined` when no literal is present so the
 * caller can fall back to the verbatim expression.
 */
function extractStaticClassName(expression) {
  // Drop template interpolations so they don't masquerade as literals.
  const stripped = expression.replace(/\$\{[^}]*\}/g, '');
  let best;
  STRING_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = STRING_LITERAL_RE.exec(stripped)) !== null) {
    const candidate = m[1].trim();
    if (!candidate) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best;
}
/**
 * Best-effort viewmodel-property hint: if the expression references
 * `props.X.Y.Z`, return the leaf segment (`Z`). Matches the MVC
 * correlator's leaf-first preference so the two flows surface the same
 * shape downstream.
 */
function extractViewmodelProperty(expression) {
  const m = PROPS_DOT_RE.exec(expression);
  if (!m) return undefined;
  const path = m[1].split('.');
  return path[path.length - 1];
}
// ── Main extractor ─────────────────────────────────────────────────────
export function extractHeadlessStyleReferences(files) {
  const externalStylesheets = [];
  const serverInjectedBodyClasses = [];
  const dynamicStyleAttributes = [];
  for (const { path, content } of files) {
    // 1. <link rel="stylesheet" href="…">
    LINK_TAG_RE.lastIndex = 0;
    let lm;
    while ((lm = LINK_TAG_RE.exec(content)) !== null) {
      const attrs = lm[1];
      if (!REL_STYLESHEET_RE.test(attrs)) continue;
      const hrefMatch = HREF_LITERAL_RE.exec(attrs);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      const ref = {
        href,
        origin: classifyHeadlessOrigin(href),
        foundIn: { file: path, kind: 'jsx-link' },
      };
      if (isHeadlessLicenseSuspected(href)) {
        ref.licenseSuspected = true;
      }
      externalStylesheets.push(ref);
    }
    // 2. <body className={…}>
    BODY_OPEN_RE.lastIndex = 0;
    let bm;
    while ((bm = BODY_OPEN_RE.exec(content)) !== null) {
      const attrs = bm[1];
      const cn = CLASSNAME_EXPR_RE.exec(attrs);
      if (!cn) continue;
      const expression = cn[1].trim();
      if (!expression) continue;
      const staticPortion = extractStaticClassName(expression);
      serverInjectedBodyClasses.push({
        className: staticPortion ?? expression,
        expression,
        foundIn: path,
      });
    }
    // 3. <TAG style={…}>
    STYLE_ATTR_RE.lastIndex = 0;
    let sm;
    while ((sm = STYLE_ATTR_RE.exec(content)) !== null) {
      const tag = sm[1];
      const expression = sm[2].trim();
      if (!expression) continue;
      // 1-based line — count newlines before the match start.
      let line = 1;
      for (let i = 0; i < sm.index; i++) {
        if (content.charCodeAt(i) === 10) line++;
      }
      const attr = {
        tag,
        expression,
        foundIn: { file: path, line },
      };
      const vmp = extractViewmodelProperty(expression);
      if (vmp) attr.viewmodelProperty = vmp;
      dynamicStyleAttributes.push(attr);
    }
  }
  return {
    externalStylesheets,
    serverInjectedBodyClasses,
    dynamicStyleAttributes,
  };
}
/**
 * Overlay headless JSX findings onto a base `StyleSystemAnalysis` from
 * the filesystem scanner. Cross-cutting fields are omitted (not set to
 * `[]`) when the extractor returned nothing, preserving the optional-
 * field contract on `StyleSystemAnalysis`.
 */
export function overlayHeadlessStyleReferences(base, refs) {
  const next = { ...base };
  const evidence = [...next.evidence];
  if (refs.externalStylesheets.length > 0) {
    next.externalStylesheets = refs.externalStylesheets;
    const cdnCount = refs.externalStylesheets.filter((r) => r.origin === 'cdn').length;
    evidence.push(`External stylesheets: ${refs.externalStylesheets.length} (${cdnCount} CDN)`);
  }
  if (refs.serverInjectedBodyClasses.length > 0) {
    next.serverInjectedBodyClasses = refs.serverInjectedBodyClasses;
    evidence.push(
      `Server-injected body classes: ${refs.serverInjectedBodyClasses.length} occurrence(s)`,
    );
  }
  if (refs.dynamicStyleAttributes.length > 0) {
    next.dynamicStyleAttributes = refs.dynamicStyleAttributes;
    const resolved = refs.dynamicStyleAttributes.filter((a) => a.viewmodelProperty).length;
    evidence.push(
      `Dynamic style attributes: ${refs.dynamicStyleAttributes.length} (${resolved} resolved to viewmodel)`,
    );
  }
  next.evidence = evidence;
  return next;
}
