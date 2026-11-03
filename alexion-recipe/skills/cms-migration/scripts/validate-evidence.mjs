import { loadProvider, providerRegistry } from './operation-providers.mjs';
import { cli, digest, fingerprintInputs, readScoped, readJSON, validate, workflowTasks, unique, isMain } from './contracts.mjs';

export const signature = inputs => JSON.stringify(inputs.map(({path, sha256}) => [path, sha256]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
export function explicitDecision(d, scopeId) {
  return d.scopeId === scopeId && typeof d.userResponse === 'string' && d.userResponse.trim().length > 0
    && typeof d.at === 'string' && Number.isFinite(Date.parse(d.at));
}
export function currentDecision(d, scopeId, inputs) {
  return inputs.length > 0 && explicitDecision(d, scopeId) && signature(d.inputs) === signature(inputs);
}
export async function checkInputs(inputs, base) {
  const errors = [];
  if (!inputs.length) return ['Missing current inputs'];
  unique(inputs.map(x => x.path), 'input paths');
  for (const item of inputs) {
    try { await checkHash(base, item.path, item.sha256); } catch (e) { errors.push(e.message); }
  }
  return errors;
}
async function checkHash(base, path, sha256) {
  if (digest(await readScoped(base, path)) !== sha256) throw new Error('Stale hash: ' + path);
}

/** Verifies staged attempts against current input and artifact bytes. No status writes. */
export async function validateEvidence(input, { base, changedFilesRoots = {}, taskScoped = false }) {
  await validate('validate-evidence-input', input);
  const tasks = await workflowTasks(input.workflow), errors = await checkInputs(input.inputs, base), verifiedTaskIds = [], verifiedEntityMappings = new Set(), entityAttestations = [];
  const requiredEvidenceKindsByTask = new Map();
  for (const [taskId, kinds] of Object.entries(input.requiredEvidenceKindsByTask ?? {})) {
    if (!tasks.has(taskId)) errors.push('Unknown task with required evidence kinds: ' + taskId);
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => typeof kind !== 'string' || !kind.trim()) || new Set(kinds).size !== kinds.length) {
      errors.push('Invalid required evidence kinds: ' + taskId);
      continue;
    }
    requiredEvidenceKindsByTask.set(taskId, new Set(kinds));
  }
  // Canonical operations declared by a provider always require actual domain replay.
  // Providers load lazily so generic CMS consumers need no optional skill.
  const { providers: entries } = await providerRegistry();
  for (const entry of entries) {
    const replayTasks = input.workflow.phases.flatMap(phase => phase.tasks
      .filter(task => (entry.replayTaskIds ?? []).includes(task.id))
      .map(task => ({ phase, task })));
    if (replayTasks.length) await (await loadProvider(entry)).module.requireReplay({ entries: replayTasks, errors, requiredEvidenceKindsByTask });
  }
  unique(input.inputs.map(x => x.path), 'input paths');
  unique(input.decisions.map(x => x.id), 'decision IDs');
  const currentInputsValid = errors.length === 0;
  const attempts = new Map(), duplicateTasks = new Set();
  for (const path of input.results) {
    try {
      const resultBytes = await readScoped(base, path);
      const result = await validate('task-result', JSON.parse(resultBytes));
      if (!tasks.has(result.taskId)) throw new Error('Unknown task: ' + result.taskId);
      if (attempts.has(result.taskId)) { duplicateTasks.add(result.taskId); throw new Error('Multiple selected attempts for task: ' + result.taskId); }
      attempts.set(result.taskId, { result, ref: { path, sha256: digest(resultBytes) } });
    } catch (e) { errors.push(path + ': ' + e.message); }
  }
  // A full workflow audit accounts for every completed task. Immediate
  // postflight validates only the selected attempt, so unrelated historical
  // tasks cannot make a current worker result ambiguous.
  const required = new Set(taskScoped
    ? input.requiredTaskIds ?? []
    : [...input.requiredTaskIds ?? [], ...[...tasks.values()].filter(t => t.status === 'done').map(t => t.id)]);
  for (const id of required) {
    if (!tasks.has(id)) errors.push('Unknown required task: ' + id);
    else if (!attempts.has(id)) errors.push('Missing result: ' + id);
  }
  // Approval and safety decisions remain separate from technical success.
  // They are a workflow-level concern and are deliberately deferred during
  // task-scoped postflight, which has not yet collected user verification.
  if (!taskScoped) {
    for (const task of tasks.values()) {
      if (!task.id.endsWith('.approve')) continue;
      if (task.status === 'skipped') errors.push('Approval gate cannot be skipped: ' + task.id);
      if (task.status !== 'done' && !attempts.has(task.id)) continue;
      const choices = input.decisions.filter(d => d.taskId === task.id && d.kind === 'phase-continuation');
      const accepted = currentInputsValid && choices.length === 1 && choices[0].choice === 'approve' && currentDecision(choices[0], input.scopeId, input.inputs);
      if (!accepted) errors.push('Missing current explicit approval: ' + task.id);
    }
  }
  for (const [id, attempt] of attempts) {
    const { result, ref: taskResultRef } = attempt;
    const taskErrors = [];
    try {
      if (duplicateTasks.has(id)) throw new Error('Ambiguous attempts');
      if (result.changedFiles.length && (!result.checkpoint || !result.changedFiles.every(p => result.checkpoint.scope.includes(p)))) throw new Error('Missing checkpoint for changed scope');
      const changedFilesBase = changedFilesRoots instanceof Map ? changedFilesRoots.get(id) : changedFilesRoots[id];
      for (const file of result.changedFiles) await readScoped(changedFilesBase ?? base, file);
      if (result.outcome !== 'success') taskErrors.push('Unverified outcome: ' + result.outcome);
      if (result.unresolved.length || !result.evidence.length) taskErrors.push('Partial or missing evidence');
      const entityEvidence = new Map();
      const passedEvidenceKinds = new Set();
      for (const evidence of result.evidence) {
        try {
          if (evidence.scopeId !== input.scopeId || signature(evidence.provenance.inputs) !== signature(input.inputs)) throw new Error('Stale input scope: ' + evidence.path);
          if (evidence.unresolved.length || !evidence.checks.length || evidence.checks.some(c => !c.passed)) throw new Error('Partial/failed checks: ' + evidence.path);
          await checkHash(base, evidence.path, evidence.provenance.sha256);
          const provider = entries.find(entry => entry.evidenceKind === evidence.kind);
          if (provider) await (await loadProvider(provider)).module.replayEvidence({ evidence, id, input, base, tasks });
          
          if (evidence.entityId) {
            if (evidence.kind !== 'entity-result') throw new Error('Entity-bound evidence must use kind entity-result: ' + evidence.path);
            const entityResult = await validate('entity-result', JSON.parse(await readScoped(base, evidence.path)));
            if (entityResult.taskId !== id || entityResult.entityId !== evidence.entityId) throw new Error('Entity-result identity mismatch: ' + evidence.path);
            if (entityResult.outcome !== 'success' || entityResult.unresolved.length || !entityResult.checks.length || entityResult.checks.some(c => !c.passed)) throw new Error('Entity result is not fully successful: ' + evidence.path);
            if (entityResult.changedFiles.some(file => !result.changedFiles.includes(file))) throw new Error('Entity-result changedFiles exceed task result: ' + evidence.path);
            if (entityResult.changedFiles.length && (!entityResult.checkpoint || !entityResult.changedFiles.every(file => entityResult.checkpoint.scope.includes(file)))) throw new Error('Entity-result checkpoint does not cover its changedFiles: ' + evidence.path);
            if (entityResult.checkpoint && (!result.checkpoint || entityResult.checkpoint.scope.some(file => !result.checkpoint.scope.includes(file)))) throw new Error('Entity-result checkpoint exceeds task checkpoint: ' + evidence.path);
            if (!entityEvidence.has(evidence.entityId)) entityEvidence.set(evidence.entityId, []);
            entityEvidence.get(evidence.entityId).push({ passed: true, ref: { path: evidence.path, sha256: evidence.provenance.sha256 } });
          }
          passedEvidenceKinds.add(evidence.kind);
        } catch (e) {
          taskErrors.push(e.message);
          if (evidence.entityId) {
            if (!entityEvidence.has(evidence.entityId)) entityEvidence.set(evidence.entityId, []);
            entityEvidence.get(evidence.entityId).push({ passed: false, ref: { path: evidence.path, sha256: evidence.provenance.sha256 } });
          }
        }
      }
      for (const kind of requiredEvidenceKindsByTask.get(id) ?? []) if (!passedEvidenceKinds.has(kind)) taskErrors.push('Missing required evidence kind: ' + kind);
      for (const [entityId, checks] of entityEvidence) {
        const mapping = { entityId, taskId: id };
        const technicallyVerified = currentInputsValid && checks.length > 0 && checks.every(check => check.passed);
        if (technicallyVerified) verifiedEntityMappings.add(JSON.stringify(mapping));
        if (!technicallyVerified) continue;

        // Human attestation is deliberately separate from worker/tester
        // success. Bind it to the selected task result and all of that
        // attempt's evidence so a rerun or changed screenshot invalidates it.
        const attestationInputs = [taskResultRef, ...result.evidence.map(item => ({ path: item.path, sha256: item.provenance.sha256 }))]
          .filter((item, index, all) => all.findIndex(other => other.path === item.path) === index)
          .sort((a, b) => a.path.localeCompare(b.path));
        const choices = input.decisions.filter(d => d.kind === 'verification' && d.scopeId === input.scopeId && d.taskId === id && d.entityId === entityId);
        const currentChoices = choices.filter(d => explicitDecision(d, input.scopeId) && signature(d.inputs) === signature(attestationInputs));
        let status = 'unattested';
        if (currentChoices.length > 1) status = 'ambiguous';
        else if (currentChoices.length === 1) {
          status = currentChoices[0].choice === 'verified' ? 'attested'
            : currentChoices[0].choice === 'not-verified' ? 'not-verified'
              : currentChoices[0].choice === 'pause' ? 'paused' : 'unattested';
        } else if (choices.length) status = 'stale';
        entityAttestations.push({ ...mapping, status, fingerprint: fingerprintInputs(input.inputs) });
      }
      if (id.endsWith('.approve') && errors.some(e => e.includes(id))) taskErrors.push('Unapproved gate');
    } catch (e) { taskErrors.push(e.message); }
    errors.push(...taskErrors.map(e => id + ': ' + e));
    if (currentInputsValid && taskErrors.length === 0) verifiedTaskIds.push(id);
  }
  const entityMappings = [...verifiedEntityMappings].map(JSON.parse).sort((a, b) => a.entityId.localeCompare(b.entityId) || a.taskId.localeCompare(b.taskId));
  const attestationSummary = Object.fromEntries(['attested', 'not-verified', 'paused', 'unattested', 'stale', 'ambiguous'].map(status => [status, entityAttestations.filter(item => item.status === status).length]));
  return { valid: errors.length === 0, inputs: input.inputs, inputFingerprint: fingerprintInputs(input.inputs), verifiedTaskIds: verifiedTaskIds.sort(), verifiedEntityMappings: entityMappings, entityAttestations: entityAttestations.sort((a, b) => a.entityId.localeCompare(b.entityId) || a.taskId.localeCompare(b.taskId)), errors, summary: { verified: verifiedTaskIds.length, verifiedEntities: entityMappings.length, entityAttestations: attestationSummary, errors: errors.length } };
}
if (await isMain(import.meta.url)) await cli('validate-evidence', validateEvidence);
