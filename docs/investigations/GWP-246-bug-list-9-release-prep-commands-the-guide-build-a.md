# GWP-246: run release-prep project commands inside the runner sandbox

## 1. Question

Release docs prep (`release.docs_prep`) runs project commands in a throwaway worktree: the PDF guide build, the
assistant-pack generator and the video recorder. Today they run as plain child processes of the runner user, with the
runner's full environment. How do we put every such command through the runner's existing bubblewrap sandbox
(`apps/runner/src/runs/sandbox.ts`), fail closed when the sandbox cannot start, and leave outputs, step reporting and
runner git plumbing unchanged?

## 2. Findings

### 2.1 The exec seam today

- `DocsPrepExec` (`apps/runner/src/git/release-docs-prep-steps.ts:39`) is `(cmd, args, {cwd, timeoutMs}) => {exitCode,
  stdout, stderr, timedOut}`. Steps get it as `ctx.exec`.
- `runSpec` (`apps/runner/src/git/release-docs-prep.ts:348`) passes `input.exec ?? noExec` into the step context. It
  also creates `outDir` with `mkdtemp(tmpdir())`.
- The only production caller is `Runner` (`apps/runner/src/runner.ts:2605`). It calls `this.exec.run` (the
  `realExecutor` of `apps/runner/src/toolchain/exec.ts`) with the toolchain env and PATH. `realExecutor` always merges
  `...process.env` (execa also extends env by default), so the command inherits the runner's whole environment,
  including `AOM_*`, tokens and the user/session bus. There is no sandbox. `timedOut` is always reported as `false`.

### 2.2 Who runs project commands

| Step | File | Project commands | Through `ctx.exec`? |
|---|---|---|---|
| changelog | `release-docs-prep-changelog.ts` | none (in-process + git) | n/a |
| help | `release-docs-prep-help.ts` | none (in-process + git) | n/a |
| guide (`apply`) | `release-docs-prep-guide.ts:380-395` | `corepack pnpm install --frozen-lockfile --prefer-offline`, `corepack pnpm --filter @aom/e2e exec playwright install chromium`, `node docs/guide/assemble-guide.mjs`, `node docs/guide/build-guide.mjs [--date …] [--edition …]` | yes |
| assistant-pack | `release-docs-prep-assistant-pack.ts:38-49` | `corepack pnpm install …`, `corepack pnpm --filter @aom/server assistant:pack` | yes. The header comment says it deliberately runs outside the sandbox. |
| videos (`plan`, `render`) | `release-docs-prep-videos.ts` | own `spawn` helper (`:80-110`): `process.execPath -e <import packages/video/src/voice.ts, ffmpeg.ts>` (voice probe, `:151-168`), `pnpm install`, `pnpm build`, `pnpm --filter @aom/e2e video` (recorder), `psql … DROP DATABASE` (cleanup) | **no**: it spawns directly with `process.env` |

So AC3 ("no docs-prep step spawns a project command outside it", including the videos step) means the videos step has to
move onto `ctx.exec`. In-process `git` reads in the steps (`changedPaths`, `changesOf`, `inputsHash`, …) and the
framework's commit/worktree/lock/push are runner plumbing and stay out of scope.

### 2.3 What the sandbox offers today

- `sandboxCommand(spec, argv)` → `bwrap <bwrapArgs> -- argv`. `bwrapArgs`: `--ro-bind / /`, `--dev`, `--proc`,
  `--unshare-pid`, `--unshare-ipc`, optional `--unshare-net`, `--cap-drop ALL`, a tmpfs or `/dev/null` over each
  `maskedPaths` entry (runner root, `HOME_SECRETS` under the real home, `BROWSER_MASKED` sockets, `/run/user/<uid>`),
  read-only git dirs, `runTmp` bound over `/tmp`, read-write binds for `worktrees` and `cacheRoot`, and optionally the
  .NET user secrets.
- `ServiceLauncher.sandboxAvailable()` does a real trial `bwrap … true` once per process. It returns `false` on any
  platform other than Linux.
