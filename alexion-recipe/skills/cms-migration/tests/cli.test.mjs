import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, symlinkSync, linkSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const workflow = () => ({ version: 1, phases: [{ id: 'code', title: 'Code', tasks: [
  { id: 'gate', title: 'Gate', status: 'done', dependsOn: [] },
  { id: 'items', title: 'Items', status: 'pending', dependsOn: ['gate'] },
] }] });
const entity = (id, extra = {}) => ({ id, kind: 'component', source: { identity: id, path: '/src/' + id }, scope: 'included', parentIds: [], routeIds: ['/'], joins: [], uncertainty: [], ...extra });
const inventory = () => ({ version: 1, scopeId: 'site:en', entities: [entity('parent'), entity('child', { parentIds: ['parent'], routeIds: ['/nested'] })] });
const buildInput = () => ({ inventory: inventory(), workflow: workflow(), profile: { rules: [{ kind: 'component', phaseId: 'code', anchorTaskId: 'items', prefix: 'code' }] }, availableAgents: [] });
test('copied coverage requires current explicit exclusions and task-bound skips', t => {
  const f = fixture(t, true);
  f.put('scope.txt', 'current');
  const input = { inventory: { version: 1, scopeId: 'site:en', entities: [entity('parent')] }, workflow: workflow(), mappings: [{ entityId: 'parent', taskId: 'gate' }], decisions: [], inputs: [{ path: 'scope.txt', sha256: hash('current') }] };
  input.workflow.phases[0].tasks[0].status = 'skipped';
  let n = 0;
  const state = () => {
    const out = join(f.dir, `coverage-${n++}.json`), r = f.run('coverage-report', input, ['--out', out]);
    assert.equal(r.status, 0, r.stdout || JSON.stringify(r.output));
    assert.ok(readdirSync(f.dir).includes(`coverage-${n - 1}.json`), JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr, output: r.output }));
    return JSON.parse(readFileSync(out)).entityCoverage[0].state;
  };
  assert.equal(state(), 'unresolved');
  const decision = { id: 'choice', kind: 'scope', scopeId: 'site:en', entityId: 'parent', taskId: 'gate', choice: 'skip', rationale: 'Reviewed', userResponse: 'Skip', at: '2026-09-11T12:00:00Z', inputs: input.inputs };
  input.decisions = [decision]; assert.equal(state(), 'explicitlySkipped');
  for (const change of [d => d.inputs = [{ path: 'absent', sha256: hash('old') }], d => d.scopeId = 'other', d => delete d.userResponse, d => d.taskId = 'other']) {
    input.decisions = [structuredClone(decision)]; change(input.decisions[0]); assert.equal(state(), 'unresolved');
  }
  decision.choice = 'exclude'; input.decisions = [decision]; assert.equal(state(), 'excluded');
  f.put('scope.txt', 'changed'); assert.equal(state(), 'unresolved');
  f.put('scope.txt', 'current'); input.decisions = [decision, { ...decision, id: 'conflict', choice: 'include' }]; assert.equal(state(), 'unresolved');
  input.decisions = [decision]; delete input.inputs; assert.equal(state(), 'unresolved');
});

test('copied evidence rejects symlink and outside reads for inputs, results, artifacts and changed files', t => {
  const f = fixture(t, true), outside = fixture(t);
  for (const mode of ['input', 'result', 'artifact', 'changed']) {
    for (const kind of ['absolute', 'traversal', 'symlink', 'directory-link', 'hardlink']) {
      const { input, result } = evidenceInput(f);
      const name = `${mode}-${kind}.json`, bytes = mode === 'result' ? JSON.stringify(result) : mode === 'input' ? 'source' : 'render';
      outside.put(name, bytes);
      let ref = join(outside.dir, name);
      if (kind === 'traversal') ref = '../' + outside.dir.split('/').at(-1) + '/' + name;
      if (kind === 'symlink') {
        ref = name;
        try { symlinkSync(join(outside.dir, name), join(f.dir, ref)); }
        catch (error) { if (error.code === 'EPERM') { t.diagnostic('Skipped symlink subcase: this Windows environment does not permit creating symlinks.'); continue; } throw error; }
      }
      if (kind === 'hardlink') { ref = name; linkSync(join(outside.dir, name), join(f.dir, ref)); }
      if (kind === 'directory-link') {
        const dir = name + '-dir';
        try { symlinkSync(outside.dir, join(f.dir, dir)); }
        catch (error) { if (error.code === 'EPERM') { t.diagnostic('Skipped directory-symlink subcase: this Windows environment does not permit creating symlinks.'); continue; } throw error; }
        ref = dir + '/' + name;
      }
      if (mode === 'input') { input.inputs[0].path = ref; result.evidence[0].provenance.inputs = input.inputs; }
      if (mode === 'result') input.results = [ref];
      if (mode === 'artifact') result.evidence[0].path = ref;
      if (mode === 'changed') { result.changedFiles = [ref]; result.checkpoint = { reference: 'backup', scope: [ref] }; }
      f.put('result.json', result);
      assert.equal(f.run('validate-evidence', input).status, 1, `${mode}/${kind}`);
    }
  }
});
test('copied approval coverage remains unresolved for missing, stale and conflicting decisions', t => {
  const f = fixture(t, true), { input: validation, result } = evidenceInput(f);
  validation.workflow.phases[0].tasks[0].id = 'setup.approve';
  validation.workflow.phases[0].tasks[1].dependsOn = ['setup.approve'];
  result.taskId = 'setup.approve'; f.put('result.json', result);
  const input = { inventory: { version: 1, scopeId: 'site:en', entities: [entity('parent')] }, workflow: validation.workflow, mappings: [{ entityId: 'parent', taskId: 'setup.approve' }], decisions: [], validation };
  const decision = { id: 'approve', kind: 'phase-continuation', scopeId: 'site:en', taskId: 'setup.approve', choice: 'approve', rationale: 'Reviewed', userResponse: 'Continue', at: '2026-09-11T12:00:00Z', inputs: validation.inputs.map(({path,sha256}) => ({sha256,path})) };
  let n = 0;
  const state = () => { const out = join(f.dir, `approval-${n++}.json`); assert.equal(f.run('coverage-report', input, ['--out', out]).status, 0); return JSON.parse(readFileSync(out)).entityCoverage[0].state; };
  assert.equal(state(), 'unresolved'); validation.decisions = [decision]; assert.equal(state(), 'verified');
  input.inputs = [{ path: 'source.txt', sha256: hash('other') }]; assert.equal(state(), 'unresolved'); delete input.inputs;
  f.put('source.txt', 'new'); assert.equal(state(), 'unresolved'); f.put('source.txt', 'source');
  validation.decisions.push({ ...decision, id: 'reject', choice: 'reject' }); assert.equal(state(), 'unresolved');
  validation.decisions = [decision]; validation.workflow.phases[0].tasks[0].status = 'skipped'; assert.equal(state(), 'unresolved');
});
function fixture(t, copied = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, data) => { writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data)); return join(dir, name); };
  const skillsRoot = copied ? join(dir, 'skill') : fileURLToPath(new URL('../../', import.meta.url));
  const scriptRoot = copied ? join(skillsRoot, 'cms-migration') : root;
  if (copied) {
    cpSync(root, scriptRoot, { recursive: true });
    cpSync(fileURLToPath(new URL('../../sitecore', import.meta.url)), join(skillsRoot, 'sitecore'), { recursive: true });
  }
  const run = (script, data, flags = []) => {
    put('input.json', data);
    const scriptPath = join(scriptRoot, 'scripts', script + '.mjs');
    const r = spawnSync(process.execPath, [scriptPath, '--input', join(dir, 'input.json'), ...flags], { cwd: dir, encoding: 'utf8' });
    let output; try { output = JSON.parse(r.stdout); } catch { output = { errors: [r.error?.message ?? r.stderr] }; }
    return { ...r, output };
  };
  return { dir, put, run };
}

