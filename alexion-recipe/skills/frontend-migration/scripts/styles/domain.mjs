// Pure domain overlays; no filesystem or runtime dependencies.
export { mergeMvcStyleReferences } from './mvc.mjs';
export {
  extractHeadlessStyleReferences,
  overlayHeadlessStyleReferences,
  classifyHeadlessOrigin,
  isHeadlessLicenseSuspected,
} from './headless.mjs';
export { overlayHeadlessStyleReferences as mergeHeadlessStyleReferences } from './headless.mjs';
