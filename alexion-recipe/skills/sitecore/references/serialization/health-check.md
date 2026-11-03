# Content health check before source pull

Detect and remediate **duplicate Sitecore items** — two or more children of the same parent sharing a name — *before* the pull. Duplicates raise `Non-unique item paths cannot be serialized`, which blocks serialization entirely; fixing them here avoids a reactive failure loop where every pull dies on the next duplicate. Dispatched at `content-migration.md` Step 3.5. **Pre-pull data quality only** — this step never touches serialization modules and never pulls or pushes.

**Exclusions do NOT fix duplicates.** The duplicate must be removed at the source
(delete or rename). Never respond to a duplicate by adding an exclusion path.

## 1. Get the duplicate report
Prefer the report Discovery already staged: `agent-data/discovery/<siteRoot>/duplicate-items.json` (read it natively; if several site folders exist, take the most recently modified). It is either a bare array of groups or `{ duplicates: [...] }`.

**If it isn't there or it is stale for the current task scope**, detect on
demand once: `run-powershell-script` on `source-sitecore` with
`scripts/spe/detect-duplicate-items.ps1` (`mode: "full"`). Let Kajoo deliver
the terminal result automatically. Use `get-tool-results` only to recover a
missing delivery or inspect that exact interrupted run; never poll routinely or
submit a duplicate detector while the first run is pending. No artifact write
is needed — a later Discovery run can stage the file.

**No duplicates found** → return `success` with `EVIDENCE.healthStatus: "clean"` immediately.

## 2. Categorize — one action per group
Apply in order:

| Rule | Outcome |
|---|---|
| **Action** — all items in the group have `IncomingLinks == 0` (`HasLinks: false`) | **DELETE** the older copy — nothing references it |
| **Action** — any item has `IncomingLinks > 0` (`HasLinks: true`) | **RENAME** the older copy to `{name}_duplicate_{YYYYMMDD}` — renaming is safer than deleting something that is linked |
| **Target** — sort the group's items by `Created` ascending | act on the **oldest** (index 0); **keep** the newest |

## 3. HITL — present the plan, then wait (in-task, yours to ask)
Group by action and present two tables — DELETE groups (parent path, name, the ID+created+createdBy being removed, the ID being kept) and RENAME groups (same, plus incoming-link counts and the new name). Then `ask-user-input { Approve all | Approve with overrides | Skip all }`.

- **Approve with overrides** is freeform ("approve all except #3") — apply the overrides in this same turn.
- **Skip all** → proceed with no remediation; the pull may fail (report `healthStatus: "issues-remaining"`).

This decision dies with your turn, so it is yours to ask — loop control after
you return belongs to the coordinator.

## 4. Execute in batches of 5
`run-powershell-script` with `scripts/spe/remediate-duplicate-items.ps1`, passing at most **5** actions per call (a mid-batch failure then stays small and reportable). Report progress after each batch (`Batch {n}/{m} — {x} deleted, {y} renamed, {z} failed`). A per-item PowerShell error does not abort the batch: record it in `EVIDENCE.failures` and count it toward `remainingGroups`. An item already gone (`NOT_FOUND`) is a success — the desired state is reached. If a batch hits an unexpected error mid-run, `ask-user-input { Continue with remaining | Stop and report }`.

## 5. Verify clean
Re-run `detect-duplicate-items.ps1` with `mode: "count"`. `RemainingDuplicateGroups == 0` → clean. Anything above 0 means some groups were skipped or failed — report which.

## 6. Return contract
```
TASK_RESULT: success
EVIDENCE: { healthStatus: "clean" | "issues-resolved" | "issues-remaining",
            duplicateGroupsFound, deletedCount, renamedCount, skippedCount,
            remainingGroups, failures: [ { id, reason } ] }
```
- `clean` — none found. · `issues-resolved` — all approved actions succeeded, 0 remaining. · `issues-remaining` — some skipped or failed; source pull may still hit them. All three are `TASK_RESULT: success` — the check ran; the coordinator must not dispatch a batch whose active scope contains a known unresolved duplicate.
- **SQL unreachable** (no connection / sandbox unavailable) → `TASK_RESULT: skipped` with `EVIDENCE.reason: "sql-unavailable"`. Preserve the capability gap and let the pull classify an observed duplicate before any retry.
- A remediation batch that crashes unrecoverably → `TASK_RESULT: failed` with `EVIDENCE: { reason: "remediation-error" | "verification-error", error, partialResults }`.

## Re-run from the pull (targeted mode)
When a pull fails with `EVIDENCE.errorType: 'duplicate-item-path'`
(`error-recovery.md` §6), the coordinator re-dispatches this step with the
known `problematicItemPath` + `duplicateIds`. Focus on that item — detect,
categorize, remediate, verify — then report so the pull can be retried.
