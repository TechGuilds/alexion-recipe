# Skill-first Sitecore migration

Four agents coordinate six gated phases using native workspace tools, focused skills and golden scripts. Migration-specific SDK orchestration is removed. A recipe installation supplies procedures and tested local contracts; each real migration must still verify its source/target capabilities and runtime behavior.

## Responsibility map

- `cms-migration`: generic evidence, approvals, coverage, recovery and the Sitecore phase catalog.
- `sitecore`: platform knowledge, authenticated remote procedures and flavor-specific constraints.
- `frontend-migration`: local source analysis, React/Next.js transformation, mock service and browser verification.
- `sitecore-mvc-to-xmc`: MVC reconstruction and target mappings, including the explicit XP Headless alternative.
- `sitecore-headless-to-xmc`: JSS-to-Content-SDK mappings and resolver adapters.
- `workflow` and `dev-server`: bundled here as recipe skills, attached to the recipe agents and staged on demand at `/mnt/skills/workspace/<name>`.

## Execution and distribution

1. Load workflow and cms-migration. Read the actual workspace context and the selected profile. Its canonical template is `cms-migration/assets/profiles/sitecore/workflow.json`; the recipe UI skeleton is a tested projection, not another status store.
2. The coordinator owns one workflow file and explicit decisions. Workers receive stable tasks, separate evidence directories and optional agent hints. Independent tasks may run in parallel; phase transitions require explicit user acceptance.
3. Use native read/write/edit/bash/LSP capabilities for local work. Keep authentication in retained connector primitives. Remote SPE executes through the selected source/target connector, not local bash.
4. Read the selected script README for exact input/output, dry-run, approval, dependency-installation and partial-result rules. Copy dependency-bearing bundles to writable task directories before `npm ci`; never install into the read-only skill projection.
5. Publish the core global-skill bundle before deploying these agent/skill definitions. Existing workspaces require a scoped, backed-up update; do not overwrite real progress or reconnect systems implicitly.

## Verification boundaries

- CMS scripts validate workflow proposals, evidence and coverage; technical completion never creates approval.
- Frontend scripts analyze syntax/layout/styles, propose scaffolds and probe HTTP readiness. Build, hydration, visual and interaction checks are separate evidence.
- Sitecore exports preserve scoped identity, presentation, dictionary, rich text and actual Layout Service captures. Partial scope, missing languages, unsupported devices/modes and failed transfers stay visible.
- Serialization scripts inspect, batch and remap local captures. They do not install/authenticate the Sitecore CLI or perform pull/push. Follow the platform's native-execution prerequisite checks.
- PowerShell/SPE test doubles and the standalone protocol mock under `packages/kajoo-recipes/testing/spe-mock` do not prove real Sitecore compatibility, licensing, resolver execution or end-to-end migration parity.

Run authoring checks from the repository root with `node --test packages/kajoo-recipes/scripts/*.test.mjs`. Individual script READMEs provide their standalone test commands. Shared-skill changes also require regeneration and verification of the bundled core manifest.
