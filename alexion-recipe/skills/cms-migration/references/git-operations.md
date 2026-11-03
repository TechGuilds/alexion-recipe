# Git operations

Repositories are worked with native bash. There is no migration git service: cloning, checkpoints and pushes are ordinary git commands run in the resolved source and target roots. This page fixes the parts that are easy to get wrong.

## Authenticated commands

- Set the bash tool's `gitCredentials` to the connector's name or ID (`source-git` for the source repository, `target-git` for the target) on every command that talks to the remote: `clone`, `fetch`, `pull`, `push`, `ls-remote`. Credentials are minted per call and injected for that command only, so repeat the parameter each time. Local commands (`status`, `diff`, `add`, `commit`, `log`) need none.
- Use plain HTTPS remote URLs with no token: `https://github.com/<owner>/<repo>.git` or `https://dev.azure.com/<org>/<project>/_git/<repo>`. Never put a token in a URL, `git remote`, `git config`, `.git-credentials`, an env file, evidence or a task result. SSH is not supported.
- Credentials apply only under the connector's own owner (GitHub) or organization and project (Azure DevOps), and redirects are not followed. A repository outside that scope will not authenticate; confirm the connection rather than trying another credential.
- `No enabled Git connection found` means the connection is missing, disabled or not attached to your agent. A 401/403 means the connection lacks access to that repository. Report either as a setup blocker with the connector name. Never ask for a token in chat.
- Read-only inspection of repositories and branches is also available through the connector's `list-repositories` and `list-branches` tools. Use the active profile's Setup procedure to confirm repository and branch.

## Checkout location

Clone repositories directly into `/workspace/repos/<original-repository-name>`, preserving
the original repository name and casing, unless the user explicitly requests another
location. Do not introduce source/target parent directories or silently rename checkouts.
For example, `website-repo` belongs at `/workspace/repos/website-repo`; an app nested inside it
remains a separate application root. Verify the remote, branch and local changes before
reusing an existing directory. A name collision or incompatible source/target branch
requires the user's choice of separate checkout locations; never overwrite existing work.
On resume, keep recorded existing roots intact unless the user requests relocation.

## Source and target

The source is read-only: clone it with `source-git` and never commit or push there. The target work happens on a dedicated work branch, not the repository's default branch, unless the user names the default branch explicitly. Extract uploaded archives with `scripts/extract-archive.mjs`, which drops any `.git` directory; clone the repository instead if history is needed. With no existing target repository, follow the active profile's target initialization procedure, run `git init` in the repository root, make sure `.gitignore` excludes dependency/build output and environment files, and commit a baseline (`Initial scaffold`) before the first change so a checkpoint has something to restore to.

A fresh sandbox has no commit identity: the platform used to author every migration commit as `Kajoo Migration <migration@kajoo.ai>` by setting the git author and committer variables on each command, and neither the sandbox tools nor `gitCredentials` do that any more. Before the first commit in a repository, set it repo-locally: `git config user.name 'Kajoo Migration'` and `git config user.email 'migration@kajoo.ai'`, so history stays consistent with earlier migrations. Use the requesting user's own name and email (from the system prompt's user details) only if the user asks for their commits to carry it. Do not use `--global`.

## Checkpoints

Follow [checkpoints](checkpoints.md) for scope and restore rules. The recoverable state before a task is its **base**; the checkpoint is the commit made once the task's checks pass. The git mechanics:

1. Before the first edit of a task, run `git status --porcelain` and `git rev-parse HEAD` in the target root. If a path the task will edit already has uncommitted changes, commit only those paths as `checkpoint(<taskId>): baseline` so the pre-task state is recoverable. Everything else you did not make stays untouched and unstaged. The base is the resulting `HEAD`.
2. After the task's checks pass, stage exactly the task's changed paths (`git add -- <path>...`, never `git add -A`) and commit:

   ```
   checkpoint(<taskId>): <short summary>

   Task: <taskId>
   Phase: <phase id>
   Base: <base hash>
   Scope: <comma-separated paths or component names>
   ```

3. Read the hash with `git rev-parse HEAD` and return `checkpoint: { "reference": "<full hash>", "scope": [<paths>] }` in the task result. The hash is the checkpoint: a tag is optional. A task that changed nothing returns `checkpoint: null`. Never report a checkpoint you did not create.
4. A local commit is enough for a checkpoint. It is not a backup of remote content, connector configuration or application state.

Restore only the approved scope. Inspect the diff first and take a safety commit of the current state. To undo a task, use its `Base` (`git show -s --format=%B <hash>`): `git restore --source <base> -- <paths>`. To return to a checkpoint, use `git restore --source <hash> -- <paths>`. Do not use `git reset --hard` or `git clean`, which discard unrelated work.

## Push, overwrite and force

Pushing is an outward change and needs an explicit user response scoped to the exact repository and branch, recorded as a mutation decision (see [decisions and approvals](decisions-and-approvals.md)). Changing repository or branch invalidates it.

A non-fast-forward push, a force push, or anything that replaces existing remote content also needs an overwrite decision naming that branch and the commit it will replace. Fetch first and compare. After approval prefer `--force-with-lease=<branch>:<expected-hash>` over `--force`. Never force-push the default branch, and never push the source repository.
