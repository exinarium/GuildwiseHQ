# GWP-116: Dependabot alerts #23 (minimatch) and #22 (glob)

## Question

How do we move `glob` and `minimatch` in `pnpm-lock.yaml` out of the vulnerable ranges of Dependabot alerts #22 and #23?
Constraints: no blanket update, no loosened overrides, same pnpm version and lockfile format, and no behaviour change.

## Findings

### The advisories (read on GitHub, 2026-11-08)

| Alert | Advisory | Package | Vulnerable range | First patched | Severity |
|---|---|---|---|---|---|
| #22 | GHSA-3g3m-2fjr-6pw4 (CVE-2026-118773), "AbortSignal cancellation bypass allows post-timeout filesystem traversal" | `glob` | `>= 9.0.0, <= 14.0.1` | `14.0.2` | Moderate |
| #23 | GHSA-g3hv-75wg-m249 (CVE-2026-118764), "potential denial of service via globparts amplification" | `minimatch` | `>= 7.0.0, < 11.0.1` | `11.0.1` | Moderate |

- Both fixes are in a **new major**: glob 13 → 14, minimatch 10 → 11.
- `glob@13.0.7` (dist-tag `v13-legacy`, published 2026-11-06) backports the abort fix ("fix: do not continue walking after signal abort"). The advisory range still covers it, though, and Dependabot matches on that range. So 13.0.7 would **not** close alert #22, and it still pulls `minimatch ^10.2.2`, which keeps #23 open.
- minimatch has no 10.x release with the fix. The changelog lists the fix only under 11.0.

### What the lockfile resolves today (base `d85ae1e5`)

There is exactly one resolution of each package. Both arrive through the same chain:

```
apps/server (@aom/server)  "@fastify/static": "^10.1.7"
  └─ @fastify/static 10.1.7           (glob ^13.0.0)
       └─ glob 13.0.6                 ← alert #22
            ├─ minimatch 10.2.6       ← alert #23
            │    └─ brace-expansion 5.0.12
            ├─ minipass 7.1.3
            └─ path-scurry 2.0.2
```

No source file in `apps/*`, `packages/*` or `e2e` imports `glob` or `minimatch` directly. The only consumer is `@fastify/static`.

### How the server uses it (runtime)

`apps/server/src/app.ts:638` registers `fastifyStatic` with `{ root, wildcard: false, index: false }` when `AOM_SERVE_WEB` is on.
With `wildcard: false`, `@fastify/static` runs `glob` over the web `dist` folder **once, at boot**, and registers one route per file it finds.
So glob runs in production on the server's startup path. The pattern is fixed by the library, with no user input and no `signal`, so real exploitability here is low. The package still ships at runtime, though.
**Classification: runtime** (shipped with apps/server, in the Docker image too).

### Upstream releases (npm registry)

| Package | Version | Published | Relevant dependencies |
|---|---|---|---|
| `@fastify/static` | 10.1.7 (current) | 2026-10-21 | `glob ^13.0.0`, `@fastify/send ^4.x` |
| | 10.1.8 | 2026-10-27 | `glob ^13.0.0`, `@fastify/send ^4.2.0` |
| | 10.1.9 | 2026-11-04 | **`glob ^14.0.0`**, `@fastify/send ^4.2.0` |
| | **10.1.10** (latest) | 2026-11-04 | **`glob ^14.0.0`**, `@fastify/send ^4.2.0` |
| `glob` | 14.0.2 | 2026-10-27 | `minimatch ^11.0.0`, `path-scurry ^3.0.0` |
| | 14.0.4 (latest) | 2026-11-06 | **`minimatch ^11.0.5`**, `path-scurry ^3.0.0`, `minipass ^7.1.3` |
| `minimatch` | 11.0.1 | 2026-10-27 | `brace-expansion ^5.0.12`, `@isaacs/nonrecursive-glob-match ^1.0.1` |
| | 11.0.5 (latest) | 2026-11-05 | |

- glob 14 still ships a CommonJS build (`exports["."].require` → `dist/commonjs/index.min.js`, `main` the same). The CJS `@fastify/static` keeps loading it with `require`.
- The breaking changes in glob 14 / minimatch 11 are the removed RegExp APIs (`makeRe`, `Minimatch#regexp`, `Pattern#isRegExp`), the removed `debug` option, walker results as arrays instead of sets, and edge-case matching that is closer to Bash (an empty path portion like the end of `a/b/` only matches an empty pattern portion). `@fastify/static` 10.1.9+ adopted glob 14 upstream, so the API side is the library's concern. We call neither package directly.
- Every target version is older than 2 days, so the repo's `minimumReleaseAge` gate (see `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`) should not block it. The newest is glob 14.0.4 from 2026-11-06. If pnpm refuses on release age, see risk R3.

