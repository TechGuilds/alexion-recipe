# Prepare Discovery plan

Use plain phase titles such as `Setup` and `Discovery`. Do not add numbered prefixes or migration-name suffixes (for example, `— Website migration`). Use numeric `rank` for ordering and artifact/binding IDs for identity, not title decorations. Never adopt an unrelated same-name epic; if find-or-create returns a collision, report it rather than silently linking it or inventing a decorated title.

Workflow task: `setup.prepare-discovery`. This is the final task in the same artifact-owned Setup phase, assigned to the orchestrator after `setup.audit`. Link the actual artifact, Setup phase and audit task using verified IDs and Kajoo annotations. Create this task as todo upfront; resolve mutable role configuration from the artifact at execution.

## Procedure

Require verified successful Setup audit evidence and complete CMS context. Load `cms-migration` and follow its [Discovery planning procedure](../../cms-migration/references/prepare-discovery.md) with the active domain profile. The tester does not create phases or tasks.

Create or reconcile this migration's Discovery phase, applicable task descriptions, assignments and dependencies; persist returned IDs, workflow bindings and artifact phase links. Ready tasks use todo; tasks needing missing task-specific inputs use draft with explicit missing details, an owner and the action required to make them ready. Do not leave generic placeholders or invent connector IDs, source-code availability or user choices. Planning can finish with clearly identified draft tasks; those missing Discovery inputs do not reopen otherwise valid Setup evidence.

## Acceptance and lifecycle

Set an explicit numeric `rank` for Discovery greater than the bound Setup phase. Follow the CMS planning procedure's missing-rank normalization and read back both ranks; dependencies and numbered names alone do not establish UI order. Repair an existing incorrectly ordered Discovery phase without recreating it or moving unrelated epics. Record the phase ranks in the planning report and verify Setup appears before Discovery before completing this task.

Mark in-progress at execution start. Mark done only after the Discovery phase and tasks are visible, linked to this migration, read back, and consistent with the active workflow and bindings. Save `reports/discovery-plan.json` with task IDs, workflow keys, ready/draft classification and missing inputs. A failed or partial plan write keeps this task incomplete; retry only missing operations using the same IDs. Do not repeat the successful audit on a planning-only retry.

Completing this task completes Setup, not Discovery. Present the next visible phase and missing inputs, then ask separately whether to start, pause or continue in another chat. Do not dispatch Discovery, run probes, install dependencies, change target applications or infer execution approval from plan creation.

## Technical report

Not recorded yet. During execution, replace this final section with the current attempt’s
outcome, verified configuration or changes, checks and material limitations, blockers/next
action, and structured result/evidence references. Preserve all task requirements above
this heading. Follow `managing-kajoo-tasks` for report updates; keep chat summaries short.
