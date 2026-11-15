# GWP-229: Runner sandbox: allow pnpm 12's fixed /tmp lock folders

## Question

pnpm 12's native binary takes its locks in three fixed folders under `/tmp` and ignores `TMPDIR`:

- `/tmp/pnpm-store-operation-locks-<uid>`
- `/tmp/pnpm-dir-locks-<uid>`
- `/tmp/pnpm-verify-deps-install-locks-<uid>`

The agent sandbox keeps `/tmp` read-only, so `pnpm install` (and any `pnpm run` / `pnpm exec` that installs first) fails.
How do we make these three folders, and only these, writable for sandboxed shifts? The fix should follow the existing
`/tmp/.dotnet` (`DOTNET_SHM_DIR`) pattern without widening `/tmp` itself.

## Findings

### 1. The failure reproduces in a real shift sandbox

This was checked inside a Claude Code shift sandbox on this workstation (pnpm 12.8.1, uid 1000). All three folders
already exist on the host, created by the owner's own pnpm runs outside the sandbox. Each is `drwx------`, owned by
the user:

```
drwx------ exinarium /tmp/pnpm-dir-locks-1000
drwx------ exinarium /tmp/pnpm-store-operation-locks-1000
drwx------ exinarium /tmp/pnpm-verify-deps-install-locks-1000
```

In a scratch workspace inside the sandbox:

```
$ pnpm install
  × installing dependencies
  ╰─▶ Failed to open the store operation lock at "pnpm-store-operation-locks":
      Read-only file system (os error 30)
```

The folder exists, but pnpm opens and creates lock files *inside* it, so it needs a write grant. Pre-creating the
folder is not enough.

What this tells us:

- pnpm creates these folders itself with mode 0700. A folder the runner creates with mode 0700 therefore looks the
  same as one pnpm made, and a folder pnpm made before the runner existed passes our checks.
- The error is exactly the lock folder, as GWP-174 found.
- The folders are shared with the owner's own pnpm outside the sandbox (same uid). That is wanted: the shared store
  under `<runner root>/cache/pnpm` (GWP-228) is guarded by these locks, so agents and the owner must see the same
  locks.

### 2. Where the write list is really built

`sandboxFor()` (`apps/runner/src/sandbox/sandbox.ts:168`) returns only the `Sandbox` folders. It builds no write
list. The `/tmp/.dotnet` grant is added in three pure builders, and each adapter fills in its input:

| Builder | Input field | Write grant | Filled by |
|---|---|---|---|
| `buildShiftSettings` → `sandbox.filesystem.allowWrite` (`adapters/claude-policy.ts:455-463`) | `ClaudePolicyContext.dotnetShmDir` (l.94) | `...(ctx.dotnetShmDir ? [ctx.dotnetShmDir] : [])` | `claude-code.ts:557` |
| `codexFilesystem` (`adapters/codex.ts:239-253`) | `CodexProfileInput.dotnetShmDir` (l.214) | `set(i.dotnetShmDir, 'write')` | `codex.ts:1053` |
| `harnessBwrapArgs` (`sandbox/harness-sandbox.ts:144`) | `HarnessSandboxInput.dotnetShmDir` (l.61) | `bind(i.dotnetShmDir, true)` | `codex.ts:1209`, `gemini.ts:930`, `opencode.ts:520` |

Every filler uses `process.platform === 'linux' ? { dotnetShmDir: DOTNET_SHM_DIR } : {}`. One exception:
`codex.ts:1053` uses `this.host.platform ?? process.platform`.

So "the write list from sandboxFor()" in the card means "the write list of every profile built for a Sandbox". This
is the same scope as `DOTNET_SHM_DIR`, and it is what requirement 5 asks for.

### 3. Who calls `ensureSandbox()`, and who does not

`ensureSandbox()` is called for shifts (`shifts/supervisor.ts:1140`), chats (`chat/chat.ts:975, 1067, 1136`),
delegates (`delegate/delegate.ts:391`) and the role smoke test (`health/role-smoke.ts:173`).

**PR review does not call it.** `review/reviewer-sandbox.ts:83` builds its `Sandbox` by hand, with no `cacheRoot`
and no `ensureDotnetShm()`. The adapters still add `/tmp/.dotnet` for it on Linux.

So a design that only stores the result of `ensureSandbox()` on the `Sandbox` object would leave PR review out of
the requirement 5 scope. A check run where the profile is built covers every path, whoever built the `Sandbox`.

### 4. Run sandboxes (`src/runs/sandbox.ts`)