## Options

| | Option | Closes #22/#23 | Notes |
|---|---|---|---|
| **A** | Bump the direct parent: `apps/server` `@fastify/static` `^10.1.7` → `^10.1.10` | Yes: resolves glob ≥14.0.2 (expected 14.0.4) and minimatch ≥11.0.1 (expected 11.0.5) | No override needed. Patch-level bump of the direct dependency. It also moves `@fastify/send` 4.1.1 → 4.2.x (required by `@fastify/static` 10.1.8+). This is the card's preferred route. |
| B | Keep `@fastify/static` 10.1.7 and override `glob@>=9.0.0 <14.0.2` → `^14.0.2` and `minimatch@>=7.0.0 <11.0.1` → `^11.0.1` | Yes | It forces a major that 10.1.7 never declared (`glob ^13`). That is an untested combination, which upstream solved properly in 10.1.9. Rejected. |
| C | Override `glob` → `13.0.7` (backport) | **No** | The advisory range still covers 13.0.7, and minimatch stays at 10.x. Rejected. |

## Recommendation: option A

Bump `@fastify/static` in `apps/server/package.json` to `^10.1.10` and regenerate the lockfile. **Add no override.** The card allows an override only when no parent release pulls a patched version, and one does. `pnpm-workspace.yaml` stays unchanged, with all six existing overrides untouched.

Note for the card text: this repository keeps its pnpm overrides in `pnpm-workspace.yaml` (block `overrides:`, added in `648b0e2c`), not in the root `package.json`. If the fallback below is ever needed, add the entries there and nowhere else.

### Fallback (only if option A fails, e.g. pnpm refuses the release age or a test breaks for a reason in `@fastify/static` itself)

Add these two entries to the existing `overrides:` block in `pnpm-workspace.yaml`. Replace nothing and keep the comment above the block:

```yaml
  # Dependabot #22, GHSA-3g3m-2fjr-6pw4
  'glob@>=9.0.0 <14.0.2': '^14.0.2'
  # Dependabot #23, GHSA-g3hv-75wg-m249
  'minimatch@>=7.0.0 <11.0.1': '^11.0.1'
```

If you take the fallback, list it in the PR description and tell the owner on the card. Do not add it "just in case" next to option A.

## Design

### Files to change

| File | Change |
|---|---|
| `apps/server/package.json` | `"@fastify/static": "^10.1.7"` → `"^10.1.10"` (line 38). Nothing else. |
| `pnpm-lock.yaml` | Regenerated by `pnpm install` with pnpm 12.8.1. The diff should touch only the `@fastify/static` subtree: `@fastify/static`, `@fastify/send`, `glob`, `minimatch`, `path-scurry` (2 → 3) and its `lru-cache` if it changes, `brace-expansion` if it changes, and the new `@isaacs/nonrecursive-glob-match`. `lockfileVersion: '9.0'` and `packageManagerDependencies.pnpm 12.8.1` stay as they are. |
| `apps/server/test/serve-web.test.ts` | Regression test (standing order "Likely regression"). In `beforeAll`, also create a nested file such as `assets/app-abc123.js`, and assert that `GET /assets/app-abc123.js` returns its body. The current test only has top-level files, while the real `dist` serves hashed files from `/assets/*`, and that nested walk is exactly the glob 14 path. Optionally also assert that a dot file (`.hidden`) is **not** served (the `dot` default is unchanged). |

No application source change is expected.

### Steps for the builder

