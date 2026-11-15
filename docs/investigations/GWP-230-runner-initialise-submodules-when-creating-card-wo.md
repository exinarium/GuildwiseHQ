# GWP-230: initialise submodules in card worktrees (read-only superproject config)

## Question

Card worktrees are created without their submodules, so guildwise-cloud's `core/` is empty and a frozen
`pnpm install` fails with `ERR_PNPM_OUTDATED_LOCKFILE`. How should the runner fill every submodule at its pinned commit
when it creates or reopens a card worktree, without writing the superproject's git config? The fill must share the URL
and mirror logic with run worktrees and deploy checkouts, and must not weaken the runner's hardening against git
configuration that agents wrote.

## Findings

### What exists today

| Place | What it does | Config writes | Mirror | Auth |
|---|---|---|---|---|
| `delivery/submodules.ts` `fillDeploySubmodules` | per submodule: pin from `HEAD:<path>`, local clone via `findRepo`, fetches a missing pin into it, `-c submodule.<name>.url=<local>`, `submodule update --init -- <path>`, checks HEAD == pin | none on git 2.53 (the url comes from `-c`) | yes | none (the mirror fetch runs without auth). Always adds `protocol.file.allow=always`, even with no mirror |
| `runs/manager.ts` `RunManager.initSubmodules` | `submodule update --init --recursive` with `gitAuth(originUrl)` | **writes** `submodule.<name>.url/active` to the clone's shared `.git/config` (linked worktree: common config) | no | origin's credentials, not the submodule host's |
| `git/worktrees.ts` `ensureWorktree` | creates or reopens the card worktree, five success returns | n/a | n/a | n/a |
| `toolchain/prepare-worktree.ts` | runs after a fresh `worktree add`; for `.gitmodules` it only adds the step `SUBMODULES_NOT_PREPARED` (1.7.0 trust decision) | n/a | n/a | n/a |

