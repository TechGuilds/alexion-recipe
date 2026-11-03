import { cli, workflowTasks, unique, isMain } from './contracts.mjs';

/** Rejects a parent cycle: no member could ever be hosted. Kahn's algorithm, no recursion limit. */
function assertAcyclic(entities) {
  const ids = new Set(entities.map(e => e.id));
  const remaining = new Map(entities.map(e => [e.id, e.parentIds.filter(p => ids.has(p)).length]));
  const children = new Map(entities.map(e => [e.id, []]));
  for (const e of entities) for (const p of e.parentIds) if (ids.has(p)) children.get(p).push(e.id);
  const queue = [...remaining].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i])) {
    remaining.set(child, remaining.get(child) - 1);
    if (remaining.get(child) === 0) queue.push(child);
  }
  if (queue.length !== entities.length) throw new Error('Parent cycle in inventory: ' + entities.filter(e => remaining.get(e.id) > 0).map(e => e.id).sort().join(', '));
}

/**
 * Tasks an earlier run generated for a rule: listed by the anchor, named prefix.<base64url entity id>
 * and titled "<kind>: ...". Anything else the anchor depends on is a structural prerequisite.
 */
function generatedBy(rule, anchor, phase) {
  return phase.tasks.filter(task => {
    if (task === anchor || !anchor.dependsOn.includes(task.id) || !task.id.startsWith(rule.prefix + '.') || !task.title.startsWith(rule.kind + ': ')) return false;
    const encoded = task.id.slice(rule.prefix.length + 1);
    return encoded !== '' && Buffer.from(encoded, 'base64url').toString('base64url') === encoded;
  });
}

/**
 * Proposes a native workflow; never executes tasks or updates an existing file.
 * A parent is where an item is hosted and verified, not a prerequisite, so parent edges are NOT
 * written to dependsOn (all-of and satisfied-by-skip would both be wrong). next-work.mjs evaluates
 * hosting from the inventory.
 */
export async function buildWorkItems(input) {
  const workflow = structuredClone(input.workflow);
  const tasks = await workflowTasks(workflow), warnings = [], mappings = [];
  const entities = [...input.inventory.entities].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  unique(entities.map(x => x.id), 'entity IDs');
  const known = new Set(entities.map(x => x.id));
  for (const e of entities) for (const parent of e.parentIds) {
    if (!known.has(parent)) throw new Error(e.id + ': missing parent ' + parent);
  }
  assertAcyclic(entities);
  unique(input.profile.rules.map(x => x.kind), 'rule kinds');
  unique(input.profile.rules.map(x => x.prefix), 'rule prefixes');
  const rules = new Map(input.profile.rules.map(x => [x.kind, x]));
  const planned = new Map();
  for (const e of entities) {
    if (e.scope !== 'included') { warnings.push(e.id + ': scope requires review (' + e.scope + ')'); continue; }
    const rule = rules.get(e.kind);
    if (!rule) throw new Error('Missing profile rule for kind: ' + e.kind);
    const id = rule.prefix + '.' + Buffer.from(e.id).toString('base64url');
    planned.set(e.id, { id, rule });
    mappings.push({ entityId: e.id, taskId: id, routeIds: e.routeIds });
  }
  unique([...planned.values()].map(x => x.id), 'generated task IDs');
  const generatedIds = new Set([...planned.values()].map(x => x.id));
  // Re-discovery can remove or exclude an entity after its task was generated. Such a task keeps its
  // progress and is reported, never deleted; it is not one of the anchor's structural prerequisites.
  const earlier = new Map(), orphans = new Map();
  for (const rule of input.profile.rules) {
    const phase = workflow.phases.find(p => p.id === rule.phaseId);
    const anchor = phase?.tasks.find(t => t.id === rule.anchorTaskId);
    if (!anchor) continue;
    if (!earlier.has(anchor.id)) earlier.set(anchor.id, new Set());
    for (const task of generatedBy(rule, anchor, phase)) {
      earlier.get(anchor.id).add(task.id);
      if (!generatedIds.has(task.id)) orphans.set(task.id, { taskId: task.id, status: task.status, title: task.title, anchorTaskId: anchor.id });
    }
  }
  const anchorDependencies = new Map();
  for (const { rule } of planned.values()) {
    const phase = workflow.phases.find(p => p.id === rule.phaseId);
    const anchor = phase?.tasks.find(t => t.id === rule.anchorTaskId);
    if (!anchor || generatedIds.has(anchor.id)) throw new Error('Invalid anchor: ' + rule.anchorTaskId);
    anchorDependencies.set(anchor.id, anchor.dependsOn.filter(id => !generatedIds.has(id) && !earlier.get(anchor.id).has(id)));
  }
  for (const e of entities) {
    const item = planned.get(e.id); if (!item) continue;
    const { id, rule } = item;
    for (const parent of e.parentIds) {
      if (!planned.has(parent)) warnings.push(e.id + ': parent ' + parent + ' is not included, so it cannot host this item');
    }
    const dependsOn = [...anchorDependencies.get(rule.anchorTaskId)].sort();
    const existing = tasks.get(id);
    if (existing && existing.title !== e.kind + ': ' + e.source.identity) throw new Error('Existing task identity collision: ' + id);
    if (existing && JSON.stringify([...existing.dependsOn].sort()) !== JSON.stringify(dependsOn)) {
      throw new Error(`Existing task dependency conflict: ${id} depends on [${[...existing.dependsOn].sort()}] but the anchor's prerequisites are [${dependsOn}]`);
    }
    const phase = workflow.phases.find(p => p.id === rule.phaseId);
    if (existing && !phase.tasks.includes(existing)) throw new Error('Existing task phase conflict: ' + id);
    if (!existing) {
      const anchor = tasks.get(rule.anchorTaskId);
      if (anchor.status !== 'pending') throw new Error('Review progressed anchor before adding tasks: ' + anchor.id);
      const task = { id, title: e.kind + ': ' + e.source.identity, status: 'pending', dependsOn };
      if (rule.agent && (!input.availableAgents || input.availableAgents.includes(rule.agent))) task.agent = rule.agent;
      else if (rule.agent) warnings.push('Missing optional agent: ' + rule.agent);
      phase.tasks.splice(phase.tasks.indexOf(anchor), 0, task);
    }
    const anchor = tasks.get(rule.anchorTaskId);
    anchor.dependsOn = [...new Set([...anchor.dependsOn, id])].sort();
  }
  await workflowTasks(workflow);
  const orphanedTasks = [...orphans.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  for (const orphan of orphanedTasks) {
    if (orphan.status !== 'done' && orphan.status !== 'skipped') warnings.push(`${orphan.taskId}: no included entity generates this ${orphan.status} task and it still blocks ${orphan.anchorTaskId}; skip it with a scope decision or restore the entity`);
  }
  return { valid: true, workflow, mappings, orphanedTasks, warnings: [...new Set(warnings)].sort(), summary: { tasks: mappings.length, orphaned: orphanedTasks.length, warnings: new Set(warnings).size } };
}
if (await isMain(import.meta.url)) await cli('build-work-items', buildWorkItems);
