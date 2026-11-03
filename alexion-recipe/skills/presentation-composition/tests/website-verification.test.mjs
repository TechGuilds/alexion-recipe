import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  verifyTargetWebsite,
  requireWebsiteSchema,
  validWebsiteScreenshot,
  assertWebsiteJournalHead,
  recheckWebsiteJournal,
} from '../scripts/verify-target-website.mjs';
import { readApplicationJournal, transitionApplication } from '../scripts/lib/application-state.mjs';
import { websiteFixture } from './website-fixture.mjs';
import { hash } from '../scripts/lib/common.mjs';

test('target verification replays successful independent application audit and binds actual target/source evidence', async (t) => {
  const f = await websiteFixture(t),
    report = await verifyTargetWebsite(f.inputPath, f.outputPath());
  assert.equal(report.ready, true);
  assert.deepEqual(report.verifiedPageIds, [f.captureValue.pages[0].pageId]);
  assert.deepEqual(report.untestedPageIds, []);
  assert.equal(report.targetWrites, false);
  assert.equal(report.workflowAdvanced, false);
  assert.match(report.limitations[0], /not proof of visual parity/);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.outputPath(), 'website-verification-report.json'), 'utf8')),
    report,
  );
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /EEXIST/);
});

test('website gate rejects unresolved application audit even if capture claims success', async (t) => {
  const f = await websiteFixture(t);
  f.current.queries[0].byId.path += '/drift';
  f.auditRequest.targetState = await f.put('independent-target-state.json', f.current);
  f.input.applicationAuditInput = await f.put('audit-input.json', f.auditRequest);
  await f.stage();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /drift|identity|differs|collision/);
});

test('independently captured target body may equal the approved preview body when provenance evidence is complete', async (t) => {
  const f = await websiteFixture(t),
    bytes = f.previewBuilt.files.get('public/mock-layouts/home/index.json');
  await writeFile(join(f.base, 'target-layout.json'), bytes);
  f.captureValue.pages[0].layout.sha256 = hash(bytes);
  f.transportValue.bodySha256 = hash(bytes);
  f.captureValue.pages[0].transport = await f.put('target-transport.json', f.transportValue);
  await f.stageCapture();
  assert.equal((await verifyTargetWebsite(f.inputPath, f.outputPath())).ready, true);
});

test('virtual preview artifacts or untyped transport evidence cannot masquerade as actual target capture', async (t) => {
  const f = await websiteFixture(t);
  f.captureValue.pages[0].layout.path = 'preview/public/mock-layouts/home/index.json';
  await f.stageCapture();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /Virtual preview artifact/);
  const g = await websiteFixture(t);
  g.transportValue.kind = 'virtual-presentation-preview';
  g.captureValue.pages[0].transport = await g.put('target-transport.json', g.transportValue);
  await g.stageCapture();
  await assert.rejects(verifyTargetWebsite(g.inputPath, g.outputPath()), /targetWebsiteTransport/);
});

test('capture rejects wrong target, stale times, swapped manifest and preview URL evidence', async (t) => {
  for (const [name, mutate] of [
    [
      'target',
      (f) => {
        f.captureValue.target = { ...f.captureValue.target, instanceId: 'wrong' };
      },
    ],
    [
      'stale',
      (f) => {
        f.captureValue.capturedAt = '2026-01-03T00:00:00Z';
      },
    ],
    [
      'expired',
      (f) => {
        f.captureValue.expiresAt = '2026-01-05T00:00:00Z';
      },
    ],
    [
      'manifest',
      (f) => {
        f.captureValue.previewManifestSha256 = '0'.repeat(64);
      },
    ],
    [
      'preview URL',
      (f) => {
        f.captureValue.pages[0].url = 'http://localhost:3000/';
      },
    ],
  ])
    await t.test(name, async (st) => {
      const f = await websiteFixture(st);
      mutate(f);
      await f.stageCapture();
      await assert.rejects(
        verifyTargetWebsite(f.inputPath, f.outputPath()),
        /target|stale|capture|manifest|preview|URL/i,
      );
    });
});

