# Checkpoints and restore

Before a target change, identify exact recoverable scope: repository files, non-git files, migration state and remote platform records are separate. Preserve existing uncommitted work. Record backup/commit reference, affected task/entity IDs and input/output hashes. [Git operations](git-operations.md) defines the commit format, the hash recorded in the task result and restore mechanics.

A git checkpoint cannot restore remote content, connector configuration or application DB state. Remote writes require an appropriate item/presentation backup and a tested restoration procedure; report unavailable restore coverage before proceeding.

Before restoring, inspect the diff and obtain explicit approval for affected changes. Create a safety backup of the current state. Restore only the named scope. Re-read results and keep partial restore failures visible.

Reset workflow tasks whose outputs were undone and review all dependent results/approvals. Keep unaffected tasks done. Restart the owned dev process if restored code/config changed and repeat relevant tests/browser checks. Keep checkpoint evidence with its task; do not create a second status store or delete unrelated records.
