# Alexion Recipe

Skills-driven Sitecore migration into an existing Headless SXA implementation using approved mappings and existing target definitions. The recipe includes its agents, connectors, skills and scripts. Its display name and description are defined in [.kajoo/recipe.json](.kajoo/recipe.json).

## Mapped Content Migration

The [mapped-content skill](skills/mapped-content-migration/SKILL.md) provides:

- Opt-in [media package migration](skills/mapped-content-migration/references/media-migration.md), preserving IDs, agreed metadata and original binaries in verified packages of at most 100 MB each (100000000 bytes).
- Reusable source snapshots with bounded capture and coverage checks.
- Deterministic transformation into target items, including split outputs, local datasource folders and shared global datasources.
- Target comparison, conflict reporting and dependency-ordered dry-run batches.
- Approved target writes with backups, drift checks, durable identity records and recovery evidence.
- Separately planned reference updates through the same guarded writer.
- Independent whole-scope content verification using fresh target read-back.
- Workflow proposals and operation dispatch through existing approval and human-verification gates.

Before media work, the coordinator asks whether to migrate media and confirms exact paths and descendant scope. Opt-in adds **Prepare media migration packages** and **Install and verify media migration packages** before the eight content tasks; declining retains the eight tasks and still requires target media reference checks. The package adapter requires a verified XP/XM runtime pilot and separate exact installation approval; SitecoreAI requires another adapter. Full live package/blob/restore verification remains pending until performed.

Setup, Discovery and approved mapping/destination evidence are prerequisites. Explicit content-transfer selection distinguishes mapped content from native serialization; native serialization is never a fallback for a failed mapped operation.

Read the [execution runbook](skills/mapped-content-migration/references/execution.md) for the flow, the [script inventory](skills/mapped-content-migration/scripts/README.md) for commands and the [operational boundaries](skills/mapped-content-migration/references/operational-boundaries.md) for capability requirements and exclusions. Presentation Composition, visual/functional website verification and publishing are separate work; mapped content verification does not prove website parity.

## Presentation composition and application

The [Presentation Composition skill](skills/presentation-composition/SKILL.md) provides virtual Partial/Page Design proposals, target-data mock layouts, rendering/variant coverage, preview-only app-file installation and evidence-bound human review. It consumes approved mappings and verified source/target/content handoffs. The [target application procedure](skills/presentation-composition/references/application.md) provides exact dry-runs, approval-bound design/page association writes, backups, durable batch recovery and independent read-back. [Workflow integration](skills/presentation-composition/references/workflow-integration.md) connects those operations to approved tasks and native postflight. A separate [Verification phase](skills/presentation-composition/references/verification.md) checks actual target payloads/browser results against approved source evidence. Preview success does not establish final target-site parity.

## Execute on Kajoo

Select Alexion Recipe in Kajoo. Agents read the assigned skills to stage their bundled scripts and use Kajoo's sandbox Node runtime for local processing, selected Sitecore connectors for remote operations, and Kajoo user prompts for approvals. Clients do not need access to the Kajoo code repository or a local recipe installation. The validator dependency is bundled with the recipe; no runtime package installation is required.

Inputs and outputs remain in the assigned task workspace. Follow the [script inventory](skills/mapped-content-migration/scripts/README.md) for execution requirements and the exact platform-advertised skill paths. Synthetic fixtures are test examples, never approved migration data. The [test guide](skills/mapped-content-migration/tests/README.md) describes developer verification separately from running a migration.
