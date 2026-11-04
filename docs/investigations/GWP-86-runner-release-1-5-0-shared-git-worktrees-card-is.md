# GWP-86: the card's own `.git/worktrees/<card>` is read-only inside the shift sandbox

Target branch: release/1.5.0. Area: `apps/runner` (Claude Code shift settings).

## 1. Question

In GWP-79's shift (an architect, commit-capable) `git add` failed with
`.git/worktrees/GWP-79/index.lock: Read-only file system`. Why is the card's own linked-worktree git dir not writable,
and how do we make it writable for commit-capable roles without opening hooks, config or other cards' worktree dirs?

## 2. Findings

### 2.1 Reproduced in this design shift

This shift is an architect shift (commit-capable: `edit` limited to docs, `mayCommit`) on GWP-86, worktree
`.../worktrees/GWP-25035684/GWP-86`, git dir `/data/src/personal/GuildwiseHQ/.git/worktrees/GWP-86`. Read-only checks
inside the shell sandbox:

```
$ test -w /data/src/personal/GuildwiseHQ/.git/worktrees/GWP-86   -> not writable (EROFS)
$ test -w /data/src/personal/GuildwiseHQ/.git                    -> not writable
$ test -w <worktree>/docs                                        -> writable
```

`/proc/self/mountinfo`, in mount order (only the relevant lines):

```
149: /data/src/personal/GuildwiseHQ/.git   rw     <- sandbox.filesystem.allowWrite (ctx.gitDirs)
174: /data/src/personal/GuildwiseHQ        rw     <- permissions.additionalDirectories / --add-dir (readDirs)
185: /data/src/personal/GuildwiseHQ        ro     <- sandbox.filesystem.denyWrite (readDirs)
```

Mount 185 is a recursive read-only bind of the clone's root, taken from the host tree. The host tree does not have the
rw bind of mount 149, so it covers that bind. Everything below `/data/src/personal/GuildwiseHQ`, including `.git` and
`.git/worktrees/GWP-86`, is read-only for the shell. (`findmnt -T` still prints the hidden rw mount because it matches
targets by prefix. `access(W_OK)` shows the real state.)

### 2.2 Root cause

Two things together cause it:

1. **The card's own main clone is passed to the shift as a read-only folder.** The architect role has
   `readOrgRepos`, so `resolveOrgFolderRepos()` (`apps/runner/src/read-repos.ts`) opens every git repository under the
   organization source folder (`/data/src/personal`). That includes `/data/src/personal/GuildwiseHQ`, the clone whose
   `.git` holds this card's worktree admin dir. The server filters the card's own repository out of the reference
   repositories, but only by `repoId` (`shiftReadRepos`, `apps/server/src/runner-gateway/brief.ts:825`). The runner-side
   org-folder scan (`orgfolder:<key>` ids) has no such filter. A reference repository with a different `repoId` but the
   same remote resolves to the same clone too. GWP-79 (architect Katherine) was the same case. The shift instructions
   list the clone under "Folders you can read", and the read-only folder list of this shift does as well.
2. **Claude Code's sandbox mounts every `denyWrite` path after every `allowWrite` path, in list order, with no sorting
   by depth.** `sandboxBlock()` (`apps/runner/src/adapters/claude-policy.ts:339-359`) puts `ctx.gitDirs` (the whole
   common `.git`) in `allowWrite` and every `readDirs` entry in `denyWrite`. When a read-only folder is an ancestor of a
   writable path, the read-only bind wins. The `Edit(<dir>/**)` deny rules for read-only folders (`readOnlyDenies`) are
   another source of `denyWrite`, because Claude Code turns Edit rules into sandbox write rules. They must be handled
   the same way.

The other suspects named in the brief are **not** the cause:

