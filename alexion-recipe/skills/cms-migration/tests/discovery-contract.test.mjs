import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Sitecore code collection accepts bounded enrichment only after its explicit deliverables and report read-back', () => {
  const profile = read('../references/profiles/sitecore/pipeline/discovery.md');
  const frontend = read('../../../agents/frontend-developer.md');
  assert.match(profile, /Code collection acceptance/);
  assert.match(profile, /component-path inventory/);
  assert.match(profile, /read back.*artifact ID/i);
  assert.match(profile, /After approved-plan capture, consume only the coordinator's verified declared successful files/i);
  assert.match(profile, /analyze-usage\.mjs --all-routes/);
  assert.match(profile, /selected rendering coverage is not whole-site usage authority/i);
  assert.match(profile, /Zero success or pending capture leaves static code collection independent/i);
  assert.match(profile, /Never promote sample omissions into unused-rendering exclusions/i);
  assert.match(frontend, /Sitecore-developer owns capture; do not independently fetch routes, crawl a sitemap or launch per-route GraphQL requests/i);
  assert.match(profile, /Return `success`.*required rows/s);
  assert.match(profile, /External package edges.*not failed local imports/);
  assert.match(profile, /missing required source.*unsuccessful/i);
  assert.match(frontend, /Code collection acceptance/);
});

