import fs from 'node:fs';
import path from 'node:path';
import { args, required, safe, separate, walk, readBytes, hash, writeReport, run } from './core.mjs';

const plugins = [
  'Sitecore.DevEx.Extensibility.Serialization@6.0.23',
  'Sitecore.DevEx.Extensibility.Publishing@6.0.23',
  'Sitecore.DevEx.Extensibility.Indexing@6.0.23',
  'Sitecore.DevEx.Extensibility.ResourcePackage@6.0.23',
  'Sitecore.DevEx.Extensibility.XMCloud@1.1.120',
];

function absent(dir, label) {
  if (fs.existsSync(dir)) throw Error(`${label} must not already exist: ${dir}`);
}

function safeSegment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw Error(`Unsafe namespace: ${value}`);
  return value;
}

function validModule(bytes, source) {
  let module;
  try { module = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error(`Invalid module JSON: ${source}`); }
  safeSegment(module?.namespace);
  if (!Array.isArray(module?.items?.includes) || module.items.includes.length === 0) throw Error(`Module has no includes: ${source}`);
  for (const include of module.items.includes) {
    if (typeof include?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(include.name) || typeof include?.path !== 'string' || !include.path.startsWith('/sitecore/') || !['SingleItem', 'ItemAndDescendants', undefined].includes(include.scope)) {
      throw Error(`Invalid module include: ${source}`);
    }
  }
  return module;
}

run(() => {
  const a = args(['modules-root', 'project-root', 'output-root']);
  required(a, 'modules-root', 'project-root', 'output-root');
  const modulesRoot = safe(a['modules-root']);
  const projectRoot = safe(a['project-root']);
  const outputRoot = safe(a['output-root']);
  separate(modulesRoot, projectRoot); separate(modulesRoot, outputRoot); separate(projectRoot, outputRoot);
  if (!fs.statSync(modulesRoot).isDirectory()) throw Error(`Expected modules directory: ${modulesRoot}`);
  absent(projectRoot, 'project root'); absent(outputRoot, 'output root');

  const modules = walk(modulesRoot).filter((file) => file.endsWith('.module.json'));
  if (!modules.length) throw Error('No module configuration files');
  const seen = new Set();
  const manifest = [];
  fs.mkdirSync(path.join(projectRoot, 'modules'), { recursive: true });
  for (const source of modules) {
    const bytes = readBytes(source);
    const module = validModule(bytes, source);
    if (seen.has(module.namespace)) throw Error(`Duplicate module namespace: ${module.namespace}`);
    seen.add(module.namespace);
    const namespace = safeSegment(module.namespace);
    const destinationDirectory = path.join(projectRoot, 'modules', namespace);
    const destination = path.join(destinationDirectory, `${namespace}.module.json`);
    fs.mkdirSync(destinationDirectory, { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    manifest.push({
      namespace: module.namespace,
      source: path.relative(modulesRoot, source),
      destination: path.relative(projectRoot, destination),
      sha256: hash(bytes),
      includeCount: module.items.includes.length,
    });
  }

  const config = {
    modules: ['modules/**/*.module.json'],
    plugins,
    serialization: {
      defaultMaxRelativeItemPathLength: 120,
      defaultModuleRelativeSerializationPath: 'serialization',
      removeOrphansForRoles: true,
      removeOrphansForUsers: true,
      continueOnItemFailure: false,
      excludedFields: [],
      progressiveMetadataPull: false,
    },
    settings: { telemetryEnabled: true, cacheAuthenticationToken: true, versionComparisonEnabled: true, apiClientTimeoutInMinutes: 5 },
  };
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(projectRoot, 'sitecore.json'), configBytes, { flag: 'wx' });
  writeReport(outputRoot, 'cli-project.json', {
    version: 1,
    projectRoot,
    modules: manifest.sort((a, b) => a.namespace.localeCompare(b.namespace)),
    sitecoreJson: { path: 'sitecore.json', sha256: hash(configBytes), plugins },
  }, [modulesRoot, projectRoot]);
});