| Suspect | Verdict |
| --- | --- |
| `protectedGitPaths(cwd)` (git/harden.ts) | Denies only `<wt>/.git`, `admin/{commondir,gitdir,config,config.worktree,hooks}`. These are deeper than the admin dir, so they do not cover `index`, `index.lock`, `HEAD`, `logs`, `ORIG_HEAD` or `MERGE_*`. Fine. |
| `<gitDir>/hooks`, `<gitDir>/config` denies | Siblings of `worktrees/`, not ancestors. Fine. |
| `worktreeLocked` (read-only roles) | Adds only `ctx.cwd` to `denyWrite`, and only for roles with no `edit` and no `mayCommit`. Not the architect or builder. |
| Claude Code's protected dotfile mounts / `sandbox-placeholders.ts` | They affect `<worktree>/.gitconfig` etc. inside a read-only cwd (the GWP-63 finalize `bwrap: Can't create file .gitconfig` error), not the admin dir. |
| Codex (`codexFilesystem`) | Per-path access, most specific wins: clone `read`, admin/objects/refs/logs `write`. Not affected. |
| Harness box (`harness-sandbox.ts`) | Sorts mounts parents first (`mounts.sort` by length), so the clone's ro bind is under the admin rw bind. Not affected. |
| `runs/sandbox.ts` / `runs/manager.ts gitDirOf` | Service sandbox for test environments, not the agent shell. Not affected. |

So only the Claude Code adapter is affected, and only when a read-only folder contains the shift's git dir or its
working folder. That explains why builders commit normally: they get no org-folder repos, and the server drops their
own repository from the reference list by id.

### 2.3 A second gap found while reading (AC 2)

`allowWrite` holds the whole common `.git`, and so does `permissions.additionalDirectories` (`buildShiftSettings`,
line 688), which Claude Code also makes writable. When nothing covers it, every **other** card's
`.git/worktrees/<other>` admin dir is writable from the shift: its `index`, `HEAD`, `logs`, and `commondir`/`gitdir`
pointers (those of other worktrees are not in `protectedGitPaths(cwd)`). In GWP-79 and this shift this was hidden only by
the shadowing bug. Once that is fixed it would be a new write ability for architects. AC 2 asks for these dirs to stay
non-writable, so the fix must deny them explicitly.

Narrowing `allowWrite` to `admin + objects + refs + logs` (as Codex and the harness do) is **not** safe for Claude
Code. Clones normally live under the user's home (`/home/me/toy/.git` in the test fixtures). The Claude sandbox hides
`/home` and re-opens only what is allowed, so the common dir's `HEAD`, `config`, `packed-refs` and `info/` would become
unreadable and git would stop working. Adding the common dir to `allowRead` instead risks the same shadowing (see the
comment above `allowRead` in `sandboxBlock`). So the whole common dir stays writable, and the parts that must stay
protected are carved out with `denyWrite` entries that are **deeper** than the allow. Those win, which is what we want.

## 3. Options

| | Option | For | Against |
| --- | --- | --- | --- |
| A | Server/supervisor drops the own clone from the read folders for every adapter | One place; the instructions become honest | The Claude shell can read anything not under a denied region. Today the own clone's `.env`/keys are masked by the read-only-folder secret rules; dropping the folder drops the masks and exposes them. The org-folder scan is runner-side, so the server cannot fix it alone. |
| B | Carve the clone up in `denyWrite` (`denyAround(clone, .git)`) and keep it in `additionalDirectories` | Keeps Read-tool access to the clone | The clone root stays writable through `--add-dir`. Any file or folder the owner creates in the clone during the shift becomes writable for the agent. A real security regression. |
| C | **Claude adapter splits the own repository off the read folders**: not `--add-dir`, not `additionalDirectories`, not `allowRead`, not `denyWrite`, no `Edit` deny, but its secret-file `Read` denies stay | Nothing in the clone becomes writable (write is allow-only; the clone is no longer in any allow list). The `.git` rw bind is no longer covered. Secret masks stay. Codex/harness untouched. | The built-in Read tool no longer sees the clone's working tree (the agent reads the same repository through its worktree). The shell can still read it where it is not under a hidden region. |
| D | Sort Claude's write rules ourselves | | We do not control the runtime's mount order, and the order is not documented. |

## 4. Recommendation

**Option C**, plus an explicit deny of other cards' admin dirs (2.3), a shadowing diagnostic, and a note for read-only
roles. No new config keys.

## 5. Design

### 5.1 `apps/runner/src/adapters/claude-policy.ts`

1. New pure helper (exported, unit-testable):

   ```ts
   /**
    * Read-only folders that hold the shift's working folder or one of its git dirs (the card's own main clone, opened
    * through the organization folder or a reference repository). Claude Code binds every denyWrite after every
    * allowWrite, so such a folder in denyWrite would cover the writable git dir beneath it (GWP-86). It is split off:
    * no --add-dir, no additionalDirectories, no allowRead, no denyWrite, no Edit deny; only its secret-file Read denies stay.
    */
   export function splitOwnRepository(
     readDirs: string[], cwd: string, gitDirs: string[],
   ): { readDirs: string[]; ownRepoDirs: string[] } {
     const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
     const targets = [cwd, ...gitDirs].map(real);
     const own = (d: string) => targets.some((t) => inside(real(d), t));
     return { readDirs: readDirs.filter((d) => !own(d)), ownRepoDirs: readDirs.filter(own) };
   }
   ```

   (`inside(parent, child)` is the existing helper in this file. Compare real paths: `gitDirsOf` resolves the `.git`
   file text, read folders are real paths.)

2. `ClaudePolicyContext` gets `ownRepoDirs?: string[]`. It is used **only** in `commonDenies` / `readOnlyDenies` for
   `secretReadDenies(ownRepoDirs)`, so the clone's `.env`, keys etc. stay masked for both the tools and the shell. No
   `Edit(...)` deny for it. It is not writable anyway: it is not in any allow list, and `dontAsk` refuses an Edit outside
   the `Edit(<cwd>/...)` allows.

3. In `sandboxBlock`, add to `denyWrite`, for each git dir `g` with an admin dir `admin = gitAdminDirOf(cwd)` under
   `g/worktrees/`:

   ```ts
   ...(admin && inside(join(g, 'worktrees'), admin) ? denyAround(join(g, 'worktrees'), admin) : []),
   ```

   `denyAround(root, keep)` (already in this file) lists every sibling of the card's own admin dir: the other cards'
   `.git/worktrees/<other>`. Those entries are deeper than the `allowWrite` of `g`, so they win. A worktree added after
   the shift started is not covered. This is the same limit `denyAround` already documents, and it is acceptable. Apply
   this to every role that has `gitDirs`; it only takes write access away.
   Reuse `gitAdminDirOf` from `codex.ts` (move it next to `gitDirsOf` or export it) rather than parsing `.git` a third
   time.

4. A diagnostic, exported: `shadowedWrites(fs: { allowWrite: string[]; denyWrite: string[] }, cwd: string): string[]`.
   It returns every `denyWrite` entry that is a **strict ancestor** of an `allowWrite` entry or of `cwd`. It is only for
   logging and tests. It must never be used to drop denies silently, because that would widen access.

### 5.2 `apps/runner/src/adapters/claude-code.ts`

In the shift path (the `args` builder around line 209 and `policy()` around line 520), compute once:

```ts
const writer = !isReadOnlyWorktreeRole(input.agent.permissions); // edit tool or mayCommit
const { readDirs, ownRepoDirs } = writer
  ? splitOwnRepository(input.readDirs ?? [], cwd, gitDirsOf(cwd))
  : { readDirs: input.readDirs ?? [], ownRepoDirs: [] };
