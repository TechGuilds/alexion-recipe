# Sitecore serialization scripts

These scripts provide local preparation, inspection, batch planning, remapping
and authenticated CLI execution. They preserve a strict boundary: discovery
scope and evidence enter as files; connector credentials exist only in the
foreground command environment that invokes the CLI wrapper.

| File | Inputs | Required outputs |
| --- | --- | --- |
| compile-serialization-scope.mjs | Collector `serialization-config.json` | Canonical, hash-bound recursive/exact Sitecore include scope with folded descendants and reviewed exclusion pointers |
| build-modules.mjs | Exact item binding or canonical serialization scope | One `.module.json` per namespace without changing declared include scopes, plus a `build-modules.json` summary |
| inspect-items.mjs | Module configs and captured serialized item directory | Namespace counts, ID/path/template index, dependency graph and invalid/duplicate item diagnostics |
| compile-task-scopes.mjs | Complete Discovery dependency index and approved task roots | Exact assigned item list, ownership/dependency diagnostics and a scope-ready gate before module generation/pull |
| plan-batches.mjs | Inspected namespaces/dependencies, batch size/runtime budget | Deterministic ordered exact namespace lists, counts, prerequisites, cycles and missing references |
| validate-transfer-plan.mjs | Captured items/modules plus a reviewed task plan | Exact task ownership, cross-task dependency closure, approved external prerequisites and a transfer-ready gate |
| remap-templates.mjs | Source capture, separate target-copy root, explicit from/to IDs and approved decision | Dry-run diff first, affected files/items, template-header edits, other occurrences for review, validation and backup references |
| prepare-cli-project.mjs | Validated module root, new project root, new evidence root | Copied module configs, pinned `sitecore.json`, project manifest hashes |
| run-cli-serialization.mjs | Prepared project, role, operation, new evidence root, optional exact namespaces | Sanitized CLI capability/login/pull/validate/push operation report |
| prepare-coverage-audit.mjs | Existing valid inspection report, new evidence root, optional approved source-to-target path map | Hash-bound target-count coverage plan without reopening or parsing source capture |

`compile-serialization-scope.mjs` is the normal collector-to-transfer handoff.
Collector folder includes default to `ItemAndDescendants`; evidence-backed
`SingleItem` and `DescendantsOnly` includes remain exact. It folds a nested
include only when an earlier include of the same kind already covers it, and
rejects incompatible nested kinds instead of guessing ownership. OOTB/platform
paths are **warned about**, not auto-excluded. Exclusion is a reviewed Discovery
scope decision, not something a transfer script can silently infer.

`build-modules.mjs` preserves the include scopes from a complete canonical
scope. Its legacy `{items:[{path,kind?}]}` mode remains `SingleItem`-only for
an explicitly approved narrow binding.

Default behavior must be non-mutating. Remaps cannot perform blind GUID replacement; reference fields and base-template lists need explicit handling. Reject source/output overlap and unsafe paths. Preserve unchanged YAML and config; report deterministic results and partial failures.

Preserve container-before-leaf, dependency and Helix ordering, but surface
cycles instead of promising success.

## Terminal content-coverage planning

The final Content Migration audit reuses current per-batch read-back evidence;
it must not repeat a per-item target retrieval or source-capture inspection for
the whole transferred scope. After all approved target batches are current,
prepare one aggregate target-count plan from the existing canonical inspection
report:

```sh
node /copied/sitecore/scripts/serialization/prepare-coverage-audit.mjs \
  --inspection-report /evidence/inspection/inspection.json \
  --output-root /evidence/terminal-audit-plan
```

When an approved target adoption maps a source path below a different target
path, provide a separate reviewed map. No target path is inferred:

```json
{
  "version": 1,
  "mappings": [
    {
      "sourcePrefix": "/sitecore/content/Example",
      "targetPrefix": "/sitecore/content/Tenant/Example"
    }
  ]
}
```

Pass the resulting `content-coverage-audit-plan.json` as `auditPlanJson` to
`../spe/audit-serialization-coverage.ps1` through the target PowerShell
connector. That script performs one aggregate root-count reconciliation.
Preserve its observation with the terminal audit, validate it against each
batch's latest read-back, and run an item-level target investigation only for a
stale, missing or count-mismatched batch.

