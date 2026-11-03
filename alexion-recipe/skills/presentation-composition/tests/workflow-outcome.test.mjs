import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';
import { applicationFixture } from './application-fixture.mjs';
import { validatePresentationOutcome } from '../scripts/validate-presentation-outcome.mjs';
import { installPresentationPreview } from '../scripts/install-presentation-preview.mjs';
import { verifyPreview } from '../scripts/review-presentation-preview.mjs';
import { auditPresentationApplication } from '../scripts/audit-presentation-application.mjs';
import { hash, id } from '../scripts/lib/common.mjs';

const catalog = JSON.parse(
  await readFile(new URL('../assets/workflow-operations.json', import.meta.url), 'utf8'),
);
async function request(f, operation, inputs, outputs, edit = () => {}) {
  const d = catalog.tasks.find((r) => r.operation === operation);
  const packet = {
    kind: 'cms-migration-task-packet',
    version: 1,
    scopeId: 'demo',
    task: { id: d.id, phaseId: d.phaseId, agent: d.agent },
    inputs: inputs.map(({ role, ...ref }) => ref),
    entities: [
      {
        id: `presentation-operation:demo:${operation}`,
        kind: `presentation:${operation}`,
        scope: 'included',
        source: { identity: operation },
      },
    ],
    presentation: {
      version: 1,
      operation,
      procedure: 'presentation-composition/' + d.procedure,
      entryPoints: d.entryPoints,
      inputRoles: inputs,
      requiredOutputRoles: d.outputRoles,
      optionalOutputRoles: d.optionalOutputRoles ?? [],
    },
  };
  edit(packet);
  return { version: 1, packet: await f.put('packet.json', packet), outputs };
}
async function validate(f, req) {
  return validatePresentationOutcome(req, { base: f.base });
}

test('composition outcome replays canonical output and remains status free', async (t) => {
  const f = await fixture(t),
    composed = await f.compose();
  const req = await request(
    f,
    'compose',
    [{ role: 'compositionInput', ...f.inputRef }],
    [{ role: 'compositionPlan', ...composed.plan }],
  );
  const result = await validate(f, req);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.workflowAdvanced, false);
  assert.equal(result.taskId, 'presentation.compose');
  assert.deepEqual(result.inputs, [f.inputRef]);
});

test('rehashed forged composition output and stale packet hashes fail', async (t) => {
  const f = await fixture(t),
    composed = await f.compose();
  const forged = structuredClone(composed.value);
  forged.pages[0].renderings = [];
  const req = await request(
    f,
    'compose',
    [{ role: 'compositionInput', ...f.inputRef }],
    [{ role: 'compositionPlan', ...(await f.put('forged-plan.json', forged)) }],
  );
  const result = await validate(f, req);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(), /canonical operation/);
  await writeFile(join(f.base, req.packet.path), '{}');
  assert.equal((await validate(f, req)).valid, false);
});

test('task, phase, agent, entities, metadata and role tampering are rejected', async (t) => {
  const f = await fixture(t),
    composed = await f.compose();
  for (const edit of [
    (p) => {
      p.task.phaseId = 'verification';
    },
    (p) => {
      p.task.agent = 'orchestrator';
    },
    (p) => {
      p.task.id = 'custom.compose';
    },
    (p) => {
      p.entities[0].scope = 'excluded';
    },
    (p) => {
      p.entities[0].source.identity = 'preview';
    },
    (p) => {
      p.entities.push(p.entities[0]);
    },
    (p) => {
      p.presentation.entryPoints = ['unknown.mjs'];
    },
    (p) => {
      p.presentation.extra = true;
    },
    (p) => {
      p.presentation.inputRoles[0].role = 'previewInput';
    },
    (p) => {
      p.inputs = [];
    },
    (p) => {
      p.inputs.push(p.inputs[0]);
    },
  ]) {
    const req = await request(
      f,
      'compose',
      [{ role: 'compositionInput', ...f.inputRef }],
      [{ role: 'compositionPlan', ...composed.plan }],
      edit,
    );
    assert.equal((await validate(f, req)).valid, false);
  }
});

