import { args, required, safe, readBytes, writeReport, run, guid, cmp, hash } from './core.mjs';

const identity = row => `${row.id}|${row.language}|${row.version}`;
const isPath = value => typeof value === 'string' && value.startsWith('/sitecore/') && !value.slice(1).split('/').some(part => !part || part === '.' || part === '..');
const under = (path, root) => path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(`${root.toLowerCase()}/`);

function readIndex(file) {
  const bytes = readBytes(file);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw Error(`Invalid dependency index: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw Error('Dependency index must be a version-1 object with nodes and edges');
  }
  if (value.status !== 'complete') throw Error('Dependency index must have status complete before compiling transfer scope');
  const seen = new Set();
  const nodes = value.nodes.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !isPath(node.path) || typeof node.kind !== 'string' || !node.kind || typeof node.language !== 'string' || !node.language || node.version === undefined) {
      throw Error(`Invalid dependency node at index ${index}`);
    }
    const normalized = { id: guid(node.id), path: node.path, kind: node.kind, language: node.language, version: String(node.version) };
    if (seen.has(identity(normalized))) throw Error(`Duplicate dependency node identity: ${identity(normalized)}`);
    seen.add(identity(normalized));
    return normalized;
  }).sort((a, b) => cmp(identity(a), identity(b)));
  const known = new Set(nodes.map(identity));
  const edges = value.edges.map((edge, index) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge) || edge.status !== 'resolved' || !edge.consumer || typeof edge.consumer !== 'object' || !edge.targetId || typeof edge.language !== 'string' || !edge.language || edge.version === undefined || typeof edge.relation !== 'string' || !edge.relation) {
      throw Error(`Invalid resolved dependency edge at index ${index}`);
    }
    const consumer = { id: guid(edge.consumer.id), language: edge.consumer.language, version: String(edge.consumer.version) };
    const target = { id: guid(edge.targetId), language: edge.language, version: String(edge.version) };
    if (!known.has(identity(consumer)) || !known.has(identity(target))) throw Error(`Dependency edge at index ${index} is not closed over the index nodes`);
    return { consumer: identity(consumer), target: identity(target), relation: edge.relation };
  }).sort((a, b) => cmp(`${a.consumer}|${a.target}|${a.relation}`, `${b.consumer}|${b.target}|${b.relation}`));
  return { nodes, edges, ref: { path: safe(file), sha256: hash(bytes), bytes: bytes.length } };
}

function readScopePlan(file) {
  const bytes = readBytes(file);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw Error(`Invalid task-scope plan: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.tasks) || !value.tasks.length) {
    throw Error('Task-scope plan must be a version-1 object with non-empty tasks');
  }
  const ids = new Set();
  const tasks = value.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id.trim() || !Array.isArray(task.roots) || !Array.isArray(task.dependsOn ?? [])) {
      throw Error(`Invalid task-scope plan task at index ${index}`);
    }
    if (ids.has(task.id)) throw Error(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);
    const role = task.role ?? 'transfer';
    if (role !== 'transfer' && role !== 'audit') throw Error(`Invalid task role for ${task.id}`);
    if ((role === 'transfer' && !task.roots.length) || (role === 'audit' && task.roots.length)) {
      throw Error(`Task ${task.id} must ${role === 'transfer' ? 'have at least one root' : 'not own transfer roots'}`);
    }
    const roots = task.roots.map(root => {
      if (!isPath(root)) throw Error(`Invalid root for task ${task.id}: ${root}`);
      return root;
    }).sort(cmp);
    if (new Set(roots.map(root => root.toLowerCase())).size !== roots.length) throw Error(`Duplicate root for task ${task.id}`);
    const dependsOn = task.dependsOn.map(dependency => {
      if (typeof dependency !== 'string' || !dependency.trim() || dependency === task.id) throw Error(`Invalid dependency for task ${task.id}`);
      return dependency;
    }).sort(cmp);
    if (new Set(dependsOn).size !== dependsOn.length) throw Error(`Duplicate dependency for task ${task.id}`);
    return { id: task.id, role, roots, dependsOn };
  }).sort((a, b) => cmp(a.id, b.id));
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw Error(`Unknown task dependency: ${task.id} -> ${dependency}`);
  const exclusions = (value.approvedExclusions ?? []).map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.decisionId !== 'string' || !row.decisionId.trim() || typeof row.rationale !== 'string' || !row.rationale.trim()) throw Error(`Invalid approved exclusion at index ${index}`);
    const result = { id: guid(row.id), decisionId: row.decisionId, rationale: row.rationale };
    if (row.language !== undefined || row.version !== undefined) {
      if (typeof row.language !== 'string' || !row.language || row.version === undefined) throw Error(`Approved exclusion language/version must be supplied together at index ${index}`);
      result.language = row.language; result.version = String(row.version);
    }
    return result;
  });
  const external = (value.approvedExternalDependencies ?? []).map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.decisionId !== 'string' || !row.decisionId.trim() || typeof row.rationale !== 'string' || !row.rationale.trim()) throw Error(`Invalid approved external dependency at index ${index}`);
    return { id: guid(row.id), decisionId: row.decisionId, rationale: row.rationale };
  });
  return { tasks, exclusions, external, ref: { path: safe(file), sha256: hash(bytes), bytes: bytes.length } };
}

