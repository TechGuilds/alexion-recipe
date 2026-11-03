import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { applicationFixture, guid } from './application-fixture.mjs';
import { buildApplication, decodeTemplateMapping } from '../scripts/plan-presentation-application.mjs';
import { preparePresentationWrite } from '../scripts/prepare-presentation-write.mjs';
import { readApplicationJournal } from '../scripts/lib/application-state.mjs';
import { verifyApplicationCompletion } from '../scripts/audit-presentation-application.mjs';
import { hash, id } from '../scripts/lib/common.mjs';

const query = (state, itemId) => state.queries.find((row) => id(row.query.id) === id(itemId));
function update(state, itemId, change) {
  const row = query(state, itemId);
  change(row.byId);
  if (row.query.path) row.byPath = structuredClone(row.byId);
}
async function prepare(f, request, name = 'write-input.json', output = 'write') {
  const ref = await f.put(name, request);
  return preparePresentationWrite(join(f.base, ref.path), join(f.base, output));
}

test('approved English and French reviews create shared designs with both language contexts', async (t) => {
  const en = await applicationFixture(t);
  const fr = await applicationFixture(t, {
    composition(documents) {
      documents.source.language = 'fr';
      documents.target.language = 'fr';
      documents.targetData.language = 'fr';
    },
    state(state) {
      for (const template of state.templates) template.language = 'fr';
      for (const consumer of state.consumers) {
        for (const context of consumer.contexts) context.language = 'fr';
      }
    },
  });
  await cp(fr.base, join(en.base, 'fr'), { recursive: true });
  en.input.reviewInputs.push({ ...fr.review, path: 'fr/' + fr.review.path });
  delete en.input.targetState;
  const input = await en.put('combined-input.json', en.input);
  const requested = await buildApplication(join(en.base, input.path));
  const observations = [...en.state.queries, ...fr.state.queries];
  const state = {
    ...en.state,
    requestSha256: requested.read.sha256,
    collectorSha256: requested.read.body.collectorSha256,
    templates: [...en.state.templates, ...fr.state.templates],
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
      const observation = observations.find((row) => row.key === query.key);
      assert.ok(observation, 'Every combined query has an observed context');
      const row = structuredClone(observation);
      row.query = query;
      for (const item of [row.byId, row.byPath]) {
        if (item)
          item.contexts = [
            { itemId: item.id, language: 'en', version: 1 },
            { itemId: item.id, language: 'fr', version: 1 },
          ];
      }
      return row;
    }),
  };
  await en.stageState(state, 'combined-state.json');
  const built = await en.build();
  assert.equal(built.plan.ready, true, JSON.stringify(built.plan.issues));
  const designs = built.plan.operations.filter((operation) => ['partial', 'design'].includes(operation.kind));
  assert.equal(designs.length, 2);
  for (const design of designs) {
    assert.equal(design.action, 'create');
    assert.deepEqual(design.contexts.map((context) => context.query.language).sort(), ['en', 'fr']);
  }
  const mappings = built.plan.operations.find((operation) => operation.kind === 'mapping');
  assert.deepEqual(mappings.contexts.map((context) => context.query.language).sort(), ['en', 'fr']);
  assert.deepEqual(mappings.contexts[0].fields, mappings.contexts[1].fields);
});

test('application first requests exact bounded reads and never emits a write envelope', async (t) => {
  const f = await applicationFixture(t, { state: false });
  const built = await f.build();
  assert.equal(built.report.ready, false);
  assert.equal(built.report.issues[0].code, 'target-read-required');
  assert.equal(built.report.targetWrites, false);
  assert.deepEqual(built.read.body.queries, built.intent.queries);
  assert.deepEqual(built.read.body.templateIds, [f.profile.partialTemplateId, f.profile.pageTemplateId]);
  assert.ok(built.read.body.queries.find((row) => id(row.id) === id(guid(43))).materialFieldIds.length);
  assert.deepEqual(Object.keys(built.outputs).sort(), [
    'presentation-read-envelope.json',
    'presentation-read-request.json',
  ]);
});

