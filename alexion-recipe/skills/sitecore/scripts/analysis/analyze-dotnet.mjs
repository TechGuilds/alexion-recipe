#!/usr/bin/env node
// Local transport for retained deps/roslyn-analyzer. Historical references:
// 03e00d4c9 roslyn-analyzer.service.ts and mvc-discovery-artifacts.builder.ts.
// No application compilation, runtime service, database or source evaluation.
import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = `Usage: node analyze-dotnet.mjs --root <source> --output <new.json> --runtime native|dotnet|docker --executable <absolute executable>
  native: --executable /absolute/roslyn-analyzer
  dotnet: --executable /absolute/dotnet --assembly /absolute/roslyn-analyzer.dll
  docker: --executable /absolute/docker --image <sha256:ID or name@sha256:digest> --assembly /app/roslyn-analyzer.dll
  --catalog <rendering JSON or JSONL> optional; absent means joins skipped
  --revision <label> caller-supplied baseline
  --max-files 10000 --max-file-bytes 2097152 --max-total-bytes 52428800
  --max-entries 100000 --max-depth 100 --timeout-ms 60000 --max-output-bytes 33554432
Requires a separately delivered real Roslyn executable/image; never falls back to regex.
The retained analyzer takes a positional root. A bounded snapshot is analyzed; source is read-only.
Output must be outside source and must not exist. See analysis/README.md for pinned Docker delivery.
`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const slash = value => value.replaceAll('\\', '/');
const normalized = value => path.posix.normalize(slash(value).replace(/^~?\//, '').replace(/^\.\//, '')).toLowerCase();
const fqn = value => [value.namespace, value.className ?? value.interfaceName].filter(Boolean).join('.');
const inside = (root, target) => { const rel = path.relative(root, target); return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const diagnostic = (code, details = {}) => ({ code, ...details });

// Correlate structured analyzer output only. Keep all catalog rows, including
// duplicate names/IDs, and never choose the first ambiguous source candidate.
export function joinRenderings(result, catalog) {
  const diagnostics = [];
  for (const field of ['id', 'name']) {
    const groups = new Map();
    for (const row of catalog) groups.set(row[field], (groups.get(row[field]) ?? 0) + 1);
    for (const [value, count] of groups) if (value && count > 1) diagnostics.push(diagnostic(`duplicate-rendering-${field}`, { value, count }));
  }
  for (const view of result.razorViews) {
    for (const raw of view.rawHelperInvocations ?? []) {
      if (/^@Html\.(?:RenderPartial|Partial|RenderAction|Action)\s*\(\s*[^"\s]/.test(raw)) {
        diagnostics.push(diagnostic('dynamic-razor-reference', { file: view.filePath, raw, evidence: 'retained-analyzer-helper-text' }));
      }
    }
  }
  const constantsMap = new Map();
  for (const file of result.fieldConstants) for (const constant of file.constants ?? []) {
    const key = `${constant.className}.${constant.fieldName}`;
    const values = constantsMap.get(key) ?? new Set();
    if (constant.value) values.add(constant.value);
    constantsMap.set(key, values);
  }
  const renderings = catalog.map((rendering, index) => {
    const issues = [];
    const pick = (values, kind, reference) => {
      if (values.length !== 1) { issues.push(diagnostic(values.length ? `ambiguous-${kind}` : `unresolved-${kind}`, { reference, candidates: values.map(v => v.filePath ?? v.name ?? fqn(v)) })); return null; }
      return values[0];
    };
    let controller = null, action = null, view = null, viewModel = null, viewResolution = null;
    const type = (rendering.template_name ?? '').toLowerCase();
    const viewsAt = reference => {
      const target = normalized(reference);
      return result.razorViews.filter(v => normalized(v.filePath) === target || normalized(v.filePath).endsWith(`/${target}`));
    };
    if (['sublayout', 'webcontrol'].includes(type)) issues.push(diagnostic('unsupported-webforms'));
    else if (rendering.controller_class) {
      const reference = rendering.controller_class.split(',')[0].trim();
      const candidates = result.controllers.filter(c => reference.includes('.') ? fqn(c) === reference : c.className === reference || c.className === `${reference}Controller`);
      controller = pick(candidates, 'controller', reference);
      if (controller) {
        const actionName = rendering.controller_action?.trim() || 'Index';
        action = pick(controller.actions.filter(a => a.name === actionName), 'action', actionName);
        if (action && !(type === 'json rendering' || action.returnsJson)) {
          let reference = rendering.view_path || action.explicitViewName;
          let sharedReference = null;
          if (reference) {
            viewResolution = rendering.view_path ? 'catalog-path' : 'roslyn-explicit-view-candidate';
            if (!reference.includes('/') && !reference.includes('\\')) {
              sharedReference = `Views/Shared/${reference.replace(/\.cshtml$/i, '')}.cshtml`;
              reference = `Views/${controller.className.replace(/Controller$/, '')}/${reference.replace(/\.cshtml$/i, '')}.cshtml`;
            }
          } else {
            reference = `Views/${controller.className.replace(/Controller$/, '')}/${action.name}.cshtml`;
            viewResolution = 'convention-candidate';
            issues.push(diagnostic('view-selection-unverified', { reason: 'Roslyn did not emit an explicit view; dynamic selection or convention requires validation' }));
          }
          const candidates = viewsAt(reference);
          view = pick(candidates.length || !sharedReference ? candidates : viewsAt(sharedReference), 'view', reference);
          // The retained AST analyzer selects one explicit name even when an
          // action contains conditional/multiple View calls. Flag its evidence
          // as uncertain; this text check adds diagnostics, never a new join.
          const body = action.sourceText ?? '';
          if ((body.match(/\bView\s*\(/g)?.length ?? 0) > 1 || /\?|\bif\s*\(/.test(body)) issues.push(diagnostic('view-selection-unverified', { reason: 'conditional/multiple-view signal in Roslyn sourceText', evidence: 'text-signal' }));
        }
      }
    } else {
      if (rendering.view_path) { view = pick(viewsAt(rendering.view_path), 'view', rendering.view_path); viewResolution = 'catalog-path'; }
      else {
        const stem = rendering.name.replace(/\s+/g, '').toLowerCase();
        view = pick(result.razorViews.filter(v => path.posix.basename(normalized(v.filePath), '.cshtml') === stem), 'view', rendering.name);
        viewResolution = 'name-convention-candidate';
        issues.push(diagnostic('view-selection-unverified', { reason: 'catalog has no explicit view path' }));
      }
    }
    if (view?.modelDirectiveResolved) {
      const candidates = [
        ...result.viewModels.map(v => ({ ...v, source: 'viewModel' })),
        ...result.itemModels.map(v => ({ ...v, source: 'itemModel' })),
      ].filter(v => fqn(v) === view.modelDirectiveResolved);
      // The same declaration can occur in both model inventories. Preserve the
      // old largest-property preference only within that identical file/FQN.
      const identities = new Map();
      for (const candidate of candidates) {
        const identity = `${candidate.filePath}:${fqn(candidate)}`;
        const previous = identities.get(identity);
        if (!previous || (candidate.properties?.length ?? 0) > (previous.properties?.length ?? 0)) identities.set(identity, candidate);
      }
      const model = pick([...identities.values()], 'model', view.modelDirectiveResolved);
      if (model) viewModel = { ...model, className: fqn(model) };
    } else if (view?.inheritsDirective && !view?.modelDirective) {
      // Only candidates already classified by Roslyn's Glass attributes qualify.
      const reference = view.inheritsDirective.match(/<\s*([\w.]+)\s*>/)?.[1];
      const matches = reference ? result.glassMapperModels.filter(m => reference.includes('.') ? fqn(m) === reference : m.interfaceName === reference) : [];
      const model = pick(matches, 'model', reference ?? view.inheritsDirective);
      if (model) viewModel = { ...model, className: fqn(model), source: 'glassMapper' };
    } else if (view?.modelDirective || view?.inheritsDirective) {
      issues.push(diagnostic('unresolved-model', { reference: view.modelDirective ?? view.inheritsDirective, reason: 'No analyzer-resolved model identity; raw evidence retained' }));
    }
    const fields = new Set();
    const unresolvedConstants = new Set();
    const resolveConstant = ref => {
      const keys = [...constantsMap.keys()].filter(k => k === ref || k.endsWith(`.${ref}`) || ref.endsWith(`.${k}`));
      const values = new Set(keys.flatMap(k => [...constantsMap.get(k)]));
      if (keys.length === 1 && values.size === 1) fields.add([...values][0]);
      else { unresolvedConstants.add(ref); issues.push(diagnostic(values.size > 1 || keys.length > 1 ? 'ambiguous-field-constant' : 'unresolved-field-constant', { reference: ref })); }
    };
    for (const occurrence of view?.hazards?.fields ?? []) {
      const name = occurrence.rawText?.match(/(?:Begin)?Field\s*\(\s*"([^"]+)"/)?.[1];
      if (name) fields.add(name);
    }
    const itemModels = action?.viewModelType ? result.itemModels.filter(m => fqn(m) === action.viewModelType) : [];
    if (itemModels.length > 1) issues.push(diagnostic('ambiguous-action-model', { reference: action.viewModelType }));
    for (const holder of [view, action, viewModel, ...(itemModels.length === 1 ? itemModels : [])].filter(Boolean)) {
      for (const field of holder.fieldAccesses ?? []) fields.add(field);
      for (const ref of [...(holder.constantFieldAccesses ?? []), ...(holder.fieldHelperConstantCalls ?? [])]) resolveConstant(ref);
      for (const prop of holder.properties ?? []) {
        if (prop.wrappedField) fields.add(prop.wrappedField);
        if (prop.wrappedFieldConstant) resolveConstant(prop.wrappedFieldConstant);
      }
    }
    return { index, catalogRecord: rendering, renderingId: rendering.id, renderingName: rendering.name, renderingPath: rendering.path ?? null, templateName: rendering.template_name ?? null,
      controller, action, view, viewModel, viewResolution, fields: [...fields].sort(compare), unresolvedConstants: [...unresolvedConstants].sort(compare),
      diagnostics: issues, status: issues.length ? 'needs-review' : 'mapped' };
  });
  return { status: 'analyzed', renderings, diagnostics, complete: diagnostics.length === 0 && renderings.every(r => r.status === 'mapped') };
}

function options(argv) {
  const opts = { 'max-files': 10000, 'max-file-bytes': 2097152, 'max-total-bytes': 52428800, 'max-entries': 100000, 'max-depth': 100, 'timeout-ms': 60000, 'max-output-bytes': 33554432 };
  const numeric = Object.keys(opts);
  const allowed = new Set([...numeric, 'root', 'output', 'runtime', 'executable', 'assembly', 'image', 'catalog', 'revision']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
    opts[key] = argv[i + 1];
  }
  for (const key of ['root', 'output', 'runtime', 'executable']) if (!opts[key]) throw new Error(`--${key} is required`);
  for (const key of numeric) {
    opts[key] = Number(opts[key]);
    if (!Number.isSafeInteger(opts[key]) || opts[key] < 1) throw new Error(`Invalid --${key}`);
  }
  if (opts['timeout-ms'] > 2147483647) throw new Error('timeout-ms exceeds Node timer range');
  if (!['native', 'dotnet', 'docker'].includes(opts.runtime)) throw new Error('Unsupported runtime; real Roslyn is required');
  if (!path.isAbsolute(opts.executable)) throw new Error('--executable must be absolute');
  if (opts.runtime !== 'native' && !opts.assembly) throw new Error('--assembly is required');
  if (opts.runtime === 'docker' && !/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(opts.image ?? '')) throw new Error('Docker --image must be pinned by immutable digest or image ID');
  if (opts.runtime === 'docker' && (!path.posix.isAbsolute(opts.assembly) || opts.assembly.includes('..'))) throw new Error('Docker assembly must be an absolute container path');
  return opts;
}

async function boundedRead(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not-regular-file');
    if (stat.size > limit) throw new Error('file-too-large');
    const chunks = []; let size = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error('file-too-large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

async function validateOutput(output, root, otherInputs = []) {
  const absolute = path.resolve(output);
  if (inside(root, absolute) || otherInputs.includes(absolute)) throw new Error('Output must be outside read-only inputs');
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Output path must not contain symlinks');
      if (current === absolute) throw new Error('Output already exists');
      if (!stat.isDirectory()) throw new Error('Output parent is not a directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}

const excluded = new Set(['.git', '.vs', 'bin', 'obj', 'packages', 'node_modules', 'dist', 'build', '.next', 'out', '.turbo', '.cache', 'wwwroot']);
const buildFiles = /^(?:gulpfile|webpack\.config|gruntfile)\.(?:js|mjs|ts)$|^package\.json$/i;
async function snapshot(root, destination, opts) {
  const info = { complete: true, filesMatched: 0, filesRead: 0, bytesRead: 0, entriesVisited: 0, files: [], omissions: [], excludedDirectories: [...excluded].sort(compare) };
  const omit = (file, reason) => { info.complete = false; info.omissions.push({ file, reason }); };
  let stop = false;
  async function walk(directory, relative = '', depth = 0) {
    if (depth > opts['max-depth']) { omit(relative, 'max-depth'); return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { omit(relative || '.', 'unreadable-directory'); return; }
    entries.sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      if (stop) return;
      if (++info.entriesVisited > opts['max-entries']) { omit(relative || '.', 'max-entries'); stop = true; return; }
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (excluded.has(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) { omit(rel, 'symlink'); continue; }
      if (entry.isDirectory()) { await walk(full, rel, depth + 1); continue; }
      if (!entry.isFile() || (!/\.(cs|cshtml|config|csproj|sln)$/i.test(entry.name) && !buildFiles.test(entry.name))) continue;
      info.filesMatched++;
      if (info.filesMatched > opts['max-files']) { omit(rel, 'max-files'); continue; }
      try {
        if (!inside(root, await realpath(full))) { omit(rel, 'outside-root'); continue; }
        const content = await boundedRead(full, opts['max-file-bytes']);
        if (info.bytesRead + content.length > opts['max-total-bytes']) { omit(rel, 'max-total-bytes'); continue; }
        const target = path.join(destination, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { flag: 'wx', mode: 0o444 });
        info.files.push({ path: rel, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
        info.bytesRead += content.length;
        info.filesRead++;
      } catch (error) { omit(rel, error.message === 'file-too-large' ? 'file-too-large' : 'unreadable-file'); }
    }
  }
  await walk(root);
  return info;
}

function execute(executable, args, { timeout, maxBytes, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = [], stderr = [], bytes = 0, failure;
    const terminate = reason => {
      failure ??= new Error(reason);
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => terminate('Roslyn timeout'), timeout);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) terminate('Roslyn output-limit exceeded');
      else chunks.push(chunk);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) reject(new Error(`Roslyn exit ${code} (${signal ?? 'no signal'}): ${err || out}`));
      else resolve({ stdout: out, stderr: err });
    });
  });
}

function validateResult(value) {
  const lists = ['controllers', 'razorViews', 'viewModels', 'itemModels', 'glassMapperModels', 'fieldConstants', 'contentResolvers', 'configPatches', 'renderingParameters'];
  if (!object(value) || !object(value.meta) || lists.some(key => !Array.isArray(value[key]) || value[key].some(row => !object(row) || typeof row.filePath !== 'string'))) throw new Error('Invalid Roslyn output schema');
  if (value.controllers.some(c => typeof c.className !== 'string' || !Array.isArray(c.actions) || c.actions.some(a => !object(a) || typeof a.name !== 'string'))) throw new Error('Invalid Roslyn controller schema');
  return value;
}

async function readCatalog(file, opts) {
  const text = (await boundedRead(file, opts['max-file-bytes'])).toString('utf8');
  let parsed;
  try { parsed = /\.jsonl$/i.test(file) ? text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text); }
  catch { throw new Error('Invalid rendering catalog JSON'); }
  if (parsed?.status === 'failed' || parsed?.complete === false || (parsed?.errors?.length ?? 0)) throw new Error('Rendering catalog declares failure/partial coverage');
  const rows = Array.isArray(parsed) ? parsed : parsed?.renderings;
  if (!Array.isArray(rows)) throw new Error('Catalog must contain a renderings array (or JSONL rendering records)');
  if (rows.length > opts['max-files']) throw new Error('Rendering catalog exceeds max-files');
  return rows.map((row, index) => {
    if (!object(row) || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name) throw new Error(`Invalid catalog rendering at ${index}`);
    const fields = row.fields ?? {};
    if (!object(fields)) throw new Error(`Invalid catalog fields at ${index}`);
    const result = { ...row, template_name: row.template_name ?? row.templateName ?? null, controller_class: row.controller_class ?? fields.Controller ?? null,
      controller_action: row.controller_action ?? fields['Controller Action'] ?? null, view_path: row.view_path ?? fields.Path ?? null };
    for (const key of ['path', 'template_name', 'controller_class', 'controller_action', 'view_path']) if (result[key] != null && typeof result[key] !== 'string') throw new Error(`Invalid catalog ${key} at ${index}`);
    return result;
  });
}

export async function run(opts) {
  const root = await realpath(path.resolve(opts.root));
  if (!(await lstat(root)).isDirectory()) throw new Error('Source root is not a directory');
  const executable = await realpath(opts.executable);
  if (!(await lstat(executable)).isFile()) throw new Error('Runtime executable is not a file');
  const assembly = opts.runtime === 'dotnet' ? await realpath(path.resolve(opts.assembly)) : opts.assembly;
  const catalogPath = opts.catalog ? await realpath(path.resolve(opts.catalog)) : null;
  const output = await validateOutput(opts.output, root, [executable, assembly, catalogPath].filter(Boolean));
  const catalog = catalogPath ? await readCatalog(catalogPath, opts) : null;
  const temporaryRoot = await realpath(tmpdir());
  if (inside(root, temporaryRoot)) throw new Error('Temporary snapshot directory would be inside source');
  const temporary = await mkdtemp(path.join(temporaryRoot, 'kajoo-dotnet-'));
  const snapshotRoot = path.join(temporary, 'source');
  const containerName = `kajoo-dotnet-${randomUUID()}`;
  let usedDocker = false;
  try {
    await mkdir(snapshotRoot);
    const scan = await snapshot(root, snapshotRoot, opts);
    let args;
    if (opts.runtime === 'native') args = [snapshotRoot];
    else if (opts.runtime === 'dotnet') args = [assembly, snapshotRoot];
    else {
      if (snapshotRoot.includes(',')) throw new Error('Docker snapshot path cannot contain commas');
      args = ['run', '--rm', '--name', containerName, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,source=${snapshotRoot},target=/source,readonly`, '--entrypoint', 'dotnet', opts.image, assembly, '/source'];
      usedDocker = true;
    }
    const execution = await execute(executable, args, { timeout: opts['timeout-ms'], maxBytes: opts['max-output-bytes'], cwd: temporary });
    let parsed;
    try { parsed = JSON.parse(execution.stdout); } catch { throw new Error('Roslyn output is not valid JSON'); }
    const result = validateResult(parsed);
    const mapping = catalog ? joinRenderings(result, catalog) : { status: 'skipped', reason: 'catalog-absent', renderings: [], diagnostics: [], complete: false };
    const diagnostics = [];
    if (result.meta.csFiles === 0) diagnostics.push(diagnostic('no-csharp-foundation'));
    const expectedCs = scan.files.filter(f => /\.cs$/i.test(f.path)).length;
    const expectedViews = scan.files.filter(f => /\.cshtml$/i.test(f.path)).length;
    if (result.meta.csFiles !== expectedCs || result.meta.cshtmlFiles !== expectedViews) { scan.complete = false; diagnostics.push(diagnostic('analyzer-file-count-mismatch', { expectedCs, expectedViews })); }
    const report = { schemaVersion: '1.0', scope: { sourceRoot: root, revision: opts.revision ?? null, revisionSource: 'caller-supplied', catalog: catalogPath },
      engine: { runtime: opts.runtime, executable, assembly: assembly ?? null, image: opts.image ?? null,
        syntaxDiagnostics: 'not-emitted-by-retained-analyzer', semanticCompilation: false, razor: 'retained-pattern-analyzer', stderr: execution.stderr },
      result, mapping, scan, diagnostics, complete: scan.complete && mapping.complete && diagnostics.length === 0 };
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > opts['max-output-bytes']) throw new Error('Roslyn report output-limit exceeded');
    // Revalidate immediately before the exclusive write. Raw Roslyn object is
    // preserved, including unknown fields and timing/root metadata.
    await validateOutput(output, root, [executable, assembly, catalogPath].filter(Boolean));
    await mkdir(path.dirname(output), { recursive: true });
    const handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(encoded); } finally { await handle.close(); }
    return { success: true, destination: output, complete: report.complete, filesRead: scan.filesRead, controllers: result.controllers.length, razorViews: result.razorViews.length, mappingStatus: mapping.status };
  } finally {
    if (usedDocker) await execute(executable, ['rm', '-f', containerName], { timeout: 5000, maxBytes: 65536, cwd: temporary }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes('--help')) process.stdout.write(usage);
  else {
    try { process.stdout.write(`${JSON.stringify(await run(options(process.argv.slice(2))))}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`); process.exitCode = 1; }
  }
}
