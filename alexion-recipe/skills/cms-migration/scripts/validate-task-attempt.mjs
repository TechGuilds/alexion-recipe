import { lstat, realpath } from 'node:fs/promises';
import { cli, isMain, readScoped, scopedDirectory, validate } from './contracts.mjs';
import { validateEvidence } from './validate-evidence.mjs';

async function workspaceRoot(path) {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace root is not a directory');
  return root;
}

async function readWorkspaceJson(root, path, contract) {
  return validate(contract, JSON.parse(await readScoped(root, path)));
}

function requireTargetRelative(paths, changedFilesRoot) {
  const root = changedFilesRoot.replace(/\/+$/, '');
  const workspaceRelative = paths.filter(path => path === root || path.startsWith(root + '/'));
  if (workspaceRelative.length) {
    throw new Error('changedFiles and checkpoint.scope must be relative to changedFilesRoot, not workspace-relative: ' + workspaceRelative.join(', '));
  }
}

/**
 * Validates one worker attempt from a task-owned, path-only postflight request.
 * The request is not execution state: workflow and decisions are re-read from
 * their canonical current records at validation time.
 */
export async function validateTaskAttempt(input, { options }) {
  await validate('validate-task-attempt-input', input);
  if (!options['workspace-root']) throw new Error('Missing --workspace-root');
  const root = await workspaceRoot(options['workspace-root']);
  const [workflow, decisionsBytes, result] = await Promise.all([
    readWorkspaceJson(root, input.workflowPath, 'workflow'),
    readScoped(root, input.decisionsPath),
    readWorkspaceJson(root, input.resultPath, 'task-result'),
  ]);
  const allDecisions = JSON.parse(decisionsBytes);
  if (result.taskId !== input.taskId) throw new Error('Task result does not match postflight task ID');
  if (!Array.isArray(allDecisions)) throw new Error('Decisions must be an array');
  // Immediate postflight consumes only decisions that can attest or reject
  // this task. Historical decisions remain canonical workflow data and are
  // checked by the full audit, not by an unrelated worker result.
  const decisions = allDecisions.filter(decision => decision?.taskId === input.taskId);
  await Promise.all(decisions.map(decision => validate('decision', decision)));
  let changedFilesRoots = {};
  if (result.changedFiles.length) {
    if (!input.changedFilesRoot) throw new Error('Missing changed files root for modified task');
    requireTargetRelative(result.changedFiles, input.changedFilesRoot);
    requireTargetRelative(result.checkpoint?.scope ?? [], input.changedFilesRoot);
    changedFilesRoots = { [input.taskId]: await scopedDirectory(root, input.changedFilesRoot) };
  } else if (input.changedFilesRoot) {
    await scopedDirectory(root, input.changedFilesRoot);
  }
  return validateEvidence({
    workflow,
    scopeId: input.scopeId,
    inputs: input.inputs,
    results: [input.resultPath],
    decisions,
    requiredTaskIds: [input.taskId],
    ...(input.requiredEvidenceKinds ? { requiredEvidenceKindsByTask: { [input.taskId]: input.requiredEvidenceKinds } } : {}),
  }, { base: root, changedFilesRoots, taskScoped: true });
}

if (await isMain(import.meta.url)) await cli('validate-task-attempt', validateTaskAttempt, ['workspace-root']);
