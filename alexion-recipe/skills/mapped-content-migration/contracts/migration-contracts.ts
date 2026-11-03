import type { Guid, SitecoreMapping, PlaceholderRef } from './sitecore-mapping';

/** Companion document version. The supplied raw SitecoreMapping stays unchanged. */
export type ContractVersion = 1;
export type Sha256 = string;
export interface DocumentHeader { version: ContractVersion; scopeId: string }
export interface ArtifactFile { path: string; sha256: Sha256 }
export interface MigrationInput extends DocumentHeader {
  mappingRevision: string;
  mapping: ArtifactFile;
  sourceSnapshot: ArtifactFile;
  targetInventory: ArtifactFile;
  destinationPlan: ArtifactFile;
  itemPlan?: ArtifactFile;
  identityMap?: ArtifactFile;
}

export type FieldStorage = 'shared' | 'unversioned' | 'versioned';
/** Raw Sitecore value; preserve empty string. Shared has no language/version;
 * unversioned has language only; versioned has both. Runtime checks enforce this. */
export interface FieldValue {
  fieldId: Guid;
  value: string;
  storage: FieldStorage;
  /** Verified source type metadata; absent legacy values need an approved compatibility decision. */
  fieldType?: string;
  language?: string;
  version?: number;
}
export interface ItemVersion { language: string; version: number }
export interface SourceReference {
  fieldId: Guid;
  kind: 'link' | 'list' | 'media' | 'datasource';
  /** Preserve list order. Includes unresolved/external IDs for later resolution. */
  targetSourceIds: Guid[];
  language?: string;
  version?: number;
}
export interface SourceItem {
  id: Guid;
  parentId: Guid;
  templateId: Guid;
  name: string;
  path: string;
  versions: ItemVersion[];
  fields: FieldValue[];
  references: SourceReference[];
}
/** Context for parameter-to-datasource moves. Not a presentation assignment. */
export interface RenderingInstance extends ItemVersion {
  instanceId: Guid;
  pageId: Guid;
  deviceId: Guid;
  renderingId: Guid;
  datasourceId?: Guid;
  parameterTemplateId?: Guid;
  parameters: FieldValue[];
}
export interface SourceSnapshot extends DocumentHeader {
  instanceId: string;
  database: string;
  capturedAt: string;
  rootPaths: string[];
  languages: string[];
  items: SourceItem[];
  renderingInstances: RenderingInstance[];
}

/** File selected by MigrationInput.sourceSnapshot may be a legacy SourceSnapshot
 * or this manifest. Content remains in bounded JSONL parts; consumers iterate them. */
export interface SnapshotManifest extends Omit<SourceSnapshot, 'items' | 'renderingInstances'> {
  format: 'source-snapshot-manifest';
  sourceStateId: string;
  preparedAt: string;
  complete: boolean;
  maxPartBytes: number;
  maxRecordsPerPart: number;
  itemCount: number;
  renderingInstanceCount: number;
  parts: (ArtifactFile & { bytes: number; itemCount: number; renderingInstanceCount: number })[];
  requestSha256: Sha256;
  provenance: (ArtifactFile & { format: string; sourceStateId: string; capturedAt: string; status: 'reused' | 'stale' | 'unsupported' | 'capture' })[];
}
export type SnapshotRecord = { kind: 'item'; data: SourceItem } | { kind: 'renderingInstance'; data: RenderingInstance };
export interface FieldRequirement {
  fieldId: Guid;
  storage: FieldStorage;
  fieldType?: string;
  /** Only used by the native Discovery adapter; ambiguous names are not reused. */
  name?: string;
  referenceKind?: SourceReference['kind'];
}
export interface ItemRequirement {
  id: Guid;
  path: string;
  templateId: Guid;
  versions: ItemVersion[];
  fields: FieldRequirement[];
  parentId?: Guid;
}
export interface ContextRequirement extends Omit<RenderingInstance, 'parameters'> { parameters: FieldRequirement[] }
export interface CaptureScope extends DocumentHeader {
  instanceId: string;
  database: string;
  /** Coordinator-confirmed source-state identity; not a server transaction token. */
  sourceStateId: string;
  rootPaths: string[];
  languages: string[];
  items: ItemRequirement[];
  renderingInstances: ContextRequirement[];
}
export interface SourceEvidence extends ArtifactFile {
  format: 'snapshot-json' | 'snapshot-manifest' | 'capture-jsonl' | 'discovery-items-jsonl' | 'discovery-summary';
  sourceStateId: string;
  capturedAt: string;
  scopeId: string;
  instanceId: string;
  database: string;
}
export interface PrepareSourceInput {
  version: ContractVersion;
  scope: CaptureScope;
  evidence: SourceEvidence[];
  maxPartBytes?: number;
  maxRecordsPerPart?: number;
  maxItemsPerCapture?: number;
  maxContextsPerCapture?: number;
}
export interface CaptureRequest { version: ContractVersion; requestId: string; scope: CaptureScope; maxResponseBytes: number }
export interface CaptureHeader extends DocumentHeader {
  instanceId: string; database: string; sourceStateId: string; requestId: string; capturedAt: string; valueMode: 'effective';
}
export interface CaptureCompletion { requestId: string; written: number; errors: number; partial: boolean; limited: boolean }
export interface ValidateSnapshotInput { version: ContractVersion; scope: CaptureScope; snapshot: ArtifactFile }
export interface TransformInput { version: ContractVersion; migrationInput: ArtifactFile; snapshotValidation: ArtifactFile }

