# Test site deploy fails after the core pins e537a940 and 733fbe41

## Question

The test-site deploy runs 041000e2 (commit e537a940) and 77dda7e3 (commit 733fbe41) end with "script exited with 1".
The reported cause is a broken lockfile. Which lockfile is broken, how is it fixed, and does the GuildwiseHQ lockfile
need to change?

## Short answer

- The broken lockfile is **guildwise-cloud's `pnpm-lock.yaml`**, not GuildwiseHQ's.
- e537a940 and 733fbe41 are commits of **guildwise-cloud** (branch `origin/development`), not of GuildwiseHQ. Neither
  exists in the GuildwiseHQ history. They are the two submodule bumps:
  - 733fbe41 `chore: pin core to 36beac9ff2` (GuildwiseHQ merge of the vite 8 / jsdom 31 work)
  - e537a940 `chore: pin core to 0590196ce6` (GuildwiseHQ merge of the DiceBear work, current GuildwiseHQ `main`)
- Each commit changes only the `core` gitlink. Neither regenerates guildwise-cloud's lockfile. guildwise-cloud's
  workspace (`pnpm-workspace.yaml`) includes `core/packages/*` and `core/apps/*`, so every core `package.json` is an
  importer of the cloud lockfile. Moving the core pin changed 43 of those specifiers. The guildwise-cloud `Dockerfile`
  build stage then runs `pnpm install --frozen-lockfile` (line 11), and pnpm refuses an out-of-date lockfile
  (`ERR_PNPM_OUTDATED_LOCKFILE`). The `docker build` fails, and the deploy script exits with 1.
- GuildwiseHQ's lockfile at `main` (0590196c) is consistent: no specifier mismatch, one vitest (4.1.12), one jsdom
  (31.0.0), one vite (8.3.7), and the lockfile overrides match `pnpm-workspace.yaml`. GWP-190 already applied the
  "two vitest snapshots, two jsdom majors" fix in 5f36412e / 14d7d3b7 / da3d4d8f. **Nothing in GuildwiseHQ needs to
  change.**
- The card's constraints put guildwise-cloud out of scope ("if the failing test site turns out to be a guildwise-cloud
  environment, the submodule bump there is a separate follow-up card"). That is the case here, so the fix is a
  guildwise-cloud change and needs the manager's decision (see Recommendation).

## Findings

### 1. Where the failing commits live

```
$ git -C GuildwiseHQ log -1 e537a940     -> fatal: Not a valid object name
$ git -C guildwise-cloud log -1 e537a940 -> e537a940 Wed Nov 11 07:15 2026  chore: pin core to 0590196ce6
$ git -C guildwise-cloud log -1 733fbe41 -> 733fbe41 Wed Nov 11 07:07 2026  chore: pin core to 36beac9ff2
$ git -C guildwise-cloud branch -a --contains e537a940 -> remotes/origin/development
$ git -C guildwise-cloud show --stat e537a940 -> core | 2 +-   (only the gitlink)
```

The parent of 733fbe41 is 9a2c083 (merge of release/1.6.0), which pins core to **95d2a9c9**. The cloud lockfile was
last regenerated in 5f86bbe (2026-11-08) and matches that pin exactly. Spot checks of core@95d2a9c9 against the cloud
lockfile: `ai 7.0.150`, `execa ^9.0.0`, `commander ^14.0.0`, `pdf-parse 1.1.1`, `jsdom ^30.1.1`, `vite ^7.3.7`,
`@vitejs/plugin-react ^5.0.0`. All of them match.

### 2. The cloud lockfile against the manifests at e537a940 (core 0590196c)

A read-only comparison of every importer's `specifier` in the cloud lockfile with the `package.json` files of a copy of
guildwise-cloud@e537a940 with core@0590196c found 44 mismatches. One of them (cloud `server` `pg`) is a false positive:
`pg` is listed in both dependencies and devDependencies, and pnpm folds the two. That leaves 43 real mismatches, all in
core importers. A selection:

| importer | dependency | package.json (core 0590196c) | cloud lockfile |
|---|---|---|---|
| core/apps/web | jsdom | ^31.0.0 | ^30.1.1 |
| core/apps/web | vite | 8.3.7 | ^7.3.7 |
| core/apps/web | vitest | ^4.1.12 | *missing* |
| core/apps/web | @vitejs/plugin-react | ^6.2.1 | ^5.0.0 |
| core/apps/runner | execa | ^10.2.1 | ^9.0.0 |
| core/apps/runner | commander | ^15.1.0 | ^14.0.0 |
| core/apps/runner | ai | 7.0.164 | 7.0.150 |
| core/apps/runner | pdf-parse | 2.4.5 | 1.1.1 |
| core/apps/server | @anthropic-ai/sdk | ^1.6.0 | ^0.132.1 |
| core/apps/server | fastify-type-provider-zod | ^7.0.0 | ^6.0.0 |
| core/packages/shared | uuid | ^14.0.3 | ^14.0.2 |
| core/packages/video | playwright-core | ^1.65.0 | ^1.63.0 |

The cloud lockfile still resolves `vitest@4.1.12(...)(jsdom@30.1.3)...`, `jsdom@30.1.3` and `vite@7.3.7`, so it describes
the pre-GWP-190 core.

The same check on GuildwiseHQ@0590196c (this worktree):

```
docs 2
mismatches 0
vitest [ 'vitest@4.1.12(@opentelemetry/api@1.10.0)(@types/node@22.20.5)(jsdom@31.0.0)(msw@3.0.4(...' ]
jsdom  [ 'jsdom@31.0.0' ]
vite   [ 'vite@8.3.7' ]
parse5 [ 'parse5@8.1.0' ]
```

### 3. The deploy path that runs the frozen install

guildwise-cloud `Dockerfile`, build stage:

```
RUN npm install -g pnpm@12.8.1
COPY . .
RUN test -f core/package.json || (...; exit 1)
RUN pnpm install --frozen-lockfile        <- fails: lockfile out of date with core/*/package.json
```

guildwise-cloud CI (`.github/workflows/ci.yml` line 74) runs the same `pnpm install --frozen-lockfile`, so CI on
`development` is red for the same reason.

### 4. The "two lockfile bodies" seen in planning is not a defect

The planning note flagged that `pnpm-lock.yaml` holds two YAML documents (`---` at line 1 and line 158). This is the
format pnpm 11+ writes when `packageManager` is set: the first document is the environment lockfile
(`importers['.'].packageManagerDependencies.pnpm` with the integrity hashes of pnpm 12.8.1 itself and its platform
binaries), and the second is the project lockfile. guildwise-cloud's lockfile has the same layout, also written by pnpm.
Do **not** remove the first document. pnpm writes it again on the next install.

### 5. Deploy logs and local reproduction

- I could not run pnpm in the design sandbox: every `pnpm install` stops at `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`
  (read-only file system for the store lock) before it checks the lockfile. I asked DevOps (request 8694307b) for the
  tail of runs 041000e2 / 77dda7e3 and for a frozen install in throwaway clones of guildwise-cloud@e537a940 (core
  0590196c) and GuildwiseHQ@0590196c. Expected results: guildwise-cloud fails with `ERR_PNPM_OUTDATED_LOCKFILE`
  ("Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date with core/apps/..."), and GuildwiseHQ
  passes. The DevOps answer goes on the card thread when it arrives.
- The ledger has a precedent for the same failure: run c148b631 deployed guildwise-cloud c928750 (`pin core to
  c2977c866e`) and failed. The CEO's answer: regenerate `pnpm-lock.yaml` on the branch that was deployed, push, and
  redeploy the test site.

### 6. Why it keeps happening

`scripts/bump-core.sh` (and the `bump-core.yml` workflow that calls it) only moves the gitlink (`git add core`). It does
not refresh the cloud lockfile. The manual "pin core to ..." commits on `development` follow the same pattern. Any core
release that changes a dependency range therefore breaks the cloud's frozen install and the test-site deploy until
someone regenerates the lockfile by hand. This has happened at least twice now (c148b631, and 041000e2 / 77dda7e3).

## Options

