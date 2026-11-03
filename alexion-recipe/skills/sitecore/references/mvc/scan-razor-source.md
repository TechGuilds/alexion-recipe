# Native Razor source inspection

`sitecore/scripts/analysis/analyze-dotnet.mjs` runs the retained Roslyn analyzer locally using an explicitly supplied native executable, .NET runtime plus assembly, or immutable Docker image. It preserves the raw structured result and adds rendering joins and coverage diagnostics. It has no regex fallback when Roslyn is unavailable. Available LSP/native reads may supplement the report; they do not certify equivalent coverage.

Take `roots.source` and the source revision from `${MIGRATION_STATE_FILE_DIR}/context.json`. Inventory csproj, cshtml, cs, config and bundle files, excluding generated/build/vendor paths explicitly. Read rendering catalog Controller, Controller Action and Path fields before locating code. Use exact qualified types where available; duplicate short names and overloads are unresolved until disambiguated.

For each rendering, save source file/line evidence for controller action, explicit view or verified convention, model directive, Glass attributes, field constants, helper calls, partials, placeholders, sections, styles and external dependencies. Follow referenced partials and model getters. Reconcile fields across Razor, controllers, item models and constants against template IDs and captured layout fields.

Record helper invocations verbatim using the vocabulary in [analysis](analysis.md). Dynamic expressions, runtime view selection, reflection, unresolved dependencies and unavailable C# projects are explicit unknowns. Search results identify candidates; they do not certify absence.

Write the resulting report into the assigned evidence directory. The raw analyzer object is under `result`; rendering joins are under `mapping.renderings`; discrete resolver records remain under `result.contentResolvers`, separate from controller/action evidence. Use these JSON pointers to produce targeted downstream evidence. Do not create task state. The hub decides work items from this inventory.

## Dependency delivery without a removed SDK

Requires Node 20+ (tested with Node 24.15.0), and one explicitly supplied runtime. Docker mode was tested on Linux arm64 via Docker Desktop; host .NET is not needed. The wrapper itself has no npm dependencies.

The retained analyzer project targets .NET 8, Microsoft.CodeAnalysis.CSharp 4.9.2 and System.Text.Json 8.0.5. `sitecore/tests/dotnet.packages.lock.json` pins transitive packages and content hashes; `dotnet.Dockerfile` restores with `--locked-mode` and pins the SDK base to `mcr.microsoft.com/dotnet/sdk@sha256:d80fdd84f7e18eea12f8e45c52914f1353395009c95c41197178ea19944e6d48` (tested SDK 8.0.422). It publishes the analyzer in the image, never under the application or removed SDK paths.

From the repository, set `sitecore_skill` to the absolute retained skill directory. This creates a separate build context from the pinned baseline; it does not modify retained source:

```sh
sitecore_skill=/absolute/repo/packages/kajoo-recipes/recipes/sitecore-migration-v2/skills/sitecore
dotnet_build=$(mktemp -d)
git archive 0f107ac46 deps/roslyn-analyzer | tar -x -C "$dotnet_build"
cp "$sitecore_skill/tests/dotnet.packages.lock.json" "$dotnet_build/deps/roslyn-analyzer/packages.lock.json"
docker build -f "$sitecore_skill/tests/dotnet.Dockerfile" -t kajoo-local-roslyn:baseline "$dotnet_build/deps/roslyn-analyzer"
docker image inspect kajoo-local-roslyn:baseline --format '{{.Id}}'
```

Use the returned `sha256:...` image ID for execution. A tag alone is rejected. For another machine, deliver the image with `docker save`/`docker load` or use a registry digest; record the image digest, analyzer source revision and lockfile together. The build needs access to the pinned base and NuGet packages (or local caches); analysis runs with network disabled. The Docker image intentionally includes the pinned .NET SDK/runtime to avoid an implicit runtime dependency. No historical `build-local.sh` invocation is required, since that script writes into a retired MCP binary location.

For native/.NET mode, deliver the complete `dotnet publish` output separately and verify its checksum/runtime architecture. Supply either `--runtime native --executable /absolute/roslyn-analyzer` for a compatible native/self-contained build, or `--runtime dotnet --executable /absolute/dotnet --assembly /absolute/roslyn-analyzer.dll` for a framework-dependent publish. Do not pass `dotnet run` or the target application's project. Native runtime configurations are caller-trusted; Docker provides an additional read-only container boundary.