`bwrapArgs()` binds a private, writable `runTmp` over `/tmp` (l.96). pnpm in a setup step or service therefore
creates its lock folders inside the private `/tmp` and does not fail. `/tmp/.dotnet` is not granted there either, so
runs are outside the `DOTNET_SHM_DIR` scope. **No change to runs.**

There is one side effect, and it is not a failure. A run's pnpm does not share locks with agents that use the same
`<runner root>/cache/pnpm` store at the same moment. pnpm's store writes are atomic renames, so this is the same as
today. It is noted as a possible follow-up, not built here.

### 5. The harness box (Gemini, opencode, Codex in harness mode)

`harnessBwrapArgs()` mounts `--tmpfs /tmp`, a private writable `/tmp`. pnpm would not fail there even without the
grant. Binding the three host folders into the box anyway:

- gives cross-agent locking on the shared store, which is what the locks are for;
- keeps all profiles the same, as requirement 5 asks.

bwrap creates the mount points inside the tmpfs. This is the same mechanism `/tmp/.dotnet` uses today.

### 6. Symlinks and ownership in a sticky `/tmp`

`/tmp` is world-writable and sticky. Another local user can create `/tmp/pnpm-dir-locks-<our uid>` before the runner
does, as a folder of their own or as a symlink (for example to `~/.ssh`). If we granted write on such a path, the
sandbox would bind the target writable. That is the attack requirement 2 guards against.

Once the runner owns a real folder there, the sticky bit stops other users from renaming or removing it. Only our own
uid could swap it, and the sandboxed agent cannot, because `/tmp` itself stays read-only to it. A check at
`ensureSandbox()` time plus a cheap re-check when the profile is built is therefore enough.

## Options

### Where the validated list comes from

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Constant only | Adapters always pass the three paths on Linux | Smallest | Fails AC 4: a symlink or a foreign folder would be granted |
| B. Result stored on `Sandbox` | `ensureSandbox()` sets `sb.pnpmLockDirs`; adapters read `input.sandbox.pnpmLockDirs` | Checked once | PR review builds `Sandbox` by hand, so it never gets them; a `Sandbox` built in tests or by `sandboxFor()` alone loses them silently; the `SandboxInfo` picks in four adapters need widening |
| **C. Create in `ensureSandbox()`, re-check when the profile is built** | `ensurePnpmLockDirs()` (async) creates the folders and fixes them; `usablePnpmLockDirs()` (sync, `lstat`, no follow) returns the folders that pass; adapters call it beside `DOTNET_SHM_DIR` | Covers every profile (also PR review); the check sits next to the grant; pure builders stay pure | Three `lstatSync` calls per session start (negligible) |

**Recommended: C.**

### How the three paths are named (requirement 6)

The uid is only known at runtime, and tests need a temp root standing in for `/tmp`. So the single audited constant
holds the three folder names, and a one-line helper builds the paths:

```ts
/**
 * pnpm 12's lock folders: fixed paths under /tmp (it ignores TMPDIR), one set per uid. The only /tmp paths besides
 * DOTNET_SHM_DIR that the sandbox may write; each is checked first (usablePnpmLockDirs).
 */
export const PNPM_LOCK_DIR_NAMES = [
  'pnpm-store-operation-locks',
  'pnpm-dir-locks',
  'pnpm-verify-deps-install-locks',
] as const;

/** `<root>/<name>-<uid>` for each of PNPM_LOCK_DIR_NAMES. */
export const pnpmLockDirs = (uid: number, root = '/tmp'): string[] =>
  PNPM_LOCK_DIR_NAMES.map((n) => `${root}/${n}-${uid}`);
```

Put both directly under `DOTNET_SHM_DIR` (`sandbox.ts:57`).

## Design

### `apps/runner/src/sandbox/sandbox.ts`

1. Add `PNPM_LOCK_DIR_NAMES` and `pnpmLockDirs()` as above.

