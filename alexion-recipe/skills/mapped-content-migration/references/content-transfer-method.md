# Content transfer method and instruction precedence

The assigned task packet must contain `contentMigrationMode: mapped-content` or `contentMigrationMode: native-serialization`, bound to the coordinator's current scope decision. Platform flavor alone does not select a content transfer method. Missing, unknown or contradictory method evidence returns `blocked`; do not default to serialization or infer a method from fixture files.

The supported `cms-migration/scripts/prepare-task-packet.mjs` producer accepts optional `contentMigrationDecision` using the existing coordinator decision contract: `kind: scope`, matching scope/task, an exact method in `choice`, recorded user response/timestamp and current declared input hashes. It emits both the selected `contentMigrationMode` and decision. For Content Migration, the coordinator must supply this decision before dispatch; code and unrelated tasks can omit it. Do not hand-edit the generated packet or create another approval format. Workers verify the selected decision and its underlying declared evidence before execution. Missing actual files, stale hashes or contradictory current decisions still block even when the packet's declared hashes agree.

## Select the content transfer method

The orchestrator owns this interview after Discovery provides enough source/target evidence and before proposing Content Migration tasks. Reuse the confirmed workflow scope in `context.migration.mode`: `full-migration` or `discovery-only`. Discovery-only work does not authorize content transfer; do not ask it to approve target writes. Workflow scope and `contentMigrationMode` are separate choices.

For full migration, first reuse an existing current mapping requirement and user decision. Otherwise ask through `kajoo/ask-user-input`: does the content require template/field mapping, item splitting, datasource relocation or structural transformation? Ask this prerequisite alone; do not combine it with conditional follow-ups.

- Mapping required: select `mapped-content` and require approved mapping/destination evidence. Many source definitions mapping to one target definition still use mapped-content. Do not infer rules from names or silently fall back to serialization.
- Mapping not required: delegate a bounded compatibility check to `sitecore-developer` using existing Discovery evidence. Obtain only missing or stale facts through approved reads. Require the check below before presenting native serialization as executable work.
- Unclear or incomplete evidence: record the gap, owner and next action; do not infer native compatibility from the user's answer.

### Direct-transfer compatibility check

The specialist must compare the approved source scope with actual target definitions and destination evidence, and return a task-owned report with source/target identities, exact evidence hashes, per-check results and unresolved dependencies:

1. Source template and field IDs resolve to compatible target definitions, including inherited fields, field types and sharing modes. Matching names alone do not establish compatibility. If approved native scope includes definition transfer, distinguish those definitions explicitly from content using existing definitions.
2. Item identities and approved paths can be handled by the native procedure without structural transformation, collisions, unapproved overwrite or prohibited definition replacement. An existing Headless SXA definition must not be overwritten just to make source content fit.
3. Languages, versions, content links, list/media references and local/global datasource dependencies can be preserved or resolved by the explicitly supported native scope/remap procedure.
4. No required one-to-many output, field redistribution, unsupported value conversion or inferred datasource restructuring remains. Those require mapped-content or an explicit scope correction.

Missing or failed checks block native transfer selection. Present the findings to the user; do not automatically switch mechanisms. After successful checks, obtain explicit approval for `native-serialization`. Record the selected mechanism through the existing `kind: scope` decision, with the user's response/time, actual scope ID and hashes of the compatibility report and current evidence in `inputs`. For mapped-content, bind the reviewed mapping requirement/evidence instead. Keep workflow-scope, mapping approval, phase continuation and mutation approval separate.

Only one content-transfer phase may be active for the current scope. Native and mapped catalog entries are alternatives, not consecutive phases. Before proposal/materialization or dispatch, reject duplicate native/mapped content work even if the phase IDs differ. Switching mechanisms requires a reviewed proposal and reconciliation of previous effects; never delete completed work or silently relabel old evidence.

This dispatch rule takes precedence over generic Content Migration serialization instructions in the specialist, tester, Sitecore platform library and profile pipeline.

| Method | Procedure |
| --- | --- |
| `mapped-content` | Follow [the mapped-content skill](../SKILL.md) and its available script inventory. Consume approved mappings and destinations; local validation, source preparation, transformation, dry-run planning, separate reference planning and explicitly approved initial/reference target execution/checkpoints are available through their documented procedures. Never run native pull/push, serialization-scope preparation, native serialization batch planning, aggregate serialization parity audits or template-definition transfer as a fallback. |
| `native-serialization` | Follow the inherited Sitecore native execution procedure and its own approved scope/capability gates. Mapped-content artifacts do not satisfy native prerequisites. |

The specialist executes only the assigned available operation. The tester may independently verify assigned local artifacts using their implemented validators and hash/coverage checks. An explicitly assigned mapped-content independent content audit follows [target verification](target-verification.md), reconstructing expected content and checking every agreed output with fresh provenance-bound readback. Missing scope/read approval/capability or incomplete observations returns `blocked`, preserving gaps and writer receipt evidence. Mapped-content workflow integration requires explicit workflow-plan approval through [workflow integration](workflow-integration.md). The writer's per-operation read-back is not this final audit. Source/target item counts cannot prove parity for split items.

This guard does not install a new workflow, select phases or record approvals. Guarded target execution is a separate explicitly assigned procedure, never an effect of selecting the method. The coordinator remains responsible for task selection and current decisions. Existing setup/discovery behavior is unchanged unless the assigned task explicitly selects a different supported operation.
