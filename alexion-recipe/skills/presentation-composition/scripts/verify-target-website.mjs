import { readFileSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import Ajv from '../../cms-migration/scripts/lib/vendor/ajv.mjs';
import { scopedPath } from '../../cms-migration/scripts/lib/files.mjs';
import { auditPresentationApplication } from './audit-presentation-application.mjs';
import { buildApplication } from './plan-presentation-application.mjs';
import { buildPreview } from './prepare-presentation-preview.mjs';
import { readApplicationJournal } from './lib/application-state.mjs';
import { verifyPresentationCompletionEvidence } from './record-presentation-execution.mjs';
import {
  definitions,
  readJSON,
  readArtifactJSON,
  decisionInputs,
  equal,
  id,
  hash,
  routeFile,
  publish,
  cli,
  isMain,
  unique,
} from './lib/common.mjs';

const schema = JSON.parse(readFileSync(new URL('../contracts/website.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(definitions);
ajv.addSchema(schema);
const validators = new Map();
export function requireWebsiteSchema(name, value) {
  if (!Object.hasOwn(schema.$defs, name)) throw Error('Unknown website contract: ' + name);
  if (!validators.has(name)) validators.set(name, ajv.compile({ $ref: schema.$id + '#/$defs/' + name }));
  if (!validators.get(name)(value)) throw Error(name + ': ' + ajv.errorsText(validators.get(name).errors));
  return value;
}
export function assertWebsiteJournalHead(journal, head) {
  if (!equal(journal.head, head.value))
    throw Error('Application journal head changed during website verification');
}
export async function recheckWebsiteJournal(journal) {
  const current = await readApplicationJournal(journal.root);
  if (current.sha256 !== journal.sha256 || !equal(current.head, journal.head))
    throw Error('Application journal changed during website verification');
}
const requireMatch = (condition, message) => {
  if (!condition) throw Error(message);
};
const timestamp = (value) => {
  const at = Date.parse(value);
  requireMatch(Number.isFinite(at) && at <= Date.now(), 'Invalid or future website evidence timestamp');
  return at;
};
export function validWebsiteScreenshot(bytes) {
  if (bytes.length > 8 * 1024 * 1024) return false;
  try {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      let offset = 8,
        header,
        ended = false;
      const data = [];
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset),
          end = offset + length + 12;
        if (end > bytes.length) return false;
        const type = bytes.subarray(offset + 4, offset + 8).toString(),
          body = bytes.subarray(offset + 8, end - 4);
        let crc = 0xffffffff;
        for (const byte of bytes.subarray(offset + 4, end - 4)) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4)) return false;
        if (!header && (type !== 'IHDR' || length !== 13)) return false;
        if (type === 'IHDR') {
          if (header) return false;
          header = body;
        }
        if (type === 'IDAT') data.push(body);
        if (type === 'IEND') {
          if (length || end !== bytes.length) return false;
          ended = true;
        }
        offset = end;
      }
      if (!header || !ended || !data.length) return false;
      const width = header.readUInt32BE(0),
        height = header.readUInt32BE(4),
        depth = header[8],
        color = header[9],
        channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      if (
        !width ||
        !height ||
        width * height > 16 * 1024 * 1024 ||
        !channels ||
        ![1, 2, 4, 8, 16].includes(depth) ||
        ([2, 4, 6].includes(color) && depth < 8) ||
        (color === 3 && depth === 16) ||
        header[10] ||
        header[11] ||
        header[12]
      )
        return false;
      const stride = Math.ceil((width * channels * depth) / 8) + 1,
        pixels = inflateSync(Buffer.concat(data), { maxOutputLength: 64 * 1024 * 1024 });
      if (pixels.length !== stride * height) return false;
      for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) return false;
      return true;
    }
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
    let offset = 2,
      frame = false;
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 255) return false;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++],
        length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if ([192, 193, 194].includes(marker)) {
        if (length < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return false;
        frame = true;
      }
      if (marker === 218) return frame && offset + length < bytes.length - 2;
      offset += length;
    }
  } catch {
    return false;
  }
  return false;
}
export function targetWebsiteUrl(value) {
  const url = new URL(value);
  requireMatch(
    ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !/localhost|127\.0\.0\.1|\[::1\]/i.test(url.hostname) &&
      !/mock-layouts|mock-preview|__kajoo|preview-manifest|(?:^|\/)preview(?:\/|$)/i.test(url.pathname),
    'Website evidence requires an actual target URL; preview URLs are forbidden',
  );
  return url;
}
// Compare captured data, identities and rendering tree. Extra Layout Service metadata is allowed;
// approved material, parameters, datasource, ordering and placeholder ancestry are not optional.
export function comparableLayout(value) {
  const route = value?.sitecore?.route;
  requireMatch(
    route && value.sitecore.context?.pageEditing === false,
    'Missing non-editing target Layout Service route',
  );
  const placeholders = (rows) =>
    Object.fromEntries(
      Object.entries(rows ?? {}).map(([key, nodes]) => [
        key,
        nodes.map((node) => ({
          uid: id(node.uid),
          componentName: node.componentName,
          dataSource: node.dataSource ? id(node.dataSource) : '',
          params: node.params ?? {},
          fields: node.fields,
          placeholders: placeholders(node.placeholders),
        })),
      ]),
    );
  return {
    itemId: id(route.itemId),
    templateId: id(route.templateId),
    databaseName: route.databaseName,
    itemLanguage: route.itemLanguage,
    itemVersion: Number(route.itemVersion),
    layoutId: id(route.layoutId),
    fields: route.fields,
    placeholders: placeholders(route.placeholders),
  };
}

