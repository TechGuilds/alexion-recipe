# Development server scripts

Server lifecycle (start, stop, restart, status, logs) uses the platform preview tools; see the [skill](../SKILL.md). This folder holds only the environment-file helper.

## env-file.mjs

Read the skill to stage resources, then run `node /mnt/skills/workspace/dev-server/scripts/env-file.mjs` in native bash with JSON on stdin: `{ "appPath": "<absolute app dir>", "updates": { "NAME": "value" } }`.

- Edits `<appPath>/.env.local`, preserving unrelated lines and line endings, and writes atomically.
- Rejects invalid names, multiline values and values containing a single quote.
- Reports changed names and `restartRequired: true`; never echoes values.
- A filesystem lock under `/workspace/tmp/kajoo-dev-server/<app-path-hash>` serializes concurrent edits of one app. Do not delete a busy lock.
- Use the platform secret mechanism for credentials that should not sit in `.env.local`.

Restart once after a batch (`preview_stop`, then `preview_run`). `sitecore/scripts/configure-dev-mode.js` imports `updateEnv` from this file; pass its installed absolute path as `envScript`.

The bundle is `common.mjs` (path, lock and atomic-write helpers) and `env-file.mjs`. `env-file.test.mjs` is excluded from publication; run it with `node --test env-file.test.mjs`.
