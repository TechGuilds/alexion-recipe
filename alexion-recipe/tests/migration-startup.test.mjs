import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const guide = readFileSync(new URL('../skills/migration-artifact/references/prepare-artifact.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const section = guide.split('### Inspect state before initialization')[1]?.split('\n\nName:')[0];
const scripts = [...(section ?? '').matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1]);
assert.equal(scripts.length, 2, 'startup documents separate inspection and initialization examples');
const [inspect, initialize] = scripts;
const candidates=[process.env.BASH_EXE,...(process.platform==='win32'?[join(process.env.ProgramFiles??'C:/Program Files','Git/bin/bash.exe')]:[]),'bash'].filter(Boolean);
const bash=candidates.find(exe=>spawnSync(exe,['--version'],{encoding:'utf8'}).status===0);
assert.ok(bash,'A working Bash runtime is required; set BASH_EXE when it is not on PATH');
const run = (script, state, cwd) => spawnSync(bash, ['-c', script], { cwd, env: { ...process.env, MIGRATION_STATE_FILE_DIR: state?relative(cwd,state).replace(/\\/g,'/'):'' }, encoding: 'utf8' });

test('inspection handles a missing state directory without creating it or returning an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-startup-'));
  const state = join(root, 'project state', 'migration');
  try {
    const fresh = run(inspect, state, root);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stderr, '');
    assert.match(fresh.stdout, /Migration state has not been initialized yet/);
    assert.equal(existsSync(state), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('initialization creates missing directories and inspection preserves existing workflow files', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-startup-'));
  const state = join(root, 'project state', 'migration');
  try {
    const created = run(initialize, state, root);
    assert.equal(created.status, 0, created.stderr);
    writeFileSync(join(state, 'workflow.json'), '{"preserve":true}');
    const resumed = run(inspect, state, root);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /workflow.json/);
    assert.equal(run(initialize, state, root).status, 0);
    assert.equal(readFileSync(join(state, 'workflow.json'), 'utf8'), '{"preserve":true}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inspection rejects missing configuration and a state path occupied by a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-startup-'));
  try {
    writeFileSync(join(root, 'blocked'), 'not a directory');
    for (const state of ['', join(root, 'blocked')]) {
      const result = run(inspect, state, root);
      assert.notEqual(result.status, 0);
      assert.notEqual(result.stderr, '');
      assert.doesNotMatch(result.stdout, /has not been initialized/);
    }
    assert.notEqual(run(initialize, join(root, 'blocked', 'state'), root).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
