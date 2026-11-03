# State contract

Version 1: an ordered, non-empty phases array. Each phase has a unique id, title and tasks array. Each task has a workflow-unique stable id, title, status and required `dependsOn` array. Optional `optionalDependsOn` arrays are soft ordering edges: a task waits until each such dependency is `done`, `skipped` or `failed`; a failed optional enrichment is visible but does not block the dependent. It must not bypass a required dependency or a still-running/blocked optional branch. Optional agent is a routing hint; optional result is a short outcome or file reference.

Statuses: pending, running, done, blocked, failed, skipped. Both dependency types refer to existing tasks in the same or an earlier phase; cycles and duplicate IDs are invalid, and a task cannot list the same dependency as both required and optional. Required dependencies are satisfied only by done/explicitly skipped tasks. Optional dependencies are satisfied by done/explicitly skipped/failed tasks. Failed tasks remain failed and keep their phase incomplete; the soft edge allows only the dependent enrichment-tolerant task to proceed. Domain rules can forbid skipping required checks or approval tasks.

Keep status only here. Inventory describes discovered entities; decisions record scope and approvals; evidence describes what was observed. Neither is another task-status engine.

The coordinator reads immediately before writing, preserves unrelated tasks, writes a complete valid document and reads it back. Do not permit concurrent writers. Where atomic replace is available, use a same-directory temporary file and rename; preserve a backup before restructuring state.

Failed or blocked tasks need a retry/repair decision. A running task after interruption is not proof of failure or permission to launch a duplicate. Inspect existing execution first. Reopening a prerequisite requires reviewing dependent tasks and resetting stale results; do not silently keep downstream success.
