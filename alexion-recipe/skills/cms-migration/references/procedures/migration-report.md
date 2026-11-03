# Migration report

Summarize scope and source/target identities without secrets, outcomes for every planned phase, inventory/coverage counts, actual verification evidence and explicit user approvals.

List changed artifacts, remote effects, approved exclusions, deferred hazards, unsupported features, failed/unverified checks and available checkpoint/restore scopes. Link evidence instead of copying logs.

State exactly what was tested locally, through a mock, and against the actual source/target systems. Mock success does not establish live-system parity. Final acceptance is the user's decision, not a script-generated success flag.

## Publish a bounded summary

This applies to Discovery reports, rendering-usage reports and later phase summaries published with `create-artifact` / `update-artifact`. It does not change the structured Migration Artifact contract.

1. Keep the complete report, per-route/rendering rows, diagnostics and raw collector output in the task's existing attempt-scoped evidence directory. Retain the run/scope, file references and hashes needed by the task result. Do not copy a full evidence report through model output simply to publish it.
2. Publish a self-contained summary of at most **8,000 characters** in the artifact content: verified scope/languages, meaningful totals and units, key findings, material blockers/limitations, decisions/next action, and exact evidence-file references. Summarize repeated findings by category; put exhaustive tables and technical details in the linked full report. Do not omit a material limitation to meet the bound. The complete summary must tell the user what passed, what did not, and where the details live.
3. Generate/read a small local summary separately; do not read the entire detailed report into chat and then echo it into tool arguments. Measure the summary length locally before publishing. If it is too long, rewrite it coherently; do not mechanically truncate JSON/markdown or split one report into repeated full-content updates. Reuse existing artifact get/create/update tools; do not invent a file-upload argument or extend their schema.
4. For an update, fetch the current artifact and revision, preserve required existing summary information, and send the bounded replacement content once. Reference the superseded evidence when correcting a report; keep the same project-scoped report identity. Read back the saved artifact and verify its summary, revision and evidence references before recording publication success.
5. If the call is interrupted/truncated by the model response limit, do not assume it executed or blindly resend the same large content. Fetch the artifact to establish what was saved. If the desired update is absent and the run can continue, make one bounded recovery with a smaller coherent summary (at most **4,000 characters**) preserving material findings and linking the full report; use the current revision. If publication still fails or continuation is unavailable, leave publication pending/blocked with the evidence path and exact error; use the assigned task's existing acceptance rules to determine its status. A local report is retained work, not successful artifact publication.

Bulk evidence should remain on disk even when a user requests a detailed report: publish an overview with references to the complete file rather than increasing model tool-argument output until it hits the response limit. Do not expose credentials, unrelated data or customer-identifying details in reusable recipe content.
