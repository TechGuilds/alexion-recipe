import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/validate-context.mjs', import.meta.url));
const template = () => JSON.parse(readFileSync(new URL('../assets/profiles/sitecore/context.json', import.meta.url)));
const repos = { source: '/workspace/repos/site-source', target: '/workspace/repos/site-target', app: '/workspace/repos/site-target/site-app' };
const withRepos = context => ({ ...context, roots: { ...context.roots, migration: '/workspace/migration-state/site-a', ...repos } });
const connector = (name, type = 'mcp-kajoo-sitecore-xp') => ({ id: 'id-' + name, name, type });
const full = () => withRepos({
  ...template(), scopeId: 'site:main:en', migration: { type: 'xpheadless2sai', mode: 'full-migration' },
  connectors: { sourceContent: connector('source-sitecore'), targetContent: connector('target-sitecore', 'mcp-kajoo-sitecore-xmc'), targetCode: connector('target-git', 'target-git') },
  source: { site: { name: 'main', path: '/sitecore/content/Tenant/main', languages: ['en', 'fr'], primaryLanguage: 'en' }, code: { mode: 'git-url', gitUrl: 'https://github.com/acme/site.git', branch: 'main' } },
  target: { code: { repoName: 'target-site', branch: 'main' } },
});

function run(t, context, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'context.json'), JSON.stringify(context));
  const r = spawnSync(process.execPath, [script, '--input', join(dir, 'context.json'), ...flags], { cwd: dir, encoding: 'utf8' });
  let output; try { output = JSON.parse(r.stdout); } catch { output = { errors: [r.stderr] }; }
  return { status: r.status, output };
}

test('the template is structurally valid but names what Setup still has to fill', t => {
  const r = run(t, template());
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.equal(r.output.valid, true);
  assert.equal(r.output.complete, false);
  assert.deepEqual(r.output.missingFields, [
  'migration.mode', 'migration.type', 'roots.migration', 'scopeId',
  ]);
});

test('a filled full-migration context is complete', t => {
  const r = run(t, full());
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.equal(r.output.complete, true);
  assert.deepEqual(r.output.missingFields, []);
});

test('full migration cannot complete without an explicit target repository branch', t => {
  const context = full();
  delete context.target.code.branch;
  assert.deepEqual(run(t, context).output.missingFields, ['target.code.branch']);
});

test('an artifact pointer is accepted without turning context into artifact content', t => {
  const context = full();
  context.artifactId = 'a'.repeat(24);
  const r = run(t, context);
  assert.equal(r.output.complete, true, JSON.stringify(r.output));
});

test('completeness follows the mode, sides, surfaces and code source', t => {
  const discovery = (sides, surfaces, extra = {}) => withRepos({ ...template(), scopeId: 's', migration: { type: 'xpmvc2sai', mode: 'discovery-only', discovery: { sides, surfaces } }, ...extra });
  assert.deepEqual(run(t, discovery(['target'], ['content'])).output.missingFields, ['connectors.targetContent']);
  assert.deepEqual(run(t, withRepos({ ...template(), scopeId: 's', migration: { type: 'x', mode: 'discovery-only' } })).output.missingFields, ['migration.discovery']);
  const codeOnly = run(t, discovery(['source'], ['code'])).output.missingFields;
  assert.deepEqual(codeOnly, ['source.code.mode']);
  const upload = discovery(['source'], ['code'], { source: { code: { mode: 'upload' } } });
  assert.deepEqual(run(t, upload).output.missingFields, ['source.code.upload']);
  upload.source.code.upload = { archivePath: '/workspace/uploads/site.zip', sha256: 'a'.repeat(64) };
  assert.equal(run(t, upload).output.complete, true);
  const repo = discovery(['source'], ['code'], { source: { code: { mode: 'connector' } } });
  assert.deepEqual(run(t, repo).output.missingFields, ['connectors.sourceCode', 'source.code.branch', 'source.code.repoName']);
  repo.source.code.branch = 'main';
  repo.source.code.repoName = 'source-site';
  assert.deepEqual(run(t, repo).output.missingFields, ['connectors.sourceCode']);
  const noRoot = discovery(['source'], ['code'], { source: { code: { mode: 'git-url', gitUrl: 'https://github.com/acme/s.git' } } });
  delete noRoot.roots.source;
  assert.deepEqual(run(t, noRoot).output.missingFields, ['roots.source']);
});

