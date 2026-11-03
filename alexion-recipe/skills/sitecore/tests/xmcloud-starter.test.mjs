import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The starter facts are data the target-app-init procedure reads. They came from the retired migration-init,
// and moving any of them changes what every new target is built from, so a change must be deliberate.
const config = JSON.parse(readFileSync(new URL('../assets/setup/xmcloud-starter.json', import.meta.url)));

test('the pinned starter matches the values migration-init used', () => {
  assert.equal(config.repository, 'https://github.com/Sitecore/xmcloud-starter-js');
  assert.equal(config.ref, '76c445b3163b8aea48dc4cff46eaabbaf89c69dc');
  assert.equal(config.examplePath, 'examples/kit-nextjs-skate-park');
  assert.deepEqual(config.removeAfterClone, ['.github/workflows/dmz-validation.yml', '.github/workflows/pr-validation.yml']);
  assert.deepEqual(config.renderingHost, { nodeVersion: '20.18.0', jssDeploymentSecret: 'SECRET_FOR_LOCAL_DEV_ONLY', enabled: true });
});

test('the .gitignore lines keep dependencies, build output and local env files out of the repository', () => {
  for (const line of ['node_modules/', '.next/', '.env.local', '.env.production.local']) assert.ok(config.gitignore.includes(line), line);
});

test('the procedure documents the same pins and commands the data file holds', () => {
  const doc = readFileSync(new URL('../references/setup/target-app-init.md', import.meta.url), 'utf8');
  for (const value of [config.renderingHost.nodeVersion, config.renderingHost.jssDeploymentSecret, ...config.removeAfterClone.map(p => p.split('/').pop())]) {
    assert.ok(doc.includes(value), `the doc must show ${value}`);
  }
  assert.ok(doc.includes('git archive'), 'the clean copy must not depend on removing history afterwards');
});
