import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
test('assigned and suggested workers are dispatched without capability rechecks', () => {
  for (const path of ['agents/orchestrator.md', 'skills/migration-artifact/SKILL.md', 'skills/migration-artifact/references/prepare-artifact.md']) {
    const content = readFileSync(resolve(root, path), 'utf8');
    assert.match(content, /assigns or suggests an agent \(including tester\)/);
    assert.match(content, /Do not call list-agents\/get-agent or inspect attached skills, tools or connectors/);
  }
});
const read = (path) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
const inlineList = (content, field) => [...content.match(new RegExp(`^${field}: (.+)$`, 'm'))[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  const child = resolve(path, entry.name);
  return entry.isDirectory() ? walk(child) : [child];
});

test('both skills have metadata and valid local Markdown links', () => {
  for (const name of ['migration-artifact', 'managing-kajoo-tasks']) {
    assert.ok(read(`skills/${name}/SKILL.md`).startsWith(`---\nname: ${name}\n`));
    for (const file of walk(resolve(root, 'skills', name))) {
      const content = readFileSync(file, 'utf8');
      for (const [, link] of content.matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(https?:|#)/.test(link)) continue;
        assert.ok(existsSync(resolve(dirname(file), link.split('#')[0])), `${file}: ${link}`);
      }
      assert.doesNotMatch(content, /(?:create-artifact|update-artifact|resolve-artifact|setup-phase-epic)\.md/);
    }
  }
  for (const path of ['templates/setup-cms-task.md', 'templates/audit-setup-task.md', 'references/complete-setup.md']) {
    assert.ok(existsSync(resolve(root, 'skills/migration-artifact', path)), path);
  }
});

test('all executing agents load lifecycle guidance and can read/update their task', () => {
  for (const name of ['orchestrator', 'frontend-developer', 'sitecore-developer', 'tester']) {
    const content = read(`agents/${name}.md`);
    const tools = inlineList(content, 'tools');
    const skills = inlineList(content, 'skills');
    assert.ok(skills.includes('managing-kajoo-tasks'), name);
    assert.ok(skills.includes('migration-artifact'), name);
    assert.ok(tools.includes('source-git/list-repositories'), name);
    assert.ok(tools.includes('target-git/list-repositories'), name);
    assert.ok(tools.includes('kajoo/get-task'), name);
    assert.ok(tools.includes('kajoo/update-task'), name);
    for (const skill of skills) assert.ok(existsSync(resolve(root, `skills/${skill}/SKILL.md`)), skill);
  }
  assert.ok(inlineList(read('agents/orchestrator.md'), 'skills').includes('migration-artifact'));
  assert.match(read('agents/tester.md'), /assigned Kajoo task/);
});

test('setup and task lifecycle requirements survive recipe sync', () => {
  const task = read('skills/managing-kajoo-tasks/SKILL.md');
  assert.match(task, /Before direct task work, update its status to `in-progress`/);
  assert.match(task, /Whenever work finishes or stops, update the task/);
  assert.match(task, /kajoo__/);
  const setup = read('skills/migration-artifact/templates/setup-source-platform-task.md');
  for (const text of ['migration-artifact', 'platform connection', 'Git connection', 'sandbox', 'CMS-specific configuration']) {
    assert.ok(setup.includes(text), text);
  }
  assert.match(setup, /<kajoo-artifact .*\/>/);
});
