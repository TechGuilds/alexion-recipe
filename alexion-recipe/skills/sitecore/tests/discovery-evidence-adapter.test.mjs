import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, "../scripts/analysis/discovery-evidence-adapter.mjs");
const inventory = join(here, "../references/discovery/discovery-script-inventory.md");
const collector = join(here, "../scripts/analysis/xp-discovery-v3.ps1");

const required = [
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

test("the migrated collector keeps the dependency-driven script and output inventory", async () => {
  const script = await readFile(collector, "utf8");
  const ledger = await readFile(inventory, "utf8");
  assert.match(script, /\.INJECTED_VARIABLES/);
  assert.match(script, /kind\s*=\s*'kajoo-export'/);
  assert.match(script, /GetDescendants/);
  assert.match(script, /Set-Content\s+-Path\s+\$duplicateItemsFile\s+-Value\s+'\[\]'/);
  const exportStart = script.indexOf("# The exported envelope is validated strictly");
  const exportEnd = script.indexOf("catch {", exportStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart, "expected the strict success export block");
  const successExport = script.slice(exportStart, exportEnd);
  for (const legacyTopLevelField of [
    "Success",
    "Output",
    "SiteRootPath",
    "Database",
    "Language",
    "OutputPath",
    "Statistics",
    "RootPaths",
    "DuplicateItems",
    "InstanceCapabilities",
    "XpOnlyTemplateAudit",
    "SxaReadiness",
  ]) {
    assert.doesNotMatch(successExport, new RegExp(`^ {8}${legacyTopLevelField}\\s*=`, "m"));
  }
  for (const name of required) assert.match(script, new RegExp(name.replace(".", "\\.")));
 assert.match(ledger, /xp-discovery-v3\.ps1/);
 assert.match(ledger, /hotfix-discover-layouts\.ps1/);
 assert.match(ledger, /analyze-source\.mjs/);
  assert.match(ledger, /analyze-layout\.mjs/);
  assert.match(ledger, /analyze-dotnet\.mjs/);
  assert.match(ledger, /fetch-layouts\.mjs/);
  assert.match(ledger, /get-rendering-source-keys\.ps1/);
});

test("the adapter accepts the strict terminal export envelope and verifies every file", async () => {
  const root = await mkdtemp(join(tmpdir(), "kajoo-discovery-evidence-"));
  try {
   for (const name of required) {
     await writeFile(join(root, name), name === "rendering-usage.jsonl" ? "{}\n" : "{}\n");
   }
    await mkdir(join(root, "auditreports", "run"), { recursive: true });
    await writeFile(join(root, "auditreports", "run", "metadata-stats.json"), JSON.stringify({ statistics: { total_items: 2 } }));
   await writeFile(join(root, "metadata-stats.json"), JSON.stringify({ statistics: { total_items: 2 } }));
    const input = join(root, "terminal.json");
    const output = join(root, "discovery-evidence-manifest.json");
    await writeFile(
      input,
      JSON.stringify({
        kind: "kajoo-export",
        version: 1,
        summary: {
          success: true,
          scope: {
            siteRootPath: "/sitecore/content/Demo",
            database: "master",
            language: "en",
          },
          statistics: { TotalItems: 2 },
        },
        files: required.map((name) => ({
          rootPath: "Data",
          path: name === "metadata-stats.json" ? "auditreports/run/metadata-stats.json" : name,
          name,
        })),
      }),
    );
    await execFileAsync(process.execPath, [adapter, "--input", input, "--root", root, "--output", output]);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.discoveryReady, true);
    assert.equal(manifest.synthesisReady, true);
    assert.equal(manifest.files.length, required.length);
    assert.equal(manifest.scope.siteRootPath, "/sitecore/content/Demo");
    assert.deepEqual(manifest.statistics, { TotalItems: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the adapter records declared size and hash mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "kajoo-discovery-evidence-mismatch-"));
  try {
    const input = join(root, "terminal.json");
    const output = join(root, "discovery-evidence-manifest.json");
    await writeFile(join(root, "metadata-stats.json"), "{}");
    await writeFile(input, JSON.stringify({
      kind: "kajoo-export",
      version: 1,
      Success: true,
      files: [{ name: "metadata-stats.json", path: "metadata-stats.json", size: 99, sha256: "0".repeat(64) }],
    }));
    await execFileAsync(process.execPath, [adapter, "--input", input, "--root", root, "--output", output]);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.ok(manifest.gaps.some((gap) => gap.type === "size-mismatch"));
    assert.ok(manifest.gaps.some((gap) => gap.type === "hash-mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the adapter keeps missing required reports as an incomplete result", async () => {
  const root = await mkdtemp(join(tmpdir(), "kajoo-discovery-evidence-gap-"));
  try {
    const input = join(root, "terminal.json");
    const output = join(root, "discovery-evidence-manifest.json");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "metadata-stats.json"), "{}");
    await writeFile(
      input,
      JSON.stringify({
        kind: "kajoo-export",
        version: 1,
        Success: true,
        files: [{ rootPath: "Data", path: "metadata-stats.json", name: "metadata-stats.json" }],
      }),
    );
    await execFileAsync(process.execPath, [adapter, "--input", input, "--root", root, "--output", output]);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.discoveryReady, false);
    assert.ok(manifest.gaps.some((gap) => gap.type === "missing-required-file"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("enhanced collector retains rendering inventory, occurrence and diagnostic contracts", async () => {
  const script = await readFile(collector, "utf8");
  for (const name of ["RenderingRootsJson", "Write-RenderingInstanceEvidence", "Get-RenderingVariantEvidence", "Get-DefinitionItemSafe", "Register-UnresolvedRenderingReference", "Get-ValidatedRenderingRoot"])
    assert.ok(script.includes(name), name);
  assert.match(script, /rendering-instances\.jsonl/);
  assert.match(script, /rendering-variants\.json/);
  assert.match(script, /discoveryEvidenceVersion\s*=\s*2/);
  assert.doesNotMatch(script, /throw "Unresolved (datasource|parameters) template/);
});

test("enhanced export requires occurrence and variant reports without blocking on reference warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "kajoo-discovery-enhanced-"));
  try {
    const files = [...required, "rendering-instances.jsonl", "rendering-variants.json"];
    for (const name of files) await writeFile(join(root, name), "{}\n");
    await writeFile(join(root, "rendering-instances.jsonl"), "");
    await writeFile(join(root, "rendering-variants.json"), JSON.stringify({schemaVersion:1,variants:[],unresolvedReferences:[]}));
    await writeFile(join(root, "rendering-details.json"), JSON.stringify({inventory_scan_complete:false,usage_scan_complete:true,configured_roots:["/sitecore/layout/Renderings/Feature/Shared"],effective_roots:["/sitecore/layout/Renderings/Feature/Shared"],unresolved_references:[{id:"missing",reason:"Datasource template could not be resolved"}]}));
    const input = join(root, "terminal.json"), output = join(root, "manifest.json");
    await writeFile(input, JSON.stringify({kind:"kajoo-export",version:1,summary:{success:true,discoveryEvidenceVersion:2},files:files.map(name=>({name,path:name}))}));
    await execFileAsync(process.execPath,[adapter,"--input",input,"--root",root,"--output",output]);
    const manifest=JSON.parse(await readFile(output,"utf8"));
    assert.equal(manifest.discoveryReady,true);
    assert.deepEqual(manifest.renderingEvidence.configuredRoots,["/sitecore/layout/Renderings/Feature/Shared"]);
    assert.equal(manifest.renderingEvidence.inventoryComplete,false);
    assert.equal(manifest.renderingEvidence.unresolvedReferences.length,1);
    await rm(join(root,"rendering-variants.json"));
    const second=join(root,"missing.json");
    await execFileAsync(process.execPath,[adapter,"--input",input,"--root",root,"--output",second]);
    const missing=JSON.parse(await readFile(second,"utf8"));
    assert.equal(missing.discoveryReady,false);
    assert.ok(missing.gaps.some(g=>g.name==='rendering-variants.json'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
