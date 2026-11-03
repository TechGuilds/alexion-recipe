import { dirname, resolve } from 'node:path';
import { buildApplication, verifyOperationPost } from './plan-presentation-application.mjs';
import { readApplicationState, stateIndex, observed } from './lib/application-model.mjs';
import { readApplicationJournal } from './lib/application-state.mjs';
import { verifyPresentationCompletionEvidence } from './record-presentation-execution.mjs';
import { requireSchema, readJSON, readArtifactJSON, equal, publish, cli, isMain } from './lib/common.mjs';

export function verifyApplicationCompletion(plan, planSha256, journal, current) {
  if (!plan.ready || journal.state.scopeId !== plan.scopeId || !equal(journal.state.target, plan.target))
    throw Error('Application audit scope/target differs');
  if (journal.state.active) throw Error('Reserved/submitted/unknown presentation effects remain unresolved');
  const history = journal.state.completed.filter((row) => row.applicationPlanSha256 === planSha256);
  for (const batch of plan.batches) {
    const records = history.filter((row) => row.batchId === batch.id);
    if (
      records.length !== 1 ||
      records[0].status !== 'success' ||
      !equal(
        records[0].results.map((row) => row.operationId),
        batch.operationIds,
      ) ||
      records[0].results.some((row) => row.status !== 'success')
    )
      throw Error('A planned presentation batch lacks a unique successful terminal history: ' + batch.id);
    const row = records[0];
    if (
      !Number.isFinite(Date.parse(row.recordedAt)) ||
      Date.parse(current.capturedAt) <= Date.parse(row.recordedAt)
    )
      throw Error('Independent target read must follow every terminal reconciliation');
    for (const result of row.results)
      verifyOperationPost(
        plan.operations.find((op) => op.operationId === result.operationId),
        result.post,
      );
  }
  if (history.some((row) => !plan.batches.some((batch) => batch.id === row.batchId)))
    throw Error('Unexpected presentation batch history');
  const index = stateIndex(current);
  const operationContexts = new Set(
    plan.operations.flatMap((operation) => operation.contexts.map((context) => context.query.key)),
  );
  for (const guard of plan.guards ?? [])
    if (!operationContexts.has(guard.key) && !equal(index.get(guard.key), guard))
      throw Error('Application dependency drift: ' + guard.key);
  // Operation read-back also verifies each preserved material/presentation field
  // and other device, so only those contexts may differ from the initial guards.
  for (const operation of plan.operations)
    verifyOperationPost(
      operation,
      operation.contexts.map((ctx) => ({ key: ctx.query.key, item: observed(index, ctx.query) })),
    );
  return true;
}

export async function auditPresentationApplication(inputPath, outputPath) {
  const staged = await readJSON(inputPath),
    input = requireSchema('applicationAuditInput', staged.value),
    base = dirname(inputPath);
  const appInput = await readArtifactJSON(base, input.applicationInput),
    saved = await readArtifactJSON(base, input.applicationPlan),
    built = await buildApplication(appInput.path);
  if (!built.plan?.ready || input.scopeId !== built.plan.scopeId || !equal(saved.value, built.plan))
    throw Error('Application audit requires the exact ready canonical plan');
  const journal = await readApplicationJournal(resolve(base, input.journalDirectory));
  const current = await readApplicationState(base, input.targetState, built.read);
  if (
    input.targetState.sha256 === built.model.input.targetState.sha256 ||
    Date.parse(current.value.capturedAt) <= Date.parse(built.state.capturedAt)
  )
    throw Error('Application audit requires an independent fresh target capture');
  if (
    !equal(current.value.templates, built.state.templates) ||
    !equal(current.value.consumers, built.state.consumers)
  )
    throw Error('Application template/consumer impact drift');
  verifyApplicationCompletion(built.plan, saved.sha256, journal, current.value);
  const evidenceRefs = [];
  for (const completion of journal.state.completed)
    evidenceRefs.push(...(await verifyPresentationCompletionEvidence(completion, journal.state)));
  const headPath = resolve(journal.root, 'head.json'),
    head = await readJSON(headPath);
  if (!equal(head.value, journal.head)) throw Error('Presentation journal changed during final audit');
  const report = {
    version: 1,
    kind: 'presentation-application-audit',
    scopeId: input.scopeId,
    ready: true,
    applicationPlanSha256: saved.sha256,
    checkpointSha256: journal.sha256,
    targetStateSha256: current.sha256,
    verifiedOperations: built.plan.operations.length,
    verifiedBatches: built.plan.batches.length,
    targetWrites: false,
    workflowAdvanced: false,
    userConfirmationRequired: true,
  };
  await publish(outputPath, { 'presentation-application-audit.json': report }, [
    ...built.model.refs,
    ...evidenceRefs,
    { path: inputPath, sha256: staged.sha256 },
    { path: saved.path, sha256: saved.sha256 },
    { path: current.path, sha256: current.sha256 },
    { path: headPath, sha256: head.sha256 },
  ]);
  return report;
}
if (isMain(import.meta.url)) await cli(auditPresentationApplication);