async function evaluateTargetWebsite(inputPath) {
  const staged = await readJSON(inputPath),
    input = requireWebsiteSchema('websiteVerificationInput', staged.value),
    base = dirname(inputPath),
    refs = [{ path: inputPath, sha256: staged.sha256 }];
  const load = async (root, ref, name) => {
    const artifact = await readArtifactJSON(root, ref);
    if (name) requireWebsiteSchema(name, artifact.value);
    refs.push({ path: artifact.path, sha256: artifact.sha256 });
    return artifact;
  };
  const image = async (root, ref) => {
    const path = await scopedPath(root, ref.path),
      bytes = await readFile(path);
    requireMatch(
      validWebsiteScreenshot(bytes) && hash(bytes) === ref.sha256,
      'Invalid or stale PNG/JPEG screenshot bytes',
    );
    refs.push({ path, sha256: ref.sha256 });
    return { path, sha256: ref.sha256 };
  };
  const auditInput = await load(base, input.applicationAuditInput),
    auditBase = dirname(auditInput.path),
    appInput = await load(auditBase, auditInput.value.applicationInput),
    built = await buildApplication(appInput.path);
  refs.push(...built.model.refs);
  requireMatch(
    built.plan?.ready && built.plan.scopeId === input.scopeId,
    'Website verification requires ready application scope',
  );
  // Replay against a fresh isolated output; never trust a submitted ready flag or modify a journal.
  const temporary = await mkdtemp(join(tmpdir(), 'presentation-website-audit-'));
  let audit;
  try {
    audit = await auditPresentationApplication(auditInput.path, join(temporary, 'audit'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  requireMatch(audit.ready === true, 'Independent application audit failed');
  const journal = await readApplicationJournal(resolve(auditBase, auditInput.value.journalDirectory)),
    journalHead = await readJSON(join(journal.root, 'head.json'));
  requireMatch(
    journal.sha256 === audit.checkpointSha256,
    'Application journal changed after independent audit',
  );
  assertWebsiteJournalHead(journal, journalHead);
  refs.push({ path: join(journal.root, 'head.json'), sha256: journalHead.sha256 });
  for (const completion of journal.state.completed)
    refs.push(...(await verifyPresentationCompletionEvidence(completion, journal.state)));
  await load(auditBase, auditInput.value.applicationPlan);
  const independentState = await load(auditBase, auditInput.value.targetState),
    afterAudit = timestamp(independentState.value.capturedAt),
    captureArtifact = await load(base, input.targetCapture, 'targetWebsiteCapture'),
    capture = captureArtifact.value,
    captureBase = dirname(captureArtifact.path),
    capturedAt = timestamp(capture.capturedAt);
  requireMatch(
    capture.scopeId === input.scopeId &&
      capture.applicationPlanSha256 === audit.applicationPlanSha256 &&
      capturedAt > afterAudit &&
      Date.parse(capture.expiresAt) > Date.now() &&
      Date.parse(capture.expiresAt) > capturedAt,
    'Wrong application, stale target capture, or capture precedes independent audit',
  );

  const previews = [],
    approvedContexts = [];
  for (const ref of built.model.input.reviewInputs) {
    const review = await load(dirname(appInput.path), ref),
      previewInput = await load(dirname(review.path), review.value.previewInput),
      manifest = await load(dirname(review.path), review.value.previewManifest);
    approvedContexts.push({ previewManifestSha256: manifest.sha256, target: manifest.value.target });
    if (manifest.sha256 === capture.previewManifestSha256) {
      const preview = await buildPreview(previewInput.path);
      requireMatch(
        preview.manifest.ready && equal(preview.manifest, manifest.value),
        'Original preview manifest is not canonical',
      );
      refs.push(...preview.refs);
      previews.push({ ...preview, manifestArtifact: manifest });
    }
  }
  requireMatch(previews.length === 1, 'Capture must bind one original approved preview manifest');
  const preview = previews[0],
    manifest = preview.manifest,
    cohort = built.model.cohorts.find((row) => equal(row.plan.target, manifest.target));
  requireMatch(
    equal(capture.target, manifest.target) && cohort,
    'Website target instance/database/site/language/version/device differs',
  );
  requireMatch(
    input.minimumPages >= manifest.minimumPages,
    'Website minimum cannot weaken the approved preview minimum',
  );
  const bindings = (row) =>
    equal(row.target, capture.target) &&
    row.applicationPlanSha256 === capture.applicationPlanSha256 &&
    row.previewManifestSha256 === capture.previewManifestSha256;

  const baselineArtifact = await load(captureBase, capture.sourceBaseline, 'sourceWebsiteBaseline'),
    baseline = baselineArtifact.value,
    baselineBase = dirname(baselineArtifact.path);
  requireMatch(
    baseline.scopeId === input.scopeId && baseline.sourceInstanceId === cohort.plan.source.instanceId,
    'Source baseline belongs to another scope or source instance',
  );
  unique(baseline.pages, (p) => id(p.sourcePageId), 'source baseline page');
  const baselineImages = new Map();
  for (const page of baseline.pages) {
    targetWebsiteUrl(page.url);
    baselineImages.set(id(page.sourcePageId), await image(baselineBase, page.screenshot));
  }
  const approvalArtifact = await load(baselineBase, baseline.approval),
    approval = approvalArtifact.value;
  refs.push(...(await decisionInputs(approval, baselineBase)));
  requireMatch(
    approval.kind === 'verification' &&
      approval.choice === 'verified' &&
      approval.scopeId === input.scopeId &&
      approval.taskId === input.taskId &&
      approval.userResponse?.trim() &&
      timestamp(approval.at) <= capturedAt &&
      baseline.pages.every((p) => approval.inputs.some((ref) => equal(ref, p.screenshot))) &&
      approval.inputs.length === baseline.pages.length,
    'Approved source screenshots require an exact human baseline decision',
  );

  unique(capture.pages, (p) => id(p.pageId), 'captured page');
  unique(capture.pages, (p) => p.route, 'captured route');
  const captured = new Map(),
    origins = new Set();
  for (const page of capture.pages) {
    const approved = manifest.pages.find((p) => id(p.pageId) === id(page.pageId) && p.route === page.route);
    requireMatch(approved, 'Captured target page is outside the original preview scope');
    const url = targetWebsiteUrl(page.url);
    requireMatch(
      url.pathname === page.route && !url.search && !url.hash,
      'Target URL does not identify the exact page route',
    );
    requireMatch(
      !/(?:^|[\\/])(?:mock-layouts|mock-preview)(?:[\\/]|$)/i.test(page.layout.path),
      'Virtual preview artifact paths cannot be used as target captures',
    );
    const transport = await load(captureBase, page.transport, 'targetWebsiteTransport'),
      layout = await load(captureBase, page.layout),
      request = targetWebsiteUrl(transport.value.requestUrl),
      response = transport.value,
      at = timestamp(response.capturedAt),
      expectedBytes = preview.files.get('public/mock-layouts/' + routeFile(page.route));
    requireMatch(
      bindings(response) &&
        response.bodySha256 === layout.sha256 &&
        at > afterAudit &&
        at <= capturedAt &&
        targetWebsiteUrl(response.websiteOrigin).origin === url.origin &&
        /\/sitecore\/api\/layout\/render(?:\/[^/]+)?\/?$/i.test(request.pathname) &&
        request.searchParams.get('sc_site') === capture.target.siteName &&
        request.searchParams.get('sc_lang') === capture.target.language &&
        request.searchParams.get('sc_database') === capture.target.database &&
        request.searchParams.get('sc_itemversion') === String(capture.target.itemVersion) &&
        id(request.searchParams.get('sc_device')) === id(capture.target.deviceId) &&
        request.searchParams.get('item') === page.route,
      'Target Layout Service transport does not bind the actual target context and capture',
    );
    requireMatch(
      !['virtual-presentation-preview', 'virtual-preview-layout'].includes(layout.value.kind),
      'Virtual preview manifests cannot be used as target captures',
    );
    const context = layout.value.sitecore?.context;
    requireMatch(
      context?.site?.name === capture.target.siteName &&
        context.language === capture.target.language &&
        equal(comparableLayout(layout.value), comparableLayout(JSON.parse(expectedBytes.toString('utf8')))),
      'Actual target layout differs from approved material, rendering, association, or context',
    );
    origins.add(url.origin);
    captured.set(id(page.pageId), { page, approved });
  }
  requireMatch(origins.size === 1, 'Target page origins differ');

  const browsers = new Map();
  for (const ref of input.browserEvidence) {
    const artifact = await load(base, ref, 'targetWebsiteBrowserEvidence'),
      row = artifact.value,
      key = id(row.pageId),
      page = captured.get(key)?.page,
      at = timestamp(row.capturedAt);
    requireMatch(
      page &&
        !browsers.has(key) &&
        bindings(row) &&
        row.targetCaptureSha256 === captureArtifact.sha256 &&
        row.scopeId === input.scopeId &&
        row.taskId === input.taskId &&
        row.route === page.route &&
        row.url === page.url &&
        at >= capturedAt &&
        at < Date.parse(capture.expiresAt) &&
        row.errors.length === 0 &&
        row.checks.every((check) => check.passed) &&
        input.requiredChecks.every((name) => row.checks.some((check) => check.name === name)),
      'Browser evidence lacks exact target bindings or required named functional checks',
    );
    unique(row.checks, (check) => check.name, 'browser functional check');
    const targetImage = await image(dirname(artifact.path), row.screenshot),
      composed = cohort.plan.pages.find((p) => id(p.targetPageId) === key),
      sourcePage = baseline.pages.find((p) => id(p.sourcePageId) === id(composed?.sourcePageId));
    requireMatch(sourcePage, 'Every target page needs its mapped approved source baseline screenshot');
    const sourceComparison = await image(dirname(artifact.path), row.comparison.sourceScreenshot),
      targetComparison = await image(dirname(artifact.path), row.comparison.targetScreenshot);
    requireMatch(
      row.comparison.passed &&
        row.comparison.notes.trim() &&
        equal(sourceComparison, baselineImages.get(id(sourcePage.sourcePageId))) &&
        equal(targetComparison, targetImage),
      'Source/target comparison must bind the exact approved source and actual target screenshot',
    );
    requireMatch(
      row.navigation.every(
        (nav) =>
          nav.passed &&
          targetWebsiteUrl(nav.fromUrl).origin === origins.values().next().value &&
          targetWebsiteUrl(nav.toUrl).origin === origins.values().next().value,
      ) && row.navigation.some((nav) => nav.toUrl === page.url || nav.fromUrl === page.url),
      'Navigation evidence must exercise actual target page URLs',
    );
    browsers.set(key, { row, ref });
  }

  const decisions = new Map(),
    issues = [];
  for (const ref of input.decisions) {
    const artifact = await load(base, ref),
      decision = artifact.value,
      key = id(decision.entityId),
      browser = browsers.get(key);
    refs.push(...(await decisionInputs(decision, base)));
    const baselineRef = { path: baselineArtifact.path, sha256: baselineArtifact.sha256 },
      wanted = [input.applicationAuditInput, input.targetCapture, browser?.ref];
    // Decision paths are relative to the operation input, as in existing preview review.
    const decisionRefs = await Promise.all(
      decision.inputs.map(async (r) => ({ path: await scopedPath(base, r.path), sha256: r.sha256 })),
    );
    requireMatch(
      browser &&
        !decisions.has(key) &&
        decision.kind === 'verification' &&
        decision.taskId === input.taskId &&
        decision.scopeId === input.scopeId &&
        decision.userResponse?.trim() &&
        ['verified', 'not-verified', 'pause'].includes(decision.choice) &&
        timestamp(decision.at) >= timestamp(browser.row.capturedAt) &&
        wanted.every((r) => decision.inputs.some((v) => equal(v, r))) &&
        decisionRefs.some((r) => equal(r, baselineRef)) &&
        decision.inputs.length === 4,
      'Human page verification must bind exact task, scope, current audit/capture/browser/baseline and actual user response',
    );
    decisions.set(key, decision);
    if (decision.choice !== 'verified')
      issues.push('Human verification is ' + decision.choice + ' for ' + decision.entityId);
  }
  const verified = [...captured.values()].filter(
      ({ page }) => browsers.has(id(page.pageId)) && decisions.get(id(page.pageId))?.choice === 'verified',
    ),
    covered = [...new Set(verified.flatMap(({ approved }) => approved.coverage))].sort(),
    missing = manifest.requiredCoverage.filter((key) => !covered.includes(key)),
    untested = manifest.pages
      .filter((page) => !verified.some((v) => id(v.page.pageId) === id(page.pageId)))
      .map((p) => p.pageId);
  if (verified.length < input.minimumPages)
    issues.push('Insufficient human verified target pages: ' + verified.length + '/' + input.minimumPages);
  if (missing.length) issues.push('Required target rendering/variant coverage is incomplete');
  const report = {
    version: 1,
    kind: 'target-website-verification',
    scopeId: input.scopeId,
    taskId: input.taskId,
    ready: issues.length === 0,
    applicationPlanSha256: capture.applicationPlanSha256,
    previewManifestSha256: capture.previewManifestSha256,
    targetCaptureSha256: captureArtifact.sha256,
    verifiedPageIds: verified.map(({ page }) => page.pageId),
    untestedPageIds: untested,
    covered,
    missing,
    issues,
    limitations: [
      'Technical and functional checks are not proof of visual parity; per-page human source/target confirmation is required.',
      ...(untested.length
        ? ['Untested pages are outside this verification result: ' + untested.join(', ')]
        : []),
    ],
    targetWrites: false,
    workflowAdvanced: false,
  };
  await recheckWebsiteJournal(journal);
  return { report, refs, journal, approvedContexts };
}

export function aggregateWebsiteContexts(results, expected) {
  requireMatch(results.length > 0, 'Website verification requires a root context');
  unique(expected, (context) => context.previewManifestSha256, 'approved application preview context');
  unique(results, (result) => result.report.previewManifestSha256, 'website preview context');
  const root = results[0].report;
  requireMatch(
    results.every(
      ({ report }) =>
        report.applicationPlanSha256 === root.applicationPlanSha256 &&
        report.scopeId === root.scopeId &&
        report.taskId === root.taskId &&
        expected.some((context) => context.previewManifestSha256 === report.previewManifestSha256),
    ),
    'Website contexts must belong to the same current application plan, task, scope and approved manifest set',
  );
  const contexts = results.map(({ report, target }) => ({
    previewManifestSha256: report.previewManifestSha256,
    targetCaptureSha256: report.targetCaptureSha256,
    target:
      target ??
      expected.find((context) => context.previewManifestSha256 === report.previewManifestSha256).target,
    ready: report.ready,
    verifiedPageIds: report.verifiedPageIds,
    untestedPageIds: report.untestedPageIds,
    covered: report.covered,
    missing: report.missing,
  }));
  requireMatch(
    contexts.every((context) =>
      equal(
        context.target,
        expected.find((row) => row.previewManifestSha256 === context.previewManifestSha256).target,
      ),
    ),
    'Website context target differs from its original approved manifest',
  );
  const untestedContexts = expected.filter(
    (context) => !contexts.some((row) => row.previewManifestSha256 === context.previewManifestSha256),
  );
  return {
    ...root,
    ready: results.every(({ report }) => report.ready) && !untestedContexts.length,
    verifiedPageIds: [...new Set(results.flatMap(({ report }) => report.verifiedPageIds))],
    untestedPageIds: [...new Set(results.flatMap(({ report }) => report.untestedPageIds))],
    covered: [...new Set(results.flatMap(({ report }) => report.covered))].sort(),
    missing: [...new Set(results.flatMap(({ report }) => report.missing))].sort(),
    issues: [
      ...results.flatMap(({ report }) => report.issues),
      ...(untestedContexts.length ? ['Approved application website contexts remain untested'] : []),
    ],
    limitations: [
      ...new Set(results.flatMap(({ report }) => report.limitations)),
      ...(untestedContexts.length
        ? [
            'Untested application contexts: ' +
              untestedContexts
                .map(
                  (row) =>
                    row.target.language + '/' + row.target.itemVersion + '/' + row.previewManifestSha256,
                )
                .join(', '),
          ]
        : []),
    ],
    contexts,
    untestedContexts,
  };
}

export async function verifyTargetWebsite(inputPath, outputPath) {
  const staged = await readJSON(inputPath),
    input = requireWebsiteSchema('websiteVerificationInput', staged.value),
    base = dirname(inputPath),
    root = await evaluateTargetWebsite(inputPath),
    results = [root],
    refs = [{ path: inputPath, sha256: staged.sha256 }, ...root.refs],
    auditPath = await scopedPath(base, input.applicationAuditInput.path);
  unique(input.additionalContextInputs ?? [], (ref) => ref.path, 'additional website context input');
  for (const ref of input.additionalContextInputs ?? []) {
    const child = await readArtifactJSON(base, ref),
      childInput = requireWebsiteSchema('websiteVerificationInput', child.value);
    requireMatch(
      !Object.hasOwn(childInput, 'additionalContextInputs'),
      'Nested website context inputs are forbidden',
    );
    requireMatch(
      childInput.taskId === input.taskId &&
        childInput.scopeId === input.scopeId &&
        childInput.applicationAuditInput.sha256 === input.applicationAuditInput.sha256 &&
        (await scopedPath(dirname(child.path), childInput.applicationAuditInput.path)) === auditPath &&
        childInput.minimumPages >= input.minimumPages &&
        input.requiredChecks.every((name) => childInput.requiredChecks.includes(name)),
      'Additional website contexts require the same current audit, task, scope and agreed checks/minimum',
    );
    const result = await evaluateTargetWebsite(child.path);
    requireMatch(
      equal(result.approvedContexts, root.approvedContexts),
      'Website application context set changed during verification',
    );
    results.push(result);
    refs.push({ path: child.path, sha256: child.sha256 }, ...result.refs);
  }
  const report = aggregateWebsiteContexts(results, root.approvedContexts);
  requireWebsiteSchema('websiteVerificationReport', report);
  for (const { journal } of results) await recheckWebsiteJournal(journal);
  await publish(outputPath, { 'website-verification-report.json': report }, refs);
  return report;
}
if (isMain(import.meta.url)) await cli(verifyTargetWebsite);
