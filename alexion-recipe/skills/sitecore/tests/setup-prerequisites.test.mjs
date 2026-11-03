import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrerequisites, selectHsPackage } from '../scripts/setup/evaluate-prerequisites.mjs';

const ready = {
  topology: { verdict: 'ready', topology: 'xp', kernelVersion: '10.4.0' },
  headlessServices: { installed: 'ready', licensed: 'ready' },
  itemService: { verdict: 'ready' },
  graphql: { verdict: 'ready' },
  layoutService: { verdict: 'ready' },
  managementServices: { verdict: 'ready' },
  spe: { scriptExecution: 'ready', fileDownload: 'ready', issue1322: 'not-affected' },
  siteSelection: { verdict: 'ready', site: 'example-site', language: 'en' },
};

test('strict headless migration is ready only when all required capabilities are ready', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpheadless2sai',
    workflowMode: 'full-migration',
    capabilities: ready,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.blockers.length, 0);
  assert.equal(result.applicability.layoutService, 'required');
  assert.equal(result.applicability.headlessServicesLicensed, 'required');
});

test('content read accepts either authenticated Item Service or GraphQL', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpheadless2sai',
    workflowMode: 'full-migration',
    capabilities: {
      ...ready,
      itemService: { verdict: 'unreachable' },
      graphql: { verdict: 'ready' },
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.blockers.length, 0);
});

test('required management evidence blocks when the connector probe is unavailable', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpheadless2sai',
    workflowMode: 'full-migration',
    capabilities: {
      ...ready,
      managementServices: { verdict: 'probe-unavailable' },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockers.map(({ capability }) => capability), ['managementServices']);
});

test('site-dependent readiness requests selection instead of diagnosing a fault', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpheadless2sai',
    workflowMode: 'full-migration',
    capabilities: {
      ...ready,
      layoutService: { verdict: 'needs-site-selection' },
      siteSelection: { verdict: 'needs-site-selection' },
    },
  });
  assert.equal(result.status, 'needs-site-selection');
  assert.equal(result.blockers.length, 0);
});

test('MVC discovery-only treats HS installation and Layout Service as non-blocking', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpmvc2sai',
    workflowMode: 'discovery-only',
    capabilities: {
      ...ready,
      headlessServices: { installed: 'missing', licensed: 'unknown' },
      layoutService: { verdict: 'missing' },
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.applicability.layoutService, 'mock-replaceable');
  assert.equal(result.applicability.headlessServicesInstalled, 'optional');
  assert.equal(result.applicability.headlessServicesLicensed, 'n/a');
});

test('MVC full migration still requires HS installation and recommends the matching package', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpmvc2xpheadless',
    workflowMode: 'full-migration',
    capabilities: {
      ...ready,
      headlessServices: { installed: 'missing', licensed: 'unknown' },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].capability, 'headlessServices.installed');
  assert.equal(result.recommendations[0].action, 'install-headless-services');
  assert.equal(result.recommendations[0].package.hsVersion, '22.0.11');
  assert.equal(result.recommendations[0].package.topology, 'xp');
});

test('package selection refuses an unsupported kernel instead of guessing', () => {
  assert.equal(selectHsPackage({ topology: 'xp', kernelVersion: '9.3.0' }), null);
});

test('an unknown migration type fails closed', () => {
  assert.throws(
    () =>
      evaluatePrerequisites({
        migrationType: 'invented-migration',
        workflowMode: 'full-migration',
        capabilities: ready,
      }),
    /Unknown Sitecore migration type/,
  );
});

test('a missing or invalid workflow mode never defaults to full migration', () => {
  assert.throws(
    () =>
      evaluatePrerequisites({
        migrationType: 'xpheadless2sai',
        capabilities: ready,
      }),
    /Explicit workflow mode/,
  );
  assert.throws(
    () =>
      evaluatePrerequisites({
        migrationType: 'xpheadless2sai',
        workflowMode: 'invented-mode',
        capabilities: ready,
      }),
    /Explicit workflow mode/,
  );
});

test('records Item Service as the verified alternative when GraphQL is unavailable', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpmvc2sai', workflowMode: 'discovery-only',
    capabilities: { ...ready, graphql: { verdict: 'unreachable', detail: 'Endpoint returned HTML' } },
  });
  assert.equal(result.status, 'complete');
  assert.ok(result.recommendations.some(r => r.action === 'use-item-service'));
  assert.ok(!result.recommendations.some(r => r.action === 'use-graphql'));
});

test('records GraphQL as the verified alternative when Item Service is unavailable', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpmvc2sai', workflowMode: 'discovery-only',
    capabilities: { ...ready, itemService: { verdict: 'unreachable' } },
  });
  assert.equal(result.status, 'complete');
  assert.ok(result.recommendations.some(r => r.action === 'use-graphql'));
});

test('does not invent a content read fallback when both services are unavailable', () => {
  const result = evaluatePrerequisites({
    migrationType: 'xpmvc2sai', workflowMode: 'discovery-only',
    capabilities: { ...ready, itemService: { verdict: 'probe-unavailable' }, graphql: { verdict: 'unreachable' } },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.some(b => b.capability === 'contentRead'));
  assert.ok(!result.recommendations.some(r => ['use-item-service', 'use-graphql'].includes(r.action)));
});

test('recommends mock layouts only when the active migration permits replacement', () => {
  const capabilities = { ...ready, layoutService: { verdict: 'unreachable', detail: 'Missing API key' } };
  const mvc = evaluatePrerequisites({ migrationType: 'xpmvc2sai', workflowMode: 'discovery-only', capabilities });
  assert.equal(mvc.status, 'complete');
  assert.ok(mvc.recommendations.some(r => r.action === 'use-mock-layouts'));
  const headless = evaluatePrerequisites({ migrationType: 'xpheadless2sai', workflowMode: 'full-migration', capabilities });
  assert.equal(headless.status, 'blocked');
  assert.ok(headless.blockers.some(b => b.capability === 'layoutService'));
  assert.ok(!headless.recommendations.some(r => r.action === 'use-mock-layouts'));
});
