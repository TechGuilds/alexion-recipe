import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest } from '../scripts/prepare-request.mjs';

test('composes an authenticated-tool request, not local SPE execution', async () => {
  const parameters = { SitePath: '/sitecore/content/Demo', Languages: ['en', 'fr'] };
  const result = await prepareRequest({ operation: 'discover-site', parameters });
  assert.match(result.script, /function Read-KajooItems/);
  assert.match(result.script, /Start-KajooExport 'discovery'/);
  assert.match(result.script, /finally/);
  assert.deepEqual(result.parameters, parameters);
  assert.equal(result.background, true);
  assert.deepEqual(result.output, { mode: 'files' });
  assert.doesNotMatch(result.script, /\. \/mnt\/skills/);
});
test('explicit foreground and destination are independent', async () => {
  const result = await prepareRequest({ operation: 'export-richtext', parameters: {SitePath:'/sitecore/content/Demo'}, background: false, destination:'migration/discovery' });
  assert.equal(result.background, false);
  assert.deepEqual(result.output, {mode:'files', destination:'migration/discovery'});
});
test('retains the MVC/runtime discovery capture operations as separate shipped scripts', async () => {
  const cases = [
    ['capture-mock-layouts', /capture-mock-layouts|License-free mock-layouts capture/],
    ['capture-mock-dictionary', /capture-mock-dictionary|License-free mock-dictionary capture/],
    ['export-richtext-structures', /export-richtext-structures|Rich Text rendering and datasource structures/],
  ];
  for (const [operation, marker] of cases) {
    const result = await prepareRequest({ operation, parameters: { SitePath: '/sitecore/content/Demo' } });
    assert.match(result.script, marker, operation);
    assert.equal(result.background, true);
    assert.equal(result.output.mode, 'files');
  }
});
test('keeps the optional layout-folder enrichment as a prepared golden script', async () => {
  const result = await prepareRequest({ operation: 'discover-layout-folders', parameters: { siteRootPath: '/sitecore/content/Demo' } });
  assert.match(result.script, /Discover layout folders|uniqueLayoutFolders|serializationIncludes/);
  assert.equal(result.output.mode, 'files');
});
test('rendering coverage uses the existing authenticated source connector export path', async () => {
  const parameters = { SitePath: '/sitecore/content/Demo', RenderingIds: ['{11111111-1111-1111-1111-111111111111}'], RenderingNames: ['Hero'], Languages: ['en'], Database: 'master', Version: 'latest', Devices: ['{22222222-2222-2222-2222-222222222222}'] };
  const result = await prepareRequest({ operation: 'analyze-rendering-coverage', parameters });
  assert.match(result.script, /coverage\.jsonl/);
  assert.match(result.script, /Complete-KajooExport/);
  assert.equal(result.output.mode, 'files');
  assert.doesNotMatch(result.script, /Get-ItemReferrer/);
  for (const key of ['Devices', 'SitePath', 'RenderingIds', 'Database', 'Languages', 'Version']) {
    const missing = { ...parameters }; delete missing[key];
    await assert.rejects(prepareRequest({ operation: 'analyze-rendering-coverage', parameters: missing }), new RegExp(key));
  }
});
test('rejects arbitrary scripts, unsafe destinations and scalar parameters', async () => {
  await assert.rejects(prepareRequest({operation:'../../other', parameters:{}}), /Unknown/);
  await assert.rejects(prepareRequest({operation:'discover-site', parameters:[]}), /object/);
  for (const destination of ['../secret', '/source', 'a/../b', 'C:\\data']) {
    await assert.rejects(prepareRequest({operation:'discover-site', parameters:{}, destination}), /relative/);
  }
});

test('presentation requests fail locally for omitted scope, misspelled parameters or empty batches', async () => {
  const parameters = { ItemPaths: ["/sitecore/content/Demo/What's new!"], Devices: ['fe5d7fdf-64b8-446f-a16c-12cea264723b'], Database: 'master', Languages: ['fr'], Version: 'latest' };
  for (const key of Object.keys(parameters)) {
    const missing = { ...parameters }; delete missing[key];
    await assert.rejects(prepareRequest({ operation: 'inspect-presentation', parameters: missing }), new RegExp(key));
  }
  await assert.rejects(prepareRequest({ operation: 'inspect-presentation', parameters: { ...parameters, ItemPaths: [] } }), /ItemPaths/);
  await assert.rejects(prepareRequest({ operation: 'inspect-presentation', parameters: { ...parameters, Devices: ['Default'] } }), /Devices/);
  await assert.rejects(prepareRequest({ operation: 'inspect-presentation', parameters: { ...parameters, Device: parameters.Devices } }), /Unknown.*Device/);
  const valid = await prepareRequest({ operation: 'inspect-presentation', parameters });
  assert.deepEqual(valid.parameters, parameters);
});

test('dependency requests accept bounded structured seeds and reject ambiguous input locally', async () => {
  const parameters = { Seeds: [{ reference: '/sitecore/content/Demo', kind: 'content', recursive: true }], Devices: ['fe5d7fdf-64b8-446f-a16c-12cea264723b'], Database: 'master', Languages: ['en'], Version: 'latest', MaxItems: 10000 };
  const result = await prepareRequest({ operation: 'inspect-dependencies', parameters });
  assert.deepEqual(result.parameters, parameters);
  assert.equal(result.background, true);
  assert.equal(result.output.mode, 'files');
  assert.match(result.script, /dependency-edges\.jsonl/);
  for (const Seeds of [[], [{ reference: 'query:./*', kind: 'content' }], [{ reference: '/sitecore/content/Demo', kind: 'content', recursive: 'true' }], [{ reference: '/sitecore/content/Demo', kind: 'invented' }]]) {
    await assert.rejects(prepareRequest({ operation: 'inspect-dependencies', parameters: { ...parameters, Seeds } }), /Seeds/);
  }
  await assert.rejects(prepareRequest({ operation: 'inspect-dependencies', parameters: { ...parameters, Devices: undefined } }), /Devices/);
});