- `RunManager.baseEnv(true)` (`runs/manager.ts:1163`) builds the sandboxed env: `scrubEnv(process.env)` (drops
  `AOM_*`, `CLAUDE*`/`ANTHROPIC*`, anything matching `SECRETISH`, `SSH_AUTH_SOCK`, `DOCKER_*`, `XDG_RUNTIME_DIR`, the bus),
  toolchain PATH, `HOME=/tmp/home`, `TMPDIR=/tmp`, XDG dirs under `/tmp/home`, .NET switches, and `cacheEnv(cacheRoot)`.
- `RunManager.checkLaunch` is the closest existing profile, but it does not fit as it stands. (a) It follows the runner's
  sandbox mode config: with `mode: 'off'`, or `best_effort` + `allowUnsandboxed`, it runs **unsandboxed**, which breaks
  AC6. (b) It forces the offline package-manager env and offers no write path for the Playwright browsers, which breaks
  AC7 on a cold cache.
- Network policy: run steps and services (`RunManager.launch`) use `network: 'host'`. Checks and worktree preparation use
  `none`. The bwrap profile has **no per-host allowlist**: it is host network or nothing. The proxy allowlist exists only
  in the agents' Claude Code sandbox.
- Run steps mask only **this** pairing's root (`paths.root`). Sibling pairings (`<machine data dir>/pairings/<other>`)
  and `pairings.json` stay readable there. Requirement 4 asks that docs-prep commands cannot read other pairings, so the
  docs-prep profile needs one extra mask (see 4.3). Run steps themselves are not changed (constraint); a backlog
  suggestion covers them.
- Tests for `bwrapArgs`/`maskedPaths` already exist (`test/runs-p2.test.ts:160-210`, `test/runs-guides.test.ts`,
  `test/handoff-checks-offline.test.ts`), but none covers a docs-prep profile.

### 2.4 Things that change when HOME and env are scrubbed (traps)

1. **Playwright browsers.** `playwright install chromium` writes a lock and `.links/` into the browsers dir on every
   run, even when the browser is already there. Today that dir is the real `~/.cache/ms-playwright`, or
   `PLAYWRIGHT_BROWSERS_PATH`. Inside the sandbox HOME is `/tmp/home` (thrown away) and the real home is read-only. Fix:
   set `PLAYWRIGHT_BROWSERS_PATH=<cacheRoot>/ms-playwright`, which is writable because `cacheRoot` is already bound
   read-write. The browser revision is pinned by the lockfile's Playwright version, so output does not change. The
   videos recorder launches Chromium too, but today never runs `playwright install`, so the videos build list must gain
   the same install command.
2. **Corepack.** `corepack pnpm` resolves `packageManager: pnpm@12.8.1`. Today it uses the real
   `~/.cache/node/corepack`. Set `COREPACK_HOME=<cacheRoot>/corepack` (writable, shared). The first use fetches pnpm from
   `registry.npmjs.org` (host network).
3. **pnpm store.** `cacheEnv` points pnpm at `<cacheRoot>/pnpm`, the store run steps already share. It sits on the same
   filesystem as the integration worktree (both under the runner root), so hardlinks work. Packages missing from the
   store are fetched once (`--prefer-offline`).
