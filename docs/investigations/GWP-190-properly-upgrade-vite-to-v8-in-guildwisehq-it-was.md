# Finishing the vite 8 upgrade (and jsdom 31)

## Question

Vite 8 came in through a dependency bump that was rebased by hand. The lockfile was regenerated and resolves vite 8.3.7, while the bump named 8.3.6. jsdom 31 landed in the same window, and CI on main failed after both bumps. Commit `612534f4` ("repair CI after the dependency bumps") fixed the execa 10, @dicebear/core, pdf-parse and Biome fallout, but none of the vite, vitest or jsdom wiring. What does it take to finish the upgrade properly: one deliberate vite version, a clean lockfile, no deprecated config, green CI and verified builds?

## Findings

### 1. Versions as they stand (HEAD `612534f4`)

| Package | Declared | Resolved in `pnpm-lock.yaml` | Peer range for vite | OK on vite 8? |
|---|---|---|---|---|
| vite | `apps/web`: `^8.3.6` (only declaration) | `8.3.7` (one copy) | n/a | yes |
| vitest | root: `^4.1.12` | `4.1.12`, **two snapshots** (see 2) | dep and peer `^6 \|\| ^7 \|\| ^8` | yes, no bump needed |
| @vitejs/plugin-react | `apps/web`: `^6.2.1` | `6.2.1` | `^8.0.0` (other peers optional) | yes, no bump needed |
| @tailwindcss/vite | `apps/web`: `^4.3.5` | `4.3.5` | `^5.2.0 \|\| ^6 \|\| ^7 \|\| ^8` | yes, no bump needed |
| jsdom | `apps/web`: `^31.0.0` | **`30.1.1` and `31.0.0`** | n/a | see 3 |