test('strict outcome descriptors reject unknown roles, duplicates, unsafe paths and extras', async (t) => {
  const f = await fixture(t),
    composed = await f.compose();
  const good = await request(
    f,
    'compose',
    [{ role: 'compositionInput', ...f.inputRef }],
    [{ role: 'compositionPlan', ...composed.plan }],
  );
  for (const edit of [
    (r) => {
      r.outputs[0].role = 'custom';
    },
    (r) => {
      r.outputs.push(r.outputs[0]);
    },
    (r) => {
      r.outputs[0].path = '../outside.json';
    },
    (r) => {
      r.outputs[0].ready = true;
    },
    (r) => {
      r.packet.role = 'packet';
    },
    (r) => {
      r.workflowAdvanced = true;
    },
  ]) {
    const req = structuredClone(good);
    edit(req);
    assert.equal((await validate(f, req)).valid, false);
  }
});

async function installed(t) {
  const f = await fixture(t),
    preview = await f.preview(),
    root = join(f.base, 'app');
  await mkdir(join(root, 'src'), { recursive: true });
  const layout = '<script src="/mock-preview/navigation.js" />',
    loader = 'synthetic loader';
  await writeFile(join(root, 'src/layout.tsx'), layout);
  await writeFile(join(root, 'src/loader.ts'), loader);
  const proof = await f.put('foundation-proof.json', { synthetic: true });
  const foundation = await f.put('foundation.json', {
    version: 1,
    scopeId: 'demo',
    targetRoot: await realpath(root),
    ready: true,
    mockEnabled: true,
    routeContract: 'single-context',
    siteName: 'target-site',
    language: 'en',
    framework: 'content-sdk',
    loader: { path: 'src/loader.ts', sha256: hash(loader) },
    layout: { path: 'src/layout.tsx', sha256: hash(layout) },
    evidence: proof,
  });
  const value = {
    version: 1,
    scopeId: 'demo',
    taskId: 'presentation.preview',
    previewInput: preview.request,
    previewManifest: preview.manifest,
    targetRoot: root,
    foundationEvidence: foundation,
  };
  const first = await f.put('install-first.json', value);
  await installPresentationPreview(join(f.base, first.path), join(f.base, 'install-review'));
  const review = {
    path: 'install-review/preview-install-review.json',
    sha256: hash(await readFile(join(f.base, 'install-review/preview-install-review.json'))),
  };
  const approval = await f.put('install-approval.json', {
    id: 'preview-files',
    kind: 'mutation',
    scopeId: 'demo',
    taskId: 'presentation.preview',
    choice: 'approve',
    rationale: 'Synthetic approved preview',
    userResponse: 'Approve',
    at: '2026-01-01T00:00:00Z',
    inputs: [review],
  });
  const install = await f.put('install.json', { ...value, review, approval });
  await installPresentationPreview(join(f.base, install.path), join(f.base, 'install-result'));
  const req = await request(
    f,
    'preview',
    [{ role: 'previewInput', ...preview.request }],
    [
      { role: 'previewManifest', ...preview.manifest },
      { role: 'previewInstallInput', ...install },
    ],
  );
  return { f, preview, root, req, value, install, approval };
}

test('preview outcome verifies an actual approved installation without mutating app files', async (t) => {
  const { f, root, req } = await installed(t);
  const before = await readdir(root, { recursive: true });
  const result = await validate(f, req);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  assert.equal(result.workflowAdvanced, false);
  await writeFile(join(root, 'public/mock-layouts/home/index.json'), '{}');
  const stale = await validate(f, req);
  assert.equal(stale.valid, false);
  assert.match(stale.errors.join(), /hash differs/);
});

test('preview stage alone, missing approval and rehashed forged approval cannot pass', async (t) => {
  const { f, req, value, install } = await installed(t);
  const noApproval = await f.put('install-no-approval.json', value);
  const bad = structuredClone(req);
  bad.outputs[1] = { role: 'previewInstallInput', ...noApproval };
  assert.equal((await validate(f, bad)).valid, false);
  const staged = JSON.parse(await readFile(join(f.base, install.path), 'utf8'));
  const approval = JSON.parse(await readFile(join(f.base, staged.approval.path), 'utf8'));
  approval.inputs = [f.inputRef];
  staged.approval = await f.put('wrong-approval.json', approval);
  bad.outputs[1] = { role: 'previewInstallInput', ...(await f.put('wrong-install.json', staged)) };
  assert.equal((await validate(f, bad)).valid, false);
});