## Invocation and catalog

```sh
node "$sitecore_skill/scripts/analysis/analyze-dotnet.mjs" \
  --root /absolute/source --revision BASELINE_LABEL \
  --runtime docker --executable /usr/local/bin/docker \
  --image sha256:REPLACE_WITH_BUILT_IMAGE_ID --assembly /app/roslyn-analyzer.dll \
  --catalog /absolute/evidence/renderings.jsonl \
  --output /absolute/evidence/dotnet-analysis.json
```

`--root`, `--output`, `--runtime` and an absolute `--executable` are required. Revision is an optional caller assertion, not independently verified. The report cannot overwrite any existing path or be inside source; output symlink paths are rejected. The source root is canonicalized; links encountered during traversal are omitted. The wrapper uses argument arrays without a shell, excludes generated/vendor directories, and cleans up its temporary snapshot. Docker sees only that snapshot at `/source`, mounted read-only, and a temporary `/tmp`; it has no source-root mount.

`--catalog` accepts a JSON array, `{renderings:[...]}`, or the `inspect-renderings` JSONL records. Each row needs string `id` and `name`. Historical fields `controller_class`, `controller_action`, `view_path`, `template_name`, `path` are supported, as are current SPE `templateName` and `fields.Controller`, `fields["Controller Action"]`, `fields.Path`. Full normalized records are retained as `catalogRecord`, including language/version and repeated IDs/names. Inspect the SPE summary/errors before passing JSONL: JSONL alone cannot certify the remote export's coverage. JSON envelopes declaring failure/partial coverage and malformed rows fail explicitly. Absent catalog yields `mapping.status: "skipped"`; an empty catalog is represented honestly, without invented renderings.

The join uses exact qualified controller identities, uniqueness-guarded short names, exact action names (overloads remain ambiguous), authoritative view paths or labeled explicit/convention candidates, and analyzer-resolved model FQNs. Shared-view lookup is used when a short explicit view has no controller-directory candidate. Duplicate suffixes never choose a first file. Glass models must already appear in the analyzer's attribute-derived result. Conflicting constants remain unresolved. Duplicate rendering rows remain separate. Dynamic helper/conditional view signals are diagnostics derived from the retained analyzer's text evidence, not additional semantic parsing.

## Limits and interpreting completeness

Defaults: 10,000 files, 2,097,152 bytes per file, 52,428,800 source bytes total, 100,000 visited entries, 100 directory levels, 60,000 ms runtime, and 33,554,432 output bytes. Flags are `--max-files`, `--max-file-bytes`, `--max-total-bytes`, `--max-entries`, `--max-depth`, `--timeout-ms`, `--max-output-bytes`. Output limit applies to child stdout/stderr together and to final report size. Files/counts/hashes and omissions are recorded under `scan`. Directory enumeration itself is not a streaming memory bound. Native process deadlines and Docker container cleanup are bounded.

Exit 0 means a report was created, including partial reports; exit 1 means fatal configuration/runtime/catalog/output failure. Inspect `scan.complete`, `mapping.complete`, diagnostics and top-level `complete`. Caps, unreadable inputs, symlinks, count mismatches, missing joins and dynamic/ambiguous selections are never clean absence evidence. Unknown raw Roslyn fields are retained; `result.meta` keeps original root/timing values, so full reports are not byte-identical across runs. Source files are identified by stable relative paths and SHA256 hashes.

The retained analyzer parses C# syntax trees but does not compile the application or emit parse diagnostics; malformed C# may produce partial AST facts without a diagnostic. It reports only the first controller per C# file and does not resolve runtime action selection/DI. Its Razor extractor is pattern-based within the real analyzer; full Razor semantic parsing is not claimed. These limitations are exposed in `engine` even when scan/join coverage is complete. No wrapper can establish that missing syntax facts are absent while those analyzer limitations remain. Follow up with an authorized analyzer change or explicit manual/LSP evidence, never silently replace the Roslyn run.
