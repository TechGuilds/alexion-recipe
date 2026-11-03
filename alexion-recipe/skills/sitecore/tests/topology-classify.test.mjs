import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/setup/classify-topology.mjs', import.meta.url));

const BASE_RAW = {
  KernelVersion: '10.4.1.012149', RoleDefine: null, SearchDefine: 'Solr', EnvironmentType: 'Non-Production',
  CmShellAppsPresent: false, CmContentEditorPresent: false, CmDesktopAspxPresent: false,
  CmLoginDirPresent: false, SwitchMasterToWebDir: false, SpeDirPresent: true,
  LicenseLicensee: 'Acme', LicenseExpires: '2099-01-01', LicenseModules: '', LicenseHasXdb: false,
  LicenseHasXmCloud: false, AnalyticsDllPresent: false, XConnectDllPresent: false,
  TrackingDllPresent: false, ProcessingDllPresent: false, MarketingOpsDllPresent: false,
  XConnectStringPresent: false, XConnectStringNames: '', XdbEnabled: false,
  HsLayoutServiceDll: false, HsServicesClientDll: false, HsJssDll: false, BaseDir: 'C:\\inetpub\\wwwroot',
};

function raw(overrides) {
  return { ...BASE_RAW, ...overrides };
}

function run(rawSignals, ...extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-'));
  const file = path.join(dir, 'raw.json');
  fs.writeFileSync(file, JSON.stringify(rawSignals));
  try {
    const p = spawnSync(process.execPath, [script, '--input', file, ...extraArgs], { encoding: 'utf8' });
    return { code: p.status, data: p.stdout ? JSON.parse(p.stdout) : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('topology: XP license + >=2 deployment signals is high-confidence XP', () => {
  const p = run(raw({ LicenseHasXdb: true, XConnectDllPresent: true, XConnectStringPresent: true }));
  assert.equal(p.code, 0);
  assert.deepEqual(p.data.topology, { topology: 'xp', confidence: 'high', mismatch: false });
});

test('topology: XP license + zero deployment signals is XM with a mismatch flag', () => {
  const p = run(raw({ LicenseHasXdb: true }));
  assert.equal(p.code, 0);
  assert.equal(p.data.topology.topology, 'xm');
  assert.equal(p.data.topology.confidence, 'high');
  assert.equal(p.data.topology.mismatch, true);
  assert.match(p.data.topology.note, /XP-licensed but XM-deployed/);
});

test('topology: no xDB license and zero deployment signals is clean XM', () => {
  const p = run(raw({}));
  assert.deepEqual(p.data.topology, { topology: 'xm', confidence: 'high', mismatch: false });
});

test('topology: XP license + exactly one deployment signal is medium-confidence XP', () => {
  const p = run(raw({ LicenseHasXdb: true, XdbEnabled: true }));
  assert.equal(p.data.topology.topology, 'xp');
  assert.equal(p.data.topology.confidence, 'medium');
  assert.equal(p.data.topology.mismatch, false);
});

test('topology: XM license with XP DLLs present is low-confidence XM with a mismatch flag', () => {
  const p = run(raw({ LicenseHasXdb: false, AnalyticsDllPresent: true }));
  assert.equal(p.data.topology.topology, 'xm');
  assert.equal(p.data.topology.confidence, 'low');
  assert.equal(p.data.topology.mismatch, true);
});

test('role: XMCloud role:define wins even alongside other tokens', () => {
  const p = run(raw({ RoleDefine: 'XMCloud, Cache4gb' }));
  assert.deepEqual(p.data.role, { role: 'xmcloud', confidence: 'high' });
});

test('role: XM Cloud license module is a fallback when the AppSetting does not say XMCloud', () => {
  const p = run(raw({ RoleDefine: 'ContentManagement', LicenseHasXmCloud: true }));
  assert.equal(p.data.role.role, 'xmcloud');
});

for (const [token, role] of [['ContentManagement', 'cm'], ['ContentDelivery', 'cd'], ['Standalone', 'standalone'], ['Processing', 'processing'], ['Reporting', 'reporting']]) {
  test(`role: role:define=${token} classifies as ${role}`, () => {
    const p = run(raw({ RoleDefine: token }));
    assert.deepEqual(p.data.role, { role, confidence: 'high' });
  });
}

test('role: empty AppSetting falls back to SwitchMasterToWeb file marker for CD', () => {
  const p = run(raw({ RoleDefine: null, SwitchMasterToWebDir: true }));
  assert.deepEqual(p.data.role, { role: 'cd', confidence: 'medium' });
});

test('role: empty AppSetting with both shell-app markers falls back to cm-or-standalone', () => {
  const p = run(raw({ RoleDefine: null, CmShellAppsPresent: true, CmContentEditorPresent: true }));
  assert.deepEqual(p.data.role, { role: 'cm-or-standalone', confidence: 'medium' });
});

test('role: no signals at all is unknown, low confidence', () => {
  const p = run(raw({}));
  assert.deepEqual(p.data.role, { role: 'unknown', confidence: 'low' });
});

test('hsInstall: both core DLLs + HTTP probe ok is installed', () => {
  const p = run(raw({ HsLayoutServiceDll: true, HsServicesClientDll: true }), '--hs-http-probe-ok');
  assert.equal(p.data.hsInstall, 'installed');
});

test('hsInstall: both core DLLs but no HTTP probe (default) is partial-or-misconfigured', () => {
  const p = run(raw({ HsLayoutServiceDll: true, HsServicesClientDll: true }));
  assert.equal(p.data.hsInstall, 'partial-or-misconfigured');
});

test('hsInstall: only one DLL present is partial-install regardless of HTTP probe', () => {
  const p = run(raw({ HsJssDll: true }), '--hs-http-probe-ok');
  assert.equal(p.data.hsInstall, 'partial-install');
});

test('hsInstall: no DLLs is not-installed', () => {
  const p = run(raw({}));
  assert.equal(p.data.hsInstall, 'not-installed');
});

test('kernelVersion is copied through from raw signals', () => {
  const p = run(raw({ KernelVersion: '10.1.0.012000' }));
  assert.equal(p.data.kernelVersion, '10.1.0.012000');
});

test('rejects a raw object missing a required field', () => {
  const { KernelVersion, ...incomplete } = BASE_RAW;
  const p = run(incomplete);
  assert.equal(p.code, 1);
  assert.match(p.data.error, /Missing fields: KernelVersion/);
});

test('rejects a raw object with an unknown extra field', () => {
  const p = run(raw({ ExtraField: true }));
  assert.equal(p.code, 1);
  assert.match(p.data.error, /Unknown fields: ExtraField/);
});

test('rejects a boolean field carrying the wrong type', () => {
  const p = run(raw({ LicenseHasXdb: 'true' }));
  assert.equal(p.code, 1);
  assert.match(p.data.error, /LicenseHasXdb.*wrong type/);
});

test('rejects malformed JSON input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-'));
  const file = path.join(dir, 'raw.json');
  fs.writeFileSync(file, '{not json');
  try {
    const p = spawnSync(process.execPath, [script, '--input', file], { encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.equal(JSON.parse(p.stdout).error, 'Invalid JSON input');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a missing --input argument', () => {
  const p = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.match(JSON.parse(p.stdout).error, /--input is required/);
});
