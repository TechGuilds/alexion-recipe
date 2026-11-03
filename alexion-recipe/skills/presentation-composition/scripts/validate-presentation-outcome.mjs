import { readFile, mkdtemp, rm, realpath, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { buildComposition } from './compose-presentation.mjs';
import { buildPreview } from './prepare-presentation-preview.mjs';
import { verifyPreview } from './review-presentation-preview.mjs';
import { buildApplication } from './plan-presentation-application.mjs';
import { auditPresentationApplication } from './audit-presentation-application.mjs';
import { readApplicationJournal } from './lib/application-state.mjs';
import {
  requireSchema,
  readJSON,
  readArtifactJSON,
  hash,
  jsonBytes,
  equal,
  canonical,
  decisionInputs,
  recheck,
  freshDirectory,
  writeNewJSON,
  isMain,
  errorReport,
} from './lib/common.mjs';
import { scopedPath } from '../../cms-migration/scripts/lib/files.mjs';
import { validate as cmsSchema } from '../../cms-migration/scripts/contracts.mjs';

const catalog = JSON.parse(
  await readFile(new URL('../assets/workflow-operations.json', import.meta.url), 'utf8'),
);
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const sameFile = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const fileSet = (refs) =>
  canonical(refs.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
const descriptor = (ref, role = false) => {
  check(ref && typeof ref === 'object' && !Array.isArray(ref), 'Invalid artifact descriptor');
  check(
    Object.keys(ref).every((k) => ['path', 'sha256', ...(role ? ['role'] : [])].includes(k)),
    'Unexpected artifact descriptor property',
  );
  requireSchema('ref', { path: ref.path, sha256: ref.sha256 });
  if (role) check(typeof ref.role === 'string' && ref.role.length > 0, 'Missing artifact role');
};

async function readBytes(base, ref) {
  descriptor({ path: ref.path, sha256: ref.sha256 });
  const path = await scopedPath(base, ref.path),
    bytes = await readFile(path);
  check(hash(bytes) === ref.sha256, 'Artifact hash differs: ' + ref.path);
  return { path, sha256: ref.sha256 };
}

async function phaseDecision(output, packet) {
  const decision = output.value;
  await cmsSchema('decision', decision);
  check(
    decision.kind === 'phase-continuation' &&
      decision.choice === 'approve' &&
      decision.scopeId === packet.scopeId &&
      decision.taskId === packet.task.id &&
      decision.userResponse?.trim() &&
      Number.isFinite(Date.parse(decision.at)) &&
      Date.parse(decision.at) <= Date.now(),
    'Phase continuation requires an explicit current human decision',
  );
  check(
    Array.isArray(decision.inputs) &&
      new Set(decision.inputs.map((r) => r.path)).size === decision.inputs.length &&
      fileSet(decision.inputs) === fileSet(packet.inputs),
    'Decision inputs differ from the exact current packet inputs',
  );
}

async function compareReplay(operation, input, output, refs = []) {
  const root = await mkdtemp(join(tmpdir(), 'presentation-outcome-'));
  try {
    let expected;
    if (operation === 'compose') {
      const built = await buildComposition(input.path);
      expected = built.plan;
      refs.push(...built.model.refs);
    } else if (operation === 'preview') {
      const built = await buildPreview(input.path);
      expected = built.manifest;
      refs.push(...built.refs);
    } else if (operation === 'review') {
      const built = await verifyPreview(input.path);
      expected = built.report;
      refs.push(...built.refs);
    } else {
      const directory = join(root, 'replay');
      const run = ['website', 'final-approve'].includes(operation)
        ? (await import('./verify-target-website.mjs')).verifyTargetWebsite
        : auditPresentationApplication;
      const result = await run(input.path, directory);
      check(result.ready === true, 'Canonical operation is blocked or not ready');
      const filename = ['website', 'final-approve'].includes(operation)
        ? 'website-verification-report.json'
        : 'presentation-application-audit.json';
      expected = (await readJSON(join(directory, filename))).value;
    }
    check(expected.ready === true, 'Canonical operation is blocked or not ready');
    check(expected.scopeId === input.value.scopeId, 'Canonical operation scope differs');
    check(
      hash(jsonBytes(expected)) === output.sha256,
      'Output differs from canonical operation: ' + output.role,
    );
    await recheck(refs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Verify the completed installation against its historical approved review.
// Re-running the installer would both mutate the app and rebuild different
// pre-install actions, so replay only reads the approved actions and actual bytes.
async function installedPreview(packet, roles, outputs, refs) {
  const install = outputs.previewInstallInput;
  const input = requireSchema('installInput', install.value),
    base = dirname(install.path);
  check(
    input.scopeId === packet.scopeId && input.taskId === packet.task.id,
    'Preview installation task/scope differs',
  );
  const preview = await readArtifactJSON(base, input.previewInput),
    manifest = await readArtifactJSON(base, input.previewManifest);
  refs.push(preview, manifest);
  check(
    preview.path === roles.previewInput.path &&
      preview.sha256 === roles.previewInput.sha256 &&
      manifest.path === outputs.previewManifest.path &&
      manifest.sha256 === outputs.previewManifest.sha256,
    'Installation must link the exact packet preview input and output manifest',
  );
  check(isAbsolute(input.targetRoot), 'Preview root must be absolute');
  const root = await realpath(input.targetRoot),
    stage = dirname(manifest.path);
  const overlap = (a, b) => {
    const rel = relative(a, b);
    return (
      !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    );
  };
  check(
    root === input.targetRoot &&
      (await lstat(root)).isDirectory() &&
      !overlap(root, stage) &&
      !overlap(stage, root),
    'Preview target root is aliased or overlaps stage',
  );
  const foundation = await readArtifactJSON(base, input.foundationEvidence),
    f = foundation.value;
  refs.push(foundation);
  check(
    f.version === 1 &&
      f.scopeId === packet.scopeId &&
      f.ready === true &&
      f.mockEnabled === true &&
      f.routeContract === 'single-context' &&
      f.targetRoot === root &&
      f.siteName === manifest.value.target.siteName &&
      f.language === manifest.value.target.language &&
      ['content-sdk', 'jss'].includes(f.framework),
    'Verified matching preview foundation required',
  );
  for (const role of ['loader', 'layout']) {
    const file = await readBytes(root, f[role]);
    refs.push(file);
    if (role === 'layout')
      check(
        (await readFile(file.path, 'utf8')).includes('/mock-preview/navigation.js'),
        'Preview navigation hook is missing',
      );
  }
  refs.push(await readArtifactJSON(dirname(foundation.path), f.evidence));
  check(
    input.review && input.approval,
    'Completed preview requires the exact installation review and explicit approval',
  );
  const review = await readArtifactJSON(base, input.review),
    approval = await readArtifactJSON(base, input.approval),
    r = review.value,
    a = approval.value;
  refs.push(review, approval, ...(await decisionInputs(a, base)));
  check(
    a.kind === 'mutation' &&
      a.choice === 'approve' &&
      a.scopeId === packet.scopeId &&
      a.taskId === packet.task.id &&
      a.userResponse?.trim() &&
      Number.isFinite(Date.parse(a.at)) &&
      Date.parse(a.at) <= Date.now() &&
      a.inputs.some((ref) => sameFile(ref, input.review)),
    'Preview app approval is not bound to the exact installation review',
  );
  const scriptSha256 = hash(await readFile(new URL('./install-presentation-preview.mjs', import.meta.url)));
  const built = await buildPreview(preview.path);
  refs.push(...built.refs);
  const expected = {
    version: 1,
    kind: 'virtual-preview-install',
    scopeId: packet.scopeId,
    taskId: packet.task.id,
    targetRoot: root,
    previewManifestSha256: manifest.sha256,
    foundationSha256: foundation.sha256,
    scriptSha256,
    actions: r.actions,
    targetSitecoreWrites: false,
    userApprovalRequired: true,
  };
  check(
    equal(r, expected) && Array.isArray(r.actions) && r.actions.length === manifest.value.files.length,
    'Installation review differs from canonical installer metadata',
  );
  for (const [index, entry] of manifest.value.files.entries()) {
    const action = r.actions[index];
    check(
      action &&
        equal(Object.keys(action).sort(), ['path', 'action', 'beforeSha256', 'afterSha256'].sort()) &&
        action.path === entry.path &&
        action.afterSha256 === entry.sha256 &&
        (action.action === 'create'
          ? action.beforeSha256 === null
          : ['reuse', 'replace'].includes(action.action) &&
            /^[a-f0-9]{64}$/.test(action.beforeSha256) &&
            (action.action === 'reuse'
              ? action.beforeSha256 === entry.sha256
              : action.beforeSha256 !== entry.sha256)),
      'Installation action differs from generated preview',
    );
    const staged = await readBytes(stage, entry),
      target = await readBytes(root, entry);
    check(
      (await readFile(target.path)).equals(built.files.get(entry.path)),
      'Installed preview differs from generated public bytes',
    );
    refs.push(staged, target);
  }
}

async function appliedPresentation(packet, roles, outputs, refs) {
  const built = await buildApplication(roles.applicationInput.path);
  refs.push(...built.model.refs);
  check(
    built.plan?.ready === true &&
      built.plan.taskId === packet.task.id &&
      equal(built.plan, roles.applicationPlan.value),
    'Application plan differs from canonical ready plan for this task',
  );
  const audit = requireSchema('applicationAuditInput', outputs.applicationAuditInput.value),
    base = dirname(outputs.applicationAuditInput.path);
  const app = await readArtifactJSON(base, audit.applicationInput),
    plan = await readArtifactJSON(base, audit.applicationPlan);
  refs.push(app, plan);
  check(
    app.path === roles.applicationInput.path &&
      app.sha256 === roles.applicationInput.sha256 &&
      plan.path === roles.applicationPlan.path &&
      plan.sha256 === roles.applicationPlan.sha256,
    'Application audit must link the exact application input and plan',
  );
  const journal = await readApplicationJournal(resolve(base, audit.journalDirectory));
  const snapshots = [];
  for (const name of await readdir(journal.root))
    if (/^checkpoint-.*\.json$/.test(name))
      snapshots.push({ ...(await readJSON(join(journal.root, name))), path: join(journal.root, name) });
  const initial = snapshots.find((row) => row.sha256 === roles.checkpoint.sha256),
    completed = snapshots.find((row) => row.sha256 === outputs.checkpoint.sha256);
  check(
    initial &&
      completed &&
      initial.path === roles.checkpoint.path &&
      completed.path === outputs.checkpoint.path,
    'Application checkpoints must identify actual immutable journal snapshots',
  );
  check(
    initial.value.sequence <= completed.value.sequence && !completed.value.active && !journal.state.active,
    'Input checkpoint must precede a completed output with no active effects',
  );
  check(
    equal(completed.value.target, built.plan.target) && completed.value.scopeId === packet.scopeId,
    'Application checkpoint target/scope differs',
  );
  if (built.plan.batches.length === 0)
    check(
      roles.checkpoint.sha256 === outputs.checkpoint.sha256,
      'No-op application must preserve its checkpoint',
    );
  for (const batch of built.plan.batches) {
    const rows = completed.value.completed.filter(
      (r) => r.applicationPlanSha256 === plan.sha256 && r.batchId === batch.id,
    );
    check(
      rows.length === 1 &&
        rows[0].status === 'success' &&
        equal(
          rows[0].results.map((r) => r.operationId),
          batch.operationIds,
        ) &&
        rows[0].results.every((r) => r.status === 'success'),
      'Output checkpoint lacks a successful planned batch',
    );
    for (const row of rows) {
      const previous = initial.value.completed.some((r) => equal(r, row));
      check(
        previous || row.taskId === packet.task.id,
        'Historical decision cannot authorize another task new writes',
      );
    }
  }
  await compareReplay('audit', outputs.applicationAuditInput, outputs.applicationAudit, refs);
  // Canonical audit independently verifies all terminal receipt evidence and
  // fresh target state; this links the reported checkpoint to that same journal.
  check(
    outputs.applicationAudit.value.checkpointSha256 === journal.sha256,
    'Application audit checkpoint differs from actual journal',
  );
  refs.push(await readBytes(journal.root, journal.head));
  const headPath = join(journal.root, 'head.json');
  refs.push({ path: headPath, sha256: (await readJSON(headPath)).sha256 });
  check(
    (await readApplicationJournal(journal.root)).sha256 === journal.sha256,
    'Application journal changed during outcome validation',
  );
}

/** Canonical read-only domain evidence. Never installs, submits jobs or advances workflow. */
export async function validatePresentationOutcome(input, { base = process.cwd() } = {}) {
  const report = {
    version: 1,
    valid: false,
    packet: input?.packet,
    outputs: input?.outputs,
    inputs: [],
    workflowAdvanced: false,
    errors: [],
  };
  try {
    requireSchema('outcomeInput', input);
    check(
      input &&
        input.version === 1 &&
        equal(Object.keys(input).sort(), ['version', 'packet', 'outputs'].sort()),
      'Invalid presentation outcome input',
    );
    descriptor(input.packet);
    check(Array.isArray(input.outputs) && input.outputs.length > 0, 'Missing output descriptors');
    input.outputs.forEach((ref) => descriptor(ref, true));
    const packetArtifact = await readArtifactJSON(base, input.packet),
      packet = packetArtifact.value,
      meta = packet.presentation;
    Object.assign(report, {
      scopeId: packet.scopeId,
      taskId: packet.task?.id,
      operation: meta?.operation,
      inputs: packet.inputs,
    });
    check(
      packet.kind === 'cms-migration-task-packet' &&
        packet.version === 1 &&
        typeof packet.scopeId === 'string' &&
        packet.scopeId.length > 0,
      'Require a scoped CMS task packet',
    );
    const definition = catalog.tasks.find((t) => t.operation === meta?.operation);
    check(
      definition &&
        packet.task.id === definition.id &&
        packet.task.agent === definition.agent &&
        packet.task.phaseId === definition.phaseId,
      'Packet task does not match the canonical operation',
    );
    const expectedMeta = {
      version: 1,
      operation: definition.operation,
      procedure: 'presentation-composition/' + definition.procedure,
      entryPoints: definition.entryPoints,
      inputRoles: meta.inputRoles,
      requiredOutputRoles: definition.outputRoles,
      optionalOutputRoles: definition.optionalOutputRoles ?? [],
    };
    check(equal(meta, expectedMeta), 'Packet operation metadata differs from canonical definition');
    check(
      Array.isArray(packet.entities) &&
        packet.entities.length === 1 &&
        packet.entities.every(
          (e) =>
            e.scope === 'included' &&
            e.kind === 'presentation:' + definition.operation &&
            e.id === `presentation-operation:${packet.scopeId}:${definition.operation}` &&
            e.source?.identity === definition.operation,
        ),
      'Packet entities do not match the canonical presentation operation unit',
    );
    check(
      Array.isArray(packet.inputs) &&
        packet.inputs.length > 0 &&
        new Set(packet.inputs.map((r) => r.path)).size === packet.inputs.length,
      'Packet inputs are missing or duplicated',
    );
    const refs = [packetArtifact];
    for (const ref of packet.inputs) {
      descriptor(ref);
      refs.push(await readBytes(base, ref));
    }
    check(
      Array.isArray(meta.inputRoles) &&
        meta.inputRoles.length === definition.inputRoles.length &&
        new Set(meta.inputRoles.map((r) => r.path)).size === meta.inputRoles.length &&
        new Set(meta.inputRoles.map((r) => r.role)).size === meta.inputRoles.length &&
        definition.inputRoles.every((role) => meta.inputRoles.some((r) => r.role === role)),
      'Packet input roles differ from canonical definition',
    );
    const roles = {},
      outputs = {};
    for (const ref of meta.inputRoles) {
      descriptor(ref, true);
      check(
        packet.inputs.some((r) => sameFile(r, ref)),
        'Input role is absent from packet inputs',
      );
      roles[ref.role] = await readArtifactJSON(base, ref);
    }
    check(
      new Set(input.outputs.map((r) => r.role)).size === input.outputs.length &&
        new Set(input.outputs.map((r) => r.path)).size === input.outputs.length &&
        definition.outputRoles.every((role) => input.outputs.some((r) => r.role === role)) &&
        input.outputs.every((r) =>
          [...definition.outputRoles, ...(definition.optionalOutputRoles ?? [])].includes(r.role),
        ),
      'Missing required output roles, duplicate roles/paths or unexpected output role',
    );
    for (const ref of input.outputs) outputs[ref.role] = { ...ref, ...(await readArtifactJSON(base, ref)) };
    for (const artifact of [...Object.values(roles), ...Object.values(outputs)]) {
      check(artifact.value.scopeId === packet.scopeId, 'Artifact scope differs from packet');
      refs.push(artifact);
    }
    const operation = definition.operation;
    if (operation === 'apply') await appliedPresentation(packet, roles, outputs, refs);
    else {
      const [inputRole, outputRole] = {
        compose: ['compositionInput', 'compositionPlan'],
        preview: ['previewInput', 'previewManifest'],
        review: ['reviewInput', 'previewReview'],
        audit: ['applicationAuditInput', 'applicationAudit'],
        approve: ['applicationAuditInput', 'applicationAudit'],
        website: ['websiteVerificationInput', 'websiteVerificationReport'],
        'final-approve': ['websiteVerificationInput', 'websiteVerificationReport'],
      }[operation];
      if (['review', 'website'].includes(operation))
        check(roles[inputRole].value.taskId === packet.task.id, 'Operation input task differs from packet');
      await compareReplay(operation, roles[inputRole], outputs[outputRole], refs);
      if (operation === 'preview') await installedPreview(packet, roles, outputs, refs);
      if (['approve', 'final-approve'].includes(operation))
        await phaseDecision(outputs.phaseDecision, packet);
    }
    await recheck(refs);
    report.valid = true;
  } catch (error) {
    report.errors.push(error.message);
  }
  return report;
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    check(
      args.length === 4 && args[0] === '--input' && args[2] === '--output',
      'Use --input request.json --output fresh-directory',
    );
    const path = resolve(args[1]),
      request = await readJSON(path),
      report = await validatePresentationOutcome(request.value, { base: dirname(path) });
    const output = await freshDirectory(args[3]);
    await writeNewJSON(join(output, 'presentation-outcome-report.json'), report);
    if (report.valid) {
      const packet = (await readArtifactJSON(dirname(path), report.packet)).value;
      for (const entity of packet.entities) {
        const result = {
          version: 1,
          taskId: report.taskId,
          entityId: entity.id,
          outcome: 'success',
          summary: `Validated presentation ${report.operation} operation evidence`,
          changedFiles: [],
          checkpoint: null,
          checks: [
            {
              name: 'presentation-operation',
              passed: true,
              detail: `presentation-outcome-report.json SHA-256 ${hash(jsonBytes(report))}; technical evidence only; human verification remains required`,
            },
          ],
          decisionIds: [],
          unresolved: [],
        };
        await cmsSchema('entity-result', result);
        await writeNewJSON(join(output, `entity-result-${hash(entity.id).slice(0, 24)}.json`), result);
      }
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.valid ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify(errorReport(error), null, 2));
    process.exitCode = 1;
  }
}