test('Discovery distinguishes collection acceptance from partial analysis and joins parallel captures explicitly', () => {
  const generic = read('../references/pipeline/discovery.md');
  const sitecore = read('../references/profiles/sitecore/pipeline/discovery.md');
  const frontend = read('../../../agents/frontend-developer.md');
  assert.match(generic, /complete: false.*not automatically fail/);
  assert.match(generic, /unresolved required acceptance failures.*prevent verified success/);
  assert.match(generic, /Do not erase warnings/);
  assert.match(read('../references/task-results.md'), /prevent the assigned task's required acceptance criteria/);
  assert.match(read('../references/task-results.md'), /cannot be moved into a report solely to pass\s+validation/);
  assert.match(sitecore, /Optional runtime failure does not\s+fail valid core collection/i);
  assert.match(sitecore, /Supply its path\/hash and exact source identity to\s+the Sitecore worker/i);
  assert.match(sitecore, /after the content gate and terminal static code result,\s+synthesize the draft/i);
  assert.match(sitecore, /Missing\s+required content inventory blocks synthesis/);
  assert.match(frontend, /Runtime\/build\/browser parity is not an unconditional static-Discovery gate/);
  assert.match(frontend, /sampled, capped, skipped or partial input `authoritative: false`/i);
  assert.match(frontend, /positive successful-route count permits `analyze-usage\.mjs --all-routes` once over declared captured files/i);
});

test('Sitecore analysis never treats tool defaults as approved migration scope', () => {
  const analysis = read('../../sitecore/scripts/analysis/README.md');
  assert.match(analysis, /tool defaults.*not.*migration scope/i);
  assert.match(analysis, /pass.*verified scope explicitly/i);
});

test('Discovery workflow plans after its audit and permits only terminal code enrichment failure through synthesis', () => {
  const workflow = JSON.parse(read('../assets/profiles/sitecore/workflow.json'));
  const discovery = workflow.phases.find(phase => phase.id === 'discovery');
  assert.ok(discovery);
  assert.deepEqual(discovery.tasks.map(task => task.id), [
    'discovery.code', 'discovery.content', 'discovery.synthesize', 'discovery.audit', 'discovery.plan-workflow',
  ]);
  const synthesis = discovery.tasks.find(task => task.id === 'discovery.synthesize');
  assert.deepEqual(synthesis.dependsOn, ['discovery.content']);
  assert.deepEqual(synthesis.optionalDependsOn, ['discovery.code']);
  assert.doesNotMatch(synthesis.title, /migration plan/i);
  assert.deepEqual(discovery.tasks.find(task => task.id === 'discovery.audit').dependsOn, ['discovery.synthesize']);
  assert.deepEqual(discovery.tasks.at(-1).dependsOn, ['discovery.audit']);

  const entry = read('../references/start-discovery.md');
  assert.match(entry, /explicit.*phase-continuation/);
  const planning = read('../references/prepare-discovery.md');
  assert.match(planning, /profile's exact workflow key/);
  assert.ok(discovery.tasks.every(task => task.id !== 'discovery.approve'));
});

test('later-phase catalog gives applicability examples, not fixed dependency ordering', () => {
  const catalog = JSON.parse(read('../assets/profiles/sitecore/phase-catalog.json'));
  assert.match(catalog.description, /dependencies from Discovery evidence/i);
  assert.ok(catalog.goldenExamples.length >= 1);
  assert.ok(catalog.goldenExamples.every(example => !Object.hasOwn(example, 'dependsOn')));
});

test('generic Discovery defines evidence, recovery, workstream granularity, plan approval and separate continuation', () => {
  const discovery = read('../references/pipeline/discovery.md');
  assert.match(discovery, /explicit user decision to enter Discovery/i);
  assert.match(discovery, /reuse current successful outputs and rerun only missing, failed or stale branches/i);
  assert.match(discovery, /Content is load-bearing/i);
  assert.match(discovery, /Code is enrichment/i);
  assert.match(discovery, /correct.*invocation.*once/i);
  assert.match(discovery, /scope.*decision.*failed.*skipped/i);
  assert.match(discovery, /granularity separately for each applicable workstream/i);
  assert.match(discovery, /`workflow-plan` approval/i);
  assert.match(discovery, /Plan approval is not permission to start execution/i);
  assert.match(discovery, /deterministic local synthesis builder/i);
  assert.match(discovery, /must not enumerate the workspace, search repositories, call a connector, or change an active plan/i);
  assert.doesNotMatch(discovery, /Ask to continue to Code Migration/);
});

test('Sitecore synthesis is a declared local draft rather than another source probe', () => {
  const profile = read('../references/profiles/sitecore/pipeline/discovery.md');
  const developer = read('../../../agents/sitecore-developer.md');
  const analysis = read('../../sitecore/scripts/analysis/README.md');
  assert.match(profile, /Canonical local synthesis/);
  assert.match(profile, /synthesize-discovery\.mjs/);
  assert.match(profile, /does not query Sitecore, inspect a repository, create workflow tasks or phases/i);
  assert.match(developer, /assigned `discovery\.synthesize` task/);
  assert.match(developer, /Do not repeat collection, query Sitecore or GraphQL, search a repository, enumerate the sandbox/i);
  assert.match(analysis, /synthesize-discovery\.mjs.*draft-only planning join/is);
});

test('Discovery hands the core serialization plan to the approved workflow without generating work', () => {
  const generic = read('../references/pipeline/discovery.md');
  const profile = read('../references/profiles/sitecore/pipeline/discovery.md');
  const orchestrator = read('../../../agents/orchestrator.md');
  assert.match(generic, /execution scope[\s\S]*during Discovery planning/i);
  assert.match(generic, /not task generation[\s\S]*activate[\s\S]*workflow\s+tasks/i);
  assert.match(profile, /Content-transfer planning handoff/);
  assert.match(profile, /core collector[\s\S]*serialization-config\.json/i);
  assert.match(profile, /Do not automatically run[\s\S]*normalized dependency/i);
  assert.match(profile, /exact item binding[\s\S]*user-approved transfer task/i);
  assert.match(orchestrator, /Before presenting that final proposal[\s\S]*execution-scope materialization/i);
  assert.doesNotMatch(orchestrator, /skills: \['workflow', 'cms-migration', 'sitecore'/i);
});

test('Sitecore Discovery retains full inventory evidence separately from approved preview selection', () => {
  const profile = read('../references/profiles/sitecore/pipeline/discovery.md');
  const content = read('../../sitecore/references/discovery/content-analysis.md');
  for (const name of ['rendering-usage.jsonl', 'rendering-details.json', 'rendering-page-mapping.json',
    'sxa-conversion-inputs.json', 'xp-only-template-audit.json', 'serialization-config.json']) {
    assert.ok(profile.includes(name) || content.includes(name), `missing ${name}`);
  }
  const preview = read('../../sitecore/references/discovery/rendering-preview-flow.md');
  assert.match(preview, /Keep every source occurrence, item ID\/path, parameters, placeholder, datasource and variant in `rendering-mapping-inventory\.json`/i);
  assert.match(preview, /Discovery enumeration itself has no 25-page preview limit/i);
  assert.match(profile, /Omitted `maxUrls` or `0` attempts all selected pages/i);
  assert.match(profile, /MVC/);
  assert.match(profile, /approved native capture plan/i);
  assert.match(profile, /No extra homepage or sitemap is implicit/i);
  assert.match(profile, /target Sitecore instance/);
  assert.match(profile, /pending-verification/);
  assert.match(profile, /translation helper.*identifies|translation helper usage/i);
  assert.match(profile, /unresolved/i);
  assert.match(content, /`inspect-presentation`/);
  assert.match(content, /suggestedExclusions/);
  assert.match(content, /assemble-discovery\.mjs/);
  assert.match(profile, /`content-discovery-report`/);
  assert.match(profile, /`code-discovery-report`/);
  assert.match(profile, /`discovery-synthesis-report`/);
  assert.match(profile, /setup\.initMode.*adopted|adopted.*target/i);
  assert.match(profile, /bootstrap-reconciliation\.json/);
});

test('Sitecore content task does not make supplemental delivery readiness a Discovery success gate', () => {
  const developer = read('../../../agents/sitecore-developer.md');
  const profile = read('../references/profiles/sitecore/pipeline/discovery.md');
  const content = read('../../sitecore/references/discovery/content-analysis.md');
  assert.match(profile, /`deliverablesReady` is stricter/);
  assert.match(content, /`deliverablesReady: false` is allowed/);
  assert.match(developer, /Return success for completed collection with documented later-work findings/);
  assert.doesNotMatch(developer, /Require the assembler's collection and delivery checks/);
});

test('Sitecore content Discovery defaults to one whole-site collector and records every normalized-recovery trigger', () => {
  const developer = read('../../../agents/sitecore-developer.md');
  const content = read('../../sitecore/references/discovery/content-analysis.md');
  const tester = read('../../../agents/tester.md');
  assert.match(content, /Whole-site core mode \(default\).*xp-discovery-v3\.ps1/is);
  assert.match(content, /Normalized recovery mode.*terminal failure.*missing\/corrupt.*named downstream task/is);
  assert.match(developer, /Respect the coordinator's explicit `collectionMode`/);
  assert.match(developer, /Do not run both modes for the same scope/);
  assert.match(developer, /`not-requested` with scope reason when excluded, and `unavailable` only with actual bounded failure evidence/);
  assert.match(content, /coordinator states `collectionMode`/i);
  assert.match(content, /worker must not choose normalized mode on its own/i);
  assert.match(content, /run ID\/report[\s\S]*defect or downstream task ID/i);
  assert.match(tester, /"kajoo\/list-artifacts".*"kajoo\/get-artifact"/);
  assert.match(tester, /For a Discovery audit, read the Migration Artifact/i);
});

test('Sitecore Discovery preserves the MVC rendering catalog prerequisite', () => {
  const profile = read('../references/profiles/sitecore/pipeline/discovery.md');
  const frontend = read('../../../agents/frontend-developer.md');
  const sitecore = read('../../../agents/sitecore-developer.md');
  const inventory = read('../../sitecore/references/discovery/discovery-script-inventory.md');
  assert.match(profile, /get-rendering-source-keys\.ps1/);
  assert.match(profile, /analyze-dotnet\.mjs.*catalog|pass its JSON catalog via.*--catalog/i);
  assert.match(frontend, /absent\/failed catalogs retain raw Roslyn output with mapping\/resolver coverage skipped/);
  assert.match(sitecore, /rendering\/controller\/view\/model join/);
  assert.match(inventory, /MVC rendering catalog/);
});

test('remote Discovery runs are deduplicated and requested layout capture is attempted before being called unavailable', () => {
  const content = read('../../sitecore/references/discovery/content-analysis.md');
  const baseline = read('../../sitecore/references/discovery/baseline-capture.md');
  const sitecore = read('../../sitecore/scripts/analysis/README.md');
  const collector = read('../../sitecore/scripts/remote-common.ps1');
  assert.match(content, /remote-runs\.jsonl/i);
  assert.match(content, /pending.*never submit the same request again/i);
  assert.match(baseline, /Do not silently move it to\s+Code Migration or call an unattempted capability unavailable/i);
  assert.match(baseline, /Actual capture and reviewed local delivery are required attempts when the user\s+requests Discovery mock preview/i);
  assert.match(baseline, /explicit user deferral with an owner\s+before accepting closure with that deliverable gap/i);
  assert.match(baseline, /attempted.*succeeded.*failed.*skipped/i);
  assert.match(sitecore, /Axes\.GetDescendants\(\)/);
  assert.match(sitecore, /requested language and nonzero version/i);
  assert.match(sitecore, /numeric and `\*` versions retain exact path-based reads/i);
  assert.match(collector, /\.Axes\.GetDescendants\(\)/);
  assert.match(collector, /GetDescendants\(\) \| Initialize-Item/);
  assert.match(collector, /-Language \$language -Version \$Version/);
  const itemReader = collector.match(/function Read-KajooItems[\s\S]*?(?=\nfunction Get-KajooOccurrences)/)?.[0] ?? '';
  assert.match(itemReader, /\$Recurse -and \$Version -eq 'latest'/);
  assert.match(itemReader, /Get-ChildItem/);
  assert.match(itemReader, /\$item\.Language.*\$language.*\$item\.Version.*-eq '0'.*continue/);
});

test('workflow-plan approval is distinct from phase continuation and is a supported decision kind', () => {
  const decisions = read('../references/decisions-and-approvals.md');
  const orchestrator = read('../../../agents/orchestrator.md');
  const discovery = read('../references/pipeline/discovery.md');
  const synchronization = read('../../workflow/references/kajoo-plan-sync.md');
  const contracts = read('../references/executable-contracts.md');
  const materializer = read('../scripts/materialize-approved-workflow.mjs');
  const schema = JSON.parse(read('../assets/contracts/decision.schema.json'));
  assert.ok(schema.properties.kind.enum.includes('workflow-plan'));
  assert.match(decisions, /`workflow-plan` approval/);
  assert.match(decisions, /separate `phase-continuation` decision/);
  assert.match(decisions, /synthetic task/);
  const documents = [decisions, orchestrator, discovery, synchronization, contracts];
  for (const document of documents) {
    assert.match(document, /materialize-approved-workflow\.mjs/i);
  }
  assert.match(documents.join('\n'), /status-free proposal|never contains runtime status|never runtime status|no runtime status/i);
  assert.match(documents.join('\n'), /second (?:status store|workflow state)/i);
  assert.match(materializer, /status:\s*task\.id\s*===\s*input\.planningTaskId\s*\?\s*'done'/);
  assert.match(materializer, /activeTasks\.get\(task\.id\)\?\.status\s*\?\?\s*'pending'/);
});

test('coverage export is an existing-connector golden operation and the catalog guides evidence-led planning', () => {
  const requestComposer = read('../../sitecore/scripts/prepare-request.mjs');
  assert.match(requestComposer, /analyze-rendering-coverage/);
  const catalog = JSON.parse(read('../assets/profiles/sitecore/phase-catalog.json'));
  for (const example of catalog.goldenExamples) {
    assert.ok(Array.isArray(example.evidenceSignals) && example.evidenceSignals.length > 0);
    assert.ok(Array.isArray(example.taskPatterns) && example.taskPatterns.length > 0);
    assert.ok(Array.isArray(example.acceptanceEvidence) && example.acceptanceEvidence.length > 0);
  }
});

test('item-level work generation requires the exact approved workflow and has no fixed-template fallback', () => {
  const schema = JSON.parse(read('../assets/contracts/build-work-items-input.schema.json'));
  const builder = read('../scripts/build-work-items.mjs');
  const contracts = read('../references/executable-contracts.md');
  assert.ok(schema.required.includes('workflow'));
  assert.doesNotMatch(builder, /input\.workflow\s*\?\?/);
  assert.doesNotMatch(contracts, /defaults to the existing six-phase template/i);
});

test('layout capture documents connector injection, in-script GraphQL fallback and exit preservation', () => {
  const capture = read('../../sitecore/scripts/capture/README.md');
  const helper = read('../../sitecore/scripts/capture/fetch-layouts.mjs');
  const evidence = read('../scripts/validate-evidence.mjs');
  const worker = read('../../../agents/sitecore-developer.md');
  assert.match(capture, /foreground through Bash/i);
  assert.match(capture, /`mcpCredentials\.source`/i);
  assert.match(capture, /SOURCE_SITECORE_GRAPHQL_API_KEY/);
  assert.match(capture, /GraphQL HTTP.*not.*MCP|not.*`graphql-query`/is);
  assert.match(helper, /SOURCE_SITECORE_GRAPHQL_API_KEY/);
  assert.match(evidence, /inputFingerprint/);
  assert.match(evidence, /fingerprint: fingerprintInputs/);
  assert.match(capture, /rc=\$\?;.*exit ["']?\$rc/is);
  assert.match(worker, /fetch-layouts\.mjs` once in foreground Bash with `mcpCredentials\.source`/i);
  assert.match(worker, /Preserve the original CLI exit status, terminal result, route identities, counts, errors and hashes/i);
});

test('orchestrator requires verification before next-work and the next worker dispatch', () => {
  const orchestrator = read('../../../agents/orchestrator.md');
  assert.match(orchestrator, /After `TASK_RESULT`, validate raw evidence once with\s+`validate-task-attempt\.mjs[^`]*` → present a\s+structured `kajoo\/ask-user-input` review table → persist one current,\s+evidence-hash-bound verification decision per rendering\/entity → run\s+`next-work\.mjs` → call `kajoo\/run-agent` for the next task/i);
  assert.match(orchestrator, /every mapped rendering/is);
  assert.match(orchestrator, /`Verified`/is);
  assert.match(orchestrator, /current evidence/is);
  assert.match(orchestrator, /technical.*status.*human.*verification.*separate/i);
});
