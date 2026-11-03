#!/usr/bin/env node
// Turns a completed export-dictionary.ps1 capture into the flat files the mock layout service reads:
// <output>/<site>/<language>.json, each a { key: phrase } map. Local, byte-faithful for phrases, and
// deterministic (keys are sorted). It converts the captured dictionary export into the mock-service shape.
//
// Usage: node build-mock-dictionary.mjs --raw-root DIR --site NAME --output NEW_DIR [--duplicates fail|first|last]
// --raw-root holds dictionary.jsonl (and errors.jsonl if the export reported any problem).
import { readFile, writeFile, mkdir, rm, rename, realpath, lstat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SITE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function parseArgs(argv) {
  const known = new Set(['raw-root', 'site', 'output', 'duplicates']);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], key = arg.slice(2);
    if (!arg.startsWith('--') || !known.has(key) || key in options) throw new Error('Unknown or duplicate option: ' + arg);
    options[key] = argv[++i];
    if (!options[key] || options[key].startsWith('--')) throw new Error('Missing value: ' + arg);
  }
  for (const key of ['raw-root', 'site', 'output']) if (!options[key]) throw new Error('Missing required option: --' + key);
  options.duplicates ??= 'fail';
  if (!['fail', 'first', 'last'].includes(options.duplicates)) throw new Error('--duplicates must be fail, first or last');
  return options;
}

const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const lines = text => text.split(/\r?\n/).filter(line => line.trim());

export async function buildMockDictionary(options) {
  if (!SITE.test(options.site) || options.site.includes('..')) throw new Error('--site must be a plain directory name: letters, digits, dot, dash or underscore');
  const rawRoot = await realpath(resolve(options['raw-root']));
  const requested = resolve(options.output);
  if (!(await exists(dirname(requested)))) throw new Error('The parent of --output must exist: ' + dirname(requested));
  const output = join(await realpath(dirname(requested)), basename(requested));
  if (await exists(output)) throw new Error('--output already exists: ' + output);

  const sourcePath = join(rawRoot, 'dictionary.jsonl');
  if (!(await exists(sourcePath))) throw new Error('dictionary.jsonl not found in --raw-root');
  const errorsPath = join(rawRoot, 'errors.jsonl');
  const exportErrors = (await exists(errorsPath)) ? lines(await readFile(errorsPath, 'utf8')).map(line => { try { return JSON.parse(line); } catch { return { message: line }; } }) : [];
  // A duplicate key is a precedence decision the caller makes below; anything else means the capture is partial.
  const otherErrors = exportErrors.filter(issue => !String(issue.message ?? '').startsWith('Duplicate dictionary key'));
  if (otherErrors.length) throw new Error(`The export reported ${otherErrors.length} problem(s) in errors.jsonl, for example ${JSON.stringify(otherErrors[0].message ?? otherErrors[0])}; it is a partial capture. Re-run it.`);
  const bytes = await readFile(sourcePath);
  const records = lines(bytes.toString('utf8')).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`dictionary.jsonl line ${index + 1} is not valid JSON`); }
  });
  if (!records.length) throw new Error('dictionary.jsonl holds no records; an empty dictionary is not a capture');

  const byLanguage = new Map(), conflicts = new Map();
  let emptyPhrases = 0;
  for (const [index, record] of records.entries()) {
    const where = `record ${index + 1}`;
    if (typeof record.key !== 'string' || !record.key.trim()) throw new Error(`${where} has no key`);
    if (typeof record.language !== 'string' || !LANGUAGE.test(record.language)) throw new Error(`${where} (${record.key}) has no usable language`);
    if (record.phrase !== undefined && record.phrase !== null && typeof record.phrase !== 'string') throw new Error(`${where} (${record.key}) has a non-text phrase`);
    const phrase = record.phrase ?? '';
    if (phrase === '') emptyPhrases++;
    const map = byLanguage.get(record.language) ?? byLanguage.set(record.language, new Map()).get(record.language);
    if (map.has(record.key)) {
      const found = conflicts.get(record.language + '\0' + record.key) ?? { language: record.language, key: record.key, phrases: [map.get(record.key)] };
      found.phrases.push(phrase); conflicts.set(record.language + '\0' + record.key, found);
      if (options.duplicates === 'last') map.set(record.key, phrase);
    } else map.set(record.key, phrase);
  }
  if (conflicts.size && options.duplicates === 'fail') throw new Error(`${conflicts.size} duplicate dictionary key(s), for example ${[...conflicts.values()][0].language}/${[...conflicts.values()][0].key}; choose precedence with --duplicates first|last`);

  const languages = {}, staging = `${output}.partial-${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(join(staging, options.site), { recursive: true });
    for (const [language, map] of [...byLanguage].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sorted = Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));
      const text = JSON.stringify(sorted, null, 2) + '\n';
      await writeFile(join(staging, options.site, `${language}.json`), text);
      languages[language] = { keys: map.size, sha256: createHash('sha256').update(text).digest('hex') };
    }
    const manifest = {
      version: 1, site: options.site, source: { file: 'dictionary.jsonl', sha256: createHash('sha256').update(bytes).digest('hex'), records: records.length },
      duplicates: options.duplicates, resolvedConflicts: [...conflicts.values()], emptyPhrases, exportProblems: exportErrors.length, languages,
    };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(staging, output);
    return { valid: true, output, site: options.site, languages, conflicts: conflicts.size, emptyPhrases, records: records.length };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await buildMockDictionary(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.log(JSON.stringify({ valid: false, errors: [error.message] })); process.exitCode = 1; }
}
