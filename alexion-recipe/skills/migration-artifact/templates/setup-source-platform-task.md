# Set up source platform

When creating the task description, copy from `## Goal` through the final Technical report without summarizing or adding sections. Replace the artifact annotation with its verified ID/name, escaping attribute values. Never save placeholders. Keep assignment, phase membership, workflow key and rank in structured records/bindings.

## Goal

Complete the source configuration for <kajoo-artifact artifactId="<migration ID>" name="<migration name>" />: connections, code repository, sandbox checkout and platform details. Reuse confirmed choices and completed work.

## Connection and repository setup

Use **migration-artifact** for these steps:

1. **Select the platform connection.** Reuse a confirmed connection. Otherwise, offer compatible connections and “Create a new connection.” Guide creation through the supported configuration flow.

2. **Select the Git connection.**

   **Which Git connection should I use to access your existing website’s code?**

   - Available connections, recommending one only when context supports it
   - Create a new connection

3. **Find and select the repository.** Fetch repositories through the selected connection. If context suggests a name, search for it and verify the match.

   **Which repository contains the website you want to migrate?**

   - Verified repository candidates
   - Text input alongside the choices: enter another repository name or URL

4. **Select the source branch.** Fetch branches for the selected repository.

   **Which branch should I read to understand and migrate your existing website?**

   - Available branches, recommending one when context supports it
   - Text input alongside the choices: enter another branch

5. **Prepare the sandbox checkout.** Clone or reuse the selected repository and branch. Clone directly into `/workspace/repos/<original-repository-name>`, preserving its name and casing, unless the user explicitly specifies another location. Do not add source/target parent folders; ask for a location if repository names collide. Verify its remote, branch and revision. Preserve existing work and keep source code read-only.

Ask dependent questions after the preceding selection. Use `ask-user-input` for every required answer, including typed values. Don’t add an “I’ll provide it” step. If the user already supplied a value, reuse it.

## CMS-specific configuration

Use the **applicable CMS skill** to:

1. Validate the selected platform connection’s health and required access.
2. Troubleshoot failures, request missing configuration securely and repeat affected checks.
3. Discover and confirm remaining platform details, including:
   - Site name, content root, host name and language
   - Platform version and rendering architecture
   - Application root, framework and SDK version
   - Other details required by the migration scope

Ask only for unresolved information. Record supplied references or an explicit “No additional references” answer. Distinguish verified facts from planned, unknown or deferred values.

## Completion

- Required connections are configured and health checks pass.
- The selected source repository and branch are verified in the sandbox.
- Required platform details and references are recorded.
- Save and read back `content.source` in the linked migration artifact, preserving the target role and unrelated content. Keep supporting evidence under the existing role persistence contract.
- Save supporting evidence and update the task’s Technical report.
- Mark done only after verification. If blocked, record the missing input and next action.

Keep chat updates short and store technical details in the task report.

## Technical report

Not recorded yet. Replace this section with the verified configuration, checkout location, check results, unresolved items and evidence references. Preserve the task instructions above.
