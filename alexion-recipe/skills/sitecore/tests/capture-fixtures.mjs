import { sha256 } from '../scripts/capture/rendering-coverage.mjs';

export function fixture() {
  const page = { route: '/primary', itemId: '{AAAA}', itemPath: '/sitecore/content/Primary', language: 'en' };
  const alternative = { ...page, route: '/alternate', itemId: '{BBBB}', itemPath: '/sitecore/content/Alternate' };
  const body = { identity: 'rendering-variant', scope: 'approved', draft: false, selectedPages: [{ ...page, requirementKeys: ['hero:variant:large'] }], requirements: [{ key: 'hero:variant:large', renderingId: 'hero-id', renderingName: 'Hero', variantId: 'large', alternatives: [page, alternative] }], warnings: [] };
  return { schemaVersion: 1, fingerprint: sha256(JSON.stringify(body)), ...body };
}
export function seal(plan) {
  const { schemaVersion, fingerprint: _fingerprint, ...body } = plan;
  return { schemaVersion, fingerprint: sha256(JSON.stringify(body)), ...body };
}
export function layout({ variant = 'large', renderingId = 'hero-id', componentName = 'Hero', itemId = '{AAAA}', params = {} } = {}) {
  return { sitecore: { route: { itemId, placeholders: { root: [{ componentName: 'Container', placeholders: { main: [{ componentName, renderingId, uid: 'u1', params: { FieldNames: variant, ...params } }] } }] } } } };
}
