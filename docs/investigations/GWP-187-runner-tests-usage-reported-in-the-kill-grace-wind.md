# GWP-187: usage recorded in the claim-lost grace window is wrong (inputTokens 1 instead of 900)

## Question

`test/runner-v3.test.ts > grace before the process is killed once the claim is released > lets Claude write its
result line, so the real usage is recorded and the shift counts as reported` fails on main and on every dependabot PR:
`shift.ended.usage` is `{inputTokens: 1, outputTokens: 2}` instead of `{inputTokens: 900, outputTokens: 100}`. Why, and
how do we fix it in runner behaviour, not in the test?

## Findings

### 1. The Claude stream parser is not involved

The test runs on `ScriptedAdapter` (`apps/runner/test/scripted-adapter.ts`), not on `ClaudeCodeAdapter`. Its `usage()`
returns `{inputTokens: 1, outputTokens: 2, ...}` until the script calls `ctl.setUsage(...)`, which this test does 500 ms
after it reports. So `inputTokens: 1` does not mean "a partial usage overwrote the result line". It means **the session
was stopped before those 500 ms were up**: the script was aborted and never called `setUsage`.
`claude-stream-parser.ts` and `claude-code.ts` need no change (the code-graph leads pointed there by name only).

### 2. Reproduction

On a copy of the card branch (scratch dir, installed modules linked in):

- `vitest run test/runner-v3.test.ts -t "grace before the process"`: 3/3 pass.
- `vitest run test/runner-v3.test.ts` (the whole file): the test fails in 623 ms with exactly the CI assertion
  (`inputTokens: 1, outputTokens: 2`). The other 28 tests pass.
- Running any single earlier `describe` block together with the grace block passes. The failure depends on load and
  timing, not on one earlier test. CI runners are slower, so it fails there every time.

### 3. Root cause: the report verdict and `shift.stop` race inside one socket read

The test's own assertions show the order of events:

- `outcome === 'reported'` passes. `handleStop` set `s.stopReason = 'claim_lost'` (that only happens when it takes the
  **immediate-kill** branch). So the outcome can only be `reported` through `|| s.reportAccepted`
  (`supervisor.ts:1852`). That means `reportAccepted` was **false when `handleStop` checked it and true later**.
