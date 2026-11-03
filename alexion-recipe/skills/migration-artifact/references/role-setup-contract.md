# Complete one platform role

Applies to `setup.source` and `setup.target`. Each owner completes its role end to end:
connector, repositories, site/language, platform/version, architecture/SDK/tech stack,
references, read-back evidence, task report and final task status. The owner selects or creates its platform/Git connectors and acquires repositories
with migration-artifact, then uses the CMS-specific skill for health and remaining details. Load the active platform procedure (for Sitecore, [role
configuration](../../sitecore/references/setup/role-configuration.md)). Do not repeat
confirmed choices or infer a site from a connector, checkout or app name.

## Isolated role output

Source setup runs first; target setup starts only after verified source completion. They write separate
`evidence/<workflow-task-key>/<attempt>/role-configuration.json` files under the resolved
`MIGRATION_STATE_FILE_DIR`, plus their own task result and evidence. Each owner saves its assigned artifact role (`content.source` or `content.target`) as well as its task-owned evidence. They do not update
`context.json`, `decisions.json`, `workflow.json` or shared reports. Updating different fields through a whole-artifact replacement is not
safe parallel writing. If checkout/output paths overlap or isolation is unproven,
serialize those operations; neither role may edit the other role's checkout or outputs.
Clone each selected repository directly into `/workspace/repos/<original-repository-name>`,
preserving the repository's original name and casing. Do not add `source/` or `target/`
parent folders, rename the checkout, or use another destination unless the user explicitly
instructs it. Verify an existing destination's remote, selected branch, ownership and
local changes before reusing it. If different repositories share a name or source/target
need incompatible branches of the same repository, ask the user for distinct checkout
locations; never overwrite, switch branches under the other role, or invent a directory.
Preserve existing nonstandard checkouts and recorded roots on resume; do not move them
automatically. Record the verified checkout root and application subdirectory separately.

Read the linked artifact and the task's existing report first. Resolve every applicable
role fact supported by the artifact schema, and save the complete verified role object
as `artifactRole` in this role's configuration file. Include actual Kajoo task/workflow
key, artifact ID, role, attempt, original artifact role used as input, connector/repository
identities, selected site/language, roots, refs/revisions or archive provenance, platform
and stack facts, reference answer, actual user-choice provenance and evidence paths.
Keep execution-only values outside `artifactRole`; never invent optional values or
save credentials. Distinguish confirmed selections from candidates, declared ranges
from installed versions, and chosen branches from remote defaults. Record optional
unknown/inapplicable/deferred facts with reasons and owners. Missing required facts
block; a deferral does not waive a later required gate.

Before completing the role, fetch the latest artifact and update only the assigned role with confirmed, schema-supported fields using `update-artifact`. Merge verified values into the current role; preserve the opposite role, unrelated role fields, `content.phases`, `content.stateFileDir` and all other content. For replacement-style updates, send the latest complete content with only that role changed. Do not replace the other role from an old snapshot or clear unknown fields. On conflict or a newer incompatible choice, refresh and resolve the exact mismatch instead of overwriting it.

Use `get-artifact` for artifact read-back and compare every saved verified role fact to the role file and terminal evidence before setting the task done. A failed or mismatched artifact write/read-back blocks this role; report the concrete persistence gap. Record the artifact ID, saved role and read-back evidence in the Technical report/result. Source must meet this acceptance before target starts.

