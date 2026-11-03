import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const terminal = task => task.status === 'done' || task.status === 'skipped';
const statuses = new Set(['pending', 'running', 'done', 'blocked', 'failed', 'skipped']);

/** Pure structural validation and readiness calculation; never writes or executes tasks. */
export function validateWorkflow(state) {
  const errors = [];
  const invalid = () => ({ valid: false, errors, complete: false, currentPhase: null, runnable: [], phases: [] });
  if (!object(state) || state.version !== 1 || !Array.isArray(state.phases) || !state.phases.length) {
    errors.push('Expected version: 1 and a non-empty phases array.');
    return invalid();
  }
  const phaseIds = new Set();
  const tasks = new Map();
  state.phases.forEach((phase, phaseIndex) => {
    if (!object(phase) || !text(phase.id) || !text(phase.title) || !Array.isArray(phase.tasks) || !phase.tasks.length) {
      errors.push(`Phase ${phaseIndex}: id, title and non-empty tasks are required.`);
      return;
    }
    if (phaseIds.has(phase.id)) errors.push(`Duplicate phase id: ${phase.id}`);
    phaseIds.add(phase.id);
    phase.tasks.forEach((task, taskIndex) => {
      if (!object(task) || !text(task.id) || !text(task.title) || !statuses.has(task.status)
        || !Array.isArray(task.dependsOn) || !task.dependsOn.every(text)
        || (task.optionalDependsOn !== undefined && (!Array.isArray(task.optionalDependsOn) || !task.optionalDependsOn.every(text)))
        || (task.agent !== undefined && !text(task.agent))
        || (task.result !== undefined && typeof task.result !== 'string')) {
        errors.push(`Task ${phase.id}/${taskIndex}: expected id, title, status, dependsOn; agent/result are optional strings.`);
        return;
      }
      if (tasks.has(task.id)) errors.push(`Duplicate task id: ${task.id}`);
      const optional = task.optionalDependsOn ?? [];
      if (new Set([...task.dependsOn, ...optional]).size !== task.dependsOn.length + optional.length) errors.push(`Duplicate dependency: ${task.id}`);
      tasks.set(task.id, { task, phaseIndex });
    });
  });
  if (errors.length) return invalid();
  for (const [id, { task, phaseIndex }] of tasks) {
    for (const dependency of [...task.dependsOn, ...(task.optionalDependsOn ?? [])]) {
      const entry = tasks.get(dependency);
      if (!entry) errors.push(`${id}: unknown dependency ${dependency}`);
      else if (entry.phaseIndex > phaseIndex) errors.push(`${id}: dependency ${dependency} is in a later phase.`);
    }
  }
  if (errors.length) return invalid();
  // Kahn's algorithm avoids recursion depth limits for large component inventories.
  const dependencies = task => [...task.dependsOn, ...(task.optionalDependsOn ?? [])];
  const remaining = new Map([...tasks].map(([id, { task }]) => [id, dependencies(task).length]));
  const children = new Map([...tasks.keys()].map(id => [id, []]));
  for (const [id, { task }] of tasks) for (const dep of dependencies(task)) children.get(dep).push(id);
  const queue = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index])) {
      remaining.set(child, remaining.get(child) - 1);
      if (remaining.get(child) === 0) queue.push(child);
    }
  }
  if (queue.length !== tasks.size) errors.push('Dependency cycle detected.');
  const phases = state.phases.map(phase => ({
    id: phase.id,
    complete: phase.tasks.every(terminal),
    total: phase.tasks.length,
    finished: phase.tasks.filter(terminal).length,
  }));
  const active = phases.findIndex(phase => !phase.complete);
  const satisfied = (task, dependency) => {
    const status = tasks.get(dependency).task.status;
    if (task.dependsOn.includes(dependency)) return terminal(tasks.get(dependency).task);
    // Optional edges model enrichment: wait for its attempt to finish, and allow
    // a terminal failure to proceed with an explicit evidence gap.
    return terminal(tasks.get(dependency).task) || status === 'failed';
  };
  for (const [id, { task, phaseIndex }] of tasks) {
    if (task.status !== 'done' && task.status !== 'running') continue;
    if ([...task.dependsOn, ...(task.optionalDependsOn ?? [])].some(dep => !satisfied(task, dep))) errors.push(`${id}: ${task.status} with unmet dependencies.`);
    if (active >= 0 && phaseIndex > active) errors.push(`${id}: ${task.status} before an earlier phase completed.`);
  }
  if (errors.length) return invalid();
  return {
    valid: true, errors: [], complete: active < 0,
    currentPhase: active < 0 ? null : phases[active].id,
    runnable: active < 0 ? [] : state.phases[active].tasks
      .filter(task => task.status === 'pending' && [...task.dependsOn, ...(task.optionalDependsOn ?? [])].every(dep => satisfied(task, dep)))
      .map(task => task.id),
    phases,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node validate.mjs <workflow.json>');
    const result = validateWorkflow(JSON.parse(await readFile(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [error.message], complete: false, currentPhase: null, runnable: [], phases: [] }));
    process.exitCode = 1;
  }
}