test('review replay requires canonical task-bound browser and human evidence', async (t) => {
  const f = await applicationFixture(t);
  const input = JSON.parse(await readFile(join(f.base, f.review.path), 'utf8'));
  input.taskId = 'presentation.review';
  const decision = JSON.parse(await readFile(join(f.base, input.decisions[0].path), 'utf8'));
  decision.taskId = input.taskId;
  input.decisions = [await f.put('current-review-decision.json', decision)];
  const role = await f.put('current-review.json', input);
  const { report } = await verifyPreview(join(f.base, role.path));
  const output = await f.put('review-report.json', report);
  const req = await request(
    f,
    'review',
    [{ role: 'reviewInput', ...role }],
    [{ role: 'previewReview', ...output }],
  );
  assert.equal((await validate(f, req)).valid, true);
  decision.userResponse = '';
  input.decisions = [await f.put('empty-review-decision.json', decision)];
  req.packet = (
    await request(
      f,
      'review',
      [{ role: 'reviewInput', ...(await f.put('bad-review.json', input)) }],
      req.outputs,
    )
  ).packet;
  assert.equal((await validate(f, req)).valid, false);
});

test('application cannot claim successful completion from a ready plan and empty journal', async (t) => {
  const f = await applicationFixture(t);
  f.input.taskId = 'presentation.apply';
  await f.stageState();
  const prepared = await f.prepare();
  const head = JSON.parse(await readFile(join(prepared.journalDirectory, 'head.json'), 'utf8'));
  const checkpoint = { path: 'journal/' + head.path, sha256: head.sha256 };
  const auditInput = await f.put('audit-input.json', {
    version: 1,
    scopeId: 'demo',
    applicationInput: f.applicationInput,
    applicationPlan: prepared.request.applicationPlan,
    journalDirectory: prepared.journalDirectory,
    targetState: f.input.targetState,
  });
  const audit = await f.put('fake-audit.json', { version: 1, scopeId: 'demo', ready: true });
  const req = await request(
    f,
    'apply',
    [
      { role: 'applicationInput', ...f.applicationInput },
      { role: 'applicationPlan', ...prepared.request.applicationPlan },
      { role: 'checkpoint', ...checkpoint },
    ],
    [
      { role: 'checkpoint', ...checkpoint },
      { role: 'applicationAuditInput', ...auditInput },
      { role: 'applicationAudit', ...audit },
    ],
  );
  const result = await validate(f, req);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(), /successful planned batch/);
});

async function noOpApplication(t) {
  const f = await applicationFixture(t);
  f.input.taskId = 'presentation.apply';
  const original = await f.build();
  // Synthetic captures describe a target that already has the desired state.
  for (const op of original.plan.operations)
    for (const ctx of op.contexts) {
      const row = f.state.queries.find((r) => r.key === ctx.query.key);
      const item = row.byId ?? {
        id: op.itemId,
        templateId: op.templateId,
        path: op.path,
        versionPresent: true,
        contexts: op.contexts.map((c) => ({
          itemId: op.itemId,
          language: c.query.language,
          version: c.query.version,
        })),
        fields: f.state.templates
          .find((r) => id(r.id) === id(op.templateId))
          .fields.map((r) => ({ ...r, rawValue: r.value, standardValue: '' })),
        shared: null,
        final: null,
        sharedOther: [],
        finalOther: [],
        componentName: null,
      };
      for (const field of ctx.fields) {
        const actual = item.fields.find((r) => r.name === field.name);
        actual.value =
          field.kind === 'mapping'
            ? field.mappings
                .map((r) => encodeURIComponent(r.templateId) + '=' + encodeURIComponent(r.designId))
                .join('&')
            : field.value;
        actual.rawValue = actual.value;
      }
      for (const layout of ctx.layouts)
        item[layout.final ? 'final' : 'shared'] = {
          layoutId: layout.layoutId,
          renderings: layout.renderings,
        };
      row.byId = item;
      if (row.query.path) row.byPath = structuredClone(item);
    }
  f.state.capturedAt = '2026-01-02T00:00:00Z';
  await f.stageState();
  const built = await f.build();
  assert.equal(built.plan.ready, true, JSON.stringify(built.plan.issues));
  assert.deepEqual(built.plan.batches, []);
  // prepare() selects a mutation batch, which no-op plans deliberately lack.
  const { initializeApplicationState } = await import('../scripts/lib/application-state.mjs');
  const journal = await initializeApplicationState(join(f.base, 'journal'), 'demo', f.profile.target);
  const checkpoint = { path: 'journal/checkpoint-000000.json', sha256: journal.sha256 };
  const plan = await f.put('application-plan.json', built.plan);
  const fresh = structuredClone(f.state);
  fresh.capturedAt = new Date().toISOString();
  const current = await f.put('audit-target-state.json', fresh);
  const auditInput = await f.put('audit-input.json', {
    version: 1,
    scopeId: 'demo',
    applicationInput: f.applicationInput,
    applicationPlan: plan,
    journalDirectory: journal.root,
    targetState: current,
  });
  await auditPresentationApplication(join(f.base, auditInput.path), join(f.base, 'audit'));
  const audit = {
    path: 'audit/presentation-application-audit.json',
    sha256: hash(await readFile(join(f.base, 'audit/presentation-application-audit.json'))),
  };
  return { f, checkpoint, plan, auditInput, audit };
}