function dependencyClosure(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const done = new Map();
  const visit = (id, active = new Set()) => {
    if (done.has(id)) return done.get(id);
    if (active.has(id)) throw Error(`Task dependency cycle: ${[...active, id].join(' -> ')}`);
    active.add(id);
    const result = new Set(byId.get(id).dependsOn);
    for (const dependency of byId.get(id).dependsOn) for (const transitive of visit(dependency, active)) result.add(transitive);
    active.delete(id); done.set(id, result); return result;
  };
  for (const task of tasks) visit(task.id);
  return done;
}

run(() => {
  const input = args(['dependency-index', 'task-scope-plan', 'output-root']);
  required(input, 'dependency-index', 'task-scope-plan', 'output-root');
  const index = readIndex(input['dependency-index']);
  const plan = readScopePlan(input['task-scope-plan']);
  const owners = new Map();
  for (const node of index.nodes) {
    const matches = plan.tasks.filter(task => task.roots.some(root => under(node.path, root))).map(task => task.id);
    owners.set(identity(node), matches);
  }
  const excluded = node => plan.exclusions.find(row => row.id === node.id && (row.language === undefined || (row.language === node.language && row.version === node.version)));
  const overlappingItems = index.nodes.filter(node => owners.get(identity(node)).length > 1).map(node => ({ id: node.id, path: node.path, language: node.language, version: node.version, taskIds: owners.get(identity(node)).sort(cmp) }));
  const approvedExternal = new Set(plan.external.map(row => row.id));
  const unassignedItems = index.nodes.filter(node => owners.get(identity(node)).length === 0 && !excluded(node) && !approvedExternal.has(node.id)).map(node => ({ id: node.id, path: node.path, language: node.language, version: node.version }));
  const owner = nodeIdentity => owners.get(nodeIdentity).length === 1 ? owners.get(nodeIdentity)[0] : null;
  const nodeByIdentity = new Map(index.nodes.map(node => [identity(node), node]));
  const closure = dependencyClosure(plan.tasks);
  const uncoveredDependencies = [], unorderedDependencies = [];
  for (const edge of index.edges) {
    const consumer = nodeByIdentity.get(edge.consumer), target = nodeByIdentity.get(edge.target);
    const consumerOwner = owner(edge.consumer), targetOwner = owner(edge.target);
    if (!consumerOwner) continue;
    if (!targetOwner) {
      if (!excluded(target) && !approvedExternal.has(target.id)) uncoveredDependencies.push({ consumer: consumer.id, consumerPath: consumer.path, target: target.id, targetPath: target.path, relation: edge.relation });
    } else if (consumerOwner !== targetOwner && !closure.get(consumerOwner).has(targetOwner)) {
      unorderedDependencies.push({ consumer: consumer.id, consumerPath: consumer.path, consumerTaskId: consumerOwner, target: target.id, targetPath: target.path, targetTaskId: targetOwner, relation: edge.relation });
    }
  }
  const pathKinds = new Map();
  for (const node of index.nodes) {
    if (!owner(identity(node))) continue;
    const key = node.path.toLowerCase();
    if (!pathKinds.has(key)) pathKinds.set(key, { path: node.path, kinds: new Set(), owners: new Set() });
    pathKinds.get(key).kinds.add(node.kind); pathKinds.get(key).owners.add(owner(identity(node)));
  }
  const pathConflicts = [...pathKinds.values()].filter(row => row.kinds.size !== 1 || row.owners.size !== 1).map(row => ({ path: row.path, kinds: [...row.kinds].sort(cmp), taskIds: [...row.owners].sort(cmp) })).sort((a, b) => cmp(a.path, b.path));
  const taskCounts = plan.tasks.map(task => ({ id: task.id, role: task.role, roots: task.roots, dependsOn: task.dependsOn, itemCount: index.nodes.filter(node => owner(identity(node)) === task.id).length })).sort((a, b) => cmp(a.id, b.id));
  const ready = overlappingItems.length === 0 && unassignedItems.length === 0 && uncoveredDependencies.length === 0 && unorderedDependencies.length === 0 && pathConflicts.length === 0;
  const scopeItems = [...pathKinds.values()].filter(row => row.kinds.size === 1 && row.owners.size === 1).map(row => ({ path: row.path, kind: [...row.kinds][0] })).sort((a, b) => cmp(a.path, b.path));
  const manifest = { version: 1, ready, source: { dependencyIndex: index.ref, taskScopePlan: plan.ref }, taskCounts, approvedExclusions: plan.exclusions, approvedExternalDependencies: plan.external, overlappingItems, unassignedItems, uncoveredDependencies, unorderedDependencies, pathConflicts, scopeItemCount: scopeItems.length };
  writeReport(input['output-root'], 'task-scope-manifest.json', manifest, [input['dependency-index'], input['task-scope-plan']]);
  writeReport(input['output-root'], 'scope-items.json', { version: 1, status: ready ? 'complete' : 'blocked', source: { taskScopeManifestSha256: hash(JSON.stringify(manifest, null, 2) + '\n'), dependencyIndexSha256: index.ref.sha256, taskScopePlanSha256: plan.ref.sha256 }, items: scopeItems }, [input['dependency-index'], input['task-scope-plan']]);
  if (!ready) process.exitCode = 2;
});
