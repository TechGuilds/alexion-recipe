import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const guid = (n) => `{00000000-0000-0000-0000-${String(n).padStart(12, '0')}}`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const field = (n, name, type, storage, value) => ({ id: guid(n), name, type, storage, value });
function fixture() {
  const target = {
    instanceId: 'synthetic',
    connectorId: 'synthetic-spe',
    database: 'master',
    rootPath: '/sitecore/content/Target',
    marker: { id: guid(1), templateId: guid(9), path: '/sitecore/content/Target' },
  };
  const capabilities = {
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
    verifiedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    maxReadItems: 100,
    maxContexts: 100,
    maxRequestBytes: 8388608,
    maxCaptureBytes: 16777216,
    maxBackupBytes: 16777216,
    maxJournalBytes: 16777216,
  };
  const otherXml = `<r><d id="${guid(80)}"><r uid="${guid(81)}" id="${guid(82)}" ph="other" /></d></r>`;
  const page = {
    id: guid(2),
    templateId: guid(9),
    path: target.rootPath + '/Home',
    fields: [
      field(20, '__Renderings', 'Layout', 'shared', otherXml),
      field(21, '__Final Renderings', 'Layout', 'versioned', otherXml),
      field(22, 'Page Design', 'Droplink', 'versioned', ''),
      field(23, 'Title', 'Single-Line Text', 'versioned', 'Keep & preserve'),
    ],
    shared: { layoutId: guid(30), renderings: [] },
    final: {
      layoutId: guid(30),
      renderings: [
        { uid: guid(40), renderingId: guid(31), placeholder: 'old', parameters: {}, datasourceId: null },
      ],
    },
  };
  const items = [
    page,
    ...[30, 31, 32].map((n) => ({
      id: guid(n),
      templateId: guid(9),
      path: '/sitecore/layout/asset-' + n,
      fields: [],
      shared: null,
      final: null,
    })),
  ];
  const query = {
    key: 'home-en-1',
    id: page.id,
    path: page.path,
    language: 'en',
    version: 1,
    materialFieldIds: [guid(23)],
  };
  const request = {
    version: 1,
    kind: 'presentation-read-request',
    scopeId: 'synthetic-scope',
    target,
    deviceId: guid(70),
    capabilities,
    queries: [query],
    templateIds: [],
    languages: ['en'],
    consumerTemplateIds: [],
    collectorSha256: 'a'.repeat(64),
  };
  return { mode: 'capture', request, items, query, target, capabilities };
}
function run(data) {
  const directory = mkdtempSync(join(tmpdir(), 'kajoo-presentation-spe-'));
  const requestJson = data.requestJson ?? JSON.stringify(data.request);
  const input = {
    ...data,
    dataRoot: join(directory, 'data'),
    requestJson,
    requestSha256: data.requestSha256 ?? hash(requestJson),
  };
  try {
    const inputPath = join(directory, 'input.json'),
      outputPath = join(directory, 'output.json');
    writeFileSync(inputPath, JSON.stringify(input));
    const result = spawnSync(
      process.env.PWSH_EXE ?? 'pwsh',
      [
        '-NoProfile',
        '-File',
        join(here, 'presentation-spe-harness.ps1'),
        '-InputPath',
        inputPath,
        '-OutputPath',
        outputPath,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, ''));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function writer() {
  const f = fixture(),
    observed = run(f);
  assert.equal(observed.state?.complete, true, JSON.stringify(observed));
  const before = observed.state.queries[0].byId;
  const layout = {
    final: true,
    deviceId: guid(70),
    layoutId: guid(30),
    renderings: [
      {
        uid: guid(41),
        renderingId: guid(31),
        placeholder: '/main/container-7',
        parameters: { RenderingIdentifier: 'one & two', Styles: '{A}|{B}', Empty: '', Unicode: 'é = ✓' },
        datasourceId: guid(32),
      },
      {
        uid: guid(42),
        renderingId: guid(31),
        placeholder: '/main/container-8',
        parameters: { GridParameters: 'col-12' },
        datasourceId: null,
      },
    ],
  };
  const op = {
    operationId: 'page-home',
    kind: 'page',
    action: 'update',
    itemId: guid(2),
    templateId: guid(9),
    path: f.query.path,
    contexts: [
      {
        query: f.query,
        before,
        layouts: [layout],
        fields: [
          {
            fieldId: guid(22),
            name: 'Page Design',
            type: 'Droplink',
            storage: 'versioned',
            kind: 'scalar',
            value: guid(90),
          },
        ],
      },
    ],
  };
  const review = {
    version: 1,
    kind: 'presentation-mutation-review',
    scopeId: 'synthetic-scope',
    taskId: 'apply',
    target: f.target,
    deviceId: guid(70),
    capabilities: f.capabilities,
    profile: {},
    consumerTemplateIds: [],
    consumers: [],
    operations: [op],
    guards: observed.state.queries,
    templates: [],
    checkpointSha256: 'b'.repeat(64),
    applicationPlanSha256: 'c'.repeat(64),
    batchId: 'batch-1',
  };
  return { ...f, mode: 'write', review, operation: op };
}
function execute(f) {
  const reviewJson = JSON.stringify(f.review),
    reviewSha256 = hash(reviewJson);
  f.request = {
    version: 1,
    requestId: 'presentation-' + 'd'.repeat(24),
    reviewJson,
    reviewSha256,
    reservation: f.review.checkpointSha256,
    approval: {
      kind: 'mutation',
      choice: 'approve',
      scopeId: f.review.scopeId,
      taskId: f.review.taskId,
      at: '2026-01-01T00:00:00Z',
      userResponse: 'Approve this exact mutation',
      inputs: [{ sha256: reviewSha256 }],
    },
  };
  return run(f);
}

test('SPE collector exports exact snapshots, field metadata, other-device XML and request hashes', () => {
  const f = fixture(),
    result = run(f),
    state = result.state;
  assert.equal(result.error, null);
  assert.equal(result.writes, 0);
  assert.equal(state.complete, true);
  assert.deepEqual(
    Object.keys(state).sort(),
    [
      'version',
      'kind',
      'scopeId',
      'target',
      'requestSha256',
      'collectorSha256',
      'capturedAt',
      'queries',
      'templates',
      'consumers',
      'complete',
      'errors',
    ].sort(),
  );
  assert.equal(state.requestSha256, hash(JSON.stringify(f.request)));
  assert.equal(state.collectorSha256, f.request.collectorSha256);
  const row = state.queries[0];
  assert.deepEqual(row.query, f.query);
  assert.deepEqual(row.byId, row.byPath);
  assert.equal(row.byId.fields.find((v) => v.name === 'Title').rawValue, 'Keep & preserve');
  assert.equal(row.byId.finalOther[0].id, guid(80));
  assert.match(row.byId.finalOther[0].xml, /ph="other"/);
  assert.deepEqual(row.byId.contexts, [{ itemId: guid(2), language: 'en', version: 1 }]);
  assert.match(result.outputs[0], /<!-- kajoo-export:/);
  assert.equal(result.files.length, 1);
});
test('SPE collector rejects mismatched request bytes before export', () => {
  const f = fixture();
  f.requestSha256 = '0'.repeat(64);
  const result = run(f);
  assert.match(result.error, /hash mismatch/);
  assert.equal(result.state, null);
  assert.equal(result.writes, 0);
});
test('SPE collector refuses query bounds before collecting', () => {
  const f = fixture();
  f.capabilities.maxReadItems = 0;
  const result = run(f);
  assert.match(result.error, /bounded presentation read/);
  assert.equal(result.state, null);
});
test('SPE collector marks context overflow incomplete with actionable evidence', () => {
  const f = fixture();
  f.capabilities.maxContexts = 0;
  const result = run(f);
  assert.equal(result.state.complete, false);
  assert.match(result.state.errors[0].message, /Context capture bound/);
  assert.equal(result.writes, 0);
});
test('SPE collector capture byte bound drops partial observations', () => {
  const f = fixture();
  f.capabilities.maxCaptureBytes = 100;
  const result = run(f);
  assert.equal(result.state.complete, false);
  assert.deepEqual(result.state.queries, []);
  assert.match(result.state.errors[0].message, /byte bound/);
});
test('SPE collector reports exact template consumers and stops scans at the item bound', () => {
  const f = fixture();
  f.items.unshift({
    id: guid(1),
    templateId: guid(8),
    path: f.target.rootPath,
    fields: [],
    shared: null,
    final: null,
  });
  f.children = [guid(2)];
  f.request.consumerTemplateIds = [guid(9)];
  const result = run(f);
  assert.equal(result.state.complete, true, JSON.stringify(result));
  assert.deepEqual(result.state.consumers, [
    { templateId: guid(9), contexts: [{ itemId: guid(2), language: 'en', version: 1 }], complete: true },
  ]);
  f.capabilities.maxReadItems = 1;
  const bounded = run(f);
  assert.equal(bounded.state.complete, false);
  assert.match(bounded.state.errors[0].message, /consumer scan.*bound/);
  assert.equal(bounded.writes, 0);
});
test('SPE collector enumerates retained version 2 when version 1 is absent', () => {
  const f = fixture();
  f.items[0].version = 2;
  f.query.version = 2;
  const result = run(f);
  assert.equal(result.error, null);
  assert.equal(result.state.complete, true, JSON.stringify(result));
  const post = result.state.queries[0].byId;
  assert.equal(post.versionPresent, true);
  assert.deepEqual(post.contexts, [{ itemId: guid(2), language: 'en', version: 2 }]);
});
test('SPE writer preserves exact UID, parameters, datasources, material and other devices with durable backup/readback', () => {
  const f = writer(),
    result = execute(f);
  assert.equal(result.error, null);
  assert.equal(result.receipt?.status, 'success', JSON.stringify(result));
  const post = result.receipt.results[0].post[0].item,
    before = f.operation.contexts[0].before;
  assert.deepEqual(post.final.renderings, f.operation.contexts[0].layouts[0].renderings);
  assert.deepEqual(post.shared, before.shared);
  assert.deepEqual(post.sharedOther, before.sharedOther);
  assert.deepEqual(post.finalOther, before.finalOther);
  assert.equal(post.fields.find((v) => v.name === 'Title').value, 'Keep & preserve');
  assert.equal(post.fields.find((v) => v.name === 'Page Design').value, guid(90));
  assert.equal(result.exports, 1);
  assert.equal(result.events[0], 'backup');
  assert.equal(result.receipt.backups.length, 1);
  assert.equal(result.receipt.journal.length, 2);
  for (const file of [...result.receipt.backups, ...result.receipt.journal]) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(file.bytes > 0);
    assert.ok(!file.file.includes('\\'), 'Export paths must use portable separators');
    const actual = result.files.find((row) => row.path.replaceAll('\\', '/').endsWith('/' + file.file));
    assert.ok(actual, 'Durable receipt record must reference an exported file');
    assert.equal(actual.sha256, file.sha256);
    assert.equal(actual.bytes, file.bytes);
  }
});
test('SPE writer rejects guard drift without backups or writes', () => {
  const f = writer();
  f.items[0].fields[3].value = 'Concurrent edit';
  const result = execute(f);
  assert.match(result.error, /Target drift/);
  assert.equal(result.writes, 0);
  assert.equal(result.exports, 0);
});
test('SPE writer rejects unapproved field metadata before any mutation', () => {
  const f = writer();
  f.operation.contexts[0].fields[0].storage = 'shared';
  const result = execute(f);
  assert.match(result.error, /Operation field metadata differs/);
  assert.equal(result.writes, 0);
  assert.equal(result.exports, 0);
});
test('SPE writer rejects a layout for another device before any mutation', () => {
  const f = writer();
  f.operation.contexts[0].layouts[0].deviceId = guid(80);
  const result = execute(f);
  assert.match(result.error, /Unapproved layout write/);
  assert.equal(result.writes, 0);
  assert.equal(result.exports, 0);
});
test('SPE writer records a failed mutation and skips later operations', () => {
  const f = writer();
  const later = structuredClone(f.operation);
  later.operationId = 'later';
  f.review.operations.push(later);
  f.failAdd = true;
  const result = execute(f);
  assert.equal(result.receipt?.status, 'failed', JSON.stringify(result));
  assert.deepEqual(
    result.receipt.results.map((v) => v.status),
    ['failed', 'skipped'],
  );
  assert.match(result.receipt.results[0].error, /Synthetic rendering failure/);
  assert.equal(result.writes, 2);
  assert.equal(result.events.filter((v) => v === 'begin').length, 0);
});
test('SPE writer detects actual postcondition corruption', () => {
  const f = writer();
  f.corruptUid = true;
  const result = execute(f);
  assert.equal(result.receipt?.status, 'failed', JSON.stringify(result));
  assert.match(result.receipt.results[0].error, /Rendering occurrence read-back differs/);
  assert.equal(result.receipt.results[0].post[0].item.final.renderings[0].uid, guid(9999));
});
test('SPE writer request replay returns durable receipt without duplicate mutation', () => {
  const f = writer();
  f.repeat = true;
  const result = execute(f);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.receipt?.status, 'success');
  assert.equal(result.exports, 1);
  assert.equal(result.writes, 5);
  assert.equal(result.outputs.length, 2);
  assert.equal(result.outputs[0], result.outputs[1]);
});

