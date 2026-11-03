import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const recipe = path.resolve(here, '../../..');
const inventory = path.join(here, '../references/discovery/discovery-script-inventory.md');

test('Discovery inventory names every shipped executable path', async () => {
  const text = await readFile(inventory, 'utf8');
  const files = [
    'skills/sitecore/scripts/analysis/xp-discovery-v3.ps1',
    'skills/sitecore/scripts/analysis/hotfix-discover-layouts.ps1',
    'skills/sitecore/scripts/analysis/discovery-evidence-adapter.mjs',
    'skills/sitecore/scripts/capture/fetch-layouts.mjs',
    'skills/sitecore/scripts/capture/capture-mock-layouts.ps1',
    'skills/sitecore/scripts/capture/capture-mock-dictionary.ps1',
    'skills/sitecore/scripts/capture/export-richtext-structures.ps1',
    'skills/sitecore/scripts/spe/get-rendering-source-keys.ps1',
    'skills/frontend-migration/scripts/analyze-source.mjs',
    'skills/frontend-migration/scripts/analyze-usage.mjs',
    'skills/frontend-migration/scripts/analyze-layout.mjs',
    'skills/frontend-migration/scripts/analyze-styles.mjs',
  ];
  for (const relative of files) {
    await access(path.join(recipe, relative));
    assert.match(text, new RegExp(path.basename(relative).replaceAll('.', '\\.' )), relative);
  }
  for (const source of [
    'sitecore-export-richtext.ts',
    'fetch-and-deploy-headless-mock-layouts.ts',
    'fetch-and-deploy-mvc-mock-layouts.ts',
    'fetch-and-deploy-mvc-mock-dictionary.ts',
    'migration-get-analysis-report.ts',
  ]) {
    assert.match(text, new RegExp(source.replaceAll('.', '\\.' )), source);
  }
});
