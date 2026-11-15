# GWP-239: full E2E suite stops at desk AC1 (runner closed with 4409, build shift lost)

## Verdict

Cause: **the E2E harness (case b)**, not the product. Two runner processes run against the same
workstation home (`paths.runnerData`) at the same time. The server behaves as designed: the newer
connection supersedes the older one with 4409, and the shift held by the closed connection is
released as `runner_lost_shift` on reconcile.

Commit tested: `10733d15` (the working branch head when the investigation ran).

## Evidence

- `pnpm -C e2e regression -- --project=desk` with only desk's dependency chain
  (auth -> pairing -> core-loop -> desk) passes desk AC1 with no 4409 line in `runner.out.log`.
  So core-loop AC7b (SIGKILL + server clock +1h) on its own does not leave a stale registration
  that breaks desk.
- In `full:shift` the `mobile` project runs between core-loop and desk (it depends only on
  `pairing`, and the single worker schedules it there). `e2e/tests/mobile.spec.ts` beforeAll calls
  `startRunner()` on the default home, the same workstation desk uses, and its afterAll never stops
  it.
- desk beforeAll then calls `startRunner()` again. `recordPid()` overwrites the pid of mobile's
  runner, so nothing in the suite (not even global teardown) knows about mobile's runner any more.
- `runner.out.log:26`: `connection closed for good (4409): another runner connected for this
  workstation` — one of the two runners is superseded. The card's events match: `CardClaimed(build)`
  -> `ClaimReleased runner_lost_shift ('runner reconnected without this shift')` -> a second claim
  takes the `ok` step -> review -> test, so AC1 never sees Blocked.
- Server code agrees: `apps/server/src/runner-gateway/gateway.ts` always lets the new connection win
  and closes the previous socket with `WS_CLOSE.superseded` (4409). A stale DB row with
  `connected=true` alone never causes a 4409; the in-memory socket map decides. A 4409 therefore
  needs a second live process.

## Fix (harness, under `e2e/**`)

The exact change is in `docs/investigations/GWP-239-harness.patch` (apply with
`git apply docs/investigations/GWP-239-harness.patch`). Typecheck (`tsc -p e2e`) and biome pass on it.

- `e2e/support/runner.ts`: `runnerConnected(api)` (server shows a connected workstation) and
  `stopRunnerAndWait(api)` (SIGTERM the recorded default-home runner and wait until the server shows
  none connected).
- `e2e/tests/mobile.spec.ts`: reuse a runner that is already connected (pairing's, when mobile runs
  before core-loop) instead of starting a second one; when it did start one, stop it in afterAll and
  wait until the server shows it disconnected.
- `e2e/tests/desk.spec.ts`: beforeAll calls `stopRunnerAndWait(api)` before `startRunner()`, so it
  never starts a runner while another one is still registered for the workstation.

desk AC1's expectation, its timeouts and the project chain are unchanged. No product change: 4409
keeps protecting the workstation from two live runners.

## Still to do (tester)

1. Apply the patch.
2. Run `pnpm -C e2e regression -- --project=desk` twice: AC1 reaches Blocked, one build claim, no
   `runner_lost_shift`, no 4409 in `runner.out.log`.
3. Run `pnpm -C e2e full:shift` and attach `pnpm -C e2e summary`; check core-loop AC9 and
   review-settings AC5 pass; file every failure after desk as its own bug card.
4. Commit `7713f38d` (review-settings uses its own revmgr account) is not in this branch's history;
   bring it over from the branch it was committed on (GWP-237) and keep it.
