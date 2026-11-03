import { cli, fingerprintInputs, unique, validate, workflowTasks, isMain } from './contracts.mjs';

// Same rule as the workflow validator: an ordering dependency is met by done or explicitly skipped.
const finished = task => task.status === 'done' || task.status === 'skipped';
const satisfied = (task, dependency, tasks) => {
  const upstream = tasks.get(dependency);
  return finished(upstream) || ((task.optionalDependsOn ?? []).includes(dependency) && upstream.status === 'failed');
};
const hostState = { pending: 'waiting', running: 'waiting', failed: 'failed', blocked: 'failed', skipped: 'skipped' };
const STARVED_LIMIT = 50;

function stableInputs(inputs) {
  return [...inputs].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The fingerprint used by validate-evidence/next-work to bind a user decision
 * to the exact reviewed input set. It is deliberately based on paths and
 * hashes, not filesystem reads, because this CLI is read-only.
 */
export function inputFingerprint(inputs) {
  return fingerprintInputs(inputs);
}

function sameInputs(left, right) {
  return JSON.stringify(stableInputs(left)) === JSON.stringify(stableInputs(right));
}

/**
 * Returns unresolved human-verification records for completed mapped tasks in
 * the active implementation phase. `attested` is validate-evidence's wire
 * status for a `verified` decision; the normalized `verified` status is also
 * accepted for callers that persist the decision directly.
 */
export function verificationBlockers(input, active, scoped) {
  if (!active || ['setup', 'discovery'].includes(active.id)) return [];
  // Only agent-owned implementation tasks participate in this frontier. The
  // same CLI is used for synthetic/setup ordering inputs that have no worker
  // agent and must retain their existing dependency/hosting behavior.
  const completed = scoped.filter(({ task }) => task.status === 'done' && task.agent);
  if (!completed.length) return [];
  const blockers = [];
  const byTask = input.validationByTask === undefined ? null : new Map(input.validationByTask.map(item => [item.taskId, item.validation]));

  for (const { task, entities } of completed) {
    const validation = byTask ? byTask.get(task.id) : input.validation;
    // Task-scoped postflight reports bind each completed attempt to its own
    // reviewed inputs. The next operation normally consumes different files.
    const currentInputs = (byTask ? validation?.inputs : input.inputs) ?? [];
    const currentFingerprint = currentInputs.length ? inputFingerprint(currentInputs) : null;
    const attestations = new Map((validation?.entityAttestations ?? []).map(item => [JSON.stringify([item.taskId, item.entityId]), item]));
    for (const entity of entities) {
      const key = JSON.stringify([task.id, entity.id]);
      const attestation = attestations.get(key);
      let reason = 'user-verification';
      let warning = `Task ${task.id} entity ${entity.id} has no current user verification`;
      if (!validation || validation.valid !== true || !currentFingerprint || !Array.isArray(validation.inputs) || !validation.inputFingerprint) {
        reason = 'missing-validation';
        warning = `Task ${task.id} entity ${entity.id} is missing current evidence validation`;
      } else if (!sameInputs(validation.inputs, currentInputs) || validation.inputFingerprint !== currentFingerprint) {
        reason = 'stale-verification';
        warning = `Task ${task.id} entity ${entity.id} has a stale verification fingerprint`;
      } else if (!attestation) {
        reason = 'user-verification';
      } else if (!['attested', 'verified'].includes(attestation.status)) {
        reason = attestation.status === 'stale' ? 'stale-verification' : 'user-verification';
        warning = `Task ${task.id} entity ${entity.id} verification is ${attestation.status}`;
      } else if (attestation.fingerprint !== currentFingerprint) {
        reason = 'stale-verification';
        warning = `Task ${task.id} entity ${entity.id} has a stale verification fingerprint`;
      } else {
        continue;
      }
      blockers.push({ taskId: task.id, entityId: entity.id, reason, needsDecision: true, warning });
    }
  }
  return blockers;
}

function parseLimit(value) {
  if (value === undefined) return 5;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be an integer from 1 to 50');
  return limit;
}

/**
 * Recommends which mapped work items to dispatch next and explains why the rest wait.
 * A recommendation only: it never writes state, marks a task running or dispatches a worker.
 *
 * Ordering dependencies (`dependsOn`) gate each task, exactly as the workflow validator does.
 * Multiple inventory entities may map to one user-sized task. Such a task is recommended only
 * when every entity in its batch is reachable; the result describes the whole group once.
 * Hosting is separate: an item is reachable when it has no parent, or when ANY of its in-scope
 * parents is done, because it needs one place where it can be seen and verified. A parent that is
 * failed, skipped or out of scope never makes an item reachable on its own; that is reported for a
 * human decision. `proceedWithoutHost` lists entities the user has approved to proceed without a
 * rendered host; they are recommended with isolated-only verification.
 */
export async function nextWork(input, context = {}) {
  const limit = parseLimit(context.options?.limit);
  if (input.validationByTask !== undefined) {
    unique(input.validationByTask.map(item => item.taskId), 'task-scoped validations');
    for (const item of input.validationByTask) await validate('task-frontier-validation', item);
  }
  const tasks = await workflowTasks(input.workflow);
  unique(input.inventory.entities.map(e => e.id), 'entity IDs');
  unique(input.mappings.map(m => m.entityId), 'entity mappings');
  const entities = new Map(input.inventory.entities.map(e => [e.id, e]));
  for (const m of input.mappings) {
    if (!entities.has(m.entityId)) throw new Error('Mapping names unknown entity: ' + m.entityId);
    if (!tasks.has(m.taskId)) throw new Error('Mapping names unknown task: ' + m.taskId);
  }
  const overrides = new Set(input.proceedWithoutHost ?? []);
  for (const id of overrides) if (!entities.has(id)) throw new Error('proceedWithoutHost names unknown entity: ' + id);
  const taskOf = new Map(input.mappings.map(m => [m.entityId, tasks.get(m.taskId)]));

  const active = input.workflow.phases.find(phase => !phase.tasks.every(finished)) ?? null;
  const inPhase = new Set(active?.tasks.map(task => task.id) ?? []);
  const grouped = new Map();
  for (const mapping of input.mappings.filter(m => inPhase.has(m.taskId))) {
    if (!grouped.has(mapping.taskId)) grouped.set(mapping.taskId, { task: tasks.get(mapping.taskId), entities: [] });
    grouped.get(mapping.taskId).entities.push(entities.get(mapping.entityId));
  }
  const scoped = [...grouped.values()].map(group => ({ ...group, entities: group.entities.sort((a, b) => a.id.localeCompare(b.id)) }));
  const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const { task } of scoped) counts[task.status]++;

  const warnings = [];
  const eligible = [], starved = [], unlocks = new Map();
  for (const { entities: members, task } of scoped) {
    if (task.status !== 'pending') continue;
    const waitingOn = [...task.dependsOn, ...(task.optionalDependsOn ?? [])].filter(id => !satisfied(task, id, tasks));
    const entityIds = members.map(entity => entity.id);
    const groupRef = entityIds.length === 1 ? { entityId: entityIds[0] } : { entityIds };
    if (waitingOn.length) { starved.push({ ...groupRef, taskId: task.id, reason: 'dependency', needsDecision: false, waitingOn }); continue; }
    const memberStates = [];
    for (const entity of members) {
      const unknown = entity.parentIds.filter(id => !entities.has(id));
      if (unknown.length) warnings.push(entity.id + ': parent not in inventory: ' + unknown.join(', '));
      const hosts = entity.parentIds.filter(id => taskOf.has(id)).map(id => ({ entityId: id, taskId: taskOf.get(id).id, status: taskOf.get(id).status }));
      const done = hosts.filter(host => host.status === 'done' || host.taskId === task.id);
      let member;
      if (!entity.parentIds.length) member = { entity, via: 'seed', hostedBy: [] };
      else if (done.length) member = { entity, via: 'hosted', hostedBy: done.map(host => host.entityId) };
      else if (overrides.has(entity.id)) member = { entity, via: 'without-host', hostedBy: [] };
      else {
        const states = new Set(hosts.map(host => hostState[host.status]));
        const reason = !hosts.length ? 'host-out-of-scope' : states.has('waiting') ? 'waiting-for-host' : states.has('failed') ? 'host-failed' : 'host-skipped';
        member = { entity, blocked: { reason, needsDecision: reason !== 'waiting-for-host', hosts } };
        if (reason === 'waiting-for-host') for (const host of hosts) unlocks.set(host.entityId, (unlocks.get(host.entityId) ?? 0) + 1);
      }
      memberStates.push(member);
    }
    const blocked = memberStates.filter(member => member.blocked);
    if (blocked.length) {
      const reasons = blocked.map(member => member.blocked.reason);
      const reason = reasons.includes('host-out-of-scope') ? 'host-out-of-scope'
        : reasons.includes('host-failed') ? 'host-failed'
          : reasons.includes('host-skipped') ? 'host-skipped' : 'waiting-for-host';
      starved.push({ ...groupRef, taskId: task.id, reason, needsDecision: blocked.some(member => member.blocked.needsDecision), members: blocked.map(member => ({ entityId: member.entity.id, ...member.blocked })) });
      continue;
    }
    eligible.push({ entities: members, task, via: [...new Set(memberStates.map(member => member.via))].join('+'),
      hostedBy: [...new Set(memberStates.flatMap(member => member.hostedBy))],
      verification: memberStates.some(member => member.via === 'without-host') ? 'isolated-only' : 'in-context' });
  }

  // Technical completion and human verification are separate. A completed
  // implementation batch may be technically done, but it cannot unlock the
  // next task until every mapped entity has a current verification decision.
  const verification = verificationBlockers(input, active, scoped);
  if (verification.length) {
    const pending = scoped.filter(({ task }) => task.status === 'pending');
    const existingStarved = new Set(starved.map(item => item.taskId));
    eligible.length = 0;
    for (const { task, entities: members } of pending) {
      if (existingStarved.has(task.id)) continue;
      const groupRef = members.length === 1 ? { entityId: members[0].id } : { entityIds: members.map(entity => entity.id) };
      const related = verification.filter(item => item.taskId !== task.id);
      const warningsForTask = related.length ? related : verification;
      starved.push({ ...groupRef, taskId: task.id, reason: 'user-verification', needsDecision: true,
        warning: warningsForTask.map(item => item.warning).join('; '),
        blockedBy: warningsForTask.map(item => ({ taskId: item.taskId, entityId: item.entityId, reason: item.reason })) });
    }
    warnings.push(...verification.map(item => item.warning));
    if (!pending.length) warnings.push('Completed mapped implementation work is awaiting user verification before the phase can close');
  }
  const ignored = [...overrides].filter(id => !eligible.some(item => item.entities.some(entity => entity.id === id) && item.verification === 'isolated-only'));
  if (ignored.length) warnings.push('proceedWithoutHost had no effect for: ' + ignored.sort().join(', ') + ' (not pending, already reachable or waiting on another dependency)');

  const rank = ({ entities: members }) => ({
    used: members.some(entity => entity.routeIds.length > 0),
    unlocks: members.reduce((total, entity) => total + (unlocks.get(entity.id) ?? 0), 0),
    routes: new Set(members.flatMap(entity => entity.routeIds)).size,
    uncertainty: members.reduce((total, entity) => total + entity.uncertainty.length, 0),
    joins: members.reduce((total, entity) => total + entity.joins.length, 0),
  });
  const order = (a, b) => {
    const x = a.rank, y = b.rank;
    if (x.used !== y.used) return x.used ? -1 : 1;
    if (x.unlocks !== y.unlocks) return y.unlocks - x.unlocks;
    if (x.routes !== y.routes) return y.routes - x.routes;
    if (x.uncertainty !== y.uncertainty) return x.uncertainty - y.uncertainty;
    if (x.joins !== y.joins) return x.joins - y.joins;
    const firstA = a.entities[0].id, firstB = b.entities[0].id;
    return firstA < firstB ? -1 : firstA > firstB ? 1 : 0;
  };
  const ranked = eligible.map(item => ({ ...item, rank: rank(item) })).sort(order)
    .map(({ entities: members, task, via, hostedBy, verification, rank: keys }) => ({
      ...(members.length === 1 ? { entityId: members[0].id } : { entityIds: members.map(entity => entity.id) }),
      taskId: task.id, title: task.title, via, ...(hostedBy.length ? { hostedBy } : {}), verification, rank: keys,
    }));
  starved.sort((a, b) => {
    const firstA = a.entityId ?? a.entityIds?.[0] ?? '';
    const firstB = b.entityId ?? b.entityIds?.[0] ?? '';
    return firstA < firstB ? -1 : firstA > firstB ? 1 : 0;
  });
  const starvedByReason = {};
  for (const item of starved) starvedByReason[item.reason] = (starvedByReason[item.reason] ?? 0) + 1;

  let status;
  if (verification.length) status = counts.failed || counts.blocked || starved.some(item => item.needsDecision && item.reason !== 'user-verification') ? 'blocked' : 'waiting';
  else if (ranked.length) status = 'has-pending';
  else if (!active) status = 'all-complete';
  else if (!scoped.length) status = 'none-in-phase';
  else if (!counts.pending && !counts.running && !counts.failed && !counts.blocked) status = 'all-complete';
  else if (counts.failed || counts.blocked || starved.some(item => item.needsDecision)) status = 'blocked';
  else status = 'waiting';
  if (status === 'none-in-phase') warnings.push('No mapped work items in the active phase' + (active ? ': ' + active.id : ''));

  const next = ranked.slice(0, limit);
  return {
    valid: true, status, phase: active?.id ?? null, primary: next[0] ?? null, next, eligibleTotal: ranked.length,
    starved: starved.slice(0, STARVED_LIMIT), starvedTruncated: starved.length > STARVED_LIMIT, starvedByReason, counts,
    warnings: [...new Set(warnings)].sort(),
    summary: { status, phase: active?.id ?? null, eligible: ranked.length, starved: starved.length, starvedByReason, primary: next[0]?.taskId ?? null, nextTaskIds: next.map(item => item.taskId) },
  };
}
if (await isMain(import.meta.url)) await cli('next-work', nextWork, ['limit']);
