#!/usr/bin/env node

/**
 * Capture Sitecore JSS Layout Service responses into the mock-layout tree.
 *
 * This recipe-owned helper keeps the sitemap-first, GraphQL-fallback,
 * homepage-first and route-cache behavior, but uses Node's fetch instead of
 * shelling out to curl and never accepts a credential in the parameter file.
 *
 * Run from a foreground Bash command with the source connector attached:
 *   node fetch-layouts.mjs --params /evidence/layout-fetch-params.json
 *
 * The Bash tool injects SOURCE_SITECORE_GRAPHQL_API_KEY from the connector.
 * Parameters contain only non-secret scope and output information.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { prepareCaptureRequest } from './prepare-capture-request.mjs';
import { validateCapturePlan } from './rendering-coverage.mjs';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
export const GRAPHQL_API_KEY_ENV = 'SOURCE_SITECORE_GRAPHQL_API_KEY';

/** @typedef {{
 * sitemapUrl?: string,
 * layoutServiceUrl: string,
 * graphqlUrl?: string,
 * siteName: string,
 * language?: string,
 * outputDir: string,
 * startIndex?: number,
 * maxUrls?: number,
 * routes?: string[],
 * timeoutMs?: number,
 * maxResponseBytes?: number,
 * }} FetchLayoutsParams */

/** @typedef {{
 * totalUrls: number,
 * attemptedUrls: number,
 * discoveredUrlCount: number,
 * maxUrlsApplied: boolean,
 * maxUrls: number | null,
 * successCount: number,
 * errorCount: number,
 * skippedCount: number,
 * durationMs: number,
 * outputDir: string,
 * sitemapUrl: string | null,
 * siteName: string,
 * language: string,
 * startIndex: number,
 * discoverySource: 'routes' | 'sitemap' | 'graphql',
 * errors: string[],
 * }} FetchLayoutsResult */

function usage() {
  return [
    'Usage: node fetch-layouts.mjs --params <json-file>',
    '',
    'The JSON file must contain layoutServiceUrl, siteName and outputDir.',
    'Use capturePlanFile for exact approved-plan capture (uncapped by default).',
    'Legacy sitemap/routes mode defaults maxUrls to 25; use 0 for all.',
    'The source connector must be attached to Bash as mcpCredentials.source.',
  ].join('\n');
}

export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const index = argv.indexOf('--params');
  if (index < 0 || !argv[index + 1]) {
    throw new Error(`${usage()}\nMissing --params <json-file>.`);
  }
  if (argv.length !== index + 2) {
    throw new Error(`${usage()}\nUnexpected arguments.`);
  }
  return { paramsPath: argv[index + 1] };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function numberOrUndefined(value, name, { integer = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a finite ${integer ? 'integer' : 'number'}`);
  }
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

export function validateParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('params must be a JSON object');
  }
  if ('apiKey' in input || 'accessToken' in input || 'password' in input) {
    throw new Error('Credentials must not be placed in params; attach the source connector to Bash');
  }
  if (Object.hasOwn(input, 'capturePlanFile') && !isNonEmptyString(input.capturePlanFile)) throw new Error('capturePlanFile must be a non-empty absolute path');
  const params = /** @type {FetchLayoutsParams} */ (input);
  if (!isNonEmptyString(params.layoutServiceUrl)) throw new Error('layoutServiceUrl is required');
  if (!isNonEmptyString(params.siteName)) throw new Error('siteName is required');
  if (!isNonEmptyString(params.outputDir)) throw new Error('outputDir is required');
  for (const [key, value] of [['sitemapUrl', params.sitemapUrl], ['graphqlUrl', params.graphqlUrl]]) {
    if (value !== undefined && !isNonEmptyString(value)) throw new Error(`${key} must be a non-empty string`);
  }
  if (params.routes !== undefined && (!Array.isArray(params.routes) || params.routes.some((route) => !isNonEmptyString(route)))) {
    throw new Error('routes must be an array of non-empty route strings');
  }
  if (params.routes?.some((route) => {
    const normalized = route.startsWith('/') ? route : `/${route}`;
    return normalized.includes('?') || normalized.includes('#') || normalized.split('/').some((part) => part === '..' || part === '.');
  })) {
    throw new Error('routes must be absolute paths without query, fragment or traversal');
  }
  const startIndex = numberOrUndefined(params.startIndex, 'startIndex', { min: 1 }) ?? 1;
  // Match the bounded collector contract: 25 routes by default; 0 is an
  // explicit request to remove the cap for a full route scope.
  const maxUrls = params.maxUrls === 0
    ? undefined
    : numberOrUndefined(params.maxUrls, 'maxUrls', { min: 1 }) ?? (params.capturePlanFile ? undefined : 25);
  const timeoutMs = numberOrUndefined(params.timeoutMs, 'timeoutMs', { min: 1000, max: 600000 }) ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = numberOrUndefined(params.maxResponseBytes, 'maxResponseBytes', { min: 1024, max: MAX_RESPONSE_BYTES }) ?? MAX_RESPONSE_BYTES;
  return {
    ...params,
    language: params.language || 'en',
    startIndex,
    maxUrls,
    timeoutMs,
    maxResponseBytes,
  };
}

function requireHttpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use HTTP(S)`);
  return url;
}