/** Supplied through a verified target read mechanism; a missing lookup is not absence. */
export interface ObservedField extends Omit<FieldValue, 'value' | 'fieldType'> { present: boolean; value?: string }
export interface TargetObservation {
  id: Guid;
  templateId: Guid;
  path: string;
  versionsComplete: true;
  versions: ItemVersion[];
  fields: ObservedField[];
}
export type TargetLookup = { lookup: 'id' | 'path'; value: string } &
  ({ exists: false; item?: never } | { exists: true; item: TargetObservation });
export interface TargetState extends DocumentHeader {
  instanceId: string;
  database: string;
  capturedAt: string;
  /** Coordinator-confirmed cohort, not a Sitecore transaction or freshness proof. */
  targetStateId: string;
  rootPath: string;
  valueMode: 'effective';
  queries: TargetLookup[];
}
export interface PlanInput {
  version: ContractVersion;
  transformInput: ArtifactFile;
  itemPlan: ArtifactFile;
  identityMap: ArtifactFile;
  transformReport: ArtifactFile;
  targetState: ArtifactFile;
  maxItemsPerBatch?: number;
  maxBatchBytes?: number;
}
/** Replays the content plan with an immutable execution checkpoint and fresh observations. */
export interface ReferencePlanInput {
  version: ContractVersion;
  contentPlanInput: ArtifactFile;
  checkpoint: ArtifactFile;
  targetState: ArtifactFile;
  /** Exact approved external bindings only; TargetState rootPath must be /sitecore. */
  existingTargetState?: ArtifactFile;
  maxItemsPerBatch?: number;
  maxBatchBytes?: number;
}
export interface BatchOperation {
  operationId: string;
  kind: 'content' | 'folder';
  action: 'create' | 'update';
  targetItemId: Guid;
  targetPath: string;
  templateId: Guid;
  parentItemId: Guid;
  beforeFingerprint: Sha256;
  versionsToCreate: ItemVersion[];
  fields: FieldValue[];
  dependsOn: string[];
}
export interface BatchPlan extends DocumentHeader {
  mappingRevision: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  database: string;
  targetRootPath: string;
  targetStateId: string;
  targetCapturedAt: string;
  plannerRequestSha256: Sha256;
  inputs: Record<'transformInput' | 'itemPlan' | 'identityMap' | 'transformReport' | 'targetState', Sha256>;
  ready: boolean;
  reviewOnly: true;
  maxItemsPerBatch: number;
  maxBatchBytes: number;
  preconditions: { targetItemId: Guid; targetPath: string; parentPath: string; beforeFingerprint: Sha256 | null }[];
  batches: { batchId: string; operations: BatchOperation[] }[];
  referencesPending: boolean;
}

