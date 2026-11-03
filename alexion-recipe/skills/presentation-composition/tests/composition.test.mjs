import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, guid } from './fixture.mjs';
import { buildComposition } from '../scripts/compose-presentation.mjs';
import { hash } from '../scripts/lib/common.mjs';

test('many source renderings map to one component while preserving instances, target data and provenance', async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.base, 'source.json')),
    a = await buildComposition(join(f.base, f.inputRef.path)),
    b = await buildComposition(join(f.base, f.inputRef.path));
  assert.deepEqual(a.plan, b.plan);
  assert.equal(a.plan.ready, true);
  assert.equal(a.plan.pages[0].renderings.length, 2);
  assert.notEqual(a.plan.pages[0].renderings[0].uid, a.plan.pages[0].renderings[1].uid);
  assert.deepEqual(a.plan.templateAssignments, [
    { templateId: guid(40).slice(1, -1), pageDesignKey: 'standard' },
  ]);
  assert.equal(a.plan.targetWrites, false);
  assert.deepEqual(await readFile(join(f.base, 'source.json')), before);
});
test('effective page overrides are authoritative and removed template defaults are not reintroduced', async (t) => {
  const f = await fixture(t, (d) => {
    d.source.pages[0].overrideUids = [guid(50)];
    d.source.pages[0].effective = [
      { ...d.source.pages[0].effective[0], origin: 'page-override', ownerId: guid(11) },
    ];
  });
  const { plan } = await buildComposition(join(f.base, f.inputRef.path));
  assert.equal(plan.ready, true);
  assert.equal(plan.pages[0].renderings.length, 1);
  assert.equal(plan.pages[0].sourceEvidence.templateDefaultUids.length, 2);
});
test('target defaults require an explicit preserve or replace policy and removals remain visible', async (t) => {
  for (const policy of ['preserve', 'replace']) {
    const f = await fixture(t, (d) => {
      d.target.templates[0].defaults = [
        {
          uid: guid(90),
          renderingId: guid(60),
          placeholder: 'headless-main',
          parameters: {},
          datasourceId: guid(43),
        },
      ];
      d.rules.pages[0].defaultPolicy = policy;
    });
    const { plan } = await buildComposition(join(f.base, f.inputRef.path));
    assert.equal(plan.ready, true);
    assert.equal(plan.pages[0].renderings.length, policy === 'preserve' ? 3 : 2);
    assert.equal(plan.pages[0].removedDefaultUids.length, policy === 'replace' ? 1 : 0);
  }
});
test('explicit partial/page designs group approved occurrences and reuse inventoried compatible designs', async (t) => {
  const f = await fixture(t, (d) => {
    d.rules.partialDesigns = [{ key: 'header', name: 'Header', reuseId: guid(110) }];
    d.rules.pageDesigns[0].partialKeys = ['header'];
    d.rules.pageDesigns[0].reuseId = guid(111);
    d.rules.occurrences = [{ sourcePageId: guid(11), sourceUid: guid(50), partialKey: 'header' }];
    d.target.partialDesigns = [
      {
        id: guid(110),
        renderings: [
          {
            uid: guid(120),
            renderingId: guid(60),
            placeholder: 'headless-main',
            parameters: {},
            datasourceId: guid(43),
          },
        ],
      },
    ];
    d.target.pageDesigns = [{ id: guid(111), layoutId: guid(70), partialIds: [guid(110)] }];
  });
  const { plan } = await buildComposition(join(f.base, f.inputRef.path));
  assert.equal(plan.ready, true);
  assert.equal(plan.pages[0].renderings.length, 1);
  assert.equal(plan.partialDesigns[0].renderings[0].uid, guid(120));
});
test('nested placeholders keep parent-child relationships and reject cycles or cross-owner splits', async (t) => {
  const f = await fixture(t, (d) => {
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
  });
  const { plan } = await buildComposition(join(f.base, f.inputRef.path));
  assert.equal(plan.ready, true);
  assert.equal(plan.pages[0].renderings[1].parentUid, guid(50));
});
test('missing, ambiguous, incompatible and stale evidence fail closed', async (t) => {
  const cases = [
    (d) =>
      d.mapping.renderings[0].target.push({ ...d.mapping.renderings[0].target[0], renderingId: guid(62) }),
    (d) => d.identities.bindings.push({ ...d.identities.bindings[1], outputKey: 'other' }),
    (d) => (d.target.renderings[0].datasourceTemplateIds = [guid(999)]),
    (d) => (d.target.placeholders[0].allowedRenderingIds = []),
    (d) => (d.source.pages[0].effective[0].origin = 'page-override'),
    (d) => (d.rules.pages[0].excludeDefaultUids = [guid(999)]),
  ];
  for (const change of cases) {
    const f = await fixture(t, change);
    assert.equal((await buildComposition(join(f.base, f.inputRef.path))).plan.ready, false);
  }
  const stale = await fixture(t, (d) => (d.targetData.expiresAt = '2020-01-01T00:00:00Z'));
  await assert.rejects(buildComposition(join(stale.base, stale.inputRef.path)), /stale/);
});
test('incomplete SXA evidence, unsafe artifact paths and changed approval inputs are rejected', async (t) => {
  const incomplete = await fixture(t, (d) => (d.source.pages[0].sxaExpanded = false));
  await assert.rejects(buildComposition(join(incomplete.base, incomplete.inputRef.path)), /source/);
  const f = await fixture(t);
  await writeFile(join(f.base, 'rules.json'), '{}');
  await assert.rejects(buildComposition(join(f.base, f.inputRef.path)), /SHA/);
  const unsafe = { ...f.input, rules: { path: '../rules.json', sha256: hash('{}') } };
  const request = await f.put('unsafe.json', unsafe);
  await assert.rejects(buildComposition(join(f.base, request.path)), /manifest-relative/);
});
test('fresh output only and explicit exclusions retain reasons', async (t) => {
  const f = await fixture(t, (d) =>
    d.rules.occurrences.push({
      sourcePageId: guid(11),
      sourceUid: guid(51),
      excludeReason: 'Approved redundant source occurrence',
    }),
  );
  const result = await f.compose();
  assert.equal(result.value.exclusions.length, 1);
  await assert.rejects(f.compose(), /exist/i);
  await assert.rejects(access(join(f.base, 'target-write.json')));
});