- The lockfile has a single `vite@8.3.7` entry and no vite 5, 6 or 7 copies. `rolldown@1.2.18` and `lightningcss@1.33.0` are vite 8's own dependencies.
- The vitest configs in `apps/runner`, `apps/server`, `packages/shared` and `packages/video` (that last one is not in the card's list, but it is a workspace with a `test` script) import `vitest/config` and run on the root `vitest`, which gets vite through its own dependency. None of these workspaces declares vite.
- Vite releases: 8.3.6 on 2026-11-05, 8.3.7 on 2026-11-09, 8.3.8 on 2026-11-11 (today; inside pnpm's minimum-release-age window). I diffed the 8.3.6 and 8.3.7 tarballs. The only changes are the `rolldown` range (`~1.2.16` to `~1.2.18`), the version string, and `new Array(n)` replaced by `Array.from({length:n})` in the HMR/import analysis. No config or API changes.
- Engines: vite 8 needs Node `^20.19 || >=22.12`, and jsdom 31 needs `^22.22.2 || ^24.15 || >=26`. `.nvmrc` is `22.23` (CI), the Docker build stage is `node:26.13`, and root `engines` is `>=22.23`. Nothing to change.

### 2. The lockfile defect: two vitest snapshots and two jsdom majors

```
importers['.'].vitest -> vitest@4.1.12(...)(jsdom@30.1.1)(vite@8.3.7...)          # root, not optional
apps/web @testing-library/jest-dom -> vitest@4.1.12(...)(jsdom@31.0.0)(msw@3.0.4)(vite@8.3.7)   # optional: true
```

- `apps/web` runs `vitest run` but does not declare `vitest`. pnpm resolves the binary and `vitest/config` (imported in `apps/web/vite.config.ts`) from the root importer, and that is the snapshot wired to **jsdom 30.1.1**. jsdom 30 has no reason to be in the tree: nothing declares it. It survived the hand regeneration as a stale optional-peer resolution.
- Result: the web unit tests most likely still run on jsdom 30, even though `package.json` says 31. Meanwhile `@testing-library/jest-dom/vitest` (from `src/test/setup.ts`) imports a *second* vitest instance, the jsdom 31 snapshot. Two vitest module copies in one run are fragile: matcher registration and the runner state are shared only through globals. This is the most likely structural reason the web suite went red after the bumps. It cannot be confirmed here: the design sandbox cannot run `pnpm install` because the shared store is read-only.
- A plain "regenerate" does not fix this on its own. Once the root vitest no longer pins jsdom, vitest `import('jsdom')` would find jsdom only through pnpm's hidden hoist (`node_modules/.pnpm/node_modules`). That is non-deterministic as soon as two jsdoms exist.

**Fix:** declare `vitest` in `apps/web` devDependencies with the same spec as the root. pnpm then gives `apps/web` its own vitest snapshot whose optional `jsdom` peer is the workspace's direct `jsdom@31`, and jest-dom gets the same snapshot. The root snapshot drops jsdom, and `jsdom@30.1.1` leaves the lockfile. Declaring a dev tool where it is used is not an upgrade, so it is inside the card's constraint.

### 3. jsdom 31 breaking changes and where they touch us

jsdom 31.0.0 release notes:
1. The canvas backend moved from `canvas` to `@napi-rs/canvas` (an optional peer). We install neither, so `getContext('2d')` returns `null` exactly as before. Our call sites are `lib/avatarImage.ts`, `lib/screenshot.ts`, `lib/qr.ts` and `components/profile/CameraCapture.tsx`, and their tests already stub or tolerate the missing canvas.
2. A new CSS engine (cascade, nesting, computed styles). Vitest runs with `css: false`, and the only `getComputedStyle` reads are `Composer.tsx` `lineHeight` (it falls back to 24 when the value is not numeric) and `screenshot.ts` `backgroundColor` (falls back to `#ffffff`). Low risk, but `toHaveStyle`/`toBeVisible` assertions should be watched.
3. Parsing pauses at blocking scripts, so `new JSDOM()` can return a partial document. Vitest's jsdom environment builds an empty document, so this does not affect us.
4. Focus changes: focus moves off elements that become non-focusable, and `document.hasFocus()` is more accurate. Six `toHaveFocus` assertions exist. If any fails, it is a behaviour difference to investigate, not a test to loosen.
5. `load` fires only on window, not on document. `lib/pwa.ts` checks `document.readyState` and then listens on window. Unaffected.

**Recommendation:** stay on jsdom 31. Fall back to `^30.1.3` (the last 30.x) only if a web test fails *because of* a jsdom 31 behaviour change that cannot be fixed in the test setup without weakening it. Record the failing test and the reason in the changelog note.

### 4. vite 8 config audit (`apps/web/vite.config.ts` and helpers)

Checked against the vite 8.3.7 `dist/node` source and types:

| Item | Status in vite 8 | Action |
|---|---|---|
| `build.rollupOptions.input` | Typed `@deprecated Use rolldownOptions instead`. At runtime it is silently aliased (`setupRollupOptionCompat`); only `optimizeDeps.rollupOptions` prints a console warning. | **Rename to `build.rolldownOptions`.** Same shape (`input: { main, form }`). |
| `transformIndexHtml: (html) => string` (brandHtml) | Plain function form is still supported. | none |
| `configureServer` + `server.middlewares.use` (publicFormDev) | Connect middlewares unchanged. | none |
| `transform` hook with `enforce: 'pre'` on `src/index.css` (extensionSources) | Runs before `@tailwindcss/vite` (plugin order unchanged). | none, but verify with `AOM_WEB_EXTENSION` set (see test plan) |
| `server.proxy` entries (`target`, `changeOrigin`, `ws`, `headers`, regex key `^/blog(/\|$)`) | Same options on vite 8's http-proxy-3. | none |
| `define: { __APP_VERSION__ }` | Unchanged. | none |
| `loadEnv(mode, webRoot, ['API_PROXY_TARGET'])` | Unchanged signature. | none |
| `resolve.alias` object form | Unchanged; no `customResolver` used (that one warns). | none |
| `defineConfig` from `vitest/config` + `test` block | vitest 4.1 supports vite 8. | none |
| No `esbuild`, `optimizeDeps.esbuildOptions`, `polyfillModulePreload`, `envFile`, `server.hmr.*` | These are the options vite 8 warns about; none are used. | none |

`apps/runner`, `apps/server`, `packages/shared` and `packages/video` `vitest.config.ts` use only `test.*` options (`include`, `globalSetup`, `setupFiles`, `env`, timeouts, `fileParallelism`). Nothing in them is deprecated on vitest 4.1 or vite 8. No change is needed beyond running them.

`src/proxy-target.ts` and `src/brand.ts` are plain TS with no vite API. `src/test/proxy-target.test.ts` covers `resolveProxyTarget`, and no change is needed.

### 5. CI and E2E

- `.github/workflows/ci.yml` runs on every PR: `boundary`, `checks` (`pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm lint`), `shared-web` (shared and web tests), `runner` and `server` (Postgres 18 and Mailpit services). `codeql.yml` and `dco.yml` also run. **CI does not run Playwright.** The E2E suites (`e2e/playwright.config.ts` and `e2e/playwright.environments-msw.config.ts`, whose `webServer` is `pnpm --filter @aom/web exec vite --host 127.0.0.1 --port … --strictPort`, a vite 8 dev server) have to be run by DevOps or the testers. No workflow command needs to change for vite 8.
- DCO: commits need a `Signed-off-by` line if the dco workflow enforces it on this repo. The builder should check that the previous commits on main carry one and match them.

### 6. Cross-repository note (guildwise-cloud, out of scope)

guildwise-cloud's `web/vite.landing.config.ts` imports only `@aom/web/brand.ts` (unchanged) and runs its own vite `^7.3.6`, jsdom `^30.1.1` and `build.rollupOptions`. Its `core/` copy of this repository builds `apps/web` from core's own lockfile, so it will pick up vite 8 together with `rolldownOptions` when core is bumped. Risk: if anything ever built this `apps/web/vite.config.ts` with vite 7, `build.rolldownOptions` would be ignored and `form.html` would silently drop out of the build. That is not the case today, but the manager should know when opening the guildwise-cloud vite 8 card. **The builder should post this on the card** (as the constraint asks) rather than change guildwise-cloud.

## Options compared

### Version: 8.3.6 or 8.3.7

| | 8.3.6 | 8.3.7 (recommended) |
|---|---|---|
| What the lockfile has today | no | yes |
| Difference | n/a | rolldown `~1.2.18` (bug fixes) plus a cosmetic array change; no API change |
| Lockfile churn to reach it | downgrade vite and rolldown | none |
| Age | 6 days | 2 days, past pnpm's minimum release age |

8.3.8 is out today but sits inside the minimum release age and is unvetted. Leave it to Dependabot.

### How to declare it

- **A. Caret in apps/web only (as today).** Does not meet "declared the same way in every workspace", and a fresh resolve could pick a different patch for vitest's own `vite` dependency.
- **B. Exact pin `"vite": "8.3.7"` in `apps/web` and in root `devDependencies`** (the root hosts the vitest that drives runner, server, shared and video). Recommended. Both declarations are identical, pnpm dedupes vitest's `vite` dependency onto the directly declared 8.3.7, and Dependabot still raises bumps (it updates both files in one PR).
- **C. B plus a pnpm `overrides: { vite: 8.3.7 }`.** Strongest guarantee, but every later vite bump then needs the override edited too. Use it only if the regenerated lockfile still shows a second vite after B.

### jsdom

- **Keep 31** (recommended), with the vitest declaration fix from finding 2 so tests really run on 31.
- **Pin `^30.1.3`.** Only as a fallback, with the failing test named.

## Recommendation and design

### Files to change

1. **`package.json` (root):** add `"vite": "8.3.7"` to `devDependencies`. Keep `vitest` `^4.1.12` (supports vite 8, no bump).
2. **`apps/web/package.json`:**
   - `"vite": "^8.3.6"` becomes `"vite": "8.3.7"`.
   - add `"vitest": "^4.1.12"` to `devDependencies` (same spec as the root).
   - keep `"jsdom": "^31.0.0"`, `"@vitejs/plugin-react": "^6.2.1"` and `"@tailwindcss/vite": "^4.3.5"` (all accept vite 8, no bump).
3. **`pnpm-lock.yaml`:** regenerate once with pnpm 12.8.1 (`packageManager`), using `pnpm install` (not `pnpm update`, which would drag unrelated packages forward). Never hand-edit. Expected result:
   - exactly one `vite@8.3.7` in `packages:`, with no `vite@5/6/7`;
   - no `jsdom@30.1.1` anywhere; only `jsdom@31.0.0`;
   - the `apps/web` importer lists `vitest` with a snapshot that carries `(jsdom@31.0.0)`;
   - no unrelated version changes in the diff (review it; anything else moving is a reason to redo the install, not to accept it).
   If a second vite or jsdom survives, apply option C (`overrides`) for that one package and say so in the note. If the stale entries stay put, `pnpm dedupe` is allowed.
   **Sandbox trap:** the builder's sandbox cannot write the shared pnpm store (`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`, read-only file system). Ask DevOps (`aom devops`) to run the install in the card worktree and to provide an installed toolchain for the test runs. Do not install SDKs or change the store.
4. **`apps/web/vite.config.ts`:** `build: { rollupOptions: { input } }` becomes `build: { rolldownOptions: { input } }`. Nothing else.
   ```ts
   build: {
     rolldownOptions: {
       input: { main: resolve(webRoot, 'index.html'), form: resolve(webRoot, 'form.html') },
     },
   },
   ```
5. **Tests:** add a small test that pins the two things this card relies on, so a later bump cannot silently undo them. For example, `apps/web/src/test/test-env.test.ts`:
   - `navigator.userAgent` contains `jsdom/31.` (proves the suite runs on the declared jsdom major; it fails today if the analysis in finding 2 is right);
   - optional: import the config (`../../vite.config.ts`, call it with `{ mode: 'production', command: 'build' }`) and assert `build.rolldownOptions.input` has `main` and `form` and `build.rollupOptions` is not set in the source object. If evaluating the config in the test is awkward (it shells out to git), keep only the jsdom assertion and cover the inputs with the build check below.
6. **`CHANGELOG.md`, `[Unreleased]`:** add a `### Changed` entry (the file is copied into the app's release notes, so keep it short and factual). Suggested text:
   > Build tooling: vite 8.3.7 (pinned; chosen over 8.3.6 because it is what the lockfile already resolved and differs only by a newer bundled rolldown) and jsdom 31 for the web unit tests. `build.rollupOptions` is now `build.rolldownOptions`; the web tests now run on the vitest and jsdom the web package declares (a stale jsdom 30 copy was removed from the lockfile). @vitejs/plugin-react 6.2.1, @tailwindcss/vite 4.3.5 and vitest 4.1.12 already support vite 8 and are unchanged. Deferred: vite 8.3.8; guildwise-cloud's own vite 7 setup.

   Put the same list in the handoff note, so the PR the runner opens carries it.

### Data model and API

None. There is no runtime or user-visible change: the built `index.html` and `form.html`, the brand substitution and `__APP_VERSION__` stay as they are.

### Risks

| Risk | Mitigation |
|---|---|
| The web suite fails on jsdom 31 once it really runs on it (finding 2) | Investigate each failure. Fix setup or code if jsdom 31 is right; otherwise fall back to `jsdom ^30.1.3` and record why. Never skip or loosen. |
| Lockfile regen moves unrelated packages | Use `pnpm install` only and review the lockfile diff. The existing `overrides` and `minimumReleaseAge` stay as they are. |
| `rolldownOptions` ignored by a vite 7 consumer | Only guildwise-cloud could be one; not today. Post it on the card. |
| Server and runner suites need Postgres, bubblewrap and so on | Those are integration-style. Leave them to CI and DevOps and name them in the handoff. |
| DCO check | Match main's sign-off convention. |

### Acceptance criteria to design

| AC | Covered by |
|---|---|
| Same vite 8.x declared in every workspace, version and reason stated | Files 1 and 2 (`8.3.7` exact in root and `apps/web`), changelog note (6) and handoff |
| One vite in the lockfile, frozen install from a fresh checkout | File 3; verify with `pnpm install --frozen-lockfile` on a clean checkout (DevOps) and `grep -c "^  vite@" pnpm-lock.yaml` = 1 |
| plugin-react, tailwind vite and vitest accept vite 8, no peer warnings | Finding 1 (peer ranges checked); install log shows no `vite` peer warning |
| jsdom 31 with the suites passing, or pinned with a reason | Finding 3 and the vitest declaration fix; jsdom UA test (5) |
| Production build exit 0, no deprecation warnings, brand HTML and version correct | File 4; `pnpm --filter @aom/web build`, then grep `dist/index.html` for no `%BRAND_` placeholders, check `dist/form.html` exists and the bundle contains `0.0.0+<sha>` |
| Dev server proxies to the resolved target; publicFormDev serves `/f/<id>` | No code change; `proxy-target.test.ts`; manual dev check with `API_PROXY_TARGET` set; `curl localhost:5173/f/abc` returns the form page |
| All unit suites pass, no skips or deletions vs main before #11 | Run shared, web and video locally; runner and server in CI. Compare test counts with `693e8860^` (`596be168`) |
| Full Playwright suite passes against a vite 8 build | DevOps/testers run both configs; any failure is compared on `596be168` and gets a bug card if it fails there too |
| Every CI workflow green | ci.yml, codeql and dco on the PR |
| Deployed check | DevOps after merge, per docs/DEPLOY.md; deployed commit and URL recorded on the card |
| Changelog note | File 6 |

### Verification commands (for the builder or DevOps)

- `pnpm install --frozen-lockfile` (clean checkout); `pnpm why vite`; `pnpm why jsdom`
- `pnpm --filter @aom/shared test`, `pnpm --filter @aom/web test`, `pnpm --filter @aom/video test` (with `timeout`)
- `pnpm -r --if-present typecheck` and `pnpm lint`
- `pnpm --filter @aom/web build 2>&1 | grep -i deprecat` (must be empty); also once with `AOM_WEB_EXTENSION` pointing at a sample module, to see the extension's Tailwind classes generated
- Left for CI and testers: `@aom/runner` and `@aom/server` suites (need bubblewrap and Postgres) and both Playwright configs.