export interface TargetField {
  id: Guid;
  name: string;
  declaringTemplateId: Guid;
  type: string;
  storage: FieldStorage;
}
export interface TargetTemplate {
  id: Guid;
  name: string;
  path: string;
  kind: 'content' | 'datasource' | 'parameters' | 'folder' | 'branch';
  /** Complete transitive base-template IDs; fields includes inherited fields. */
  baseTemplateIds: Guid[];
  fields: TargetField[];
}
export interface TargetItem { id: Guid; templateId: Guid; path: string }
export interface TargetRendering {
  id: Guid;
  name: string;
  path: string;
  datasourceTemplateId?: Guid;
  parameterTemplateId?: Guid;
}
export interface TargetInventory extends DocumentHeader {
  instanceId: string;
  database: string;
  capturedAt: string;
  rootPaths: string[];
  templates: TargetTemplate[];
  items: TargetItem[];
  renderings: TargetRendering[];
  placeholders: PlaceholderRef[];
}

export interface DestinationRule {
  sourceTemplateId: Guid;
  targetTemplateId: Guid;
  /** Stable output role, e.g. page, banner-data, cta-data. Not a template name. */
  outputKey: string;
  kind: 'page' | 'datasource' | 'folder' | 'parameters';
  scope: 'page' | 'page-local' | 'global' | 'rendering-instance';
  identity: 'source-item' | 'source-item-and-page' | 'rendering-instance';
  /** Required for items, forbidden for parameters. No executable expressions. */
  pathPattern?: string;
  folderRuleKey?: string;
  branchId?: Guid;
  existingItem: 'create-only' | 'reuse' | 'update';
  collision: 'block';
}
export interface FolderRule {
  key: string;
  /** Ordered segments relative to the local page or global parent. */
  segments: { name: string; templateId: Guid }[];
}
export interface ReferenceRule {
  /** The referencing source item's template and field. */
  sourceTemplateId: Guid;
  sourceFieldId: Guid;
  /** Output role to choose on the referenced source item if it splits. */
  targetOutputKey: string;
}
export interface DestinationPlan extends DocumentHeader {
  targetRootPath: string;
  rules: DestinationRule[];
  folders: FolderRule[];
  referenceRules: ReferenceRule[];
  exclusions: { sourceItemId: Guid; reason: string }[];
  fieldCompatibility?: FieldCompatibilityDecision[];
  ownershipRules?: OwnershipRule[];
  existingReferenceTargets?: ExistingReferenceTarget[];
}
/** Approved binding to an existing target; never authorizes writing that item. */
export interface ExistingReferenceTarget {
  sourceItemId: Guid;
  targetItemId: Guid;
  targetPath: string;
  templateId: Guid;
}
export type OwnershipRule = { sourceItemId: Guid } & (
  { via: 'source-ancestor'; ancestorItemId: Guid } |
  { via: 'source-reference'; ownerItemId: Guid; fieldId: Guid } |
  { via: 'explicit-pages'; pageIds: Guid[] }
);
export interface FieldCompatibilityDecision {
  sourceTemplateId: Guid; sourceFieldId: Guid; targetTemplateId: Guid; targetFieldId: Guid;
  sourceType: string; targetType: string; decision: 'raw-compatible'; reason: string;
}

