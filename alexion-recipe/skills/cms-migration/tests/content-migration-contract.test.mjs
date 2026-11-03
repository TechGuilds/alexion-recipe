import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const skillRoot = path.resolve(import.meta.dirname, '..');
const recipeRoot = path.resolve(skillRoot, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(skillRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('Sitecore content phase has an evidence-led, ordered transfer contract', () => {
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'content-migration.md');
  const required = [
    'target-adoption', 'source and target', 'duplicate', 'approved exclusions',
    'template remap', 'source pull', 'local validation', 'dry-run',
    'sequential', 'target read-back', 'tester audit',
  ];
  for (const phrase of required) assert.match(profile, new RegExp(phrase, 'i'), phrase);

  assert.match(profile, /no automatic exclusion/i);
  assert.match(profile, /exact namespace/i);
  assert.doesNotMatch(profile, /compile-task-scopes/i);
  assert.match(profile, /validate-transfer-plan/i);
  assert.match(profile, /task\s+grouping[\s\S]*not a reason[\s\S]*omit/i);
  assert.match(profile, /plan-batches/i);
  assert.match(profile, /dependency-closure/i);
  assert.match(profile, /terminal audit/i);
  assert.match(profile, /latest target mutation/i);
  assert.match(profile, /language\/version/i);
  assert.match(profile, /mismatch.*block/i);
  assert.match(profile, /deterministic task entry/i);
  assert.match(profile, /only initial source\s+of scope/i);
  assert.match(profile, /do \*\*not\*\*\s+enumerate a source root/i);
  assert.match(profile, /stages 1–4 as one bounded non-mutating group/i);
  assert.match(profile, /automatic terminal delivery/i);
  assert.match(profile, /Do not compile or revise task roots here/i);
  assert.match(profile, /return[\s\S]*Discovery planning/i);
  assert.match(profile, /not a requirement to create one user-visible\s+task per row/i);
  assert.match(profile, /standalone scope-reconstruction task/i);
  assert.match(profile, /one phase-level shared capture foundation/i);
  assert.match(profile, /all approved transfer tasks/i);
  assert.match(profile, /user-approved task boundary stable/i);
  assert.match(profile, /canonical `serialization-scope\.json`/i);
  assert.match(profile, /Sitecore CLI validation is authoritative/i);
  assert.match(profile, /soft reference.*not.*ordering/i);
  const historicalRecipeTerms = [
    ["pre", "cleanup"].join("-"),
    ["legacy", "recipe"].join(" "),
    ["previous", "recipe"].join(" "),
  ];
  assert.doesNotMatch(profile, new RegExp(historicalRecipeTerms.join("|"), "i"));
});

test('Sitecore phase catalog offers complete content work examples without forcing one task size', () => {
  const catalog = JSON.parse(read('assets', 'profiles', 'sitecore', 'phase-catalog.json'));
  const content = catalog.goldenExamples.find(({ key }) => key === 'content-migration');
  assert.ok(content);
  assert.match(content.taskPatterns.join(' '), /namespace|site-section|milestone/i);
  assert.match(content.tasks.join(' '), /adoption.*capability.*scope/i);
  assert.match(content.tasks.join(' '), /pull.*local(ly)? validate/i);
  assert.match(content.tasks.join(' '), /dry-run.*push.*read back/i);
  assert.match(content.tasks.join(' '), /reus(e|ing).*target-adoption.*capability/i);
  assert.match(content.acceptanceEvidence.join(' '), /languages\/versions/i);
});

test('Generic coordination reuses compatible phase evidence instead of rediscovering it', () => {
  const generic = read('SKILL.md');
  const orchestrator = fs.readFileSync(path.join(recipeRoot, 'agents', 'orchestrator.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(generic, /Evidence reuse is the default for every phase/i);
  assert.match(generic, /later phase consuming Discovery evidence never turns that need into\s+another Discovery task/i);
  assert.match(orchestrator, /Evidence reuse is mandatory across phases/i);
  assert.match(orchestrator, /not permission to rediscover/i);
  assert.match(generic, /do not hand-edit it, re-sort it to imitate a tool result/i);
  assert.match(orchestrator, /validated packet is immutable dispatch input/i);
  assert.match(orchestrator, /Invoke only `packet\.task\.agent` for implementation/i);
  assert.match(orchestrator, /Do not invoke a tester or technical postflight until the assigned worker has returned/i);
  assert.match(orchestrator, /reported by Kajoo as error or failed/i);

  const tasks = fs.readFileSync(path.join(recipeRoot, 'skills', 'managing-kajoo-tasks', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(tasks, /coordinator treats the worker as running only\s+after the real dispatch is accepted/i);
});

test('Sitecore worker has the foreground Bash capability but generic guidance stays vendor-neutral', () => {
  const worker = fs.readFileSync(path.join(recipeRoot, 'agents', 'sitecore-developer.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(worker, /workspace-sandbox\/bash/);
  assert.match(worker, /mcpCredentials\.source/);
  assert.match(worker, /mcpCredentials\.target/);
  assert.match(worker, /source-sitecore\/run-powershell-script/);
  assert.match(worker, /source-sitecore\/get-item/);
  assert.match(worker, /target-sitecore\/get-item/);

  const generic = read('references', 'pipeline', 'content-migration.md');
  assert.doesNotMatch(generic, /sitecore|powershell|graphql/i);
  assert.match(generic, /task packet and bounded dispatch/i);
  assert.match(generic, /stable path-and-hash references/i);
  assert.match(generic, /never permission to scan a source hierarchy/i);
  assert.match(generic, /contiguous, non-mutating preparation group/i);
  assert.match(generic, /approved execution-scope manifest/i);
  assert.match(generic, /Discovery planning refresh/i);
  assert.match(generic, /shared phase capture/i);
});

test('Sitecore serialization reference requires capability, role separation, and target parity', () => {
  const native = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore', 'references', 'serialization', 'native-execution.md'), 'utf8').replace(/\r\n/g, '\n');
  const parity = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore', 'references', 'serialization', 'target-parity.md'), 'utf8').replace(/\r\n/g, '\n');
  const serialization = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore', 'scripts', 'serialization', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(native, /mcpCredentials\.source/);
  assert.match(native, /mcpCredentials\.target/);
  assert.match(native, /foreground Bash/i);
  assert.match(native, /credentials in arguments/i);
  assert.match(parity, /stable ID/i);
  assert.match(parity, /languages?\/versions?/i);
  assert.match(parity, /representative page/i);
  assert.match(parity, /terminal audit freshness/i);
  assert.match(parity, /latest target mutation/i);
  assert.match(parity, /aggregate.*count/i);
  assert.match(parity, /thousands of `get-item` calls/i);
  assert.match(serialization, /compile-task-scopes/i);
  assert.match(serialization, /compile-serialization-scope/i);
  assert.match(serialization, /status: "complete"/i);
  assert.match(serialization, /scope-items\.json/i);
  assert.match(native, /current task packet/i);
  assert.match(native, /not permission for exploratory source queries/i);
  assert.match(native, /pull and push authenticate within their wrapper invocation/i);
  assert.match(native, /local validation.*does not require connector credentials/i);
  assert.match(serialization, /Do not make a standalone `login` call/i);
  assert.ok(fs.existsSync(path.join(recipeRoot, 'skills', 'sitecore', 'scripts', 'serialization', 'prepare-coverage-audit.mjs')));
  assert.ok(fs.existsSync(path.join(recipeRoot, 'skills', 'sitecore', 'scripts', 'spe', 'audit-serialization-coverage.ps1')));

  const health = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore', 'references', 'serialization', 'health-check.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(health, /terminal result automatically/i);
  assert.match(health, /only to recover a\s+missing delivery/i);
  assert.doesNotMatch(health, /then poll `get-tool-results`/i);
});
