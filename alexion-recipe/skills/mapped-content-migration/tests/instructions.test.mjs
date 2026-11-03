import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const files = ['SKILL.md', 'references/execution.md', 'references/recovery.md', 'scripts/README.md', 'references/reference-resolution.md', 'references/target-verification.md', 'references/workflow-integration.md'];
const read = file => readFile(new URL(file, root), 'utf8');

test('agents and platform entry route content migration by explicit mode before native instructions', async () => {
  for (const file of ['../../agents/sitecore-developer.md', '../../agents/tester.md', '../sitecore/SKILL.md', '../cms-migration/references/profiles/sitecore/pipeline/content-migration.md']) {
    const content = await read(file);
    for (const token of ['contentMigrationMode', 'mapped-content', 'native-serialization', 'blocked']) assert.ok(content.includes(token), `${file}: ${token}`);
    assert.match(content, /precedence|only.*native-serialization/i);
  }
  const tester = await read('../../agents/tester.md');
  assert.match(tester, /mapped-content independent content audit/i);
  assert.match(tester, /every agreed output/i);
  assert.match(tester, /workflow integration requires explicit workflow-plan approval/i);
});

test('the skill is discoverable and routes to operational references', async () => {
  const skill = await read('SKILL.md');
  assert.match(skill, /^---\r?\nname: mapped-content-migration\r?\ndescription: Use when /);
  for (const file of files.slice(1)) assert.ok(skill.includes(file), file);
  assert.match(skill, /input validation/i);
  assert.match(skill, /explicit.*assign|assign.*explicit/i);
});

test('skill files do not depend on internal delivery tickets or development milestones', async () => {
  const inspect = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await inspect(file); continue; }
      if (!/\.(md|mjs|ts|json)$/.test(entry.name)) continue;
      const content = await readFile(file, 'utf8');
      assert.doesNotMatch(content, /\b(?:story|stage)\s*(?:#\s*)?\d+\b/i, file.href);
      if (entry.name.endsWith('.md')) assert.doesNotMatch(content, /\b(?:TODO|TBD|FIXME)\b/i, file.href);
      assert.doesNotMatch(content, /C:[\\/]Users[\\/]|D:[\\/]Repos[\\/]/i, file.href);
    }
  };
  await inspect(root);
});

test('all local Markdown links in the new operational documentation resolve', async () => {
  for (const file of [...files, 'references/input-contracts.md', 'references/source-snapshot.md', 'references/transformation.md', 'references/dry-run.md', 'references/target-execution.md', 'references/ownership.md', 'references/content-transfer-method.md', 'contracts/README.md', 'tests/README.md']) {
    const content = await read(file);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1].split('#')[0];
      if (!href || /^[a-z]+:/i.test(href)) continue;
      await access(new URL(href, new URL(file, root)));
    }
  }
});

test('only implemented scripts are offered as executable commands', async () => {
  const scripts = await read('scripts/README.md');
  const inventory = scripts.split('\n').filter(line => /^\| `[^`]+\.(?:mjs|ps1)` \| Available/.test(line));
  assert.equal(inventory.length, 14);
  for (const row of inventory) {
    const script = row.match(/`([^`]+)`/)[1];
    await access(new URL('scripts/' + script, root));
  }
  for (const file of [...files, 'references/source-snapshot.md', 'references/transformation.md', 'references/dry-run.md', 'references/target-execution.md']) {
    const content = await read(file);
    for (const block of content.matchAll(/```(?:sh|bash|powershell)?\r?\n([\s\S]*?)```/g)) {
      for (const command of block[1].split('\n').filter(line => line.startsWith('node '))) {
        const script = command.split(/\s+/)[1];
        assert.ok(['validate-inputs.mjs', 'prepare-source-snapshot.mjs', 'validate-snapshot.mjs', 'transform-content.mjs', 'plan-content.mjs', 'plan-references.mjs', 'prepare-execution.mjs', 'record-execution.mjs', 'verify-target.mjs', 'prepare-content-workflow.mjs', 'validate-mapped-outcome.mjs'].includes(script), 'Unsupported executable command: ' + command);
      }
    }
  }
});

