# Executable CMS contracts

Each script accepts `--input staged.json [--out NEW_REPORT.json]`. Staged envelopes contain inline parsed documents, not paths to inventory/workflow/profile documents. Artifact/result/hash paths resolve relative to the staged JSON file; output flags resolve relative to cwd. Parent directories must exist; destinations must not. Without out, stdout contains only a concise summary. Default and `--dry-run` are read-only except for an explicitly requested new report. Exit 1 signals input/filesystem errors or failed evidence validation; coverage gaps/import uncertainty are data in a successfully computed report.

## build-work-items.mjs

Envelope: `{ inventory, profile, workflow?, availableAgents? }`.

Inventory: `{ version: 1, scopeId, entities }`. Every entity requires `id`, `kind`, `source: { identity, path }`, `scope` (included/excluded/uncertain), and string arrays `parentIds`, `routeIds`, `joins`, `uncertainty`. Joins name other inventory entities. These are facts, never live status or approval. IDs must already identify site/language/variant where needed.

Profile: `{ rules: [{ kind, phaseId, anchorTaskId, prefix, agent? }] }`, at most one rule per kind and unique prefixes. The anchor is an existing aggregate task in the named phase. Generated tasks inherit the anchor's prerequisites; the anchor depends on generated tasks. Parents are not dependency edges: hosting is advisory and evaluated by next-work.mjs (see [work ordering](work-ordering.md)). No profile workflow edits are required.

The input must supply the exact user-approved current workflow; the builder never selects phases or falls back to a fixed template. The supplied workflow is cloned. IDs are `prefix + '.' + base64url(UTF8(entity.id))` without padding; `child` with prefix `code` becomes `code.Y2hpbGQ`. Titles are `kind + ': ' + source.identity`; names do not define IDs. Entity sorting stabilizes output across input order. Matching resumed tasks retain status/agent; conflicting title/phase/dependencies fail for review. Progressed anchors cannot acquire new tasks. Supplying availableAgents omits unavailable hints on new tasks and reports warnings; existing hints never reset status.

This builder deliberately generates one task per included entity. It does not choose user task granularity. Use it only when the user approved item-level tasks. For batches or milestone-level tasks, the coordinator authors the approved grouped workflow and one `{ entityId, taskId }` mapping per covered entity; `taskId` may repeat. A grouped task is dispatched and audited once for all of its mapped entities.

Only included entities generate tasks; other scope values produce review warnings. Missing included-kind rules, duplicate IDs, parents that do not exist in the inventory, parent cycles, collisions, missing/later-phase dependencies and dependency cycles fail without output. A parent that exists but is not included produces a warning. Full report: `{ valid, workflow, mappings, orphanedTasks, warnings, summary }`; `orphanedTasks` lists generated tasks (`{ taskId, status, title, anchorTaskId }`) whose entity is no longer included, which happens when re-discovery removes or excludes it. They are never deleted or changed, and a non-finished one still blocks its anchor and produces a warning; mappings contain `{ entityId, taskId, routeIds }`. Review and apply the proposed workflow through ordinary native coordinator edits.

## next-work.mjs

Envelope: `{ inventory, workflow, mappings, inputs?, validation?, proceedWithoutHost? }`; optional `--limit` (1 to 50, default 5). Mappings are the `{ entityId, taskId }` pairs returned by build-work-items. `proceedWithoutHost` lists entity IDs the user approved to proceed without a rendered host. For implementation phases, `inputs` is the current reviewed `{ path, sha256 }` set and `validation` is the current `validate-evidence.mjs` result plus its matching `inputFingerprint` and per-entity attestation fingerprints.

