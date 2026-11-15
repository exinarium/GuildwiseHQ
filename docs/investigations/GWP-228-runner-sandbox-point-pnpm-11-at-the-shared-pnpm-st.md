# GWP-228: point pnpm 11+ at the shared pnpm store (`pnpm_config_store_dir`)

## Question

The runner's sandbox env tells pnpm where the shared store is through `npm_config_store_dir`
(`<runner root>/cache/pnpm`). pnpm 11 and later no longer read `npm_config_*` variables; they read
`pnpm_config_*`. How do we make shifts and run environments use the shared store with pnpm 11/12,
while pnpm 8-10 keep working?

## Findings

### Code as it is on `main`

- `apps/runner/src/sandbox/sandbox.ts:63` `cacheEnv(cacheRoot)` returns the cache variables. The
  pnpm entry is `npm_config_store_dir: d('pnpm')`, where `d = (k) => sharedCacheDir(cacheRoot, k)`
  (`join(cacheRoot, 'pnpm')`).
- `sandbox.ts:113` `CACHE_ENV_KEYS` is **derived**: `[...Object.keys(cacheEnv('/')), ...Object.keys(dotnetEnv('/')), 'NUGET_FALLBACK_PACKAGES']`.
  A new key in `cacheEnv()` is in `CACHE_ENV_KEYS` with no further edit (requirement 3).
- Consumers of `cacheEnv()`:
  - `sandboxEnv()` (`sandbox.ts:216`) spreads `cacheEnv(sb.cacheRoot)` after `toolchainEnv` and
    before `dotnetEnv`, so the runner value wins over any toolchain value. Callers: shift supervisor,
    chat manager (run, runDirectChat, runSessionTurn), delegate runner, PR review, role smoke. None
    of them needs a change.
  - `RunManager.baseEnv(sandboxed)` (`apps/runner/src/runs/manager.ts:1125`) assigns
    `cacheEnv(sharedCacheRoot(this.deps.paths))` **only when `sandboxed` is true** (line 1155). It
    feeds `launch()` (run steps and services, line 1265) and `checkLaunch()` (handoff checks, line
    1226). Unsandboxed runs inherit the runner's own process env (scrubbed), as they do today for
    `npm_config_store_dir`; this card does not change that.
- `apps/runner/src/adapters/claude-code.ts:163` deletes every `CACHE_ENV_KEYS` entry from the
  unsandboxed DevOps session, so the DevOps engineer keeps the user's own pnpm store. The new key is
  covered there automatically.
- The store directory already exists and is writable: `ensureSharedCaches()` creates
  `<cacheRoot>/pnpm`, and the policy grants write on the whole cache root
  (`claude-policy.ts:461`, run sandbox `sandboxCommand({ cacheRoot })`). No write-list change.
- `apps/runner/src/toolchain/registry.ts:82` `RESERVED` stops toolchains from setting
  `npm_config_.*` / `NPM_CONFIG_.*`, but **not** `pnpm_config_.*`. In shifts this does not matter
  (cacheEnv is spread after toolchainEnv). See "Risks" for a follow-up.

### Behaviour checked in this shift (pnpm 12.8.1 toolchain)

This shift's env already carries both variables with the same value (the runner process or a
toolchain sets `pnpm_config_store_dir` today; the runner source on `main` does not):

| Command | Output |
| --- | --- |
| `pnpm --version` | `12.8.1` |
| `pnpm store path` | `<runner root>/cache/pnpm/v11` |
| `env -u pnpm_config_store_dir pnpm store path` (only `npm_config_store_dir` set) | `<worktree>/node_modules/.pnpm-store/v11` |

So pnpm 12 ignores `npm_config_store_dir` and falls back to a private store (here on the worktree's
filesystem, elsewhere under the sandbox HOME): cold, unshared, re-downloaded per agent. Setting
`pnpm_config_store_dir` fixes it. This confirms the card's premise.

Note for the tester: `pnpm store path` prints the store **plus a layout suffix** (`/v11` for
pnpm 12; `/v3` or `/v10` for older pnpm). The expected output is `<runner root>/cache/pnpm/v<N>`,
not the bare directory. `pnpm config get store-dir` prints the bare directory.

## Options

1. **Add `pnpm_config_store_dir` to `cacheEnv()` next to `npm_config_store_dir`** (both the same
   path). One line; `CACHE_ENV_KEYS`, `sandboxEnv`, `baseEnv` and the DevOps strip all follow. pnpm
   8-10 keep reading `npm_config_store_dir`; pnpm 11+ read `pnpm_config_store_dir`. When both are
   read by one version they agree, so there is no precedence question.
2. Write a `store-dir` line into a `.npmrc`/`pnpm` global rc in the sandbox HOME. More moving parts
   (file written per agent, differs between shift HOME and the run `SERVICE_HOME`), and a project
   `.npmrc` could still override it. Rejected.
3. Replace `npm_config_store_dir` with `pnpm_config_store_dir`. Breaks pnpm 8-10 toolchains and the
   card forbids it. Rejected.

## Recommendation and design

Take option 1.

### Change (product code)

`apps/runner/src/sandbox/sandbox.ts`, `cacheEnv()`:

