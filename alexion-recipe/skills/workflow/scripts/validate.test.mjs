import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const module = await import('./validate.mjs').catch(() => ({}));
const validate = module.validateWorkflow;
const task = (id, dependsOn = [], status = 'pending') => ({ id, title: id, status, dependsOn });
const fixture = () => ({ version: 1, phases: [
  { id: 'prepare', title: 'Prepare', tasks: [task('inventory'), task('access'), task('approve', ['inventory', 'access'])] },
  { id: 'build', title: 'Build', tasks: [task('convert', ['approve'])] },
] });

test('validator is available as an importable function', () => assert.equal(typeof validate, 'function'));
test('independent tasks are runnable together; join waits; later phases wait', () => {
  const state = fixture();
  assert.deepEqual(validate(state).runnable, ['inventory', 'access']);
  state.phases[0].tasks[0].status = 'done';
  assert.deepEqual(validate(state).runnable, ['access']);
  state.phases[0].tasks[1].status = 'done';
  assert.deepEqual(validate(state).runnable, ['approve']);
  state.phases[0].tasks[2].status = 'done';
  assert.equal(validate(state).currentPhase, 'build');
  assert.deepEqual(validate(state).runnable, ['convert']);
});
test('missing or stale agent hints do not change scheduling or progress', () => {
  const state = fixture();
  const before = validate(state);
  state.phases[0].tasks[0].agent = 'deleted-agent';
  assert.deepEqual(validate(state), before);
});
test('failed/blocked/running tasks are not automatically retried or redispatched', () => {
  for (const status of ['failed', 'blocked', 'running']) {
    const state = fixture();
    state.phases[0].tasks[0].status = status;
    assert.deepEqual(validate(state).runnable, ['access']);
    assert.equal(validate(state).complete, false);
  }
});
test('all terminal tasks complete the workflow without mutating it', () => {
  const state = fixture();
  state.phases.flatMap(p => p.tasks).forEach(t => { t.status = 'done'; });
  const copy = structuredClone(state);
  assert.equal(validate(state).complete, true);
  assert.equal(validate(state).currentPhase, null);
  assert.deepEqual(state, copy);
});
test('explicit skips satisfy dependencies, not failures', () => {
  const state = fixture();
  state.phases[0].tasks[0].status = 'skipped';
  state.phases[0].tasks[1].status = 'done';
  assert.deepEqual(validate(state).runnable, ['approve']);
});
test('optional dependencies wait for a terminal enrichment result but allow synthesis after failure', () => {
  const state = { version: 1, phases: [{ id: 'discovery', title: 'Discovery', tasks: [
    task('code', [], 'running'), task('content', [], 'done'),
    { ...task('synthesize', ['content']), optionalDependsOn: ['code'] },
  ] }] };
  assert.deepEqual(validate(state).runnable, [], 'do not synthesize while optional code enrichment is running');
  state.phases[0].tasks[0].status = 'failed';
  assert.deepEqual(validate(state).runnable, ['synthesize'], 'a terminal code failure does not block synthesis');
  state.phases[0].tasks[0].status = 'blocked';
  assert.deepEqual(validate(state).runnable, [], 'a blocked enrichment still needs resolution');
  assert.equal(validate(state).phases[0].complete, false, 'a failed requested branch keeps Discovery incomplete');
});
test('rejects duplicate IDs, unknown dependencies, forward phase dependencies and cycles', () => {
  const cases = [
    s => { s.phases[0].tasks[1].id = 'inventory'; },
    s => { s.phases[0].tasks[0].dependsOn = ['missing']; },
    s => { s.phases[0].tasks[0].dependsOn = ['convert']; },
    s => { s.phases[0].tasks[0].dependsOn = ['approve']; },
    s => { s.phases[0].tasks[0].dependsOn = ['inventory']; },
    s => { s.phases[1].id = 'prepare'; },
  ];
  for (const change of cases) {
    const state = fixture(); change(state);
    const result = validate(state);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length);
    assert.deepEqual(result.runnable, []);
    assert.equal(result.complete, false);
  }
});
test('rejects malformed state and unsupported versions without throwing', () => {
  for (const state of [null, [], {}, { version: 2, phases: [] }, { version: 1, phases: [null] },
    { version: 1, phases: [] }, { version: 1, phases: [{ id: 'x', title: 'X', tasks: [null] }] }]) {
    assert.equal(validate(state).valid, false);
  }
});
test('rejects invalid statuses, malformed dependencies and agent hints', () => {
  for (const patch of [{ status: 'complete' }, { dependsOn: 'inventory' }, { agent: 7 }, { id: '' }]) {
    const state = fixture(); Object.assign(state.phases[0].tasks[0], patch);
    assert.equal(validate(state).valid, false);
  }
});
test('rejects completed/running work with unmet dependencies or earlier phases', () => {
  for (const status of ['done', 'running']) {
    const state = fixture(); state.phases[0].tasks[2].status = status;
    assert.equal(validate(state).valid, false);
    const later = fixture(); later.phases[1].tasks[0].dependsOn = []; later.phases[1].tasks[0].status = status;
    assert.equal(validate(later).valid, false);
  }
});
test('CLI returns JSON, distinguishes invalid from incomplete, and never modifies state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-validator-'));
  try {
    const file = join(dir, 'workflow.json');
    const source = JSON.stringify(fixture());
    writeFileSync(file, source);
    const script = fileURLToPath(new URL('./validate.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    let result = run();
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).runnable, ['inventory', 'access']);
    assert.equal(readFileSync(file, 'utf8'), source);
    writeFileSync(file, '{broken');
    result = run();
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).valid, false);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
