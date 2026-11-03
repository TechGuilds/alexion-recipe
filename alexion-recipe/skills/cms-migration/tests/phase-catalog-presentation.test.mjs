import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertExclusiveContentTransfer } from '../scripts/content-transfer-phases.mjs';

const catalog = JSON.parse(readFileSync(new URL('../assets/profiles/sitecore/phase-catalog.json', import.meta.url), 'utf8'));
const entry = key => catalog.goldenExamples.find(phase => phase.key === key);

test('Verification describes target-site evidence instead of repeating Presentation Composition', () => {
  const presentation = entry('presentation-composition');
  const verification = entry('verification');
  for (const field of ['evidenceSignals', 'taskPatterns', 'acceptanceEvidence'])
    assert.notDeepEqual(verification[field], presentation[field], field);
  assert.match(verification.acceptanceEvidence.join(' '), /screenshots/i);
  assert.match(verification.taskPatterns.join(' '), /verification\.\*/);
});

test('a workflow cannot hold both native and mapped content-transfer phases', () => {
  const phase = (id, title) => ({ id, title, tasks: [{ id: id + '.task', status: 'pending' }] });
  assert.equal(assertExclusiveContentTransfer({ phases: [phase('content-migration', 'Content Migration')] }).length, 1);
  assert.equal(assertExclusiveContentTransfer({ phases: [phase('mapped-content-migration', 'Mapped Content Migration')] }).length, 1);
  assert.throws(
    () => assertExclusiveContentTransfer({ phases: [phase('content-migration', 'Content Migration'), phase('mapped-content-migration', 'Mapped Content Migration')] }),
    /Only one content-transfer phase/,
  );
});
