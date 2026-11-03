/**
 * mergeMvcStyleReferences
 *
 * Pure function that overlays ASP.NET MVC style metadata from a staged
 * Roslyn analyzer output onto a filesystem-driven `StyleSystemAnalysis`.
 *
 * The FS scan already detects SCSS/CSS files, build tools, and framework
 * detection. This function adds the ASP.NET-side view of the style system:
 *   - BundleConfig.cs bundle order (the source of truth for which CSS ships)
 *   - Razor <link rel="stylesheet"> tags from _Layout.cshtml and partials
 *   - @Styles.Render("~/bundles/...") call sites
 *   - File paths that use @section Styles { ... }
 *
 * KAJOO-4885: also populates the four cross-cutting fields on
 * `StyleSystemAnalysis` that the FS analyzer cannot see —
 * `externalStylesheets[]`, `serverInjectedBodyClasses[]`,
 * `dynamicStyleAttributes[]`, and (later) `externallyCoupledPartials[]`.
 *
 * When `styleRefs` is undefined (MVC discovery has not run yet), the
 * original analysis is returned unchanged with a warning in `evidence[]`.
 */
export function mergeMvcStyleReferences(fsAnalysis, styleRefs) {
  if (!styleRefs) {
    return {
      ...fsAnalysis,
      evidence: [
        ...fsAnalysis.evidence,
        'MVC style references unavailable: run MVC discovery to include BundleConfig and Razor link analysis',
      ],
    };
  }
  const bundleConfigs = styleRefs.bundleConfigs.flatMap((bc) =>
    bc.bundles.map((b) => ({
      virtualPath: b.virtualPath,
      includes: b.includes,
    })),
  );
  const razorLinkTags = styleRefs.razorStyleRefs.flatMap((r) => r.linkTags);
  const stylesRender = styleRefs.razorStyleRefs.flatMap((r) => r.stylesRenders);
  const sectionStyles = styleRefs.razorStyleRefs
    .filter((r) => r.hasStylesSection)
    .map((r) => r.filePath);
  // ── KAJOO-4885: cross-cutting fields ────────────────────────────────
  const externalStylesheets = buildExternalStylesheets(styleRefs);
  const serverInjectedBodyClasses = buildBodyClassInjections(styleRefs);
  const dynamicStyleAttributes = buildDynamicStyleAttributes(
    styleRefs,
    styleRefs.cssStringViewModelProps ?? [],
  );
  const evidenceAdditions = [];
  if (bundleConfigs.length > 0) {
    const names = bundleConfigs.map((b) => b.virtualPath).join(', ');
    evidenceAdditions.push(`BundleConfig: ${bundleConfigs.length} bundle(s) — ${names}`);
  }
  if (razorLinkTags.length > 0) {
    evidenceAdditions.push(`Razor <link> tags: ${razorLinkTags.length} stylesheet reference(s)`);
  }
  if (stylesRender.length > 0) {
    evidenceAdditions.push(`@Styles.Render: ${stylesRender.length} call(s)`);
  }
  if (sectionStyles.length > 0) {
    evidenceAdditions.push(`@section Styles: ${sectionStyles.length} file(s)`);
  }
  if (externalStylesheets.length > 0) {
    const cdnCount = externalStylesheets.filter((s) => s.origin === 'cdn').length;
    evidenceAdditions.push(`External stylesheets: ${externalStylesheets.length} (${cdnCount} CDN)`);
  }
  if (serverInjectedBodyClasses.length > 0) {
    evidenceAdditions.push(
      `Server-injected body classes: ${serverInjectedBodyClasses.length} occurrence(s)`,
    );
  }
  if (dynamicStyleAttributes.length > 0) {
    const wired = dynamicStyleAttributes.filter((d) => d.viewmodelProperty).length;
    evidenceAdditions.push(
      `Dynamic style attributes: ${dynamicStyleAttributes.length} (${wired} resolved to viewmodel)`,
    );
  }
  const merged = {
    ...fsAnalysis,
    evidence: [...fsAnalysis.evidence, ...evidenceAdditions],
    mvc: {
      bundleConfigs,
      razorLinkTags,
      stylesRender,
      sectionStyles,
    },
  };
  // Keep the cross-cutting arrays absent (rather than empty) when the
  // producer had nothing to report — preserves the "optional field"
  // contract on `StyleSystemAnalysis` and avoids noisy downstream diffs.
  if (externalStylesheets.length > 0) {
    merged.externalStylesheets = externalStylesheets;
  }
  if (serverInjectedBodyClasses.length > 0) {
    merged.serverInjectedBodyClasses = serverInjectedBodyClasses;
  }
  if (dynamicStyleAttributes.length > 0) {
    merged.dynamicStyleAttributes = dynamicStyleAttributes;
  }
  return merged;
}
// ── KAJOO-4885 helpers ───────────────────────────────────────────────
/**
 * Convert each Razor `<link>` href into an
 * {@link ExternalStylesheetRef} with a best-effort origin
 * classification.
 *
 * `cdn` — absolute http(s) URL.
 * `same-origin` — root-relative (`/…`) or app-rooted (`~/…`) path.
 * `unknown` — anything else (data URIs, protocol-relative, relative).
 */
