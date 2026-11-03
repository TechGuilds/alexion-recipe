/** JSON Schema is the runtime authority; these types document CLI handoffs. */
export interface ArtifactRef {
  path: string;
  sha256: string;
}
export interface CompositionInput {
  version: 1;
  scopeId: string;
  source: ArtifactRef;
  target: ArtifactRef;
  mapping: ArtifactRef;
  rules: ArtifactRef;
  identities: ArtifactRef;
  targetData: ArtifactRef;
  mappingApproval: ArtifactRef;
}
export interface PreviewInput {
  version: 1;
  scopeId: string;
  compositionInput: ArtifactRef;
  compositionPlan: ArtifactRef;
  minimumPages: number;
}
export interface PreviewReviewInput {
  version: 1;
  taskId: string;
  scopeId: string;
  previewInput: ArtifactRef;
  previewManifest: ArtifactRef;
  decisions: ArtifactRef[];
  browserEvidence: ArtifactRef[];
}
export interface PreviewInstallInput {
  version: 1;
  scopeId: string;
  taskId: string;
  previewInput: ArtifactRef;
  previewManifest: ArtifactRef;
  targetRoot: string;
  foundationEvidence: ArtifactRef;
  review?: ArtifactRef;
  approval?: ArtifactRef;
}
export interface TargetMarker {
  id: string;
  templateId: string;
  path: string;
}
export interface ApplicationTarget {
  instanceId: string;
  database: string;
  connectorId: string;
  rootPath: string;
  marker: TargetMarker;
}
export interface ApplicationProfile {
  version: 1;
  scopeId: string;
  target: ApplicationTarget;
  sourceRoots: string[];
  partialFolder: TargetMarker;
  pageFolder: TargetMarker;
  partialTemplateId: string;
  pageTemplateId: string;
  partialLayoutId: string;
  pageDesignLayoutField: 'Layout' | null;
  placeholderPaths: { owner: string; uid: string; path: string }[];
  evidence: ArtifactRef[];
}
export interface ApplicationCapabilities {
  version: 1;
  scopeId: string;
  instanceId: string;
  database: string;
  connectorId: string;
  verifiedAt: string;
  expiresAt: string;
  speRead: true;
  stableReadWindow: true;
  fileDownload: true;
  speWrite: boolean;
  fullItemBackup: boolean;
  restoreValidated: boolean;
  exclusiveWriteWindow: boolean;
  journalContinuityVerified: boolean;
  layoutRoundtripValidated: boolean;
  authoringDatabaseValidated: boolean;
  maxRequestBytes: number;
  maxCaptureBytes: number;
  maxBackupBytes: number;
  maxJournalBytes: number;
  maxReadItems: number;
  maxContexts: number;
  evidence: ArtifactRef[];
}
export interface ApplicationInput {
  version: 1;
  scopeId: string;
  taskId: string;
  reviewInputs: ArtifactRef[];
  profile: ArtifactRef;
  capabilities: ArtifactRef;
  targetState?: ArtifactRef;
  maxOperationsPerBatch?: number;
}
export interface PresentationWriteInput {
  version: 1;
  scopeId: string;
  taskId: string;
  applicationInput: ArtifactRef;
  applicationPlan: ArtifactRef;
  batchId: string;
  currentState: ArtifactRef;
  journalDirectory: string;
  review?: ArtifactRef;
  approval?: ArtifactRef;
}
export interface PresentationEvent {
  version: 1;
  action: 'initialize' | 'submitted' | 'unknown' | 'terminal';
  scopeId: string;
  journalDirectory: string;
  target?: ApplicationTarget;
  expectedHeadSha256?: string;
  requestId?: string;
  connectorId?: string;
  jobId?: string;
  review?: ArtifactRef;
  receipt?: ArtifactRef;
  backups?: ArtifactRef[];
}
export interface ApplicationAuditInput {
  version: 1;
  scopeId: string;
  applicationInput: ArtifactRef;
  applicationPlan: ArtifactRef;
  journalDirectory: string;
  targetState: ArtifactRef;
}
export interface WorkflowInput {
  version: 1;
  scopeId: string;
  planningTaskId: string;
  activeWorkflow: ArtifactRef;
  inventory: ArtifactRef;
  mappings: ArtifactRef;
  mappingDecision: ArtifactRef;
  evidence: ArtifactRef[];
  prerequisiteTaskIds: string[];
}
export interface OperationArtifact extends ArtifactRef {
  role: string;
}
export interface OutcomeInput {
  version: 1;
  packet: ArtifactRef;
  outputs: OperationArtifact[];
}
export interface WebsiteVerificationInput {
  version: 1;
  scopeId: string;
  taskId: string;
  applicationAuditInput: ArtifactRef;
  targetCapture: ArtifactRef;
  minimumPages: number;
  requiredChecks: string[];
  browserEvidence: ArtifactRef[];
  decisions: ArtifactRef[];
  additionalContextInputs?: ArtifactRef[];
}
export interface WebsiteTarget {
  instanceId: string;
  database: string;
  stateId: string;
  siteName: string;
  language: string;
  itemVersion: number;
  deviceId: string;
}
export interface WebsiteContext {
  previewManifestSha256: string;
  target: WebsiteTarget;
}
export interface WebsiteContextResult extends WebsiteContext {
  targetCaptureSha256: string;
  ready: boolean;
  verifiedPageIds: string[];
  untestedPageIds: string[];
  covered: string[];
  missing: string[];
}
export interface WebsiteVerificationReport {
  version: 1;
  kind: 'target-website-verification';
  scopeId: string;
  taskId: string;
  ready: boolean;
  applicationPlanSha256: string;
  previewManifestSha256: string;
  targetCaptureSha256: string;
  verifiedPageIds: string[];
  untestedPageIds: string[];
  covered: string[];
  missing: string[];
  issues: string[];
  limitations: string[];
  contexts: WebsiteContextResult[];
  untestedContexts: WebsiteContext[];
  targetWrites: false;
  workflowAdvanced: false;
}