test('credentials are refused anywhere in the file, by field name or by value', t => {
  const cases = [
    ['a credential-like key (not in the schema)', c => { c.source.site.apiKey = 'x'; }, /unknown field apiKey/],
    ['a token key (not in the schema)', c => { c.connectors.sourceContent.accessToken = 'x'; }, /unknown field accessToken/],
    ['URL userinfo', c => { c.source.code.gitUrl = 'https://user:pass@github.com/acme/s.git'; }, /source\.code\.gitUrl looks like a URL with embedded credentials/],
    ['a token in the user part', c => { c.source.code.gitUrl = 'https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/acme/s.git'; }, /embedded credentials/],
    ['a credential query parameter', c => { c.source.site.path = 'https://x.example/layout?sc_apikey=abc'; }, /credential parameter/],
    ['a JWT', c => { c.source.code.revision = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'; }, /a JWT/],
    ['a GitHub token', c => { c.source.code.branch = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; }, /a GitHub token/],
    ['a private key', c => { c.target.appName = '-----BEGIN RSA PRIVATE KEY-----'; }, /a private key/],
    ['a bearer header', c => { c.source.site.name = 'Bearer abcdefghijklmnopqrstuvwxyz'; }, /authorization header/],
    ['credential-like connector metadata', c => { c.connectors.sourceContent.apiKey = 'x'; }, /unknown field apiKey/],
  ];
  for (const [label, change, pattern] of cases) {
    const context = full(); change(context);
    const r = run(t, context);
    assert.equal(r.status, 1, label);
    assert.match(r.output.errors.join('\n'), pattern, label);
  }
});

test('roots must be clean, must not contain each other and must keep migration files out of the repositories', t => {
  const bad = change => { const c = full(); change(c.roots); return run(t, c); };
  assert.equal(bad(r => { r.source = 'workspace/source'; }).status, 1, 'relative paths fail the schema');
  assert.match(bad(r => { r.app = '/workspace/repos/other-app'; }).output.errors.join(), /roots.app must be inside roots.target/);
  assert.equal(bad(r => { r.app = r.target; }).status, 0, 'a single-app repository uses the repository root');
  assert.match(bad(r => { r.target = '/workspace/../etc'; }).output.errors.join(), /clean absolute POSIX path/);
  assert.match(bad(r => { r.target = '/workspace/repos/site-source/app'; }).output.errors.join(), /must not contain each other/);
  assert.match(bad(r => { r.source = '/workspace/repos/site-source/'; r.target = '/workspace/repos'; }).output.errors.join(), /must not contain each other/);
  assert.match(bad(r => { r.migration = '/workspace/repos/site-target/.kajoo'; }).output.errors.join(), /migration must not be inside roots\.target/);
  assert.equal(bad(r => { r.source = '/workspace/repos/site-source-copy'; }).status, 0, 'a sibling that merely shares a prefix is fine');
});

test('structure is enforced and incomplete current context remains resumable', t => {
  for (const change of [c => { c.version = 2; }, c => { c.migration.mode = 'sideways'; }, c => { c.extra = true; }, c => { c.source.code.mode = 'ftp'; },
    c => { c.connectors.sourceContent = { id: 'x' }; }, c => { c.source.code.upload = { archivePath: 'relative.zip' }; }]) {
    const context = full(); change(context);
    assert.equal(run(t, context).status, 1, JSON.stringify(change.toString()));
  }
  const gitUrl = full(); delete gitUrl.source.code.gitUrl;
  assert.match(run(t, gitUrl).output.errors.join(), /requires source\.code\.gitUrl/);
  const incomplete = { version: 1, scopeId: 'site:en' };
  const r = run(t, incomplete);
  assert.equal(r.status, 0, JSON.stringify(r.output));
  assert.equal(r.output.complete, false);
  assert.equal(r.output.warnings, 0);
});