Acceptance tests exercise malformed YAML, duplicate IDs, missing template,
cyclic inheritance, container ordering, scope-preserving remap, dry-run
non-mutation, project materialization, role separation and source/target
isolation through actual copied-script processes. No credentials belong in
processor inputs or reports.

## Installation and invocation

Use Node 22+. Copy this entire directory including package.json and package-lock.json; run `npm ci --ignore-scripts --no-audit --no-fund` inside that copy. The sole runtime dependency is locally pinned yaml@2.8.1. No repository imports or deprecated SDKs are used. Installation needs registry/cache access; processors operate offline.

Commands operating on captured YAML require explicit `--items-root`, `--modules-root` and `--output-root`. `compile-serialization-scope.mjs` requires `--serialization-config` and `--output-root`; `compile-task-scopes.mjs` instead requires `--dependency-index`, `--task-scope-plan` and `--output-root`. Use canonical absolute paths: symlink components (including macOS /var aliases) are rejected. Output must be disjoint from both inputs. Reports are exclusively created: choose a fresh output directory each run.

```sh
node /copied/sitecore/scripts/serialization/inspect-items.mjs --items-root /capture/items --modules-root /capture/modules --output-root /evidence/inspection-1
node /copied/sitecore/scripts/serialization/compile-serialization-scope.mjs --serialization-config /discovery/serialization-config.json --output-root /evidence/serialization-scope-1
node /copied/sitecore/scripts/serialization/compile-task-scopes.mjs --dependency-index /discovery/dependency-index.json --task-scope-plan /plans/content-task-scope.json --output-root /evidence/scope-1
node /copied/sitecore/scripts/serialization/plan-batches.mjs --items-root /capture/items --modules-root /capture/modules --output-root /evidence/plan-1 --batch-size 1000 --runtime-budget-seconds 300 --items-per-second 10
node /copied/sitecore/scripts/serialization/validate-transfer-plan.mjs --items-root /capture/items --modules-root /capture/modules --task-plan /plans/content-transfer-tasks.json --output-root /evidence/preflight-1
node /copied/sitecore/scripts/serialization/remap-templates.mjs --items-root /capture/items --modules-root /capture/modules --target-root /derived/items --output-root /evidence/preview-1 --from 11111111-1111-1111-1111-111111111111 --to 22222222-2222-2222-2222-222222222222
node /copied/sitecore/scripts/serialization/prepare-cli-project.mjs --modules-root /capture/modules --project-root /work/cli-project-1 --output-root /evidence/project-1
```

Use `run-cli-serialization.mjs` with `--operation probe`, `pull`, `validate`
or `push`. Do not make a standalone `login` call in the normal procedure:
`pull` and `push` authenticate themselves from the matching foreground Bash
`mcpCredentials` role. `validate` is local and must run without connector
credentials. `pull` accepts only `--role source`; `push` accepts only
`--role target`. `--include` is a comma-separated list of exact namespaces.
The wrapper initializes a prepared project once while its hash-bound
`sitecore.json` is unchanged, and redacts secret values from every report.

Review remap.json first. Repeat with a new output root and `--apply --approval decision-reference` to apply the reviewed decision. The target must still be absent. Approval is a recorded caller assertion, not an authorization service; compare source hashes against the preview before applying. There is no automatic approval persistence.

Exit 0 means local processing succeeded; 1 means invalid arguments/paths or fatal failure; 2 means diagnostics, non-ready plan or partial apply. Read the evidence report. Fatal errors print JSON to stderr.

## Canonical scope before task grouping

Before presenting the Content Migration workflow, compile the current
collector `serialization-config.json` once with
`compile-serialization-scope.mjs`. Retain both `serialization-scope.json` and
`serialization-scope-manifest.json` with the Discovery attempt. The compiler
is local and does not query either Sitecore instance or require normalized
dependency enrichment.

Use the canonical scope—not a task title or bare path list—to generate modules
for the one shared source capture. User-selected tasks then group the generated
namespaces for review and target mutation. A missing, stale, incomplete or
incompatible canonical scope returns to Discovery planning; Content Migration
never guesses recursion semantics from a raw path.

## Exact-item scope before task grouping

User-approved task grouping is a delivery and review boundary, never a reason
to reduce the content selected for transfer. An exact-item binding is optional
and is only needed for a deliberately narrow repair/remap that cannot be
represented by the canonical serialization scope. During Discovery workflow
planning—before the final plan is presented for approval—compile a version-1
task-scope plan against the complete same-run Discovery dependency index:

