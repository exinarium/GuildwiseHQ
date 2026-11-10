# GWP-186: runner tests time out and leave Playwright browsers in the temp data dir

## Question

Since 1.6.0 the `Runner tests` CI job fails on main and on every dependabot PR:

1. `test/runner-v3-units.test.ts` > role smoke test > "every built-in role goes down its handoff path" times out at 120 s.
2. Eight files (architect-shift, handoff-checks, owner-turn-gating, runs-shift, test-environment, devops-setup,
   shift-limit, supervisor) fail in `afterAll` with `ENOTEMPTY` on `aom-data-*/browsers/chromium_headless_shell-*`.
3. `test/attachments.test.ts:646` finds `screen.png` still there after the shift (seen on main only).

What is the shared cause, and what is the fix that stops the races instead of hiding them?

Out of scope: the kill-grace usage failure in `test/runner-v3.test.ts` (GWP-187), guildwise-cloud `@fastify/static`
(GWP-188), and `forms-offline-flow.test.ts:468`.

## Findings

### F1. Every `Runner.start()` starts a real Chromium download into `<dataDir>/browsers`. Introduced in 1.6.0.

- `src/runner.ts:1201` `start()` calls `this.repairPdfRenderer()` with no condition.
- `repairPdfRenderer()` (`src/runner.ts:1284-1293`) calls `this.pdf.status()`. If no browser is found, it calls
  `this.pdf.install({ withDeps: false })` as fire-and-forget (`void (async () => ...)()`). Nothing keeps a handle to it.
- `chromiumPdfRenderer.install` (`src/storage/pdf.ts:246-258`) runs
  `node <playwright-core>/cli.js install --only-shell chromium` through execa with
  `PLAYWRIGHT_BROWSERS_PATH=<dataDir>/browsers`. It passes no cancel signal.
- playwright-core 1.63 does the download in a forked grandchild (`entry/oopBrowserDownload.js`). That grandchild
  downloads the zip into `os.tmpdir()` and extracts it into `<browsers>/chromium_headless_shell-<rev>/`. It exits on
  `disconnect`, so it ends when the `cli.js` parent is killed (checked in
  `playwright-core/lib/coreBundle.js`, `downloadBrowserWithProgressBarOutOfProcess` / `runOopDownloadBrowserMain`).
- `Runner.stop()` (`src/runner.ts:1268-1281`) calls `this.pdf.close()`. That closes a launched browser only. The
  install keeps running.
- Every other "reaches out" job at start is turned off under tests with the same pattern:
  `opts.X ?? !(mock enabled || process.env.VITEST)`. Examples: `roleSmokeOnce` at 1175, `integrationsReport` at 988,
  `mcpReport` at 1624/1645, `gitReport` at 1685. The PDF repair was added in **GWP-142 (fb0a61cc, 2026-11-08)** without
  that gate. `git log v1.5.0..v1.6.0` lists this commit, so the trigger arrived with 1.6.0.

Under vitest, a fresh temp data dir never holds a browser. About 58 test files start a Runner, many of them once per
test (shift-limit alone has 22 `startHarness`/`new Runner` sites). So on CI, every start launches a ~100 MB
chrome-headless-shell download plus its extraction.

- No test awaits these installs or cancels them.
- The test temp-root cleanup does not kill them. `test/tmp-root.ts` `procsUnder` matches on the command line, and the
  browsers path is only in the environment, not in the command line.
- So they pile up across the run. Commit 3e2c984d already lists "Playwright downloads" among the leftovers in the temp
  dir.
- Locally in a sandbox with no network the install fails at once. That is why the problem shows on CI (which has
  network) and on every PR, and not on a developer's sandboxed run.

**ENOTEMPTY (req. 2) follows directly.** `afterAll` → `cleanupTmp` (`test/helpers.ts:22`) and `setup-git.ts` `removeTree`
remove `aom-data-*` while the grandchild is still extracting into `browsers/chromium_headless_shell-*`. The extractor
keeps creating entries, so `rmdir` sees a non-empty dir even after 8 retries.

### F2. Role smoke timeout (req. 1): same trigger, through load. The smoke path itself is unchanged.

- `runRoleSmoke` (`src/health/role-smoke.ts`) runs 8 built-in roles one after another. For each role it runs
  `ensureSandbox` (mkdir and small writes), `settingsProblem` (pure), `ipc.registerShift`, then one run of the
  `bin/aom` shim.
- From source, the shim is `node tsx/dist/cli.mjs src/aom/aom-cli.ts` (`src/shims.ts` `selfCommand`). `sandboxEnv`
  gives every role a fresh `TMPDIR`, and role-smoke removes it afterwards. tsx keeps its transform cache under
  `os.tmpdir()`, so **every role compiles aom-cli.ts and its large import graph from scratch**. That costs a few seconds
  per role on an idle machine. Production uses the bundled `aom.mjs` and does not pay it.