2. **`ensurePnpmLockDirs(opts?)`**: async, Linux only, never throws, returns the folders that passed.

   ```ts
   export async function ensurePnpmLockDirs(
     opts: { root?: string; uid?: number; log?: (msg: string) => void } = {},
   ): Promise<string[]> {
     if (process.platform !== 'linux' && opts.root === undefined) return [];
     const uid = opts.uid ?? process.getuid?.();
     if (uid === undefined) return [];
     const ok: string[] = [];
     for (const dir of pnpmLockDirs(uid, opts.root)) {
       try {
         await mkdir(dir, { mode: 0o700 });                 // NOT recursive: EEXIST on any existing entry, even a symlink
       } catch (e) {
         if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { warn(dir, `cannot create (${code(e)})`); continue; }
       }
       let fh;
       try {
         // O_NOFOLLOW + O_DIRECTORY: a symlink (ELOOP) or a non-directory (ENOTDIR) is refused, never followed;
         // the stat and chmod below act on this exact inode, so nothing can be swapped in between
         fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
         const st = await fh.stat();
         if (st.uid !== uid) { warn(dir, `owned by uid ${st.uid}, not ${uid}`); continue; }
         if ((st.mode & 0o777) !== 0o700) await fh.chmod(0o700);
         ok.push(dir);
       } catch (e) {
         warn(dir, code(e) === 'ELOOP' ? 'is a symlink' : code(e) === 'ENOTDIR' ? 'is not a directory' : `unusable (${code(e)})`);
       } finally {
         await fh?.close().catch(() => undefined);
       }
     }
     return ok;
   }
   ```

   - `warn(dir, reason)` logs `pnpm lock folder <dir> not added to the sandbox write list: <reason>` through
     `opts.log`. Default: one `process.stderr.write` line. Log each `(dir, reason)` once per process (a module-level
     `Set`), so a foreign folder does not spam the log on every shift.
   - Use `fh.chmod` (fchmod), not `chmod(path)`, which follows symlinks.
   - `mkdir` mode is masked by umask. 0700 survives any normal umask, and the explicit chmod makes it exact anyway.
   - `opts.root` / `opts.uid` exist for the unit tests. With `root` set, the Linux guard is skipped so the logic can
     be tested on any POSIX host. Production calls pass no options.

3. **`usablePnpmLockDirs(opts?)`**: sync, used where the profile is built. It never creates or changes anything.

   ```ts
   export function usablePnpmLockDirs(opts: { root?: string; uid?: number } = {}): string[] {
     if (process.platform !== 'linux' && opts.root === undefined) return [];
     const uid = opts.uid ?? process.getuid?.();
     if (uid === undefined) return [];
     return pnpmLockDirs(uid, opts.root).filter((d) => {
       try {
         const st = lstatSync(d);                         // does not follow a symlink
         return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) === 0o700;
       } catch {
         return false;                                    // missing: not granted (the sandbox cannot bind it anyway)
       }
     });
   }
   ```

   This function is silent. The reason is logged once by `ensurePnpmLockDirs()`.

4. **`ensureSandbox()`**: add `await ensurePnpmLockDirs({ log })` right after `await ensureDotnetShm()` (l.200).
   - Logging option (recommended): add an optional trailing parameter `opts?: { log?: Logger }` and pass
     `this.log`/`deps.log` from `shifts/supervisor.ts:1140`. Other callers keep the stderr default.
   - Do **not** change the order or the return type of the existing parameters. More than 30 call sites in tests use
     them.
   - `Sandbox` and `sandboxFor()` do not change.

### Adapters: thread a new input next to `dotnetShmDir`

