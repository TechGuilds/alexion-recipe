#!/usr/bin/env node
// Classifies the raw signals from probe-topology.ps1 into topology (XP/XM),
// role (CM/CD/Standalone/...), and Headless Services install state.
//
// Ported from historical b988214b4^:packages/kajoo-sitecore/src/topology/
// topology-classifier.ts — pure, no I/O beyond reading --input and writing
// stdout. Sitecore 9.0+ sources only (see probe-topology.ps1's header): the
// topology classifier's deployment-side signals are xConnect artifacts,
// which do not exist pre-9.0; a pre-9.0 XP source can be confidently
// misclassified as XM here, not just low-confidence. Do not use below 9.0.
import fs from 'node:fs';

const FIELDS = {
  KernelVersion: 'string?', RoleDefine: 'string?', SearchDefine: 'string?', EnvironmentType: 'string?',
  CmShellAppsPresent: 'boolean', CmContentEditorPresent: 'boolean', CmDesktopAspxPresent: 'boolean',
  CmLoginDirPresent: 'boolean', SwitchMasterToWebDir: 'boolean', SpeDirPresent: 'boolean',
  LicenseLicensee: 'string?', LicenseExpires: 'string?', LicenseModules: 'string', LicenseHasXdb: 'boolean',
  LicenseHasXmCloud: 'boolean', AnalyticsDllPresent: 'boolean', XConnectDllPresent: 'boolean',
  TrackingDllPresent: 'boolean', ProcessingDllPresent: 'boolean', MarketingOpsDllPresent: 'boolean',
  XConnectStringPresent: 'boolean', XConnectStringNames: 'string', XdbEnabled: 'boolean',
  HsLayoutServiceDll: 'boolean', HsServicesClientDll: 'boolean', HsJssDll: 'boolean', BaseDir: 'string?',
};

function parseArgs(args) {
  const o = { 'hs-http-probe-ok': false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hs-http-probe-ok') { o['hs-http-probe-ok'] = true; continue; }
    if (args[i] !== '--input' || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Expected --input FILE [--hs-http-probe-ok]');
    }
    if (o.input) throw new Error('Duplicate --input');
    o.input = args[++i];
  }
  if (!o.input) throw new Error('--input is required');
  return o;
}

function validateRaw(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object of raw topology-probe signals');
  }
  const keys = Object.keys(value);
  const expected = Object.keys(FIELDS);
  const missing = expected.filter((k) => !keys.includes(k));
  const unknown = keys.filter((k) => !expected.includes(k));
  if (missing.length) throw new Error('Missing fields: ' + missing.join(', '));
  if (unknown.length) throw new Error('Unknown fields: ' + unknown.join(', '));
  for (const [key, type] of Object.entries(FIELDS)) {
    const v = value[key];
    const ok = type === 'boolean' ? typeof v === 'boolean'
      : type === 'string' ? typeof v === 'string'
      : v === null || typeof v === 'string'; // string?
    if (!ok) throw new Error(`Field ${key} has the wrong type (expected ${type})`);
  }
  return value;
}

/**
 * XP vs XM. Combines license shape (LicenseHasXdb — matches older
 * Analytics/DMS-era module names too, not just xDB) with deployment shape
 * (XP-only DLLs + xConnect connection strings + Xdb.Enabled, all 9.0+
 * xConnect-era signals).
 *
 * - License XP + >=2 deployment signals -> XP, high confidence
 * - License XP + 0 deployment signals   -> XM, high confidence, mismatch
 *   (XP-licensed but XM-deployed; install XM package)
 * - License XM + 0 deployment signals   -> XM, high confidence
 * - License XP + 1 deployment signal    -> XP, medium confidence
 * - License XM + any XP DLLs            -> XM, low confidence, mismatch
 *   (manual review recommended)
 */
