import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, jsonBytes } from '../scripts/lib/common.mjs';
import { composePresentation } from '../scripts/compose-presentation.mjs';
import { preparePresentationPreview } from '../scripts/prepare-presentation-preview.mjs';

export const guid = (n) => '{00000000-0000-4000-8000-' + String(n).padStart(12, '0') + '}';
export async function fixture(t, change = () => {}) {
  const base = await mkdtemp(join(tmpdir(), 'virtual-presentation-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const put = async (path, value) => {
    const bytes = jsonBytes(value);
    await mkdir(join(base, path, '..'), { recursive: true });
    await writeFile(join(base, path), bytes);
    return { path, sha256: hash(bytes) };
  };
  const evidence = await put('capture.json', { collector: 'synthetic test', complete: true });
  const context = { siteName: 'target-site', language: 'en', itemVersion: 1, deviceId: guid(1) };
  const header = {
    version: 1,
    scopeId: 'demo',
    database: 'master',
    stateId: 'capture-1',
    evidence: [evidence],
  };
  const occ = (uid, rendering, ds, placeholder = 'main') => ({
    uid: guid(uid),
    renderingId: guid(rendering),
    placeholder,
    parameters: {},
    datasourceId: ds ? guid(ds) : null,
    origin: 'template-default',
    ownerId: guid(10),
  });
  const source = {
    ...header,
    ...context,
    instanceId: 'source',
    partialDesigns: [],
    siteName: 'source-site',
    parameterTemplates: [],
    templates: [{ id: guid(10), defaults: [occ(50, 20, 30), occ(51, 21, 31)] }],
    pages: [
      {
        id: guid(11),
        templateId: guid(10),
        effectiveComplete: true,
        sxaExpanded: true,
        defaultEvidenceComplete: true,
        overrideUids: [],
        effective: [occ(50, 20, 30), occ(51, 21, 31)],
      },
    ],
  };
  const rendering = (n, name) => ({
    id: guid(n),
    name,
    componentName: name,
    datasourceTemplateIds: [guid(42)],
    dataSource: 'datasource',
    dataMode: 'fields',
    parameterTemplateIds: [],
    parameterFields: [],
    variants: [],
  });
  const target = {
    ...header,
    ...context,
    instanceId: 'target',
    templates: [{ id: guid(40), standardValuesOnly: true, defaults: [] }],
    renderings: [rendering(60, 'Banner')],
    layouts: [guid(70)],
    placeholders: [{ key: 'headless-main', allowedRenderingIds: [guid(60)], ownerRenderingIds: [] }],
    partialDesigns: [],
    pageDesigns: [],
  };
  const template = (n, name) => ({
    templateId: guid(n),
    templateName: name,
    path: '/sitecore/templates/' + name,
    baseTemplates: [],
  });
  const renderingRef = (n, name) => ({
    renderingId: guid(n),
    renderingName: name,
    path: '/sitecore/layout/Renderings/' + name,
  });
  const mapping = {
    templates: [
      {
        source: [template(10, 'SourcePage')],
        target: [template(40, 'TargetPage')],
        fields: [],
        warnings: [],
      },
    ],
    renderings: [
      {
        source: [renderingRef(20, 'Hero'), renderingRef(21, 'Promo')],
        target: [renderingRef(60, 'Banner')],
        warnings: [],
      },
    ],
    placeholders: [{ source: { key: 'main', id: guid(80) }, target: { key: 'headless-main', id: guid(81) } }],
  };
  const identities = {
    version: 1,
    scopeId: 'demo',
    targetInstanceId: 'target',
    database: 'master',
    evidence: [evidence],
    bindings: [
      { sourceItemId: guid(11), targetItemId: guid(41), outputKey: 'page', status: 'verified' },
      { sourceItemId: guid(30), targetItemId: guid(43), outputKey: 'banner', status: 'verified' },
      { sourceItemId: guid(31), targetItemId: guid(44), outputKey: 'banner', status: 'verified' },
    ],
  };
  const targetData = {
    ...header,
    ...context,
    instanceId: 'target',
    format: 'target-layout-fields',
    capturedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    resolverData: [],
    items: [
      {
        id: guid(41),
        templateId: guid(40),
        path: '/sitecore/content/Target/Home',
        name: 'Home',
        fields: { Title: { value: 'Actual target page' } },
      },
      {
        id: guid(43),
        templateId: guid(42),
        path: '/sitecore/content/Target/Home/Data/Banner',
        name: 'Banner',
        fields: { Heading: { value: 'Actual target banner' } },
      },
      {
        id: guid(44),
        templateId: guid(42),
        path: '/sitecore/content/Target/Global/Promo',
        name: 'Promo',
        fields: { Heading: { value: 'Actual target promo' } },
      },
    ],
  };
  const rules = {
    version: 1,
    scopeId: 'demo',
    partialDesigns: [],
    pageDesigns: [{ key: 'standard', name: 'Standard', layoutId: guid(70), partialKeys: [] }],
    pages: [
      {
        sourcePageId: guid(11),
        targetPageId: guid(41),
        targetTemplateId: guid(40),
        pageDesignKey: 'standard',
        route: '/',
        defaultPolicy: 'preserve',
        excludeDefaultUids: [],
        templateAssociation: true,
      },
    ],
    occurrences: [],
    requiredCoverage: [{ renderingId: guid(60), variant: '' }],
  };
  const documents = { source, target, mapping, identities, targetData, rules };
  await change(documents);
  const input = { version: 1, scopeId: 'demo' };
  for (const [role, document] of Object.entries(documents)) input[role] = await put(role + '.json', document);
  input.mappingApproval = await put('mapping-approval.json', {
    id: 'mapping',
    kind: 'mapping',
    scopeId: 'demo',
    choice: 'approve',
    rationale: 'Reviewed mappings',
    userResponse: 'Approve',
    at: '2026-01-01T00:00:00Z',
    inputs: [input.mapping, input.rules],
  });
  const inputRef = await put('composition-input.json', input);
  const compose = async () => {
    const output = join(base, 'composition');
    const report = await composePresentation(join(base, inputRef.path), output);
    return {
      report,
      plan: {
        path: 'composition/composition-plan.json',
        sha256: hash(await readFile(join(output, 'composition-plan.json'))),
      },
      value: JSON.parse(await readFile(join(output, 'composition-plan.json'), 'utf8')),
    };
  };
  const preview = async (minimumPages = 1) => {
    const composed = await compose();
    const request = await put('preview-input.json', {
      version: 1,
      scopeId: 'demo',
      compositionInput: inputRef,
      compositionPlan: composed.plan,
      minimumPages,
    });
    const report = await preparePresentationPreview(join(base, request.path), join(base, 'preview'));
    return {
      composed,
      request,
      report,
      manifest: {
        path: 'preview/preview-manifest.json',
        sha256: hash(await readFile(join(base, 'preview/preview-manifest.json'))),
      },
      value: JSON.parse(await readFile(join(base, 'preview/preview-manifest.json'), 'utf8')),
    };
  };
  return { base, put, input, inputRef, documents, compose, preview };
}