test('page and datasource outputs split from the same source item use explicit verified target selections', async (t) => {
  const f = await fixture(t, (d) => {
    d.source.pages[0].effective[0].datasourceId = null;
    d.identities.bindings.push({
      sourceItemId: guid(11),
      targetItemId: guid(43),
      outputKey: 'split-banner',
      status: 'verified',
    });
    d.rules.occurrences.push({
      sourcePageId: guid(11),
      sourceUid: guid(50),
      datasourceSourceId: guid(11),
      outputKey: 'split-banner',
    });
  });
  const { plan } = await buildComposition(join(f.base, f.inputRef.path));
  assert.equal(plan.ready, true);
  assert.equal(plan.pages[0].targetPageId, guid(41));
  assert.equal(plan.pages[0].renderings[0].datasourceId, guid(43));
});

test('source Partial Design occurrences require inspected dependency records, not a completeness flag alone', async (t) => {
  for (const inspected of [false, true]) {
    const f = await fixture(t, (d) => {
      const occurrence = d.source.pages[0].effective[0];
      occurrence.origin = 'partial-design';
      occurrence.ownerId = guid(300);
      if (inspected)
        d.source.partialDesigns.push({ id: guid(300), renderings: [structuredClone(occurrence)] });
    });
    const { plan } = await buildComposition(join(f.base, f.inputRef.path));
    assert.equal(plan.ready, inspected);
  }
});