Only pending mapped tasks in the earliest incomplete phase are considered. Required dependencies must be done/skipped; optional enrichment dependencies wait for done/skipped/failed and permit continuation after terminal failure only. An item is reachable when it has no parent or any in-scope parent is done. When several entities map to one approved batch task, the task is recommended once only when every entity in the batch is reachable; `next` carries `entityIds` for a batch and retains `entityId` for a singleton. Counts and eligibility are task-based, not duplicated per entity. Report: `{ valid, status, phase, primary, next, eligibleTotal, starved, starvedTruncated, starvedByReason, counts, warnings, summary }`. `next` items carry `via` (seed, hosted, without-host or a mixture), `verification` (in-context, isolated-only) and rank keys; `starved` items carry a `reason` and `needsDecision`. Status: has-pending, waiting, blocked, all-complete or none-in-phase. For an implementation phase, every completed mapped task is a verification frontier: missing validation, mismatched current-input fingerprints, missing entity attestations, stale attestations, `not-verified`, `paused`, `unattested` or `ambiguous` status returns `waiting` with `reason: "user-verification"` (or `stale-verification`) and no `next` item. Only `attested` (the validator's wire form of a `verified` decision) or `verified` with the current fingerprint unlocks dispatch. Independent dependency/host failures remain `blocked`. Setup and Discovery retain their existing behavior when no implementation frontier is present. It reads no files besides the input and never writes state. See [work ordering](work-ordering.md).

## validate-context.mjs

Input is the context document itself (`assets/contracts/context.schema.json`), staged where the CLI can read it, normally `${MIGRATION_STATE_FILE_DIR}/context.json` with `--input`. Only `version` is required structurally; the rest is validated when present and unknown fields are refused. It then refuses credentials anywhere in the file (credential-like field names, URL userinfo or credential parameters, tokens, JWTs, private keys), unsafe roots (relative, `..`, backslashes, source and target containing each other, the migration directory inside a repository) and a `git-url` source without a URL.

Report: `{ valid, complete, missing, warnings, errors, summary }`. `valid` is false only for the problems above. `complete` is true when `valid` and no field required for the chosen mode is missing: `scopeId`, `migration.type` and `roots.migration` always; for each chosen side and surface, the content connector or the code root; `source.site.name` and `primaryLanguage` when source content is in scope; and the code source details for its mode. Full migration covers both sides and surfaces; `discovery-only` uses `migration.discovery`. See [context file](context-file.md).

## extract-archive.mjs

Envelope: `{ archivePath, rootMarkers?, rootPath? }`. `archivePath` is a zip, resolved relative to the input file (an absolute path is allowed, so an upload need not be copied). Name the project root with `rootPath` (an archive-relative directory, `.` for the archive root) or let it be detected: `rootMarkers` is a list of entry names, or `*.suffix` patterns, and the root is the one directory within five levels that directly holds any marker. Zero or several matches fail and, for several, list the candidates so the user can choose one for `rootPath`. The markers are profile data; the script has none of its own.

Dry run (default) reads only the archive directory and reports the root, totals, skipped entries, warnings and the archive SHA-256. `--apply --destination NEW_DIR` extracts only the root, with its prefix stripped, into a directory that must not exist; extraction is staged and renamed on success, so a failure leaves no destination. Content is read and verified (size and CRC) only when applying.

Refused, failing the whole archive: absolute, drive-letter, NUL or `..` names, backslash traversal, duplicate or case-colliding entries, an entry that is both file and directory, encryption, zip64, multi-disk, unsupported compression, sizes above the limits (100000 entries, 2 GiB total, 256 MiB per entry) and entries whose data does not match their declared size or CRC. Skipped and reported: symbolic links and special files (never created), any `.git` directory (a hook or config in an untrusted archive can run code on the next git command), and macOS `__MACOSX` metadata. File modes keep only the execute bit.

## validate-evidence.mjs

Envelope: `{ workflow, scopeId, inputs, results, decisions, requiredTaskIds?, requiredEvidenceKindsByTask? }`.

Inputs: a nonempty array of `{ path, sha256 }` for the current reviewed input files. SHA-256 is lowercase hex of exact bytes. Results: paths to task-result JSON files, exactly one selected attempt per task. Every done task and explicitly required task needs a result. Unknown tasks, malformed/missing results and duplicate attempts fail.

Task result: `{ taskId, outcome, summary, evidence, changedFiles, checkpoint, unresolved }`. Outcomes: success/failed/blocked/needs-redo/skipped. Checkpoint is null for read-only work or `{ reference, scope: [changedPath, ...] }`; changed files must exist and their paths must appear in checkpoint scope. Reference is a restore identifier; validation does not execute restores.

## validate-task-attempt.mjs

Use this as the sole technical postflight for one worker attempt when evidence
lives under the migration workspace and changed files live under a target
repository nested elsewhere in that workspace. Invoke it with
`--input postflight-request.json --workspace-root /workspace`; the workspace
root is explicit and the request itself remains a path-only task artifact.

Envelope: `{ workflowPath, decisionsPath, scopeId, inputs, taskId, resultPath,
changedFilesRoot?, requiredEvidenceKinds? }`. Every path is a forward-slash,
workspace-relative descendant. `workflowPath`, `decisionsPath`, inputs and
`resultPath` resolve from `--workspace-root`. `changedFilesRoot`, when the
selected task changes files, is the workspace-relative target repository root;
the selected result's `changedFiles` and checkpoint scope resolve from that
root. The script rereads the current workflow and decisions, validates exactly
the named result through `validate-evidence.mjs`, and never rewrites worker
evidence or task status. Missing/unsafe roots, a mismatched task ID, stale
input/evidence hashes, partial results and absent required evidence fail the
single command.

`requiredEvidenceKindsByTask` is optional and vendor-neutral: each key is an
existing task ID and its value is a nonempty, unique array of evidence-kind
strings. When supplied, the selected task result must include a current,
hash-valid, passing artifact for each declared kind. It does not add workflow
state or tell a worker how to collect that evidence; a platform profile may use
it to make an existing acceptance gate executable.

Evidence entry: `{ kind, path, role, scopeId, entityId?, provenance, observation, checks, unresolved }`. Role: source/target. `entityId` optionally binds this artifact to one stable inventory entity when the workflow task groups multiple entities. When present, `kind` must be `entity-result` and the referenced JSON artifact must satisfy `entity-result.schema.json`, match the evidence task/entity IDs, and keep changed files/checkpoint scope within the task result. Other evidence such as screenshots and logs support the work but do not by themselves prove one batch member. Provenance: `{ producer, version, sha256, inputs }`, with the same input fingerprints as the envelope. Checks: `{ name, passed: boolean }`. Validation rereads all input/artifact bytes and requires current hashes/scope. A task is verified only with success outcome, nonempty evidence/checks, all checks passing and no unresolved gaps. Passing entity-bound evidence is also reported as `verifiedEntityMappings` (`{ entityId, taskId }` pairs); a batch may therefore preserve individually proven entities while its task remains failed/blocked. Entity IDs are derived from selected attempt evidence, never persisted as a second task-status ledger. This validates local evidence integrity, not independent remote/browser truth. The validator separately reports `inputs`, an `inputFingerprint`, and `entityAttestations`: a current `verification` decision must match the entity/task/scope and hash the selected task-result JSON plus all evidence artifacts in that attempt. Each attestation carries the current input fingerprint so `next-work.mjs` can detect stale validation. Its choices are `verified`, `not-verified` and `pause`; absent or stale decisions remain unsigned and do not change technical success. The active domain profile's Code Migration exit audit checks these separately from technical coverage.

Completed/submitted `.approve` tasks additionally require a decision with matching taskId, scopeId, exact current input fingerprints, kind `phase-continuation`, choice `approve`, nonblank userResponse and parseable timestamp. Skipped approval gates fail. Conversational `workflow-plan` decisions are recorded against a status-free sandbox proposal plus evidence fingerprints and are never represented as a task. `validate-workflow-plan.mjs` requires exactly one matching approval, the exact proposal plus nonempty current evidence fingerprints, the user response and a parseable timestamp. After approval, `materialize-approved-workflow.mjs` derives active runtime status from the proposal plus current active workflow: existing task statuses persist, new tasks begin pending, and the named completed planning task becomes done. `validate-workflow-sync.mjs` then requires exact equality of approved and active structure, one binding per phase/task, unique Kajoo IDs and exact equality between bound epic IDs and Migration Artifact `content.phases`; it deliberately does not compare runtime status. The proposal is not a second status store and is never corrected after promotion. All decisions require id/kind/scopeId/choice/rationale/nonempty inputs; taskId/entityId/userResponse/at are optional structurally. Actual user interaction must supply response/time; validators check recorded scope/provenance, not authentication. No success or timestamp generates approval.

## coverage-report.mjs

Envelope: `{ inventory, workflow, mappings, decisions, inputs?, sampledRouteIds?, validation? }`. Mappings are the builder array; routeIds optional. `inputs` is the current reviewed array of `{path, sha256}`; it defaults to `validation.inputs`. If both are supplied they must match. Coverage rereads these files before accepting decisions. Without current inputs, decisions cannot resolve coverage. Validation uses the outer workflow and matching inventory scope. Multiple distinct entities may map to the same approved batch task; each entity receives that shared task's status in coverage, while the human audit verifies the task evidence covers every mapped entity. Without validated evidence, ordinary done tasks count as unverified; completed approval gates remain unresolved.

Counts: total/included/excluded/verified/pending/running/failed/blocked/explicitlySkipped/unverified/unresolved. Included is every entity not explicitly excluded; the state buckets partition included. A mapped entity is individually verified only when its selected task attempt contains current, hash-valid, fully passing evidence bound to that entityId. This is required for grouped tasks; task-level success without evidence for every mapped entity leaves uncovered entities unverified. Human attestation counts are reported separately (`attested`, `notVerified`, `paused`, `unattested`, `stale`, `ambiguous`, `notRequired`) and do not alter the technical state bucket. Exclusion requires exactly one scope decision for the entity with choice `exclude`, rationale, userResponse, timestamp, matching scopeId and the exact nonempty current input fingerprints. If taskId is supplied it must match the entity mapping. Ordinary skipped tasks require choice `skip` and both matching entityId and taskId, under the same current-input checks. Status alone never establishes an explicit skip. Missing/stale decisions, wrong scopes and conflicting choices remain unresolved and retain routes in coverage. A factual scope=excluded alone never removes coverage. Use a new scopeId when scope changes. Sampling never excludes entities/routes.

Phase approvals also require exactly one selected phase-continuation decision; conflicting approvals/rejections remain unresolved. Fingerprints compare path/hash values independently of JSON property order. The caller must stage the complete reviewed input/scope set: hashes verify bytes, not whether the caller selected every relevant source fact. No second state engine or inferred authorization is introduced.

## Scoped evidence reads

The staged JSON parent is the caller-selected read boundary. Current-input, result, artifact and changed-file paths must be relative descendants with no empty, dot, parent, absolute or backslash segments. Child symlinks, hard links and special files are rejected, including a linked staged JSON file. Stage reviewed copies under the selected directory when originals live elsewhere. System aliases in the selected parent are canonicalized; these checks assume no hostile concurrent replacement. Output flags still resolve relative to cwd.

Full report also includes missingEntityIds, unmatchedTaskIds, unresolvedEntityIds, unsampledRouteIds, entityCoverage, evidenceErrors and empty-inventory warnings. Missing mappings/joins/parents and uncertain facts remain visible. Duplicate entity/task mappings fail. Skipped approval gates remain unresolved. Exit 0 means report computed, not migration complete.


## Runnable example

From the CMS migration skill directory (choose an unused output):

```sh
node scripts/build-work-items.mjs --input tests/fixtures/build-input.json --out /tmp/cms-proposal-new.json
```

The CLI and external validators use ../assets/contracts/*.schema.json. Unknown fields fail; put detailed connector/browser observations inside referenced artifact files instead of extending result envelopes.