```json
{
  "version": 1,
  "tasks": [
    { "id": "content.backbone", "role": "transfer", "roots": ["/sitecore/templates/Project/<site>"], "dependsOn": [] },
    { "id": "content.site-root", "role": "transfer", "roots": ["/sitecore/content/<site>"], "dependsOn": ["content.backbone", "content.shared"] },
    { "id": "content.shared", "role": "transfer", "roots": ["/sitecore/content/Shared"], "dependsOn": [] },
    { "id": "content.audit", "role": "audit", "roots": [], "dependsOn": ["content.site-root"] }
  ],
  "approvedExclusions": [],
  "approvedExternalDependencies": []
}
```

The index must have `version: 1` and `status: "complete"`. A transfer task
must have roots; an audit task has no roots and owns no serialized items. The
compiler rejects overlapping roots, unassigned indexed items, dependencies
outside the approved scope without an explicit decision, and cross-task
dependencies that do not name an earlier task. An approved external
prerequisite is intentionally not assigned to a transfer task. It emits
`task-scope-manifest.json` plus exact `scope-items.json`. Retain those files
with the draft/approved workflow and feed that item list to
`build-modules.mjs` only for that narrow exact-item operation; do not build
modules from a task title, manually shortened list, or a different discovery
attempt. Content Migration validates and reuses this binding; it never
recreates it. The compiler is offline and never reads credentials or contacts
either Sitecore instance.

## Shared phase capture

After the user approves task grouping, perform one shared phase capture for
the complete approved scope: validate the canonical serialization scope (and
an optional exact-item binding only when applicable), generate all modules,
prepare one CLI project, probe, pull once, inspect, run
`validate-transfer-plan.mjs`, and produce one global `plan-batches.mjs` result.
Its manifests are immutable inputs to later target tasks. A target task selects
only its already-owned namespaces for local validation, dry-run, approved push
and read-back; it does not generate modules, pull source YAML, or recreate the
global plan. Recreate the shared capture only after an approved scope, remap or
task-boundary change invalidates its input hashes.

Canonical modules preserve their declared recursive or exact include semantics.
Exact `SingleItem` includes remain intentional for an approved narrow binding;
neither mode is broadened or narrowed merely to reduce command count.

## Transfer task preflight

Before the first target dry-run, create a reviewed task plan with every exact
serialized namespace owned by exactly one task. Dependencies name earlier tasks
whose captured items are required by the dependent task. A dependency outside
the capture is allowed only when its stable ID and approving decision are
recorded in `approvedExternalDependencies`.

```json
{
  "version": 1,
  "approvedExternalDependencies": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "decisionId": "scope-platform-prerequisite",
      "rationale": "Reviewed target platform prerequisite"
    }
  ],
  "tasks": [
    { "id": "content.foundation", "namespaces": ["Template.Foundation"], "dependsOn": [] },
    { "id": "content.project", "namespaces": ["Template.Project"], "dependsOn": ["content.foundation"] }
  ]
}
```

`transfer-preflight.json` binds the plan bytes and captured YAML/module bytes,
then records counts, unassigned or multiply-owned namespaces, cross-task edges
without an ordered dependency, unapproved structural external references and
separate soft field-reference findings. Exit 2 or
`ready: false` means do not dry-run or push. The script is offline and does not
read credentials, call a connector, alter a module, or mutate a Sitecore
instance. Use a new evidence root for each preflight and rerun after any
material scope, remap, or task-boundary change.

## Inspection contract

Recursively reads .yml/.yaml items and .module.json configs. Each config requires a unique exact namespace and items.includes with Sitecore path. Supported scopes: SingleItem and ItemAndDescendants (default). Only master database is supported. Include rules and unsupported scopes are rejected. Each item must match exactly one namespace; overlapping scopes need correction.

Items require GUID ID, GUID Template and absolute /sitecore/... Path. GUIDs normalize to lowercase hyphenated form; braced hyphenated and compact input forms are accepted. Malformed YAML, aliases, duplicate keys, duplicate IDs, duplicate case-insensitive paths, missing headers, ambiguous/unmatched namespace ownership, unsafe filesystem entries and empty captures fail validation. Sitecore-generated plain scalars beginning with `%` are retained as parser warnings when the YAML library has constructed the value; the shared capture must retain a successful Sitecore CLI `ser validate` report as the syntax authority. inspection.json contains namespace counts, file hashes, ID/path/template records, structural dependency edges, soft references, diagnostics, warnings and missing structural references. Partial valid records do not establish transfer safety.