function creation() {
  const f = writer(),
    languages = ['en', 'fr'];
  const partialId = guid(110),
    designId = guid(111),
    partialTemplateId = guid(112),
    designTemplateId = guid(113);
  const partialFolder = f.target.rootPath + '/Presentation/Partial Designs',
    pageFolder = f.target.rootPath + '/Presentation/Page Designs';
  const partialFields = [
    field(120, '__Renderings', 'Layout', 'shared', ''),
    field(121, '__Final Renderings', 'Layout', 'versioned', ''),
    field(122, 'Signature', 'Single-Line Text', 'shared', ''),
  ];
  const designFields = [
    field(123, 'PartialDesigns', 'Multilist', 'shared', ''),
    field(124, 'Layout', 'Droplink', 'shared', ''),
  ];
  f.templates = languages.flatMap((language) => [
    { id: partialTemplateId, language, baseIds: [], fields: structuredClone(partialFields) },
    { id: designTemplateId, language, baseIds: [], fields: structuredClone(designFields) },
  ]);
  f.review.templates = f.templates;
  f.review.profile = {
    partialFolder: { id: guid(114), path: partialFolder },
    pageFolder: { id: guid(115), path: pageFolder },
    partialTemplateId,
    pageTemplateId: designTemplateId,
    pageDesignLayoutField: 'Layout',
  };
  const context = (itemId, path, language) => ({
    query: { key: itemId + '-' + language, id: itemId, path, language, version: 1, materialFieldIds: [] },
    before: null,
    layouts: [],
    fields: [],
  });
  const partial = {
    operationId: 'create-partial',
    kind: 'partial',
    action: 'create',
    itemId: partialId,
    path: partialFolder + '/Header',
    templateId: partialTemplateId,
    contexts: languages.map((language) => context(partialId, partialFolder + '/Header', language)),
  };
  for (const ctx of partial.contexts) {
    ctx.layouts = [{ ...structuredClone(f.operation.contexts[0].layouts[0]), final: false }];
    ctx.fields = [
      {
        fieldId: guid(122),
        name: 'Signature',
        type: 'Single-Line Text',
        storage: 'shared',
        kind: 'scalar',
        value: 'header',
      },
    ];
  }
  const design = {
    operationId: 'create-design',
    kind: 'design',
    action: 'create',
    itemId: designId,
    path: pageFolder + '/Home',
    templateId: designTemplateId,
    contexts: languages.map((language) => context(designId, pageFolder + '/Home', language)),
  };
  for (const ctx of design.contexts)
    ctx.fields = [
      {
        fieldId: guid(123),
        name: 'PartialDesigns',
        type: 'Multilist',
        storage: 'shared',
        kind: 'scalar',
        value: partialId,
      },
      {
        fieldId: guid(124),
        name: 'Layout',
        type: 'Droplink',
        storage: 'shared',
        kind: 'scalar',
        value: guid(30),
      },
    ];
  f.review.operations = [partial, design];
  f.review.guards = [...partial.contexts, ...design.contexts].map((ctx) => ({
    key: ctx.query.key,
    query: ctx.query,
    byId: null,
    byPath: null,
  }));
  return f;
}
test('SPE writer creates exact partial and Page Design identities in both languages with signature and associations', () => {
  const f = creation(),
    result = execute(f);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.receipt?.status, 'success', JSON.stringify(result));
  assert.equal(result.exports, 0);
  assert.deepEqual(result.receipt.backups, []);
  assert.deepEqual(
    result.receipt.results.map((row) => row.status),
    ['success', 'success'],
  );
  assert.equal(result.events.filter((event) => event === 'create:en').length, 2);
  assert.equal(result.events.filter((event) => event === 'version:fr').length, 2);
  for (const [index, operation] of f.review.operations.entries()) {
    const posts = result.receipt.results[index].post;
    assert.equal(posts.length, 2);
    for (const [contextIndex, post] of posts.entries()) {
      const ctx = operation.contexts[contextIndex];
      assert.equal(post.key, ctx.query.key);
      assert.equal(post.item.id, operation.itemId);
      assert.equal(post.item.path, operation.path);
      assert.equal(post.item.templateId, operation.templateId);
      assert.equal(post.item.versionPresent, true);
      assert.deepEqual(
        post.item.contexts,
        ['en', 'fr'].map((language) => ({ itemId: operation.itemId, language, version: 1 })),
      );
      for (const scalar of ctx.fields)
        assert.equal(post.item.fields.find((field) => field.name === scalar.name).value, scalar.value);
      if (operation.kind === 'partial') {
        assert.deepEqual(post.item.shared.renderings, ctx.layouts[0].renderings);
        assert.equal(post.item.shared.layoutId, guid(30));
        assert.deepEqual(post.item.final.renderings, []);
      }
    }
  }
});

