// Read-only mapping plan. Human approval and source capture are separate evidence.
import { canonicalId, compare, exact, list, object, requiredText, sha256, sourceMappingRequirements, validateComponentMappings, validateSourceMappingInventory, validateTargetRenderingInventory } from './component-mapping.mjs';

const refKey = r => `${r.path}:${r.sha256}`;
export function validateInputFiles(inputFiles = []) {
  const result = list(inputFiles, 'inputFiles').map(ref => {
    exact(ref, ['role', 'path', 'sha256'], 'input file');
    if (!['source', 'target', 'manifest', 'coverage'].includes(ref.role)) throw new Error('Unknown input file role');
    if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Input sha256 must be a SHA-256 hex digest');
    return { role: ref.role, path: requiredText(ref.path, 'input path'), sha256: ref.sha256 };
  }).sort((a, b) => compare(a.role, b.role));
  if (new Set(result.map(r => r.role)).size !== result.length || new Set(result.map(r => r.path)).size !== result.length) throw new Error('Duplicate input file role/path');
  return result;
}
function approvalFor(decisions, inputFiles, scopeId) {
  const reasons = [];
  const candidates = list(decisions, 'decisions').filter(d => d?.kind === 'mapping' && d.scopeId === scopeId);
  if (candidates.length !== 1) reasons.push('Exactly one keyed mapping decision must match the current scope.');
  const decision = candidates.length === 1 ? candidates[0] : undefined;
  if (!['source', 'target', 'manifest'].every(role => inputFiles.some(ref => ref.role === role))) reasons.push('Mapping approval requires current source, target and manifest file hashes.');
  if (decision) {
    const allowed = ['id', 'kind', 'scopeId', 'taskId', 'entityId', 'choice', 'rationale', 'userResponse', 'at', 'inputs'];
    try { exact(decision, allowed, 'keyed decision'); } catch (error) { reasons.push(error.message); }
    if (typeof decision.id !== 'string' || !decision.id.trim() || typeof decision.rationale !== 'string' || !decision.rationale.trim()) reasons.push('Mapping decision requires id and rationale.');
    if (decision.choice !== 'approve') reasons.push('Mapping decision is not approved.');
    if (decision.taskId !== undefined || decision.entityId !== undefined) reasons.push('Whole-manifest mapping approval cannot use a narrower taskId or entityId scope.');
    if (typeof decision.userResponse !== 'string' || !decision.userResponse.trim()) reasons.push('Mapping approval requires the user response.');
    if (typeof decision.at !== 'string' || Number.isNaN(Date.parse(decision.at))) reasons.push('Mapping approval requires a valid timestamp.');
    const refs = Array.isArray(decision.inputs) ? decision.inputs : [];
    if (refs.some(r => !r || Object.keys(r).some(k => !['path', 'sha256'].includes(k)) || typeof r.path !== 'string' || !r.path.trim() || !/^[a-f0-9]{64}$/.test(r.sha256)) || JSON.stringify(refs.map(refKey).sort(compare)) !== JSON.stringify(inputFiles.map(refKey).sort(compare))) reasons.push('Mapping approval must bind the exact current input file hashes.');
  }
  return reasons.length ? { status: 'unresolved', scopeId, reasons } : { status: 'approved', scopeId, decisionId: decision.id, decision: structuredClone(decision), reasons: [] };
}
function coverageByIdentity(report, source) {
  const result = new Map();
  if (report === undefined) return result;
  if (report?.schemaVersion !== 1 || report.captureIdentity !== 'rendering-variant') throw new Error('Coverage report must use the v3 rendering-variant capture identity');
  for (const requirement of list(report.requirements, 'coverage requirements')) {
    const id = canonicalId(requirement.renderingId), variant = requirement.variantId == null ? null : canonicalId(requirement.variantId), key = JSON.stringify([id, variant]);
    const rendering = source.renderings.find(r => canonicalId(r.renderingId) === id);
    if (!rendering || (variant !== null && !sourceMappingRequirements(source).some(r => canonicalId(r.renderingId) === id && r.variantId != null && canonicalId(r.variantId) === variant))) throw new Error('Coverage contains an unknown source rendering/variant identity');
    if (result.has(key)) throw new Error('Duplicate coverage rendering/variant identity');
    if (!['captured', 'mapping-only', 'target-absent', 'target-unverified', 'capture-failed', 'not-captured'].includes(requirement.status)) throw new Error('Unknown source coverage status');
    list(requirement.examples, 'coverage examples');
    result.set(key, requirement);
  }
  return result;
}

