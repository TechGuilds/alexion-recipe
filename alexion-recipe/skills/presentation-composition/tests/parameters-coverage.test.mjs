import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, guid } from './fixture.mjs';
import { buildComposition } from '../scripts/compose-presentation.mjs';

function withParameters(d) {
  d.source.parameterTemplates = [
    {
      id: guid(200),
      fields: [{ id: guid(201), name: 'Style', type: 'Droplist', declaringTemplateId: guid(200) }],
    },
  ];
  for (const [index, row] of d.source.pages[0].effective.entries()) {
    row.parameterTemplateId = guid(200);
    row.parameters = { [guid(201)]: index === 0 ? 'hero' : 'promo' };
  }
  d.target.renderings[0].parameterTemplateIds = [guid(203)];
  d.target.renderings[0].parameterFields = [
    { id: guid(202), name: 'Variant', type: 'Droplist', declaringTemplateId: guid(203) },
  ];
  d.target.renderings[0].variantParameter = 'Variant';
  d.target.renderings[0].variants = ['hero', 'promo'];
  const ref = (id, name) => ({
    templateId: guid(id),
    templateName: name,
    path: '/sitecore/templates/' + name,
    baseTemplates: [],
  });
  d.mapping.templates.push({
    source: [ref(200, 'SourceParameters')],
    target: [ref(203, 'TargetParameters')],
    fields: [
      {
        action: 'map',
        sfid: guid(201),
        from: 'Style',
        tfid: guid(202),
        to: 'Variant',
        targetTemplate: 'TargetParameters',
        targetTemplateId: guid(203),
      },
    ],
    warnings: [],
  });
  d.rules.requiredCoverage = [
    { renderingId: guid(60), variant: 'hero' },
    { renderingId: guid(60), variant: 'promo' },
  ];
}
test('parameter field mappings preserve variants and coverage tracks each target rendering/variant pair', async (t) => {
  const f = await fixture(t, withParameters),
    preview = await f.preview();
  assert.equal(preview.report.ready, true);
  assert.equal(preview.value.requiredCoverage.length, 2);
  assert.deepEqual(
    preview.composed.value.pages[0].renderings.map((r) => r.parameters.Variant),
    ['hero', 'promo'],
  );
});
test('parameter constants/removals are explicit and incompatible or unmapped values block composition', async (t) => {
  const constant = await fixture(t, (d) => {
    withParameters(d);
    const group = d.mapping.templates[1];
    group.fields = [
      { action: 'remove', sfid: guid(201), from: 'Style' },
      {
        action: 'set',
        tfid: guid(202),
        to: 'Variant',
        value: 'hero',
        targetTemplate: 'TargetParameters',
        targetTemplateId: guid(203),
      },
    ];
    d.rules.requiredCoverage = [{ renderingId: guid(60), variant: 'hero' }];
  });
  assert.equal((await constant.preview()).report.ready, true);
  for (const change of [
    (d) => (d.source.parameterTemplates[0].fields[0].type = 'Image'),
    (d) => (d.source.pages[0].effective[0].parameters[guid(250)] = 'unmapped'),
    (d) => (d.target.renderings[0].variants = ['other']),
  ]) {
    const f = await fixture(t, (d) => {
      withParameters(d);
      change(d);
    });
    assert.equal((await buildComposition(join(f.base, f.inputRef.path))).plan.ready, false);
  }
});
test('parameter-to-datasource mappings require actual migrated field evidence instead of copying source values into preview', async (t) => {
  const f = await fixture(t, (d) => {
    withParameters(d);
    d.target.renderings[0].parameterFields = [];
    d.target.renderings[0].parameterTemplateIds = [];
    delete d.target.renderings[0].variantParameter;
    d.target.renderings[0].variants = [];
    d.mapping.templates[1].target = [
      {
        templateId: guid(42),
        templateName: 'BannerData',
        path: '/sitecore/templates/BannerData',
        baseTemplates: [],
      },
    ];
    d.mapping.templates[1].fields = [
      {
        action: 'map',
        sfid: guid(201),
        from: 'Style',
        tfid: guid(204),
        to: 'Style',
        targetTemplate: 'BannerData',
        targetTemplateId: guid(42),
      },
    ];
    for (const [index, item] of d.targetData.items.slice(1).entries()) {
      item.fieldIds = { [guid(204)]: 'Style' };
      item.fields.Style = { value: index === 0 ? 'hero' : 'promo' };
    }
    d.rules.requiredCoverage = [{ renderingId: guid(60), variant: '' }];
  });
  const preview = await f.preview();
  assert.equal(preview.report.ready, true);
  assert.deepEqual(preview.composed.value.pages[0].renderings[0].parameters, {});
});
function secondPage(d) {
  d.source.pages.push({ ...structuredClone(d.source.pages[0]), id: guid(12) });
  d.rules.pages.push({
    ...structuredClone(d.rules.pages[0]),
    sourcePageId: guid(12),
    targetPageId: guid(45),
    route: '/second',
  });
  d.identities.bindings.push({
    sourceItemId: guid(12),
    targetItemId: guid(45),
    outputKey: 'page',
    status: 'verified',
  });
  d.targetData.items.push({
    ...structuredClone(d.targetData.items[0]),
    id: guid(45),
    path: '/sitecore/content/Target/Second',
    name: 'Second',
  });
}
test('shared partial conflicts and template association conflicts remain explicit blockers', async (t) => {
  const partial = await fixture(t, (d) => {
    secondPage(d);
    d.rules.partialDesigns = [{ key: 'shared', name: 'Shared' }];
    d.rules.pageDesigns[0].partialKeys = ['shared'];
    d.rules.occurrences = [11, 12].map((page) => ({
      sourcePageId: guid(page),
      sourceUid: guid(50),
      partialKey: 'shared',
    }));
    d.rules.occurrences[1].outputKey = 'local';
    d.identities.bindings[1].sourcePageId = guid(11);
    d.identities.bindings.push({
      sourceItemId: guid(30),
      sourcePageId: guid(12),
      targetItemId: guid(44),
      outputKey: 'local',
      status: 'verified',
    });
  });
  assert.equal((await buildComposition(join(partial.base, partial.inputRef.path))).plan.ready, false);
  const association = await fixture(t, (d) => {
    secondPage(d);
    d.rules.pageDesigns.push({ ...d.rules.pageDesigns[0], key: 'other', name: 'Other' });
    d.rules.pages[1].pageDesignKey = 'other';
  });
  assert.equal((await buildComposition(join(association.base, association.inputRef.path))).plan.ready, false);
});
test('multiple page choices satisfy the minimum without synthetic examples or automatic scope reduction', async (t) => {
  const f = await fixture(t, secondPage),
    preview = await f.preview(2);
  assert.equal(preview.report.ready, true);
  assert.equal(preview.value.selectedRoutes.length, 2);
  assert.equal(preview.value.pages.length, 2);
  const collision = await fixture(t, (d) => {
    secondPage(d);
    d.rules.pages[1].route = '/home';
  });
  await assert.rejects(buildComposition(join(collision.base, collision.inputRef.path)), /route\/output/);
});
