# Set up target platform

When creating the task description, copy from `## Goal` through the final Technical report without summarizing or adding sections. Replace the artifact and prerequisite annotations with actual verified IDs/names. Escape annotation attributes and never save placeholders. Keep assignment, phase membership, workflow key and rank in structured records/bindings.

## Goal

Complete the target platform configuration for <kajoo-artifact artifactId="<migration ID>" name="<migration name>" />, including its connections, repositories, sandbox checkouts and CMS-specific details.

Read the current task and linked migration artifact first. Reuse confirmed choices and completed work.

Start only after <kajoo-task taskId="<source task ID>" name="Set up source platform" /> is complete.

## Connection and repository setup

Use **migration-artifact** for these steps:

1. **Select the platform connector.** Reuse a suitable existing connector. If none exists and one is required, guide the user through creating and configuring it.
2. **Select the Git connector.** Reuse a suitable existing connection. If none exists and repository access requires one, guide the user through creating it.
3. **Select repositories and branches.** Confirm which repositories belong to this role and their purpose. Reuse existing selections rather than asking again.
4. **Clone repositories into the sandbox.** Use the selected Git connection for authentication. Clone directly into `/workspace/repos/<original-repository-name>`, preserving its name and casing, unless the user explicitly specifies another location. Do not add source/target parent folders; ask for a location if repository names collide. Verify each checkout’s remote, branch and revision. Preserve existing work and keep source checkouts read-only.

If the target has no repository yet, record that explicitly and hand repository/application initialization to CMS-specific setup. Do not treat cloning as permission to overwrite, initialize or push.

## CMS-specific configuration

Load the **applicable CMS skill** for these steps:

1. **Validate platform connector health.** Run the platform-specific access and capability checks required for this role.
2. **Troubleshoot failures.** Diagnose the actual error, correct safe configuration issues and repeat affected checks. Request missing credentials or approval when required.
3. **Complete platform configuration.** Discover and confirm applicable details, such as:
   - Site name and content root
   - Host name and language
   - Platform version and rendering architecture
   - Application root, framework and SDK version
   - Other fields required by the selected CMS and migration scope

Ask only for information that cannot be established reliably from existing configuration or platform/repository evidence. Distinguish verified, planned and deferred values.

## Completion

- The required platform and Git connections are selected and configured.
- Required repositories are selected and verified in the sandbox.
- Applicable CMS health checks pass.
- Required platform configuration is complete and verified.
- Save and read back `content.target` in the linked migration artifact before completing this task; preserve the other role and unrelated content. Keep the verified role file and read-back evidence under the existing role persistence contract.
- Update this task’s Technical report and final status. If blocked, identify the missing input and next action.

Keep chat updates short. Store configuration details and technical evidence in the saved task report and linked outputs.

## Technical report

Not recorded yet. Replace this section with the verified configuration, checkout locations, check results, unresolved items and output references. Preserve the task instructions above.
