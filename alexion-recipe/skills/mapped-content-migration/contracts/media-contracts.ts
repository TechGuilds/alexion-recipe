/** Media stays outside the transformed-content item plan and execution journal. */
export interface MediaArtifact { path: string; sha256: string }
export interface MediaPlatform {
  instanceId: string; connectorId: string; database: 'master'; deployment: 'XP' | 'XM';
  rootPath: '/sitecore/media library'; marker: { id: string; path: string; templateId: string };
}
export interface MediaSelector { path: string; includeDescendants: boolean }
export interface MediaScope {
  kind: 'media-scope'; version: 1; scopeId: string; source: MediaPlatform; target: MediaPlatform;
  selectors: MediaSelector[]; maxPackageBytes: 100000000;
}
export interface MediaItem {
  id: string; path: string; templateId: string; parentId: string; isFolder: boolean;
  /** Raw metadata excluding volatile audit/lock fields and Blob; empty language/version 0 denotes shared storage. */
  fields: { id: string; language: string; version: number; value: string }[];
  /** Original stream observations for each actual language/version. */
  blobs: { language: string; version: number; bytes: number; sha256: string }[];
}
export interface MediaInventory {
  kind: 'media-inventory'; version: 1; scopeId: string; target: MediaPlatform;
  capturedAt: string; expiresAt: string; requestId: string; requestSha256: string; complete: true;
  selectors?: MediaSelector[]; sourceInventorySha256?: string; items: MediaItem[];
  missingIds: string[]; collisions: { expectedId: string; observedId: string; path: string }[];
  unresolvedOperations: { operationId: string; status: string }[];
}
export interface MediaPackage {
  id: string; path: string; serverPath: string; order: number; bytes: number; sha256: string; itemIds: string[];
}
export interface MediaManifest {
  kind: 'media-package-manifest'; version: 1; scopeId: string; source: MediaPlatform;
  sourceInventorySha256: string; requestId: string; requestSha256: string; completedAt: string; maxPackageBytes: 100000000;
  items: MediaItem[]; packages: MediaPackage[];
}
export interface MediaCapabilities {
  speRead: true; fileTransfer: true; stableReadWindow: true; verifiedAt: string; expiresAt: string;
  updatePackages?: true; binaryRoundTripVerified?: true; restoreVerified?: true;
  exclusiveWriteWindow?: true; pilotSha256?: string;
}
export interface MediaInput {
  version: 1; action: 'capture' | 'prepare' | 'install' | 'verify'; scopeId: string; attemptId: string;
  taskId: 'content.media-prepare' | 'content.media-install';
  scopeArtifact: MediaArtifact; mediaDecision: MediaArtifact; scopeDecision: MediaArtifact;
  capabilities: MediaCapabilities;
  sourceInventory?: MediaArtifact; sourceCaptureRequest?: MediaArtifact;
  packageManifest?: MediaArtifact; packageFiles?: (MediaArtifact & { packageId: string })[];
  packageTransports?: MediaPackage[]; packageId?: string;
  targetInventory?: MediaArtifact; inspectionRequest?: MediaArtifact;
  review?: MediaArtifact; approval?: MediaArtifact;
  verificationInventory?: MediaArtifact; verificationRequest?: MediaArtifact;
  receipts?: { request: MediaArtifact; receipt: MediaArtifact }[];
}
export interface MediaReport {
  version: 1; scopeId: string; taskId: string; ready: boolean; targetWrites: false;
  workflowAdvanced: false; maxPackageBytes: 100000000; issues: string[]; inputSha256?: string;
  mediaManifestSha256?: string; sourceInventorySha256?: string; packageCount?: number;
  mediaParity?: boolean; target?: MediaPlatform; verificationInventorySha256?: string;
  items?: { id: string; action: 'create' | 'update' | 'reuse' | 'conflict' }[];
  identities?: { sourceItemId: string; targetItemId: string; path: string; templateId: string }[];
  limitations?: string[];
}