Structural dependencies include Template, Parent and GUIDs in the __Base template field. GUIDs in other structured field Value strings are soft references: they are retained for audit and parity, but never create ordering edges, require an external-prerequisite decision, or enlarge the approved scope. Null GUIDs are ignored. Embedded compact GUIDs, custom encodings, path references and external target existence are not resolved. Missing structural platform prerequisites require reconciliation outside this processor.

## Planning contract

Re-inspects inputs, then emits plan.json. Dependencies override namespace-name
heuristics. Singular and plural kind names are supported. Exact `._containers`
namespaces precede their base and descendants through explicit edges.
Independent names sort deterministically; names/case are preserved verbatim.

Batches contain exact namespace lists, counts, prerequisite namespaces, phase and estimated duration. Prerequisites are in earlier batches. Namespaces are indivisible: oversized namespaces are flagged, not split into invented filters. Runtime estimates use the supplied rate (default 10 items/second), not measured throughput. Limits default to 1000 items and 300 seconds.

Strongly connected components identify namespace cycles and item parent/template/inheritance cycles, including within one namespace. Soft field references never affect namespace ordering or create cycles; their complete and external subsets remain in the report for review. blockedNamespaces includes downstream nodes that are not themselves cyclic. Missing structural references or diagnostics make ready false and exit 2. A plan is not permission to push.

## Remap and filesystem protection

Default dryrun writes only evidence. Apply requires --apply and a nonempty --approval; a no-match apply fails. Target must be new and disjoint from source, modules and evidence. Source is never edited. Only YAML is copied; non-YAML files in items-root fail before copying, preventing accidental CLI/auth config copying. Module configs remain untouched in their explicit root.

Only parsed top-level Template scalar ranges change. Unchanged YAML bytes, comments, field values and base-template lists are preserved. Other matching GUIDs are reported with file/item/offset for separate review. Destination capture presence is reported, but target schema compatibility is unverified.

Changed files have byte-for-byte .serialization-backup/<relative-file>.bak copies inside target; report edits include backup paths and source hashes. Existing target files, backups and reports are never overwritten. Symlinks (including dangling links) and special files are rejected. Source hashes are rechecked before apply. Mid-copy errors retain a partial target and report partial-failure; diagnose and use a fresh target for retry. Inputs/output directories must not be concurrently changed: these checks are not a defense against hostile filesystem races.

## Deterministic manifests

Inspection, plan and remap reports include `inputManifest: {roots: {items, modules}, files: [{role, path, sha256, bytes}]}`. Roots are the explicit absolute input roots; paths are relative to their role's root. Entries sort by role then path and hash original bytes, including malformed files that were read before a parse diagnostic. Every consumed YAML and module JSON is represented. Unreadable/unsafe files produce failures or diagnostics and cannot establish a complete valid capture. Non-consumed files such as authentication configuration are not read or included. Plans therefore change when item or module bytes change even if batches do not.

Remap includes `targetRoot` and `producedFiles: [{path, kind, sourcePath, sha256, bytes}]`, sorted by target-relative path. Kinds are `copy`, `edit`, and `backup`; each successful write is reread and checked before being recorded as verified output. Dryrun has no produced files. The manifest covers the target copy and backups, not the evidence JSON itself (which cannot contain its own hash). Consumers must require `status: complete`; partial-failure reports are diagnostic and cannot establish completeness. The full input file set and hashes, including module configuration, are rechecked before apply and after copying. Module files remain in their source root.

Input reads reject child/ancestor symlinks, nonregular files and hard links. YAML is decoded strictly as UTF-8; malformed encoding fails rather than replacing bytes. BOMs, CRLF and comments remain preserved outside the changed Template scalar. Root separation, new-target/exclusive-report rules and the trusted-directory/no-concurrent-writer requirement remain in effect.

## Test command

```sh
node --test packages/kajoo-recipes/recipes/alexion-recipe/skills/sitecore/tests/serialization-cli.test.mjs
```

Tests copy the processor directory without node_modules, install from its lockfile, and spawn real scripts from an unrelated working directory. They do not run Sitecore CLI validation or prove CLI/auth availability.