```ts
    npm_config_cache: d('npm'),
    // pnpm 8-10 read npm_config_*, pnpm 11+ only pnpm_config_*: both point at the same shared store
    npm_config_store_dir: d('pnpm'),
    pnpm_config_store_dir: d('pnpm'),
    YARN_CACHE_FOLDER: d('yarn'),
```

Nothing else in product code. Do **not** add a literal to `CACHE_ENV_KEYS`: it is derived from
`Object.keys(cacheEnv('/'))`, and a hand-added duplicate would be noise. (Leave the doc comment on
`cacheEnv` as is, or extend it with the one-line pnpm note above.)

No change to `CACHE_KINDS`, `sharedCacheDir`, the store path, the sandbox write list, `ensureSandbox`
or the `/tmp` lock folders (GWP-229, same group, separate functions).

### Tests

Extend `apps/runner/test/sandbox-caches.test.ts`:

1. In "points every package manager at the shared cache dirs" (line ~48), add
   `pnpm_config_store_dir: c('pnpm')` to the `toMatchObject` and assert
   `env.pnpm_config_store_dir === env.npm_config_store_dir`. This covers `sandboxEnv()` for a shift.
2. New case for `cacheEnv()` directly (import `cacheEnv`, `CACHE_ENV_KEYS`):
   ```ts
   it('pnpm 11+ and pnpm 8-10 both get the shared store', () => {
     const e = cacheEnv('/r/cache');
     expect(e.pnpm_config_store_dir).toBe(join('/r/cache', 'pnpm'));
     expect(e.npm_config_store_dir).toBe(e.pnpm_config_store_dir);
     expect(CACHE_ENV_KEYS).toEqual(expect.arrayContaining(['npm_config_store_dir', 'pnpm_config_store_dir']));
   });
   ```
3. In "a sandboxed session gets the cache env; the unsandboxed DevOps engineer keeps the user caches"
   (line ~96), add `'pnpm_config_store_dir'` (and `'npm_config_store_dir'`) to the list that must be
   undefined for DevOps. This pins the existing strip in `claude-code.ts:163` (regression guard).
4. `RunManager.baseEnv()` for a run: it is private. Two ways, pick the first:
   - `(mgr as any).baseEnv(true)` on a `RunManager` built with `runnerPaths(tmp())` (the `runs-p2`
     tests already reach privates with `as any`, line ~792). Assert
     `pnpm_config_store_dir === join(paths.root, 'cache', 'pnpm')` and equal to
     `npm_config_store_dir`. Also assert `baseEnv(false)` does **not** add it when the runner
     process env lacks it (documents that only sandboxed runs get the cache env; run the assertion
     with `pnpm_config_store_dir` removed from `process.env` via `vi.stubEnv`/restore, because this
     very shift's env carries it).
   - Or through the public `checkLaunch({ key, worktree, argv: ['true'] })` with
     `sandboxMode: () => ({ mode: 'required', allowUnsandboxed: false })` and a launcher stub whose
     `sandboxAvailable()` resolves `true`; it returns `baseEnv(true)` without executing anything.
   Put it in `sandbox-caches.test.ts` or `runs-p2.test.ts` outside the `skipIf(!hasBwrap)` block, so
   it runs on every machine.

Run only unit tests of apps/runner with a hang limit (for example
`timeout 600 pnpm --filter @aom/runner exec vitest run test/sandbox-caches.test.ts`, then the whole
runner suite). The bubblewrap/dotnet cases in `sandbox-caches.test.ts` skip themselves without bwrap;
leave `scan-sandbox-real`/`claude-sandbox-real` behaviour as is.

### Acceptance criteria mapping

| AC | Covered by |
| --- | --- |
| cacheEnv() returns both keys, same path under `<runner root>/cache/pnpm` | the one-line change; test 2 |
| CACHE_ENV_KEYS contains `pnpm_config_store_dir` | derived list; test 2 |
| sandboxEnv() and RunManager.baseEnv() carry it | consumers unchanged; tests 1 and 4 |
| pnpm 12 shift: `pnpm store path` is the shared store | manual/tester: expect `<runner root>/cache/pnpm/v11`; verified above that without the variable it is not |
| pnpm 8-10: still the shared store | `npm_config_store_dir` kept unchanged; manual/tester with a pnpm 8-10 binary (expect `.../cache/pnpm/v3` or `/v10`) |
| runner tests pass, unit test for the key | tests 1-4 plus full apps/runner unit suite |

## Risks

- **Low.** Additive env variable, same value as an existing one; no path, permission or policy
  change.
- The installed runner already appears to inject `pnpm_config_store_dir` into shifts (see the
  table), probably through the runner process env or a registered toolchain variable. After this
  change the runner sets it itself, with the same value, and `cacheEnv` wins over a toolchain value
  in `sandboxEnv`. Any such stop-gap can be removed after release; that is an ops task, not code.
- Follow-up (not this card): `toolchain/registry.ts` `RESERVED` blocks `npm_config_.*` but not
  `pnpm_config_.*`, so a toolchain may register `pnpm_config_*` variables. Harmless for the store
  (overridden), but the symmetry argues for reserving `pnpm_config_store_dir` (or `pnpm_config_.*`)
  later, after checking that no registered toolchain uses it. Suggested on the backlog.
- Unsandboxed runs (`baseEnv(false)`, sandbox mode off) keep inheriting the runner's process env,
  as they already do for `npm_config_store_dir`. Out of scope.
