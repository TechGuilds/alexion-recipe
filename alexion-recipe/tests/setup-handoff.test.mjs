import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { validateWorkflow } from '../skills/workflow/scripts/validate.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const profile = () => JSON.parse(read('skills/cms-migration/assets/profiles/sitecore/workflow.json'));

test('the recipe does not seed competing Setup or Discovery phases', () => {
  const file = new URL('../.kajoo/workflow.json', import.meta.url);
  assert.ok(!existsSync(file) || JSON.parse(readFileSync(file, 'utf8')).phases.length === 0);
});

test('artifact-owned Setup ends with independent audit then Discovery planning', () => {
  const workflow = profile();
  const setup = workflow.phases.find(phase => phase.id === 'setup');
  assert.deepEqual(setup.tasks.map(task => task.id), [
    'setup.source', 'setup.target', 'setup.cms', 'setup.audit', 'setup.prepare-discovery',
  ]);
  assert.deepEqual(setup.tasks.map(task => task.dependsOn), [
    [], ['setup.source'], ['setup.source', 'setup.target'],
    ['setup.cms'], ['setup.audit'],
  ]);
  const active = { version: 1, phases: [structuredClone(setup)] };
  assert.equal(validateWorkflow(active).valid, true);
  assert.deepEqual(validateWorkflow(active).runnable, ['setup.source']);
  active.phases[0].tasks.slice(0, -1).forEach(task => { task.status = 'done'; });
  assert.equal(validateWorkflow(active).complete, false);
  assert.deepEqual(validateWorkflow(active).runnable, ['setup.prepare-discovery']);
  active.phases[0].tasks.forEach(task => { task.status = 'done'; });
  assert.equal(validateWorkflow(active).complete, true);
  active.phases.push(workflow.phases.find(phase => phase.id === 'discovery'));
  assert.equal(validateWorkflow(active).valid, true);
  assert.equal(validateWorkflow(active).currentPhase, 'discovery');
  active.phases[1].tasks.find(task => task.id === 'discovery.code').status = 'blocked';
  assert.equal(validateWorkflow(active).valid, true);
  assert.deepEqual(validateWorkflow(active).runnable, ['discovery.content']);
});

test('CMS entry consumes artifact-owned Setup instead of creating another plan', () => {
  const setup = read('skills/cms-migration/references/profiles/sitecore/pipeline/setup.md');
  const artifact = read('skills/migration-artifact/references/prepare-artifact.md');
  assert.match(setup, /setup\.cms/);
  assert.match(setup, /artifact-owned Setup/);
  assert.doesNotMatch(setup, /Mongo epics\/tasks are seeded/);
  assert.doesNotMatch(artifact, /`setup\.prepare`/);
  assert.match(artifact, /setup\.source/);
  assert.match(artifact, /setup\.target/);
  assert.match(artifact, /setup\.cms/);
  assert.match(artifact, /setup\.audit/);
  assert.match(artifact, /only.*Setup.*active workflow|active workflow.*only.*Setup/i);
});

test('Discovery planning precedes execution continuation and preserves artifact links', () => {
  const handoff = read('skills/migration-artifact/references/complete-setup.md');
  assert.match(handoff, /setup\.audit/);
  assert.match(handoff, /setup\.prepare-discovery/);
  assert.match(handoff, /phase-continuation/);
  assert.match(handoff, /returned.*ID/i);
  assert.match(handoff, /content\.phases/);
  assert.match(handoff, /preserve/i);
  assert.match(handoff, /never.*name/i);
});

test('target readiness deferral cannot waive full-migration Setup gates', () => {
  const target = read('skills/migration-artifact/templates/setup-target-platform-task.md');
  const cms = read('skills/migration-artifact/templates/setup-cms-task.md');
  assert.match(target, /CMS-specific setup/);
  assert.match(target, /hand repository\/application initialization to CMS-specific setup/i);
  assert.match(cms, /readiness.*deferral|readiness task recorded no target repository/i);
  assert.match(cms, /explicit.*discovery-only/);
});

test('the audit owner publishes and verifies its own declared reports', () => {
  const audit = read('skills/migration-artifact/templates/audit-setup-task.md');
  assert.match(audit, /this task’s evidence directory/);
  assert.match(audit, /persist\/read back.*reports\/setup-summary/);
  assert.match(audit, /sole assigned audit-report writer/);
  assert.match(audit, /Do not edit combined context/);
  assert.match(audit, /Do not create or start Discovery/);
});

