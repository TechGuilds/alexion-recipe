/** Content transfer has one phase per scope, independent of its chosen ID. */
export function contentTransferPhases(workflow) {
  return workflow.phases.filter(phase =>
    phase.tasks.some(task => task.status !== 'skipped') &&
    (phase.id === 'content' ||
      /content[-_\s]*migration|mapped[-_\s]*content|native[-_\s]*(?:content|serialization)/i.test(phase.id + ' ' + phase.title)));
}

export function assertExclusiveContentTransfer(workflow) {
  const phases = contentTransferPhases(workflow);
  if (phases.length > 1) throw new Error('Only one content-transfer phase is allowed for the current scope; review the selected transfer mechanism');
  return phases;
}