test('actual target material, rendering params and layout association are compared against approved original preview', async (t) => {
  for (const [name, mutate] of [
    [
      'material',
      (layout) => {
        layout.sitecore.route.fields.unapproved = { value: 'drift' };
      },
    ],
    [
      'rendering',
      (layout) => {
        Object.values(layout.sitecore.route.placeholders)[0][0].componentName = 'Wrong';
      },
    ],
    [
      'parameters',
      (layout) => {
        Object.values(layout.sitecore.route.placeholders)[0][0].params.unapproved = 'value';
      },
    ],
    [
      'layout',
      (layout) => {
        layout.sitecore.route.layoutId = '{00000000-0000-4000-8000-999999999999}';
      },
    ],
  ])
    await t.test(name, async (st) => {
      const f = await websiteFixture(st);
      mutate(f.layoutValue);
      f.captureValue.pages[0].layout = await f.put('target-layout.json', f.layoutValue);
      f.transportValue.bodySha256 = f.captureValue.pages[0].layout.sha256;
      f.captureValue.pages[0].transport = await f.put('target-transport.json', f.transportValue);
      await f.stageCapture();
      await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /Actual target layout differs/);
    });
});

test('named functional checks and target navigation evidence are mandatory', async (t) => {
  for (const [name, mutate] of [
    [
      'missing checks',
      (f) => {
        f.browserValue.checks = [{ name: 'other', passed: true }];
      },
    ],
    [
      'failed check',
      (f) => {
        f.browserValue.checks[0].passed = false;
      },
    ],
    [
      'preview navigation',
      (f) => {
        f.browserValue.navigation[0].toUrl = 'https://preview.test/';
      },
    ],
    [
      'wrong target URL',
      (f) => {
        f.browserValue.url = 'https://wrong.test/';
      },
    ],
    [
      'before capture',
      (f) => {
        f.browserValue.capturedAt = '2026-01-03T00:00:00Z';
      },
    ],
  ])
    await t.test(name, async (st) => {
      const f = await websiteFixture(st);
      mutate(f);
      await f.stageBrowser();
      await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /functional|Browser|Navigation/);
    });
});

test('missing baseline, failed comparison and fake image bytes cannot prove look and feel', async (t) => {
  const f = await websiteFixture(t);
  f.browserValue.comparison.passed = false;
  await f.stageBrowser();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /comparison/);
  f.browserValue.comparison.passed = true;
  await writeFile(join(f.base, 'target.png'), 'PNG screenshot claim');
  f.browserValue.screenshot.sha256 = hash('PNG screenshot claim');
  f.browserValue.comparison.targetScreenshot = f.browserValue.screenshot;
  await f.stageBrowser();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /PNG\/JPEG/);
  const g = await websiteFixture(t);
  g.baselineValue.pages[0].sourcePageId = '{00000000-0000-4000-8000-999999999999}';
  g.captureValue.sourceBaseline = await g.put('source-baseline.json', g.baselineValue);
  await g.stageCapture();
  await assert.rejects(verifyTargetWebsite(g.inputPath, g.outputPath()), /mapped approved source baseline/);
});

test('per-page human confirmation requires actual user response, exact task and all current artifacts', async (t) => {
  for (const [name, mutate] of [
    [
      'response',
      (d) => {
        d.userResponse = ' ';
      },
    ],
    [
      'task',
      (d) => {
        d.taskId = 'other-task';
      },
    ],
    [
      'scope',
      (d) => {
        d.scopeId = 'other-scope';
      },
    ],
    [
      'inputs',
      (d) => {
        d.inputs.pop();
      },
    ],
    [
      'early',
      (d) => {
        d.at = '2026-01-04T00:00:00Z';
      },
    ],
  ])
    await t.test(name, async (st) => {
      const f = await websiteFixture(st);
      mutate(f.decisionValue);
      f.input.decisions = [await f.put('website-decision.json', f.decisionValue)];
      await f.stage();
      await assert.rejects(
        verifyTargetWebsite(f.inputPath, f.outputPath()),
        /Human page verification|decision.userResponse/,
      );
    });
});

test('technical checks without sufficient human pages or required rendering coverage return blocked report', async (t) => {
  const f = await websiteFixture(t);
  f.input.decisions = [];
  await f.stage();
  const report = await verifyTargetWebsite(f.inputPath, f.outputPath());
  assert.equal(report.ready, false);
  assert.ok(report.missing.length);
  assert.deepEqual(report.untestedPageIds, [f.captureValue.pages[0].pageId]);
  assert.match(report.limitations.at(-1), /Untested pages/);
  const g = await websiteFixture(t);
  g.input.minimumPages = 2;
  await g.stage();
  assert.equal((await verifyTargetWebsite(g.inputPath, g.outputPath())).ready, false);
});

test('website contracts reject unknown properties and weak evidence shapes', () => {
  assert.throws(
    () => requireWebsiteSchema('websiteVerificationInput', { version: 1, guessed: true }),
    /websiteVerificationInput/,
  );
  assert.throws(
    () => requireWebsiteSchema('targetWebsiteCapture', { kind: 'virtual-presentation-preview' }),
    /targetWebsiteCapture/,
  );
});

