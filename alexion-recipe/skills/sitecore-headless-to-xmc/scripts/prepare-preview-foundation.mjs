#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isWithin = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  throw new Error(message);
}

function parse(argv) {
  const options = { 'prior-result': [] };
  const singleton = new Set(['target', 'source', 'fixture', 'route', 'layout', 'out']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith('--')) fail('Unknown option: ' + option);
    const name = option.slice(2);
    if (![...singleton, 'prior-result'].includes(name) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      fail('Unknown or missing option: ' + option);
    }
    const value = argv[++index];
    if (singleton.has(name)) {
      if (options[name] !== undefined) fail('Duplicate option: ' + option);
      options[name] = value;
    } else {
      options[name].push(value);
    }
  }
  for (const required of ['target', 'fixture', 'route', 'layout', 'out']) {
    if (!options[required]) fail('--' + required + ' is required');
  }
  if (!options.route.startsWith('/') || /[\r\n]/.test(options.route)) fail('--route must be an absolute route path');
  if (path.isAbsolute(options.layout) || options.layout.includes('\\') || options.layout.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('--layout must be a safe relative slash path');
  }
  return options;
}

function existingDirectory(value, label) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) fail(label + ' must be an existing directory');
  if (fs.lstatSync(resolved).isSymbolicLink()) fail(label + ' cannot be a symbolic link');
  return fs.realpathSync(resolved);
}

function existingFile(value, label) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail(label + ' must be an existing file');
  if (fs.lstatSync(resolved).isSymbolicLink() || fs.statSync(resolved).nlink !== 1) fail(label + ' must be a regular unlinked file');
  return fs.realpathSync(resolved);
}

function targetFile(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (!isWithin(root, resolved)) fail('Layout escapes target root');
  return existingFile(resolved, '--layout');
}

function newOutput(value, forbiddenRoots) {
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail('--out parent must be an existing directory');
  const realParent = fs.realpathSync(parent);
  if (fs.lstatSync(realParent).isSymbolicLink()) fail('--out parent cannot be a symbolic link');
  const output = path.join(realParent, path.basename(resolved));
  if (forbiddenRoots.some(root => isWithin(root, output))) fail('--out must be outside target and source roots');
  if (fs.existsSync(output)) fail('--out already exists');
  return output;
}

function placeholders(fixture) {
  const candidates = [
    fixture?.sitecore?.route?.placeholders,
    fixture?.route?.placeholders,
    fixture?.layout?.sitecore?.route?.placeholders,
    fixture?.layout?.route?.placeholders,
  ].filter(isRecord);
  if (!candidates.length) fail('Fixture does not contain a route placeholders object');
  const keys = candidates.map(candidate => Object.keys(candidate).sort());
  const signature = JSON.stringify(keys[0]);
  if (keys.some(value => JSON.stringify(value) !== signature)) fail('Fixture has ambiguous route placeholder containers');
  return keys[0];
}

function reference(file, label) {
  const bytes = fs.readFileSync(file);
  return { path: file, sha256: hash(bytes), label };
}

function priorResult(file) {
  const referenceValue = reference(file, 'prior-result');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('--prior-result must contain JSON: ' + file); }
  if (!isRecord(value) || typeof value.taskId !== 'string' || !value.taskId.trim()) fail('--prior-result must contain a taskId: ' + file);
  return { path: referenceValue.path, sha256: referenceValue.sha256, taskId: value.taskId };
}

function run(options) {
  const target = existingDirectory(options.target, '--target');
  const source = options.source ? existingDirectory(options.source, '--source') : null;
  const fixturePath = existingFile(options.fixture, '--fixture');
  const layoutPath = targetFile(target, options.layout);
  const output = newOutput(options.out, [target, ...(source ? [source] : [])]);
  let fixture;
  try { fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); } catch { fail('--fixture must contain JSON'); }
  const priorResults = options['prior-result'].map(file => priorResult(existingFile(file, '--prior-result')))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(priorResults.map(item => item.path)).size !== priorResults.length) fail('Duplicate --prior-result');
  const manifest = {
    schemaVersion: 1,
    kind: 'sitecore-headless-preview-input',
    route: options.route,
    fixture: { ...reference(fixturePath, 'layout-fixture'), placeholderKeys: placeholders(fixture) },
    layout: { path: options.layout, sha256: hash(fs.readFileSync(layoutPath)) },
    priorResults,
  };
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { valid: true, output, summary: { placeholderKeys: manifest.fixture.placeholderKeys.length, priorResults: priorResults.length } };
}

try {
  const result = run(parse(process.argv.slice(2)));
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ valid: false, errors: [error.message] }));
  process.exitCode = 1;
}
