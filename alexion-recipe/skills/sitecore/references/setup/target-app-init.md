# Target application preparation (XM Cloud targets)

Applies to `xpheadless2sai` and `xpmvc2sai`, whose target is a SitecoreAI / XM Cloud Content SDK application. For `xpmvc2xpheadless` the recipe does not assume the starter: follow [target XP Headless](../../../sitecore-mvc-to-xmc/references/target-xp-headless.md) and treat a new rendering-host app as an explicit user decision.

## Adopt or initialize

Inspect configuration through an allowlist of non-secret fields. For `xmcloud.build.json`, report only rendering-host names, paths, Node versions and enabled flags; never print the entire file or `jssDeploymentSecret` values, including when auditing an existing app. Check secret presence or whether a value is a known starter placeholder without returning its value. Do not read environment-file values into tool output.

Inspect the target before creating anything (the Setup phase already requires this). Clone the target repository and branch from `target-git` (see [git operations](../../../cms-migration/references/git-operations.md)) into a new directory under `/workspace/repos/`, or find that it does not exist yet.

| What the target holds | Do |
| --- | --- |
| A working app (`package.json`, `xmcloud.build.json`) | **Adopt** it. Record `setup.initMode: "adopted"`. Never overwrite it unless the user gives an overwrite approval naming that repository and branch. |
| Nothing: no repository, or an empty branch | **Initialize** from the starter, below. Record `setup.initMode: "starter"`. |
| Unrelated content | Stop and ask: adopt, use a separate destination, or approve an overwrite. |

Record and use only the branch the user explicitly confirms after probing the target repository.

## Initialize from the starter

The facts are data in [`assets/setup/xmcloud-starter.json`](../../assets/setup/xmcloud-starter.json): the starter `repository`, the pinned `ref`, the `examplePath`, the upstream files to drop (`removeAfterClone`), the `renderingHost` settings and the `gitignore` lines. Read it and use its values below. The commit is pinned to the last one before the Content SDK 2.0.2 upgrade. Do not move it: the resolver framework and the pair skills target that SDK. The starter is a public repository, so no `gitCredentials` are needed.

Name three paths once and reuse them. `T` must not exist yet: stop if it does, and never write into an existing repository.

```sh
S=/workspace/tmp/chats/<chatId>/scratch/xmcloud-starter   # scratch checkout of the starter
T=/workspace/repos/<target-repo>                          # the new target repository
APP=<appName>                                             # the new app inside it
```

1. **Check out the pinned commit into scratch**, not into a repository:
   ```sh
   git init "$S" && git -C "$S" remote add origin <repository>
   git -C "$S" fetch --depth 1 origin <ref> && git -C "$S" checkout FETCH_HEAD
   ```
2. **Make a clean copy.** `git archive` exports only tracked files, so the starter's history and any installed dependencies cannot come along:
   ```sh
   test ! -e "$T" && mkdir -p "$T" && git -C "$S" archive HEAD | tar -x -C "$T"
   ```
3. **Drop the upstream CI files** listed in `removeAfterClone` (`dmz-validation.yml` and `pr-validation.yml`, which fail with permission errors when pushed to a customer repository). Keep every other workflow:
   ```sh
   rm -f "$T/.github/workflows/dmz-validation.yml" "$T/.github/workflows/pr-validation.yml"
   ```
4. **Create the app from the example.** Stop if `$APP` already exists in the starter:
   ```sh
   test ! -e "$T/$APP" && cp -r "$T/<examplePath>" "$T/$APP"
   ```
5. **Register the app as a rendering host** in `$T/xmcloud.build.json`: add `renderingHosts["<appName>"]` with `path` set to `./<appName>` plus the `renderingHost` values from the data file (`nodeVersion`, `jssDeploymentSecret` which is a placeholder and not a secret, `enabled`). Keep every existing host and every other key, create `renderingHosts` if it is missing, and stop if the app is already registered. The edit tool does this, or:
   ```sh
   node -e "const fs=require('fs'),[p,app]=process.argv.slice(1),c=JSON.parse(fs.readFileSync(p,'utf8'));if(c.renderingHosts?.[app])throw new Error('already registered');c.renderingHosts={...c.renderingHosts,[app]:{path:'./'+app,nodeVersion:'20.18.0',jssDeploymentSecret:'SECRET_FOR_LOCAL_DEV_ONLY',enabled:true}};fs.writeFileSync(p,JSON.stringify(c,null,2)+String.fromCharCode(10))" "$T/xmcloud.build.json" "$APP"
   ```
   Use the values from the data file if they differ from the ones shown.
6. **Write `$T/.gitignore`** from the `gitignore` lines in the data file. If the starter already has one, append only the lines it lacks. It must exclude `node_modules/`, `.next/` and `.env.local`.
7. **Check the result before going on.** Each of these must hold:
   ```sh
   test ! -e "$T/.git"                                        # no template history
   test -f "$T/$APP/package.json" && test ! -e "$T/$APP/node_modules"
   ls "$T/.github/workflows"                                  # only the workflows you kept
   node -e "const c=require(process.argv[1]);console.log(Object.keys(c.renderingHosts))" "$T/xmcloud.build.json"   # lists your app and the existing hosts
   ```
8. **Install dependencies** in `$T/$APP` with the package manager its lockfile implies (`pnpm-lock.yaml`, `yarn.lock`, else npm), on the Node version the project asks for (`.nvmrc`, `engines`). It takes minutes: run it with a long timeout or in the background and read the log. Then check the install is healthy (Gate 0 of the pair skill).
9. **Initialize git and take the baseline**: `git init` in `$T`, set the commit identity, commit everything as `Initial scaffold`, and record a checkpoint as [git operations](../../../cms-migration/references/git-operations.md) describes.
10. **Scaffold the Sitecore framework** into the app with the existing scripts: the [resolver framework](../../../sitecore-headless-to-xmc/scripts/README.md) and the [mock layout service](../../../sitecore-headless-to-xmc/assets/mock-layout-service/README.md). Deliver the captured baseline as [baseline delivery](../discovery/baseline-delivery.md) describes.
11. **Configure the environment** with [dev mode](../dev-mode.md): mock mode needs no credentials; live modes need `SITECORE_EDGE_CONTEXT_ID` and `SITECORE_EDITING_SECRET`, which come from the user and never go into chat or context.json.
12. **Add the preview entry** with the dev-server skill, with `$T/$APP` as its `cwd`.
13. **Record the result** in `context.json`: `roots.target` (`$T`), `roots.app` (`$T/$APP`), `target.appName`, `target.sdkVersion` (the `@sitecore-content-sdk/nextjs` version in `$T/$APP/package.json`), `target.code.repoName` and `branch`, and `setup.initMode` and `initializedAt`. Run `validate-context.mjs`.

Pushing the new repository to the target remote is a separate approved step (see [git operations](../../../cms-migration/references/git-operations.md)). Do not force-push or change remote branch history; obtain explicit approval naming the repository and branch before any push.

The rendering host's `nodeVersion` is an XM Cloud deployment setting written into `xmcloud.build.json`. It is separate from the sandbox's Node version: change it only if the starter's `engines` require it.