test('ready application deterministically creates designs, updates page and preserves unrelated mappings', async (t) => {
  const f = await applicationFixture(t, {
    state(state) {
      update(state, guid(304), (item) => {
        item.fields.find((row) => row.name === 'TemplatesMapping').value = guid(999) + '=' + guid(998);
        item.fields.find((row) => row.name === 'TemplatesMapping').rawValue = guid(999) + '=' + guid(998);
      });
    },
  });
  const a = await f.build(),
    b = await f.build();
  assert.equal(a.report.ready, true, JSON.stringify(a.report.issues));
  assert.deepEqual(a.plan, b.plan);
  assert.deepEqual(
    a.plan.operations.map((row) => [row.kind, row.action]),
    [
      ['partial', 'create'],
      ['design', 'create'],
      ['page', 'update'],
      ['mapping', 'update'],
    ],
  );
  assert.equal(
    a.plan.operations.find((row) => row.kind === 'page').contexts[0].layouts[0].renderings.length,
    1,
  );
  const mappings = a.plan.operations.find((row) => row.kind === 'mapping').contexts[0].fields[0].mappings;
  assert.ok(mappings.some((row) => row.templateId === id(guid(999)) && row.designId === id(guid(998))));
  assert.equal(a.plan.targetWrites, false);
  assert.equal(a.plan.mutationApprovalRequired, true);
  assert.equal(a.plan.batches.length, 1);
});

test('raw target observations, profile evidence and successful human review are mandatory', async (t) => {
  await assert.rejects(
    applicationFixture(t, {
      composition(d) {
        delete d.targetData.items[0].rawFields;
      },
    }),
    /raw field observations/,
  );
  const f = await applicationFixture(t);
  await writeFile(join(f.base, 'application-evidence.json'), '{}');
  await assert.rejects(f.build(), /evidence is stale/);
  const g = await applicationFixture(t);
  const decision = JSON.parse(await readFile(join(g.base, 'preview-decision.json'), 'utf8'));
  decision.choice = 'needs-review';
  await g.put('preview-decision.json', decision);
  await assert.rejects(g.build(), /SHA|stale/);
});

test('material, component definition, site identity and exact query drift fail closed', async (t) => {
  for (const change of [
    (state) =>
      update(state, guid(43), (item) => {
        item.fields[0].value = 'Changed after preview';
      }),
    (state) =>
      update(state, guid(60), (item) => {
        item.componentName = 'ChangedComponent';
      }),
    (state) =>
      update(state, guid(300), (item) => {
        item.templateId = guid(999);
      }),
    (state) => {
      state.queries.pop();
    },
    (state) => {
      state.requestSha256 = '0'.repeat(64);
    },
    (state) => {
      state.complete = false;
    },
  ]) {
    const f = await applicationFixture(t, { state: change });
    await assert.rejects(f.build(), /changed|drift|query scope|mismatched/);
  }
});

test('design path collisions cannot be implicitly adopted or overwritten', async (t) => {
  const f = await applicationFixture(t, {
    state(state, first) {
      const target = [...first.intent.targets.values()].find((row) => row.kind === 'partial'),
        row = query(state, target.itemId);
      row.byPath = {
        ...structuredClone(query(state, guid(300)).byId),
        id: guid(999),
        templateId: target.templateId,
        path: target.path,
        contexts: [{ itemId: guid(999), language: 'en', version: 1 }],
      };
    },
  });
  const built = await f.build();
  assert.equal(built.plan.ready, false);
  assert.ok(built.plan.issues.some((row) => /collision/.test(row.message)));
  assert.deepEqual(built.plan.batches, []);
});