Hardening that already exists and that this design relies on (`git/harden.ts`, `git/git.ts`):
- Every `git()` call gets `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `protocol.ext.allow=never`,
  `submodule.recurse=false` and more, plus `GIT_CONFIG_NOSYSTEM=1`. Command-line `-c` values reach child gits
  (`GIT_CONFIG_PARAMETERS` is kept by `prepare_submodule_repo_env`), so they also hold in the submodule clone and
  checkout. Verified below: a planted hook ran with plain git and did not run with `-c core.hooksPath=/dev/null`.
- `gitPointerProblem` refuses a worktree whose `.git` file points somewhere odd.
- `protectedGitPaths` makes `modules/<name>/{config,config.worktree,hooks}` read-only in the agent's sandbox, but only
  for what **exists when the sandbox is set up**. When the runner fills before the session starts, the new submodule
  repository is protected from the first agent turn.
- `guard.ts` `changedPaths` and `dirtyPaths` use `status --porcelain` with `--ignore-submodules=dirty`, so a submodule
  checked out **at its pin** is not a change.
- `shift.started.worktreePrep` already says "submodules at their pinned commits" in its schema comment
  (`packages/shared/src/protocol/runner.ts:1785`). It takes free step names, so no protocol change is needed.

### Experiments (git 2.53.0, scratch fixture: clone, linked worktree, bare origin, local mirror)

1. `git -c protocol.file.allow=always -c submodule.active=core -c submodule.core.url=<mirror> submodule update -- core`
   in a linked worktree: core is checked out at the pin, the `.git/config` sha256 is unchanged, `git status --porcelain`
   is empty, and it also works with `.git/config` set to mode 444. `submodule.<name>.active=true` works the same way.
   `submodule.active` takes **pathspecs**, not names (name == path for core). The design uses
   `submodule.<name>.active=true` so a name that differs from its path also works.
2. The submodule repository goes to the **per-worktree** gitdir: `<clone>/.git/worktrees/<wt>/modules/<name>`
   (`git rev-parse --git-path modules/<name>` from the worktree). Agents can write that folder (the sandbox allows
   their own `.git/worktrees/<wt>`), except for the paths `protectedGitPaths` binds read-only.
3. Reopen with `core/` emptied but `modules/core` still present: `submodule update` **reuses the existing repository**.
   A `hooks/post-checkout` planted there ran with plain git and did not run with `-c core.hooksPath=/dev/null`. Other
   programs in that repository's `config` (a filter driver, for example) are not covered by the hardening flags. Rule:
   **never run the update into an existing submodule repository.**
4. Unreachable URL: exit 1, and git's stderr repeats the URL **with any userinfo it has**
   (`clone of 'https://x-access-token:SECRET@...' failed`). Git removes its half-made `modules/core`, leaves an empty
   `core/`, keeps status clean and keeps the config unchanged. A later retry succeeds. So the error text must be
   redacted (userinfo removed) before it is logged or stored.
5. `--init` with the `-c` overrides wrote nothing on 2.53 either, but that depends on the git version. The design uses
   the fill-only form (no `--init`), which GWP-174 also verified.

### Timing constraint (why the fill is not inside `ensureWorktree`)

`ensureWorktree` runs before `shift.accepted`, and the server releases a shift that is not accepted within 30 s.
It also holds the clone's repo lock, which blocks every other shift of that clone. A submodule clone from the remote, or
a fetch of a missing pin into the mirror (up to 5 minutes in `fillDeploySubmodules`), can take far longer. The runner
already has a slot for this kind of work: after the accept and before the agent starts, where `prepareNewWorktree`
runs. A call after `ensureWorktree` returns also covers all five of its return paths at once (planner flag, trap 3), and
it keeps `git/completion.ts` (merge completion, which calls `ensureWorktree` in reuse mode) free of a slow fill it does
not need.

## Options

**A. Fill inside `ensureWorktreeLocked` on every return path.** This matches the card's wording. But it runs
pre-accept and under the repo lock (risks the 30 s accept and blocks other shifts), it needs five call sites, and it
slows merge completions. Rejected.

**B. A separate exported step `initWorktreeSubmodules` (in `worktrees.ts`) that the supervisor calls once after the
accept, for every card shift with a card worktree (fresh or reopened, not resumed). One shared submodule module does
the resolve and fill for card worktrees, run worktrees and deploy checkouts.** Recommended.

**C. Leave it to DevOps (status quo) or to a sandboxed in-agent step.** This doesn't meet the card. A sandboxed agent
has no credentials and cannot write the per-worktree `modules/`. Rejected.

### Trust decision (trap 4: the 1.7.0 "never fill on the host" rule)

Decision: card worktrees become an exception to the 1.7.0 rule, under these conditions. They replace the blanket ban
and are written into `prepare-worktree.ts` and docs/RUNNER.md:

1. **Only into a submodule repository the runner creates in this call.** If `modules/<name>` already exists (in any
   form) or the submodule folder holds anything (files, a `.git`, a symlink), the submodule counts as initialised or as
   agent content. It is left as it is, and no git runs inside it. That is also requirement 7 (no re-clone, only fill
   what is uninitialised). The `modules` root itself must be absent or a plain folder (lstat, not a symlink).
2. **Through `git()`** (hardening flags, pointer check, no system config), with no `--recursive` for card worktrees,
   and with `GIT_LFS_SKIP_SMUDGE=1` for card worktrees. Nothing the checked-out content holds is run: no hooks, no
   fsmonitor, no filters from a fresh repository's config, no LFS download driven by an agent's `.lfsconfig`.
3. **The URL never comes raw from `.gitmodules` for local access.** `protocol.file.allow=always` is passed only when
   the URL is a clone that `findRepo` found (a repository registered on this workstation, an absolute path). A
   `.gitmodules` URL that is a local path or `file://` with no registered mirror gets no file protocol, so git refuses
   it and the failure is reported.
