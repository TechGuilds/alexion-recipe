---
name: dev-server
description: Use when starting, restarting, inspecting or troubleshooting the migrated app's preview, reading its logs, or editing its `.env.local` values.
---

# Development server

Server lifecycle belongs to the platform preview tools (`preview_run`, `preview_stop`, `preview_list`, `preview_logs`). Their descriptions define the `/workspace/.kajoo/launch.json` contract and the failure workflow; follow them. This skill adds the recipe's verbs, launch conventions and environment edits. It does not start processes itself.

## Verbs used across the recipe

Other skills say "restart" or "logs". They mean:

| Verb | Do |
| --- | --- |
| status | `preview_list`. Find the entry by `name`. `serverId: null` means never started; `failed` and `orphaned` are not running. |
| start | `preview_run({"name":"<entry>"})`. Reuses a running instance, so it never restarts one. |
| restart | `preview_stop({"serverId":"<id>"})`, then `preview_run({"name":"<entry>"})`. Each start creates a new `serverId`: read it from the `preview_run` result before calling `preview_logs`. |
| logs | `preview_logs({"serverId":"<id>","level":"error","lines":30})` for compile/runtime errors. Use `level: "all"` for context and a literal `search` (for example `[resolver-debug]`) to narrow. It is a bounded snapshot, not a stream: act, then take another snapshot. |
| probe | Not a lifecycle call. Run `frontend-migration/scripts/probe-render.mjs` against `http://127.0.0.1:<port>` using the port from `preview_list`. |

Attached URL entries have no process and no logs. `preview_stop` only detaches them.

## Launch entry

Write one entry for the target application, keep its name stable (workflow evidence refers to it) and merge by name instead of replacing the file. Build it from project evidence: read the actual `package.json` scripts, lockfile and `engines`, and do not assume a command. Recipe conventions on top of the tool contract:

- Bind `0.0.0.0` and give the app its port through the entry's `port`. Use a fixed port
  (`autoPort` off) when an integration callback or editing host requires a stable URL; the
  domain skill owns the integration-specific environment variable and configuration rules.
- Keep secrets out of `launch.json`, including its `env` block. Credentials live in the app's `.env.local` (below) or the platform secret mechanism.
- The coordinator writes and changes launch entries. Task agents ask for a change rather than editing the entry another task is running.

## Ownership

A developer task may restart the preview when its own edits require it (a config file, a new dependency, an environment change). Run `preview_list` first, because a sibling task may already have restarted it. The tester only inspects (`preview_list`, `preview_logs`, probe) and requests changes through the coordinator. Never stop a process this skill did not start, and never kill a listener by port.

## Environment edits

`scripts/env-file.mjs` edits the app's `.env.local` in one atomic batch: it preserves unrelated lines, rejects multiline values and reports changed names only, never values. Run it with JSON on stdin from native bash: `node /mnt/skills/workspace/dev-server/scripts/env-file.mjs` with `{"appPath":"<absolute app dir>","updates":{"NAME":"value"}}`. Batch every change into one call and restart once afterwards. Platform-specific mode policy stays in the active domain skill.

## Verify

`preview_run` proves the process owns the listening port. It does not prove HTTP success or correct rendering. After every start or restart:

1. `preview_logs` at `level: "error"`. A compile error means the run is not valid evidence.
2. Request the affected route with the render probe. Use the returned preview `url` for browser checks, never a guessed hostname.
3. For a running app with the wrong page, use browser console/network checks when authorized.

See [troubleshooting](references/troubleshooting.md) and [scripts](scripts/README.md).