- Between v1.5.0 and v1.6.0 nothing on this path changed in a way that adds waiting:
  - `src/aom/aom-cli.ts` only lost the `release-changelog` verbs.
  - `sandbox.ts` gained the `.aom-owner` write and `removeOrphanAgentTmps`, which is scoped to this runner's agents
    folder.
  - `src/ipc` and `src/health` have no runner changes.
  - No IPC call in the smoke waits on a lock, the network or the install.
- What did change is the CPU, disk and network load on the 4-vCPU CI machine. Every harness in the same worker and in
  the parallel workers adds a playwright-core download and extract process, and none of them is ever stopped. A
  CPU-bound tsx compile run 8 times in a row is exactly what slows down past a fixed 120 s budget under that load. The
  test harness in this file also starts its own install (F1) right next to the smoke.

So the timeout has the same root cause as F1. I could not reproduce it in this sandbox, because the pnpm store is
read-only (no `node_modules` in a copy) and there is no network for the download. **The builder must measure it** (see
the plan, step 5). If the smoke still takes more than about 60 s on CI once F1 is fixed, a second fix is listed there.

### F3. `screen.png` left behind (req. 3): `shift.ended` is sent before the shift's temp cleanup runs.

- `ShiftSupervisor.run()` sends `shift.ended` at `src/shifts/supervisor.ts:1861`.
- The agent temp cleanup (`cleanAgentTmp(shift.sandbox.tmp)`, which removes `card-attachments/`) runs later, in
  `handleStart`'s `finally` (`supervisor.ts:688-698`), after `run()` returns. Before it, the same block runs
  read-only-checkout and prep-worktree removal and `releaseWorktree`.
- `startHarness().runShift` resolves on `shift.ended`. The test then asserts at once
  `existsSync(card-attachments/screen.png) === false` (attachments.test.ts:646).
- On an idle machine the `finally` usually wins. Under the F1 load it often loses, which is why it was seen on main
  only.
- Read-only is not the problem. `syncCardAttachments` (`src/attachments/index.ts:255-271`) makes the dir 0755 and the
  files 0444, and on POSIX unlinking a file needs write permission on the dir, not on the file. `cleanAgentTmp` can
  delete them.

The same gap exists at shutdown:

- `Runner.stop()` → `supervisor.stopAll()` awaits `handleStop`.
- `handleStart`'s `finally` (`cleanAgentTmp`, `pruneScratch`) can still be running when `stop()` returns.
- The comment in `cleanupTmp` ("a shift that is still wrapping up may write into its directory while it is removed")
  describes this race. Today it is hidden by the retries.

### Root cause, in short (for the card)

1.6.0 (GWP-142, fb0a61cc) added `repairPdfRenderer()` to `Runner.start()`. Unlike every other outbound start-up job,
it is not turned off under tests. Nobody can await or cancel it: the install is fire-and-forget, gets no cancel signal,
and `stop()` does not touch it. Every test that starts a Runner therefore downloads and extracts Chromium into its temp
data dir.

- These installs outlive their tests and race the `afterAll` removal, which gives the ENOTEMPTY failures.
- Together they load the CI machine. That turns two latent timing gaps into failures:
  - the role smoke, which runs tsx 8 times with no cache, against its 120 s budget;
  - the attachments assertion, which runs right after `shift.ended` while the temp cleanup comes after that message.

## Options

| | Option | Stops the race | Production unchanged | Notes |
|---|---|---|---|---|
| A | Gate `repairPdfRenderer` like the others: `opts.pdfRepair ?? !process.env.VITEST` | Yes, for tests | Yes | Leave the mock runtime **out** of the gate (unlike the other jobs). Mock-runtime runners (CI e2e, demos) then keep fetching the browser exactly as today. |
| B | Make the install cancellable and awaited: an `AbortSignal` through `PdfRenderer.install`, then `stop()` aborts and awaits it | Yes, also in production | Yes (stop only) | Fixes a real defect: a stop or self-update restart leaves an orphan installer writing into `<dataDir>/browsers` while the new process starts a second one. Meets AC3's "cancelled before removal" for any test that turns the repair on. |
| C | Inject a fake `PdfRenderer` from the harness only | Yes, for harness tests | Yes | Misses every test that does `new Runner(...)` directly (most of the 58 files). |
| D | Kill installs in test teardown (`procsUnder` on env) | Partly | Yes | Treats the symptom. Card forbids hiding the race in cleanup. |
| E | Raise timeouts or swallow ENOTEMPTY | No | Yes | Forbidden by the card. |

