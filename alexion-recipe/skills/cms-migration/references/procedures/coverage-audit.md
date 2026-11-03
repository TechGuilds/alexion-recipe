# Coverage audit

Compare the confirmed inventory against workflow tasks and evidence, not a count returned by one analysis run. Every in-scope entity must have a stable task mapping; duplicates and unmatched entities remain visible.

Report included, verified, pending, failed, blocked, explicitly skipped and unresolved separately. Check nested placeholder parents and route coverage. Re-check in context any item that proceeded without a host once a host is done (see [work ordering](../work-ordering.md)). Sampled routes cannot justify exclusion elsewhere.

Re-read actual target files/items for a representative set and all known-risk cases. Verify hashes/scope match the accepted evidence. A missing report or empty inventory is not proof of zero work. Output missing/mismatched IDs and evidence references; coordinator decides next action.
