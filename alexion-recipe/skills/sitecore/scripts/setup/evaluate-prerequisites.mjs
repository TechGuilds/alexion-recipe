#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const requirementsDocument = JSON.parse(
  readFileSync(new URL('../../assets/setup/capability-requirements.json', import.meta.url), 'utf8'),
);
const packageDocument = JSON.parse(
  readFileSync(new URL('../../assets/setup/hs-package-matrix.json', import.meta.url), 'utf8'),
);

function compareSemver(left, right) {
  const a = String(left).split('.').map(value => Number.parseInt(value, 10) || 0);
  const b = String(right).split('.').map(value => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function selectHsPackage({ topology, kernelVersion }) {
  return (
    packageDocument.packages.find(entry => {
      if (entry.topology !== topology) return false;
      if (!kernelVersion) return true;
      return (
        compareSemver(kernelVersion, entry.xpKernelMin) >= 0 &&
        compareSemver(kernelVersion, entry.xpKernelMax) <= 0
      );
    }) ?? null
  );
}

function verdict(value) {
  return typeof value === 'string' ? value : value?.verdict;
}

function blocker(capability, observed, required = 'ready') {
  return {
    capability,
    required,
    observed: observed ?? 'unverified',
    nextAction: `Provide terminal evidence that ${capability} is ${required}.`,
  };
}

export function evaluatePrerequisites({ migrationType, workflowMode, capabilities = {} }) {
  const base = requirementsDocument.migrationTypes[migrationType];
  if (!base) throw new Error(`Unknown Sitecore migration type: ${migrationType}`);
  if (workflowMode !== 'full-migration' && workflowMode !== 'discovery-only') {
    throw new Error(
      'Explicit workflow mode is required: choose full-migration or discovery-only.',
    );
  }

  const mode = workflowMode;
  const installedApplicability =
    mode === 'discovery-only' && base.headlessServices.discoveryOnlyInstalled
      ? base.headlessServices.discoveryOnlyInstalled
      : base.headlessServices.installed;
  const applicability = {
    headlessServicesInstalled: installedApplicability,
    headlessServicesLicensed: base.headlessServices.licensed,
    layoutService: base.layoutService,
    speScriptExecution: base.spe.scriptExecution,
    speFileDownload: base.spe.fileDownload,
    managementServices: base.managementServices,
    contentRead: base.contentRead,
  };

  const blockers = [];
  const recommendations = [];
  const selectionPending = verdict(capabilities.siteSelection) !== 'ready';

  if (installedApplicability === 'required' && capabilities.headlessServices?.installed !== 'ready') {
    blockers.push(
      blocker('headlessServices.installed', capabilities.headlessServices?.installed, 'ready'),
    );
    const recommendedPackage = selectHsPackage({
      topology: capabilities.topology?.topology,
      kernelVersion: capabilities.topology?.kernelVersion,
    });
    recommendations.push({
      action: 'install-headless-services',
      package: recommendedPackage,
      detail: recommendedPackage
        ? 'Use the matched, checksum-pinned package after explicit mutation approval.'
        : 'No package matches the observed topology/kernel; do not guess a package.',
    });
  }
  if (
    base.headlessServices.licensed === 'required' &&
    capabilities.headlessServices?.licensed !== 'ready'
  ) {
    blockers.push(
      blocker('headlessServices.licensed', capabilities.headlessServices?.licensed, 'ready'),
    );
  }

  const layoutVerdict = verdict(capabilities.layoutService);
  if (
    base.layoutService === 'required' &&
    layoutVerdict !== 'ready' &&
    layoutVerdict !== 'needs-site-selection'
  ) {
    blockers.push(blocker('layoutService', layoutVerdict, 'ready'));
  }
  if (base.spe.scriptExecution === 'required' && capabilities.spe?.scriptExecution !== 'ready') {
    blockers.push(blocker('spe.scriptExecution', capabilities.spe?.scriptExecution, 'ready'));
  }
  if (base.spe.fileDownload === 'required' && capabilities.spe?.fileDownload !== 'ready') {
    blockers.push(blocker('spe.fileDownload', capabilities.spe?.fileDownload, 'ready'));
  }
  if (capabilities.spe?.issue1322 === 'affected') {
    blockers.push(blocker('spe.issue1322', 'affected', 'not-affected'));
  }
  if (base.managementServices === 'required' && verdict(capabilities.managementServices) !== 'ready') {
    blockers.push(blocker('managementServices', verdict(capabilities.managementServices), 'ready'));
  }
  if (
    base.contentRead === 'either' &&
    verdict(capabilities.itemService) !== 'ready' &&
    verdict(capabilities.graphql) !== 'ready'
  ) {
    blockers.push(
      blocker(
        'contentRead',
        `itemService=${verdict(capabilities.itemService) ?? 'unverified'}, graphql=${verdict(capabilities.graphql) ?? 'unverified'}`,
        'at least one authenticated read path ready',
      ),
    );
  }

  // Record usable alternatives without relaxing required capability gates.
  const itemReady = verdict(capabilities.itemService) === 'ready';
  const graphqlReady = verdict(capabilities.graphql) === 'ready';
  if (base.contentRead === 'either' && itemReady !== graphqlReady) {
    recommendations.push({
      action: itemReady ? 'use-item-service' : 'use-graphql',
      detail: itemReady
        ? 'Use the verified Item Service for supported content reads. GraphQL is unavailable or unverified; retain its diagnostic and do not use GraphQL-dependent operations until repaired and re-probed.'
        : 'Use the verified GraphQL service for supported content reads. Item Service is unavailable or unverified; retain its diagnostic and do not use Item Service operations until repaired and re-probed.',
    });
  }
  if (
    base.layoutService === 'mock-replaceable' &&
    layoutVerdict !== 'ready' &&
    layoutVerdict !== 'needs-site-selection' &&
    !selectionPending
  ) {
    recommendations.push({
      action: 'use-mock-layouts',
      detail: 'REST Layout is unavailable or unverified. This migration permits mock layouts for applicable downstream work; follow the profile procedure. Mock output is not verified live Layout Service evidence and does not waive other required capabilities.',
    });
  }

  const status =
    blockers.length > 0
      ? 'blocked'
      : selectionPending || layoutVerdict === 'needs-site-selection'
        ? 'needs-site-selection'
        : 'complete';

  return {
    schemaVersion: 1,
    migrationType,
    workflowMode: mode,
    status,
    applicability,
    blockers,
    recommendations,
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = readArgument('--input');
  if (!inputPath) throw new Error('Usage: evaluate-prerequisites.mjs --input <setup-capabilities.json>');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(evaluatePrerequisites(input), null, 2)}\n`);
}