| | What | Fixes the deploy | Scope fit |
|---|---|---|---|
| A | Regenerate GuildwiseHQ's lockfile (the card as written) | No. It is already consistent, so a regenerate produces no diff, and the builder would hand off an empty change | In scope, but useless |
| B | New guildwise-cloud card (or this card re-scoped to guildwise-cloud): on `development`, run `pnpm install --lockfile-only` with pnpm 12.8.1 at the e537a940 pin, commit `pnpm-lock.yaml`, CI green, redeploy the test site | Yes | Needs the manager's decision (the card puts guildwise-cloud out of scope) |
| C | As B, done by DevOps as an operations fix (precedent c148b631) | Yes, fastest | Leaves no design or review trail for the cloud workspace overrides (below) |
| D | B plus the process fix: `scripts/bump-core.sh` runs `pnpm install --lockfile-only` after moving the gitlink and stages `pnpm-lock.yaml`, and the bump PR commits both | Yes, and prevents the next one | Separate guildwise-cloud card or a backlog item |

Points a guildwise-cloud fix has to keep in mind:

1. **Overrides.** The core's `pnpm-workspace.yaml` overrides are not read in the cloud workspace (the cloud's own
   workspace file says so). The core relies on `parse5-parser-stream>parse5: ^8.1.0` (jsdom 31 cannot parse documents
   without it, see da3d4d8f) and `jsdom@<31: ^31.0.0`. The Docker build and cloud CI do not run the core web tests, so
   the deploy does not need these overrides. Mirror `parse5-parser-stream>parse5` into the cloud workspace only if the
   cloud runs jsdom 31 anywhere. Do not mirror `jsdom@<31` without a decision: it would also move cloud `web`'s own
   `jsdom ^30.1.1` to 31.
2. **Two vite / jsdom majors in the cloud workspace are expected after the regenerate.** Cloud `web/package.json`
   declares `vite ^7.3.6`, `@vitejs/plugin-react ^5.0.0` and `jsdom ^30.1.1`. Core `apps/web` declares vite 8.3.7 and
   jsdom 31. Both majors can coexist, and the frozen install passes. Aligning cloud `web` with vite 8 is a separate
   upgrade and not part of the deploy fix.
3. Regenerate with pnpm 12.8.1 (the cloud's `packageManager` field and the Dockerfile's `npm install -g pnpm@12.8.1`),
   with the submodule checked out at the pinned commit, never by hand. Then check that a second `pnpm install` gives no
   lockfile diff.

## Recommendation

1. **No change in GuildwiseHQ.** Its lockfile already meets the card's lockfile criteria at `main` 0590196c (one vitest
   4.1.12, one jsdom major 31.0.0, regenerated by pnpm in GWP-190, 0 specifier mismatches). The GuildwiseHQ-side
   criteria can be shown from `main` as it is: frozen install, no diff on reinstall, `pnpm why vitest` / `pnpm why
   jsdom`, and GuildwiseHQ CI.
2. **Fix guildwise-cloud (option B, with D as a follow-up).** Regenerate the cloud's `pnpm-lock.yaml` on `development`
   at the current core pin (0590196c) with pnpm 12.8.1, commit it as "regenerate pnpm-lock.yaml for core 0590196ce6",
   let CI run, and redeploy the test site from that commit. Then record the run id, commit and URL.
3. Teach `scripts/bump-core.sh` to regenerate and stage the cloud lockfile together with the gitlink, so a core bump
   cannot land without it.

The card restricts its own scope to GuildwiseHQ, so I am handing this to the manager to choose B, C or a re-scope
rather than designing a build in GuildwiseHQ that has nothing to change.

## Acceptance criteria against this finding

| Criterion | Status |
|---|---|
| Failing step and error of 041000e2 / 77dda7e3 recorded, and whether the lockfile is the cause | Cause found from the commits and manifests: the `pnpm install --frozen-lockfile` step of the guildwise-cloud Docker build, which fails because the **cloud** lockfile is out of date. Log text pending from DevOps (request 8694307b) |
| Frozen install passes at the pinned pnpm version | GuildwiseHQ: expected to pass at 0590196c (0 mismatches). guildwise-cloud: fails until its lockfile is regenerated |
| One vitest, one jsdom major | GuildwiseHQ: met (vitest 4.1.12, jsdom 31.0.0) |
| Regenerated by pnpm, no diff on reinstall | GuildwiseHQ: regenerated by pnpm in 14d7d3b7 (GWP-190). guildwise-cloud: applies to the cloud fix |
| CI green | GuildwiseHQ: unaffected. guildwise-cloud CI is red on `development` for the same reason |
| Test-site deploy succeeds | Needs the guildwise-cloud lockfile fix |