function buildExternalStylesheets(styleRefs) {
  const refs = [];
  for (const razor of styleRefs.razorStyleRefs) {
    for (const href of razor.linkTags) {
      refs.push({
        href,
        origin: classifyOrigin(href),
        foundIn: { file: razor.filePath, kind: 'razor-link' },
        ...(isLicenseSuspected(href) ? { licenseSuspected: true } : {}),
      });
    }
  }
  return refs;
}
function classifyOrigin(href) {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return 'cdn';
  if (trimmed.startsWith('/') || trimmed.startsWith('~/')) return 'same-origin';
  return 'unknown';
}
/**
 * Conservative license-suspect heuristic — matches well-known patterns
 * (Font Awesome kit URLs, anything with `/pro/` in the path) without
 * trying to be exhaustive. Migration agent verifies before shipping.
 */
function isLicenseSuspected(href) {
  return (
    /kit\.fontawesome\.com/i.test(href) || /\/pro\//i.test(href) || /licens(e|ing)/i.test(href)
  );
}
/**
 * Map each Roslyn `RazorBodyClass` into a
 * {@link BodyClassInjection}. `className` falls back to the verbatim
 * expression when no static class portion was extractable, so consumers
 * always have a non-empty string to render in evidence.
 */
function buildBodyClassInjections(styleRefs) {
  return (styleRefs.razorBodyClasses ?? []).map((bc) => ({
    className: bc.staticClasses[0] ?? bc.expression,
    expression: bc.expression,
    foundIn: bc.filePath,
    ...(bc.conditionHint ? { conditionHint: bc.conditionHint } : {}),
  }));
}
/**
 * Map each Roslyn inline-style hit into a
 * {@link DynamicStyleAttribute}. When the C# correlator emitted a
 * matching {@link RoslynCssStringViewModelPropertyInfo} for the same
 * (file, property) pair, the property name flows through verbatim — the
 * correlator has already done the catalogue lookup, so we don't
 * re-derive it here.
 */
function buildDynamicStyleAttributes(styleRefs, cssStringProps) {
  // Build a quick lookup of (consumedByView -> Set<propertyName>) so we
  // can prefer the correlator's classification when the regex viewmodel
  // resolution was ambiguous.
  const correlated = new Map();
  for (const prop of cssStringProps) {
    if (!prop.consumedByView) continue;
    const set = correlated.get(prop.consumedByView) ?? new Set();
    set.add(prop.propertyName);
    correlated.set(prop.consumedByView, set);
  }
  return (styleRefs.razorInlineStyleAttrs ?? []).map((attr) => {
    let viewmodelProperty = attr.viewModelProperty ?? undefined;
    if (!viewmodelProperty) {
      // Fall back to the correlator's classification when the regex
      // missed (e.g. method-call expressions whose argument matches a
      // known property name).
      const candidates = correlated.get(attr.filePath);
      if (candidates && candidates.size === 1) {
        viewmodelProperty = candidates.values().next().value;
      }
    }
    return {
      tag: attr.tag,
      expression: attr.expression,
      ...(viewmodelProperty ? { viewmodelProperty } : {}),
      foundIn: { file: attr.filePath, line: attr.lineNumber },
    };
  });
}
