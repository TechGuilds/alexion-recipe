import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const skillRoot = path.resolve(import.meta.dirname, '..');
const recipeRoot = path.resolve(skillRoot, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(skillRoot, ...parts), 'utf8');
const sitecoreRoot = path.join(recipeRoot, 'skills', 'sitecore');

test('Sitecore SXA conversion has an evidence-led ordered contract with explicit human gates', () => {
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'sxa-conversion.md');
  const required = [
    'Entry, resume and parameter gate',
    'Tenant Setup',
    'Rendering Registration',
    'Site Adoption',
    'Site Conversion',
    'Presentation Setup',
    'Presentation Migration',
    'Coverage audit',
    'shared-data safety',
    'partial-design',
    'TemplatesMapping',
    'dry-run',
    'Roll back',
    'signature',
    'language',
    'needs-redo',
  ];
  for (const phrase of required) assert.match(profile, new RegExp(phrase, 'i'), phrase);

  assert.match(profile, /partial.*ask.*continue/i);
  assert.match(profile, /failed.*stop/i);
  assert.match(profile, /no target mutation.*approval/i);
  assert.match(profile, /independent.*tester/i);
  const historicalRecipeTerms = [
    ["pre", "cleanup"].join("-"),
    ["legacy", "recipe"].join(" "),
    ["previous", "recipe"].join(" "),
  ];
  assert.doesNotMatch(profile, new RegExp(historicalRecipeTerms.join("|"), "i"));
});

test('Sitecore SXA guidance keeps the established provisioning script inventory intact', () => {
  const expected = [
    'xmc-adopt-site-into-tenant.ps1',
    'xmc-apply-rendering-modules.ps1',
    'xmc-assign-page-design.ps1',
    'xmc-backup-renderings.ps1',
    'xmc-convert-to-headless-site.ps1',
    'xmc-create-module.ps1',
    'xmc-create-page-designs.ps1',
    'xmc-create-partial-designs.ps1',
    'xmc-create-rendering.ps1',
    'xmc-discover-presentation-patterns.ps1',
    'xmc-ensure-rendering-parameters.ps1',
    'xmc-list-modules.ps1',
    'xmc-list-partial-designs.ps1',
    'xmc-list-site-page-templates.ps1',
    'xmc-migrate-to-page-designs.ps1',
    'xmc-register-rendering-folders.ps1',
    'xmc-restore-renderings.ps1',
  ];
  const scripts = fs.readdirSync(path.join(sitecoreRoot, 'scripts', 'sxa')).filter(name => name.endsWith('.ps1')).sort();
  assert.deepEqual(scripts, expected);

  const provisioning = fs.readFileSync(path.join(sitecoreRoot, 'references', 'sxa', 'provisioning.md'), 'utf8');
  for (const script of expected) assert.match(provisioning, new RegExp(script.replace('.', '\\.'), 'i'), script);
  assert.match(provisioning, /unchanged executable body/i);
  assert.match(provisioning, /signature[\s\S]*datasource[\s\S]*parameters/i);
  assert.match(provisioning, /per-language/i);
  assert.match(provisioning, /SimulatedInheritedSvRenderings/);
  assert.match(provisioning, /do not apply a[\s\S]*not explicitly approved/i);
});

test('SXA planning examples are coarse milestones and not a fixed phase template', () => {
  const catalog = JSON.parse(read('assets', 'profiles', 'sitecore', 'phase-catalog.json'));
  const sxa = catalog.goldenExamples.find(({ key }) => key === 'sxa-conversion');
  assert.ok(sxa);
  assert.match(sxa.taskPatterns.join(' '), /foundation.*adoption.*conversion/i);
  assert.match(sxa.tasks.join(' '), /dry-run.*roll back.*presentation/i);
  assert.match(sxa.acceptanceEvidence.join(' '), /signature|datasource/i);
  assert.match(sxa.acceptanceEvidence.join(' '), /language|representative/i);
});

test('Sitecore worker and tester hold the respective SXA execution and independent audit boundaries', () => {
  const worker = fs.readFileSync(path.join(recipeRoot, 'agents', 'sitecore-developer.md'), 'utf8');
  const tester = fs.readFileSync(path.join(recipeRoot, 'agents', 'tester.md'), 'utf8');
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'sxa-conversion.md');
  assert.match(worker, /For SXA Conversion/i);
  assert.match(worker, /target-sitecore\/run-powershell-script/);
  assert.match(worker, /dry-run[\s\S]*Do not execute/i);
  assert.match(worker, /After execute[\s\S]*Do not run.*repair/i);
  assert.match(worker, /Do not create or change\s+workflow/i);
  assert.match(tester, /SXA coverage audit/i);
  assert.match(tester, /read-only/i);
  assert.match(tester, /templatesmapping/i);
  assert.match(profile, /No target mutation occurs before the dry-run approval/i);
  assert.match(profile, /independent tester/i);
});

