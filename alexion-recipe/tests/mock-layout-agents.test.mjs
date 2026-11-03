import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const recipe = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['orchestrator', 'sitecore-developer', 'frontend-developer', 'tester'];
const agents = Object.fromEntries(names.map(name => [name, readFileSync(resolve(recipe, 'agents', `${name}.md`), 'utf8').replace(/\r\n/g, '\n')]));
const runbook = '../skills/sitecore/references/discovery/rendering-preview-flow.md';

function section(name, heading) {
  const body = agents[name].split(`## ${heading}\n`)[1];
  assert.ok(body, `${name} must assign an explicit ${heading} responsibility`);
  return body.split(/\n## /)[0];
}

function requires(body, tokens) {
  for (const token of tokens) assert.ok(body.includes(token), `Missing instruction contract: ${token}`);
}

test('each role links the shared rendering-preview procedure and keeps lifecycle ownership', () => {
  for (const name of names) {
    assert.ok(agents[name].includes(`](${runbook})`), `${name} must link the authoritative runbook`);
    assert.ok(existsSync(resolve(recipe, 'agents', runbook)), 'the linked runbook must ship with the recipe');
    requires(agents[name], ['managing-kajoo-tasks', 'TASK_RESULT', 'Technical report']);
  }
});

test('coordinator persists scope and schedules approved capture without discarding core progress', () => {
  const body = section('orchestrator', 'Rendering preview coordination');
  requires(body, ['renderingRoots', 'RenderingRootsJson', 'omit', 'null', '[]',
    'includedRenderingIds', 'buildRenderingCapturePlan', 'draft',
    'durable', 'static', 'parallel', 'one', 'timeout', 'owner', 'reason',
    'not-attempted', 'unavailable', 'Discovery', 'delivery', 'human']);
  assert.ok(body.indexOf('renderingRoots') < body.indexOf('buildRenderingCapturePlan'), 'scope interview precedes capture authorization');
  assert.doesNotMatch(body, /flip[^.\n]*draft|set\s+draft\s*[:=]\s*false/i);
});

test('platform owner separates complete inventory from approved minimum-page capture', () => {
  const body = section('sitecore-developer', 'Rendering inventory and preview capture');
  requires(body, ['RenderingRootsJson', 'xp-discovery-v3.ps1', 'rendering-mapping-inventory.json',
    'rendering-capture-plan.json', 'buildRenderingCapturePlan', 'includedRenderingIds',
    'prepare-capture-request.mjs', 'fetch-layouts.mjs', 'process-capture-results.mjs',
    'capture-mock-layouts.ps1', 'assemble-mvc-captures.mjs', 'mappingInventorySha256',
    'not-attempted', 'not-requested', 'unavailable', 'minimumProven',
    'target-sitecore/get-item', 'target-sitecore/graphql-query', 'target-sitecore/run-powershell-script',
    'renderings: []', 'create-target-inventory.mjs']);
  assert.doesNotMatch(agents['sitecore-developer'], /frontend-developer runs[^.]*fetch-layouts|post-synthesis pre-warm/);
});

test('frontend waits for content scope and deploys only reviewed mapping and preview evidence', () => {
  const body = section('frontend-developer', 'Rendering mapping and local preview delivery');
  requires(body, ['static', 'parallel', 'rendering-capture-plan.json', 'sitecore-developer',
    'reuse-target', 'implement-missing', 'disregard', 'mapping-required',
    'build-component-migration-plan.mjs', 'apply-component-mappings.mjs',
    'selectedRequirementKeys', 'build-component-examples.mjs', 'visualValidation',
    'prepare-preview-navigation.mjs', 'deployment-manifest.json',
    '--preview-stage', '--preview-stage-sha256', '--dry-run', '--apply',
    "USE_MOCK_LAYOUT_SERVICE === 'true'", 'placeholder', 'target contract']);
  assert.doesNotMatch(agents['frontend-developer'], /direct-sitemap retry|bounded initial\s+capture|before usage analysis|mcpCredentials\.source/);
});

test('tester checks native contracts without conflating capture, HTTP, mapping and human parity', () => {
  const body = section('tester', 'Rendering preview evidence audit');
  requires(body, ['validate-sitecore-artifact.mjs', '--kind', '--file', '--sha256', 'rendering-capture-plan',
    'capture-result', 'mock-preview-deployment', 'warning', 'error', 'skipped',
    'not-attempted', 'not-requested', 'unavailable', '404', 'human',
    'synthetic', 'mapping-required', 'current', 'hash',
    'not-captured', 'capture-failed', 'target-absent', 'target-unverified', 'mapping-only', 'captured']);
  assert.doesNotMatch(body, /(?:HTTP 200|exit 0) (?:proves|establishes) (?:parity|completion)/i);
});

test('agent flow cannot silently restore the retired discovery-wide fetch defaults', () => {
  const combined = Object.values(agents).join('\n');
  assert.doesNotMatch(combined, /maxUrls\s*[:=]\s*25|direct-sitemap retry|post-synthesis pre-warm/);
  assert.doesNotMatch(combined, /(?:run|invoke|call)\s+`?migration-work-init/i);
});

test('agent handoffs name existing portable entrypoints rather than replacement backend tools', async () => {
  const entrypoints = [
    'sitecore/scripts/analysis/build-rendering-capture-plan.mjs',
    'sitecore/scripts/capture/prepare-capture-request.mjs',
    'sitecore/scripts/capture/fetch-layouts.mjs',
    'sitecore/scripts/capture/process-capture-results.mjs',
    'sitecore/scripts/capture/capture-mock-layouts.ps1',
    'sitecore/scripts/capture/assemble-mvc-captures.mjs',
    'sitecore/scripts/mapping/create-target-inventory.mjs',
    'sitecore/scripts/mapping/build-component-migration-plan.mjs',
    'sitecore/scripts/mapping/apply-component-mappings.mjs',
    'sitecore/scripts/capture/build-component-examples.mjs',
    'sitecore/scripts/preview/prepare-preview-navigation.mjs',
    'sitecore/scripts/validate-sitecore-artifact.mjs',
    'sitecore-headless-to-xmc/scripts/scaffold-mock-service.mjs',
  ];
  for (const entrypoint of entrypoints) {
    assert.ok(existsSync(resolve(recipe, 'skills', entrypoint)), `Missing portable entrypoint: ${entrypoint}`);
    assert.ok(Object.values(agents).some(body => body.includes(entrypoint.split('/').at(-1))), `Missing handoff: ${entrypoint}`);
  }
  const planner = await import('../skills/sitecore/scripts/analysis/build-rendering-capture-plan.mjs');
  assert.equal(typeof planner.buildRenderingCapturePlan, 'function', 'approved-plan preparation must use the actual native export');
});