test('fixed Setup tasks are todo before the interview and resolve role configuration at dispatch', () => {
  const prepare = read('skills/migration-artifact/references/prepare-artifact.md');
  assert.match(prepare, /Before dispatching either role, create all five tasks/);
  assert.match(prepare, /each as `todo`/);
  assert.match(prepare, /material scope change belongs in the pending task description/);
  assert.match(prepare, /Do not repeat.*launch prompt/);
  for (const role of ['source', 'target']) {
    const template = read(`skills/migration-artifact/templates/setup-${role}-platform-task.md`);
    assert.match(template, /Select the platform (?:connector|connection)/);
    assert.match(template, /Use \*\*migration-artifact\*\*/);
    assert.match(template, /(?:Load|Use) the \*\*applicable CMS skill\*\*/);
    assert.doesNotMatch(template, /connectorId="<connectorId>"|<displayName>|<IPlatform.type>|<actual agent ID>/);
  }
});

test('Discovery creation is a separate planning task, not part of the audit', () => {
  const template = read('skills/migration-artifact/templates/prepare-discovery-task.md');
  const prepare = read('skills/cms-migration/references/prepare-discovery.md');
  const entry = read('skills/cms-migration/references/start-discovery.md');
  const workflow = profile();
  for (const task of workflow.phases.find(phase => phase.id === 'discovery').tasks.slice(0, 2)) {
    assert.deepEqual(task.dependsOn, ['setup.prepare-discovery']);
  }
  assert.match(template, /setup\.prepare-discovery/);
  assert.match(template, /cms-migration/);
  assert.match(prepare, /does not require.*phase-continuation/i);
  assert.match(prepare, /`todo`/);
  assert.match(prepare, /`draft`/);
  assert.match(prepare, /`blocked`/);
  assert.match(prepare, /Do not dispatch/);
  assert.match(prepare, /retry only missing/i);
  assert.match(entry, /phase-continuation/);
  assert.match(entry, /Do not create a second Discovery/);
  assert.match(entry, /draft.*not.*runnable/i);
});

test('Discovery planning explicitly ranks the phase after Setup', () => {
  const prepare = read('skills/cms-migration/references/prepare-discovery.md');
  const template = read('skills/migration-artifact/templates/prepare-discovery-task.md');
  assert.match(prepare, /rank.*ascending/i);
  assert.match(prepare, /Setup.*`1000`/);
  assert.match(prepare, /Discovery.*Setup.*\+ 1000/);
  assert.match(prepare, /Missing ranks sort last/);
  assert.match(prepare, /read back.*ranks/i);
  assert.match(template, /numeric `rank`.*greater than.*Setup/i);
});

test('phase titles stay plain without numbering or migration suffixes', () => {
  for (const path of ['skills/migration-artifact/references/prepare-artifact.md', 'skills/migration-artifact/templates/prepare-discovery-task.md', 'skills/cms-migration/references/prepare-discovery.md', 'skills/workflow/references/kajoo-plan-sync.md']) {
    const content = read(path);
    assert.match(content, /Do not add numbered prefixes or migration-name suffixes/);
    assert.match(content, /numeric `rank` for ordering/);
    assert.doesNotMatch(content, /Setup — <migration name>/);
  }
});

test('readiness workers load the artifact procedure and have Git credential connections', () => {
  const worker = read('agents/sitecore-developer.md');
  assert.match(worker.match(/^skills: (.+)$/m)[1], /migration-artifact/);
  assert.match(worker, /source-git\/list-repositories/);
  assert.match(worker, /target-git\/list-repositories/);
  assert.match(worker, /setup\.source.*setup\.target/);
  const skill = read('skills/migration-artifact/SKILL.md');
  assert.match(skill, /Role setup worker entry/);
  assert.match(skill, /No enabled Git connection found/);
  assert.match(skill, /not.*repository.*inaccessible/i);
  for (const role of ['source', 'target']) {
    const template = read(`skills/migration-artifact/templates/setup-${role}-platform-task.md`);
    assert.match(template, /Use \*\*migration-artifact\*\*/);
    assert.match(template, /applicable CMS skill/);
    assert.match(template, /role persistence contract/);
  }
});