For F3:

| | Option | Notes |
|---|---|---|
| F | Supervisor tracks each `handleStart` until its `finally` is done. It exposes `whenSettled(shiftId)` and `settledAll()`. `runShift` in the harness awaits `whenSettled`, and `Runner.stop()` awaits `settledAll()` with a time limit. | Deterministic. Also closes the shutdown gap. Small production change: `stop()` now waits for the cleanup it already started. |
| G | Send `shift.ended` after the cleanup | Changes the order of server events and adds the cleanup time to every shift end. GWP-187 works in that same area. Rejected. |
| H | `waitUntil(!existsSync(...))` in the test | A poll instead of a signal. Fixes only one test. Rejected. |

## Recommendation

Build **A + B + F**. Measure the role smoke after A. Add the step 5 fallback only if the measurement calls for it.

## Design

### 1. `src/runner.ts`: gate, track and cancel the PDF repair

- `RunnerOptions` gains these options, written in the style of `roleSmoke` (which is at around line 285):
  ```ts
  /** Fetch the PDF renderer's browser in the background at start when it is missing. Default on, off under tests. */
  pdfRepair?: boolean;
  /** Test seam: the PDF renderer (default: chromiumPdfRenderer under <data dir>/browsers). */
  pdfRenderer?: PdfRenderer;
  ```
- Constructor (around line 566): `this.pdf = opts.pdfRenderer ?? chromiumPdfRenderer({ browsersPath: ... })`.
- `repairPdfRenderer()`:
  ```ts
  private pdfRepair?: { abort: AbortController; done: Promise<void> };
  private repairPdfRenderer(): void {
    if (!(this.opts.pdfRepair ?? !process.env.VITEST)) return;   // NOT gated on the mock runtime (e2e/demos keep it)
    const abort = new AbortController();
    const done = (async () => {
      if ((await this.pdf.status()).ready || abort.signal.aborted) return;
      this.log.info('pdf renderer: browser missing, installing in the background');
      await this.pdf.install({ withDeps: false, log: () => undefined, signal: abort.signal });
      this.log.info('pdf renderer: browser installed');
    })().catch(() => {
      if (!abort.signal.aborted)
        this.log.warn('pdf renderer: background install failed (run `guildwise-runner pdf-renderer install`)');
    });
    this.pdfRepair = { abort, done };
  }
  ```
- `stop()`: before `await this.pdf.close()`, add
  `this.pdfRepair?.abort.abort(); await this.pdfRepair?.done;`. Then `stop()` returns only after the install process
  has exited. The execa force-kill delay bounds the wait.

### 2. `src/storage/pdf.ts`: `install` takes a cancel signal

- `PdfRenderer.install(opts: { withDeps; log; signal?: AbortSignal })`.
- In `run`: `execa(process.execPath, [cli, ...args], { env, reject: false, all: true, cancelSignal: opts.signal, forceKillAfterDelay: 2000 })`.
  This is execa 9 (`package.json` has `^9.0.0`).
- After a cancelled run, throw `PdfError('pdf_failed')` and do not start the second `install` step. Check
  `signal?.aborted` before each `run`.
- Killing `cli.js` also ends playwright's download grandchild: it exits on IPC `disconnect`.
- Optional test seam: `ChromiumPdfOptions.cli?: string`, the path of the cli to run instead of `playwrightCli()`. With
  it a test can prove that an abort kills a long-running fake cli.
- Callers of `install`: the `pdf-renderer install` CLI command (grep `pdf.install` / `.install({ withDeps`) and the
  fake in `test/storage-service-pdf.test.ts:29`. Both keep working, because `signal` is optional.

### 3. `src/shifts/supervisor.ts`: know when a shift is fully done

```ts
private readonly settling = new Map<string, Promise<void>>();
/** Resolves when the shift's handleStart (incl. its temp cleanup) has returned; at once for an unknown id. */
whenSettled(shiftId: string): Promise<void> { return this.settling.get(shiftId) ?? Promise.resolve(); }
async settledAll(): Promise<void> { await Promise.all([...this.settling.values()]); }
```

- In `handleStart`, after the redelivery check, wrap the existing body:
  `const p = this.startInner(msg, resume); this.settling.set(id, p); try { await p } finally { if (this.settling.get(id) === p) this.settling.delete(id) }`.
  Or set and delete the map entry inside the existing try/finally. What matters is that the promise resolves only after
  `cleanAgentTmp` and `pruneScratch`.
- Early rejections that return before `this.active.set` need no entry.
- `Runner.stop()`: after `await this.supervisor.stopAll('manager')`, add
  `await Promise.race([this.supervisor.settledAll(), delay(this.opts.exitGraceMs ?? 10_000)])` so that a stuck cleanup
  can never hang a stop.