test('target execution instructions require exact review, capability proof and durable job recovery', async () => {
  const text = await read('references/target-execution.md');
  for (const token of ['execution-review.json', 'target-request.json', 'checkpointSha256', 'action": "initialize', 'action": "submitted', 'action: unknown', 'action": "terminal', 'exclusive write window', 'restore capability', 'unknown request blocks', 'per-operation read-back', 'independent final parity', 'executionAvailable: false']) assert.ok(text.includes(token), token);
  assert.match(text, /no mutation envelope or operation reservation/i);
  assert.match(text, /kind: mutation/);
  assert.match(text, /choice: approve/);
  assert.match(text, /Do not resubmit, clear locks, delete checkpoints/i);
  assert.match(text, /never run.*locally/i);
  assert.match(text, /run one explicitly approved small operation before wider execution/i);
});

test('dry-run instructions require explicit evidence, reused-parent guards and current approval', async () => {
  const text = await read('references/dry-run.md');
  for (const term of ['versionsComplete', 'present: false', 'target-read-requirements.json', 'reused planned parents', 'remote backups', 'Exit 2', 'targetStateId']) assert.ok(text.includes(term), term);
  assert.match(text, /no target exporter/i); assert.match(text, /never enter initial scalar batch fields/i);
  assert.match(text, /not mutation approval/i);
});

