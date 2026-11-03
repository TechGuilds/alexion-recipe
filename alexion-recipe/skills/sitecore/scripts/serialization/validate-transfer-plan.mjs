import { args, cmp, guid, hash, inspect, readBytes, required, run, safe, writeReport } from './core.mjs';

function readPlan(file) {
  const absolute = safe(file), bytes = readBytes(absolute);
  let plan;
  try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw Error(`Invalid task plan JSON: ${error.message}`); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1 || !Array.isArray(plan.tasks) || !plan.tasks.length) {
    throw Error('Task plan must be a version-1 object with non-empty tasks');
  }
  const ids = new Set();
  const tasks = plan.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id.trim()
      || !Array.isArray(task.namespaces) || !task.namespaces.length || !Array.isArray(task.dependsOn ?? [])) {
      throw Error(`Invalid task plan task at index ${index}`);
    }
    if (ids.has(task.id)) throw Error(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);
    const namespaces = task.namespaces.map(namespace => {
      if (typeof namespace !== 'string' || !namespace.trim()) throw Error(`Invalid namespace for task: ${task.id}`);
      return namespace;
    });
    if (new Set(namespaces).size !== namespaces.length) throw Error(`Duplicate namespace for task: ${task.id}`);
    const dependsOn = task.dependsOn.map(dependency => {
      if (typeof dependency !== 'string' || !dependency.trim()) throw Error(`Invalid dependency for task: ${task.id}`);
      return dependency;
    });
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(task.id)) throw Error(`Invalid dependency set for task: ${task.id}`);
    return { id: task.id, namespaces: namespaces.sort(cmp), dependsOn: dependsOn.sort(cmp) };
  }).sort((a, b) => cmp(a.id, b.id));
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw Error(`Unknown task dependency: ${task.id} -> ${dependency}`);
  const approvedExternalDependencies = (plan.approvedExternalDependencies ?? []).map((dependency, index) => {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)
      || typeof dependency.decisionId !== 'string' || !dependency.decisionId.trim()
      || typeof dependency.rationale !== 'string' || !dependency.rationale.trim()) throw Error(`Invalid external dependency at index ${index}`);
    return { id: guid(dependency.id), decisionId: dependency.decisionId, rationale: dependency.rationale };
  }).sort((a, b) => cmp(a.id, b.id));
  if (new Set(approvedExternalDependencies.map(dependency => dependency.id)).size !== approvedExternalDependencies.length) throw Error('Duplicate approved external dependency');
  return { plan: { version: 1, tasks, approvedExternalDependencies }, ref: { path: absolute, sha256: hash(bytes), bytes: bytes.length } };
}

function dependencyClosure(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const complete = new Map();
  const visit = (id, active = new Set()) => {
    if (complete.has(id)) return complete.get(id);
    if (active.has(id)) throw Error(`Task dependency cycle: ${[...active, id].join(' -> ')}`);
    active.add(id);
    const dependencies = new Set(byId.get(id).dependsOn);
    for (const dependency of byId.get(id).dependsOn) for (const transitive of visit(dependency, active)) dependencies.add(transitive);
    active.delete(id); complete.set(id, dependencies); return dependencies;
  };
  for (const task of tasks) visit(task.id);
  return complete;
}

run(() => {
  const input = args(['items-root', 'modules-root', 'task-plan', 'output-root']);
  required(input, 'items-root', 'modules-root', 'task-plan', 'output-root');
  const inspection = inspect(input['items-root'], input['modules-root']);
  const { plan, ref: taskPlan } = readPlan(input['task-plan']);
  const knownNamespaces = new Set(inspection.modules.map(module => module.namespace));
  const namespaceOwners = new Map();
  for (const task of plan.tasks) for (const namespace of task.namespaces) {
    if (!namespaceOwners.has(namespace)) namespaceOwners.set(namespace, []);
    namespaceOwners.get(namespace).push(task.id);
  }
  const unknownNamespaces = [...namespaceOwners]
    .filter(([namespace]) => !knownNamespaces.has(namespace))
    .map(([namespace, taskIds]) => ({ namespace, taskIds: taskIds.sort(cmp) }))
    .sort((a, b) => cmp(a.namespace, b.namespace));
  const ownershipOverlaps = [...namespaceOwners]
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([namespace, taskIds]) => ({ namespace, taskIds: taskIds.sort(cmp) }))
    .sort((a, b) => cmp(a.namespace, b.namespace));
  const ownerForItem = item => namespaceOwners.get(item.namespace)?.length === 1 ? namespaceOwners.get(item.namespace)[0] : undefined;
  const unassignedItems = inspection.items.filter(item => !ownerForItem(item)).map(item => ({ id: item.id, namespace: item.namespace, path: item.path })).sort((a, b) => cmp(a.id, b.id));
  const closure = dependencyClosure(plan.tasks);
  const byId = new Map(inspection.items.map(item => [item.id, item]));
  const crossTaskDependencyErrors = [];
  for (const item of inspection.items) for (const dependency of item.dependencies) {
    const prerequisite = byId.get(dependency.id);
    if (!prerequisite) continue;
    const owner = ownerForItem(item), prerequisiteOwner = ownerForItem(prerequisite);
    if (owner && prerequisiteOwner && owner !== prerequisiteOwner && !closure.get(owner).has(prerequisiteOwner)) {
      crossTaskDependencyErrors.push({ itemId: item.id, itemTaskId: owner, dependencyId: dependency.id, dependencyTaskId: prerequisiteOwner, kind: dependency.kind });
    }
  }
  crossTaskDependencyErrors.sort((a, b) => cmp(a.itemId, b.itemId) || cmp(a.dependencyId, b.dependencyId));
  const approvedExternal = new Set(plan.approvedExternalDependencies.map(dependency => dependency.id));
  const unapprovedExternalDependencies = inspection.missingReferences
    .filter(dependency => !approvedExternal.has(dependency.id))
    .sort((a, b) => cmp(a.item, b.item) || cmp(a.id, b.id) || cmp(a.kind, b.kind));
  const externalSoftReferences = inspection.softReferences
    .filter(dependency => !byId.has(dependency.id))
    .sort((a, b) => cmp(a.item, b.item) || cmp(a.id, b.id) || cmp(a.kind, b.kind));
  const taskCounts = plan.tasks.map(task => ({
    id: task.id,
    namespaces: task.namespaces,
    dependsOn: task.dependsOn,
    itemCount: inspection.items.filter(item => ownerForItem(item) === task.id).length,
  }));
  const ready = inspection.valid && unknownNamespaces.length === 0 && ownershipOverlaps.length === 0
    && unassignedItems.length === 0 && crossTaskDependencyErrors.length === 0 && unapprovedExternalDependencies.length === 0;
  const report = {
    version: 1,
    ready,
    inputManifest: { ...inspection.inputManifest, taskPlan },
    diagnostics: inspection.diagnostics,
    warnings: inspection.warnings,
    taskCounts,
    unknownNamespaces,
    ownershipOverlaps,
    unassignedItems,
    crossTaskDependencyErrors,
    approvedExternalDependencies: plan.approvedExternalDependencies,
    unapprovedExternalDependencies,
    softReferences: inspection.softReferences,
    externalSoftReferences,
  };
  writeReport(input['output-root'], 'transfer-preflight.json', report, [input['items-root'], input['modules-root'], input['task-plan']]);
  if (!report.ready) process.exitCode = 2;
});