export interface InputBinding {
  mapping: Sha256;
  sourceSnapshot: Sha256;
  targetInventory: Sha256;
  destinationPlan: Sha256;
}
export interface ItemIdentity {
  /** Captured item ID; for parameter-generated items use occurrence UID plus
   * the full context below to distinguish occurrences across devices/versions. */
  sourceItemId: Guid;
  outputKey: string;
  targetItemId: Guid;
  targetPath: string;
  pageId?: Guid;
  renderingInstanceId?: Guid;
  deviceId?: Guid;
  language?: string;
  version?: number;
}
export interface IdentityMap extends DocumentHeader {
  mappingRevision: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  entries: ItemIdentity[];
}
export interface TargetRelationship {
  fieldId: Guid;
  language?: string;
  version?: number;
  targets: ItemIdentity[];
}
export interface PlannedItem {
  identity: ItemIdentity;
  templateId: Guid;
  action: 'create' | 'update' | 'reuse' | 'exclude' | 'conflict';
  fields: FieldValue[];
  relationships: TargetRelationship[];
  versions?: ItemVersion[];
  parentPath?: string;
}
/** Structural folders are not source template outputs or successful writes. */
export interface PlannedStructure {
  targetPath: string;
  targetItemId: Guid;
  templateId: Guid;
  parentPath: string;
  action: 'create' | 'reuse';
}
export interface ItemPlan extends DocumentHeader {
  mappingRevision: string;
  inputs: InputBinding;
  items: PlannedItem[];
  structures?: PlannedStructure[];
  issues: { code: string; message: string; severity: 'warning' | 'error' }[];
}
export interface MigrationDocuments {
  mapping: SitecoreMapping;
  sourceSnapshot: SourceSnapshot;
  targetInventory: TargetInventory;
  destinationPlan: DestinationPlan;
  itemPlan?: ItemPlan;
  identityMap?: IdentityMap;
}