export function layoutEndpoint(layoutServiceUrl) {
  const url = requireHttpUrl(layoutServiceUrl, 'layoutServiceUrl');
  if (url.pathname.includes('/sitecore/api/layout/render')) return url.toString().replace(/\/$/, '');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/sitecore/api/layout/render/jss`;
  return url.toString().replace(/\/$/, '');
}

function graphEndpoint(params) {
  if (params.graphqlUrl) return requireHttpUrl(params.graphqlUrl, 'graphqlUrl').toString().replace(/\/$/, '');
  const url = new URL(layoutEndpoint(params.layoutServiceUrl));
  const basePath = url.pathname.split('/sitecore/api/layout/render')[0].replace(/\/$/, '');
  url.pathname = `${basePath}/sitecore/api/graph/edge`;
  url.search = '';
  return url.toString();
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function readResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  return body.toString('utf8');
}

async function fetchText(url, { timeoutMs, maxResponseBytes }) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'text/xml,application/xml,text/plain,*/*' }, signal: timeout.signal });
    const body = await readResponse(response, maxResponseBytes);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } finally { timeout.clear(); }
}

async function fetchJson(url, { timeoutMs, maxResponseBytes }) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: timeout.signal });
    const body = await readResponse(response, maxResponseBytes);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try { return JSON.parse(body); } catch { throw new Error('response was not valid JSON'); }
  } finally { timeout.clear(); }
}

export function parseSitemapUrls(xml) {
  const urls = [];
  const regex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = regex.exec(xml.replace(/\r/g, ''))) !== null) urls.push(match[1]);
  const unique = [];
  const seen = new Set();
  for (const value of urls) {
    const parsed = requireHttpUrl(value, 'sitemap URL');
    const key = parsed.pathname;
    if (!seen.has(key)) { seen.add(key); unique.push(parsed.toString()); }
  }
  return unique;
}

function routePathFromUrl(value) {
  const pathname = new URL(value).pathname;
  const decoded = decodeURIComponent(pathname || '/');
  if (!decoded.startsWith('/') || decoded.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`unsafe route path: ${decoded}`);
  }
  return decoded || '/';
}

function fileForRoute(outputDir, route) {
  const clean = route === '/' ? 'home' : route.replace(/^\/+|\/+$/g, '');
  const file = resolve(join(outputDir, clean, 'index.json'));
  const root = resolve(outputDir);
  const rel = relative(root, file);
  if (rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`unsafe output route: ${route}`);
  return file;
}

function layoutUrl(endpoint, apiKey, siteName, language, route) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ sc_apikey: apiKey, sc_site: siteName, sc_lang: language, item: route }).toString();
  return url;
}

async function fetchUrlsFromGraphQL(params, apiKey) {
  const endpoint = graphEndpoint(params);
  const layout = layoutEndpoint(params.layoutServiceUrl);
  const homepage = layoutUrl(layout, apiKey, params.siteName, params.language, '/');
  const home = await fetchJson(homepage, params);
  const rawId = home?.sitecore?.route?.itemId ?? home?.itemId;
  if (!rawId) throw new Error('Homepage layout response missing sitecore.route.itemId');
  const formattedId = String(rawId).replace(/[{}\-]/g, '').toLowerCase();
  const paths = [];
  let after;
  let hasNext = true;
  while (hasNext) {
    const query = `{
      search(where:{AND:[{name:"_path",value:${JSON.stringify(formattedId)}},{name:"_language",value:${JSON.stringify(params.language)}},{name:"_hasLayout",value:"true"}]},first:100${after ? `,after:${JSON.stringify(after)}` : ''}) {
        total pageInfo { endCursor hasNext } results { url { path } }
      }
    }`;
    const timeout = withTimeout(params.timeoutMs);
    let response;
    try {
      const requestUrl = new URL(endpoint);
      requestUrl.searchParams.set('sc_apikey', apiKey);
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: timeout.signal,
      });
      const body = await readResponse(response, params.maxResponseBytes);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = JSON.parse(body);
      const search = data?.data?.search;
      if (!search) throw new Error(`Unexpected GraphQL response: ${JSON.stringify(data?.errors || data).slice(0, 200)}`);
      for (const result of search.results || []) if (result?.url?.path) paths.push(`${new URL(params.layoutServiceUrl).origin}${result.url.path}`);
      hasNext = Boolean(search.pageInfo?.hasNext);
      after = search.pageInfo?.endCursor || undefined;
    } finally { timeout.clear(); }
  }
  return paths;
}

export function scopeDiscoveredUrls(urls, layoutServiceUrl, maxUrls) {
  const unique = [];
  const seen = new Set();
  for (const value of urls) {
    const key = routePathFromUrl(value);
    if (!seen.has(key)) { seen.add(key); unique.push(value); }
  }
  // The historical collector always fetched the homepage first, even when
  // a supplied route list/sitemap omitted it. Count that request in the
  // same scope used by the completeness gate.
  if (!seen.has('/')) unique.unshift(`${new URL(layoutServiceUrl).origin}/`);
  const discoveredUrlCount = unique.length;
  const selected = maxUrls ? unique.slice(0, maxUrls) : unique;
  return {
    urls: selected,
    discoveredUrlCount,
    maxUrlsApplied: selected.length < discoveredUrlCount,
  };
}

async function discoverUrls(params, apiKey, outputDir) {
  if (params.routes?.length) {
    return { source: 'routes', ...scopeDiscoveredUrls(params.routes.map((route) => {
      const normalized = route.startsWith('/') ? route : `/${route}`;
      return `${new URL(params.layoutServiceUrl).origin}${normalized}`;
    }), params.layoutServiceUrl, params.maxUrls) };
  }
  if (params.sitemapUrl) {
    try {
      const xml = await fetchText(params.sitemapUrl, params);
      writeFileSync(join(outputDir, 'sitemap.xml'), xml, 'utf8');
      const urls = parseSitemapUrls(xml);
      if (!urls.length) throw new Error('No URLs found in sitemap');
      return { source: 'sitemap', ...scopeDiscoveredUrls(urls, params.layoutServiceUrl, params.maxUrls) };
    } catch (error) {
      console.warn(`Sitemap discovery failed; using GraphQL fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const urls = await fetchUrlsFromGraphQL(params, apiKey);
  const deduped = parseSitemapUrls(urls.map((url) => `<loc>${url}</loc>`).join(''));
  return { source: 'graphql', ...scopeDiscoveredUrls(deduped, params.layoutServiceUrl, params.maxUrls) };
}