4. **Credentials are those of the submodule's own host** (`auth(submoduleUrl)`): `gitAuthFor` scopes helpers and
   extraheaders per host, and ssh goes through `GIT_SSH_COMMAND`. An agent that points `.gitmodules` at another host
   gets no token sent there.
5. **It runs before the agent session starts**, so `protectedGitPaths` binds the new `modules/<name>/config` and
   `hooks` read-only for the whole session.

Why this is acceptable: the 1.7.0 concern was a *trust check* anchored on agent-writable refs and objects. Here no
trust check is needed. The pin and `.gitmodules` may be agent-committed (on a reused card branch), but a checkout only
writes files that the agent could have written into the worktree itself. With the conditions above, the runner reads
no configuration and runs no program from agent-controlled places. The objects come from the registered mirror
(content-addressed by the pinned SHA) or from the submodule's real remote. The remaining host-side git process in the
new repository is the same one deploy checkouts already run.

Known residual risk (outside this card, unchanged by it): a submodule repository that an agent creates by hand later
in a session is not covered by `protectedGitPaths` ("only what exists now"). The runner's own git never runs inside
it, which is the existing guarantee.

## Design

### New shared module `apps/runner/src/git/submodule-fill.ts`

Move the per-submodule logic of `fillDeploySubmodules` here and extend it. `readSubmodules` stays in
`submodule-pin.ts`, but it must also return the resolved raw URL:

```ts
// submodule-pin.ts: add `url` (absolute, clonable) next to `normalized`
export async function readSubmodules(worktree, originUrl): Promise<Array<{ name: string; path: string; url: string; normalized: string }>>
// relative urls: resolve against the RAW origin url, the way git does:
//   https://h/o/r(.git) + ../core.git -> https://h/o/core.git ; git@h:o/r.git + ../core.git -> git@h:o/core.git
export function resolveRelativeSubmoduleUrl(originRaw: string, rel: string): string
```

```ts
export interface SubmoduleSource {
  /** `-c` pairs for this one command: submodule.<name>.active=true, submodule.<name>.url=<url>, and
   *  protocol.file.allow=always only for a local mirror. Plus the host-scoped auth args. */
  args: string[];
  env: Record<string, string>;
  via: 'mirror' | 'remote';
}

/** The ONE place a submodule url is chosen: the registered local clone (fetching a missing pin into it under that
 *  clone's repo lock, with its origin's auth), else the submodule's own url with the auth of ITS host. */
export async function resolveSubmoduleSource(
  sub: { name: string; url: string; normalized: string },
  pinned: string,
  deps: { findRepo: FindRepo; auth?: GitAuth },
): Promise<SubmoduleSource>

export interface SubmoduleFill {
  path: string;
  name: string;
  status: 'filled' | 'present' | 'failed' | 'skipped';
  /** Redacted (no userinfo, `redactSecrets`), <= 300 chars. */
  detail?: string;
}

/** Fills each submodule of `.gitmodules` at its pin. Never throws. No-op (one existsSync) without .gitmodules. */
export async function fillSubmodules(
  worktree: string,
  deps: { findRepo: FindRepo; auth?: GitAuth },
  opts: { onlyUninitialised?: boolean; stopOnFirstError?: boolean; skipLfsSmudge?: boolean; timeoutMs?: number },
): Promise<SubmoduleFill[]>

export const redactGitError = (s: string) =>
  redactSecrets(s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')).trim().slice(0, 300);
```

The per-submodule algorithm:
1. Run `git ls-files -s -z` once and keep the gitlinks (mode 160000, stage 0, as `submodule-drift.ts` `gitlinks` does).
   Take the pin from that, not from `rev-parse HEAD:<path>`, so a pin staged but not committed is honoured the same way
   `git status` sees it. A `.gitmodules` entry with no gitlink becomes `skipped`, with detail "no pinned commit".
