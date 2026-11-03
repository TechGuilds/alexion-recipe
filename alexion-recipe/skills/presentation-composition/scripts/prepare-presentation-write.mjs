import { dirname, resolve } from 'node:path';
import { buildApplication, verifyOperationPost } from './plan-presentation-application.mjs';
import { readApplicationState, stateIndex, observed, applicationSources } from './lib/application-model.mjs';
import { readApplicationJournal, transitionApplication } from './lib/application-state.mjs';
import {
  requireSchema,
  readJSON,
  readArtifactJSON,
  equal,
  hash,
  jsonBytes,
  decisionInputs,
  recheck,
  publish,
  cli,
  isMain,
} from './lib/common.mjs';

export async function preparePresentationWrite(inputPath, outputPath) {
  const staged = await readJSON(inputPath),
    request = requireSchema('presentationWriteInput', staged.value),
    base = dirname(inputPath);
  const appInput = await readArtifactJSON(base, request.applicationInput),
    saved = await readArtifactJSON(base, request.applicationPlan),
    built = await buildApplication(appInput.path);
  if (
    !built.plan?.ready ||
    !equal(saved.value, built.plan) ||
    request.scopeId !== built.plan.scopeId ||
    request.taskId !== built.plan.taskId
  )
    throw Error('Require the exact ready canonical application plan for this task');
  const cap = built.model.cap;
  for (const flag of [
    'speWrite',
    'fullItemBackup',
    'restoreValidated',
    'exclusiveWriteWindow',
    'journalContinuityVerified',
    'layoutRoundtripValidated',
    'authoringDatabaseValidated',
  ])
    if (cap[flag] !== true) throw Error('Verified presentation write capability absent: ' + flag);
  const batch = built.plan.batches.find((batch) => batch.id === request.batchId);
  if (!batch)
    throw Error('Select an actual presentation mutation batch; zero-batch plans require no execution');
  const journalDirectory = resolve(base, request.journalDirectory),
    journal = await readApplicationJournal(journalDirectory);
  if (journal.state.scopeId !== request.scopeId || !equal(journal.state.target, built.plan.target))
    throw Error('Journal belongs to another presentation scope');
  if (journal.state.active)
    throw Error('Reserved/submitted/unknown presentation job must be reconciled first');
  const done = journal.state.completed.filter(
    (row) => row.applicationPlanSha256 === saved.sha256 && row.status === 'success',
  );
  if (batch.dependsOn.some((id) => !done.some((row) => row.batchId === id)))
    throw Error('Presentation batch prerequisites have not completed successfully');
  const current = await readApplicationState(base, request.currentState, built.read),
    index = stateIndex(current.value),
    latest = new Map();
  if (
    Date.parse(current.value.capturedAt) < Date.parse(built.state.capturedAt) ||
    done.some((row) => Date.parse(current.value.capturedAt) <= Date.parse(row.recordedAt))
  )
    throw Error('Fresh target capture must follow prior batch reconciliation');
  for (const completed of done)
    for (const row of completed.results) for (const post of row.post ?? []) latest.set(post.key, post.item);
  const guards = built.plan.guards.map((row) => ({
    ...row,
    byId: latest.has(row.key) ? latest.get(row.key) : row.byId,
    byPath: row.query.path && latest.has(row.key) ? latest.get(row.key) : row.byPath,
  }));
  for (const guard of guards) {
    const actual = current.value.queries.find((row) => row.key === guard.key);
    if (!actual || !equal(actual, guard))
      throw Error('Target presentation or dependency drift: ' + guard.key);
  }
  if (
    !equal(current.value.consumers, built.state.consumers) ||
    !equal(current.value.templates, built.state.templates)
  )
    throw Error('Template/consumer impact drift');
  const operations = batch.operationIds.map((id) =>
    built.plan.operations.find((op) => op.operationId === id),
  );
  const already = done.find((row) => row.batchId === batch.id);
  if (already) {
    for (const op of operations)
      verifyOperationPost(
        op,
        op.contexts.map((ctx) => ({ key: ctx.query.key, item: observed(index, ctx.query) })),
      );
    return { ready: true, executionAvailable: false, alreadyCompleted: true };
  }
  if (
    journal.state.completed.some(
      (row) => row.applicationPlanSha256 === saved.sha256 && row.batchId === batch.id,
    )
  )
    throw Error('A failed/partial presentation batch requires reviewed recovery, not blind resubmission');
  const sources = await applicationSources();
  const review = {
    version: 1,
    kind: 'presentation-mutation-review',
    scopeId: request.scopeId,
    taskId: request.taskId,
    applicationPlanSha256: saved.sha256,
    batchId: batch.id,
    target: built.plan.target,
    profile: built.model.profile,
    capabilities: cap,
    deviceId: built.model.cohorts[0].plan.target.deviceId,
    writerSha256: hash(sources.writer),
    readRequestSha256: built.read.sha256,
    checkpointSha256: journal.sha256,
    guards,
    templates: built.plan.templates,
    consumers: built.state.consumers,
    consumerTemplateIds: built.read.body.consumerTemplateIds,
    operations,
    readQueries: built.read.body.queries,
    userApprovalRequired: true,
  };
  const refs = [
    ...built.model.refs,
    { path: inputPath, sha256: staged.sha256 },
    { path: saved.path, sha256: saved.sha256 },
    { path: current.path, sha256: current.sha256 },
  ];
  const outputs = { 'presentation-execution-review.json': review },
    reviewSha256 = hash(jsonBytes(review));
  if (request.approval && !request.review)
    throw Error('Mutation approval requires the exact prior presentation review');
  if (request.review) {
    const artifact = await readArtifactJSON(base, request.review);
    if (!equal(artifact.value, review)) throw Error('Presentation mutation review is stale');
    refs.push({ path: artifact.path, sha256: artifact.sha256 });
  }
  if (!request.approval) {
    await publish(outputPath, outputs, refs);
    return { ready: true, executionAvailable: false, reviewSha256, mutationApprovalRequired: true };
  }
  const approval = await readArtifactJSON(base, request.approval),
    decision = approval.value;
  refs.push(...(await decisionInputs(decision, base)), { path: approval.path, sha256: approval.sha256 });
  if (
    decision.kind !== 'mutation' ||
    decision.choice !== 'approve' ||
    decision.scopeId !== request.scopeId ||
    decision.taskId !== request.taskId ||
    !decision.userResponse?.trim() ||
    !Number.isFinite(Date.parse(decision.at)) ||
    Date.parse(decision.at) > Date.now() ||
    !decision.inputs.some((ref) => equal(ref, request.review))
  )
    throw Error('Exact current CMS mutation approval required');
  const requestId = 'presentation-' + hash(reviewSha256 + journal.sha256).slice(0, 24),
    payload = {
      version: 1,
      requestId,
      reviewSha256,
      reviewJson: jsonBytes(review),
      reservation: journal.sha256,
      approval: decision,
    };
  const requestJson = jsonBytes(payload),
    envelope = {
      script: sources.writer,
      parameters: { RequestJson: requestJson, RequestSha256: hash(requestJson) },
      background: true,
      output: { mode: 'files' },
    };
  if (Buffer.byteLength(jsonBytes(envelope)) > cap.maxRequestBytes)
    throw Error('Presentation request exceeds connector byte bound');
  await recheck(refs);
  const reserved = await transitionApplication(journalDirectory, journal.sha256, (state) => {
    state.active = {
      requestId,
      reviewSha256,
      applicationPlanSha256: saved.sha256,
      batchId: batch.id,
      status: 'reserved',
      requestSha256: hash(requestJson),
      connectorId: built.plan.target.connectorId,
    };
  });
  outputs['presentation-target-request.json'] = envelope;
  outputs['presentation-reservation.json'] = { requestId, checkpointSha256: reserved.sha256 };
  await publish(outputPath, outputs, refs);
  return { ready: true, executionAvailable: true, requestId, checkpointSha256: reserved.sha256 };
}
if (isMain(import.meta.url)) await cli(preparePresentationWrite);
