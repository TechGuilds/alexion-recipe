import { readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { applicationFixture, guid } from './application-fixture.mjs';
import { transitionApplication, readApplicationJournal } from '../scripts/lib/application-state.mjs';
import { hash, id } from '../scripts/lib/common.mjs';
import { buildPreview } from '../scripts/prepare-presentation-preview.mjs';
import { buildApplication } from '../scripts/plan-presentation-application.mjs';

// Every byte and human response below is synthetic, local test evidence only.
// No Sitecore connector, browser session, target write or live-parity claim is involved.
export async function websiteFixture(
  t,
  {
    applicationTaskId = 'presentation.apply',
    websiteTaskId = 'verification.website',
    additionalLanguage = false,
  } = {},
) {
  const f = await applicationFixture(t, {
    state(state) {
      state.capturedAt = '2026-01-01T00:00:00Z';
    },
  });
  const sourceContexts = [{ fixture: f, prefix: '', previewBase: f.base }];
  if (additionalLanguage) {
    const fr = await applicationFixture(t, {
      composition(documents) {
        for (const role of ['source', 'target', 'targetData']) documents[role].language = 'fr';
      },
      state(state) {
        state.capturedAt = '2026-01-01T00:00:00Z';
        for (const row of state.templates) row.language = 'fr';
        for (const consumer of state.consumers)
          for (const context of consumer.contexts) context.language = 'fr';
      },
    });
    await cp(fr.base, join(f.base, 'fr'), { recursive: true });
    sourceContexts.push({ fixture: fr, prefix: 'fr-', previewBase: join(f.base, 'fr') });
    f.input.reviewInputs.push({ ...fr.review, path: 'fr/' + fr.review.path });
    delete f.input.targetState;
    const requestedRef = await f.put('combined-input.json', f.input),
      requested = await buildApplication(join(f.base, requestedRef.path)),
      observations = [...f.state.queries, ...fr.state.queries],
      combined = {
        ...f.state,
        requestSha256: requested.read.sha256,
        collectorSha256: requested.read.body.collectorSha256,
        templates: [...f.state.templates, ...fr.state.templates],
        consumers: [
          {
            templateId: guid(40),
            complete: true,
            contexts: [
              { itemId: guid(41), language: 'en', version: 1 },
              { itemId: guid(41), language: 'fr', version: 1 },
            ],
          },
        ],
        queries: requested.read.body.queries.map((query) => {
          const row = structuredClone(observations.find((observation) => observation.key === query.key));
          row.query = query;
          for (const item of [row.byId, row.byPath])
            if (item)
              item.contexts = [
                { itemId: item.id, language: 'en', version: 1 },
                { itemId: item.id, language: 'fr', version: 1 },
              ];
          return row;
        }),
      };
    Object.assign(f.state, combined);
  }
  f.input.taskId = applicationTaskId;
  await f.stageState();
  const { built, request, journalDirectory } = await f.prepare(),
    current = structuredClone(f.state),
    results = [];
  for (const operation of built.plan.operations) {
    const post = [];
    for (const context of operation.contexts) {
      const observation = current.queries.find((row) => row.key === context.query.key);
      const item = structuredClone(context.before) ?? {
        id: operation.itemId,
        templateId: operation.templateId,
        path: operation.path,
        versionPresent: true,
        contexts: operation.contexts.map((ctx) => ({
          itemId: operation.itemId,
          language: ctx.query.language,
          version: ctx.query.version,
        })),
        fields: current.templates
          .find((row) => id(row.id) === id(operation.templateId) && row.language === context.query.language)
          .fields.map((field) => ({ ...field, rawValue: field.value, standardValue: '' })),
        shared: null,
        final: null,
        sharedOther: [],
        finalOther: [],
        componentName: null,
      };
      for (const desired of context.fields) {
        const field = item.fields.find((row) => row.name === desired.name);
        field.value =
          desired.kind === 'mapping'
            ? desired.mappings.map((r) => r.templateId + '=' + r.designId).join('&')
            : desired.value;
        field.rawValue = field.value;
      }
      for (const layout of context.layouts)
        item[layout.final ? 'final' : 'shared'] = {
          layoutId: layout.layoutId,
          renderings: layout.renderings,
        };
      observation.byId = item;
      if (observation.query.path) observation.byPath = structuredClone(item);
      post.push({ key: context.query.key, item });
    }
    results.push({ operationId: operation.operationId, status: 'success', post });
  }
  const reviewValue = {
      version: 1,
      kind: 'presentation-mutation-review',
      scopeId: 'demo',
      taskId: applicationTaskId,
      target: f.profile.target,
      applicationPlanSha256: request.applicationPlan.sha256,
      batchId: built.plan.batches[0].id,
      operations: built.plan.operations,
    },
    review = await f.put('terminal-review.json', reviewValue);
  await writeFile(join(f.base, 'remote-journal.jsonl'), 'synthetic terminal log\n');
  await writeFile(join(f.base, 'remote-backup.json'), 'synthetic full backup\n');
  const downloads = [];
  for (const file of ['remote-journal.jsonl', 'remote-backup.json']) {
    const bytes = await readFile(join(f.base, file));
    downloads.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  const receiptValue = {
      version: 1,
      kind: 'presentation-execution-receipt',
      scopeId: 'demo',
      taskId: applicationTaskId,
      target: f.profile.target,
      requestId: 'synthetic-request',
      requestSha256: 'a'.repeat(64),
      reviewSha256: review.sha256,
      applicationPlanSha256: request.applicationPlan.sha256,
      batchId: built.plan.batches[0].id,
      status: 'success',
      results,
      backups: [downloads[1]],
      journal: [downloads[0]],
    },
    receipt = await f.put('terminal-receipt.json', receiptValue),
    journal = await readApplicationJournal(journalDirectory);
  await transitionApplication(journalDirectory, journal.sha256, (state) => {
    state.completed.push({
      ...receiptValue,
      connectorId: f.profile.target.connectorId,
      jobId: 'synthetic-job',
      recordedAt: '2026-01-02T00:00:00Z',
      evidenceRoot: f.base,
      receipt,
      review,
      downloaded: downloads.map(({ file, sha256 }) => ({ path: file, sha256 })),
    });
  });
  current.capturedAt = '2026-01-03T00:00:00Z';
  const auditRequest = {
      version: 1,
      scopeId: 'demo',
      applicationInput: request.applicationInput,
      applicationPlan: request.applicationPlan,
      journalDirectory: 'journal',
      targetState: await f.put('independent-target-state.json', current),
    },
    audit = await f.put('audit-input.json', auditRequest),
    preview = await buildPreview(join(f.base, f.preview.request.path)),
    manifestValue = JSON.parse(await readFile(join(f.base, f.preview.manifest.path), 'utf8')),
    target = manifestValue.target,
    page = manifestValue.pages[0],
    url = 'https://target.test/';
  const chunk = (type, body) => {
    const name = Buffer.from(type),
      length = Buffer.alloc(4),
      crcBytes = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, body])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, body, crcBytes]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(join(f.base, 'source.png'), png);
  await writeFile(join(f.base, 'target.png'), png);
  const sourceScreenshot = { path: 'source.png', sha256: hash(png) },
    screenshot = { path: 'target.png', sha256: hash(png) },
    baselineDecisionValue = {
      id: 'baseline-approval',
      taskId: websiteTaskId,
      kind: 'verification',
      scopeId: 'demo',
      choice: 'verified',
      rationale: 'Synthetic approved source baseline',
      userResponse: 'Use this source screenshot for comparison',
      at: '2026-01-03T12:00:00Z',
      inputs: [sourceScreenshot],
    },
    baselineValue = {
      version: 1,
      kind: 'approved-source-website-baseline',
      scopeId: 'demo',
      sourceInstanceId: 'source',
      approval: await f.put('baseline-decision.json', baselineDecisionValue),
      pages: [
        { sourcePageId: guid(11), route: '/', url: 'https://source.test/', screenshot: sourceScreenshot },
      ],
    },
    sourceBaseline = await f.put('source-baseline.json', baselineValue),
    layoutValue = JSON.parse(preview.files.get('public/mock-layouts/home/index.json').toString('utf8'));
  layoutValue.sitecore.context.requestId = 'synthetic-target-layout-service-response';
  const layout = await f.put('target-layout.json', layoutValue),
    service = new URL('https://cm-target.test/sitecore/api/layout/render/jss');
  for (const [key, value] of Object.entries({
    sc_site: target.siteName,
    sc_lang: target.language,
    sc_database: target.database,
    sc_itemversion: target.itemVersion,
    sc_device: target.deviceId,
    item: '/',
  }))
    service.searchParams.set(key, value);
  const transportValue = {
      version: 1,
      kind: 'target-layout-service-response',
      target,
      capturedAt: '2026-01-04T00:00:00Z',
      requestUrl: service.href,
      websiteOrigin: 'https://target.test',
      statusCode: 200,
      bodySha256: layout.sha256,
      applicationPlanSha256: request.applicationPlan.sha256,
      previewManifestSha256: f.preview.manifest.sha256,
    },
    captureValue = {
      version: 1,
      kind: 'target-website-capture',
      scopeId: 'demo',
      target,
      capturedAt: '2026-01-04T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applicationPlanSha256: request.applicationPlan.sha256,
      previewManifestSha256: f.preview.manifest.sha256,
      sourceBaseline,
      pages: [
        {
          pageId: page.pageId,
          route: '/',
          url,
          layout,
          transport: await f.put('target-transport.json', transportValue),
        },
      ],
    },
    capture = await f.put('target-capture.json', captureValue),
    browserValue = {
      version: 1,
      kind: 'target-website-browser-evidence',
      scopeId: 'demo',
      taskId: websiteTaskId,
      target,
      capturedAt: '2026-01-05T00:00:00Z',
      applicationPlanSha256: request.applicationPlan.sha256,
      previewManifestSha256: f.preview.manifest.sha256,
      targetCaptureSha256: capture.sha256,
      pageId: page.pageId,
      route: '/',
      url,
      screenshot,
      checks: [{ name: 'main navigation', passed: true }],
      errors: [],
      comparison: {
        sourceScreenshot,
        targetScreenshot: screenshot,
        passed: true,
        notes: 'Synthetic source/target page comparison',
      },
      navigation: [{ fromUrl: url, toUrl: url, passed: true }],
    },
    browser = await f.put('target-browser.json', browserValue),
    decisionValue = {
      id: 'website-page',
      kind: 'verification',
      taskId: websiteTaskId,
      scopeId: 'demo',
      entityId: page.pageId,
      choice: 'verified',
      rationale: 'Synthetic human visual assessment',
      userResponse: 'This target page matches the approved source baseline',
      at: '2026-01-06T00:00:00Z',
      inputs: [audit, capture, browser, sourceBaseline],
    },
    decision = await f.put('website-decision.json', decisionValue),
    input = {
      version: 1,
      scopeId: 'demo',
      taskId: websiteTaskId,
      applicationAuditInput: audit,
      targetCapture: capture,
      minimumPages: 1,
      requiredChecks: ['main navigation'],
      browserEvidence: [browser],
      decisions: [decision],
    };
  const requestRef = await f.put('website-input.json', input);
  let additionalContext;
  if (additionalLanguage) {
    const frContext = sourceContexts[1],
      frPreview = await buildPreview(join(frContext.previewBase, frContext.fixture.preview.request.path)),
      frManifest = frPreview.manifest,
      frManifestSha = frContext.fixture.preview.manifest.sha256,
      frLayoutValue = JSON.parse(frPreview.files.get('public/mock-layouts/home/index.json').toString('utf8'));
    frLayoutValue.sitecore.context.requestId = 'synthetic-target-fr-layout-service-response';
    const frLayout = await f.put('fr-target-layout.json', frLayoutValue),
      frTransport = structuredClone(transportValue),
      frService = new URL(frTransport.requestUrl);
    frService.searchParams.set('sc_lang', 'fr');
    Object.assign(frTransport, {
      target: frManifest.target,
      requestUrl: frService.href,
      bodySha256: frLayout.sha256,
      previewManifestSha256: frManifestSha,
    });
    const frCaptureValue = {
        ...structuredClone(captureValue),
        target: frManifest.target,
        previewManifestSha256: frManifestSha,
        pages: [
          {
            pageId: frManifest.pages[0].pageId,
            route: '/',
            url,
            layout: frLayout,
            transport: await f.put('fr-target-transport.json', frTransport),
          },
        ],
      },
      frCapture = await f.put('fr-target-capture.json', frCaptureValue),
      frBrowserValue = {
        ...structuredClone(browserValue),
        target: frManifest.target,
        previewManifestSha256: frManifestSha,
        targetCaptureSha256: frCapture.sha256,
      },
      frBrowser = await f.put('fr-target-browser.json', frBrowserValue),
      frDecisionValue = {
        ...structuredClone(decisionValue),
        id: 'fr-website-page',
        inputs: [audit, frCapture, frBrowser, sourceBaseline],
      },
      frDecision = await f.put('fr-website-decision.json', frDecisionValue),
      frInput = {
        ...structuredClone(input),
        targetCapture: frCapture,
        browserEvidence: [frBrowser],
        decisions: [frDecision],
      },
      frInputRef = await f.put('fr-website-input.json', frInput);
    input.additionalContextInputs = [frInputRef];
    await f.put('website-input.json', input);
    additionalContext = {
      input: frInput,
      ref: frInputRef,
      captureValue: frCaptureValue,
      browserValue: frBrowserValue,
      decisionValue: frDecisionValue,
      async stage() {
        input.additionalContextInputs = [await f.put('fr-website-input.json', frInput)];
        await f.put('website-input.json', input);
      },
    };
  }
  return {
    ...f,
    input,
    requestRef,
    captureValue,
    transportValue,
    layoutValue,
    browserValue,
    baselineValue,
    baselineDecisionValue,
    decisionValue,
    auditRequest,
    current,
    journalDirectory,
    previewBuilt: preview,
    additionalContext,
    inputPath: join(f.base, requestRef.path),
    outputPath: (name = 'verified') => join(f.base, name),
    async stage() {
      return f.put('website-input.json', input);
    },
    async stageBrowser() {
      input.browserEvidence = [await f.put('target-browser.json', browserValue)];
      decisionValue.inputs[2] = input.browserEvidence[0];
      input.decisions = [await f.put('website-decision.json', decisionValue)];
      await f.put('website-input.json', input);
    },
    async stageCapture() {
      input.targetCapture = await f.put('target-capture.json', captureValue);
      browserValue.targetCaptureSha256 = input.targetCapture.sha256;
      decisionValue.inputs[1] = input.targetCapture;
      await this.stageBrowser();
    },
  };
}