test('matching deterministic designs are reused and mismatches block overwrite', async (t) => {
  const f = await applicationFixture(t),
    original = await f.build();
  for (const op of original.plan.operations.filter((row) => ['partial', 'design'].includes(row.kind))) {
    const row = query(f.state, op.itemId),
      ctx = op.contexts[0];
    const item = {
      id: op.itemId,
      templateId: op.templateId,
      path: op.path,
      versionPresent: true,
      contexts: [{ itemId: op.itemId, language: 'en', version: 1 }],
      fields: f.state.templates
        .find((row) => id(row.id) === id(op.templateId))
        .fields.map((row) => ({ ...row, rawValue: row.value, standardValue: '' })),
      shared: null,
      final: null,
      sharedOther: [],
      finalOther: [],
      componentName: null,
    };
    for (const desired of ctx.fields) {
      const actual = item.fields.find((row) => row.name === desired.name);
      actual.value = desired.value;
      actual.rawValue = desired.value;
    }
    for (const desired of ctx.layouts)
      item[desired.final ? 'final' : 'shared'] = {
        layoutId: desired.layoutId,
        renderings: desired.renderings,
      };
    row.byId = item;
    row.byPath = structuredClone(item);
  }
  await f.stageState();
  assert.deepEqual(
    (await f.build()).plan.operations.slice(0, 2).map((row) => row.action),
    ['reuse', 'reuse'],
  );
  const partial = original.plan.operations.find((row) => row.kind === 'partial');
  update(f.state, partial.itemId, (item) => {
    item.fields.find((row) => row.name === 'Signature').value = 'unexpected';
  });
  await f.stageState();
  const conflicted = await f.build();
  assert.equal(conflicted.plan.ready, false);
  assert.ok(conflicted.plan.issues.some((row) => /no implicit overwrite/.test(row.message)));
});

test('shared association impact requires every affected page context to have an approved review', async (t) => {
  for (const change of [
    (state) => {
      state.consumers[0].complete = false;
    },
    (state) => {
      state.consumers[0].contexts.push({ itemId: guid(999), language: 'en', version: 1 });
    },
    (state) => {
      state.consumers[0].contexts.push({ itemId: guid(41), language: 'en', version: 2 });
    },
    (state) =>
      update(state, guid(41), (item) => {
        item.fields.find((row) => row.name === 'Page Design').storage = 'shared';
        item.contexts.push({ itemId: guid(41), language: 'fr', version: 1 });
      }),
  ]) {
    const f = await applicationFixture(t, { state: change }),
      built = await f.build();
    assert.equal(built.plan.ready, false);
    assert.ok(built.plan.issues.some((row) => /coverage is incomplete|unreviewed/.test(row.message)));
  }
});

test('page-specific associations block when another device would be affected', async (t) => {
  const f = await applicationFixture(t, {
    composition(d) {
      d.rules.pages[0].templateAssociation = false;
    },
    state(state) {
      update(state, guid(41), (item) => {
        item.finalOther = [{ id: guid(9), xml: '<d id="' + guid(9) + '" />' }];
      });
    },
  });
  const built = await f.build();
  assert.equal(built.plan.ready, false);
  assert.ok(built.plan.issues.some((row) => /other devices/.test(row.message)));
  assert.deepEqual(built.plan.batches, []);
});

test('nested placeholders require an explicit physical path bound to the approved occurrence', async (t) => {
  const composition = (d) => {
    d.rules.partialDesigns = [];
    d.rules.pageDesigns[0].partialKeys = [];
    d.rules.occurrences = [];
    d.source.pages[0].effective[1].parentUid = guid(50);
    d.source.pages[0].effective[1].placeholder = 'inner';
    d.mapping.placeholders.push({
      source: { key: 'inner', id: guid(82) },
      target: { key: 'content', id: guid(83) },
    });
    d.target.placeholders.push({
      key: 'content',
      allowedRenderingIds: [guid(60)],
      ownerRenderingIds: [guid(60)],
    });
  };
  await assert.rejects(
    applicationFixture(t, { composition }),
    /Nested rendering needs one approved physical placeholder path/,
  );
  const f = await applicationFixture(t, {
    composition,
    profile(profile) {
      profile.placeholderPaths.push({
        owner: 'page:' + id(guid(41)),
        uid: guid(51),
        path: '/headless-main/content',
      });
    },
  });
  const built = await f.build();
  assert.equal(built.plan.ready, true, JSON.stringify(built.plan.issues));
  assert.equal(
    built.plan.operations.find((row) => row.kind === 'page').contexts[0].layouts[0].renderings[1].placeholder,
    '/headless-main/content',
  );
});

