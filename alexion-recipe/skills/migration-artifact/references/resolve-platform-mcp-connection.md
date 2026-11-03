# Resolve a platform connection and label

Load this file only at the role-selection step, after the operation-wide tool preflight. Reuse it for both roles; do not reread it between roles. Tool discovery is not deferred to this interview: any offered creation branch must have been checked upfront. If scope changes or a capability unexpectedly becomes unavailable, recheck before further writes and preserve completed work.

Run only for the assigned source or target role. This selection procedure resolves type, connectorId and displayName; the same task uses its CMS skill afterward for health and remaining configuration.

## 1. Resolve type

Read the allowed IPlatform.type values for this role from the active artifact schema. Use the first matching rule:
1. The user explicitly chose a supported type, or the role already has a valid type and no change was requested: reuse it without asking again.
2. Exactly one type is supported: select it automatically. Do not ask for platform or migration-direction confirmation.
3. Multiple types are supported and no type is resolved: use ask-user-input to ask which platform to use for this role. Offer schema-supported types only.
4. No types are supported or the schema is unavailable: report the limitation; do not guess.

An explicit unsupported request takes precedence over automatic selection: explain the mismatch, never silently substitute. Product/edition choices are not type choices.

## 2. Resolve connectorId

Use the first matching rule:
1. The user explicitly requests a new connection for this role: start the creation flow below, without a redundant existing-versus-new question.
2. The user explicitly selects a connection by ID or name: resolve and validate it in this workspace, then reuse it without confirmation if unambiguous.
3. The artifact already has a valid confirmed link, or chat history clearly records the user's selection for this role: reuse it unless a change was requested.
4. Only project/workspace context suggests a connection: recommend it and confirm the role assignment before using it, allowing selection of a different or new connection.
5. No connection is resolved: list compatible workspace connections, completing pagination:
   - One or more: ask "Which connection should be the source?" (or target), offering candidates by name plus "Create a new connection". Wait for the choice. Apply this even with one candidate.
   - None: inform the user and start the supported creation flow; do not ask them to select from an empty list.

Reuse one current workspace inventory across source and target, filtering separately for each role's selected type. Match compatibility from connector schema/metadata, not names alone or an assumption that connector kinds equal platform-type strings. Refresh only when connection state changed or inventory is incomplete. Respect ask-user-input option limits; narrow or paginate choices without dropping the creation option.

A missing explicitly referenced connector or a failed lookup is not an empty result: explain or resolve the error rather than silently creating a substitute.

### Creation flow

Guide the user through supported connection creation/authentication, then resolve and select the created record. Keep required endpoint/credential configuration inside that dedicated flow, not an expanded platform interview. Use secure credential/OAuth entry; never collect secrets in ordinary chat or artifact fields. Reuse a record created during a partial attempt. If creation cannot finish, record the exact blocker and stop this role.

Use actual connector IDs. Do not modify shared connections merely to fit this migration. A connected status is not live health evidence. Do not assign the source connection to target by default; resolve target separately. If the user selects the same connection for both roles, make that arrangement explicit and confirm only if their selection did not already clearly authorize both roles.

## 3. Resolve displayName

Choose the first available value:
1. An explicit label the user requested for this role.
2. Its existing non-empty displayName.
3. The selected connector's non-empty name.
4. "Source" or "Target", matching the role.

Use a readable schema-valid label; trim surrounding whitespace and obey the field length limit without inventing a site or product identity. Do not ask a separate naming question or overwrite a meaningful existing label just because the connector changed.

## 4. Hand the selection to this role's remaining steps

Save the resolved `type`, `connectorId` and `displayName` in this task's isolated role configuration, preserving existing verified role fields and actual choice provenance. As this sequential role owner, save and read back the selected values in the assigned artifact role, merging with the latest complete artifact content and preserving the opposite role. Save later verified fields there before completing the task. Read back the task-owned file before completing the task.

Continue this same role task with Git connector/repository selection and acquisition under its template, then use the CMS-specific skill for health/troubleshooting and remaining platform details. This selection step alone does not complete the role. Missing required selection or secure authentication blocks this role, not the independent other role. Do not launch the other role yourself.
