# Sitecore development mode

Load the `dev-server` skill for preview lifecycle and environment edits. Run this skill's `scripts/configure-dev-mode.js` through native bash with JSON `{appPath, mode, envScript}`. `envScript` is the installed absolute path of `dev-server/scripts/env-file.mjs`; resolve it from the skill loader, not a guessed repository path.

Modes: `mock`, `mock-debug`, `live`, `live-debug`. Mock sets `USE_MOCK_LAYOUT_SERVICE=true`; live sets false. Debug variants set `RESOLVER_DEBUG=true`; plain variants explicitly set it false. Resolver work requires `live-debug` throughout validation.

Live modes require non-empty `SITECORE_EDGE_CONTEXT_ID` and `SITECORE_EDITING_SECRET` in `.env.local`. Missing names are returned together without values and no partial edits occur. Collect them once and use the dev-server environment script to write a batch. `SITECORE_INTERNAL_EDITING_HOST_URL` defaults to `http://localhost:<port>` (port defaults 3000) and is written only when absent, so pass the launch entry's real `port` and keep it fixed (`autoPort` off); after a port change, update that variable with `env-file.mjs`. The mode operation does not restart: follow with a preview restart (`preview_stop`, then `preview_run`), `preview_list` to confirm it is running, `preview_logs` at `level: error`, then actual render validation.
