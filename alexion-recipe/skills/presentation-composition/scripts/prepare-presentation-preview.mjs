import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildComposition } from './compose-presentation.mjs';
import {
  requireSchema,
  readJSON,
  readArtifactJSON,
  canonical,
  equal,
  id,
  hash,
  jsonBytes,
  routeFile,
  freshDirectory,
  recheck,
  cli,
  isMain,
} from './lib/common.mjs';

export const coverageKey = (row) => id(row.renderingId) + '|' + row.variant;
export function selectPages(pages, required, minimum) {
  const uncovered = new Set(required),
    selected = [],
    remaining = [...pages].sort((a, b) => a.route.localeCompare(b.route, 'en'));
  while (uncovered.size && remaining.length) {
    remaining.sort(
      (a, b) =>
        b.coverage.filter((k) => uncovered.has(k)).length -
          a.coverage.filter((k) => uncovered.has(k)).length || a.route.localeCompare(b.route, 'en'),
    );
    const page = remaining.shift();
    if (!page.coverage.some((k) => uncovered.has(k))) break;
    selected.push(page);
    for (const key of page.coverage) uncovered.delete(key);
  }
  for (const page of remaining.sort((a, b) => a.route.localeCompare(b.route, 'en')))
    if (selected.length < minimum) selected.push(page);
  return {
    selectedRoutes: selected.map((p) => p.route),
    missingCoverage: [...uncovered].sort(),
    minimumSatisfied: selected.length >= minimum,
  };
}
export async function buildPreview(inputPath) {
  const staged = await readJSON(inputPath),
    input = requireSchema('previewInput', staged.value),
    base = dirname(inputPath);
  const original = await readArtifactJSON(base, input.compositionInput),
    saved = await readArtifactJSON(base, input.compositionPlan);
  const { plan, model } = await buildComposition(original.path);
  if (input.scopeId !== plan.scopeId || !equal(saved.value, plan))
    throw Error('Composition plan differs from current canonical inputs');
  const refs = [
    ...model.refs,
    { path: inputPath, sha256: staged.sha256 },
    { path: saved.path, sha256: saved.sha256 },
  ];
  let totalPreviewBytes = 0;
  const layouts = new Map(),
    pages = [],
    issues = [...plan.issues],
    requirements = [];
  const { target, targetData: data } = model.documents,
    itemMap = new Map(data.items.map((r) => [id(r.id), r]));
  if (plan.ready)
    for (const page of plan.pages) {
      try {
        const design = plan.pageDesigns.find((d) => d.key === page.pageDesignKey),
          item = itemMap.get(id(page.targetPageId));
        const rows = [
          ...design.partialKeys.flatMap((key) => plan.partialDesigns.find((p) => p.key === key).renderings),
          ...page.renderings,
        ];
        const seen = new Set();
        for (const row of rows) {
          if (seen.has(id(row.uid))) throw Error('Effective rendering UID collides across designs');
          seen.add(id(row.uid));
        }
        const nodes = new Map(),
          coverage = [];
        let pageBytes = Buffer.byteLength(jsonBytes(item.fields)) + 2048;
        for (const row of rows) {
          const definition = target.renderings.find((r) => id(r.id) === id(row.renderingId));
          let fields = {};
          if (definition.dataMode === 'resolver') {
            const matches = data.resolverData.filter(
              (r) =>
                id(r.pageId) === id(page.targetPageId) &&
                id(r.renderingUid) === id(row.uid) &&
                id(r.renderingId) === id(row.renderingId) &&
                (r.datasourceId ? id(r.datasourceId) : null) ===
                  (row.datasourceId ? id(row.datasourceId) : null) &&
                r.parametersSha256 === hash(canonical(row.parameters)),
            );
            if (matches.length !== 1) {
              requirements.push({
                pageId: page.targetPageId,
                renderingUid: row.uid,
                renderingId: row.renderingId,
                datasourceId: row.datasourceId,
                parameters: row.parameters,
                parametersSha256: hash(canonical(row.parameters)),
                reason: 'Capture the exact target resolver output using a confirmed read mechanism',
              });
              throw Error('Missing or ambiguous target resolver data');
            }
            fields = matches[0].fields;
          } else if (definition.dataSource !== 'none') {
            const bound = definition.dataSource === 'page' ? item : itemMap.get(id(row.datasourceId));
            if (!bound) throw Error('Missing captured target item fields');
            fields = bound.fields;
          }
          pageBytes +=
            Buffer.byteLength(jsonBytes(fields)) + Buffer.byteLength(jsonBytes(row.parameters)) + 2048;
          if (pageBytes > 16 * 1024 * 1024 || totalPreviewBytes + pageBytes > 64 * 1024 * 1024)
            throw Error('Preview byte budget exceeded; reduce the explicit page scope');
          const node = {
            uid: id(row.uid),
            componentName: definition.componentName,
            renderingId: row.renderingId,
            dataSource: row.datasourceId ?? '',
            params: structuredClone(row.parameters),
            fields: structuredClone(fields),
            placeholders: Object.create(null),
          };
          nodes.set(id(row.uid), node);
          coverage.push(
            coverageKey({
              renderingId: row.renderingId,
              variant: definition.variantParameter ? row.parameters[definition.variantParameter] : '',
            }),
          );
        }
        const placeholders = Object.create(null);
        for (const row of rows) {
          const parent = row.parentUid ? nodes.get(id(row.parentUid))?.placeholders : placeholders;
          if (!parent) throw Error('Missing effective parent rendering');
          (parent[row.placeholder] ??= []).push(nodes.get(id(row.uid)));
        }
        const layout = {
          sitecore: {
            context: {
              pageEditing: false,
              language: target.language,
              site: { name: target.siteName },
              itemPath: item.path,
            },
            route: {
              itemId: item.id,
              name: item.name,
              displayName: item.name,
              templateId: item.templateId,
              databaseName: target.database,
              itemLanguage: target.language,
              itemVersion: target.itemVersion,
              layoutId: design.layoutId,
              fields: structuredClone(item.fields),
              placeholders,
            },
          },
        };
        totalPreviewBytes += Buffer.byteLength(jsonBytes(layout));
        if (totalPreviewBytes > 64 * 1024 * 1024)
          throw Error('Preview exceeds the total 64 MiB limit; reduce scope');
        layouts.set(page.route, layout);
        pages.push({ pageId: page.targetPageId, route: page.route, coverage: [...new Set(coverage)].sort() });
      } catch (error) {
        issues.push({ code: 'preview-data', pageId: page.targetPageId, message: error.message });
      }
    }
  const required = [
    ...new Set([...plan.requiredCoverage.map(coverageKey), ...pages.flatMap((p) => p.coverage)]),
  ].sort();
  const selection = selectPages(pages, required, input.minimumPages);
  if (selection.missingCoverage.length)
    issues.push({
      code: 'coverage-gap',
      message: 'No preview page covers required rendering/variant combinations',
      keys: selection.missingCoverage,
    });
  if (!selection.minimumSatisfied)
    issues.push({
      code: 'minimum-pages',
      message: 'Fewer valid pages exist than the agreed minimum; obtain a revised scope decision',
    });
  const files = new Map();
  for (const [route, layout] of layouts)
    files.set('public/mock-layouts/' + routeFile(route), Buffer.from(jsonBytes(layout)));
  const navigation = await readFile(
    new URL('../../sitecore/assets/mock-preview/navigation.template.txt', import.meta.url),
  );
  files.set('public/mock-preview/navigation.js', navigation);
  files.set(
    'public/mock-preview/routes.json',
    Buffer.from(jsonBytes({ routes: pages.map((p) => p.route).sort() })),
  );
  const manifest = {
    version: 1,
    kind: 'virtual-presentation-preview',
    scopeId: input.scopeId,
    previewInputSha256: staged.sha256,
    compositionPlanSha256: saved.sha256,
    target: plan.target,
    minimumPages: input.minimumPages,
    requiredCoverage: required,
    selectedRoutes: selection.selectedRoutes,
    pages,
    files: [...files]
      .map(([path, bytes]) => ({ path, sha256: hash(bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path, 'en')),
    ready: issues.length === 0,
    issues,
    targetWrites: false,
    browserVerified: false,
    approved: false,
    userApprovalRequired: true,
  };
  requireSchema('previewManifest', manifest);
  return { input, manifest, files, refs, requirements };
}
export async function preparePresentationPreview(inputPath, outputPath) {
  const result = await buildPreview(inputPath);
  await recheck(result.refs);
  for (const bytes of result.files.values())
    if (bytes.length > 16 * 1024 * 1024) throw Error('Preview file exceeds byte limit');
  const output = await freshDirectory(outputPath);
  // Incomplete compositions produce reports only; never install a partial preview.
  if (result.manifest.ready)
    for (const [path, bytes] of result.files) {
      await mkdir(dirname(join(output, path)), { recursive: true });
      await writeFile(join(output, path), bytes, { flag: 'wx' });
    }
  await writeFile(join(output, 'preview-manifest.json'), jsonBytes(result.manifest), { flag: 'wx' });
  await writeFile(
    join(output, 'target-read-requirements.json'),
    jsonBytes({ version: 1, scopeId: result.input.scopeId, requirements: result.requirements }),
    { flag: 'wx' },
  );
  return {
    ready: result.manifest.ready,
    issues: result.manifest.issues,
    pages: result.manifest.pages.length,
    selectedRoutes: result.manifest.selectedRoutes,
    approved: false,
    targetWrites: false,
  };
}
if (isMain(import.meta.url)) await cli(preparePresentationPreview);