1. **Before**: run `pnpm why minimatch -r` and `pnpm why glob -r` and save the output for the card. Expected: glob 13.0.6 and minimatch 10.2.6, via `@fastify/static` 10.1.7.
2. Edit the one specifier and run `pnpm install` **without** `--frozen-lockfile`. Do not run `pnpm update` and do not use `--latest`. Downloads need the registry. Per the ledger decision of 2026-11-03, running `pnpm install` outside the sandbox is authorised, so ask through `aom devops` if the sandbox has no DNS. Check `git diff --stat pnpm-lock.yaml` and confirm that only the subtree above moved. If unrelated packages changed, revert and redo with `pnpm install --filter @aom/server`.
3. **After**: `pnpm install --frozen-lockfile` succeeds. `pnpm why glob -r` and `pnpm why minimatch -r` show only glob ≥ 14.0.2 and minimatch ≥ 11.0.1. `grep -E "^  (glob|minimatch)@" pnpm-lock.yaml` shows one entry each. `pnpm audit` shows no glob or minimatch advisory (audit needs the network, so run it the same way as the install).
4. `pnpm -r --if-present build`, `pnpm -r --if-present typecheck` and `pnpm lint`.
5. Unit tests: `pnpm --filter @aom/shared test`, `pnpm --filter @aom/web test` and `pnpm --filter @aom/runner test`, with a hang limit (`timeout`).
   - The `apps/server` suite, **including `serve-web.test.ts`**, needs Postgres (`DATABASE_URL`). That makes it integration in this sandbox, so leave it to the testers/DevOps and name it in the handoff. If a DB is reachable, run it.
6. Smoke test (glob crossed a major in a runtime package, so test plan item 4 applies): build the web app, start the server with `AOM_SERVE_WEB=true` pointing at `apps/web/dist`, and check that `/`, a hashed `/assets/*.js` file and `/sw.js` return 200 with the expected content types. If the sandbox cannot start the server, ask DevOps to run it and record the result.

### PR description / completion notes (AC 4)

| Package | Parent | Old | New | Runtime/dev |
|---|---|---|---|---|
| `@fastify/static` | apps/server (direct) | 10.1.7 | 10.1.10 | runtime |
| `glob` | `@fastify/static` | 13.0.6 | 14.0.x (actual from lockfile) | runtime |
| `minimatch` | `glob` | 10.2.6 | 11.0.x (actual) | runtime |
| `@fastify/send` | `@fastify/static` | 4.1.1 | 4.2.x (actual) | runtime (side effect of the bump) |
| `path-scurry` | `glob` | 2.0.2 | 3.x (actual) | runtime (side effect) |

Overrides added: none (or list the fallback entries if they were used).
Also attach the before/after `pnpm why` output and the test summary.

## Risks

- **R1: matching edge cases in minimatch 11 / glob 14.** The pattern `@fastify/static` uses walks every file under `root`. Two cases could change what gets served: a file with Unicode in its name (the new `normalize` option is off by default) and dot files. Both are covered by the extended `serve-web` test and the smoke test. Vite's `dist` uses ASCII hashed names.
- **R2: `@fastify/send` 4.1.1 → 4.2.x** comes with the bump (minor, same major). It handles the response headers (cache-control, ETag, ranges). The existing `onSend` hook in `app.ts:639` overrides cache-control for `/sw.js`, `/manifest.webmanifest` and `/offline.html`, and the `serve-web` and `push`/`landing` tests exercise that path. Watch for header differences there.
- **R3: release age.** If pnpm refuses a version as too new, do **not** add it to `minimumReleaseAgeExclude` on your own, because that weakens a supply-chain guard. Wait for the age to pass or ask the owner.
- **R4: the alert closing (AC 6).** This depends on the lockfile on the default branch no longer matching the advisory ranges. Option A meets that. The owner or DevOps checks it after the merge.
- **Branch.** The card brief mentions `release/1.6.0`. The project's working branch is `main` and this card branch was cut from it, so build on the card branch as it is.

## Acceptance criteria → design

| AC | How it is met |
|---|---|
| Lockfile resolves no glob/minimatch in the vulnerable ranges | Option A resolves glob ≥14.0.2 and minimatch ≥11.0.1, with one resolution each (step 3) |
| `pnpm audit` reports no glob/minimatch advisory | Step 3, run with network access |
| Every override is scoped, commented, listed | None needed. The fallback entries are pre-scoped and commented, if ever used |
| PR lists parent, old/new version, runtime/dev per resolution | Table above, filled with the actual lockfile versions |
| Frozen install, build of every package, tests with no new failures | Steps 3 to 5. The server suite (DB) and e2e are left to testers/DevOps and named in the handoff |
| Alerts #22/#23 close after merge | Owner/DevOps check on GitHub (R4) |

## Sources

- https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 (glob, alert #22)
- https://github.com/advisories/GHSA-g3hv-75wg-m249 (minimatch, alert #23)
- https://github.com/isaacs/node-glob/blob/main/changelog.md, https://github.com/isaacs/minimatch/blob/main/changelog.md
- https://registry.npmjs.org/@fastify/static, /glob, /minimatch (version manifests and publish times)
