import { cli, unique, workflowTasks, isMain } from './contracts.mjs';
import { validateEvidence, currentDecision, checkInputs, signature } from './validate-evidence.mjs';

export async function coverageReport(input, context) {
  unique(input.inventory.entities.map(e => e.id), 'entity IDs');
  unique(input.mappings.map(m => m.entityId), 'entity mappings');
  unique(input.decisions.map(d => d.id), 'decision IDs');
  const tasks = await workflowTasks(input.workflow), entities = new Map(input.inventory.entities.map(e => [e.id, e]));
  const mappings = new Map(input.mappings.map(m => [m.entityId, m.taskId]));
  const inputs = input.inputs ?? input.validation?.inputs ?? [];
  const inputErrors = await checkInputs(inputs, context.base);
  if (input.inputs && input.validation && signature(input.inputs) !== signature(input.validation.inputs)) inputErrors.push('Coverage and validation inputs differ');
  const validation = input.validation ? await validateEvidence({ ...input.validation, workflow: input.workflow }, context) : null;
  if (input.validation && input.validation.scopeId !== input.inventory.scopeId) throw new Error('Validation scope does not match inventory');
  const verified = new Set(inputErrors.length ? [] : validation?.verifiedTaskIds ?? []);
  const verifiedEntityMappings = new Set((inputErrors.length ? [] : validation?.verifiedEntityMappings ?? []).map(x => JSON.stringify([x.entityId, x.taskId])));
  const attestations = new Map((inputErrors.length ? [] : validation?.entityAttestations ?? []).map(x => [JSON.stringify([x.entityId, x.taskId]), x.status]));
  const entitiesByTask = new Map();
  for (const mapping of input.mappings) entitiesByTask.set(mapping.taskId, (entitiesByTask.get(mapping.taskId) ?? 0) + 1);
  const counts = { total: entities.size, included: 0, excluded: 0, verified: 0, pending: 0, running: 0, failed: 0, blocked: 0, explicitlySkipped: 0, unverified: 0, unresolved: 0 };
  const attestationCounts = { attested: 0, notVerified: 0, paused: 0, unattested: 0, stale: 0, ambiguous: 0, notRequired: 0 };
  const missingEntityIds = [], unmatchedTaskIds = [], unresolvedEntityIds = [], routes = new Set(), entityCoverage = [];
  for (const mapping of input.mappings) {
    if (!entities.has(mapping.entityId) || !tasks.has(mapping.taskId)) unmatchedTaskIds.push(mapping.taskId);
  }
  for (const e of [...entities.values()].sort((a, b) => a.id < b.id ? -1 : 1)) {
    const choices = input.decisions.filter(d => d.kind === 'scope' && d.entityId === e.id);
    const current = choices.length === 1 && !inputErrors.length && currentDecision(choices[0], input.inventory.scopeId, inputs);
    const excluded = current && choices[0].choice === 'exclude' && (!choices[0].taskId || choices[0].taskId === mappings.get(e.id));
    if (excluded) { counts.excluded++; attestationCounts.notRequired++; entityCoverage.push({ entityId: e.id, state: 'excluded', attestation: 'not-required' }); continue; }
    counts.included++;
    e.routeIds.forEach(r => routes.add(r));
    const task = tasks.get(mappings.get(e.id));
    let state = 'unresolved';
    const skipped = current && choices[0].choice === 'skip' && choices[0].taskId === task?.id;
    const unresolved = e.scope !== 'included' || e.uncertainty.length > 0 || (choices.length > 0 && (!current || !['include', 'skip'].includes(choices[0].choice)))
      || (task?.status === 'skipped' && (!skipped || task.id.endsWith('.approve')))
      || (task?.id.endsWith('.approve') && task.status === 'done' && !verified.has(task.id))
      || e.parentIds.some(p => !entities.has(p)) || e.joins.some(j => !entities.has(j));
    if (!task) missingEntityIds.push(e.id);
    else if (unresolved) state = 'unresolved';
    else if (verifiedEntityMappings.has(JSON.stringify([e.id, task.id]))) state = 'verified';
    else if (task.status === 'done') state = verified.has(task.id) && entitiesByTask.get(task.id) === 1 ? 'verified' : 'unverified';
    else if (task.status === 'skipped') state = 'explicitlySkipped';
    else state = task.status;
    counts[state]++;
    if (state === 'unresolved') unresolvedEntityIds.push(e.id);
    const attestation = task ? (attestations.get(JSON.stringify([e.id, task.id])) ?? 'unattested') : 'unattested';
    if (attestation === 'attested') attestationCounts.attested++;
    else if (attestation === 'not-verified') attestationCounts.notVerified++;
    else if (attestation === 'paused') attestationCounts.paused++;
    else if (attestation === 'stale') attestationCounts.stale++;
    else if (attestation === 'ambiguous') attestationCounts.ambiguous++;
    else attestationCounts.unattested++;
    entityCoverage.push({ entityId: e.id, taskId: task?.id ?? null, state, attestation });
  }
  const unsampledRouteIds = [...routes].filter(r => !(input.sampledRouteIds ?? []).includes(r)).sort();
  return { valid: true, counts, attestationCounts, missingEntityIds, unmatchedTaskIds: [...new Set(unmatchedTaskIds)].sort(), unresolvedEntityIds, unsampledRouteIds, entityCoverage,
    evidenceErrors: [...inputErrors, ...(validation?.errors ?? [])], warnings: entities.size ? [] : ['Empty inventory is not proof of zero work'],
    summary: { ...counts, attestations: attestationCounts, missing: missingEntityIds.length, unmatched: unmatchedTaskIds.length } };
}
if (await isMain(import.meta.url)) await cli('coverage-report', coverageReport);