function mappingFixture(preserveOther) {
  const f = writer(),
    pageFolderPath = f.target.rootPath + '/Presentation/Page Designs';
  const clean = (value) => value.slice(1, -1).toLowerCase();
  const prior = preserveOther
    ? [
        [guid(130), guid(140)],
        [guid(131), guid(142)],
      ]
    : [];
  const desired = [[guid(130), guid(141)], ...(preserveOther ? [[guid(131), guid(142)]] : [])];
  const encoded = prior.length
    ? encodeURIComponent(
        prior.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&'),
      )
    : '';
  f.items[0].path = pageFolderPath;
  f.items[0].fields.push(field(125, 'TemplatesMapping', 'Name Value List', 'shared', encoded));
  const query = { ...f.query, path: pageFolderPath };
  f.request = { ...fixture().request, queries: [query] };
  f.mode = 'capture';
  const captured = run(f);
  assert.equal(captured.state?.complete, true, JSON.stringify(captured));
  const before = captured.state.queries[0].byId;
  const operation = {
    operationId: 'update-template-mapping',
    kind: 'mapping',
    action: 'update',
    itemId: guid(2),
    templateId: guid(9),
    path: pageFolderPath,
    contexts: [
      {
        query,
        before,
        layouts: [],
        fields: [
          {
            fieldId: guid(125),
            name: 'TemplatesMapping',
            type: 'Name Value List',
            storage: 'shared',
            kind: 'mapping',
            mappings: desired.map(([templateId, designId]) => ({
              templateId: clean(templateId),
              designId: clean(designId),
            })),
          },
        ],
      },
    ],
  };
  f.mode = 'write';
  f.review.operations = [operation];
  f.review.guards = captured.state.queries;
  f.review.profile = { pageFolder: { id: guid(2), path: pageFolderPath } };
  return { f, desired, before };
}
for (const preserveOther of [false, true]) {
  test(`SPE writer round-trips ${preserveOther ? 'multiple template mappings and preserves unrelated pairs' : 'a single template mapping'}`, () => {
    const { f, desired, before } = mappingFixture(preserveOther),
      result = execute(f);
    assert.equal(result.error, null, JSON.stringify(result));
    assert.equal(result.receipt?.status, 'success', JSON.stringify(result));
    const post = result.receipt.results[0].post[0].item;
    const value = post.fields.find((field) => field.name === 'TemplatesMapping').value;
    assert.match(value, /%25/i, 'Raw field must contain the encoded UrlString transport');
    const roundtrip = [...new URLSearchParams(decodeURIComponent(value.replaceAll('+', ' '))).entries()];
    assert.deepEqual(roundtrip, desired);
    assert.deepEqual(post.shared, before.shared);
    assert.deepEqual(post.final, before.final);
    for (const original of before.fields.filter((field) => field.name !== 'TemplatesMapping'))
      assert.deepEqual(
        post.fields.find((field) => field.name === original.name),
        original,
      );
    assert.equal(result.writes, 1);
    assert.equal(result.exports, 1);
    assert.deepEqual(result.events, ['backup', 'begin', 'scalar']);
  });
}
