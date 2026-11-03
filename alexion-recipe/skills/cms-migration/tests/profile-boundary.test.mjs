import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

function sharedReferenceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return entry.name === 'profiles' ? [] : sharedReferenceFiles(join(directory, entry.name));
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [join(directory, entry.name)] : [];
  });
}

test('shared CMS guidance does not encode a vendor, product flavor, or migration-pair procedure', () => {
  const referenceRoot = fileURLToPath(new URL('../references', import.meta.url));
  const docs = [fileURLToPath(new URL('../SKILL.md', import.meta.url)), ...sharedReferenceFiles(referenceRoot)];
  for (const path of docs) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /Sitecore|\bSXA\b|XM Cloud|\bXMC\b|\bJSS\b|XP Headless|XP MVC/i, path);
    assert.doesNotMatch(path.slice(referenceRoot.length), /(?:^|[\\/])(?:sxa|sitecore)[^\\/]*\.md$/i, path);
  }
});

test('shared workflow-template loader requires the active profile instead of defaulting to Sitecore', () => {
  const contracts = read('../scripts/contracts.mjs');
  assert.match(contracts, /templateForProfile\(profileId\)/);
  assert.doesNotMatch(contracts, /profiles\/sitecore\/workflow\.json/);
});