2. Validate the name and path: the name must match `^[A-Za-z0-9._/-]+$` and must not contain `..` (it goes into a `-c`
   key: no `=`, no newline). The path must be relative, with no `..` segment and no leading `-`. Otherwise `skipped`.
3. `onlyUninitialised` (card worktrees): get `modules/<name>` with `git rev-parse --path-format=absolute --git-path
   modules/<name>`. If it exists (lstat, any type), or `<wt>/<path>` exists and is not an empty plain folder, mark it
   `present` and run no git there. If the `modules` root is a symlink, mark it `skipped`.
4. `resolveSubmoduleSource`, then
   `git(worktree, [...src.args, 'submodule', 'update', '--', path], { env: {...src.env, ...(skipLfs ? {GIT_LFS_SKIP_SMUDGE:'1'} : {})}, timeoutMs })`.
   Don't pass `--init` or `--recursive`.
5. Check `git rev-parse HEAD` in the submodule against the pin: the existing `fillDeploySubmodules` check, run only
   right after the runner created that repository. A mismatch is `failed`.
6. On a non-zero exit, `failed` with `redactGitError(stderr || stdout)`.

### Callers

- **`delivery/submodules.ts` `fillDeploySubmodules`**: becomes a wrapper,
  `fillSubmodules(checkout, {findRepo, auth}, { stopOnFirstError: true })`. It maps the first failure to the existing
  string messages (keep the wording the deploy tests assert: "has no pinned commit", "could not be checked out", "is at
  X, not the pinned Y"). It passes no `auth`: `delivery/exec.ts` has no git auth dependency, so deploy keeps using the
  user's own git credentials as today. Change: `protocol.file.allow` is only passed for a mirror (a deploy with a
  `file://` submodule URL and no registered clone now fails). The constraint asks for this; mention it in the changelog.
