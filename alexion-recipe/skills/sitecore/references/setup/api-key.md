# Sitecore API Key — the 400-vs-403 diagnostic & repair

How `sitecore-developer` repairs a missing or wrong source Sitecore API Key so the Layout Service / GraphQL authenticate. Runs the relocated SPE scripts via **`run-powershell-script`** (source connector); the orchestrator reconciles the connector header.

## Why the API key matters (the diagnostic)
The source connector authenticates the Layout Service / GraphQL with an `x-graphql-api-key` header whose value is the **GUID of an API Key item** under `/sitecore/system/Settings/Services/API Keys`. If that item is missing or its fields are wrong:
- **HTTP 400** from the Layout Service / GraphQL endpoint = the API Key **item doesn't exist** for the GUID in the header (or the key GUID is malformed). This is the `needs-api-key` verdict — repair BEFORE the HS/SPE gates, because a 400 short-circuits the validator so downstream gates never fire.
- **HTTP 403** = the item exists but its **CORS Origins / AllowedControllers / Impersonation User** are wrong (or the caller's origin isn't allowed).

The probe surfaces the suspected key GUID as `capabilities.layoutService.suspectedKeyId`.

## Repair workflow
The goal is: an API Key **item whose GUID equals the connector's `x-graphql-api-key`**, with correct fields. Two paths:

**A. Connector already has a key GUID (the common case — `suspectedKeyId` present).** Recreate/repair the item *at that exact GUID* so it matches the header — no connector write needed.
1. **Read** (optional confirm): run `scripts/setup/get-sitecore-api-key.ps1` with `params: { apiKeyId: <suspectedKeyId> }`. `status: not-found` confirms the 400 cause; `found` with wrong fields confirms the 403 cause.
2. **Ensure:** run `scripts/setup/ensure-sitecore-api-key.ps1` with `params: { apiKeyId: <suspectedKeyId>, name: "JSS API Key", corsOrigins: "*", allowedControllers: "*", impersonationUser: "extranet\\Anonymous" }`. It creates the item with `New-Item -ForceId <suspectedKeyId>` (so the GUID matches the header) or updates its fields, and round-trip-verifies from the database.
3. **Re-probe:** repeat the original source Layout Service/API probe through the configured connector and save the sanitized result.

**B. No key GUID on the connector at all.** Run `ensure-sitecore-api-key.ps1` with `apiKeyId: ""` (mints a fresh GUID, returns `apiKey.id` + `generatedId: true`). Then the **orchestrator must write that new GUID into the connector's `x-graphql-api-key`** so header and item match — surface the new GUID for the orchestrator/user to reconcile the connector config. Do not leave a minted key un-reconciled.

## Field-name gotchas (Sitecore XP 10.4 — get these exactly right)
- **`AllowedControllers` has NO space.** The spaced variant silently no-ops.
- **`CORS Origins`** and **`Impersonation User`** both have spaces.
- **`Impersonation User` MUST be `extranet\Anonymous`** — `sitecore\Anonymous` / `sitecore\admin` are wrong / unsafe.

## Running the scripts
Read the script (`read`), then `run-powershell-script` on **`source-sitecore`** with `script: <file body>` and the `params` named in the script's `.INJECTED_VARIABLES` header (injected as `$variables` — do not string-interpolate). Poll `get-tool-results`; the script `ConvertTo-Json`s a `{ status, apiKey, error }` object.

## Failure / safety
- `ensure` returns `status: "failed"` with `error` on template-missing / folder-missing / invalid GUID / round-trip-verify failure — surface verbatim; do not retry blindly.
- Never invent a key GUID — use `suspectedKeyId`, or mint one via the script and reconcile the connector.
- Manual fallback (R4c): recreate the item via Content Editor / SPE ISE at the connector's GUID with the three field values above, using `New-Item -ForceId` so the GUID matches.
