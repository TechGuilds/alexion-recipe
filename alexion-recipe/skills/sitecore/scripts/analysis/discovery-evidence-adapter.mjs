#!/usr/bin/env node

/*
 * Normalize the terminal export of xp-discovery-v3.ps1.
 *
 * This adapter is deliberately an indexer, not a data generator. The
 * collector's raw contract is a set of named report files (it
 * intentionally does not emit content-items.jsonl), so the adapter preserves
 * those bytes and records hashes/counts without inventing normalized rows.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseRenderingInstances, parseRenderingVariants } from "./rendering-evidence.mjs";

const REQUIRED_FILES = [
  "metadata-stats.json",
  "serialization-config.json",
  "rendering-usage.jsonl",
  "rendering-details.json",
  "rendering-page-mapping.json",
  "template-definitions.json",
  "placeholder-usage.json",
  "placeholder-settings.json",
  "branch-templates.json",
  "rendering-resolvers.jsonl",
  "rendering-resolver-details.json",
  "migration-manifest.json",
  "duplicate-items.json",
  "xp-only-template-audit.json",
  "sxa-readiness.json",
  "sxa-conversion-inputs.json",
];

function usage(message) {
  throw new Error(
    message +
      "\nUsage: node discovery-evidence-adapter.mjs --input <terminal-export.json> --root <downloaded-export-dir> --output <manifest.json>",
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith("--") || value === undefined) {
      usage("Invalid argument near " + (key || "<end>"));
    }
    parsed[key.slice(2)] = value;
  }
  if (!parsed.input || !parsed.root || !parsed.output) {
    usage("input, root and output are required");
  }
  return parsed;
}

function safeWithin(root, candidate) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathForFile(root, entry) {
  const name = String(entry?.name || "");
  const path = String(entry?.path || name);
  if (!name || !path || path.includes("\\0")) {
    throw new Error("Export file has no safe name/path");
  }
 const flatCandidate = resolve(root, name);
 const candidate = resolve(root, path);
  const pathLooksNested = path !== name && (path.includes("/") || path.includes("\\"));
  if (pathLooksNested && safeWithin(root, candidate) && existsSync(candidate)) {
    return candidate;
  }
  if (safeWithin(root, flatCandidate)) {
    return flatCandidate;
  }
  if (!safeWithin(root, candidate)) {
    throw new Error("Export path escapes root: " + path);
 }
 return candidate;
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const inputPath = resolve(options.input);
  const root = resolve(options.root);
  const outputPath = resolve(options.output);
  const terminal = JSON.parse(await readFile(inputPath, "utf8"));
 const files = Array.isArray(terminal.files)
   ? terminal.files
    : [];

  const seenNames = new Set();
  const indexed = [];
  const resolvedFiles = new Map();
  const gaps = [];
  for (const entry of files) {
    const name = String(entry?.name || "");
    if (!name || seenNames.has(name)) {
      gaps.push({ type: "invalid-export-entry", name: name || null });
      continue;
    }
    seenNames.add(name);
    const file = pathForFile(root, entry);
    let size;
    let hash;
   try {
     size = (await stat(file)).size;
     hash = await sha256(file);
   } catch (error) {
      gaps.push({
        type: "missing-export-file",
        name,
        path: entry.path,
        message: String(error.message || error),
      });
     continue;
   }
    const expectedSize = Number(entry?.size);
    const expectedHash = String(entry?.sha256 || entry?.Sha256 || "").toLowerCase();
    if (Number.isFinite(expectedSize) && expectedSize >= 0 && size !== expectedSize) {
      gaps.push({ type: "size-mismatch", name, expected: expectedSize, actual: size });
    }
    if (expectedHash && expectedHash !== hash.toLowerCase()) {
      gaps.push({ type: "hash-mismatch", name, expected: expectedHash, actual: hash });
    }
    resolvedFiles.set(name, file);
   indexed.push({
     name,
     rootPath: entry.rootPath || "Data",
     path: entry.path || name,
     size,
     sha256: hash,
     required: REQUIRED_FILES.includes(name),
    });
  }

  const byName = new Map(indexed.map((file) => [file.name, file]));
  for (const name of REQUIRED_FILES) {
    const file = byName.get(name);
    if (!file) gaps.push({ type: "missing-required-file", name });
    else if (file.size === 0) gaps.push({ type: "empty-required-file", name });
  }

  const metadata = await readJsonIfPresent(join(root, "metadata-stats.json"));
  const migration = await readJsonIfPresent(join(root, "migration-manifest.json"));
  // New streamed exports are deliberately strict: their collector metadata
  // lives in summary. Retain legacy fallbacks so an older stored terminal
  // export can still be indexed during a resume.
  const summary = terminal.summary && typeof terminal.summary === "object" ? terminal.summary : {};
  const scope = summary.scope && typeof summary.scope === "object" ? summary.scope : {};
  const detail = await readJsonIfPresent(resolvedFiles.get("rendering-details.json") ?? join(root,"rendering-details.json"));
  const enhanced = summary.discoveryEvidenceVersion === 2;
  const enhancedFiles = ["rendering-instances.jsonl", "rendering-variants.json"];
  if (enhanced) {
    for (const name of enhancedFiles) {
      const file = byName.get(name);
      if (!file) { gaps.push({type:"missing-required-file",name}); continue; }
      file.required = true;
      try {
        const text = (await readFile(resolvedFiles.get(name), "utf8")).replace(/^\uFEFF/, "");
        if (name.endsWith(".jsonl")) parseRenderingInstances(text);
        else parseRenderingVariants(text);
      } catch(error) { gaps.push({type:"invalid-rendering-evidence",name,message:error.message}); }
    }
  }
  const renderingEvidence = {
    version: enhanced ? 2 : 1,
    occurrenceEvidenceAvailable: byName.has("rendering-instances.jsonl"),
    variantEvidenceAvailable: byName.has("rendering-variants.json"),
    inventoryComplete: detail?.inventory_scan_complete ?? summary.inventoryScanComplete ?? null,
    usageComplete: detail?.usage_scan_complete ?? summary.usageScanComplete ?? null,
    configuredRoots: detail?.configured_roots ?? [],
    effectiveRoots: detail?.effective_roots ?? [],
    unresolvedReferences: detail?.unresolved_rendering_references ?? detail?.unresolved_references ?? summary.unresolvedRenderingReferences ?? [],
    limitations: enhanced ? [] : ["Legacy discovery export has no guaranteed occurrence or variant evidence; do not infer complete variant coverage."],
  };
  const terminalSuccess = terminal.Success === true || terminal.success === true || summary.success === true;
  if (!terminalSuccess) gaps.push({ type: "non-terminal-or-failed-export" });
 const success = terminalSuccess && gaps.length === 0;
  const result = {
    version: 1,
    mode: "dependency-driven-compatible",
    collector: "xp-discovery-v3",
    collectionMode: "dependency-driven-folder-traversal",
    terminalSuccess,
    renderingEvidence,
    discoveryReady: success,
    synthesisReady: success,
    deliverablesReady: false,
    scope: {
      siteRootPath: terminal.SiteRootPath || terminal.siteRootPath || scope.siteRootPath || summary.siteRootPath || null,
      database: terminal.Database || terminal.database || scope.database || summary.database || null,
      language: terminal.Language || terminal.language || scope.language || summary.language || null,
    },
    statistics: terminal.Statistics || terminal.statistics || summary.statistics || metadata?.statistics || null,
    migrationManifestSummary: migration?.migration_manifest || null,
    files: indexed,
    gaps,
    notes: [
      "The collector intentionally does not emit content-items.jsonl; folder-traversal and migration-manifest evidence are preserved instead.",
      "deliverablesReady is false until downstream dependency closure, target assessment and authenticated delivery are completed.",
      "Optional layout, dictionary and rich-text enrichments are not part of this core collector gate.",
    ],
  };
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: outputPath,
      discoveryReady: result.discoveryReady,
      fileCount: indexed.length,
      gapCount: gaps.length,
    }),
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write((error.stack || error) + "\n");
    process.exitCode = 1;
  });
}

export { REQUIRED_FILES, pathForFile };
