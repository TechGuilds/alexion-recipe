# Delete a migration and clean up

Enter only for an explicit deletion request. Never resolve missing artifacts by creating one.

1. Resolve the exact migration ID in the current project. Inventory its linked phases, tasks, chat references if accessible, and active runs. Check other artifacts and phase dependencies for shared use. If ownership cannot be established, retain that resource.
2. Plan the complete proposed deletion and cleanup sequence from that inventory. Apply SKILL.md's tool preflight, including verification, link/reference removal, and active-run handling where required. Raise missing capabilities before any mutation; do not load setup templates or connection instructions. Present a concrete deletion scope: the artifact, optionally its exclusively owned tasks/phases, retained shared resources, and known recovery behavior. Obtain confirmation for that scope and comply with tool-level approval requirements. Default to artifact-only deletion unless broader cleanup is approved.
3. Wait for active migration runs or obtain authorized cancellation through a supported tool. Do not delete records while agents are still writing them.
4. Before any write, record exact approved IDs and required capabilities. If a required cleanup capability is unavailable, explain and narrow the scope with the user rather than starting an unfinishable cascade.
5. For approved task/phase cleanup, process tasks before phases. Detach phase links from the artifact before deleting those phases, preserving other content. Use delete-task for each approved exclusively owned task, then delete-epic for each approved exclusively owned phase. Deleting an epic clears its tasks' epicId and other epics' dependencies; it does NOT delete the tasks. Never delete a phase with retained/shared tasks or dependencies without an explicit resolution of those effects.
6. Remove approved chat references using supported capabilities, then call delete-artifact for the resolved ID. Do not assume artifact deletion cascades to phases, tasks, or chat references.
7. Verify the approved records are absent or soft-deleted. Report exactly what was removed, retained, or left incomplete, and only claim recoverability when supported by the product.

On partial failure, stop, report successful changes and remaining exact IDs, and retry only unfinished operations. Respect deletion confirmation safeguards; no DB/script bypass.

Never delete workspace MCP connections, credentials, agents, remote repositories, source/target content, or sandbox files as a side effect of artifact deletion. Those require separate explicit requests and impact checks.