export function buildComponentMigrationPlan(sourceInventory, targetInventory, manifest, options = {}) {
  const source = validateSourceMappingInventory(sourceInventory), target = validateTargetRenderingInventory(targetInventory);
  const validated = validateComponentMappings(manifest, { sourceInventory: source, targetInventory: target });
  const inputFiles = validateInputFiles(options.inputFiles), scopeId = requiredText(options.scopeId ?? 'component-mappings', 'scopeId');
  const approval = approvalFor(options.decisions ?? [], inputFiles, scopeId);
  const coverage = coverageByIdentity(options.coverageReport, source);
  if (options.coverageReport !== undefined && !inputFiles.some(r => r.role === 'coverage') && approval.status === 'approved') throw new Error('Approved coverage must be bound by a coverage input file hash');
  const entries = sourceMappingRequirements(source).map(requirement => {
    const sourceRenderingId = canonicalId(requirement.renderingId), rendering = source.renderings.find(r => canonicalId(r.renderingId) === sourceRenderingId);
    const decision = validated.decisions.find(d => d.sourceRenderingId === sourceRenderingId && d.configurationKey === requirement.configurationKey) ?? validated.decisions.find(d => d.sourceRenderingId === sourceRenderingId && d.configurationKey === undefined);
    const confirmed = approval.status === 'approved' && decision?.confirmed === true;
    const variantId = requirement.variantId == null ? null : canonicalId(requirement.variantId);
    const sourceCoverage = coverage.get(JSON.stringify([sourceRenderingId, variantId]));
    const examples = sourceCoverage?.examples ?? [], sourceCoverageStatus = requirement.definitionOnly ? 'mapping-only' : sourceCoverage?.status ?? 'not-captured';
    const warnings = examples.flatMap(e => [...(e.reason ? [e.reason] : []), ...(e.warnings ?? [])]);
    if (!confirmed) warnings.push(decision ? 'Mapping decision requires current user approval and confirmation.' : 'An explicit source-to-target mapping decision is required.');
    if (sourceCoverageStatus !== 'captured') warnings.push(`Source coverage remains ${sourceCoverageStatus}.`);
    return {
      key: requirement.key, sourceRenderingId, sourceComponent: rendering.name, configurationKey: requirement.configurationKey, variantId, parameters: requirement.parameters ?? {}, definitionOnly: requirement.definitionOnly === true,
      action: confirmed ? decision.action : 'mapping-required', proposedAction: decision?.action ?? null, confirmed,
      ...(decision?.targetRenderingId ? { targetRenderingId: decision.targetRenderingId } : {}), ...(decision?.targetComponent ? { targetComponent: decision.targetComponent } : {}), ...(decision?.targetVariant ? { targetVariant: decision.targetVariant } : {}), ...(decision?.targetDatasourceTemplateId ? { targetDatasourceTemplateId: decision.targetDatasourceTemplateId } : {}), ...(decision?.rationale ? { rationale: decision.rationale } : {}),
      fieldMap: decision?.fieldMap ?? {}, parameterMap: decision?.parameterMap ?? {}, placeholderMap: decision?.placeholderMap ?? {}, datasourceMap: decision?.datasourceMap ?? {},
      sourceUsage: requirement.sourceUsage ?? rendering.usage?.status ?? 'unknown', sourceCoverageStatus,
      sourceOccurrences: requirement.sourceOccurrences ?? [], examples, routes: requirement.routes ?? [], warnings: [...new Set(warnings)].sort(compare),
    };
  });
  if (options.approvalEvidence !== undefined) validateApprovalEvidence(options.approvalEvidence);
  const body = { schemaVersion: 1, sourceFingerprint: source.fingerprint, targetInventoryFingerprint: target.fingerprint, inputFiles, ...(options.approvalEvidence ? { approvalEvidence: structuredClone(options.approvalEvidence) } : {}), approval, warnings: [...new Set([...(source.warnings ?? []), ...(options.coverageReport?.warnings ?? [])])].sort(compare), entries };
  return { ...body, fingerprint: sha256(JSON.stringify(body)) };
}

/** Local integrity and approval proof; filesystem consumers also verify each current input hash. */
function validateApprovalEvidence(ref) {
  exact(ref, ['path', 'sha256'], 'approval evidence');
  requiredText(ref.path, 'approval evidence path');
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Approval evidence sha256 must be a SHA-256 digest');
  return ref;
}
export function validateComponentMigrationPlan(plan, { requireApproval = false, currentInputs, currentDecisions, currentApprovalEvidence } = {}) {
  object(plan, 'component migration plan');
  const { fingerprint, ...body } = plan;
  if (plan.schemaVersion !== 1 || fingerprint !== sha256(JSON.stringify(body))) throw new Error('Component migration plan fingerprint is stale or invalid');
  const refs = validateInputFiles(plan.inputFiles);
  object(plan.approval, 'plan approval');
  const checked = approvalFor(plan.approval.decision ? [plan.approval.decision] : [], refs, plan.approval.scopeId);
  if (plan.approval.status === 'approved' && (checked.status !== 'approved' || checked.decisionId !== plan.approval.decisionId)) throw new Error('Component migration plan approval is invalid');
  if (requireApproval && plan.approval.status !== 'approved') throw new Error('Component migration plan requires current user approval');
  if (plan.approvalEvidence !== undefined) validateApprovalEvidence(plan.approvalEvidence);
  if (currentApprovalEvidence !== undefined && (!plan.approvalEvidence || refKey(validateApprovalEvidence(currentApprovalEvidence)) !== refKey(plan.approvalEvidence))) throw new Error('Component migration plan approval evidence is stale');
  if (currentDecisions !== undefined) {
    const current = approvalFor(currentDecisions, refs, plan.approval.scopeId);
    if (current.status !== 'approved' || JSON.stringify(current.decision) !== JSON.stringify(plan.approval.decision)) throw new Error('Component migration plan approval does not match current decisions');
  }
  if (currentInputs !== undefined && JSON.stringify(validateInputFiles(currentInputs)) !== JSON.stringify(refs)) throw new Error('Component migration plan inputs do not match current inputs');
  const keys = new Set();
  for (const entry of list(plan.entries, 'plan entries')) {
    if (keys.has(entry.key)) throw new Error('Duplicate plan entry');
    keys.add(requiredText(entry.key, 'entry key'));
    canonicalId(entry.sourceRenderingId);
    if (!['reuse-target', 'implement-missing', 'disregard', 'mapping-required'].includes(entry.action)) throw new Error('Unknown plan action');
    if ((entry.confirmed || entry.action !== 'mapping-required') && plan.approval.status !== 'approved') throw new Error('Unapproved plan cannot contain confirmed mapping actions');
  }
  return plan;
}
