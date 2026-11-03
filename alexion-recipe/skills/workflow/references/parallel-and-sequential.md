# Sequential and parallel work

A dependsOn edge expresses ordering. Independent tasks in the active phase can run in parallel; a task depending on both is a join. No parallel flag, conditional language, scheduler or event bus is needed.

Use `optionalDependsOn` only for an enrichment whose terminal failure must remain visible but must not block a dependent task (for example, synthesis that can use valid content evidence while recording failed code enrichment). The dependent waits for the optional task to become done, skipped or failed; it never races a still-running task, and a blocked optional task still waits for resolution. The failed optional task itself keeps its phase incomplete. A soft edge does not make the failed task successful or authorize dropping its requested scope.

Before parallel dispatch, check real resources: two tasks editing the same file, target site, repository branch or shared settings are not independent even if the JSON has no edge. Serialize those tasks or separate their resources.

Dispatch a task reference: `Work on <kajoo-task taskId="ACTUAL_ID" name="ACTUAL_NAME" />.` The owner reads the task, linked inputs and acceptance criteria; add only missing task-local facts or exact packet/output references, not copied task/skill instructions. Owners persist their isolated outputs, final Technical report and Kajoo status. Only the coordinator projects validated results into the workflow. A missing agent hint is normal; select by capability, never historical identity. Do not run owners with overlapping writes concurrently; use a dependent integration owner for shared configuration.

Keep phase boundaries explicit. Ask the user to continue, pause or resume in another chat as the domain requires. A new chat reads the same files; it must not reconstruct approvals from conversation summaries.