function classifyTopology(p) {
  const signals =
    Number(p.AnalyticsDllPresent) + Number(p.XConnectDllPresent) + Number(p.TrackingDllPresent) +
    Number(p.ProcessingDllPresent) + Number(p.MarketingOpsDllPresent) + Number(p.XConnectStringPresent) +
    Number(p.XdbEnabled);

  if (p.LicenseHasXdb && signals >= 2) return { topology: 'xp', confidence: 'high', mismatch: false };
  if (p.LicenseHasXdb && signals === 0) {
    return { topology: 'xm', confidence: 'high', mismatch: true, note: 'XP-licensed but XM-deployed; install XM package' };
  }
  if (!p.LicenseHasXdb && signals === 0) return { topology: 'xm', confidence: 'high', mismatch: false };
  if (p.LicenseHasXdb && signals === 1) {
    return { topology: 'xp', confidence: 'medium', mismatch: false, note: 'XP license with only one XP deployment signal; partial XP install possible' };
  }
  return { topology: 'xm', confidence: 'low', mismatch: true, note: 'XM license but XP DLLs found; manual review recommended' };
}

/**
 * CM/CD/Standalone/Processing/Reporting/XMCloud. Primary signal is the
 * `role:define` AppSetting (canonical on Sitecore 9.0+). SitecoreAI / XM
 * Cloud is checked first (most reliable signal, must not be shadowed by
 * generic role tokens in the same string), then falls back to
 * file-presence markers when the AppSetting is empty.
 */
function classifyRole(p) {
  const appSetting = (p.RoleDefine ?? '').toLowerCase();

  if (appSetting.includes('xmcloud')) return { role: 'xmcloud', confidence: 'high' };
  if (p.LicenseHasXmCloud) return { role: 'xmcloud', confidence: 'high' };
  if (appSetting.includes('contentmanagement')) return { role: 'cm', confidence: 'high' };
  if (appSetting.includes('contentdelivery')) return { role: 'cd', confidence: 'high' };
  if (appSetting.includes('standalone')) return { role: 'standalone', confidence: 'high' };
  if (appSetting.includes('processing')) return { role: 'processing', confidence: 'high' };
  if (appSetting.includes('reporting')) return { role: 'reporting', confidence: 'high' };
  if (p.SwitchMasterToWebDir) return { role: 'cd', confidence: 'medium' };
  if (p.CmShellAppsPresent && p.CmContentEditorPresent) return { role: 'cm-or-standalone', confidence: 'medium' };
  return { role: 'unknown', confidence: 'low' };
}

/**
 * Combines bin-anchor signals (DLLs on disk) with a caller-supplied HTTP
 * probe result (Layout Service responds 2xx — get one with
 * frontend-migration/scripts/probe-render.mjs against the Layout Service
 * base URL, or omit --hs-http-probe-ok to default false).
 */
function classifyHsInstall(p, httpProbeOk) {
  const hasAnyDll = p.HsLayoutServiceDll || p.HsServicesClientDll || p.HsJssDll;
  const hasAllCoreDlls = p.HsLayoutServiceDll && p.HsServicesClientDll;
  if (hasAllCoreDlls && httpProbeOk) return 'installed';
  if (hasAllCoreDlls && !httpProbeOk) return 'partial-or-misconfigured';
  if (hasAnyDll) return 'partial-install';
  return 'not-installed';
}

function classify(o) {
  const raw = validateRaw(JSON.parse(fs.readFileSync(o.input, 'utf8')));
  return {
    raw,
    topology: classifyTopology(raw),
    role: classifyRole(raw),
    hsInstall: classifyHsInstall(raw, o['hs-http-probe-ok']),
    kernelVersion: raw.KernelVersion,
  };
}

try {
  const result = classify(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 0;
} catch (e) {
  const error = e instanceof SyntaxError ? 'Invalid JSON input' : (e.code ? `Filesystem operation failed (${e.code})` : e.message);
  console.log(JSON.stringify({ error }));
  process.exitCode = 1;
}
