# Render validation and evidence

Validate the changed component in its actual route and parent layout. Resolve target root, package scripts, lockfile, preview origin and source baseline first. Use the dev-server skill (the platform preview tools) for lifecycle and the returned preview `url`; do not guess a public hostname from localhost.

## Native procedure

1. Read package scripts and run the relevant existing type/build checks through bash from the target root. Capture command, working directory, exit code and log path. LSP diagnostics help locate errors but do not replace the required build.
2. Find the application preview with `preview_list`, and start it with `preview_run` if it is not running. Record its `serverId`, port and data mode. Restart it (`preview_stop`, then `preview_run`) after configuration or environment changes, and check `preview_logs` at `level: error` before probing.
3. Probe each selected route with a bounded HTTP request, for example `curl --max-time 30 --silent --show-error --dump-header "$HEADERS_PATH" --output "$BODY_PATH" "$ROUTE_URL"`. Resolve variables to new workspace evidence files and the actual URL. Record status, content type, redirect location and a recognizable route/component marker; inspect error HTML even when status is 200. Follow redirects only after checking their destination.
4. Open the route in a supported browser. Capture console errors, failed requests, hydration issues, unknown components and missing assets. Wait for fonts/data to settle before screenshots; record viewport and capture conditions.
5. Compare source and target at matching route, site, language, content and viewport. Check DOM/selector structure, typography, spacing, responsive wrapping and overflow. Exercise menus, keyboard focus, forms, validation, dialogs, scrolling and route navigation relevant to the migrated behavior.
6. Repeat navigation or mount/unmount for listener-driven components to expose duplicate handlers and stale state. Include empty/missing data and nested/repeated instances where they affect the change.

## Result contract

Save a route matrix with URL, route identity, data mode, baseline path, viewport, build/probe/browser outcomes and evidence paths. Each check is passed, failed or not run, with reason. For failures include reproduction steps, expected/actual behavior, relevant source/target coordinates and likely owner. Keep credentials and personal data out of saved logs and screenshots.

Mock rendering proves only the recorded fixture scope. Record fixture provenance and missing data; live resolver, editing, personalization and authentication checks remain separate pair-skill checks. A build pass does not prove route rendering; an HTTP pass does not prove hydration; a screenshot does not prove interaction parity.

The native probe is available with Node 20+ and no installed dependencies:

`node scripts/probe-render.mjs --url http://127.0.0.1:<port>/example --marker expected-component --reject-marker 'Application error' --timeout-ms 5000`

Use the port `preview_list` reports for the entry. Only credential-free localhost, 127.0.0.1 and ::1 HTTP(S) URLs are accepted. Redirects are reported and never followed. Repeated --marker strings must all be present; repeated --reject-marker strings must all be absent. --status defaults to 200. The total request/body timeout defaults to 5000 ms and is capped at 60000 ms. --max-bytes defaults to 1048576 and is capped at 10485760. Limit, timeout, connection, interrupted-response, status and marker failures cannot report readiness success. No retry, browser or application process is started.

Stdout is JSON with ready, browserParity (always not-run), status, contentType, redirect presence, marker results and bodyBytes; transport/limit failures include error. Query strings and response bodies are omitted. Avoid secrets in paths/marker arguments. Exit 0 means explicit HTTP checks passed, 2 means failed checks, 1 means invalid invocation. A 200 response without markers proves only endpoint reachability; supply meaningful positive/error markers for route evidence.

No retired render tool is required. If browser/baseline evidence is unavailable, explicitly leave visual/interaction parity unverified. Return evidence to the existing writer without automatically completing a migration phase.