test('unsupported association metadata and design template inheritance are rejected', async (t) => {
  for (const [name, change] of [
    [
      'missing Page Design field',
      (state) =>
        update(state, guid(41), (item) => {
          item.fields = item.fields.filter((row) => row.name !== 'Page Design');
        }),
    ],
    [
      'Page Design has non-reference type',
      (state) =>
        update(state, guid(41), (item) => {
          item.fields.find((row) => row.name === 'Page Design').type = 'Single-Line Text';
        }),
    ],
    [
      'partial template does not inherit SXA Partial Design',
      (state) => {
        state.templates[0].baseIds = [];
      },
    ],
    [
      'page template does not inherit SXA Page Design',
      (state) => {
        state.templates[1].baseIds = [];
      },
    ],
    [
      'PartialDesigns has non-reference type',
      (state) => {
        state.templates[1].fields.find((row) => row.name === 'PartialDesigns').type = 'Single-Line Text';
      },
    ],
  ]) {
    await t.test(name, async (st) => {
      const f = await applicationFixture(st, { state: change }),
        built = await f.build();
      assert.equal(built.plan.ready, false, 'Unsupported field/template metadata must block writes');
      assert.deepEqual(built.plan.batches, []);
    });
  }
});

test('read item, request byte and observed context bounds are enforced', async (t) => {
  await assert.rejects(
    applicationFixture(t, {
      capabilities(cap) {
        cap.maxReadItems = 1;
      },
    }),
    /item bound/,
  );
  await assert.rejects(
    applicationFixture(t, {
      capabilities(cap) {
        cap.maxRequestBytes = 4096;
      },
    }),
    /byte bound/,
  );
  const f = await applicationFixture(t, {
    capabilities(cap) {
      cap.maxContexts = 1;
    },
    state(state) {
      update(state, guid(43), (item) => {
        item.contexts.push({ itemId: guid(43), language: 'en', version: 2 });
      });
    },
  });
  await assert.rejects(f.build(), /context.*bound|bound.*context/i);
});

test('write preparation emits unapproved exact review and reserves only after exact mutation approval', async (t) => {
  const f = await applicationFixture(t),
    { request, journalDirectory } = await f.prepare();
  const result = await prepare(f, request);
  assert.equal(result.executionAvailable, false);
  assert.equal((await readApplicationJournal(journalDirectory)).state.active, null);
  await assert.rejects(access(join(f.base, 'write/presentation-target-request.json')));
  const reviewBytes = await readFile(join(f.base, 'write/presentation-execution-review.json'));
  const review = { path: 'write/presentation-execution-review.json', sha256: hash(reviewBytes) };
  const decision = {
    id: 'application-mutation',
    taskId: request.taskId,
    kind: 'mutation',
    scopeId: 'demo',
    choice: 'approve',
    rationale: 'Reviewed exact synthetic operations',
    userResponse: 'Approve these writes',
    at: '2026-01-01T00:00:00Z',
    inputs: [review],
  };
  const approval = await f.put('mutation-approval.json', decision);
  const approved = await prepare(f, { ...request, review, approval }, 'approved-input.json', 'approved');
  assert.equal(approved.executionAvailable, true);
  const journal = await readApplicationJournal(journalDirectory);
  assert.equal(journal.state.active.status, 'reserved');
  assert.equal(journal.state.active.requestId, approved.requestId);
  const envelope = JSON.parse(
    await readFile(join(f.base, 'approved/presentation-target-request.json'), 'utf8'),
  );
  assert.equal(hash(envelope.parameters.RequestJson), envelope.parameters.RequestSha256);
  await assert.rejects(
    prepare(f, { ...request, review, approval }, 'replay-input.json', 'replay'),
    /must be reconciled/,
  );
});

