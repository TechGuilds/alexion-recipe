import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const library = fileURLToPath(new URL('../scripts/lib/presentation-target-common.ps1', import.meta.url));
const pwsh = process.env.PWSH_EXE ?? 'pwsh';
const available = spawnSync(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

function run(expression) {
  const script = `. '${library.replaceAll("'", "''")}'; ${expression}`;
  return spawnSync(pwsh, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 });
}

test('Get-PresTime accepts strings, DateTime and DateTimeOffset values and rejects invalid text', { skip: !available && 'PowerShell is not available' }, () => {
  const expression = [
    "(Get-PresTime '2026-01-02T03:04:05Z').ToString('o')",
    "(Get-PresTime ([DateTime]::SpecifyKind([DateTime]'2026-01-02T03:04:05',[DateTimeKind]::Utc))).ToString('o')",
    "(Get-PresTime ([DateTimeOffset]::Parse('2026-01-02T05:04:05+02:00'))).ToString('o')",
    "try { Get-PresTime 'not a timestamp'; 'accepted' } catch { $_.Exception.Message }",
  ].join('; ');
  const result = run(expression);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.deepEqual(lines, [
    '2026-01-02T03:04:05.0000000+00:00',
    '2026-01-02T03:04:05.0000000+00:00',
    '2026-01-02T03:04:05.0000000+00:00',
    'Invalid presentation timestamp',
  ]);
});
