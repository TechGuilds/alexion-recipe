#!/usr/bin/env node
// Filters probe-sites.ps1's raw site list down to real, user-facing
// candidates and shapes it for the operator/agent to pick from.
//
// Ported from historical b988214b4^:packages/kajoo-sitecore/src/sites/
// {sites-classifier,enumerate-sites}.ts. Kept deliberately separate from
// the remote probe (same split the original used) so the system-site
// exclusion list stays small, reviewable and independently testable.
import fs from 'node:fs';

// Sitecore ships ~12 system/chrome sites under the same Factory the
// user-facing sites live in. They surface in GetSiteNames() regardless of
// deployment shape and are NEVER valid migration targets.
//
// Source: App_Config\Sitecore.config and App_Config\Include\*.config
// cross-checked against a clean Sitecore 10.4 install. Names match the
// literal <site name="..."> value, case-insensitively (Factory.GetSiteNames()
// returns them lower-cased on every version probed).
const SYSTEM_SITE_NAMES = [
  'shell', 'login', 'admin', 'service', 'modules_shell', 'modules_website',
  'scheduler', 'system', 'publisher', 'testing',
  // Headless Services and SXA add a few of their own — strip them too so a
  // partially-converted XP MVC source doesn't surface them as candidates.
  'preview', 'speak',
];
const SYSTEM_SITE_SET = new Set(SYSTEM_SITE_NAMES.map((n) => n.toLowerCase()));

function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--input' || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Expected --input FILE');
    }
    if (o.input) throw new Error('Duplicate --input');
    o.input = args[++i];
  }
  if (!o.input) throw new Error('--input is required');
  return o;
}

function stringOrNull(v) { return v === null || typeof v === 'string'; }
function stringArray(v) { return Array.isArray(v) && v.every((x) => typeof x === 'string'); }

function validateSite(entry, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`sites[${index}] is not an object`);
  }
  const keys = Object.keys(entry);
  const expected = ['name', 'rootPath', 'startItem', 'hostName', 'availableLanguages'];
  const unknown = keys.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`sites[${index}] has unknown fields: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`sites[${index}] is missing fields: ${missing.join(', ')}`);
  if (typeof entry.name !== 'string') throw new Error(`sites[${index}].name must be a string`);
  if (!stringOrNull(entry.rootPath)) throw new Error(`sites[${index}].rootPath must be a string or null`);
  if (!stringOrNull(entry.startItem)) throw new Error(`sites[${index}].startItem must be a string or null`);
  if (!stringOrNull(entry.hostName)) throw new Error(`sites[${index}].hostName must be a string or null`);
  if (!stringArray(entry.availableLanguages)) throw new Error(`sites[${index}].availableLanguages must be a string array`);
  return entry;
}

function validateRaw(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object with { sites, availableLanguages }');
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((k) => !['sites', 'availableLanguages'].includes(k));
  if (unknown.length) throw new Error(`Unknown top-level fields: ${unknown.join(', ')}`);
  if (!Array.isArray(value.sites)) throw new Error('sites must be an array');
  if (!stringArray(value.availableLanguages ?? [])) throw new Error('availableLanguages must be a string array');
  value.sites.forEach(validateSite);
  return value;
}

/**
 * Pure filter: drops system/chrome sites, dedupes by case-insensitive
 * trimmed name, and shapes the rest into the operator-facing form. Order
 * is preserved (Factory order) — typically primary site first.
 */
function filterUserSites(sites) {
  const seen = new Set();
  const out = [];
  for (const entry of sites) {
    const trimmed = entry.name.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (SYSTEM_SITE_SET.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: trimmed,
      displayName: trimmed,
      rootPath: entry.rootPath,
      startItem: entry.startItem,
      availableLanguages: [...entry.availableLanguages].sort((a, b) => a.localeCompare(b)),
    });
  }
  return out;
}

function run(o) {
  const raw = validateRaw(JSON.parse(fs.readFileSync(o.input, 'utf8')));
  const list = filterUserSites(raw.sites);
  return {
    verdict: 'ready',
    list,
    availableLanguages: [...new Set(raw.availableLanguages)].sort((a, b) => a.localeCompare(b)),
  };
}

try {
  const result = run(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 0;
} catch (e) {
  const error = e instanceof SyntaxError ? 'Invalid JSON input' : (e.code ? `Filesystem operation failed (${e.code})` : e.message);
  console.log(JSON.stringify({ verdict: 'unknown', list: [], error }));
  process.exitCode = 1;
}