test('write preparation rejects fresh dependency drift and approvals that omit exact review', async (t) => {
  const f = await applicationFixture(t),
    { request } = await f.prepare();
  const current = structuredClone(f.state);
  update(current, guid(43), (item) => {
    item.fields[0].rawValue = 'concurrent edit';
  });
  const currentState = await f.put('current-drift.json', current);
  await assert.rejects(prepare(f, { ...request, currentState }), /dependency drift/);
  const approval = await f.put('wrong-approval.json', {
    id: 'wrong',
    taskId: request.taskId,
    kind: 'mutation',
    scopeId: 'demo',
    choice: 'approve',
    rationale: 'Wrong review',
    userResponse: 'Approve',
    at: '2026-01-01T00:00:00Z',
    inputs: [f.review],
  });
  await assert.rejects(
    prepare(f, { ...request, approval }, 'no-review.json', 'no-review'),
    /exact prior presentation review/,
  );
  await prepare(f, request, 'review-request.json', 'review');
  const bytes = await readFile(join(f.base, 'review/presentation-execution-review.json'));
  const review = { path: 'review/presentation-execution-review.json', sha256: hash(bytes) };
  await assert.rejects(
    prepare(f, { ...request, review, approval }, 'wrong-review.json', 'wrong-review'),
    /Exact current CMS mutation approval/,
  );
});

test('template mappings decode GUID pairs and reject duplicate keys or arbitrary values', () => {
  const encoded = encodeURIComponent(guid(40) + '=' + guid(111));
  assert.deepEqual(decodeTemplateMapping(encoded), [{ templateId: id(guid(40)), designId: id(guid(111)) }]);
  assert.throws(() => decodeTemplateMapping(guid(40) + '=arbitrary'), /Non-GUID/);
  assert.throws(
    () => decodeTemplateMapping(guid(40) + '=' + guid(111) + '&' + guid(40) + '=' + guid(112)),
    /Duplicate/,
  );
});

test('final audit retains material and component dependency guards', async (t) => {
  const f = await applicationFixture(t),
    built = await f.build();
  // Isolate the non-operation guard check from receipt history: operation
  // read-back and terminal history have their own focused journal tests.
  const plan = { ...built.plan, operations: [], batches: [] },
    journal = { state: { scopeId: 'demo', target: f.profile.target, active: null, completed: [] } };
  assert.equal(verifyApplicationCompletion(plan, 'a'.repeat(64), journal, f.state), true);
  for (const [itemId, change] of [
    [
      guid(43),
      (item) => {
        item.fields[0].value = 'Changed target banner';
      },
    ],
    [
      guid(60),
      (item) => {
        item.componentName = 'ChangedTargetComponent';
      },
    ],
  ]) {
    const current = structuredClone(f.state);
    update(current, itemId, change);
    assert.throws(
      () => verifyApplicationCompletion(plan, 'a'.repeat(64), journal, current),
      /Application dependency drift/,
    );
  }
});

test('write preparation resolves the journal relative to its input manifest', async (t) => {
  const f = await applicationFixture(t),
    { request, journalDirectory } = await f.prepare();
  const result = await prepare(f, { ...request, journalDirectory: 'journal' });
  assert.equal(result.executionAvailable, false);
  const reviewBytes = await readFile(join(f.base, 'write/presentation-execution-review.json'));
  const review = { path: 'write/presentation-execution-review.json', sha256: hash(reviewBytes) };
  const approval = await f.put('relative-approval.json', {
    id: 'relative-journal',
    taskId: request.taskId,
    kind: 'mutation',
    scopeId: 'demo',
    choice: 'approve',
    rationale: 'Exact fixture review',
    userResponse: 'Approve',
    at: '2026-01-01T00:00:00Z',
    inputs: [review],
  });
  assert.equal(
    (
      await prepare(
        f,
        { ...request, journalDirectory: 'journal', review, approval },
        'relative-input.json',
        'relative-approved',
      )
    ).executionAvailable,
    true,
  );
  assert.equal((await readApplicationJournal(journalDirectory)).state.active.status, 'reserved');
});
