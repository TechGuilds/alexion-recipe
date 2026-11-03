import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const skillRoot = path.resolve(import.meta.dirname, '..');
const recipeRoot = path.resolve(skillRoot, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(skillRoot, ...parts), 'utf8');

test('Sitecore Resolver Adapters has evidence-led entry, per-contract gates and a final audit', () => {
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'resolver-adapters.md');
  for (const phrase of [
    'Entry, resume and prerequisite gate',
    'Framework and live-debug gate',
    'Contract inventory and task selection',
    'Per-adapter execution and verification frontier',
    'Completion and final acceptance input',
    'phase-continuation',
    'target site name',
    'scaffold-resolver.mjs',
    'phase-level framework-plan result',
    'live-debug',
    'changedFields=yes',
    'validate-evidence.mjs',
    'next-work.mjs',
    'independently checks',
  ]) assert.ok(profile.toLowerCase().includes(phrase.toLowerCase()), phrase);

  assert.match(profile, /one safe correction and retry/i);
  assert.match(profile, /Do not mark another adapter task in progress/i);
  assert.match(profile, /raw Edge layout is not enrichment/i);
  assert.match(profile, /scoped reduced-acceptance decision/i);
  const retiredFlowTerms = [
    ['pre', 'cleanup'].join('-'),
    ['legacy', 'recipe'].join(' '),
    ['previous', 'recipe'].join(' '),
  ];
  assert.doesNotMatch(profile, new RegExp(retiredFlowTerms.join('|'), 'i'));
});

test('Resolver adapter worker guidance uses the native scaffold and current workflow facts', () => {
  const pair = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore-headless-to-xmc', 'references', 'resolver-adapter.md'), 'utf8');
  const worker = fs.readFileSync(path.join(recipeRoot, 'agents', 'frontend-developer.md'), 'utf8');
  const scripts = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore-headless-to-xmc', 'scripts', 'README.md'), 'utf8');

  assert.match(pair, /approved Discovery synthesis\/report evidence/i);
  assert.match(pair, /stable source rendering\/entity ID/i);
  assert.doesNotMatch(pair, /resolver work-kind/i);
  assert.match(worker, /Resolver Adapters task/i);
  assert.match(worker, /analyze-field-access\.mjs/i);
  assert.match(worker, /phase-level framework-plan result/i);
  assert.match(worker, /must not run `?scaffold-resolver\.mjs --dry-run`? from an adapter task/i);
  assert.match(worker, /changedFields=yes/i);
  assert.match(scripts, /hash-bound overwrite/i);
  assert.match(scripts, /resolver-adapter\.types/i);
});

test('Resolver phase remains a selectable evidence-led catalog example', () => {
  const catalog = JSON.parse(read('assets', 'profiles', 'sitecore', 'phase-catalog.json'));
  const resolver = catalog.goldenExamples.find(({ key }) => key === 'resolver-adapters');
  assert.ok(resolver);
  assert.match(resolver.taskPatterns.join(' '), /phase-entry framework-plan.*reused/i);
  assert.match(resolver.tasks.join(' '), /target-site identity.*framework.*adapter.*audit/i);
  assert.match(resolver.acceptanceEvidence.join(' '), /source-versus-raw-target.*resolver-debug.*visible marker/i);
  assert.doesNotMatch(JSON.stringify(resolver), /"dependsOn"/);
});

test('Sitecore resolver profile holds resolver task gating and human verification requirements', () => {
  const profile = fs.readFileSync(path.join(recipeRoot, 'skills', 'cms-migration', 'references', 'profiles', 'sitecore', 'pipeline', 'resolver-adapters.md'), 'utf8');
  assert.match(profile, /one fresh frontend-developer/i);
  assert.match(profile, /Do not mark another adapter task in progress/i);
  assert.match(profile, /source-expanded[\s\S]*target-enriched/i);
});

test('Headless resolver guidance permits only explicitly attached connector environment', () => {
  const pairSkill = fs.readFileSync(path.join(recipeRoot, 'skills', 'sitecore-headless-to-xmc', 'SKILL.md'), 'utf8');
  assert.match(pairSkill, /mcpCredentials\.source/i);
  assert.match(pairSkill, /role-namespaced connector environment variables/i);
  assert.doesNotMatch(pairSkill, /Local scripts cannot borrow that authentication/i);
});