test('canonical no-op application preserves its checkpoint and fresh audit replays independently', async (t) => {
  const { f, checkpoint, plan, auditInput, audit } = await noOpApplication(t);
  const req = await request(
    f,
    'apply',
    [
      { role: 'applicationInput', ...f.applicationInput },
      { role: 'applicationPlan', ...plan },
      { role: 'checkpoint', ...checkpoint },
    ],
    [
      { role: 'checkpoint', ...checkpoint },
      { role: 'applicationAuditInput', ...auditInput },
      { role: 'applicationAudit', ...audit },
    ],
  );
  const result = await validate(f, req);
  assert.equal(result.valid, true, result.errors.join('\n'));
  const auditRequest = await request(
    f,
    'audit',
    [{ role: 'applicationAuditInput', ...auditInput }],
    [{ role: 'applicationAudit', ...audit }],
  );
  assert.equal((await validate(f, auditRequest)).valid, true);
});

test('phase approval requires exact current packet evidence and an explicit human response', async (t) => {
  const { f, auditInput, audit } = await noOpApplication(t);
  const phase = {
    id: 'continue-presentation',
    kind: 'phase-continuation',
    scopeId: 'demo',
    taskId: 'presentation.approve',
    choice: 'approve',
    rationale: 'Synthetic phase approval',
    userResponse: 'Continue',
    at: '2026-01-01T00:00:00Z',
    inputs: [auditInput],
  };
  const req = await request(
    f,
    'approve',
    [{ role: 'applicationAuditInput', ...auditInput }],
    [
      { role: 'applicationAudit', ...audit },
      { role: 'phaseDecision', ...(await f.put('phase.json', phase)) },
    ],
  );
  assert.equal((await validate(f, req)).valid, true);
  for (const edit of [
    (p) => {
      p.userResponse = '';
    },
    (p) => {
      p.taskId = 'presentation.audit';
    },
    (p) => {
      p.kind = 'mutation';
    },
    (p) => {
      p.inputs = [f.inputRef];
    },
    (p) => {
      p.inputs.push(audit);
    },
    (p) => {
      p.choice = 'pause';
    },
  ]) {
    const wrong = structuredClone(phase);
    edit(wrong);
    req.outputs[1] = { role: 'phaseDecision', ...(await f.put('phase-wrong.json', wrong)) };
    const result = await validate(f, req);
    assert.equal(result.valid, false);
    assert.equal(result.workflowAdvanced, false);
  }
});

