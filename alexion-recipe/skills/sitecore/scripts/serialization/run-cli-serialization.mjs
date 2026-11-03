import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { safe, separate, walk, readBytes, hash, writeReport, run } from './core.mjs';

const values = new Set(['project-root', 'role', 'operation', 'output-root', 'include', 'timeout-ms']);
const flags = new Set(['what-if', 'force']);
const operations = new Set(['probe', 'login', 'pull', 'push', 'validate']);

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith('--')) throw Error(`Unknown argument: ${option}`);
    const name = option.slice(2);
    if ((!values.has(name) && !flags.has(name)) || name in out) throw Error(`Unknown or duplicate option: ${option}`);
    out[name] = flags.has(name) ? true : argv[++index];
    if (out[name] === undefined || String(out[name]).startsWith('--')) throw Error(`Missing value: ${option}`);
  }
  for (const name of ['project-root', 'role', 'operation', 'output-root']) if (!out[name]) throw Error(`Required --${name}`);
  if (out.role !== 'source' && out.role !== 'target') throw Error('role must be source or target');
  if (!operations.has(out.operation)) throw Error('Unsupported operation');
  if (out.operation === 'pull' && out.role !== 'source') throw Error('pull requires role source');
  if (out.operation === 'push' && out.role !== 'target') throw Error('push requires role target');
  if (out['what-if'] && out.operation !== 'push') throw Error('--what-if is only valid for push');
  if (out.force && !['pull', 'push'].includes(out.operation)) throw Error('--force is only valid for pull or push');
  return out;
}

