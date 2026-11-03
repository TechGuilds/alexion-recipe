import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the setup context template does not choose migration scope or target branch', () => {
  const template = JSON.parse(read('../assets/profiles/sitecore/context.json'));
  assert.equal(template.migration?.mode, undefined);
  assert.equal(template.target?.code?.branch, undefined);
});

test('context validation requires explicit mode and target code identity for full migration', () => {
  const validator = read('../scripts/validate-context.mjs');
  assert.match(validator, /need\(['"]migration\.mode['"]/);
  assert.match(validator, /connectors\.targetCode/);
  assert.match(validator, /target\.code\.repoName/);
  assert.match(validator, /target\.code\.branch/);
});

test('setup records supported facts through the migration artifact interface', () => {
  const contract = read('../references/migration-artifact-contract.md');
  assert.match(contract, /create-artifact/);
  assert.match(contract, /update-artifact/);
  assert.match(contract, /artifactId/);
  assert.match(contract, /content\.phases.*database IDs.*project epics/s);
  assert.doesNotMatch(contract, /Keep `phases:\s*\[\]`/);
});

test('CMS setup validates the artifact-owned workflow before running checkpoints', () => {
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  assert.match(setup, /artifact-owned Setup/);
  assert.match(setup, /Validate it/);
  assert.match(setup, /before context|context.*workflow/i);
  assert.match(setup, /S1.*S11/s);
  assert.match(setup, /needs-site-selection/);
  assert.match(setup, /re-?run.*S4|re-enter S4 only/i);
  assert.match(setup, /phase-deferred/);
  assert.match(setup, /heuristic topology.*does not stop|topology.*does not stop/i);
});

test('setup accepts connector transport normalization when probe behavior is valid', () => {
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  const developer = read('../../../agents/sitecore-developer.md');
  assert.match(setup, /hash is provenance only/i);
  assert.match(setup, /exact-byte acceptance gate/i);
  assert.match(developer, /transport-integrity gate/i);
  assert.match(developer, /terminal.*non-empty\/schema-valid.*classifier/i);
});

test('site enumeration rejects a bare array as a valid probe response', () => {
  const enumeration = read('../../sitecore/references/setup/site-enumeration.md');
  assert.match(enumeration, /bare.*\[\]|execution-contract\s+failure/i);
  assert.match(enumeration, /availableLanguages.*sites/s);
  assert.match(enumeration, /probe-sites\.ps1.*canonical source/s);
  assert.match(enumeration, /LanguageManager/);
  assert.match(enumeration, /normalization alone is not a capability failure/i);
});

test('recoverable tool-invocation errors receive one automatic corrective retry', () => {
  const cmsMigration = read('../SKILL.md');
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  assert.match(setup, /argument[- ]binding.*parameter[- ]schema.*serialization.*invocation/i);
  assert.match(setup, /one automatic corrective retry/i);
  assert.match(cmsMigration, /one automatic correction.*invocation/i);
});

test('Sitecore Setup uses focused golden probes rather than an aggregate script', () => {
  const developer = read('../../../agents/sitecore-developer.md');
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  const procedures = read('../../sitecore/scripts/setup/README.md');
  assert.match(developer, /never write.*aggregate.*Setup probe/i);
  assert.match(setup, /No aggregate custom script/i);
  assert.match(procedures, /install-spe-1322-patch.*dryRun/i);
  assert.match(procedures, /no package URL/i);
  assert.match(procedures, /graphql-query.*__typename/i);
});

test('static topology evidence does not diagnose the Layout Service before site selection', () => {
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  const topology = read('../../sitecore/references/setup/topology-and-prerequisites.md');
  assert.match(setup, /needs-site-selection.*not.*misconfigured/i);
  assert.match(topology, /preliminary.*not.*Layout Service readiness/i);
  assert.match(topology, /connector-owned.*Layout Service probe/i);
});

test('the Sitecore developer has the direct read-only file-download primitive', () => {
  const developer = read('../../../agents/sitecore-developer.md');
  assert.match(developer, /source-sitecore\/download-file/);
});

test('the Setup prerequisite record distinguishes method, verdict, and next action', () => {
  const recording = read('../../sitecore/references/setup/setup-recording-contract.md');
  assert.match(recording, /probe method/i);
  assert.match(recording, /verdict/i);
  assert.match(recording, /next action/i);
  assert.match(recording, /probe-unavailable/i);
});

test('the Sitecore developer receives every focused Setup capability tool', () => {
  const developer = read('../../../agents/sitecore-developer.md');
  assert.match(developer, /source-sitecore\/get-item/);
  assert.match(developer, /source-sitecore\/graphql-query/);
  assert.match(developer, /source-sitecore\/sitecore-get-layout/);
  assert.match(developer, /source-sitecore\/test-management-services/);
  assert.match(developer, /target-sitecore\/test-management-services/);
});

test('Setup uses the profile requirements and deterministic evaluator', () => {
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  const procedures = read('../../sitecore/scripts/setup/README.md');
  assert.match(setup, /capability-requirements\.json/);
  assert.match(setup, /evaluate-prerequisites\.mjs/);
  assert.match(procedures, /probe-spe-execution\.ps1/);
  assert.match(procedures, /test-management-services/);
  assert.match(procedures, /sitecore-get-layout/);
});

test('the user-visible Setup workflow ends with Discovery planning and has no approval task', () => {
  const workflow = JSON.parse(read('../assets/profiles/sitecore/workflow.json'));
  const setup = workflow.phases.find(phase => phase.id === 'setup');
  assert.deepEqual(
    setup.tasks.map(task => task.id),
    [
      'setup.source',
      'setup.target',
      'setup.cms',
      'setup.audit',
      'setup.prepare-discovery',
    ],
  );
  const discovery = workflow.phases.find(phase => phase.id === 'discovery');
  assert.deepEqual(discovery.tasks.find(task => task.id === 'discovery.code').dependsOn, ['setup.prepare-discovery']);
  assert.deepEqual(discovery.tasks.find(task => task.id === 'discovery.content').dependsOn, ['setup.prepare-discovery']);

  const artifact = read('../../migration-artifact/references/prepare-artifact.md');
  assert.match(artifact, /initialize only Setup in the active workflow/);
  const handoff = read('../references/start-discovery.md');
  const planning = read('../references/prepare-discovery.md');
  assert.match(planning, /actual Setup epic ID/);
  assert.match(handoff, /explicit.*phase-continuation/);
});

test('Setup resolves candidate-dependent inputs before dispatching selected-site probes', () => {
  const setup = read('../references/profiles/sitecore/pipeline/setup.md');
  assert.match(setup, /available languages before asking/i);
  assert.doesNotMatch(setup, /Batch all currently knowable Setup questions/i);
  assert.match(setup, /confirm the site before fetching its available languages/i);
  assert.match(setup, /confirm migration mode before asking mode-specific questions/i);
  assert.match(setup, /only after the user confirms both site and language/i);
});