test('builder creates stable mapped IDs, keeps hosting out of dependsOn, resumes status, tolerates deleted agent hints', t => {
  const f = fixture(t), input = buildInput();
  input.profile.rules[0].agent = 'deleted-agent';
  let r = f.run('build-work-items', input, ['--out', join(f.dir, 'proposal.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const proposal = JSON.parse(readFileSync(join(f.dir, 'proposal.json')));
  const tasks = proposal.workflow.phases[0].tasks;
  assert.deepEqual(proposal.mappings.map(x => x.entityId), ['child', 'parent']);
  assert.equal(proposal.mappings[0].taskId, 'code.Y2hpbGQ');
  assert.deepEqual(tasks.find(x => x.id === 'code.Y2hpbGQ').dependsOn, ['gate']);
  assert.equal(tasks.find(x => x.id === 'code.Y2hpbGQ').agent, undefined);
  assert.ok(proposal.warnings.some(x => x.includes('deleted-agent')));
  input.workflow = proposal.workflow;
  input.workflow.phases[0].tasks.find(x => x.id === 'code.cGFyZW50').status = 'done';
  input.inventory.entities.reverse();
  r = f.run('build-work-items', input, ['--out', join(f.dir, 'resume.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const resumed = JSON.parse(readFileSync(join(f.dir, 'resume.json')));
  assert.equal(resumed.workflow.phases[0].tasks.find(x => x.id === 'code.cGFyZW50').status, 'done');
  assert.deepEqual(resumed.mappings, proposal.mappings);
});

test('builder rejects duplicate identities, missing parents, cycles, invalid statuses and unknown fields without writes', t => {
  const f = fixture(t);
  for (const change of [
    x => x.inventory.entities.push(entity('parent')),
    x => x.inventory.entities[0].parentIds.push('missing'),
    x => x.inventory.entities[0].parentIds.push('child'),
    x => x.workflow.phases[0].tasks[0].status = 'success',
    x => { x.workflow.phases[0].tasks[0].status = 'pending'; x.workflow.phases[0].tasks[1].status = 'done'; },
    x => x.inventory.entities[0].status = 'done',
  ]) {
    const input = buildInput(); change(input);
    const r = f.run('build-work-items', input, ['--out', join(f.dir, 'bad.json')]);
    assert.equal(r.status, 1);
    assert.ok(r.output.errors.length);
    assert.ok(!readdirSync(f.dir).includes('bad.json'));
  }
});

test('CLIs are read-only by default and never overwrite an explicit existing destination', t => {
  const f = fixture(t), input = buildInput();
  assert.equal(f.run('build-work-items', input).status, 0);
  assert.deepEqual(readdirSync(f.dir), ['input.json']);
  const original = readFileSync(join(f.dir, 'input.json'), 'utf8');
  assert.equal(f.run('build-work-items', input, ['--out', join(f.dir, 'input.json')]).status, 1);
  assert.equal(readFileSync(join(f.dir, 'input.json'), 'utf8'), original);
});

test('task packet packages only the canonical next task and its declared inputs', t => {
  const f = fixture(t);
  const input = {
    inventory: { version: 1, scopeId: 'site:en', entities: [entity('hero', {
      routeIds: ['/'], joins: ['source-report:Hero'], uncertainty: [],
    })] },
    workflow: { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [
      { id: 'gate', title: 'Gate', status: 'done', dependsOn: [] },
      { id: 'code.hero', title: 'Hero rendering', status: 'pending', dependsOn: ['gate'], agent: 'frontend-developer' },
    ] }] },
    mappings: [{ entityId: 'hero', taskId: 'code.hero', routeIds: ['/'] }],
    scopeId: 'site:en',
    taskId: 'code.hero',
    targetRoot: 'repos/target-app',
    attemptRoot: 'evidence/code.hero/attempt-1',
    inputs: [
      { path: 'discovery/synthesis/coverage-plan.json', sha256: hash('coverage') },
      { path: 'discovery/code/reports/source.json', sha256: hash('source') },
    ],
    acceptance: ['typecheck passes', 'agreed route renders'],
  };
  const out = join(f.dir, 'task-packet.json');
  const r = f.run('prepare-task-packet', input, ['--out', out]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const packet = JSON.parse(readFileSync(out));
  assert.equal(packet.kind, 'cms-migration-task-packet');
  assert.deepEqual(packet.task, { id: 'code.hero', title: 'Hero rendering', phaseId: 'code', agent: 'frontend-developer' });
  assert.deepEqual(packet.entities.map(item => item.id), ['hero']);
  assert.deepEqual(packet.inputs.map(item => item.path), [
    'discovery/code/reports/source.json',
    'discovery/synthesis/coverage-plan.json',
  ]);
  assert.deepEqual(packet.acceptance, input.acceptance);
  assert.deepEqual(packet.target, { root: 'repos/target-app', attemptRoot: 'evidence/code.hero/attempt-1' });
});

test('task packet rejects a task that is not the canonical dispatch recommendation', t => {
  const f = fixture(t);
  const input = {
    inventory: { version: 1, scopeId: 'site:en', entities: [entity('hero'), entity('card')] },
    workflow: { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [
      { id: 'gate', title: 'Gate', status: 'done', dependsOn: [] },
      { id: 'code.hero', title: 'Hero rendering', status: 'pending', dependsOn: ['gate'], agent: 'frontend-developer' },
      { id: 'code.card', title: 'Card rendering', status: 'pending', dependsOn: ['gate'], agent: 'frontend-developer' },
    ] }] },
    mappings: [{ entityId: 'hero', taskId: 'code.hero' }, { entityId: 'card', taskId: 'code.card' }],
    scopeId: 'site:en', taskId: 'code.hero', targetRoot: 'repos/target-app', attemptRoot: 'evidence/code.hero/attempt-1',
    inputs: [{ path: 'discovery/source.json', sha256: hash('source') }], acceptance: ['typecheck passes'],
  };
  const r = f.run('prepare-task-packet', input);
  assert.equal(r.status, 1);
  assert.match(r.output.errors.join(' '), /canonical next task|recommended/i);
});

function evidenceInput(f) {
  f.put('source.txt', 'source'); f.put('render.txt', 'render');
  const inputs = [{ path: 'source.txt', sha256: hash('source') }];
  const result = { taskId: 'gate', outcome: 'success', summary: 'Rendered', evidence: [{ kind: 'render', path: 'render.txt', role: 'target', scopeId: 'site:en', provenance: { producer: 'test', version: '1', sha256: hash('render'), inputs }, observation: 'Visible', checks: [{ name: 'render', passed: true }], unresolved: [] }], changedFiles: [], checkpoint: null, unresolved: [] };
  f.put('result.json', result);
  return { input: { workflow: workflow(), scopeId: 'site:en', inputs, results: ['result.json'], decisions: [] }, result };
}

test('evidence validates actual files and rejects missing, partial, malformed, stale and unapproved results', t => {
  const f = fixture(t), { input, result } = evidenceInput(f);
  let r = f.run('validate-evidence', input, ['--out', join(f.dir, 'validation.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'validation.json'))).verifiedTaskIds, ['gate']);
  for (const change of [
    x => x.evidence[0].path = 'absent.txt',
    x => x.evidence[0].provenance.inputs[0].sha256 = hash('old'),
    x => x.evidence[0].scopeId = 'other',
    x => x.evidence[0].checks = [],
    x => x.evidence[0].checks[0].passed = false,
    x => x.evidence = [],
    x => x.unresolved.push('partial'),
    x => x.changedFiles.push('render.txt'),
    x => x.outcome = 'done',
  ]) {
    const bad = structuredClone(result); change(bad); f.put('result.json', bad);
    r = f.run('validate-evidence', input);
    assert.equal(r.status, 1, JSON.stringify(bad));
  }
  f.put('result.json', result); f.put('source.txt', 'changed');
  assert.equal(f.run('validate-evidence', input).status, 1);
  f.put('source.txt', 'source');
  input.workflow.phases[0].tasks[0].id = 'setup.approve';
  input.workflow.phases[0].tasks[1].dependsOn = ['setup.approve'];
  result.taskId = 'setup.approve'; f.put('result.json', result);
  assert.equal(f.run('validate-evidence', input).status, 1);
  input.decisions.push({ id: 'ack', kind: 'phase-continuation', taskId: 'setup.approve', scopeId: 'site:en', choice: 'approve', rationale: 'Reviewed', userResponse: 'Continue', at: '2026-09-11T12:00:00Z', inputs: input.inputs });
  assert.equal(f.run('validate-evidence', input).status, 0);
});

test('task-attempt postflight validates evidence under the workspace and changed files under a nested target root', t => {
  const f = fixture(t);
  const putNested = (name, data) => {
    const path = join(f.dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const inputs = [{ path: 'migration-state/site-a/scope.json', sha256: hash('current scope') }];
  const resultPath = 'migration-state/site-a/evidence/code.preview/attempt-1/task-result.json';
  const screenshotPath = 'migration-state/site-a/evidence/code.preview/attempt-1/preview.png';
  putNested('migration-state/site-a/scope.json', 'current scope');
  putNested(screenshotPath, 'preview');
  putNested('repos/target-app/src/Layout.tsx', 'layout');
  putNested('migration-state/site-a/workflow.json', { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [
    { id: 'historical.done', title: 'Historical task', status: 'done', dependsOn: [] },
    { id: 'code.preview', title: 'Preview', status: 'running', dependsOn: [] },
  ] }] });
  // This legacy record is intentionally malformed. It belongs to a different
  // task, so immediate postflight must not parse it; a full workflow audit
  // remains responsible for reporting and repairing it.
  putNested('migration-state/site-a/decisions.json', [{
    id: 'historical-decision', kind: 'scope', scopeId: 'site:en', taskId: 'historical.done', choice: 'include', rationale: 'Historical', inputs: [{ path: 'old-scope.json' }],
  }]);
  putNested(resultPath, {
    taskId: 'code.preview', outcome: 'success', summary: 'Preview ready',
    evidence: [{ kind: 'target-parity', path: screenshotPath, role: 'target', scopeId: 'site:en', provenance: { producer: 'test', version: '1', sha256: hash('preview'), inputs }, observation: 'Visible', checks: [{ name: 'render', passed: true }], unresolved: [] }],
    changedFiles: ['src/Layout.tsx'], checkpoint: { reference: 'checkpoint', scope: ['src/Layout.tsx'] }, unresolved: [],
  });
  const request = {
    workflowPath: 'migration-state/site-a/workflow.json', decisionsPath: 'migration-state/site-a/decisions.json', scopeId: 'site:en', inputs,
    taskId: 'code.preview', resultPath, changedFilesRoot: 'repos/target-app', requiredEvidenceKinds: ['target-parity'],
  };
  const out = join(f.dir, 'postflight-report.json');
  const r = f.run('validate-task-attempt', request, ['--workspace-root', f.dir, '--out', out]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.deepEqual(JSON.parse(readFileSync(out)).verifiedTaskIds, ['code.preview']);
});

test('task-attempt postflight explains when changed paths are workspace-relative instead of target-root-relative', t => {
  const f = fixture(t);
  f.put('workflow.json', { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [{ id: 'code.preview', title: 'Preview', status: 'running', dependsOn: [] }] }] });
  f.put('decisions.json', []);
  f.put('scope.txt', 'scope');
  mkdirSync(join(f.dir, 'repos/target-app/src'), { recursive: true });
  f.put('repos/target-app/src/Layout.tsx', 'layout');
  f.put('result.json', {
    taskId: 'code.preview', outcome: 'success', summary: 'Changed', evidence: [],
    changedFiles: ['repos/target-app/src/Layout.tsx'],
    checkpoint: { reference: 'checkpoint', scope: ['repos/target-app/src/Layout.tsx'] },
    unresolved: [],
  });
  const request = {
    workflowPath: 'workflow.json', decisionsPath: 'decisions.json', scopeId: 'site:en',
    inputs: [{ path: 'scope.txt', sha256: hash('scope') }], taskId: 'code.preview', resultPath: 'result.json',
    changedFilesRoot: 'repos/target-app',
  };
  const r = f.run('validate-task-attempt', request, ['--workspace-root', f.dir]);
  assert.equal(r.status, 1);
  assert.match(r.output.errors.join(' '), /relative to changedFilesRoot/i);
});

test('task-attempt postflight rejects malformed decisions bound to its selected task', t => {
  const f = fixture(t);
  f.put('workflow.json', { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [{ id: 'code.preview', title: 'Preview', status: 'running', dependsOn: [] }] }] });
  f.put('scope.txt', 'scope');
  f.put('render.txt', 'render');
  const inputs = [{ path: 'scope.txt', sha256: hash('scope') }];
  f.put('result.json', { taskId: 'code.preview', outcome: 'success', summary: 'Ready', evidence: [{ kind: 'target-parity', path: 'render.txt', role: 'target', scopeId: 'site:en', provenance: { producer: 'test', version: '1', sha256: hash('render'), inputs }, observation: 'Visible', checks: [{ name: 'render', passed: true }], unresolved: [] }], changedFiles: [], checkpoint: null, unresolved: [] });
  f.put('decisions.json', [{ id: 'bad-current', kind: 'verification', scopeId: 'site:en', taskId: 'code.preview', choice: 'verified', rationale: 'Broken provenance', inputs: [{ path: 'scope.txt' }] }]);
  const request = { workflowPath: 'workflow.json', decisionsPath: 'decisions.json', scopeId: 'site:en', inputs, taskId: 'code.preview', resultPath: 'result.json', requiredEvidenceKinds: ['target-parity'] };
  const r = f.run('validate-task-attempt', request, ['--workspace-root', f.dir]);
  assert.equal(r.status, 1);
  assert.match(r.output.errors.join(' '), /sha256/i);
});

test('task-attempt postflight rejects a changed-files root outside the selected workspace', t => {
  const f = fixture(t);
  f.put('workflow.json', { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [{ id: 'code.preview', title: 'Preview', status: 'running', dependsOn: [] }] }] });
  f.put('decisions.json', []);
  f.put('scope.txt', 'scope');
  f.put('result.json', { taskId: 'code.preview', outcome: 'success', summary: 'Changed', evidence: [], changedFiles: ['src/Layout.tsx'], checkpoint: { reference: 'checkpoint', scope: ['src/Layout.tsx'] }, unresolved: [] });
  const request = { workflowPath: 'workflow.json', decisionsPath: 'decisions.json', scopeId: 'site:en', inputs: [{ path: 'scope.txt', sha256: hash('scope') }], taskId: 'code.preview', resultPath: 'result.json', changedFilesRoot: '../outside' };
  const r = f.run('validate-task-attempt', request, ['--workspace-root', f.dir]);
  assert.equal(r.status, 1);
  assert.match(r.output.errors.join(' '), /Unsafe scoped path|changed files root/i);
});

test('coverage distinguishes factual scope, explicit exclusions, sampled routes and unverified done tasks', t => {
  const f = fixture(t), inv = inventory();
  inv.entities.push(entity('excluded', { scope: 'excluded', routeIds: ['/other'] }));
  const input = { inventory: inv, workflow: workflow(), mappings: [{ entityId: 'parent', taskId: 'gate' }], decisions: [], sampledRouteIds: ['/'] };
  let r = f.run('coverage-report', input, ['--out', join(f.dir, 'coverage.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  let report = JSON.parse(readFileSync(join(f.dir, 'coverage.json')));
  assert.equal(report.counts.verified, 0);
  assert.equal(report.counts.excluded, 0);
  assert.deepEqual(report.missingEntityIds, ['child', 'excluded']);
  assert.deepEqual(report.unsampledRouteIds, ['/nested', '/other']);
  f.put('scope.json', inv);
  input.inputs = [{ path: 'scope.json', sha256: hash(JSON.stringify(inv)) }];
  input.decisions.push({ id: 'exclude', kind: 'scope', scopeId: 'site:en', entityId: 'excluded', choice: 'exclude', rationale: 'Out of scope', userResponse: 'Exclude it', at: '2026-09-11T12:00:00Z', inputs: input.inputs });
  r = f.run('coverage-report', input, ['--out', join(f.dir, 'coverage2.json')]);
  report = JSON.parse(readFileSync(join(f.dir, 'coverage2.json')));
  assert.equal(report.counts.excluded, 1);
  assert.deepEqual(report.missingEntityIds, ['child']);
  input.mappings.push({ entityId: 'parent', taskId: 'items' });
  assert.equal(f.run('coverage-report', input).status, 1);
});

test('coverage and next-work support user-approved batch tasks mapping multiple entities to one task', t => {
  const f = fixture(t);
  const inv = { version: 1, scopeId: 'site:en', entities: [entity('hero'), entity('card', { routeIds: ['/about'] })] };
  const state = { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [
    { id: 'gate', title: 'Gate', status: 'done', dependsOn: [] },
    { id: 'batch.hero-card', title: 'Convert hero and card together', status: 'pending', dependsOn: ['gate'] },
  ] }] };
  const mappings = [{ entityId: 'hero', taskId: 'batch.hero-card' }, { entityId: 'card', taskId: 'batch.hero-card' }];
  const next = nextWork(f, { inventory: inv, workflow: state, mappings });
  assert.equal(next.eligibleTotal, 1);
  assert.equal(next.counts.pending, 1, 'task status counts are task-based, not duplicated per entity');
  assert.deepEqual(next.next[0].entityIds, ['card', 'hero']);
  assert.equal(next.next[0].taskId, 'batch.hero-card');

  const reportPath = join(f.dir, 'batch-coverage.json');
  const run = f.run('coverage-report', { inventory: inv, workflow: state, mappings, decisions: [] }, ['--out', reportPath]);
  assert.equal(run.status, 0, JSON.stringify(run.output));
  const report = JSON.parse(readFileSync(reportPath));
  assert.equal(report.counts.pending, 2, 'entity coverage reflects the one shared task status for each mapped entity');
  assert.deepEqual(report.entityCoverage.map(item => item.taskId), ['batch.hero-card', 'batch.hero-card']);
});

test('coverage requires per-entity evidence for a grouped task and preserves proven entities on partial failure', t => {
  const f = fixture(t);
  const inv = { version: 1, scopeId: 'site:en', entities: [entity('hero'), entity('card')] };
  const state = { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [
    { id: 'batch.hero-card', title: 'Convert hero and card', status: 'done', dependsOn: [] },
  ] }] };
  const mappings = [{ entityId: 'hero', taskId: 'batch.hero-card' }, { entityId: 'card', taskId: 'batch.hero-card' }];
  f.put('source.txt', 'source'); const inputs = [{ path: 'source.txt', sha256: hash('source') }];
  const addEvidence = (entityId, passed = true) => {
    const body = JSON.stringify({ version: 1, taskId: 'batch.hero-card', entityId, outcome: passed ? 'success' : 'blocked',
      summary: passed ? 'Rendering passed' : 'Rendering has a visual mismatch', changedFiles: [], checkpoint: null,
      checks: [{ name: 'render', passed, detail: passed ? 'Rendered' : 'Visual mismatch' }], decisionIds: [], unresolved: passed ? [] : ['visual mismatch'] });
    const path = entityId + '.json'; f.put(path, body);
    return { kind: 'entity-result', path, role: 'target', scopeId: 'site:en', entityId,
      provenance: { producer: 'test', version: '1', sha256: hash(body), inputs }, observation: 'Rendering result',
      checks: [{ name: 'render', passed }], unresolved: passed ? [] : ['visual mismatch'] };
  };
  const hero = addEvidence('hero');
  const result = { taskId: 'batch.hero-card', outcome: 'success', summary: 'Only hero evidence was supplied', evidence: [hero], changedFiles: [], checkpoint: null, unresolved: [] };
  f.put('result.json', result);
  const validation = { workflow: state, scopeId: 'site:en', inputs, results: ['result.json'], decisions: [] };
  let r = f.run('coverage-report', { inventory: inv, workflow: state, mappings, decisions: [], inputs, validation }, ['--out', join(f.dir, 'coverage.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  let report = JSON.parse(readFileSync(join(f.dir, 'coverage.json')));
  assert.deepEqual(report.entityCoverage.map(x => [x.entityId, x.state]), [['card', 'unverified'], ['hero', 'verified']]);

  const card = addEvidence('card', false);
  result.outcome = 'blocked'; result.summary = 'One rendering remains blocked'; result.unresolved = ['card has a visual mismatch']; result.evidence = [hero, card];
  state.phases[0].tasks[0].status = 'blocked'; f.put('result.json', result);
  r = f.run('coverage-report', { inventory: inv, workflow: state, mappings, decisions: [], inputs, validation }, ['--out', join(f.dir, 'partial.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  report = JSON.parse(readFileSync(join(f.dir, 'partial.json')));
  assert.deepEqual(report.entityCoverage.map(x => [x.entityId, x.state]), [['card', 'blocked'], ['hero', 'verified']]);
  assert.ok(report.evidenceErrors.length);

  const forged = { ...hero, kind: 'render' };
  result.outcome = 'success'; result.unresolved = []; result.evidence = [forged]; state.phases[0].tasks[0].status = 'done'; f.put('result.json', result);
  r = f.run('coverage-report', { inventory: inv, workflow: state, mappings, decisions: [], inputs, validation }, ['--out', join(f.dir, 'unstructured.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  report = JSON.parse(readFileSync(join(f.dir, 'unstructured.json')));
  assert.deepEqual(report.entityCoverage.map(x => [x.entityId, x.state]), [['card', 'unverified'], ['hero', 'unverified']], 'non-entity-result evidence cannot claim a batch member is verified');
});

test('entity visual attestation is separate from technical success and bound to selected task/evidence hashes', t => {
  const f = fixture(t), inv = { version: 1, scopeId: 'site:en', entities: [entity('hero')] };
  const state = { version: 1, phases: [{ id: 'code', title: 'Code', tasks: [{ id: 'code.hero', title: 'Hero', status: 'done', dependsOn: [] }] }] };
  const inputs = [{ path: 'source.txt', sha256: hash('source') }]; f.put('source.txt', 'source');
  const entityBody = summary => JSON.stringify({ version: 1, taskId: 'code.hero', entityId: 'hero', outcome: 'success', summary,
    changedFiles: [], checkpoint: null, checks: [{ name: 'browser-render', passed: true }], decisionIds: [], unresolved: [] });
  const writeAttempt = summary => {
    const body = entityBody(summary); f.put('hero.json', body);
    const evidence = { kind: 'entity-result', path: 'hero.json', role: 'target', scopeId: 'site:en', entityId: 'hero',
      provenance: { producer: 'test', version: '1', sha256: hash(body), inputs }, observation: summary,
      checks: [{ name: 'browser-render', passed: true }], unresolved: [] };
    const resultBody = JSON.stringify({ taskId: 'code.hero', outcome: 'success', summary, evidence: [evidence], changedFiles: [], checkpoint: null, unresolved: [] });
    f.put('result.json', resultBody);
    return { resultBody, evidence };
  };
  let attempt = writeAttempt('Hero rendered as expected');
  const validation = { workflow: state, scopeId: 'site:en', inputs, results: ['result.json'], decisions: [] };
  const outer = { inventory: inv, workflow: state, mappings: [{ entityId: 'hero', taskId: 'code.hero' }], decisions: [], inputs, validation };
  let reportIndex = 0;
  const run = () => {
    const out = join(f.dir, `attestation-coverage-${reportIndex++}.json`);
    const r = f.run('coverage-report', outer, ['--out', out]);
    assert.equal(r.status, 0, JSON.stringify(r.output));
    return JSON.parse(readFileSync(out));
  };
  let report = run();
  assert.equal(report.entityCoverage[0].state, 'verified');
  assert.equal(report.entityCoverage[0].attestation, 'unattested');
  assert.equal(report.attestationCounts.unattested, 1);

  const decision = { id: 'verify:code.hero:hero', kind: 'verification', scopeId: 'site:en', taskId: 'code.hero', entityId: 'hero',
    choice: 'verified', rationale: 'Reviewed the rendering against the target route', userResponse: 'Verified', at: '2026-09-28T12:00:00Z',
    inputs: [{ path: 'result.json', sha256: hash(attempt.resultBody) }, { path: 'hero.json', sha256: attempt.evidence.provenance.sha256 }] };
  validation.decisions = [decision];
  report = run();
  assert.equal(report.entityCoverage[0].state, 'verified', 'human attestation does not replace technical state');
  assert.equal(report.entityCoverage[0].attestation, 'attested');
  assert.equal(report.attestationCounts.attested, 1);

  decision.choice = 'not-verified'; decision.userResponse = 'The spacing still looks wrong';
  report = run();
  assert.equal(report.entityCoverage[0].attestation, 'not-verified');

  decision.choice = 'verified'; decision.userResponse = 'Verified';
  attempt = writeAttempt('Hero rerendered after a code adjustment');
  report = run();
  assert.equal(report.entityCoverage[0].state, 'verified');
  assert.equal(report.entityCoverage[0].attestation, 'stale', 'a new selected attempt invalidates the previous attestation');
});

test('builder rejects collisions with unrelated existing tasks instead of adopting their status', t => {
  const f = fixture(t), input = buildInput();
  input.workflow.phases[0].tasks.push({ id: 'code.cGFyZW50', title: 'Unrelated operation', status: 'done', dependsOn: ['gate'] });
  const r = f.run('build-work-items', input);
  assert.equal(r.status, 1);
  assert.match(r.output.errors.join(' '), /collision/i);
});

test('coverage never counts skipped approval gates as explicitly skipped work', t => {
  const f = fixture(t), input = { inventory: inventory(), workflow: workflow(), mappings: [{ entityId: 'parent', taskId: 'gate' }, { entityId: 'child', taskId: 'items' }], decisions: [] };
  input.workflow.phases[0].tasks[0].id = 'setup.approve';
  input.workflow.phases[0].tasks[0].status = 'skipped';
  input.workflow.phases[0].tasks[1].dependsOn = ['setup.approve'];
  input.mappings[0].taskId = 'setup.approve';
  const r = f.run('coverage-report', input, ['--out', join(f.dir, 'coverage.json')]);
  assert.equal(r.status, 0);
  const report = JSON.parse(readFileSync(join(f.dir, 'coverage.json')));
  assert.equal(report.counts.explicitlySkipped, 0);
  assert.ok(report.unresolvedEntityIds.includes('parent'));
});

test('schema rejects empty IDs, malformed provenance and invalid workflows in real CLIs', t => {
  const f = fixture(t), { input, result } = evidenceInput(f);
  for (const change of [x => x.taskId = '', x => x.evidence[0].provenance.sha256 = 'bad', x => x.evidence[0].surprise = true]) {
    const bad = structuredClone(result); change(bad); f.put('result.json', bad);
    const r = f.run('validate-evidence', input); assert.equal(r.status, 1); assert.match(r.output.errors.join(' '), /task-result/);
  }
  f.put('result.json', result);
  input.results = ['missing-result.json'];
  assert.equal(f.run('validate-evidence', input).status, 1);
  input.results = ['result.json', 'second.json']; f.put('second.json', result);
  const r = f.run('validate-evidence', input, ['--out', join(f.dir, 'duplicate.json')]);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'duplicate.json'))).verifiedTaskIds, []);
});

test('isolated skill copy expands an explicitly approved evidence-led workflow', t => {
  const f = fixture(t), isolated = join(f.dir, 'skill'); cpSync(root, isolated, { recursive: true });
  const input = { inventory: { version: 1, scopeId: 'multilingual', entities: [entity('mvc:hero:en', { kind: 'mvc' }), entity('mvc:hero:fr', { kind: 'mvc' }), entity('headless:hero:en', { kind: 'headless', joins: ['mvc:hero:en'] })] }, workflow: { version: 1, phases: [
    { id: 'setup', title: '0 — Setup', tasks: [{ id: 'setup.audit', title: 'Audit Setup', status: 'pending', dependsOn: [] }] },
    { id: 'discovery', title: '1 — Discovery', tasks: [{ id: 'discovery.audit', title: 'Audit Discovery', status: 'pending', dependsOn: ['setup.audit'] }] },
    { id: 'code-migration', title: '2 — Code Migration', tasks: [{ id: 'code.items', title: 'Migrate approved code', status: 'pending', dependsOn: ['discovery.audit'] }] },
    { id: 'resolver-adapters', title: '3 — Resolver Adapters', tasks: [{ id: 'resolvers.items', title: 'Implement approved adapters', status: 'pending', dependsOn: ['code.items'] }] },
  ] }, profile: { rules: [
    { kind: 'mvc', phaseId: 'code-migration', anchorTaskId: 'code.items', prefix: 'mvc' },
    { kind: 'headless', phaseId: 'resolver-adapters', anchorTaskId: 'resolvers.items', prefix: 'headless' },
  ] } };
  f.put('input.json', input);
  const r = spawnSync(process.execPath, [join(isolated, 'scripts/build-work-items.mjs'), '--input', join(f.dir, 'input.json'), '--out', join(f.dir, 'six.json')], { cwd: f.dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(f.dir, 'six.json')));
  assert.equal(report.workflow.phases.length, 4);
  assert.equal(new Set(report.mappings.map(m => m.taskId)).size, 3);
  assert.ok(report.workflow.phases.flatMap(p => p.tasks).every(task => task.status === 'pending'));
  assert.ok(report.workflow.phases[2].tasks.find(task => task.id === 'code.items').dependsOn.includes('mvc.bXZjOmhlcm86ZW4'));
  assert.ok(report.workflow.phases[3].tasks.find(task => task.id === 'headless.aGVhZGxlc3M6aGVybzplbg').dependsOn.includes('code.items'));
});

test('builder warns about a parent that is not in scope and rejects unsupported parent-task dependencies', t => {
  const f = fixture(t), input = buildInput();
  input.inventory.entities[0].scope = 'excluded';
  let r = f.run('build-work-items', input, ['--out', join(f.dir, 'excluded-parent.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const proposal = JSON.parse(readFileSync(join(f.dir, 'excluded-parent.json')));
  assert.ok(proposal.warnings.some(x => x.includes('parent parent is not included')));
  assert.equal(proposal.mappings.length, 1);
  const existingPlan = buildInput();
  r = f.run('build-work-items', existingPlan, ['--out', join(f.dir, 'fresh.json')]);
  const fresh = JSON.parse(readFileSync(join(f.dir, 'fresh.json')));
  fresh.workflow.phases[0].tasks.find(x => x.id === 'code.Y2hpbGQ').dependsOn.push('code.cGFyZW50');
  existingPlan.workflow = fresh.workflow;
  r = f.run('build-work-items', existingPlan);
  assert.equal(r.status, 1);
  assert.match(r.output.errors[0], /task dependency conflict/i);
});

// Hosting scenarios use a hand-built workflow so each task status is explicit.
let nextRuns = 0;
const hosting = (spec, extra = {}) => {
  const names = Object.keys(spec), planned = names.filter(id => (spec[id].scope ?? 'included') === 'included');
  const entities = names.map(id => entity(id, { parentIds: spec[id].parents ?? [], routeIds: spec[id].routes ?? ['/'], uncertainty: spec[id].uncertainty ?? [], joins: spec[id].joins ?? [], scope: spec[id].scope ?? 'included' }));
  const { gate = 'done', ...rest } = extra;
  const tasks = [{ id: 'gate', title: 'Gate', status: gate, dependsOn: [] },
    ...planned.map(id => ({ id: 't-' + id, title: 'component: ' + id, status: spec[id].status ?? 'pending', dependsOn: ['gate'] })),
    { id: 'items', title: 'Items', status: 'pending', dependsOn: planned.map(id => 't-' + id) }];
  return { inventory: { version: 1, scopeId: 'site:en', entities }, workflow: { version: 1, phases: [{ id: 'code', title: 'Code', tasks }] }, mappings: planned.map(id => ({ entityId: id, taskId: 't-' + id })), ...rest };
};
const nextWork = (f, input, flags = []) => {
  const out = join(f.dir, `next-${nextRuns++}.json`), r = f.run('next-work', input, ['--out', out, ...flags]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  return JSON.parse(readFileSync(out));
};
const taskIds = report => report.next.map(x => x.taskId);

const inputFingerprint = inputs => hash(JSON.stringify([...inputs].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha256 }) => [path, sha256])));
const verificationInput = (f, statuses = { a: 'attested' }, fingerprint = null) => {
  const input = hosting({ a: { status: 'done' }, b: {} });
  for (const task of input.workflow.phases[0].tasks) if (task.id.startsWith('t-')) task.agent = 'frontend-developer';
  const inputs = [{ path: 'evidence.json', sha256: hash('current evidence') }];
  input.inputs = inputs;
  const currentFingerprint = inputFingerprint(inputs);
  input.validation = {
    valid: true,
    inputs,
    inputFingerprint: fingerprint ?? currentFingerprint,
    entityAttestations: Object.entries(statuses).map(([entityId, status]) => ({
      entityId, taskId: 't-' + entityId, status, fingerprint: fingerprint ?? currentFingerprint,
    })),
  };
  return input;
};

test('next-work holds the next task until every completed mapped entity is verified', t => {
  const f = fixture(t);
  let r = nextWork(f, verificationInput(f, { a: 'unattested' }));
  assert.equal(r.status, 'waiting');
  assert.deepEqual(r.next, []);
  assert.equal(r.starvedByReason['user-verification'], 1);
  assert.equal(r.starved[0].taskId, 't-b');
  assert.equal(r.starved[0].needsDecision, true);

  r = nextWork(f, verificationInput(f, { a: 'attested' }));
  assert.equal(r.status, 'has-pending');
  assert.deepEqual(r.next.map(item => item.taskId), ['t-b']);
});

test('evidence can require explicit evidence kinds for a selected task without changing the default contract', t => {
  const f = fixture(t), { input, result } = evidenceInput(f);
  input.requiredEvidenceKindsByTask = { gate: ['target-parity'] };
  assert.equal(f.run('validate-evidence', input).status, 1);
  result.evidence[0].kind = 'target-parity';
  f.put('result.json', result);
  const matchingKinds = f.run('validate-evidence', input);
  assert.equal(matchingKinds.status, 0, JSON.stringify(matchingKinds.output));
  input.requiredEvidenceKindsByTask = { missing: ['target-parity'] };
  assert.equal(f.run('validate-evidence', input).status, 1);
});

test('next-work treats a stale verification fingerprint as unresolved', t => {
  const f = fixture(t);
  const input = verificationInput(f, { a: 'attested' }, '0'.repeat(64));
  const r = nextWork(f, input);
  assert.equal(r.status, 'waiting');
  assert.deepEqual(r.next, []);
  assert.equal(r.starved[0].reason, 'user-verification');
  assert.match(r.starved[0].warning, /stale|fingerprint/i);
  const invalid = verificationInput(f, { a: 'unknown-status' });
  assert.equal(f.run('next-work', invalid).status, 1);
});

test('next-work offers seeds first and holds children until a host is done', t => {
  const f = fixture(t), spec = { root: { routes: ['/', '/a', '/b'] }, a: { parents: ['root'] }, b: { parents: ['root'] }, leaf: { parents: ['a'] } };
  let r = nextWork(f, hosting(spec));
  assert.equal(r.status, 'has-pending');
  assert.deepEqual(taskIds(r), ['t-root']);
  assert.equal(r.next[0].via, 'seed');
  assert.deepEqual(r.starvedByReason, { 'waiting-for-host': 3 });
  spec.root.status = 'done';
  r = nextWork(f, hosting(spec));
  assert.deepEqual(taskIds(r), ['t-a', 't-b'], 'a unlocks leaf, so it ranks before b');
  assert.deepEqual(r.next[0].hostedBy, ['root']);
  assert.equal(r.next[0].rank.unlocks, 1);
  assert.deepEqual(r.starved.map(x => [x.entityId, x.reason]), [['leaf', 'waiting-for-host']]);
  spec.a.status = 'done';
  assert.deepEqual(taskIds(nextWork(f, hosting(spec))), ['t-b', 't-leaf']);
});

test('next-work treats hosting as any-of: one done parent is enough', t => {
  const f = fixture(t);
  const r = nextWork(f, hosting({ p1: { status: 'done' }, p2: {}, shared: { parents: ['p1', 'p2'] } }));
  assert.deepEqual(taskIds(r), ['t-p2', 't-shared']);
  assert.deepEqual(r.next.find(x => x.entityId === 'shared').hostedBy, ['p1']);
});

test('next-work reports failed, skipped and out-of-scope hosts for a decision and honors the explicit override', t => {
  const f = fixture(t);
  const spec = { p1: { status: 'failed' }, c1: { parents: ['p1'] }, p2: { status: 'skipped' }, c2: { parents: ['p2'] }, px: { scope: 'excluded' }, c3: { parents: ['px'] }, p4: { status: 'running' }, c4: { parents: ['p4'] } };
  let r = nextWork(f, hosting(spec));
  assert.equal(r.status, 'blocked');
  assert.equal(r.eligibleTotal, 0);
  assert.deepEqual(r.starvedByReason, { 'host-failed': 1, 'host-skipped': 1, 'host-out-of-scope': 1, 'waiting-for-host': 1 });
  assert.deepEqual(Object.fromEntries(r.starved.map(x => [x.entityId, x.needsDecision])), { c1: true, c2: true, c3: true, c4: false });
  r = nextWork(f, hosting(spec, { proceedWithoutHost: ['c1', 'c3'] }));
  assert.equal(r.status, 'has-pending');
  assert.deepEqual(r.next.map(x => [x.entityId, x.via, x.verification]), [['c1', 'without-host', 'isolated-only'], ['c3', 'without-host', 'isolated-only']]);
  assert.deepEqual(r.starved.map(x => x.entityId), ['c2', 'c4']);
  assert.equal(f.run('next-work', hosting(spec, { proceedWithoutHost: ['nope'] })).status, 1);
  r = nextWork(f, hosting(spec, { proceedWithoutHost: ['p1', 'c1'] }));
  assert.ok(r.warnings.some(x => x.includes('had no effect for: p1')));
});

test('next-work separates ordering dependencies, waiting, blocked and complete', t => {
  const f = fixture(t);
  let r = nextWork(f, hosting({ a: {}, b: { parents: ['a'] } }, { gate: 'pending' }));
  assert.equal(r.status, 'waiting');
  assert.deepEqual(r.starved.map(x => [x.entityId, x.reason, x.waitingOn]), [['a', 'dependency', ['gate']], ['b', 'dependency', ['gate']]]);
  r = nextWork(f, hosting({ p: { status: 'running' }, c: { parents: ['p'] } }));
  assert.equal(r.status, 'waiting');
  r = nextWork(f, hosting({ a: { status: 'done' }, b: { status: 'skipped' } }));
  assert.equal(r.status, 'all-complete');
  const later = hosting({ a: {} });
  later.workflow.phases.unshift({ id: 'discovery', title: 'Discovery', tasks: [{ id: 'd', title: 'D', status: 'pending', dependsOn: [] }] });
  r = nextWork(f, later);
  assert.equal(r.status, 'none-in-phase');
  assert.equal(r.phase, 'discovery');
});

test('next-work ranks used, unlocking, widely placed, certain and simple items first with a stable tiebreak', t => {
  const f = fixture(t);
  const spec = () => hosting({ unused: { routes: [] }, shaky: { uncertainty: ['unknown'] }, coupled: { joins: ['plain'] }, plain: {}, wide: { routes: ['/', '/x', '/y'] }, a2: {}, a1: {} });
  const r = nextWork(f, spec());
  assert.deepEqual(r.next.map(x => x.entityId), ['wide', 'a1', 'a2', 'plain', 'coupled']);
  assert.equal(r.eligibleTotal, 7);
  assert.deepEqual(nextWork(f, spec(), ['--limit', '10']).next.map(x => x.entityId), ['wide', 'a1', 'a2', 'plain', 'coupled', 'shaky', 'unused']);
});

test('next-work is read-only, bounds its list and rejects a bad limit', t => {
  const f = fixture(t), input = hosting({ a: {}, b: {}, c: {} });
  assert.equal(nextWork(f, input, ['--limit', '1']).next.length, 1);
  for (const bad of ['0', '51', '1.5', 'x']) assert.equal(f.run('next-work', input, ['--limit', bad]).status, 1, bad);
  const stdout = f.run('next-work', input);
  assert.equal(stdout.status, 0);
  assert.deepEqual(stdout.output.nextTaskIds, ['t-a', 't-b', 't-c']);
  assert.deepEqual(readdirSync(f.dir).filter(x => x !== 'input.json' && !x.startsWith('next-')), []);
});

test('builder reports a task whose entity left the inventory as an orphan, keeps its progress and never crashes', t => {
  const f = fixture(t), input = buildInput();
  input.inventory = { version: 1, scopeId: 'site:en', entities: [entity('a'), entity('b')] };
  let r = f.run('build-work-items', input, ['--out', join(f.dir, 'first.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const first = JSON.parse(readFileSync(join(f.dir, 'first.json')));
  assert.deepEqual(first.orphanedTasks, []);
  // Re-discovery excludes b while its task is still pending.
  const again = { ...buildInput(), workflow: first.workflow, inventory: { version: 1, scopeId: 'site:en', entities: [entity('a'), entity('b', { scope: 'excluded' })] } };
  r = f.run('build-work-items', again, ['--out', join(f.dir, 'second.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const second = JSON.parse(readFileSync(join(f.dir, 'second.json')));
  assert.deepEqual(second.orphanedTasks.map(x => [x.taskId, x.status]), [['code.Yg', 'pending']]);
  assert.deepEqual(second.mappings.map(x => x.entityId), ['a']);
  assert.ok(second.warnings.some(x => x.includes('code.Yg') && x.includes('still blocks items')));
  const tasks = second.workflow.phases[0].tasks;
  assert.equal(tasks.find(x => x.id === 'code.Yg').status, 'pending', 'the orphan is kept, not deleted');
  assert.ok(tasks.find(x => x.id === 'items').dependsOn.includes('code.Yg'), 'it stays visible by still blocking its anchor');
  assert.deepEqual(tasks.find(x => x.id === 'code.YQ').dependsOn, ['gate'], 'a live task keeps only structural prerequisites');
  // Once the coordinator resolves it, the orphan is informational only.
  tasks.find(x => x.id === 'code.Yg').status = 'skipped';
  r = f.run('build-work-items', { ...again, workflow: second.workflow }, ['--out', join(f.dir, 'third.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const third = JSON.parse(readFileSync(join(f.dir, 'third.json')));
  assert.deepEqual(third.orphanedTasks.map(x => [x.taskId, x.status]), [['code.Yg', 'skipped']]);
  assert.ok(!third.warnings.some(x => x.includes('still blocks')));
});

test('builder does not mistake a structural prerequisite of the anchor for an orphan', t => {
  const f = fixture(t), input = buildInput();
  input.workflow.phases[0].tasks.splice(1, 0, { id: 'code.styles', title: 'Shared styles', status: 'pending', dependsOn: ['gate'] });
  input.workflow.phases[0].tasks.find(x => x.id === 'items').dependsOn = ['code.styles', 'gate'];
  input.inventory = { version: 1, scopeId: 'site:en', entities: [entity('a'), entity('b')] };
  let r = f.run('build-work-items', input, ['--out', join(f.dir, 'first.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  const first = JSON.parse(readFileSync(join(f.dir, 'first.json')));
  assert.deepEqual(first.workflow.phases[0].tasks.find(x => x.id === 'code.YQ').dependsOn, ['code.styles', 'gate']);
  const again = { ...input, workflow: first.workflow, inventory: { version: 1, scopeId: 'site:en', entities: [entity('a'), entity('b', { scope: 'excluded' })] } };
  r = f.run('build-work-items', again, ['--out', join(f.dir, 'second.json')]);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'second.json'))).orphanedTasks.map(x => x.taskId), ['code.Yg']);
});