/** Existing CMS decision shape narrowed to an explicit, hash-bound mutation approval. */
export interface ExecutionDecision {
  id: string;
  kind: 'mutation';
  scopeId: string;
  taskId: string;
  entityId?: string;
  choice: 'approve';
  rationale: string;
  userResponse: string;
  at: string;
  inputs: ArtifactFile[];
}
export interface ExecutionTarget {
  instanceId: string;
  database: string;
  rootPath: string;
  connectorId: string;
  marker: TargetItem;
}
/** Journal initialization scope has no document version; the checkpoint adds it. */
export interface ExecutionScope {
  scopeId: string;
  targetInstanceId: string;
  database: string;
  rootPath: string;
  connectorId: string;
}
export interface ExecutionCapabilities extends DocumentHeader {
  instanceId: string;
  database: string;
  rootPath: string;
  connectorId: string;
  marker: TargetItem;
  evidence: ArtifactFile;
  expiresAt: string;
  verifiedAt?: string;
  maxRequestBytes: number;
  maxBackupBytes: number;
  maxJournalBytes: number;
  speRead: true;
  speWrite: true;
  fullItemBackup: true;
  restoreValidated: true;
  exclusiveWriteWindow: true;
  fileDownload: true;
  journalContinuityVerified: true;
}
export type ExecutionInput = {
  version: ContractVersion;
  /** Absence retains content execution behavior. */
  operationKind?: ExecutionOperationKind;
  contentMigrationMode: 'mapped-content';
  taskId: string;
  /** Omitted for canonical empty plans, which produce no execution request. */
  batchId?: string;
  structuralLanguage: string;
  planInput: ArtifactFile;
  batchPlan: ArtifactFile;
  dryRun: ArtifactFile;
  targetState: ArtifactFile;
  capabilities: ArtifactFile;
  /** Fresh observations of approved existing reference targets, rooted at /sitecore. */
  existingTargetState?: ArtifactFile;
} & ({ approval: ArtifactFile; review: ArtifactFile } | { approval?: never; review?: never });
export interface ExecutionOperation extends BatchOperation { expectedPost: TargetObservation }
export type ExecutionOperationKind = 'content' | 'references';
export interface ReferenceBinding extends ExistingReferenceTarget {
  /** Present for migrated/reused identities; absent for explicit existing bindings. */
  identity?: ItemIdentity;
  existing: boolean;
}
/** Exact immutable bytes reviewed by the user before a remote request is reserved. */
export interface ExecutionReview extends DocumentHeader {
  contentMigrationMode: 'mapped-content';
  operationKind?: ExecutionOperationKind;
  mappingRevision: string;
  taskId: string;
  batchPlanSha256: Sha256;
  batchId: string;
  scriptSha256: Sha256;
  sourceInstanceId: string;
  target: ExecutionTarget;
  structuralLanguage: string;
  maxBackupBytes: number;
  maxJournalBytes: number;
  maxRequestBytes: number;
  capabilities: ExecutionCapabilities;
  inputs: Record<'planInput' | 'batchPlan' | 'dryRun' | 'targetState' | 'capabilities', Sha256> & { existingTargetState?: Sha256 };
  checkpointSha256: Sha256;
  guards: TargetLookup[];
  referenceGuards?: TargetLookup[];
  referenceBindings?: ReferenceBinding[];
  operations: ExecutionOperation[];
  knownSuccess: ExecutionReused[];
  templates: (Omit<TargetTemplate, 'kind'> & { kind: 'content' | 'datasource' | 'folder' })[];
  identities: ItemIdentity[];
}
export interface ExecutionRemoteFile {
  /** Path below the selected target instance's Sitecore DataFolder. */
  path: string;
  sha256: Sha256;
  bytes: number;
}
export interface ExecutionResultIdentity {
  operationId: string;
  targetItemId: Guid;
  targetPath: string;
  templateId: Guid;
}
export type ExecutionResult = ExecutionResultIdentity & (
  { status: 'success'; mutated: boolean; post: TargetObservation; message?: string } |
  { status: 'failed'; mutated: boolean; post?: TargetObservation; message?: string } |
  { status: 'skipped'; mutated: false; post?: never; message?: string }
);
export interface ExecutionReused extends ExecutionResultIdentity { post: TargetObservation }
export interface ExecutionBackup {
  operationId: string;
  targetItemId: Guid;
  files: ExecutionRemoteFile[];
}
/** Terminal remote evidence. Success still requires exact postcondition reconciliation. */
export interface ExecutionReceipt extends DocumentHeader {
  kind: 'mapped-content-execution';
  requestId: string;
  reviewSha256: Sha256;
  taskId: string;
  batchPlanSha256: Sha256;
  batchId: string;
  target: ExecutionTarget;
  terminal: true;
  status: 'success' | 'partial' | 'failed' | 'blocked';
  backups: ExecutionBackup[];
  results: ExecutionResult[];
  reused: ExecutionReused[];
  journal: ExecutionRemoteFile;
  message?: string;
}
export type ExecutionCheckpointOperation = ExecutionResult & {
  operationKind?: ExecutionOperationKind;
  requestId: string;
  batchPlanSha256: Sha256;
  batchId: string;
};
export interface ExecutionIdentity {
  identity: ItemIdentity;
  status: 'success' | 'partial' | 'reused';
  requestId: string;
  batchPlanSha256: Sha256;
  mappingRevision: string;
}
export type ExecutionActive = {
  requestId: string;
  reviewSha256: Sha256;
  batchPlanSha256: Sha256;
  batchId: string;
  operationIds: string[];
  envelopeSha256: Sha256 | null;
} & ({ state: 'reserved' | 'unknown'; jobId: string | null } | { state: 'submitted'; jobId: string });
export interface ExecutionCheckpoint extends ExecutionScope {
  version: ContractVersion;
  sequence: number;
  previousSha256: Sha256 | null;
  active: ExecutionActive | null;
  completedBatches: { batchPlanSha256: Sha256; batchId: string; requestId: string }[];
  operations: ExecutionCheckpointOperation[];
  identities: ExecutionIdentity[];
}
export type ExecutionEvent =
  { version: ContractVersion; action: 'initialize'; scope: ExecutionScope } |
  ({ version: ContractVersion; checkpointSha256: Sha256; requestId: string; connectorId: string } & (
    { action: 'submitted'; jobId: string } |
    { action: 'unknown'; jobId?: string } |
    { action: 'terminal'; terminal: true; jobId: string; review: ArtifactFile; receipt: ArtifactFile }
  ));