4. **Video toolchain.** `packages/video/src/voice.ts` reads `AOM_VIDEO_HOME` (default `~/.cache/aom-video`), and
   `AOM_FFMPEG`, `AOM_KOKORO_PYTHON` and `AOM_PIPER`. `scrubEnv` drops every `AOM_*`, and HOME moves, so the voice would
   become "unavailable". The voice also writes an audio cache under `AOM_VIDEO_HOME/audio`. Fix (videos step only): pass
   these four tool-location variables through. Set `AOM_VIDEO_HOME` explicitly (inherited value, else
   `<realHome>/.cache/aom-video`) and bind that dir read-write when it exists. Also pass `AOM_E2E_PG_HOSTPORT` (the
   recorder's Postgres address).
5. **Video staging.** `render` stages under `tmpdir()`, and the recorder writes to `AOM_VIDEO_OUT`. Inside the sandbox
   `/tmp` is private, so staging moves under `ctx.outDir`, which the profile binds read-write at the same path.
6. **Voice probe.** It runs `process.execPath` (the runner's node) on project modules. Route it through `ctx.exec` as
   `node` from the toolchain PATH, as the guide step already does with `node assemble-guide.mjs`. Toolchain node 22.23
   strips types by default. If the runner's node is outside the masked data dir, `process.execPath` is acceptable too.
   The builder picks one and states it.
7. **psql cleanup.** It is best effort, and `PGPASSWORD`/`~/.pgpass` are not visible in the sandbox. Use the
   harness's own URL (`postgres://aom:aom@${AOM_E2E_PG_HOSTPORT ?? '127.0.0.1:5433'}/postgres`) so it keeps working.
   These are the credentials already written in `e2e/support/env.ts`; no secret is added.
8. **Pack builder and guide build** read no env and no home paths (`OPEN_SOURCE_LIVE` is a constant, and the guide fonts
   are bundled in `docs/guide/assets/fonts`). Output is the same for the same input.

## 3. Options

| | A. New docs-prep profile on `sandbox.ts` (recommended) | B. Reuse `RunManager.checkLaunch` | C. Keep `Executor`, wrap argv in `bwrap` |
|---|---|---|---|
| Fail closed (AC6) | yes: always requires bwrap and ignores the sandbox-mode config | no: follows `off`/`best_effort` config; needs a new flag on a shared method | yes |
| Env scrubbed | yes (own spawn, `extendEnv:false`) | yes | **no**: `realExecutor` spreads `process.env` into bwrap, and bwrap passes it on |
| Writes worktree + outDir only | yes (exact binds) | worktree only | yes |
| Network/browser/corepack needs | host network, Playwright/corepack in `cacheRoot` | offline env forced: cold cache fails, which breaks AC7 | as A |
| Other callers touched | none (optional fields only) | `checkLaunch` signature grows; supervisor callers at risk | none |
| Second sandbox implementation | no (composes `sandboxCommand`, `scrubEnv`, `cacheEnv`, `ServiceLauncher`) | no | no |

Option A is the only one that meets AC6 and the env scrub without changing a shared code path.

## 4. Recommendation and design

### 4.1 Shape

`runSpec` builds `ctx.exec` from a **factory** bound to the step's scope, not from a ready-made exec. The production
factory always sandboxes, and the steps can only reach a process through `ctx.exec`. A guard test keeps it that way.

```ts
// release-docs-prep-steps.ts
export type DocsPrepExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }, // env: NEW, extra vars for this command
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export interface DocsPrepExecScope { step: string; phase: string; worktree: string; outDir: string; runId: string; repoId: string }
export type DocsPrepExecFactory = (scope: DocsPrepExecScope) => DocsPrepExec;

/** Thrown by the exec seam when the sandbox cannot be set up; the command was not run. */
export class DocsPrepSandboxError extends Error {}
```

```ts
// release-docs-prep.ts
export interface ReleaseDocsPrepInput { /* … */ execFor?: DocsPrepExecFactory; /* replaces `exec` */ }

async function runSpec(input, spec, wt, start) {
  const outDir = await mkdtemp(join(tmpdir(), `docs-prep-${input.payload.step}-`));
  const scope = { step: p.step, phase: p.phase ?? '', worktree: wt, outDir, runId: p.runId, repoId: p.repoId };
  try {
    return await spec.run({ …, exec: input.execFor?.(scope) ?? noExec });
  } catch (err) {
    if (err instanceof DocsPrepSandboxError) return { ok: false, error: err.message };
    throw err;
  } finally { await rm(outDir, …); }
}
```

Replace the `exec` input with `execFor` instead of keeping both, so there is one door. The test call sites change
mechanically (`exec: e.exec` → `execFor: () => e.exec`): about 10 places in `test/release-docs-prep-{guide,help,
changelog,assistant-pack}.test.ts`.

### 4.2 New module `apps/runner/src/git/release-docs-prep-exec.ts`

```ts
export interface DocsPrepSandboxDeps {
  runnerRoot: string;           // paths.root (masked)
  realHome: string;             // homedir()
  cacheRoot: string;            // sharedCacheRoot(paths)
  launcher: Pick<ServiceLauncher, 'sandboxAvailable'>;
  toolchains: () => Pick<ResolvedToolchains, 'pathDirs' | 'env'>;
  spawn?: DocsPrepSpawner;      // default: execa, extendEnv:false, reject:false, stdin 'ignore', output redacted
  log?: Pick<Logger, 'info'>;
  platform?: NodeJS.Platform;
}
export type DocsPrepSpawner = (cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number })
  => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export function sandboxedDocsPrepExec(deps: DocsPrepSandboxDeps): DocsPrepExecFactory
export function docsPrepSandboxSpec(deps, scope, runTmp): SandboxSpec     // pure, for tests
export function docsPrepEnv(deps, scope, extra?): Record<string, string>  // pure, for tests
export function machineDataDir(runnerRoot: string): string                // `<x>/pairings/<id>` → `<x>`, else runnerRoot
```

Per call, `exec(cmd, args, {cwd, timeoutMs, env})`:

1. **cwd check**: `realpath(cwd)` must be inside `scope.worktree` or `scope.outDir`. Otherwise throw
   `DocsPrepSandboxError`.
2. **Availability**: if `platform !== 'linux'`, throw `DocsPrepSandboxError(\`release prep step '${label}' needs the
   Linux bubblewrap sandbox to run ${cmd}; this workstation runs ${platform}. The command was not run.\`)`. If
   `!(await launcher.sandboxAvailable())`, throw with `bubblewrap is not available or cannot start here (install
   bubblewrap: apt install bubblewrap)`. Here `label` is `step` or `step/phase`. **The sandbox-mode config
   (`runtimes['claude-code'].sandbox`, `allowUnsandboxed`) is ignored on purpose**: there is no unsandboxed path.
3. **Prepare**: `runTmp = <agentTmpRoot()>/aom-docsprep-<sha256(runId,repoId,step,phase) first 10 hex>`, created with
   `home/` (0700). Run `ensureSharedCaches(cacheRoot)`, and `mkdir -p <cacheRoot>/ms-playwright <cacheRoot>/corepack`.
   Remove runTmp after the call (`finally`).
4. **Spec** (`docsPrepSandboxSpec`):
   ```ts
   {
     runnerRoot, realHome, cacheRoot, runTmp,
     worktrees: [scope.worktree, scope.outDir, ...(videoHome && scope.step === 'videos' ? [videoHome] : [])],
     gitDirs: gitDirOf(scope.worktree),   // read-only; move gitDirOf from runs/manager.ts into sandbox.ts as an export
     userSecrets: false,                  // never the .NET user secrets
     network: 'host',                     // same as run steps (see 4.4)
     extraMasked: [machineDataDir(runnerRoot)], // NEW: hides sibling pairings and pairings.json
     dieWithParent: true,                 // NEW: a timeout or runner exit takes the whole tree down
   }
   ```
5. **Env** (`docsPrepEnv`): `scrubEnv(process.env)`, then `toolchains().env` (filtered through `scrubEnv` too), then
   `PATH = [...pathDirs, scrubbed PATH, ...userBinDirs(realHome), ...BREW_BIN_DIRS]`. This is the PATH `realExecutor`
   builds today, so `corepack`/`node`/`pnpm` resolve the same way. Then `HOME=/tmp/home`, `TMPDIR/TMP/TEMP=/tmp`, the
   XDG dirs under `/tmp/home`, and the .NET switches as in `RunManager.baseEnv(true)`, plus `cacheEnv(cacheRoot)`,
   `PLAYWRIGHT_BROWSERS_PATH=<cacheRoot>/ms-playwright`, `COREPACK_HOME=<cacheRoot>/corepack`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
   `DEBIAN_FRONTEND=noninteractive`, `GIT_TERMINAL_PROMPT=0`. For the videos step only, add the pass-through
   `AOM_VIDEO_HOME` (inherited, else `<realHome>/.cache/aom-video`), `AOM_FFMPEG`, `AOM_KOKORO_PYTHON`, `AOM_PIPER` and
   `AOM_E2E_PG_HOSTPORT` when set. Finally the per-call `opts.env` from the step. Keep the HOME/XDG/.NET block a small
   local constant with a comment pointing at `baseEnv`. Do **not** refactor `RunManager` for it.
6. **Spawn**: `sandboxCommand(spec, [cmd, ...args])`, then `spawn(c.cmd, c.args, {cwd, env, timeoutMs})`. Log one
   info line: `release prep <label>: <cmd> <first args…> (sandboxed: bwrap)`, which is test plan item 6.
7. **Setup failure after spawn**: bwrap exits 1 and prints `bwrap: …` on stderr when a bind/mount/exec fails (for
   example `bwrap: execvp corepack: No such file or directory`). If `exitCode !== 0` and the first non-empty stderr line
   starts with `bwrap: `, throw `DocsPrepSandboxError(\`release prep step '${label}' could not start ${cmd} in the
   sandbox: ${line}\`)`.
8. Return `{exitCode, stdout, stderr, timedOut}`. `timedOut` now comes from execa: that is what the steps' existing
   `r.timedOut ? 'timed out' : tail` branch expects, and the production wiring had dropped it. The timeout values do not
   change. This is the one visible difference, and only in a failure message.

### 4.3 `apps/runner/src/runs/sandbox.ts` (small, additive)

- `SandboxSpec.extraMasked?: string[]`: masked like the runner root. Put these entries **first** in the mask list, so a
  parent tmpfs never hides a child mask made before it. Run them through `maskedPaths`' existing realpath/symlink
  handling (add the field to its `Pick`).
- `SandboxSpec.dieWithParent?: boolean`: appends `--die-with-parent` when true. It defaults to off, so services keep
  outliving the runner (as the comment at the top of the file requires).
- `export function gitDirOf(worktree)`: moved verbatim from `runs/manager.ts:153`, which then imports it.
- Nothing else changes. With neither new field set, `bwrapArgs` returns byte-identical args for every current caller.
  Add a regression assertion for that to `test/runs-p2.test.ts`.

### 4.4 Network (AC5 / requirement 5)

The policy is `network: 'host'`, the same as sandboxed run steps (`RunManager.launch`). The bubblewrap profile has no
per-host allowlist (that mechanism exists only in the agents' proxy sandbox), so no new mechanism is invented here. The
hosts these commands may contact, named for the record:

| Command | Host | When |
|---|---|---|
| `corepack pnpm …` | `registry.npmjs.org` | pnpm 12.8.1 not yet in `<cacheRoot>/corepack` (first run) |
| `pnpm install --frozen-lockfile --prefer-offline` | `registry.npmjs.org` | a locked package missing from `<cacheRoot>/pnpm` |
| `playwright install chromium` | `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` (Playwright's own fallbacks) | the pinned Chromium is not yet in `<cacheRoot>/ms-playwright` (first run) |
| videos recorder | `127.0.0.1:5433` (Postgres), `127.0.0.1:<free port>` (the app it starts) | each render |
| `psql` cleanup | `127.0.0.1:5433` | after a render |
| assistant pack, guide assemble/build, voice probe | none | n/a |

`network: 'none'` with the offline env was rejected: on a cold cache it fails a step that passes today (AC7), and the
videos step needs loopback to a host Postgres.

### 4.5 Step changes

- **guide** (`release-docs-prep-guide.ts`): no code change. It already uses `ctx.exec` with `cwd: wt`.
- **assistant-pack** (`release-docs-prep-assistant-pack.ts`): no command change. Rewrite the header comment: the
  generator runs through `ctx.exec` inside the runner sandbox (worktree writable, credentials and runner data hidden),
  not as the runner user.
- **videos** (`release-docs-prep-videos.ts`):
  - Delete `run()` and the `node:child_process` import. Add `const ran = async (ctx, cmd, args, o) => { const r = await
    ctx.exec(cmd, args, o); return { code: r.exitCode, out: \`${r.stdout}\n${r.stderr}${r.timedOut ? \`\n(timed out
    after ${Math.round(o.timeoutMs/60_000)} min)\` : ''}\` }; }`. stdout and stderr are no longer interleaved, so only
    the order of lines in a failure tail can differ.
  - `probe(ctx)`: `ctx.exec('node', ['--input-type=module', '-e', script], { cwd: wt, timeoutMs: 60_000, env:
    {...} })`. The `AOM_PREP_VIDEO_PROBE` test override stays first.
  - `render`: the build list becomes `pnpm install --frozen-lockfile --prefer-offline`, `pnpm build`, and **new**
    `pnpm --filter @aom/e2e exec playwright install chromium`, the last only when `rec.build` (a browser for the
    recorder in the sandbox's browser cache).
  - `stageRoot = join(ctx.outDir, 'stage')` instead of `tmpdir()`. The recorder gets `AOM_VIDEO_SLUG`, `AOM_VIDEO_OUT`,
    `AOM_VIDEO_PORT`, `AOM_VIDEO_DB` and `AOM_VIDEO_DIR_BASE` through `opts.env`, not `{...process.env}`.
  - psql cleanup through `ctx.exec('psql', [url, '-c', \`DROP DATABASE IF EXISTS ${db}\`], …)`, still best effort.
  - Under test, `AOM_PREP_VIDEO_CMD` is also run through `ctx.exec`.
- **changelog, help**: no change (no processes).

### 4.6 Runner wiring (`apps/runner/src/runner.ts:2597-2613`)

```ts
private readonly docsPrepLauncher = new ServiceLauncher();
…
? await runReleaseDocsPrep({
    …,
    execFor: sandboxedDocsPrepExec({
      runnerRoot: this.paths.root,
      realHome: homedir(),
      cacheRoot: sharedCacheRoot(this.paths),
      launcher: this.docsPrepLauncher,
      toolchains: () => this.toolchains.resolve(),
      log: this.log,
    }),
  })
```

Remove the inline `this.exec.run` closure. `this.exec` stays for its other users.

### 4.7 Guard against bypass (AC3)

Add `test/release-docs-prep-sealed.test.ts`. It reads every `apps/runner/src/git/release-docs-prep*.ts` except
`release-docs-prep-exec.ts` and fails if any file imports `node:child_process`/`child_process`/`execa`/`../toolchain/exec`
or mentions `process.execPath`, `spawn(`, `execFile(` or `fork(`. The in-process `git()` helper from `./git.ts` stays
allowed (runner plumbing). It also asserts that `DOCS_PREP_STEP_HANDLERS` keys equal the handler files it scanned
(`changelog, guide, help, assistant-pack, videos`), so a new step lands under the guard.

## 5. Files to change

| File | Change |
|---|---|
| `apps/runner/src/runs/sandbox.ts` | `extraMasked`, `dieWithParent` (optional), export `gitDirOf` |
| `apps/runner/src/runs/manager.ts` | import `gitDirOf` from `sandbox.ts` (pure move, no behaviour change) |
| `apps/runner/src/git/release-docs-prep-steps.ts` | `DocsPrepExec.opts.env`, `DocsPrepExecScope`, `DocsPrepExecFactory`, `DocsPrepSandboxError` |
| `apps/runner/src/git/release-docs-prep-exec.ts` | **new**: `sandboxedDocsPrepExec`, `docsPrepSandboxSpec`, `docsPrepEnv`, `machineDataDir`, default spawner |
| `apps/runner/src/git/release-docs-prep.ts` | `execFor` replaces `exec`; `runSpec` builds the scope and maps `DocsPrepSandboxError` to a failed outcome |
| `apps/runner/src/git/release-docs-prep-videos.ts` | all spawns through `ctx.exec`; staging under `outDir`; Playwright install in the build list |
| `apps/runner/src/git/release-docs-prep-assistant-pack.ts` | header comment only |
| `apps/runner/src/runner.ts` | production `execFor` wiring |
| `docs/RUNNER.md` (release prep / sandbox section, if present) | one paragraph: prep commands run in the sandbox, fail when bwrap is missing, the browser and corepack caches live in `<data dir>/cache` |
| tests | see section 7 |

Estimated diff: ~150 lines new module, ~80 lines in steps/framework/runner/sandbox, ~300 lines tests. It touches a
security boundary in several modules, so it is recorded as large.

## 6. Risks

- **Non-Linux runners** (macOS, Windows): guide PDF rebuilds, the assistant pack and the videos step now **fail** with
  the sandbox message, where they used to run. The card's constraint asks for exactly this ("or that the step fails
  there"). The changelog and help steps are unaffected.
- **Runners with `sandbox: off` / `allowUnsandboxed`**: the docs-prep steps that run commands now fail there unless
  bubblewrap works. This is intended (AC6).
- **First run on a runner**: one-off downloads of pnpm (corepack), any missing store packages and Chromium (~150 MB) into
  `<data dir>/cache`. The first guide/videos run is slower; later runs reuse the caches.
- **Video voice**: depends on the `AOM_VIDEO_HOME` pass-through and its read-write bind. If a workstation installed the
  voice somewhere else through an env var not on the list, the preflight fails with "voice unavailable" (a clear, safe
  failure). Integration test 5 covers the default layout.
- **The real home stays readable** (except the masked credential folders), as for run steps. The card lists the
  credential files and runner data, and both are hidden. Hiding the whole home would break toolchains under
  `~/.nvm`/`~/.dotnet`.
- **Sibling pairings**: hidden for docs-prep by `extraMasked`. Run steps still see them (pre-existing, out of scope, a
  backlog suggestion was filed).
- **Bind of `outDir` under `/tmp`**: bwrap creates the mount point inside the private `/tmp` (runTmp). This works
  because the source is resolved on the host, and it leaves an empty directory in runTmp, which is removed after the
  call.

## 7. Tests

Unit (vitest, `apps/runner/test`):

1. `release-docs-prep-exec.test.ts` (new), with a fake spawner and a fake launcher:
   - the guide `apply` and assistant-pack commands go through a single `bwrap` spawn each. `args` end with
     `-- corepack pnpm …` / `-- node …/build-guide.mjs`. They contain `--bind <worktree> <worktree>` and `--bind
     <outDir> <outDir>`, `--die-with-parent` and a tmpfs over `machineDataDir` and the runner root. They do not contain
     `--unshare-net` or `usersecrets` (AC1, AC2, AC3).
   - env: no `AOM_*` (except the videos pass-throughs for `step: 'videos'`), no `*TOKEN*`/`SSH_AUTH_SOCK`/`DBUS_*`;
     `HOME=/tmp/home`, `PLAYWRIGHT_BROWSERS_PATH` and `COREPACK_HOME` under `cacheRoot`, and PATH starts with the
     toolchain dirs (AC4).
   - the launcher says unavailable, or the platform is `darwin`: `exec` rejects with `DocsPrepSandboxError` naming the
     step and the reason, and **the spawner is never called** (AC6).
   - spawn result `exitCode 1`, `stderr 'bwrap: Can't mkdir …'`: rejects with `DocsPrepSandboxError` (AC6).
   - a cwd outside the worktree/outDir: rejects, no spawn.
   - `machineDataDir('/h/.aom-runner/pairings/x') === '/h/.aom-runner'`; `machineDataDir('/h/.aom-runner') === '/h/.aom-runner'`.
2. `release-docs-prep.test.ts`: `runReleaseDocsPrep` with an `execFor` whose exec throws `DocsPrepSandboxError`.
   The guide `apply` and assistant-pack steps report `state: 'failed'` with that message, nothing is committed on the work
   ref, and the worktree is cleaned up (AC6, AC7). Also assert that `execFor` receives `{step, phase, worktree, outDir}`
   with the integration worktree.
3. `release-docs-prep-sealed.test.ts` (new): the source guard of 4.7 (AC3).
4. `runs-p2.test.ts`: `bwrapArgs` with `extraMasked` puts those masks first and skips missing paths; `dieWithParent`
   adds `--die-with-parent`; without the new fields the args equal the current output (regression for run steps,
   services, checks, AC8).
5. Existing suites stay green after the mechanical `exec` → `execFor` change: `release-docs-prep{,-guide,-guide-meta,
   -changelog,-help,-assistant-pack,-videos}.test.ts`. The videos test passes a test-only pass-through `execFor` that
   spawns plainly, so the `AOM_PREP_VIDEO_CMD` fake still runs (AC7).
6. Optional real-bwrap test (`release-docs-prep-sandbox-real.test.ts`, skipped unless `bwrap` works, following
   `scan-sandbox-real.test.ts`). Under a temporary fake home and runner root, run the real `sandboxedDocsPrepExec` with
   `sh -c 'cat $FAKEHOME/.ssh/id; cat $FAKEHOME/.npmrc; cat $ROOT/secrets/k; ls $MACHINE/pairings/other; echo ok >
   $WT/out.txt'`. Each read fails (No such file / Permission denied), the write lands in the worktree (AC4, AC5). Never
   point it at the real home.

Integration (Linux runner with bubblewrap; testers or DevOps, as in the card's test plan 5-8): a full prep run with
guide and assistant pack enabled, with output compared byte for byte against an unsandboxed baseline of the same commit
(the PDF with the same `--date`/`--edition`). Check that `ps --forest` (or the new info log line) shows `bwrap` as the
command's parent. Probe step. RunManager step and service and shift prepare/submit regression.

## 8. Acceptance criteria mapping

| AC | Design |
|---|---|
| Guide build runs inside bwrap | guide `ctx.exec` → `sandboxedDocsPrepExec` → `sandboxCommand` (4.2, 4.6); test 1 |
| Assistant-pack build inside the same sandbox | same seam, same profile (4.5); test 1; comment updated |
| Every docs-prep command sandboxed by default, no direct spawns | `execFor` is the only door; videos migrated (4.5); source guard (4.7); tests 1, 3 |
| Secrets/keys/config and credential files unreadable | `maskedPaths` (runner root, `HOME_SECRETS`) + `extraMasked` machine data dir + scrubbed env (4.2, 4.3); tests 1, 6, integration probe |
| Worktree and output read-write; same files and content | binds for worktree + outDir; same commands, same caches by pinned version; fonts bundled (2.4); tests 5, 6, integration 5 |
| Sandbox cannot start → step fails naming step and error, never unsandboxed | `DocsPrepSandboxError` before spawn and on a `bwrap:` setup error; config mode ignored; `runSpec` maps it to `failed` (4.1, 4.2); tests 1, 2 |
| Step outcomes unchanged; existing tests pass | handlers and `keepWork` untouched; only the `execFor` rename in tests; `timedOut` now real (noted) (4.2 step 8); test 5 |
| Git plumbing unchanged | `git()` calls, worktree, lock, commit and push untouched; `sandbox.ts` additive only (4.3); test 4 |

## 9. Follow-up (outside this card)

- Run steps/services/checks mask only their own pairing root, so sibling pairings stay readable to sandboxed run steps.
  A backlog suggestion was filed to add the same `extraMasked` machine-data-dir mask there.