test('SXA tenant setup performs a bounded read-only target reconnaissance before target choices or writes', () => {
  const worker = fs.readFileSync(path.join(recipeRoot, 'agents', 'sitecore-developer.md'), 'utf8');
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'sxa-conversion.md');
  const scriptReadme = fs.readFileSync(path.join(sitecoreRoot, 'scripts', 'sxa', 'README.md'), 'utf8');

  assert.match(profile, /read-only target[\s\S]*reconnaissance before requesting a tenant name, rendering prefix, or any[\s\S]*target mutation/i);
  assert.match(profile, /List the target collections and sites[\s\S]*registered modules/i);
  assert.match(worker, /For `sxa\.tenant-setup`[\s\S]*xmc-list-collections[\s\S]*xmc-list-sites/i);
  assert.match(worker, /xmc-list-modules\.ps1/i);
  assert.match(worker, /Do not call collection\/site ensure,[\s\S]*adoption,[\s\S]*rendering registration/i);
  assert.match(scriptReadme, /automatic terminal delivery/i);
  assert.match(scriptReadme, /only to recover a missing terminal result or inspect the exact known interrupted run/i);
  assert.doesNotMatch(scriptReadme, /, poll `get-tool-results`/i);
});

test('SXA presentation scripts preserve the source parameter contract and isolate target transport artifacts', () => {
  const scripts = [
    'xmc-discover-presentation-patterns.ps1',
    'xmc-create-partial-designs.ps1',
    'xmc-migrate-to-page-designs.ps1',
  ].map(name => fs.readFileSync(path.join(sitecoreRoot, 'scripts', 'sxa', name), 'utf8'));

  for (const script of scripts) assert.match(script, /Normalize-RenderingParams/);

  const migration = scripts[2];
  assert.match(migration, /\$text -ceq "s"/,
    'the migration-time comparison tolerates the observed empty-parameter artifact');
  assert.match(scripts[1], /Normalized empty parameter artifact/,
    'newly created Partial Designs clear the artifact at its target-side source');
  assert.match(migration, /OrdinalIgnoreCase/,
    'rendering UIDs are identifiers and must not depend on serialized casing');
  assert.match(migration, /Test-UidReference/,
    'UIDs embedded in placeholder paths need case-insensitive matching too');
  assert.match(migration, /SimulatedInheritedSvRenderings/,
    'dry-run must report inherited SV renderings it suppresses before page planning');
  assert.match(migration, /Test-LayoutXmlUid/,
    'dry-run must retain a page-owned rendering even when its UID appears in an SV strip set');
  assert.doesNotMatch(migration, /\.Placeholder\.Contains\(\$uid\)/,
    'raw case-sensitive placeholder UID comparisons must not remain');
  assert.match(migration, /New-UidSet/,
    'the parent-preserved guard must receive a case-insensitive UID set');
  assert.match(migration,
    /function New-UidSet\s*\{\s*#.*?\s*#.*?\s*return ,\[System\.Collections\.Generic\.HashSet\[string\]\]::new\(\[System\.StringComparer\]::OrdinalIgnoreCase\)/s,
    'an empty UID set must return as one object rather than be unrolled to no pipeline output');
});

test('SXA module application reports post-setup and target materialization failures instead of swallowing them', () => {
  const script = fs.readFileSync(
    path.join(sitecoreRoot, 'scripts', 'sxa', 'xmc-apply-rendering-modules.ps1'),
    'utf8',
  );

  assert.match(script, /PostSetup/);
  assert.match(script, /Available Renderings/);
  assert.match(script, /ModuleMaterialization/);
  assert.match(script, /ExpectedAvailableRenderingNames/,
    'materialization must be derived from the module action branch, not a bare module name');
  assert.match(script, /ExpectedNames/,
    'the report must preserve the concrete target names it checked');
  assert.match(script, /not-applicable/,
    'modules with no materialization action must remain explicit rather than be claimed as verified');
  assert.doesNotMatch(script, /Non-fatal:\s*post-setup is best-effort/i);
});

test('SXA dispatch uses task-scoped worker continuations and explicit mutation authorization', () => {
  const orchestrator = fs.readFileSync(path.join(recipeRoot, 'agents', 'orchestrator.md'), 'utf8');
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'sxa-conversion.md');

  assert.match(orchestrator, /same workflow task/i);
  assert.match(orchestrator, /omit .*runId/i);
  assert.match(orchestrator, /Approve execution/i);
  assert.match(orchestrator, /must not substitute/i);
  assert.match(profile, /decision bundle/i);
});

test('SXA keeps the Stage-compatible default-language path non-blocking while retaining language deltas as deferred evidence', () => {
  const profile = read('references', 'profiles', 'sitecore', 'pipeline', 'sxa-conversion.md');
  const provisioning = fs.readFileSync(path.join(sitecoreRoot, 'references', 'sxa', 'provisioning.md'), 'utf8');
  const tester = fs.readFileSync(path.join(recipeRoot, 'agents', 'tester.md'), 'utf8');

  assert.match(profile, /default-language scope is the standard SXA execution path/i);
  assert.match(profile, /non-blocking deferred finding/i);
  assert.match(provisioning, /do not block E1 or\s+E2 solely because a non-default layout delta exists/i);
  assert.match(tester, /default-language result passes its approved scope/i);
  assert.match(tester, /non-default layout delta as deferred/i);
});