function roleCredentials(role) {
  const prefix = `${role.toUpperCase()}_SITECORE_`;
  const pick = (name) => process.env[`${prefix}${name}`] || process.env[`${prefix.replace('SITECORE_', '')}${name}`];
  const values = {
    cm: pick('MANAGEMENT_SERVICE_CM'),
    authority: pick('MANAGEMENT_SERVICE_AUTHORITY'),
    clientId: pick('MANAGEMENT_SERVICE_CLIENT_ID') || pick('CLIENT_ID'),
    clientSecret: pick('MANAGEMENT_SERVICE_CLIENT_SECRET') || pick('CLIENT_SECRET'),
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw Error(`Missing ${role} connector credential environment: ${missing.join(', ')}`);
  return values;
}

function redactor(secrets) {
  return (value) => secrets.reduce((result, secret) => secret ? result.split(secret).join('[REDACTED]') : result, String(value ?? ''));
}

function splitIncludes(include) {
  if (!include) return [];
  const names = include.split(',').map((name) => name.trim()).filter(Boolean);
  if (!names.length || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) throw Error('Invalid exact namespace selector');
  return names;
}

function execute(binary, commandArgs, cwd, timeout, redact) {
  const invocation = process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd')
    ? {
      binary: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', binary, ...commandArgs],
    }
    : { binary, args: commandArgs };
  const result = spawnSync(invocation.binary, invocation.args, { cwd, encoding: 'utf8', timeout, windowsHide: true });
  if (result.error) return { command: commandArgs, exitCode: result.status ?? 1, stdout: '', stderr: redact(result.error.message) };
  return { command: commandArgs, exitCode: result.status ?? 1, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

function projectManifest(projectRoot) {
  return walk(projectRoot)
    .filter((file) => path.basename(file) === 'sitecore.json' || file.endsWith('.module.json'))
    .map((file) => {
      const bytes = readBytes(file);
      return { path: path.relative(projectRoot, file), sha256: hash(bytes), bytes: bytes.length };
    });
}

function initializedProject(projectRoot, runCommand) {
  const statePath = path.join(projectRoot, '.kajoo-sitecore-cli-init.json');
  const sitecoreJsonSha256 = hash(readBytes(path.join(projectRoot, 'sitecore.json')));
  if (fs.existsSync(statePath)) {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      throw Error('Invalid Sitecore CLI initialization state; prepare a fresh project');
    }
    if (state.version !== 1 || state.sitecoreJsonSha256 !== sitecoreJsonSha256) {
      throw Error('Sitecore CLI initialization state does not match sitecore.json; prepare a fresh project');
    }
    return true;
  }
  const initialized = runCommand(['init']).exitCode === 0;
  if (!initialized) return false;
  const state = JSON.stringify({ version: 1, sitecoreJsonSha256 }, null, 2) + '\n';
  try {
    fs.writeFileSync(statePath, state, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return initializedProject(projectRoot, runCommand);
  }
  return true;
}

run(() => {
  const a = parse(process.argv.slice(2));
  const projectRoot = safe(a['project-root']);
  const outputRoot = safe(a['output-root']);
  separate(projectRoot, outputRoot);
  if (!fs.statSync(projectRoot).isDirectory() || !fs.statSync(path.join(projectRoot, 'sitecore.json')).isFile()) throw Error('Expected prepared Sitecore CLI project');
  if (fs.existsSync(outputRoot)) throw Error(`output root must not already exist: ${outputRoot}`);
  const timeout = a['timeout-ms'] ? Number(a['timeout-ms']) : 300000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) throw Error('Invalid timeout-ms');
  const binary = process.env.SITECORE_CLI_BIN || 'sitecore';
  if (path.isAbsolute(binary) && !fs.existsSync(binary)) throw Error('Configured Sitecore CLI binary is unavailable');
  const commands = [];
  let secrets = [];
  let credentials;
  if (['login', 'pull', 'push'].includes(a.operation)) {
    credentials = roleCredentials(a.role);
    secrets = [credentials.clientSecret];
  }
  const redact = redactor(secrets);
  const runCommand = (commandArgs) => {
    const entry = execute(binary, commandArgs, projectRoot, timeout, redact);
    commands.push(entry);
    return entry;
  };

  let success;
  let detectedCliMajor = null;
  if (a.operation === 'probe') {
    const version = runCommand(['--version']);
    const versionMatch = version.stdout.match(/(?:^|\s)(\d+)\.\d+\.\d+/);
    detectedCliMajor = versionMatch ? Number(versionMatch[1]) : null;
    success = version.exitCode === 0 && detectedCliMajor === 6 && runCommand(['ser', '--help']).exitCode === 0;
  } else {
    success = initializedProject(projectRoot, runCommand);
    if (success && credentials) {
      const loginArgs = ['login', '--client-credentials', 'true', '--allow-write', 'true', '--environment-name', a.role, '--cm', credentials.cm, '--auth', credentials.authority, '--client-id', credentials.clientId, '--client-secret', credentials.clientSecret, '-t'];
      if (credentials.authority.includes('sitecorecloud.io')) loginArgs.push('--audience', 'https://api.sitecorecloud.io');
      success = runCommand(loginArgs).exitCode === 0;
    }
    if (success && a.operation !== 'login') {
      const include = splitIncludes(a.include);
      const commandArgs = a.operation === 'validate' ? ['ser', 'validate'] : ['ser', a.operation, '-n', a.role];
      if (include.length) commandArgs.push('--include', ...include);
      if (a['what-if']) commandArgs.push('--what-if');
      if (a.force) commandArgs.push('--force');
      success = runCommand(commandArgs).exitCode === 0;
    }
  }
  const report = {
    version: 1,
    role: a.role,
    operation: a.operation,
    namespaces: splitIncludes(a.include),
    whatIf: Boolean(a['what-if']),
    force: Boolean(a.force),
    cli: a.operation === 'probe' ? { requiredMajor: 6, detectedMajor: detectedCliMajor } : undefined,
    projectManifest: projectManifest(projectRoot),
    success,
    commands: commands.map(({ command, exitCode, stdout, stderr }) => ({
      command: command.map((value) => redact(value)), exitCode, stdout, stderr,
    })),
  };
  writeReport(outputRoot, 'serialization-operation.json', report, [projectRoot]);
  if (!success) process.exitCode = commands.find(({ exitCode }) => exitCode !== 0)?.exitCode || 1;
});