test('screenshot validation checks PNG pixels and rejects header-only or corrupt image claims', async (t) => {
  const f = await websiteFixture(t),
    valid = await readFile(join(f.base, 'target.png'));
  assert.equal(validWebsiteScreenshot(valid), true);
  const corrupt = Buffer.from(valid);
  corrupt[45] ^= 1;
  assert.equal(validWebsiteScreenshot(corrupt), false);
  assert.equal(validWebsiteScreenshot(Buffer.from([255, 216, 255, 217])), false);
  assert.equal(
    validWebsiteScreenshot(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZyHAAAAAASUVORK5CYII=',
        'base64',
      ),
    ),
    false,
  );
});

test('target transport must request the exact audited device and raw response hash', async (t) => {
  const f = await websiteFixture(t),
    url = new URL(f.transportValue.requestUrl);
  url.searchParams.set('sc_device', '{00000000-0000-4000-8000-999999999999}');
  f.transportValue.requestUrl = url.href;
  f.captureValue.pages[0].transport = await f.put('target-transport.json', f.transportValue);
  await f.stageCapture();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /transport/);
});

test('source baseline needs a real human response for the exact approved screenshots', async (t) => {
  const f = await websiteFixture(t);
  delete f.baselineDecisionValue.userResponse;
  f.baselineValue.approval = await f.put('baseline-decision.json', f.baselineDecisionValue);
  f.captureValue.sourceBaseline = await f.put('source-baseline.json', f.baselineValue);
  await f.stageCapture();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /userResponse|baseline decision/);
});

test('journal race guards reject a mismatched head snapshot and a concurrent checkpoint transition', async (t) => {
  const f = await websiteFixture(t),
    journal = await readApplicationJournal(f.journalDirectory);
  assert.doesNotThrow(() => assertWebsiteJournalHead(journal, { value: journal.head }));
  assert.throws(
    () => assertWebsiteJournalHead(journal, { value: { ...journal.head, sha256: '0'.repeat(64) } }),
    /head changed/,
  );
  await recheckWebsiteJournal(journal);
  await transitionApplication(f.journalDirectory, journal.sha256, () => {});
  await assert.rejects(recheckWebsiteJournal(journal), /journal changed/);
});

test('all approved EN/FR application contexts must be independently verified before final website readiness', async (t) => {
  const f = await websiteFixture(t, { additionalLanguage: true });
  const report = await verifyTargetWebsite(f.inputPath, f.outputPath());
  assert.equal(report.ready, true);
  assert.deepEqual(
    report.contexts.map((context) => context.target.language),
    ['en', 'fr'],
  );
  assert.ok(report.contexts.every((context) => context.ready && context.verifiedPageIds.length === 1));
  assert.deepEqual(report.untestedContexts, []);
  delete f.input.additionalContextInputs;
  await f.stage();
  const omitted = await verifyTargetWebsite(f.inputPath, f.outputPath('omitted-fr'));
  assert.equal(omitted.ready, false);
  assert.deepEqual(
    omitted.contexts.map((context) => context.target.language),
    ['en'],
  );
  assert.deepEqual(
    omitted.untestedContexts.map((context) => context.target.language),
    ['fr'],
  );
  assert.match(omitted.issues.at(-1), /contexts remain untested/);
});

test('additional contexts reject a different audit, task, recursive children or duplicate manifest', async (t) => {
  for (const [name, mutate] of [
    [
      'different audit',
      (f, child) => {
        child.applicationAuditInput = { ...child.applicationAuditInput, sha256: '0'.repeat(64) };
      },
    ],
    [
      'different task',
      (f, child) => {
        child.taskId = 'another-website-task';
      },
    ],
    [
      'recursive children',
      (f, child) => {
        child.additionalContextInputs = [];
      },
    ],
    [
      'weaker checks',
      (f, child) => {
        child.requiredChecks = ['unrelated check'];
      },
    ],
  ])
    await t.test(name, async (st) => {
      const f = await websiteFixture(st, { additionalLanguage: true });
      mutate(f, f.additionalContext.input);
      await f.additionalContext.stage();
      await assert.rejects(
        verifyTargetWebsite(f.inputPath, f.outputPath()),
        /same current audit|Nested website context/,
      );
    });
  const f = await websiteFixture(t);
  const duplicated = { ...structuredClone(f.input) };
  f.input.additionalContextInputs = [await f.put('duplicate-context-input.json', duplicated)];
  await f.stage();
  await assert.rejects(verifyTargetWebsite(f.inputPath, f.outputPath()), /Repeated website preview context/);
});