function assertSecret() {
  const value = process.env[GRAPHQL_API_KEY_ENV];
  if (!value) throw new Error(`${GRAPHQL_API_KEY_ENV} is missing; attach the source connector to Bash as mcpCredentials.source`);
  return value;
}

/** Capture exact approved identities into a fresh attempt directory. */
async function fetchPlannedLayouts(input) {
  if (input.routes !== undefined || input.sitemapUrl !== undefined || (input.startIndex ?? 1) !== 1) throw new Error('Plan capture cannot mix routes, sitemap or startIndex');
  const prepared = prepareCaptureRequest({ ...input, mode: 'headless' });
  const plan = validateCapturePlan(JSON.parse(readFileSync(prepared.capturePlanFile, 'utf8')));
  const pages = prepared.capturePages ?? plan.selectedPages.slice(0, prepared.maxUrls || undefined);
  const languages = [...new Set(pages.map((page) => page.language).filter(Boolean))];
  if (languages.length > 1 || (input.language && languages.some((lang) => lang !== input.language))) throw new Error('Capture requires a single matching page language');
  const params = validateParams({ ...prepared, language: input.language ?? languages[0] ?? 'en' });
  const endpoint = layoutEndpoint(params.layoutServiceUrl);
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search) throw new Error('Layout Service URL must not contain credentials or query parameters');
  const outputDir = resolve(params.outputDir);
  // Reject links in any existing ancestor before creating or writing outputs.
  const captureResultFile = resolve(prepared.captureResultFile ?? join(outputDir, 'capture-result.json'));
  for (const target of [outputDir, dirname(captureResultFile)]) for (let path = target; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Capture output ancestors must not be symbolic links');
    if (dirname(path) === path) break;
  }
  if (existsSync(captureResultFile)) throw new Error('captureResultFile must be new');
  const apiKey = assertSecret();
  mkdirSync(outputDir, { recursive: true });
  // Exclusive lock also prevents two requests from populating the same empty directory.
  writeFileSync(join(outputDir, '.capture-attempt'), plan.fingerprint, { flag: 'wx' });
  mkdirSync(dirname(captureResultFile), { recursive: true });
  writeFileSync(captureResultFile, '', { flag: 'wx' });
  const started = Date.now();
  const outcomes = [];
  const canonical = (value) => String(value ?? '').replace(/[{}-]/g, '').toLowerCase();
  for (const page of pages) {
    const identity = Object.fromEntries(['route', 'itemId', 'itemPath', 'language'].filter((key) => page[key] !== undefined).map((key) => [key, page[key]]));
    try {
      const payload = await fetchJson(layoutUrl(endpoint, apiKey, params.siteName, params.language, page.route), params);
      const route = payload?.sitecore?.route;
      if (!route || typeof route !== 'object' || Array.isArray(route) || !route.placeholders || typeof route.placeholders !== 'object') throw new Error('Response does not contain a valid Layout Service route');
      if (page.itemId && (!route.itemId || canonical(page.itemId) !== canonical(route.itemId))) throw new Error('Layout Service returned a different source item ID');
      const file = fileForRoute(outputDir, page.route);
      mkdirSync(dirname(file), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(payload, null, 2));
      writeFileSync(file, bytes, { flag: 'wx' });
      outcomes.push({ ...identity, status: 'captured', layoutFile: file, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error).split(apiKey).join('[redacted]');
      outcomes.push({ ...identity, status: 'failed', reason });
    }
  }
  const successCount = outcomes.filter((outcome) => outcome.status === 'captured').length;
  const result = {
    selection: 'discovery-plan', capturePlanFingerprint: plan.fingerprint,
    outputDir, siteName: params.siteName, language: params.language,
    outcomes, totalUrls: plan.selectedPages.length, discoveredUrlCount: plan.selectedPages.length,
    attemptedUrls: outcomes.length, successCount, errorCount: outcomes.length - successCount,
    skippedCount: Math.max(0, plan.selectedPages.length - outcomes.length),
    maxUrlsApplied: outcomes.length < plan.selectedPages.length, maxUrls: prepared.maxUrls ?? null,
    totalMaxUrls: prepared.totalMaxUrls ?? 0, previousCaptureResultFiles: prepared.previousCaptureResultFiles ?? [],
    durationMs: Date.now() - started, discoverySource: 'discovery-plan',
    errors: outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => `${outcome.route}: ${outcome.reason}`),
  };
  writeFileSync(captureResultFile, `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, captureResultFile };
}

/** @param {FetchLayoutsParams} input */
export async function fetchLayouts(input) {
  const params = validateParams(input);
  if (params.capturePlanFile) return fetchPlannedLayouts(input);
  const apiKey = assertSecret();
  const outputDir = resolve(params.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const started = Date.now();
  const errors = [];
  const discovered = await discoverUrls(params, apiKey, outputDir);
  const urls = discovered.urls;
  const discoveredUrlCount = discovered.discoveredUrlCount;
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  const fetchRoute = async (route, label) => {
    const file = fileForRoute(outputDir, route);
    if (existsSync(file)) { successCount += 1; return; }
    try {
      const payload = await fetchJson(layoutUrl(layoutEndpoint(params.layoutServiceUrl), apiKey, params.siteName, params.language, route), params);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      successCount += 1;
    } catch (error) {
      errorCount += 1;
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Keep homepage-first ordering and stable startIndex semantics.
  await fetchRoute('/', '/');
  for (let index = 0; index < urls.length; index += 1) {
    const route = routePathFromUrl(urls[index]);
    if (route === '/') continue;
    if (index + 1 < params.startIndex) {
      if (existsSync(fileForRoute(outputDir, route))) successCount += 1;
      else skippedCount += 1;
      continue;
    }
    await fetchRoute(route, route);
  }
  const result = /** @type {FetchLayoutsResult} */ ({
    totalUrls: discoveredUrlCount,
    attemptedUrls: urls.length,
    discoveredUrlCount,
    maxUrlsApplied: discovered.maxUrlsApplied,
    maxUrls: params.maxUrls ?? null,
    successCount,
    errorCount,
    skippedCount,
    durationMs: Date.now() - started,
    outputDir,
    sitemapUrl: params.sitemapUrl || null,
    siteName: params.siteName,
    language: params.language,
    startIndex: params.startIndex,
    discoverySource: discovered.source,
    errors,
  });
  return result;
}

/**
 * A bounded sample with one or more captured layouts is useful, partial
 * evidence. Per-route failures remain in Result.errors for the coordinator to
 * classify; they must not make Bash discard the usable result as a terminal
 * invocation failure. Discovery/authentication failures throw before a result
 * exists, while a completed run with zero captures remains a non-zero exit.
 *
 * @param {FetchLayoutsResult} result
 */
export function processExitCode(result) {
  return result.successCount > 0 || (result.selection === 'discovery-plan' && result.totalUrls === 0) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(usage()); process.exit(0); }
    const params = JSON.parse(readFileSync(args.paramsPath, 'utf8'));
    const result = await fetchLayouts(params);
    console.log(`Result: ${JSON.stringify(result, null, 2)}`);
    process.exitCode = processExitCode(result);
  } catch (error) {
    console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