/** Independent source-led content verification; execution history remains immutable. */
export interface VerificationInput {
  version: ContractVersion;
  contentPlanInput: ArtifactFile;
  checkpoint: ArtifactFile;
  capabilities: ArtifactFile;
  structuralLanguage: string;
  readbackId: string;
  readbacks: ArtifactFile[];
  maxQueriesPerRequest?: number;
}
export interface VerificationReadCapabilities {
  speRead: true;
  fileDownload: true;
  stableReadWindow: true;
  verifiedAt: string;
  expiresAt: string;
  maxCaptureBytes: number;
  maxRequestBytes: number;
}
export interface VerificationCapabilities extends DocumentHeader, VerificationReadCapabilities {
  instanceId: string;
  database: string;
  rootPath: string;
  connectorId: string;
  marker: TargetItem;
  evidence: ArtifactFile;
}
/** Exact selectors only; field metadata is observed independently at capture time. */
export interface VerificationFieldRequirement {
  fieldId: Guid;
  storage: FieldStorage;
  language?: string;
  version?: number;
}
export interface VerificationQuery {
  lookup: 'id' | 'path';
  value: string;
  fields: VerificationFieldRequirement[];
}
export interface VerificationRequest extends DocumentHeader {
  requestId: string;
  expectedSha256: Sha256;
  collectorSha256: Sha256;
  readbackId: string;
  target: ExecutionTarget;
  capabilities: VerificationReadCapabilities;
  queries: VerificationQuery[];
  maxBytes: number;
}
export type VerificationObservedField = Omit<ObservedField, 'present' | 'value'> & (
  { present: true; value: string; fieldType: string } |
  { present: false; value?: never; fieldType?: string }
);
export interface VerificationObservation extends Omit<TargetObservation, 'fields'> {
  parentId: Guid;
  fields: VerificationObservedField[];
}
export type VerificationLookup = { lookup: 'id' | 'path'; value: string } & (
  { exists: false; item?: never } | { exists: true; item: VerificationObservation }
);
export interface VerificationState extends DocumentHeader {
  instanceId: string;
  database: string;
  rootPath: '/sitecore';
  targetStateId: string;
  capturedAt: string;
  valueMode: 'effective';
  requestId: string;
  requestSha256: Sha256;
  collectorSha256: Sha256;
  expectedSha256: Sha256;
  complete: boolean;
  errors: { lookup: 'id' | 'path'; value: string; message: string }[];
  queries: VerificationLookup[];
}
export interface VerificationDifference {
  code: string;
  message: string;
  fieldId?: Guid;
  language?: string;
  version?: number;
}
export interface VerificationItemResult {
  kind: 'content' | 'folder';
  targetItemId: Guid;
  targetPath: string;
  templateId: Guid;
  sourceItemId?: Guid;
  status: 'success' | 'reused' | 'failed' | 'unverified';
  differences: VerificationDifference[];
}
export interface VerificationReport extends DocumentHeader {
  ready: boolean;
  contentParity: boolean;
  requiresUserConfirmation: true;
  expectedSha256: Sha256;
  verificationInputSha256: Sha256;
  checkpointSha256: Sha256;
  readbackId: string;
  summary: Record<'success' | 'reused' | 'failed' | 'unverified' | 'excluded', number>;
  items: VerificationItemResult[];
  exclusions: { sourceItemId: Guid; reason: string }[];
  executionOutcomes: {
    operationId: string; targetItemId: Guid; status: 'success' | 'failed' | 'skipped';
    mutated: boolean; operationKind?: ExecutionOperationKind; requestId: string;
  }[];
  issues: { code: string; message: string; targetPath?: string }[];
  gaps: { lookup: 'id' | 'path'; value: string; requestId: string }[];
  readRequestCount: number;
  completedRequestCount: number;
  boundaries: {
    presentationVerified: false; visualVerified: false; mediaBinariesVerified: false;
    unrelatedItemsEnumerated: false; workflowAdvanced: false;
  };
  deferredParameters: Record<string, unknown>[];
}

/** Produces a reviewable proposal without approving or materializing it. */
export interface WorkflowInput extends DocumentHeader {
  activeWorkflow: ArtifactFile;
  inventory: ArtifactFile;
  mappings: ArtifactFile;
  planningTaskId: string;
  evidence: ArtifactFile[];
  modeDecision: ArtifactFile;
  mappingDecision: ArtifactFile;
  mediaDecision: ArtifactFile;
}

/** Postflight validation binds a CMS task packet to exact operation outputs. */
export interface MappedOutcomeInput {
  version: ContractVersion;
  packet: ArtifactFile;
  outputs: (ArtifactFile & { role: string })[];
}