```

Use `readDirs` for `--add-dir` **and** `ctx.readDirs`, and pass `ctx.ownRepoDirs = ownRepoDirs`.
`isReadOnlyWorktreeRole(p)` is the existing predicate in `buildShiftSettings`
(`!p.allowedTools.includes('edit') && !p.mayCommit`, line 701), moved into an exported function so both places use the
same rule. Read-only roles keep their input unchanged (AC 3). Chats (`chat = true`, `gitDirs: []`), the DevOps
engineer, the CEO and scan sessions are not touched. After the settings are built, log a `warn` for each entry from
`shadowedWrites(...)` (`sandbox: <deny> hides writable <allow>`), so the next case of this class shows in the runner log
instead of as a raw EROFS in an agent shell.

Delegated children (`aom delegate`) and native subagents start through the same adapter or settings, so they inherit
this.

### 5.3 Message for read-only roles (requirement 3)

`apps/runner/src/shifts/supervisor.ts`: for a card shift whose role is a read-only worktree role
(`isReadOnlyWorktreeRole(msg.agent.permissions)`) and that has a worktree, append one line to the instructions:

> Your working folder is read-only in this role. A "Read-only file system" error from a write there (files, git add,
> git commit) is by design, not an environment fault: do not ask DevOps to fix it.

Optional, low priority: leave out of the "Folders you can read" text a folder that contains the shift's git dir, because
the built-in Read tool no longer opens it. Do not remove it from `readDirs` there, because the secret masks depend on it
(option A's problem).

### 5.4 Which paths are writable, per role (the rule, also in docs/RUNNER.md)

| Path (linked worktree of clone `R`) | Commit-capable role (`edit` or `mayCommit`: builder, architect, tester, BA ...) | Read-only role (no `edit`, no `mayCommit`: reviewer ...) | Read-only checkout (design before deps, chats) |
| --- | --- | --- | --- |
| the worktree (cwd) | writable (Edit tool limited to the role's globs) | read-only | read-only folder |
| `R/.git/worktrees/<card>`: `index`, `index.lock`, `HEAD`, `logs/`, `ORIG_HEAD`, `MERGE_*`, `AUTO_MERGE` | writable | unchanged from today (writable with the common dir; read-only where a read-only folder covers it) | not writable (cwd is the scratch dir: no gitDirs) |
| `R/.git/objects`, `refs`, `logs`, `packed-refs` | writable (unchanged) | unchanged | not writable |
| `<wt>/.git` file, `admin/{commondir,gitdir,config,config.worktree,hooks}` | read-only | read-only | read-only |
| `R/.git/hooks`, `R/.git/config` | read-only | read-only | read-only |
| `R/.git/worktrees/<other card>` | **read-only (new explicit deny)** | read-only (new explicit deny) | read-only |
| `R` working tree (the owner's clone) | not writable, not a read folder for the tools; secret files masked | read-only folder (unchanged) | read-only folder |

Refs other than the card's own stay as writable as today. The post-shift guard (`commits_on_other_branch`) watches
them, and narrowing refs is out of scope (the card asks for them to stay "as protected as today").

## 6. Acceptance criteria mapping

| AC | Design | Test |
| --- | --- | --- |
| `git add`/`git commit` succeed for a commit-capable shift; `index.lock` can be created | 5.1 (1, 2) + 5.2: the own clone is no longer in `denyWrite`/`--add-dir`, so nothing covers the `.git` rw bind | Unit (`claude-policy` settings): a real repo fixture (`git init` + `git worktree add` X and Y, as in `git-harden.test.ts`'s `fixture()`), `readDirs: [repo]`, builder and architect permissions. Expect `repo` **not** in `denyWrite`, `additionalDirectories`, `allowRead`, or as `Edit(repo/**)` in `deny`; `repo/.git` in `allowWrite`; `shadowedWrites(...)` empty; the `Read(//repo/**/.env)` deny present. Plus an invariant test over the existing role fixtures: `shadowedWrites` is empty for every built-in role. Real check: extend `claude-sandbox-real.test.ts` (skipped without `claude` + bwrap) with a commit role whose read folder is the clone, running `git add -A && git commit -m x`. |
| Other cards' `.git/worktrees/<other>`, `.git/hooks`, `.git/config` stay non-writable | 5.1 (3), plus the existing hooks/config denies | Same fixture: `denyWrite` contains `repo/.git/worktrees/Y`, `repo/.git/hooks`, `repo/.git/config`, and not `repo/.git/worktrees/X`. |
| Read-only roles and read-only checkouts keep their behaviour | 5.2: no split for read-only roles; chats/scan unchanged; a read-only checkout has a scratch cwd (no gitDirs), so nothing changes | Reviewer with `readDirs: [repo]`: `repo` still in `denyWrite` and `additionalDirectories`, cwd in `denyWrite` (worktreeLocked) as before. Snapshot-style assertion that the reviewer settings equal today's, except the new other-worktree denies. Existing `reference-repos.test.ts`, `scan-guard.test.ts` and `sandbox-placeholders` tests unchanged and green. |
| Root cause and rule documented | docs/RUNNER.md: new paragraph "Git metadata in the shift sandbox" after the Claude settings table, the `allowWrite/denyWrite` row and the "How it is enforced" bullet of the read-only-folders section (written in this design commit; the builder checks it against the code) | n/a |

## 7. Risks and traps

- **Do not narrow `allowWrite` to admin/objects/refs/logs** for Claude Code (2.3): with clones under `/home`, git
  loses the common `HEAD`/`config`/`packed-refs` and stops working.
- **Do not keep the own clone in `--add-dir`** while removing it from `denyWrite` (option B): its working tree would
  become writable.
- **Keep the secret `Read` denies for the own clone**, or its `.env`/keys become shell-readable where they are masked
  today.
- Compare real paths in `splitOwnRepository`: `/data/src/...` may be reached through a symlink.
- `denyAround` lists the worktree dirs at settings-build time. A worktree created mid-shift is not covered (documented).
- Only the Claude adapter changes. Codex (`codexFilesystem`) and the harness box already do the right thing. A cheap
  parity unit test for both with `readDirs: [repo]` (admin writable, clone read) is welcome but not required.
- Siblings GWP-83/84/85 change `guard.ts`, `autocommit.ts` and `supervisor.ts` (discard/auto-commit). This card touches
  `supervisor.ts` only for the one-line note in 5.3. Expect a trivial merge at most.

## 8. Test notes for the testers

The unit tests above run in the shift (`pnpm --filter runner test`, or vitest on `apps/runner`). The bubblewrap check
needs a workstation with `claude` and bwrap: run `claude-sandbox-real.test.ts`, or start an architect shift on a
GuildwiseHQ card (the organization folder includes the main clone). Inside it,
`test -w "$(git rev-parse --git-dir)" && git add -A && git commit -m probe --dry-run` must succeed, and
`test -w "$(git rev-parse --git-common-dir)/worktrees/<other card>"` must fail.