- The fake server sends `shift.report.result` **before** the test sends `shift.stop` (`fake-server.ts:176-179`
  replies inside `onFrame`; the test's `waitFor` polls every 25 ms before it sends the stop).

So the runner had the accepted verdict in hand, but had not yet applied it, when it handled the stop. The code:

1. `connection/client.ts:179` dispatches every ws `message` event straight through `onFrame` → `emit('message')` →
   `Runner.onMessage` (`runner.ts:1925`) → `supervisor.onReportResult` / `supervisor.handleStop`. Every step is
   synchronous.
2. ws 8.22 (`receiver.js:54-57, 605-607`) defaults `allowSynchronousEvents` to `true`. When several frames arrive in
   **one socket read**, it emits their `message` events back to back in the same tick. No microtask checkpoint runs
   between them.
3. `onReportResult` (`supervisor.ts:853`) only resolves the `verdict` promise. The terminal state
   (`s.reportState = 'accepted'`, `s.reportAccepted = true`, the `exitGraceMs` timer) is set in `submit()`
   **after `await verdict`** (`supervisor.ts:3011-3033`), which runs as a microtask continuation.
4. When `shift.report.result` and `shift.stop{claim_lost}` arrive in one read, `handleStop` runs before that
   continuation. It sees `reportAccepted === undefined` (`supervisor.ts:778`), skips the grace, sets
   `stopReason = 'claim_lost'` and calls `session.stop()`. The script is aborted after a few ms and the default usage
   is recorded. A moment later the continuation sets `reportAccepted = true`, which is why the outcome still reads
   `reported`.

Why the frames arrive together: in the test, the fake server, the runner and the test run in **one Node process**.
When that event loop is blocked for more than about 25 ms after the result frame was written (synchronous work
elsewhere in the run), the next loop iteration runs timers before the I/O poll phase. The test's `waitFor` timer fires
and writes `shift.stop`, and only then does the runner's socket read both frames at once. In production the same
race exists between the server's report handler and its heartbeat-driven `stopIfClaimLost`
(`apps/server/src/runner-gateway/handlers.ts:1166, 1306, 1368`). The handler releases the claim in its transaction and
then still awaits `deliverPending` before it sends `shift.report.result` (`handlers.ts:348-363`). A stop sent in that
gap can arrive in the same read as the result, or **before** it.

### 4. What regressed

The runner logic did not change. The grace feature (`handleStop`, `claimLostGraceMs`) and this test have been the same
since `91d4a418` (2026-10-17). `git diff v1.5.0 v1.6.0 -- apps/runner/src/shifts/supervisor.ts` does not touch
`submit`, `onReportResult` or `handleStop`, and ws stays at 8.22. The defect is the **latent ordering race** above. What
changed in 1.6.0 is timing: the runner and its test suite do more synchronous work on the shared event loop (the
release added about 4,000 lines to apps/runner: storage, sealed credentials, vault scoping and more), so the two frames
now land in one read on CI. I could not single out the commit that pushed it over the edge. The suite's sandbox
refused edits even to a scratch copy, so I could not add timing logs. The fix does not depend on finding that commit:
it removes the ordering dependency itself.

**The grace period did not regress.** `claimLostGraceMs` (test: 5,000 ms, default 5,000 ms) is never reached: the
kill happens before the grace logic runs. Lengthening it would not help.

## Options

| | Option | Verdict |
|---|---|---|
| A | **Apply the terminal verdict synchronously** where the verdict arrives (inside the `pendingReports` callback), not after `await verdict`. | **Recommended.** Removes the race for result-then-stop. Small, local, same end states. |
| B | Also, in `handleStop`, **wait (bounded by the grace) for a terminal report still in flight** (`reportState === 'pending'`) before deciding. | **Recommended, together with A.** Covers stop-before-result, which the server can produce today. A few lines in the same function. |
| C | Defer `handleStop` by `setImmediate`/`queueMicrotask` in `Runner.onMessage`. | Rejected. Hides the race for one frame order only, depends on tick ordering, and changes timing for every stop reason. |
| D | Set `allowSynchronousEvents: false` on the client WebSocket. | Rejected. Makes every frame cost a `setImmediate`, changes behaviour for the whole connection, and still leaves stop-before-result open. |
| E | Change the test (wait longer before sending the stop). | Not allowed (card constraint), and it would hide a real production race. |

## Design (A + B), all in `apps/runner/src/shifts/supervisor.ts`

### A. Apply the terminal verdict at the moment it arrives

New private helper, which takes over the three branches now in `submit()` after `await verdict`
(lines ~3018-3033):

```ts
/** Records the server's verdict on a terminal report. Called synchronously when the verdict frame arrives, so a
 *  `shift.stop` in the same socket read already sees it (ws emits back-to-back frames in one tick). */
private applyTerminalVerdict(s: ActiveShift, v: ReportVerdict): void {
  if (!v.accepted || v.continueShift) {
    s.reportState = 'none';
    return;
  }
  s.reportState = 'accepted';
  s.reportAccepted = true;
  s.graceTimer = setTimeout(() => void s.session?.stop('report_accepted'), this.deps.exitGraceMs ?? 120_000);
  s.graceTimer.unref?.();
}
```

In `submit()`:

```ts
const reportId = uuidv7();
if (terminal) s.reportState = 'pending';
let verdictApplied: () => void = () => {};
if (terminal) s.terminalVerdict = new Promise<void>((r) => { verdictApplied = r; });   // (B)
const verdict = new Promise<ReportVerdict | 'timeout'>((resolve) => {
  s.pendingReports.set(reportId, (v) => {
    if (terminal) this.applyTerminalVerdict(s, v);   // before any other frame of the same read is handled
    verdictApplied();
    resolve(v);
  });
  setTimeout(() => {
    if (s.pendingReports.delete(reportId)) { verdictApplied(); resolve('timeout'); }
  }, this.deps.reportWaitMs ?? 120_000).unref?.();
});
this.deps.transport.send('shift.report', ...);
const result = await verdict;
if (result === 'timeout') return { accepted: true, message: `Queued. ${ACCEPTED_MESSAGE}` };
if (!result.accepted) return rejected(result.error ?? 'the server rejected the report', result.matches);
return { accepted: true, message: ..., ...(result.matches ? { matches: result.matches } : {}) };
```

The state changes after `await verdict` are removed: they now live only in `applyTerminalVerdict`. The returned
messages stay exactly as they are.

Equivalence for the existing paths:
- Accepted / `continueShift` / rejected: the same end state as today, just set earlier (in the same tick as the frame
  instead of one microtask later).
- `handleStop` rejecting pending reports (`cb({accepted:false, error:'claim lost ...'})`, line ~796): today
  `reportState` goes `'accepted'` (set by `handleStop`) and then `'none'` one microtask later. After the change it goes
  `'none'` at once. The end state is the same and `stopReason` is already set, so the fallback report at line ~1700
  still cannot run. Keep this behaviour as it is; do not "improve" it in this card.
- Timeout: `reportState` stays `'pending'`, as today.
- Non-terminal reports (`terminal === false`): untouched.

### B. A claim lost while the terminal verdict is still in flight

`ActiveShift` gets one field next to `reportAccepted`:

```ts
/** Settles once the verdict of the terminal report in flight was applied (accepted, rejected or timed out). */
terminalVerdict?: Promise<void>;
```

`handleStop`, top of the function (one deadline shared by both waits, so the total wait stays at most `claimLostGraceMs`):

```ts
const grace = this.deps.claimLostGraceMs ?? 5_000;
const deadline = Date.now() + grace;
const within = async (p: Promise<unknown>) => { /* race p against a timer of max(0, deadline - Date.now()); true if p won */ };
// The server releases the claim when it accepts the report and may say so before (or in the same read as) the verdict.
if (reason === 'claim_lost' && s.reportState === 'pending' && s.terminalVerdict) await within(s.terminalVerdict);
const afterAccepted = reason === 'claim_lost' && s.reportAccepted === true;
if (afterAccepted && s.streamEnded) { if (await within(s.streamEnded)) return; }
... rest unchanged ...
```

Keep the existing timer-clearing pattern (`clearTimeout` and `unref`) in `within`. Any `shift.stop` that is not
`claim_lost`, or a claim lost with no terminal report pending (`reportState === 'none'`), still stops at once, as today.

### Files

- `apps/runner/src/shifts/supervisor.ts`: `ActiveShift.terminalVerdict`, `applyTerminalVerdict`, `submit()` and
  `handleStop()` as above. No other production file changes.
- Tests: new cases in `apps/runner/test/runner-v3.test.ts` inside the existing `describe('grace before the process
  is killed ...')` (the three existing tests stay **unchanged**). The local `start()` helper may get an optional third
  `serverOpts` argument passed through to `startHarness` (or the new tests call `startHarness` directly).

### Tests the builder adds

1. **Result and stop in one socket read (deterministic regression test for A).** The fake server's `reportResult`
   hook runs inside `onFrame` just before the result is written. Queue the stop as a microtask so it is written in
   the same tick, after the result. Both frames are then in the kernel buffer before the runner (same process) can read:
   ```ts
   reportResult: (m) => {
     queueMicrotask(() => h!.server.send('shift.stop', { shiftId: m.shiftId, reason: 'claim_lost' }));
     return { accepted: true };
   },
   ```
   Script: report, `sleep(500)`, `setUsage({inputTokens: 900, outputTokens: 100})`, return. `claimLostGraceMs: 5_000`.
   Expect `outcome === 'reported'` and usage `{900, 100}`. Run it against the unfixed code once and confirm it fails.
2. **Stop before the verdict (B).** `reportResult: () => 'ignore'`. Wait for `shift.report`, send
   `shift.stop{claim_lost}`, wait about 100 ms, then send `shift.report.result {reportId, accepted: true}` by hand
   (the `reportId` comes from the received `shift.report`). Same script and expectations as test 1.
3. **Stop before a verdict that never comes (B is bounded).** `reportResult: () => 'ignore'`, `claimLostGraceMs: 300`,
   and the script blocks until aborted. Send the stop and never answer. Expect `shift.ended` within 10 s, outcome
   `stopped` (no accepted report), and the agent's pending `aom` report answered with the claim-lost error.
4. Existing: `still stops a process that does not finish within the grace` and `a claim lost before any report still
   stops at once` must pass unchanged. They cover "no longer wait than the grace" and "no report → immediate stop".

## Acceptance criteria mapping

| AC | How it is met |
|---|---|
| The grace test passes with exactly `{900, 100}` | A: `reportAccepted` is set before `handleStop` can run, so the grace path waits for `streamEnded` and the usage is read after the script set it. Builder runs the full file (it failed only there) at least twice. |
| The shift counts as reported | Unchanged `outcome` logic (`supervisor.ts:1852`); `reportAccepted` is true and `stopReason` stays unset on the grace path. |
| Result-line usage during the grace window is recorded and not overwritten | A and B make the grace path deterministic for both frame orders. `shift.ended.usage` is read once, after the stream ended (`supervisor.ts:1865`); there is no earlier write to overwrite it. With the real Claude adapter, `streamEnded` resolves only after the result line was parsed (`ClaudeStreamParser.usage()` prefers the result-line total), so no parser change is needed. New tests 1-2. |
| Other runner-v3 and claude stream parser tests pass | No change to the adapters or the parser. Run `test/runner-v3.test.ts`, `test/claude-stream-parser.test.ts` and the other supervisor/report suites (`grep -l "reportAccepted\|claim_lost\|shift.report.result" test/`). |
| CI 'Runner tests' shows no failure in runner-v3 | Same as row 1. The role-smoke and Playwright ENOTEMPTY failures belong to GWP-186. |
| Cause written on the card | Posted as a card comment (summary of section 3); the builder repeats it in the handoff. |

## Risks

- **Ordering-dependent code elsewhere.** `reportState`/`reportAccepted` are read in `handleStop`, `idleCheck`
  (`reportState !== 'none'` → no idle stop), the end-of-shift fallback and `outcome`. All of them now see the verdict
  sooner, never later. The builder checks each reader (`grep -n "reportState\|reportAccepted" src/shifts/supervisor.ts`).
- **B adds up to `claimLostGraceMs` (5 s) of delay** to a claim lost while a terminal report is pending and its verdict
  never comes. Bounded, and only in that state.
- **GWP-186** (same group) edits `supervisor.ts` in shift setup, not these functions. A textual conflict is unlikely.
- Normal (non-grace) shift ends: unaffected. The usage is still `session.usage()` read once at the end.
