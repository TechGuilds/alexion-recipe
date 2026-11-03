import { readFile, writeFile, mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { buildPreview } from './prepare-presentation-preview.mjs';
import {
  decisionInputs,
  requireSchema,
  readJSON,
  readArtifactJSON,
  equal,
  hash,
  jsonBytes,
  freshDirectory,
  recheck,
  cli,
  isMain,
} from './lib/common.mjs';
import { scopedPath } from '../../cms-migration/scripts/lib/files.mjs';

const inside = (root, path) => {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
  );
};
async function safeTarget(root, name) {
  if (
    isAbsolute(name) ||
    name.split('/').some((p) => !p || p === '.' || p === '..') ||
    /[\\:\x00-\x1f]/.test(name)
  )
    throw Error('Unsafe preview target path');
  let current = root;
  for (const part of name.split('/')) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (current !== join(root, name) ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      )
        throw Error('Preview target contains a link or unexpected file kind');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}
async function existing(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function installPresentationPreview(inputPath, outputPath) {
  const staged = await readJSON(inputPath),
    input = requireSchema('installInput', staged.value),
    base = dirname(inputPath);
  if (!isAbsolute(input.targetRoot)) throw Error('Preview app root must be an explicit absolute path');
  const root = await realpath(input.targetRoot),
    previewInput = await readArtifactJSON(base, input.previewInput),
    manifestArtifact = await readArtifactJSON(base, input.previewManifest),
    foundationArtifact = await readArtifactJSON(base, input.foundationEvidence);
  if (
    !(await lstat(root)).isDirectory() ||
    inside(root, manifestArtifact.path) ||
    inside(dirname(manifestArtifact.path), root)
  )
    throw Error('Preview evidence and target app must not overlap');
  const rebuilt = await buildPreview(previewInput.path),
    manifest = rebuilt.manifest,
    foundation = foundationArtifact.value;
  if (input.scopeId !== manifest.scopeId || !manifest.ready || !equal(manifestArtifact.value, manifest))
    throw Error('Preview manifest differs from the current ready composition');
  if (
    foundation.version !== 1 ||
    foundation.scopeId !== input.scopeId ||
    foundation.ready !== true ||
    foundation.mockEnabled !== true ||
    foundation.routeContract !== 'single-context' ||
    foundation.targetRoot !== root ||
    foundation.siteName !== manifest.target.siteName ||
    foundation.language !== manifest.target.language ||
    !['content-sdk', 'jss'].includes(foundation.framework)
  )
    throw Error('A verified matching target preview foundation is required');
  const refs = [
    ...rebuilt.refs,
    { path: inputPath, sha256: staged.sha256 },
    { path: manifestArtifact.path, sha256: manifestArtifact.sha256 },
    { path: foundationArtifact.path, sha256: foundationArtifact.sha256 },
  ];
  for (const role of ['loader', 'layout']) {
    const descriptor = foundation[role],
      path = await scopedPath(root, descriptor?.path),
      bytes = await readFile(path);
    if (hash(bytes) !== descriptor.sha256) throw Error('Preview foundation drift: ' + role);
    if (role === 'layout' && !bytes.toString('utf8').includes('/mock-preview/navigation.js'))
      throw Error('Preview navigation hook is missing');
    refs.push({ path, sha256: descriptor.sha256 });
  }
  const foundationProof = await readArtifactJSON(dirname(foundationArtifact.path), foundation.evidence);
  refs.push({ path: foundationProof.path, sha256: foundationProof.sha256 });
  const actions = [],
    stage = dirname(manifestArtifact.path);
  for (const entry of manifest.files) {
    const source = await scopedPath(stage, entry.path),
      bytes = await readFile(source);
    if (
      !rebuilt.files.has(entry.path) ||
      hash(bytes) !== entry.sha256 ||
      !bytes.equals(rebuilt.files.get(entry.path))
    )
      throw Error('Preview stage file is missing, stale or forged');
    const target = await safeTarget(root, entry.path),
      before = await existing(target);
    refs.push({ path: source, sha256: entry.sha256 });
    actions.push({
      path: entry.path,
      action: before ? (hash(before) === entry.sha256 ? 'reuse' : 'replace') : 'create',
      beforeSha256: before ? hash(before) : null,
      afterSha256: entry.sha256,
    });
  }
  const scriptSha256 = hash(await readFile(new URL('./install-presentation-preview.mjs', import.meta.url)));
  const review = {
    version: 1,
    kind: 'virtual-preview-install',
    scopeId: input.scopeId,
    taskId: input.taskId,
    targetRoot: root,
    previewManifestSha256: manifestArtifact.sha256,
    foundationSha256: foundationArtifact.sha256,
    scriptSha256,
    actions,
    targetSitecoreWrites: false,
    userApprovalRequired: true,
  };
  const mutations = actions.filter((row) => row.action !== 'reuse');
  if (input.approval && !input.review)
    throw Error('Preview installation approval requires the exact prior review');
  if (input.review) {
    const bound = await readArtifactJSON(base, input.review);
    if (!equal(bound.value, review)) throw Error('Preview installation review is stale');
    refs.push({ path: bound.path, sha256: bound.sha256 });
  }
  if (input.approval) {
    const artifact = await readArtifactJSON(base, input.approval),
      approval = artifact.value;
    refs.push(...(await decisionInputs(approval, base)));
    if (
      approval.kind !== 'mutation' ||
      approval.choice !== 'approve' ||
      approval.scopeId !== input.scopeId ||
      approval.taskId !== input.taskId ||
      !approval.userResponse?.trim() ||
      !Number.isFinite(Date.parse(approval.at)) ||
      Date.parse(approval.at) > Date.now() ||
      !approval.inputs?.some((ref) => equal(ref, input.review))
    )
      throw Error('Preview app writes require a current explicit decision bound to the exact review');
    refs.push({ path: artifact.path, sha256: artifact.sha256 });
  }
  await recheck(refs);
  const output = await freshDirectory(outputPath);
  await writeFile(join(output, 'preview-install-review.json'), jsonBytes(review), { flag: 'wx' });
  const report = {
    version: 1,
    scopeId: input.scopeId,
    ready: true,
    installed: false,
    targetSitecoreWrites: false,
    results: [],
    previewManifestSha256: manifestArtifact.sha256,
  };
  if (!input.approval && mutations.length) {
    await writeFile(join(output, 'preview-install-report.json'), jsonBytes(report), { flag: 'wx' });
    return report;
  }
  const lockPath = join(root, '.kajoo-presentation-preview.lock');
  await writeFile(lockPath, jsonBytes({ scopeId: input.scopeId, reviewSha256: hash(jsonBytes(review)) }), {
    flag: 'wx',
  });
  try {
    await recheck(refs);
    for (const action of actions) {
      const target = await safeTarget(root, action.path),
        before = await existing(target);
      if ((before ? hash(before) : null) !== action.beforeSha256)
        throw Error('Preview app changed after review: ' + action.path);
      let backup = null;
      if (action.action === 'replace') {
        for (let n = 1; ; n++) {
          backup = action.path + '.bak.' + action.beforeSha256.slice(0, 12) + '.' + n;
          await safeTarget(root, backup);
          try {
            await writeFile(join(root, backup), before, { flag: 'wx' });
            break;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
      }
      const result = { ...action, backup, status: 'started' };
      report.results.push(result);
      await writeFile(join(output, 'preview-install-report.json'), jsonBytes(report));
      if (action.action !== 'reuse') {
        await mkdir(dirname(target), { recursive: true });
        await safeTarget(root, action.path);
        await writeFile(target, rebuilt.files.get(action.path), {
          flag: action.action === 'create' ? 'wx' : 'w',
        });
      }
      if (hash(await readFile(target)) !== action.afterSha256) throw Error('Preview file read-back failed');
      result.status = 'success';
      await writeFile(join(output, 'preview-install-report.json'), jsonBytes(report));
    }
    report.installed = true;
    await writeFile(join(output, 'preview-install-report.json'), jsonBytes(report));
  } catch (error) {
    report.ready = false;
    report.error = error.message;
    for (const row of report.results) if (row.status === 'started') row.status = 'unknown';
    await writeFile(join(output, 'preview-install-report.json'), jsonBytes(report));
    throw error;
  } finally {
    await unlink(lockPath);
  }
  return report;
}
if (isMain(import.meta.url)) await cli(installPresentationPreview);