test('website and final approval replay actual target verification and retain current human phase evidence', async (t) => {
  const { websiteFixture } = await import('./website-fixture.mjs');
  const { verifyTargetWebsite } = await import('../scripts/verify-target-website.mjs');
  const f = await websiteFixture(t);
  f.input.taskId = 'verification.website';
  f.browserValue.taskId = f.input.taskId;
  f.decisionValue.taskId = f.input.taskId;
  await f.stageBrowser();
  const websiteInput = await f.stage();
  await verifyTargetWebsite(f.inputPath, f.outputPath());
  const websiteReport = {
    path: 'verified/website-verification-report.json',
    sha256: hash(await readFile(join(f.base, 'verified/website-verification-report.json'))),
  };
  const req = await request(
    f,
    'website',
    [{ role: 'websiteVerificationInput', ...websiteInput }],
    [{ role: 'websiteVerificationReport', ...websiteReport }],
  );
  const first = await validate(f, req);
  assert.equal(first.valid, true, first.errors.join('\n'));
  const decision = {
    id: 'final-continue',
    kind: 'phase-continuation',
    taskId: 'verification.approve',
    scopeId: 'demo',
    choice: 'approve',
    rationale: 'Synthetic final approval',
    userResponse: 'Approve final outcome',
    at: '2026-01-07T00:00:00Z',
    inputs: [websiteInput],
  };
  const final = await request(
    f,
    'final-approve',
    [{ role: 'websiteVerificationInput', ...websiteInput }],
    [
      { role: 'websiteVerificationReport', ...websiteReport },
      { role: 'phaseDecision', ...(await f.put('final-decision.json', decision)) },
    ],
  );
  const outcome = await validate(f, final);
  assert.equal(outcome.valid, true, outcome.errors.join('\n'));
  assert.equal(outcome.workflowAdvanced, false);
  decision.inputs = [f.inputRef];
  final.outputs[1] = { role: 'phaseDecision', ...(await f.put('stale-final.json', decision)) };
  assert.equal((await validate(f, final)).valid, false);
  await writeFile(join(f.base, 'target.png'), 'forged screenshot');
  assert.equal((await validate(f, final)).valid, false);
});

test('completed application requires actual checkpoint lineage and preserves historical snapshots safely', async (t) => {
  const { websiteFixture } = await import('./website-fixture.mjs');
  const { readApplicationJournal, transitionApplication } = await import(
    '../scripts/lib/application-state.mjs'
  );
  const f = await websiteFixture(t),
    initialPath = 'journal/checkpoint-000000.json';
  const initial = { path: initialPath, sha256: hash(await readFile(join(f.base, initialPath))) };
  const journal = await readApplicationJournal(f.journalDirectory);
  const completed = { path: 'journal/' + journal.head.path, sha256: journal.sha256 };
  // An additional immutable journal transition must not rebase a historical
  // completed output; a fresh audit may inspect the current verified head.
  const next = await transitionApplication(f.journalDirectory, journal.sha256, () => {});
  const auditInput = f.input.applicationAuditInput;
  await auditPresentationApplication(join(f.base, auditInput.path), join(f.base, 'application-audit'));
  const audit = {
    path: 'application-audit/presentation-application-audit.json',
    sha256: hash(await readFile(join(f.base, 'application-audit/presentation-application-audit.json'))),
  };
  const req = await request(
    f,
    'apply',
    [
      { role: 'applicationInput', ...f.auditRequest.applicationInput },
      { role: 'applicationPlan', ...f.auditRequest.applicationPlan },
      { role: 'checkpoint', ...initial },
    ],
    [
      { role: 'checkpoint', ...completed },
      { role: 'applicationAuditInput', ...auditInput },
      { role: 'applicationAudit', ...audit },
    ],
  );
  const result = await validate(f, req);
  assert.equal(result.valid, true, result.errors.join('\n'));
  const copied = await f.put(
    'copied-checkpoint.json',
    JSON.parse(await readFile(join(f.base, completed.path), 'utf8')),
  );
  req.outputs[0] = { role: 'checkpoint', ...copied };
  assert.equal((await validate(f, req)).valid, false);
  req.outputs[0] = { role: 'checkpoint', ...completed };
  await transitionApplication(f.journalDirectory, next.sha256, (state) => {
    state.active = { status: 'unknown' };
  });
  const active = await validate(f, req);
  assert.equal(active.valid, false);
  assert.match(active.errors.join(), /no active effects/);
});

test('CLI emits CMS entity-result evidence and refuses existing output directories', async (t) => {
  const f = await fixture(t),
    composed = await f.compose();
  const req = await request(
    f,
    'compose',
    [{ role: 'compositionInput', ...f.inputRef }],
    [{ role: 'compositionPlan', ...composed.plan }],
  );
  const input = await f.put('outcome-input.json', req),
    output = join(f.base, 'validated');
  const script = fileURLToPath(new URL('../scripts/validate-presentation-outcome.mjs', import.meta.url));
  const args = [script, '--input', join(f.base, input.path), '--output', output];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const files = await readdir(output);
  assert.equal(files.filter((name) => name.startsWith('entity-result-')).length, 1);
  const entity = JSON.parse(
    await readFile(
      join(
        output,
        files.find((name) => name.startsWith('entity-result-')),
      ),
      'utf8',
    ),
  );
  assert.equal(entity.checks[0].name, 'presentation-operation');
  assert.equal(entity.outcome, 'success');
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
});