Read back the role file and compare its configuration and references to the actual
terminal evidence. Save a complete structured TASK_RESULT referencing that file. Follow terminal handoff validation in the `cms-migration` skill at `references/task-results.md#validate-every-terminal-handoff` (resolve from that skill's root) for every outcome, including blocked/skipped role setup; a user-approved deferral uses `skipped`, not a custom outcome or shortened result shape.
Update only the final `## Technical report` section of the current task description,
preserving its requirements, with outcome, configuration/checks, limitations and exact
result/role-file references. Read back the report and final task status. The owner sets
`done` when its artifact role, role output and report meet these criteria, or `blocked` with the exact
gap. Use `review` only for a real outstanding required review, never for coordinator
bookkeeping. Chat returns a short outcome, material blocker/next action and task link.
The coordinator reviews the result and projects its outcome into the shared workflow;
it does not save role configuration or finish the owner's Kajoo task on its behalf.

## Single integration owner

`setup.cms` depends on both role tasks and owns combined sandbox context and Setup decisions. Each artifact role is already saved and verified by its role owner.
It fetches both tasks' current Technical report sections and reads their exact selected
TASK_RESULT/role-configuration files. Validate each TASK_RESULT schema before dereferencing its fields; reject malformed owner output for correction rather than substituting empty evidence. Validate identity, attempt, outcome, provenance,
required facts and disjoint roots; do not take task status or chat text as evidence.
Return a missing/stale/contradictory role input to that same owner without silently
repairing it, rerunning successful probes or rewriting the owner's outcome/report.

The CMS setup owner fetches the latest artifact and verifies both existing roles against the selected role evidence. It reuses these persisted roles rather than performing their first persistence. Missing or stale artifact role values return to the respective owner; preserve unrelated fields and `content.phases`/`content.stateFileDir`. A changed connector/site/ref conflicting with
the role evidence needs a scoped decision; never overwrite a newer user choice.
It resolves state paths from the current artifact/environment and alone writes the
combined `context.json` and Setup choices in `decisions.json` during this serialized
task. Preserve existing unrelated state; validate and read back supported context facts
and actual decision provenance. Unsupported context fields remain in artifact/evidence;
never invent a mode, language, SDK version or approval. CMS setup cannot finish until
artifact role facts, task-owned evidence and combined state agree.

Role `done` means its artifact role and task-owned role configuration are both verified; combined context/decision persistence is the CMS task's acceptance criterion. If integration fails, keep `setup.cms`
blocked and retain both completed role outputs. Reuse current evidence on resume; repair
only stale/missing owner outputs, using the same bound task IDs. This contract supersedes
older readiness-only or coordinator-sync role descriptions. Do not rewrite an active
run's task scope while it is running; apply the new task descriptions on explicit plan
repair or new Setup creation.

Cross-role scope, compatibility, remaining gates and approved initialization belong to
CMS setup. Neither role configuration nor integration authorizes unapproved target
content changes, commits or pushes. Independent Setup audit follows integration.


## Acquisition and evidence details

Use the selected Git connection via native Bash `gitCredentials` for authenticated commands. Public credential-free URLs and verified uploaded archives do not require a Git connector. For uploads, preserve existing files and reject paths escaping the extraction root. Save supporting references only as `{type: "url", description, url}` with HTTP(S) links, including related repository web links. Never put Git connector or branch objects in `references`. Keep capability/health findings in task evidence and execution state, not `artifactRole`. Confirm required references or an explicit “No additional references” answer; retain their purpose and access limitations. Credentials never belong in chat, repository URLs, artifacts or report files. Verify that a newly selected connection is enabled for the executing owner before authenticated Git; `No enabled Git connection found` means attachment is missing, not that the repository is inaccessible. Diagnose that attachment without anonymous retries or replacing the chosen repository.

Record the selected working branch in the implementation repository's `branchName` field, not in a supporting reference URL. A remote default is not the selected working branch. Record the resolved revision and any local changes separately. Do not infer user confirmation from an existing checkout. In the complete isolated role configuration, save the verified connector identities, repository descriptions and checkout roots, references, actual choice provenance, CMS checks, platform/site/stack facts and precise unknowns. Each sequential owner persists its artifact role before completion; CMS setup reuses those saved roles later; a saved connector ID or connected status alone is not health evidence.

## Repository and branch follow-ups

Discover repository/branch candidates through the selected Git connection's supported read-only tools before asking, when those capabilities are available. Do not claim repository listing is unavailable without checking the available tools or an actual lookup failure. Select the Git connection first, then fetch repositories through that selected connection. If context suggests a repository name, search for and verify the actual repository before offering it. Present verified repository candidates; after the repository is selected, fetch its branches and ask for the working branch. Reuse confirmed selections and recommend only when context supports the recommendation. Batch repository-name and branch questions in one call only when neither answer depends on the other; otherwise ask in selection order. Use `type: "single_select"` with actual discovered repositories/branches as options; the existing widget shows a custom text field alongside them. Ask for the repository name or branch directly. Do not offer “I will provide the repo name”, “I'll type it”, or “Other” as a separate option. When there are no candidates, use no preset options for a typed answer. The user supplies the actual value in this same question.

“I'll type the repo and branch”, “Other”, or another promise to provide information is not the repository name or branch. If the actual values are absent, issue a follow-up `ask-user-input` for those values and wait in that structured interrupt. Do not end the run, mark the task blocked merely while awaiting this answer, or ask the user to reply in ordinary chat. Reuse any name/branch already supplied and ask only for the missing value. Call `ask-user-input` alone in its turn. A genuine failed access check or missing capability can block the task with its concrete evidence; awaiting an answer uses the resumable input flow.


### Questions that explain the purpose

For source setup, use:
- “Which Git connection should I use to access your existing website’s code?”
- “Which repository contains the website you want to migrate?”
- “Which branch should I read to understand and migrate your existing website?”

For target setup, use:
- “Which Git connection should I use to access the destination repository?”
- “Which repository should contain your migrated website’s code?”
- “Which branch should I use for migration changes?”

For a target branch, explain that selecting it does not authorize pushing changes to the remote repository. Each selection uses actual verified options plus the widget’s existing custom text input; never add a separate “I’ll provide it” or “Other” placeholder option. With no candidates, ask for the actual value in the text field directly. Keep technical execution details in evidence, not in the user-facing question.
