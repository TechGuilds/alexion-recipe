import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, guid } from './fixture.mjs';
import { hash, id } from '../scripts/lib/common.mjs';
import { buildApplication } from '../scripts/plan-presentation-application.mjs';
import { initializeApplicationState } from '../scripts/lib/application-state.mjs';

export { guid };
export const siteRoot = '/sitecore/content/Target';
export const partialBase = '{FD2059FD-6043-4DFE-8C04-E2437CE87634}';
export const pageBase = '{1105B8F8-1E00-426B-BF1F-C840742D827B}';
export const field = (n, name, type, storage = 'shared', value = '') => ({
  id: guid(n),
  name,
  type,
  storage,
  value,
  rawValue: value,
  standardValue: '',
});
export const layoutFields = () => [
  field(200, '__Renderings', 'Layout'),
  field(201, '__Final Renderings', 'Layout', 'versioned'),
];

// Synthetic observations follow Get-PresSnapshot/Get-PresTemplate output. They
// are evidence for local tests only and never claim a live Sitecore capture.
export async function applicationFixture(t, options = {}) {
  const f = await fixture(t, async (d) => {
    for (const [index, item] of d.targetData.items.entries())
      item.rawFields = Object.entries(item.fields).map(([name, value]) => ({
        fieldId: guid(250 + index),
        name,
        value: value.value,
      }));
    d.rules.partialDesigns = [{ key: 'header', name: 'Header' }];
    d.rules.pageDesigns[0].partialKeys = ['header'];
    d.rules.occurrences = [{ sourcePageId: guid(11), sourceUid: guid(50), partialKey: 'header' }];
    await options.composition?.(d);
  });
  const preview = await f.preview();
  if (!preview.report.ready)
    throw Error('Application fixture preview is not ready: ' + JSON.stringify(preview.report));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZyHAAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(join(f.base, 'browser.png'), png);
  const browser = await f.put('browser.json', {
    scopeId: 'demo',
    pageId: guid(41),
    route: '/',
    previewManifestSha256: preview.manifest.sha256,
    status: 'rendered',
    checks: [{ name: 'Synthetic browser rendering assertion', passed: true }],
    errors: [],
    screenshot: { path: 'browser.png', sha256: hash(png) },
  });
  const decision = await f.put('preview-decision.json', {
    id: 'preview-review',
    taskId: 'preview-review',
    kind: 'verification',
    scopeId: 'demo',
    entityId: guid(41),
    choice: 'verified',
    rationale: 'Synthetic human review fixture',
    userResponse: 'Verified',
    at: '2026-01-01T00:00:00Z',
    inputs: [preview.manifest, browser],
  });
  const review = await f.put('review-input.json', {
    version: 1,
    scopeId: 'demo',
    taskId: 'preview-review',
    previewInput: preview.request,
    previewManifest: preview.manifest,
    decisions: [decision],
    browserEvidence: [browser],
  });
  const evidence = await f.put('application-evidence.json', {
    collector: 'synthetic SPE test fixture',
    complete: true,
  });
  const profile = {
    version: 1,
    scopeId: 'demo',
    target: {
      instanceId: 'target',
      database: 'master',
      connectorId: 'synthetic-spe',
      rootPath: siteRoot,
      marker: { id: guid(300), templateId: guid(301), path: siteRoot },
    },
    sourceRoots: ['/sitecore/content/Source'],
    partialFolder: { id: guid(302), templateId: guid(303), path: siteRoot + '/Presentation/Partial Designs' },
    pageFolder: { id: guid(304), templateId: guid(305), path: siteRoot + '/Presentation/Page Designs' },
    partialTemplateId: guid(306),
    pageTemplateId: guid(307),
    partialLayoutId: guid(308),
    pageDesignLayoutField: 'Layout',
    placeholderPaths: [],
    evidence: [evidence],
  };
  const capabilities = {
    version: 1,
    scopeId: 'demo',
    instanceId: 'target',
    database: 'master',
    connectorId: 'synthetic-spe',
    verifiedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    speRead: true,
    speWrite: true,
    fullItemBackup: true,
    restoreValidated: true,
    exclusiveWriteWindow: true,
    stableReadWindow: true,
    fileDownload: true,
    journalContinuityVerified: true,
    layoutRoundtripValidated: true,
    authoringDatabaseValidated: true,
    maxRequestBytes: 8388608,
    maxCaptureBytes: 16777216,
    maxBackupBytes: 67108864,
    maxJournalBytes: 16777216,
    maxReadItems: 1000,
    maxContexts: 5000,
    evidence: [evidence],
  };
  await options.profile?.(profile);
  await options.capabilities?.(capabilities);
  const input = {
    version: 1,
    scopeId: 'demo',
    taskId: 'presentation-apply',
    reviewInputs: [review],
    profile: await f.put('profile.json', profile),
    capabilities: await f.put('capabilities.json', capabilities),
    maxOperationsPerBatch: 10,
  };
  let inputRef = await f.put('application-input.json', input);
  const first = await buildApplication(join(f.base, inputRef.path));
  const template = (templateId, baseId, fields) => ({
    id: templateId,
    language: 'en',
    baseIds: [baseId],
    fields: fields.map(({ id, name, type, storage, value }) => ({ id, name, type, storage, value })),
  });
  const state = {
    version: 1,
    kind: 'presentation-target-state',
    scopeId: 'demo',
    target: profile.target,
    requestSha256: first.read.sha256,
    collectorSha256: first.read.body.collectorSha256,
    capturedAt: new Date().toISOString(),
    queries: [],
    templates: [
      template(profile.partialTemplateId, partialBase, [
        ...layoutFields(),
        field(202, 'Signature', 'Single-Line Text'),
      ]),
      template(profile.pageTemplateId, pageBase, [
        ...layoutFields(),
        field(203, 'PartialDesigns', 'Multilist'),
        field(204, 'Layout', 'Droplink'),
      ]),
    ],
    consumers: [
      { templateId: guid(40), complete: true, contexts: [{ itemId: guid(41), language: 'en', version: 1 }] },
    ],
    complete: true,
    errors: [],
  };
  for (const query of first.read.body.queries) {
    const desired = [...first.intent.targets.values()].find((row) => id(row.itemId) === id(query.id));
    let item = null;
    if (!desired || desired.kind === 'page') {
      const material = f.documents.targetData.items.find((row) => id(row.id) === id(query.id));
      const marker = [profile.target.marker, profile.partialFolder, profile.pageFolder].find(
        (row) => id(row.id) === id(query.id),
      );
      const rendering = f.documents.target.renderings.find((row) => id(row.id) === id(query.id));
      item = {
        id: query.id,
        path:
          material?.path ??
          marker?.path ??
          '/sitecore/layout/' + (rendering ? 'Renderings/Banner' : 'Layouts/' + id(query.id)),
        templateId: material?.templateId ?? marker?.templateId ?? guid(309),
        versionPresent: true,
        contexts: [{ itemId: query.id, language: query.language, version: query.version }],
        fields: material
          ? material.rawFields.map((row) =>
              field(Number(id(row.fieldId).slice(-12)), row.name, 'Single-Line Text', 'versioned', row.value),
            )
          : [],
        shared: null,
        final: null,
        sharedOther: [],
        finalOther: [],
        componentName: rendering?.componentName ?? null,
      };
      if (desired?.kind === 'page') {
        item.fields.push(...layoutFields(), field(205, 'Page Design', 'Droplink', 'versioned'));
        item.shared = { layoutId: null, renderings: [] };
        item.final = { layoutId: null, renderings: [] };
      }
      if (marker === profile.pageFolder) item.fields.push(field(206, 'TemplatesMapping', 'Name Value List'));
      if (rendering)
        item.fields.push(field(207, 'Component Name', 'Single-Line Text', 'shared', rendering.componentName));
    }
    state.queries.push({
      key: query.key,
      query,
      byId: item,
      byPath: query.path ? structuredClone(item) : null,
    });
  }
  const stageState = async (value = state, path = 'target-state.json') => {
    input.targetState = await f.put(path, value);
    inputRef = await f.put('application-input.json', input);
    return inputRef;
  };
  if (options.state !== false) {
    await options.state?.(state, first, f);
    await stageState();
  }
  const build = () => buildApplication(join(f.base, inputRef.path));
  const prepare = async () => {
    const built = await build(),
      applicationPlan = await f.put('application-plan.json', built.plan),
      journalDirectory = join(f.base, 'journal');
    await initializeApplicationState(journalDirectory, 'demo', profile.target);
    const request = {
      version: 1,
      scopeId: 'demo',
      taskId: input.taskId,
      applicationInput: inputRef,
      applicationPlan,
      batchId: built.plan.batches[0].id,
      currentState: input.targetState,
      journalDirectory,
    };
    return { built, request, journalDirectory };
  };
  return {
    ...f,
    preview,
    review,
    profile,
    capabilities,
    input,
    state,
    first,
    stageState,
    build,
    prepare,
    get applicationInput() {
      return inputRef;
    },
  };
}
