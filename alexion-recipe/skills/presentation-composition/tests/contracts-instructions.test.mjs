import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import Ajv from '../../cms-migration/scripts/lib/vendor/ajv.mjs';
import { definitions, websiteDefinitions, requireSchema } from '../scripts/lib/common.mjs';

test('all public presentation contracts compile strictly without runtime package installation', () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  ajv.addSchema(definitions);
  ajv.addSchema(websiteDefinitions);
  for (const name of Object.keys(definitions.$defs))
    assert.equal(typeof ajv.compile({ $ref: definitions.$id + '#/$defs/' + name }), 'function', name);
  for (const name of Object.keys(websiteDefinitions.$defs))
    assert.equal(typeof ajv.compile({ $ref: websiteDefinitions.$id + '#/$defs/' + name }), 'function', name);
  assert.throws(() =>
    requireSchema('previewInput', { version: 1, scopeId: 'demo', minimumPages: 0, unknown: true }),
  );
});
test('client references resolve and describe approved application and preserve workflow ownership', async () => {
  const root = new URL('../', import.meta.url);
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'tests') continue;
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const text = await readFile(file, 'utf8');
      assert.doesNotMatch(text, /\b(?:story|stage)\s*#?\s*\d+\b|\bTODO\b|\bTBD\b/i);
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const path = match[1].split('#')[0];
        if (path && !/^[a-z]+:/i.test(path)) await access(new URL(path, file));
      }
    }
  };
  await walk(root);
  const skill = await readFile(new URL('SKILL.md', root), 'utf8');
  assert.match(skill, /Preview operations do not write Sitecore presentation/);
  assert.match(skill, /A collector reporting `sxaDesignExpansion: false` is incomplete evidence/);
  assert.match(skill, /actual user decisions/);
  assert.match(skill, /applyAuthorized: false/);
  const preview = await readFile(new URL('references/preview.md', root), 'utf8');
  assert.match(preview, /not be relabelled to pass the legacy captured-layout installer/);
  assert.match(preview, /does not claim a mathematically smallest set/);
  assert.match(preview, /actual PNG\/JPEG/);
});

test('presentation scripts take shared utilities from cms-migration, not from mapped-content internals', async () => {
  const skill = new URL('../', import.meta.url);
  const sources = [];
  for (const directory of ['scripts/', 'scripts/lib/']) {
    for (const entry of await readdir(new URL(directory, skill), { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith('.mjs')) sources.push(new URL(directory + entry.name, skill));
  }
  for (const file of sources) {
    const imports = [...(await readFile(file, 'utf8')).matchAll(/from '([^']*mapped-content-migration[^']*)'/g)].map((m) => m[1]);
    for (const specifier of imports)
      assert.match(specifier, /mapped-content-migration\/scripts\/lib\/schema\.mjs$/, file.pathname + ' ' + specifier);
  }
  await access(new URL('../cms-migration/scripts/lib/vendor/ajv.mjs', skill));
  await access(new URL('../cms-migration/scripts/lib/files.mjs', skill));
});