Field name: `pnpmLockDirs?: string[]` (doc comment: "pnpm 12's fixed lock folders under /tmp that passed
`usablePnpmLockDirs` (Linux); writable").

| File | Change |
|---|---|
| `adapters/claude-policy.ts` | Add the field to `ClaudePolicyContext` (beside l.94). In `allowWrite` (l.462) add `...(ctx.pnpmLockDirs ?? [])` after the dotnet entry. |
| `adapters/claude-code.ts:557` | Beside `dotnetShmDir`: `...(process.platform === 'linux' ? { pnpmLockDirs: usablePnpmLockDirs() } : {})` |
| `adapters/codex.ts` | Add the field to `CodexProfileInput` (l.214). In `codexFilesystem` after l.253: `for (const p of i.pnpmLockDirs ?? []) set(p, 'write');`. Fill it at l.1053 with the same `this.host.platform ?? process.platform` guard, and at l.1209 for the harness input. |
| `sandbox/harness-sandbox.ts` | Add the field to `HarnessSandboxInput` (l.61). After l.144: `for (const p of i.pnpmLockDirs ?? []) bind(p, true);` |
| `adapters/gemini.ts:930`, `adapters/opencode.ts:520` | Fill the field beside `dotnetShmDir` |

Simplest pattern for every filler: one local
`const linux = process.platform === 'linux'` (or the host platform in codex), then
`...(linux ? { dotnetShmDir: DOTNET_SHM_DIR, pnpmLockDirs: usablePnpmLockDirs() } : {})`.

The three builders stay pure. Their unit tests pass the field by hand, as they do for `dotnetShmDir`.

### Not changed

- `src/runs/sandbox.ts`: private writable `/tmp`, see finding 4.
- `TMPDIR`, `cacheEnv`, `sandboxEnv`: no change, no TMPDIR trick.
- The deny lists: nothing under `/tmp` is added to `denyWrite`. Everything not in `allowWrite` stays read-only, as
  today.
- macOS and Windows: no grant (Linux only, like `DOTNET_SHM_DIR`).

### Docs: `docs/RUNNER.md`

- l.1485-1486 (".NET shm" paragraph in "Shared package caches and .NET"): add a paragraph. It should cover:
  - pnpm 12 takes locks in `/tmp/pnpm-{store-operation,dir,verify-deps-install}-locks-<uid>` and ignores TMPDIR;
  - the runner creates the three folders for its own uid (mode 0700, never through a symlink);
  - a folder that is a symlink or belongs to another uid is not granted, and the runner logs why;
  - only these three paths and `/tmp/.dotnet` are writable under `/tmp`;
  - the constant is `PNPM_LOCK_DIR_NAMES` in `sandbox/sandbox.ts`.
- l.1760 (`allowWrite` row): add "+ the three pnpm lock folders `/tmp/pnpm-*-locks-<uid>` on Linux when they pass
  the ownership check".
- l.1131 (Codex grants): add the three folders after `/tmp/.dotnet`.
- The harness-box section (the "writable:" list, mirrored in the `harness-sandbox.ts` header comment l.16-17): add
  "and the pnpm lock folders".

## Tests

Use `test/sandbox-caches.test.ts` and `test/sandbox-dotnet-roots.test.ts` as the pattern. Use a new
`test/sandbox-pnpm-locks.test.ts` or extend `sandbox-caches.test.ts`.

Unit tests (temp root via `tmp()`, `uid: process.getuid()`):

1. **Creation**: `ensurePnpmLockDirs({ root, uid })` creates exactly the three `<root>/<name>-<uid>` folders,
   directories with `(mode & 0o777) === 0o700` and `st.uid === uid`, and returns all three.
2. **Idempotence**: a second call returns the same three, with no error and the mode unchanged.
3. **Mode fix**: pre-create one folder with 0755. After the call it is 0700 and it is returned.
4. **Symlink**: make one path a symlink to another temp folder. It is not returned, the target's mode is not changed,
   the log callback got a message containing the path and "symlink", and `usablePnpmLockDirs` leaves it out.
5. **Not a directory**: a plain file at the path. Refused and logged.
6. **Foreign owner**: running as another uid needs root, so simulate it. Call with `uid: process.getuid() + 1` on
   folders the test created. Every existing folder is refused as "owned by uid …". (`mkdir` succeeds as the real uid,
   so the folders are owned by the real uid, which is not the `uid` passed.) Assert that nothing is returned, the
   message names the owner uid, and `usablePnpmLockDirs` with the same `uid` returns `[]`.
7. **Log once**: two calls with the same bad folder log once.
8. **Exact write-list entries**:
   - `buildShiftSettings(..., policyCtx({ dotnetShmDir: DOTNET_SHM_DIR, pnpmLockDirs: pnpmLockDirs(1000) }))`: for
     builder, reviewer and tester, `allowWrite` contains `DOTNET_SHM_DIR` and exactly the three new paths. The test
     filters `allowWrite` for entries starting with `/tmp` and asserts it equals
     `[DOTNET_SHM_DIR, ...pnpmLockDirs(1000)]` (no `/tmp`, no wildcard).
   - Without the field the list is unchanged (regression).
   - The same exact check for `codexFilesystem` (the three paths map to `'write'`, `/tmp` is absent) and for
     `harnessBwrapArgs` (three `--bind p p` pairs; `/tmp` stays `--tmpfs` only).
9. **Adapter wiring**: one test per adapter that its context or profile carries `pnpmLockDirs` on Linux. Use the
   existing adapter-test fixtures. `vi.spyOn` on the module export, or check against `usablePnpmLockDirs()` on the
   real host.

Real bubblewrap test (skipped without `bwrap`, like the dotnet block in `sandbox-caches.test.ts:218`). Bind only the
policy's `allowWrite` paths over a read-only `/`, then:

- `touch /tmp/pnpm-dir-locks-<uid>/probe` succeeds (rm the probe after);
- `touch /tmp/x` fails with "Read-only file system" (AC "any other /tmp path denied");
- when `pnpm --version` reports 12 or higher on the host (skip otherwise): in a temp workspace with
  `package.json` (no dependencies) and `pnpm-lock.yaml` (`lockfileVersion: '9.0'`, empty importer), run
  `pnpm install --frozen-lockfile`, `pnpm run <echo script>` and `pnpm exec node -v`. None prints
  `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` or "store operation lock". A run with the lock folders left out of the
  binds shows the bug (the error above), the same way the dotnet "without /tmp/.dotnet" case does.

The suite runs `ensureSandbox()` against the real `/tmp` on Linux, as `ensureDotnetShm()` already does. That is
harmless: it is the runner's own uid, and the folders usually exist already.

### Regression trap

Look for tests that build the Claude, Codex or harness profile through an adapter on Linux and assert an exact
`allowWrite` / fs table or an exact bwrap argument list. On a machine where the folders exist they now see three more
entries. Grep for `allowWrite).toEqual(`, `toStrictEqual`, and exact `harnessBwrapArgs` comparisons in
`claude-*.test.ts`, `codex-adapter.test.ts`, `gemini-adapter.test.ts`, `opencode-adapter.test.ts` and
`harness-*.test.ts`. The pure-builder tests (for example `claude-args.test.ts:292`) build the context by hand and are
not affected.

## Acceptance criteria mapping

| AC | Design |
|---|---|
| Owner's approval recorded before merge | Not code. The builder/BA must not let the card merge until the owner's OK is on the card (see "Approval" below). |
| After `ensureSandbox()` the three folders exist, runner uid, 0700 | `ensurePnpmLockDirs()` called from `ensureSandbox()` beside `ensureDotnetShm()`; tests 1-3 |
| Write list has exactly those three plus existing entries (incl. `/tmp/.dotnet`), no broader `/tmp` | `pnpmLockDirs` field in the three builders, filled from `usablePnpmLockDirs()` beside `DOTNET_SHM_DIR`; test 8 (exact `/tmp*` filter) |
| Symlink or foreign-owned folder not added, reason logged | `O_NOFOLLOW` + `O_DIRECTORY` + uid check in `ensurePnpmLockDirs` (logs); `lstat` check in `usablePnpmLockDirs` (excludes); tests 4-7 |
| `pnpm install --frozen-lockfile` works in a shift | Real-bwrap test (pnpm 12 present) plus the tester's manual run in guildwise-cloud |
| `pnpm run` / `pnpm exec` verify-deps step works | Same; `pnpm-verify-deps-install-locks-<uid>` is in the list |
| `touch /tmp/x` still denied | No `/tmp` entry is added; real-bwrap `touch /tmp/x` test; tester check in a shift |
| Unit tests + full `apps/runner` suite pass | Tests 1-9 + the real-bwrap block; run `pnpm --filter @aom/runner test` (or the package's test script) |

## Risks

- **Security (the reason for the owner's approval).** The agent can write into three folders that the owner's own,
  unsandboxed pnpm also uses. An agent could plant entries (for example a symlink named like a lock file) that the
  owner's pnpm then opens.
  - pnpm opens lock files to take an advisory lock, not to write content into them.
  - Agents of one runner already share the writable pnpm store, which is a stronger capability.
  - Today `/tmp/.dotnet` is 0777 and open to every local user, while these folders are 0700 and open only to our uid.
  - Residual risk: low. The report recommends approval.
- **Folder owned by another local user** (pre-created on a shared machine): pnpm in shifts keeps failing as today,
  and the runner logs why. This is intended. The fix is for the admin to remove the foreign folder.
- **Run sandboxes**: not covered, intentionally (private `/tmp`). See finding 4.
- **pnpm adds another fixed path in a later version**: the shift fails the same way, with a different folder name.
  The single constant makes that a one-line change, plus another owner approval.
- **Merge with GWP-228**: GWP-228 edits `cacheEnv()` at l.63-79. The new constant goes at l.57, so the hunks are
  near each other but separate. Build this card on top of the merged GWP-228.

## Approval

This change widens the sandbox write list. The owner's explicit OK must be recorded on the card before merge, as the
card's first AC requires. The design does not need the approval to be built and reviewed.

## Assumptions about unlanded dependencies

GWP-228 (pnpm_config_store_dir) is assumed to:

1. Change only `cacheEnv()` (add `pnpm_config_store_dir`) and its tests. It does not touch `DOTNET_SHM_DIR`,
   `ensureDotnetShm`, `ensureSandbox`'s signature, the `Sandbox` interface, or the adapters' `dotnetShmDir` threading.
   If it does, the insertion points above move, but the design does not change.
2. Not change the sandbox write list. Its spec says so (requirement 5). If it adds write entries, test 8's exact
   `/tmp*` filter still holds, because the store is under `<runner root>/cache`, not `/tmp`.
3. Land before this card. The lock folders alone do not need it: pnpm 12 fails on the locks with or without the store
   variable. But the manual AC check (`pnpm install` in a shift) is only meaningful with the shared store set up. If
   GWP-228 has not landed, the install still gets past the locks, using a store under the sandbox HOME.