test('the independent auditor can read phase membership and connector metadata', () => {
  const tester = read('agents/tester.md');
  for (const tool of ['list-tasks', 'list-epics', 'list-connectors', 'get-connector']) {
    assert.ok(tester.includes(`kajoo/${tool}`));
  }
});

test('readiness distinguishes remote defaults and never invents decision provenance', () => {
  const acquisition = read('skills/migration-artifact/references/role-setup-contract.md');
  assert.match(acquisition, /implementation repository's `branchName` field, not in a supporting reference URL/);
  assert.match(acquisition, /remote default is not the selected working branch/);
  assert.match(acquisition, /Do not infer user confirmation from an existing checkout/);
  const skill = read('skills/migration-artifact/SKILL.md');
  assert.match(skill, /actual UTC clock/);
  assert.match(skill, /never invent or backdate/);
  assert.match(skill, /never.*write those placeholders back/);
});

test('target application inspection does not echo deployment secrets', () => {
  const target = read('skills/sitecore/references/setup/target-app-init.md');
  const audit = read('skills/migration-artifact/templates/audit-setup-task.md');
  assert.match(target, /never print the entire file or `jssDeploymentSecret` values/);
  assert.match(audit, /Never print the entire `xmcloud.build.json`/);
  assert.match(audit, /through `NVM_DIR`/);
});


test('role owners persist isolated state and integration owns combined configuration', () => {
  const contract = read('skills/migration-artifact/references/role-setup-contract.md');
  for (const role of ['source', 'target']) {
    const template = read(`skills/migration-artifact/templates/setup-${role}-platform-task.md`);
    assert.match(template, /role persistence contract/);
    assert.doesNotMatch(template, /migration site\/language selection.*belong to the subsequent/);
    assert.match(template, /Save and read back `content\./);
  }
  assert.match(contract, /content\.source/);
  assert.match(contract, /content\.target/);
  assert.match(contract, /read back/i);
  assert.match(contract, /They do not update/);
  assert.match(contract, /context\.json/);
  assert.match(contract, /CMS setup owner fetches the latest artifact/);
  assert.match(contract, /CMS task.s acceptance criterion/);
  assert.match(contract, /review/);
  assert.match(contract, /owner sets\n`done`/);
  const sitecore = read('skills/sitecore/references/setup/role-configuration.md');
  for (const value of ['site.name', 'site.rootPath', 'site.startItem', 'site.hostName', 'rendering', 'version', 'xmc-list-sites']) {
    assert.ok(sitecore.includes(value), value);
  }
  assert.match(sitecore, /never auto-select/i);
  const audit = read('skills/migration-artifact/templates/audit-setup-task.md');
  assert.match(audit, /artifact.*read.back/i);
  assert.match(audit, /role-configuration\.json/);
});


test('source completes before target and integration waits for both', () => {
  const setup = structuredClone(profile().phases.find(phase => phase.id === 'setup'));
  const workflow = { version: 1, phases: [setup] };
  assert.deepEqual(validateWorkflow(workflow).runnable, ['setup.source']);
  setup.tasks[0].status = 'blocked';
  assert.deepEqual(validateWorkflow(workflow).runnable, []);
  setup.tasks[0].status = 'done';
  assert.deepEqual(validateWorkflow(workflow).runnable, ['setup.target']);
  setup.tasks[1].status = 'done';
  assert.deepEqual(validateWorkflow(workflow).runnable, ['setup.cms']);
  assert.equal(setup.tasks[2].agent, 'sitecore-developer');
});


test('dispatch references the task instead of duplicating its instructions', () => {
  const tasks = read('skills/managing-kajoo-tasks/SKILL.md');
  assert.match(tasks, /Work on <kajoo-task taskId=/);
  assert.match(tasks, /calls `get-task` first/);
  assert.match(tasks, /Do not paste the task/);
  assert.match(tasks, /packet\/postflight reference/);
  const orchestrator = read('agents/orchestrator.md');
  assert.match(orchestrator, /do not duplicate templates, skill instructions/);
});


test('role tasks own acquisition and CMS skills own health and platform details', () => {
  assert.equal(existsSync(new URL('../skills/migration-artifact/templates/prepare-migration-task.md', import.meta.url)), false);
  for (const role of ['source', 'target']) {
    const template = read(`skills/migration-artifact/templates/setup-${role}-platform-task.md`);
    assert.match(template, /Connection and repository setup/);
    assert.match(template, /CMS-specific configuration/);
    assert.match(template, /Select the platform (?:connector|connection)/);
    assert.match(template, /Select the Git (?:connector|connection)/);
    assert.match(template, /Validate.*(?:connector health|connection’s health)/i);
    assert.doesNotMatch(template, /prepare task ID|Return unresolved selection problems to preparation/);
  }
  assert.match(read('agents/sitecore-developer.md'), /kajoo\/create-connector/);
});


test('role task descriptions retain the approved simple sections without technical wrappers', () => {
  for (const role of ['source', 'target']) {
    const template = read(`skills/migration-artifact/templates/setup-${role}-platform-task.md`);
    const headings = [...template.slice(template.indexOf('\n## Goal\n') + 1).matchAll(/^## (.+)$/gm)].map(match => match[1]);
    assert.deepEqual(headings, ['Goal', 'Connection and repository setup', 'CMS-specific configuration', 'Completion', 'Technical report']);
  }
  assert.match(read('skills/migration-artifact/templates/setup-target-platform-task.md'), /Start only after.*source task ID.*is complete/);
  assert.match(read('skills/migration-artifact/references/prepare-artifact.md'), /copy.*template.*verbatim/i);
});

test('each sequential role owner persists and verifies its artifact role before completing', () => {
  for (const role of ['source', 'target']) {
    const template = read(`skills/migration-artifact/templates/setup-${role}-platform-task.md`);
    assert.match(template, new RegExp('Save and read back `content\\.' + role + '`'));
  }
  const contract = read('skills/migration-artifact/references/role-setup-contract.md');
  assert.match(contract, /fetch the latest artifact.*update only the assigned role/s);
  assert.match(contract, /artifact read-back.*before.*done/s);
  assert.match(contract, /preserve the opposite role/i);
  const cms = read('skills/migration-artifact/templates/setup-cms-task.md');
  assert.match(cms, /already persisted.*role owners/i);
  assert.doesNotMatch(cms, /merge both verified `artifactRole` objects once/);
});

test('repository and branch follow-ups remain structured and resumable', () => {
  const contract = read('skills/migration-artifact/references/role-setup-contract.md');
  assert.match(contract, /repository-name and branch questions in one call/);
  assert.match(contract, /no preset options for a typed answer/);
  assert.match(contract, /issue a follow-up `ask-user-input`/);
  assert.match(contract, /Do not end the run, mark the task blocked merely while awaiting this answer/);
});


test('source setup asks purpose-specific Git questions in connector-repository-branch order', () => {
  const template = read('skills/migration-artifact/templates/setup-source-platform-task.md');
  const questions = [
    'Which Git connection should I use to access your existing website’s code?',
    'Which repository contains the website you want to migrate?',
    'Which branch should I read to understand and migrate your existing website?',
  ];
  const positions = questions.map(question => template.indexOf(question));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  assert.match(template, /search for it and verify the match/);
  assert.match(template, /Fetch branches for the selected repository/);
  assert.match(template, /Text input alongside the choices/);
  assert.match(template, /Ask dependent questions after the preceding selection/);
  assert.match(read('skills/migration-artifact/references/role-setup-contract.md'), /Which branch should I use for migration changes/);
});


test('coordinator and workers ask dependent questions in separate turns', () => {
  const coordinator = read('agents/orchestrator.md');
  const hub = read('skills/cms-migration/SKILL.md');
  const policy = read('skills/cms-migration/references/decisions-and-approvals.md');
  for (const guidance of [coordinator, policy]) {
    assert.match(guidance, /every question remains relevant and its options remain valid regardless of the other answers/i);
    assert.match(guidance, /ask the prerequisite question alone/i);
  }
  assert.match(hub, /dependent-question rules/);
  assert.match(policy, /full-migration\/discovery-only workflow scope.*dependent scope questions/s);
  assert.match(policy, /Content transfer method selection is a separate profile-owned decision/);
  assert.match(policy, /site.*languages/s);
  assert.match(policy, /destination.*approval/s);
  assert.doesNotMatch(coordinator, /Batch already-known unresolved task-local choices/);
});


test('concise communication keeps users informed and labels known bash actions', () => {
  const contract = read('skills/cms-migration/references/task-results.md');
  assert.match(contract, /Concise does not mean silent/);
  assert.match(contract, /before the first tool call/);
  assert.match(contract, /more than about a minute/);
  assert.match(contract, /Before\nasking for user input/);
  assert.match(contract, /For every bash call whose purpose is known/);
  assert.match(contract, /populate its `description`/);
  assert.match(contract, /Do not read or analyze\nan unfamiliar script just to describe it/);
  assert.match(contract, /generic fallback/);
  for (const name of ['frontend-developer', 'sitecore-developer', 'tester']) {
    const agent = read(`agents/${name}.md`);
    assert.match(agent, /Begin each task with a short user-friendly opening/);
    assert.match(agent, /bash description when its purpose is known/);
  }
  const coordinator = read('agents/orchestrator.md');
  assert.doesNotMatch(coordinator, /At most one short opening|Give at most one short/);
  assert.match(coordinator, /Populate bash descriptions/);
});


test('migration scratch and presentation requests are scoped to the project state directory', () => {
  const context = read('skills/cms-migration/references/context-file.md');
  const setup = read('skills/cms-migration/references/workspace-setup.md');
  const content = read('skills/sitecore/references/discovery/content-analysis.md');
  const analysis = read('skills/sitecore/scripts/analysis/README.md');
  for (const text of [context, setup, content, analysis]) {
    assert.ok(text.includes('${MIGRATION_STATE_FILE_DIR}/tmp/'));
  }
  assert.ok(analysis.includes('--output "${MIGRATION_STATE_FILE_DIR}/tmp/'));
  assert.ok(analysis.includes('.kajoo/<projectId>/tmp/'));
  assert.doesNotMatch(content, /under a fresh `\.kajoo\/tmp\//);
  assert.doesNotMatch(analysis, /--output \/workspace\/\.kajoo\/tmp/);
  assert.match(context, /Runtime-managed per-chat tool output/);
});


test('audit guidance distinguishes evidence path bases instead of duplicating prefixes', () => {
  const paths = read('skills/cms-migration/references/context-file.md');
  const audit = read('skills/cms-migration/references/tester-checks.md');
  const synthesis = read('skills/sitecore/scripts/analysis/README.md');
  assert.match(paths, /Resolve the reference once/);
  assert.match(paths, /not.*MIGRATION_STATE_FILE_DIR.*evidence/);
  assert.match(paths, /never search for/);
  assert.match(audit, /never its `evidence\/` child/);
  assert.match(synthesis, /outputs\[\]\.path.*directory/);
  assert.match(synthesis, /inputs.*paths resolve from the/);
});


test('setup preserves repository names directly beneath repos unless the user chooses otherwise', () => {
  for (const path of [
    'skills/migration-artifact/references/role-setup-contract.md',
    'skills/cms-migration/references/git-operations.md',
    'skills/migration-artifact/templates/setup-source-platform-task.md',
    'skills/migration-artifact/templates/setup-target-platform-task.md',
  ]) {
    const text = read(path);
    assert.ok(text.includes('/workspace/repos/<original-repository-name>'));
    assert.match(text, /user explicitly/);
    assert.doesNotMatch(text, /repos\/source\/|repos\/target\//);
  }
  const role = read('skills/migration-artifact/references/role-setup-contract.md');
  assert.match(role, /ask the user for distinct checkout/);
  assert.match(role, /do not move them\nautomatically/);
});


test('role setup writes only simplified artifact configuration', () => {
  const hub = read('skills/migration-artifact/SKILL.md');
  const role = read('skills/migration-artifact/references/role-setup-contract.md');
  const platform = read('skills/sitecore/references/setup/role-configuration.md');
  assert.match(hub, /Supporting references are URL-only/);
  assert.match(hub, /SDK type is `jss` or `content-sdk`/);
  assert.match(hub, /Do not write `capabilities`/);
  assert.match(role, /Never put Git connector or branch objects in `references`/);
  assert.match(platform, /never in the artifact role/);
});
