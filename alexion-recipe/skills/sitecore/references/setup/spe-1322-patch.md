# Applying the SPE-1322 Patch (RemoteScriptCall.ashx)

How `sitecore-developer` patches a Sitecore content connector for SPE issue #1322 via **`install-spe-1322-patch`**. Operational reference — dry-run → confirm → apply mechanics. Applies to either the source or target Sitecore connector (the caller selects the connector role).

## What it patches / why
SPE issue #1322 concerns the SPE remoting endpoint `<webroot>/sitecore modules/PowerShell/Services/RemoteScriptCall.ashx`. The affected handler calls the removed `Sitecore.Configuration.Settings.get_IndexFolder()` method while resolving file downloads. Script execution can still work while downloads fail. The patch replaces that file's payload; a compatible SPE upgrade is the alternative repair. The tool patches the live `.ashx` file in place, with a backup.

## Diagnose failed PowerShell downloads

Use this procedure during Setup or whenever a PowerShell export reports an incomplete download, unexpected redirect/HTML, or a file-size mismatch. The tool executes and reports results; the task owner diagnoses and recovers using this reference. Do not stop at an opaque failed tool result or repeatedly rerun the same command without new evidence.

1. **Separate execution from transfer.** Read the terminal job result. Using a read-only SPE query on the same connector, check whether the expected report directory/files already exist, their lengths and modification times. A successful remote script does not prove its files reached the sandbox. Preserve the run ID, exact paths and verified scope; never guess a new report folder or mix attempts.
2. **Inspect the response and logs.** A 302/error-page redirect, HTTP 200 HTML, or generic 500 does not by itself establish #1322. Read the active Sitecore log location and search narrowly for the matching download path/time and `RemoteScriptCall`, `GetPathFromParameters`, `MissingMethodException` or `Settings.get_IndexFolder`. Return only relevant, bounded, sanitized entries; do not print credentials, request headers, unrelated logs or entire configuration files. If the tool does not expose response details, use the logs and report that limitation instead of inventing the response.
3. **Choose recovery from evidence.** `MissingMethodException` naming `Sitecore.Configuration.Settings.get_IndexFolder()` in `RemoteScriptCall.GetPathFromParameters` / `ProcessFileDownload`, or the tool's explicit typed #1322 error, confirms #1322. Follow the dry-run/approval/SHA-guarded workflow below. For authentication, permissions, missing files, other exceptions or unknown causes, troubleshoot that cause; never apply the #1322 patch merely because a transfer failed. If logs are inaccessible, request the exact missing log/access and mark the task blocked.
4. **Respect the authorized scope.** Read-only inspection does not authorize patching, upgrading, changing configuration, or creating probe files on the client. If the user asked for inspection only, report the diagnosis and proposed repair and stop before mutation, even if tool approval mode is bypass. Otherwise obtain the required repair approval before applying.
5. **Verify and resume.** After an authorized repair, verify one known existing, nonsensitive file: read its byte length and SHA-256 through SPE, transfer it using the file-output mode, and compare the sandbox bytes with that metadata. A pre-probe, version string, dry-run success or HTTP 200 alone is insufficient. If verification fails, retain the evidence and block/escalate rather than repeating patches. If it passes, retry transfer of the already-generated reports using their original remote paths/export envelope and a fresh task-local sandbox destination. Do not rerun Discovery solely because transfer failed; rerun the collector only when files are unavailable or the original execution/scope was invalid. Retain original/recovery run references and run the normal report adapter before completing the task.

Keep user updates short: explain what failed, what is being checked, whether approval is needed, and what recovered. Save technical diagnostics in the task's evidence/report rather than dumping them into chat.

## Workflow
1. **Dry-run first.** Call `install-spe-1322-patch` with `dryRun: true` and `forceUnknownSource: false` in the selected source or target connector namespace. Connector role is selected by the tool namespace; it is not a tool argument.
2. **Review the dry-run envelope** (present these when present): `LivePath`, `LiveSha`, `LiveSize`, `SourceClass`, `SourceKind`, `PayloadSha`, `PayloadSize`, `BackupPath`, `PreProbe`.
3. **Confirm** `{ Apply | Cancel }` with the user unless confirmation is explicitly disabled (still show the dry-run fields for audit).
4. **Apply.** Call the same tool with `dryRun: false`, the same `forceUnknownSource`, and `expectedCurrentSha256: <LiveSha from the dry-run>`. **Never blind-write** — the SHA guard prevents patching a file that changed between dry-run and apply.
5. Parse the terminal envelope delivered when the long-running job completes. Use `get-tool-results` only if that terminal result was not delivered or a bounded foreground call explicitly returned a run ID; use `cancel-tool-run` only to abort a running job.

## Envelope statuses
Success: `Status: 'dry-run'` (preview → continue to confirm/apply) · `Status: 'applied'` (patched; carries previous + new SHA, probe verdicts, backup path) · `Status: 'already-patched'` (no change).

Patch-operation failure: `Status: 'error'`, or `Reason:` one of `unknown-source-ashx`, `concurrent-edit-detected`, `payload-integrity-failed`, `ashx-not-found`, `pre-probe-unreachable`, `post-write-sha-mismatch`, `post-probe-still-vulnerable`; also a missing/malformed envelope, tool timeout, or poll/cancel failure. Forward server-side fields verbatim; don't infer compatibility from SPE version text. For the Setup capability gate, classify the independent `PreProbe` using [capability-requirements.md](capability-requirements.md): an absence-of-symptom pre-probe is not verified file-transfer evidence; verify an existing file before marking downloads ready. An unknown source file still requires human review before overwrite.

## Manual fallback
If logs confirm #1322 but the patch tool returns `pre-probe-unreachable` because the exception was hidden by a redirect, retain both pieces of evidence and use the reviewed manual repair/upgrade path below. Do not repeatedly call apply, forge a healthy verdict, bypass the SHA guard, or set `forceUnknownSource=true` to get past it. If manual repair is unavailable or not authorized, leave the task blocked with the exact required action.

If the automated apply fails after the retry budget, a human can manually replace the live `RemoteScriptCall.ashx` with the Kajoo patched payload, or **upgrade SPE** to a version that includes the fix (prefer the upgrade). Always **back up** the original first; verify the live source class (stock SPE sources expected; unknown custom classes need human review before overwrite); roll back by restoring the backup and re-running the readiness probe.

## Safety rules
- Never default `forceUnknownSource` to `true`.
- Never apply without a completed dry-run from the same connector role.
- Never apply without `expectedCurrentSha256` from the dry-run `LiveSha`.
- Never treat a failed post-probe as success.
- On user cancel, do not call apply.