test('transformation guidance distinguishes local plans, deferred references and unavailable target operations', async () => {
  const text = await read('references/transformation.md');
  for (const term of ['proposed-identity-map.json', 'transform-report.json', 'snapshot-validation', 'branch-unsupported', '16 MiB', 'Raw legacy', 'source references', 'Exit 2']) assert.ok(text.includes(term), term);
  assert.match(text, /does not contact Sitecore/i);
  assert.match(text, /never a verified execution checkpoint/i);
  assert.match(text, /Raw source|raw source/);
  const inputs = await read('references/input-contracts.md');
  assert.match(inputs, /transformer blocks it with `branch-unsupported`/);
  assert.match(inputs, /no package installation or Kajoo code checkout is required/);
  assert.doesNotMatch(inputs, /run `npm install|execution must inspect\/reuse branch-generated children/i);
  const execution = await read('references/execution.md');
  assert.doesNotMatch(execution, /Validate that branch-generated children will be reused|Track planned creations and branch-generated descendants/);

});

test('pre-capture entry does not require a fabricated snapshot', async () => {
  const execution = await read('references/execution.md');
  assert.match(execution, /Before a source snapshot exists/i);
  assert.match(execution, /Do not fabricate.*snapshot/i);
  assert.match(execution, /validateSchema/);
  assert.match(execution, /does not authorize.*capture|capture.*approval/i);
});

test('validation and current script availability cannot authorize writes', async () => {
  const skill = await read('SKILL.md');
  assert.match(skill, /valid: true/);
  assert.match(skill, /blocked/);
  const execution = await read('references/execution.md');
  assert.match(execution, /plan hash/i);
  assert.match(execution, /target.*identit/i);
  assert.match(execution, /current.*approval|approval.*current/i);
  assert.match(execution, /missing.*script|script.*missing/i);
});

test('capture, transform, planning, execution, resolution and read-back have gates', async () => {
  const execution = await read('references/execution.md');
  for (const heading of ['Entry', 'Capture', 'Transform', 'Dry-run', 'Execute', 'Resolve', 'Verify', 'Handoff'])
    assert.match(execution, new RegExp('^## .*' + heading, 'mi'));
  assert.match(execution, /one.*snapshot|snapshot.*once/i);
  assert.match(execution, /global/i);
  assert.match(execution, /base template/i);
  assert.match(execution, /parameter/i);
  assert.match(execution, /circular/i);
  assert.match(execution, /missing reference|unresolved reference/i);
  assert.match(execution, /success.*failed.*skipped/i);
});

test('resume gates distinguish lost jobs, drift and retries', async () => {
  const recovery = await read('references/recovery.md');
  assert.match(recovery, /unknown|lost/i);
  assert.match(recovery, /same job|same run/i);
  assert.match(recovery, /Do not resubmit/i);
  assert.match(recovery, /mapping revision/i);
  assert.match(recovery, /external.*edit|edit.*external/i);
  assert.match(recovery, /before.*after/i);
});

test('remote backups are distinct from Git checkpoints and rollback needs review', async () => {
  const recovery = await read('references/recovery.md');
  assert.match(recovery, /Git.*cannot restore.*Sitecore/i);
  assert.match(recovery, /approval/i);
  assert.match(recovery, /current.*backup|backup.*current/i);
  assert.match(recovery, /created.*item/i);
  assert.match(recovery, /partial.*restore|restore.*partial/i);
});

test('handoff keeps the existing seven-field task result and workflow ownership', async () => {
  const execution = await read('references/execution.md');
  for (const field of ['taskId', 'outcome', 'summary', 'evidence', 'changedFiles', 'checkpoint', 'unresolved']) assert.ok(execution.includes(field), field);
  assert.match(execution, /remote.*changedFiles|changedFiles.*remote/i);
  assert.match(execution, /coordinator.*workflow|workflow.*coordinator/i);
  assert.match(execution, /not.*proof.*success|not.*prove.*success/i);
  assert.match(execution, /task-results\.md/);
});


test('reference planning is separate and uses the same approval-bound guarded writer', async () => {
  const text = await read('references/reference-resolution.md');
  for (const token of ['plan-references.mjs', 'contentPlanInput', 'checkpoint', 'targetState', 'existingTargetState', 'existingReferenceTargets', 'reference-report.json', 'operationKind: references', 'prepare-execution.mjs', 'initial-field evidence', 'all mutation batches', 'list order and duplicates', 'rootPath: /sitecore']) assert.ok(text.includes(token), token);
  assert.match(text, /immutable checkpoint/i);
  assert.match(text, /creates no items or versions/i);
  assert.match(text, /exact review\/mutation approval/i);
  assert.match(text, /independent content audit is available/is);
  assert.match(text, /workflow integration requires explicit workflow-plan approval/i);
  assert.match(text, /no second executor/i);
  const inventory = await read('scripts/README.md');
  assert.match(inventory, /`plan-references\.mjs` \| Available/);
  assert.doesNotMatch(inventory, /Reference rewriting[^.]*unavailable/i);
  const skill = await read('SKILL.md');
  assert.ok(skill.includes('references/reference-resolution.md'));
  assert.doesNotMatch(skill, /Reference rewriting[^.]*unavailable/i);
});


test('independent target content audit binds exact scoped read approval and actual collector provenance', async () => {
  const text = await read('references/target-verification.md');
  for (const token of ['verify-target.mjs', 'capture-target.ps1', 'contentPlanInput', 'checkpoint', 'capabilities', 'structuralLanguage', 'readbackId', 'readbacks', 'maxQueriesPerRequest', 'verification-report.json', 'expected-content.json', 'target-read-requirements.json', 'readback-requests.json', 'speRead', 'fileDownload', 'stableReadWindow: true', 'verifiedAt', 'expiresAt', 'maxCaptureBytes', 'maxRequestBytes', 'kajoo-export']) assert.ok(text.includes(token), token);
  assert.match(text, /whole agreed content output scope, not a sample/i);
  assert.match(text, /original source and mapping artifacts/i);
  assert.match(text, /exact read request scope and request hash/i);
  assert.match(text, /only the selected TARGET connector/);
  assert.match(text, /Never run.*locally/i);
  assert.match(text, /write access, backups, restore capability.*not prerequisites/i);
  assert.match(text, /observed parent IDs/i);
  assert.match(text, /no truncation/i);
  assert.match(text, /Pending, partial, latest-failed or unmapped captured-source/i);
  assert.match(text, /Explicit scope exclusions.*separately/i);
  assert.match(text, /cannot.*relabeled as collector output/i);
  assert.match(text, /Exit 0.*exit 2.*exit 1/is);
  assert.match(text, /never updates a journal, checkpoint, shared workflow/i);
  assert.match(text, /Verify live Sitecore\/SPE compatibility through the selected connector/i);
  assert.match(text, /media binaries, presentation\/visual verification and unrelated tree enumeration are excluded/i);
});

test('agent and profile audit guards preserve independent read-only ownership and explicit workflow approval', async () => {
  for (const file of ['../../agents/tester.md', '../../agents/sitecore-developer.md', '../cms-migration/references/profiles/sitecore/pipeline/content-migration.md', 'references/content-transfer-method.md']) {
    const text = await read(file);
    assert.ok(text.includes('target-verification.md'), file);
    assert.match(text, /explicitly assigned/i, file);
    assert.match(text, /workflow integration requires explicit workflow-plan approval/i, file);
    assert.doesNotMatch(text, /mapped-content terminal audit of target writes is unavailable/i, file);
  }
  const tester = await read('../../agents/tester.md');
  assert.match(tester, /actual downloaded readback file descriptors/i);
  assert.match(tester, /Do not create journal\/workflow changes, mutation batches, remediation or publishing/i);
  const skill = await read('SKILL.md');
  assert.ok(skill.includes('references/target-verification.md'));
});


test('target audit requires actual current checkpoint, field types, bounded capture and fresh requests after journal changes', async () => {
  const text = await read('references/target-verification.md');
  for (const token of ['head.json', 'actual journal directory', 'both start and end', 'fieldType', '64 MiB', '16 MiB', 'verification-size', 'without recapture']) assert.ok(text.includes(token), token);
  assert.match(text, /journal transition invalidates prior captures/i);
  assert.match(text, /regenerate read requests/i);
  assert.match(text, /approved reuse and exact unchanged field values and version sets/i);
});

test('workflow integration preserves existing state and retains all coordinator approval gates', async () => {
  const text = await read('references/workflow-integration.md');
  for (const token of ['prepare-content-workflow.mjs', 'workflow-proposal.json', 'inventory.json', 'task-mappings.json', 'integration-report.json', 'mapped-content:<step>', 'workflow-plan', 'validateWorkflowPlan', 'materialize-approved-workflow.mjs', 'Kajoo', 'phase-continuation', 'next-work.mjs', 'content.approve', 'mappedContentInputs', 'packet.mappedContent']) assert.ok(text.includes(token), token);
  assert.match(text, /preserves existing active work and Discovery inventory/i);
  assert.match(text, /never mutates active workflow files, Kajoo tasks, decisions/i);
  assert.match(text, /not CMS items or content counts/i);
  assert.match(text, /Never hand-edit command fields/i);
  assert.match(text, /adds no new code, SXA, resolver or presentation work/i);
  assert.match(text, /native-serialization/);
  assert.match(text, /Confirm live-instance compatibility using the selected connectors/i);
  const asset = JSON.parse(await read('assets/workflow-operations.json'));
  assert.equal(asset.tasks.length, 8);
  for (const task of asset.tasks) assert.ok(text.includes(task.id), task.id);
  const catalog = JSON.parse(await read('../cms-migration/assets/profiles/sitecore/phase-catalog.json'));
  assert.ok(catalog.goldenExamples.find(example => example.key === 'content-migration'));
  assert.equal(catalog.goldenExamples.find(example => example.key === 'mapped-content-migration').tasks.length, 8);
});

test('workflow outcome evidence replays actual packet outputs before shared result and never fabricates receipts', async () => {
  const text = await read('references/workflow-integration.md');
  for (const token of ['validate-mapped-outcome.mjs', 'mapped-outcome-input.json', 'outputs: [{role,path,sha256}]', 'valid: true', 'seven-field task result', 'evidence.kind: mapped-content-operation', 'executionReceipt']) assert.ok(text.includes(token), token);
  assert.match(text, /dynamically reruns the domain validator/i);
  assert.match(text, /Newly mutated outcomes require actual bound receipts and current journal evidence/i);
  assert.match(text, /Never fabricate receipts/i);
  for (const file of ['../../agents/orchestrator.md', '../../agents/sitecore-developer.md', '../../agents/tester.md', '../cms-migration/references/profiles/sitecore/pipeline/content-migration.md']) {
    const entry = await read(file);
    assert.ok(entry.includes('workflow-integration.md'), file);
    assert.ok(entry.includes('mapped-content-operation'), file);
    assert.ok(entry.includes('content.approve'), file);
  }
});


test('mapped packet frontier reruns prior task attempts with each task own inputs and workspace boundary', async () => {
  const text = await read('references/workflow-integration.md');
  for (const token of ['priorTaskAttempts: [{path,sha256}]', 'prepareTaskPacket(input, {base})', 'SAME workspace boundary', 'workflowPath', 'requiredEvidenceKinds', 'entity-result', 'entityAttestations']) assert.ok(text.includes(token), token);
  assert.match(text, /each prior task's own immutable inputs, the current workflow and actual decisions/i);
  assert.match(text, /next task may select different inputs/i);
  assert.match(text, /immutable postflight request file's hash persists/i);
  assert.match(text, /mutable workflow and decisions are reread at runtime/i);
  assert.match(text, /never fabricate validation objects/i);
});

test('empty execution completes only from canonical zero batches and unchanged checkpoint without invented write artifacts', async () => {
  const text = await read('references/workflow-integration.md');
  for (const token of ['batches: []', 'unchanged checkpoint and canonical zero batches', 'may omit `batchId`', 'Do NOT call `prepareExecution`', 'Nonempty plans still require actual execution reviews', 'CURRENT actual journal head']) assert.ok(text.includes(token), token);
  assert.match(text, /verified ancestor after later reference writes/i);
  assert.match(text, /fresh supported no-op review/i);
  const asset = JSON.parse(await read('assets/workflow-operations.json'));
  for (const operation of ['execute', 'reference-execute']) {
    const task = asset.tasks.find(task => task.operation === operation);
    assert.deepEqual(task.outputRoles, ['checkpoint']);
    assert.deepEqual(task.optionalOutputRoles, ['executionReview', 'executionReceipt']);
  }
});


test('content transfer selection separates workflow scope, compatibility and human approval',async()=>{
 const mode=await read('references/content-transfer-method.md');
 for(const token of ['full-migration','discovery-only','Direct-transfer compatibility check','inherited fields','sharing modes','one-to-many','kind: scope','compatibility report','inputs','kajoo/ask-user-input'])assert.ok(mode.includes(token),token);
 assert.match(mode,/Missing or failed checks block native transfer selection/);
 const owner=await read('../../agents/orchestrator.md');
 assert.match(owner,/Delegate direct-transfer compatibility checks to `sitecore-developer`/);
 assert.match(owner,/ask whether mapping is required only when no current answer exists/);
 assert.match(owner,/Delegate the local `verify-target.mjs` replay/);
 assert.match(owner,/do not run Bash yourself or give the tester approval authority/);
 const integration=await read('references/workflow-integration.md');
 assert.match(integration,/authority for IDs, owners, roles, entry points and procedures/);
 assert.match(integration,/tester cannot supply a user response or approve the migration/);
});