- **`runs/manager.ts` `RunManager.initSubmodules`**: same trigger, same 15-minute timeout, same non-fatal
  `submoduleWarning` and `log.warn` text. Its body becomes:
  1. `fillSubmodules(worktree, { findRepo: this.deps.findRepo, auth: this.deps.gitAuth }, { timeoutMs: 15*60_000 })`
     (top level, via the shared resolver: mirror first, no write to the clone's config any more).
  2. For each `filled` submodule that has its own `.gitmodules`, run the old
     `git(<worktree>/<path>, [...auth(subUrl).args, 'submodule', 'update', '--init', '--recursive'])`. This keeps the
     nested behaviour of today's `--recursive` (it writes only the run-owned `modules/<name>/config`).
  3. The warning is the failures joined with `; `, then `redactGitError`.

  The observable run behaviour stays the same (filled at the pin, warning shown by `aom run info`). What changes: the
  mirror is preferred, credentials match the submodule's host, and the shared `.git/config` is no longer written.
- **`git/worktrees.ts`**: add a thin exported wrapper, so the card-worktree behaviour is tested in `worktrees.test.ts`:
  ```ts
  export async function initWorktreeSubmodules(path: string, deps: { findRepo: FindRepo; auth?: GitAuth }): Promise<SubmoduleFill[]> {
    if (!existsSync(join(path, '.gitmodules'))) return [];          // requirement 4: no git call at all
    return fillSubmodules(path, deps, { onlyUninitialised: true, skipLfsSmudge: true, timeoutMs: 10 * 60_000 });
  }
  ```
  Don't change `ensureWorktree`, `ensureWorktreeLocked` or `completion.ts`.
- **`shifts/supervisor.ts`**: right after `shift.accepted` and `persist(s)`, before the "prepare new worktree" block:
  ```ts
  if (msg.kind === 'card' && s.worktree && msg.worktree && !s.resumed) await this.fillWorktreeSubmodules(s);
  ```
  `fillWorktreeSubmodules`:
  1. Add the progress line "filling the submodules", but only when `.gitmodules` exists.
  2. Call `initWorktreeSubmodules(s.worktree.path, { findRepo: this.deps.findRepo, auth: this.deps.gitAuth })` inside
     try/catch, so it never fails the shift.
  3. Turn the result into one `PrepStep` named `submodules`. `done` when all are `filled` or `present`. `failed` with
     detail `core: <redacted error>; ...` when any failed. `skipped` when only skipped ones are left.
  4. Keep it on `s.submodulesStep`, persisted with the shift.
  5. For each failure, call `log.warn` with the submodule name and the redacted error (requirement 5: the RunManager
     way, warning kept and shown) and `addProgress(s, 'status', 'the submodule <path> could not be filled: <redacted>')`.

  If `prepareNewWorktree` runs afterwards, it passes the step to `prepareWorktree` (new optional input
  `submodules?: PrepStep`). If it doesn't run (a reopened worktree, `prepareWorktrees=false`, DevOps), set
  `s.worktreePrep = { ok: step.status !== 'failed', steps: [step] }`. That way `shift.started.worktreePrep` and
  `prepNote` (the agent's instructions) carry it too. Run the fill for DevOps card shifts as well: it is harmless, and
  a conflict attempt then sees a complete tree.
- **`toolchain/prepare-worktree.ts`**: step 1 becomes "use `i.submodules` if given, otherwise (no fill ran) the fixed
  `SUBMODULES_NOT_PREPARED` line". Rewrite the header comment and the `SUBMODULES_NOT_PREPARED` comment to point at
  the conditions in "Trust decision" (the fill itself lives in `git/submodule-fill.ts`; prepare still runs no
  `git submodule`). Keep `SUBMODULES_NOT_PREPARED` exported: the tests and the fallback use it.
  `changedPaths` there already uses `--ignore-submodules=dirty`, so a filled submodule does not count as "changed by
  the preparation".

### Data model and API

- `ActiveShift.submodulesStep?: PrepStep` (persisted). There is no new protocol field: it goes out through the existing
  `worktreePrep`.
- `readSubmodules` returns `url` as well. Its existing caller `attemptBump` ignores the new field.
- `PrepareWorktreeInput.submodules?: PrepStep`.

### Docs

Rewrite the docs/RUNNER.md section "A new card worktree is prepared (1.7.0)": replace the paragraph "Submodules are
not filled" with the new behaviour.
- When the fill runs: after the accept, fresh or reopened worktree, never for a resumed shift.
- Where the URL comes from: the mirror, else the submodule's own URL with that host's credentials.
- That no config is written (one-shot `-c`), and what happens when it fails (the shift continues, the step is listed
  as not prepared).
- The trust conditions 1 to 5.
- The run worktree change: shared resolver, no `.git/config` write, nested submodules as before.

Also add a CHANGELOG line if the repository keeps one for the runner.

## Acceptance criteria mapping

| AC | Covered by | Test |
|---|---|---|
| New card worktree (guildwise-cloud) has `core/` at the pin | supervisor `fillWorktreeSubmodules` → `initWorktreeSubmodules` → `fillSubmodules` | worktrees.test.ts: fixture superproject (`makeRepo` ×2 as in deploy-submodules.test.ts), `ensureWorktree` then `initWorktreeSubmodules` with `findRepo` → mirror; `git -C wt/core rev-parse HEAD` == `ls-tree HEAD core` sha |
| Config byte-for-byte unchanged, guard quiet | `-c` only, no `--init`, nothing written in the common dir | sha256 of `<clone>/.git/config` and of `<clone>/.git/worktrees/<wt>/config.worktree` (if present) before and after. Run with `.git/config` at mode 0444 too. `runGuard` with a read-only role's permissions (`mayCommit:false`, startSha = HEAD) returns no `readonly_role_modified_code` (add this case to guard.test.ts or worktrees.test.ts) |
| `git status --porcelain` empty | fill at the pin, guard-style status | the same test, both raw `git status --porcelain` and `dirtyPaths` |
| Frozen pnpm install no longer fails | `core/` populated before `prepareNewWorktree` runs the installs | manual/tester: builder shift on a guildwise-cloud card, then `pnpm install --frozen-lockfile` (parts 1 and 2 on pnpm 12) |
| No `.gitmodules`: unchanged | `existsSync` short-circuit, no git call | test: spy on or count calls (inject a `findRepo` that throws, and check that `modules/` was not created); `ensureWorktree` tests unchanged and passing |
| Unreachable URL: worktree kept, name and redacted error logged, no crash | `failed` entry, `redactGitError`, supervisor try/catch | test: `.gitmodules` URL `https://user:SECRET@127.0.0.1:9/x.git`, no mirror → result `failed`, detail names `core`, contains no `SECRET`, no throw, worktree still on its branch, status clean. Supervisor test (test hook or fake): the shift still starts, the progress line is there, `worktreePrep.steps` has `submodules: failed` |
| URL resolution shared with runs | `resolveSubmoduleSource` used by card, run and deploy | test that `RunManager.initSubmodules` fills from a mirror (runs test with a fixture) and leaves `.git/config` unchanged; deploy-submodules.test.ts stays green; grep check in review: there is no other `submodule.*.url=` construction |
| Reopen does not re-clone | `onlyUninitialised` checks `modules/<name>` and the folder | test: fill, write a marker into `<clone>/.git/worktrees/<wt>/modules/core/marker`, call again → `present`, marker kept, no "Cloning" (pass a `findRepo` spy that must not be called). Also: emptied `core/` with `modules/core` present plus a planted hook → `present`, hook marker absent |
| Full runner suite passes | | `pnpm --filter runner test` (unit only). worktrees, prepare-worktree, deploy-submodules, submodule-pin, guard, architect-guard, tester-guard, git-submodule-exec |

Extra tests worth having: `resolveRelativeSubmoduleUrl` (https, scp-like ssh, `.git` suffix). Invalid names and paths
are skipped. `protocol.file.allow` is absent when there is no mirror (a `file://` URL fails). `prepareWorktree` with a
given `submodules` step uses it and does not add `SUBMODULES_NOT_PREPARED`.

## Risks

- **Run behaviour drift.** The run worktree now uses the mirror and per-host auth. The nested recursion is kept by the
  second step. The risk is low, but say it in the PR.
- **Deploy `file://` submodules without a registered clone now fail.** That is intended by the constraint. None is
  known in use (guildwise-cloud uses an ssh URL and the GuildwiseHQ clone is registered).
- **Mirror fetch writes the mirror's refs.** Do it under `withRepoLock(mirror)` so it doesn't collide with that clone's
  shifts. The lock is in-process and re-entrant, and no lock is held on the superproject at that point, so there is no
  deadlock.
- **Time.** A remote clone of a large submodule can take minutes before the agent starts. The progress line tells the
  owner, and the 10-minute timeout caps it. With the registered mirror (the normal case) the clone is local and uses
  hardlinks.
- **Older git.** The fill-only form needs no `--init` behaviour. The config-hash test catches a regression on the CI
  git.
- **Residual:** a submodule repository an agent creates later in the session is not sandbox-protected. This is
  pre-existing, and the runner never runs git inside it.

## Recommendation

Build option B: one shared `git/submodule-fill.ts` (resolve and fill), used by deploy, runs and card worktrees. Call
`initWorktreeSubmodules` from the supervisor after the accept, for fresh and reopened card worktrees. Fill only into
repositories the runner creates in that call, through the hardened `git()`, with one-shot `-c` options. Surface the
result as the `submodules` prep step. Update `prepare-worktree.ts` comments and docs/RUNNER.md to the new trust
conditions.