- GWP-187, in the same group, works on the grace timer in `handleStop`. Keep this change separate from that logic.

### 4. Tests (harness and files)

- `test/harness.ts` `runShift`: after `server.waitFor('shift.ended', ...)`, add
  `await runner.supervisor.whenSettled(shiftId)`. That fixes attachments:646 without touching its assertion.
- Do not change `test/helpers.ts` `cleanupTmp`. It keeps its retries. It no longer needs them for the browsers dir.
- New tests:
  - **runner-pdf-repair.test.ts** (new file), with a fake `pdfRenderer`:
    - Under VITEST, a default Runner start calls neither `status` nor `install`.
    - With `pdfRepair: true` and `status → {ready:false}`, `install` is called once with an `AbortSignal`.
    - With `install` pending until abort, `stop()` aborts the signal and resolves only after the `install` promise has
      settled. Check the order with a flag.
    - `status → {ready:true}` means no install.
  - **pdf.ts**: with the `cli` seam pointing to a script that sleeps forever, `install({signal})` plus `abort()` rejects
    with `PdfError`, and the child pid is gone afterwards. This test can go in the new file, or in a new
    `pdf-install.test.ts`.
  - **supervisor settle**: run a shift with a ScriptedAdapter, `await whenSettled(id)`, then
    `card-attachments/` under `sandbox.tmp` is empty. This is the attachments test through the harness change.
    `whenSettled` of an unknown id resolves at once.
  - **Regression check of existing behaviour**:
    - `test/pdf-render.test.ts` (real browser, skipped when absent) and `test/storage-service-pdf.test.ts` stay green.
    - The role smoke test file stays green: `the runner sends role.smoke ...` uses `roleSmoke: true` and is not affected
      by the PDF gate.

### 5. Role smoke: measure, then decide

1. After steps 1-4, log each role's duration in the role smoke test, for example by timing `runRoleSmoke` per role
   with `roles: [r]` in a loop, or by a temporary `console.time`. Run the full suite once locally and push. Put the
   CI numbers in the handoff.
2. If the whole smoke is still above about 60 s on CI (half the budget), the remaining cost is the uncached tsx compile
   of `aom-cli.ts` per role. In that case:
   - Make the smoke reuse one compile cache across its roles, for example with a role-smoke option
     `toolCacheDir` for test runs only.
   - Or have the test point `deps.aom` at one pre-warmed tsx command that shares a cache dir.

   Production uses the bundled `aom.mjs`, so it is unaffected. Do **not** raise the 120 s timeout or the 60 s
   per-role execa timeout.
3. If a single role is the outlier, not all of them evenly, record which role and its stderr, and ask before going
   further. That would be a different cause from the one found here.

## Risks

- **Mock-runtime runners**: the gate is `VITEST` only, on purpose. The CI e2e and demo runners (mock runtime, not
  vitest) keep fetching the PDF browser exactly as today.
- **Tests that wanted the real install**: none found. `pdf-render.test.ts` uses an installed browser if one is there
  and is skipped otherwise. `storage-*-pdf` tests use a fake renderer.
- **`stop()` takes longer**: it now waits for the installer to die (at most about 2 s with the force-kill delay) and
  for the shift cleanups (bounded by the race in §3). Self-update and restart become cleaner: no orphan installer
  shares `<dataDir>/browsers` with the next process.
- **`runShift` awaits settle**: tests that check something during the end-of-shift cleanup would see it done. A grep
  found none. If one appears, it should wait on a signal anyway.
- **Merging with GWP-187**: both cards touch `supervisor.ts`. The settle map is additive and stays away from the
  grace timer and claim logic.

## Acceptance criteria mapping

| AC | Covered by |
|---|---|
| Role smoke passes within 120 s, timeout unchanged | §1 (no installs load the CI machine) plus the §5 measurement and fallback. Timeouts untouched. |
| No afterAll ENOTEMPTY or other cleanup error in the 9 files | §1 (no install under tests), §3 (`stop()` awaits shift cleanup), `runShift` awaits settle |
| No real Playwright install into aom-data-*, or finished or cancelled before removal | §1 gate (none started under VITEST) plus §1/§2 abort and await in `stop()` for any test that turns it on. Unit tests in §4. |
| attachments test passes and leaves no files | §3 `whenSettled` in `runShift`. The existing assertion at :646 stays as it is. |
| Job green on the PR and on 3 re-runs, no retries | Run on CI by the builder or tester (test plan steps 3-4) |
| Root cause and fix written on the card | "Root cause, in short" above, also posted on the card thread |
