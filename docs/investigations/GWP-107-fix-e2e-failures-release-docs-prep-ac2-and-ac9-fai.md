# GWP-107: release-docs-prep AC2 and AC9 fail in the full E2E run on release/1.5.0

## 1. Question

In the GWP-99 full E2E run on release/1.5.0, `e2e/tests/release-docs-prep.spec.ts` reports AC2 and AC9 as failing.
What is the root cause of each failure: a product regression, a test defect, or a full-run isolation problem? How should
each be fixed without weakening the spec?

## 2. Evidence available

- The GWP-99 run log `/home/exinarium/devbox-cache/gwp99-run/run.log` no longer exists on this workstation (the
  `gwp99-run` folder is gone). DevOps has been asked for a copy or excerpt (request c6639db7). The builder or tester
  must quote the failing lines from that copy, or from a fresh run of the spec, on the card (card AC1).
- This report is based on the code at `caa6a44f` (the current release/1.5.0 tip in this worktree), its git history, the
  Playwright config and the unit tests of the release prep step registry.

## 3. Findings

### 3.1 There is one failing test, not two

The spec runs in serial mode (`test.describe.configure({ mode: 'serial' })`, line 14), and `e2e/playwright.config.ts`
sets `retries: 0`. In serial mode, after the first failing test Playwright skips the rest of the file ("did not run"),
so **at most one test in this spec can fail per run**.

The test at line 278 is titled `AC2/AC9: the owner switches release prep on; the checklist lists only the registered
steps`. A single failure of this test, read from the log, gives "AC2 and AC9 fail". The test at line 240
(`AC2: a member sees the settings read-only ...`) runs before it. If line 240 had failed, line 278 would have been
skipped, not failed. So **the failing test is the line-278 test, and the line-240 AC2 test passed** in the GWP-99 run.
The tester confirms this from the log copy or a fresh run (it should show `✓ AC2: a member ...`,
`✘ AC2/AC9: the owner switches ...`, and every test after it as skipped or not run).

### 3.2 Root cause of the AC2/AC9 failure (line 278): test out of date (category b)

GWP-92 (Release prep 4/4, merged into release/1.5.0 at `caa6a44f`) added the step 'Generate videos' to the release prep
registry on purpose:

- `packages/shared/src/release/docs-prep-videos.ts:10-20`: `VIDEOS_STEP = { id: 'videos', label: 'Generate videos',
  order: 40, defaultOn: false, ... }`.
- `packages/shared/src/release/docs-prep.ts:78-84`: `STEPS = [ANALYSE_STEP, CHANGELOG_STEP, GUIDE_STEP, VIDEOS_STEP,
  COMMIT_STEP]`.
- The registry unit test was updated for it (`2da2ce40`, `packages/shared/test/release-docs-prep-videos.test.ts`):
  the order is `analyse, changelog, guide, videos, commit`, and videos is off by default even with prep on.

The settings API lists every registered step (`getReleaseDocsPrepSettings`, `apps/server/src/release/docs-prep.ts:88`),
and the panel renders one `fieldset label` per listed step (`apps/web/src/components/ReleaseDocsPrepPanel.tsx:70`). When
the switch is turned on, the panel sends its whole `steps` state (including `videos: false`), and
`setReleaseDocsPrepSettings` stores one entry per registered step (`docs-prep.ts:111-113`).

The spec was last updated for Write changelog (`18faf7b6`) and was not updated for Generate videos. It still expects
four steps:

| Line | Assertion in the spec | What release/1.5.0 now does |
|------|-----------------------|-----------------------------|
| 283 | labels `['Analyse changes', 'Write changelog', 'Update user guide', 'Commit results']` | `[..., 'Update user guide', 'Generate videos', 'Commit results']` (fails here first) |
| 298 | stored steps `{ analyse, changelog, guide, commit }` all `true` | `{ analyse: true, changelog: true, guide: true, videos: false, commit: true }` |
| 300-302 | narrow PUT without `videos` | still 200; videos stays `false` (from the stored value), but the intent is implicit |

**Classification: test defect (b), out of date after an intended product change.** It is not a regression: the shared
registry test, the server and the panel all agree on the five steps. It is not a full-run issue: it fails when the spec
runs alone too. The same kind of update was made for the guide step in `1ea853fb` and for changelog in `18faf7b6`.

Rule 4 of the card (ask the Architect before changing an expectation that 1.5.0 changed on purpose): **this report is
that decision.** Update the expectation to the five-step registry. Do not change the product.

### 3.3 The line-240 AC2 test

There is no evidence that it failed (see 3.1), and it does not depend on the step list. I checked every assertion
against the code:

- `GET settings` for the guest: `loadVisibleProject` lets the active project member through; `canManage` is false for
  a `member` with no org role, so `canEdit: false`.
- PUT settings / POST runs / POST skip / POST retry: each calls `requireManager`, so 403.
- Stranger: `admin:create` gives each user their own organization (`e2e/support/api.ts:20-45`), so ADMIN is not a member
  of OWNER's project or org, and `loadVisibleProject` returns 404.
- UI: the panel renders for a software project (`ProjectSettings.tsx:384`), with the read-only note, a disabled switch,
  and the `fieldset` disabled, so `Analyse changes` is disabled.
- DB: `enabled` stays false (the guest PUT is refused).

**No change is needed for the line-240 test.** If the log copy or a fresh run shows it failing anyway, the tester records
the error on the card and diagnoses it separately (card rule 3) before applying 4.

### 3.4 What runs for the first time after the fix

In the GWP-99 run every test after line 278 (AC3, AC4/AC5/AC8, AC6, AC7 x2) was skipped by serial mode, so their state
on release/1.5.0 is unknown. With videos off (the default), the runs in those tests use only `analyse` and `commit`, as
before. The step rows expected at line 401 (`analyse/`, `commit/prepare`, `commit/push`) and the 4 commit rows at line
463 (2 repos x 2 phases) still hold. I found no 1.5.0 change that should break them, but card AC3 ("no other test in
that spec fails") means they must pass. If one fails, it is a newly exposed failure of this spec: record it on the card
and diagnose it with the same a/b/c split.

## 4. Options

| Option | Verdict |
|--------|---------|
| A. Update the literal expectations at lines 283, 298 and 301 to the five-step registry, keeping exact `toEqual` | **Chosen.** Still checks AC9 ("lists only the registered steps", in order) and the default-off rule for videos. |
| B. Build the expected labels from `releaseDocsPrepSteps()` in `@aom/shared` | Rejected: compares the product with itself, so a wrong label or order would pass. This weakens the test. |
| C. Hide 'Generate videos' from the settings panel | Rejected: changes intended 1.5.0 behaviour (GWP-92 lists it as an opt-in step). |
| D. Filter `videos` out of the stored steps in the assertion | Rejected: loosens the assertion. |

## 5. Design (the change)

**One file: `e2e/tests/release-docs-prep.spec.ts`.** Do not change product code, `e2e/support/*`, other specs,
migrations or `RUNNER_VERSION`.

```ts
// line 283
expect(labels).toEqual([
  'Analyse changes',
  'Write changelog',
  'Update user guide',
  'Generate videos',
  'Commit results',
]);
```

```ts
// line 298: Generate videos is off by default even when prep is switched on
).then((s) =>
  expect(s.steps).toEqual({ analyse: true, changelog: true, guide: true, videos: false, commit: true }),
);
```

```ts
// lines 299-302: the comment and the narrow PUT name videos explicitly
// the runs below use Analyse and Commit only (the mock runner has no writer agent for the guide, changelog or videos)
const narrow = await owner.put(`/api/projects/${projectId}/release-docs-prep/settings`, {
  data: { enabled: true, steps: { analyse: true, changelog: false, guide: false, videos: false, commit: true } },
});
```

Leave everything else in the test as it is: the readonly check, the switch, the event actor check and the unknown-step
400 check.

No assertion is removed or loosened. Two assertions get one more expected element (more strict, not less), and the PUT
body names one more step.

Checked against the base commit before applying:

- `VIDEOS_STEP` (`packages/shared/src/release/docs-prep-videos.ts` l.10-16): id `videos`, label `Generate videos`,
  order 40, `defaultOn: false`. With analyse 10, changelog 20, guide 30 and commit 1000, the checklist order is the
  five labels above.
- The server stores every registered step when the settings are saved, filling a missing one from `defaultOn`
  (`apps/server/src/release/docs-prep.ts` l.112:
  `releaseDocsPrepSteps().map((d) => [d.id, input.steps[d.id] ?? before.steps[d.id] ?? d.defaultOn])`). So after the
  switch is turned on, `release_docs_prep.steps` holds `videos: false`, and the exact `toEqual` at l.298 needs it.
- In the narrow PUT, `videos: false` would also be kept without naming it (`before.steps.videos` is `false`). Naming
  it makes the "runs below use Analyse and Commit only" setup explicit and does not depend on the earlier state.

### Who builds it

Every edit is under `e2e/**`. The ledger rulings (aadf93f9, 69b39b28, and f87e3c86 for GWP-103, an e2e-only card) say
builders get no exception to the e2e guard. The tester role owns these edits, so **route the build of GWP-107 to a
tester-role shift**, then to review. If the tester shift cannot run the stack, DevOps runs the spec and the full suite
and the tester records the results (standing order on GWP-99).

### Group and conflicts

This change touches no `e2e/support/*` file and no spec other than this one, so it cannot conflict with GWP-105, 106,
108 or 109, or with GWP-103 (`e2e/support`). No dependency needs to be recorded.

## 6. Verification

1. Get the GWP-99 log copy from DevOps, or run the spec alone on the unmodified tip. Quote the `AC2/AC9` failure (the
   expected and received arrays at line 283) and the status of the line-240 test on the card.
2. Apply the change. Run `pnpm --filter @aom/e2e exec tsc --noEmit` (or the e2e typecheck script) to check the types.
3. Run the spec alone three times (`playwright test --project=release-docs-prep`, the `auth` dependency runs first).
   All 9 tests must pass every time.
4. Run the full suite with the GWP-99 configuration. The release-docs-prep project must pass in full, and no new
   failure may appear compared with the GWP-99 list. Attach the summary to the card.
5. No product code changes, so card AC5 does not apply. Still run `pnpm --filter @aom/shared test` once to show the
   registry test (`release-docs-prep-videos.test.ts`) that defines the expected order still passes.

## 7. Acceptance criteria mapping

| Card AC | How it is met |
|---------|---------------|
| AC1: root cause of each, with log lines, classified | 3.1 to 3.3: one failing test (`AC2/AC9`, line 278), a test defect (b) from the intended Generate videos step. The line-240 AC2 test did not fail (serial mode) and needs no change. The tester adds the log or fresh-run lines. |
| AC2: both pass alone | Section 5 change, verification step 3. |
| AC3: both pass in the full run, no other failures | Verification step 4. 3.4 covers the tests that run for the first time. |
| AC4: no skip, fixme or retry, no loosened assertion | Option A only adds expected elements. Options B and D were rejected for this reason. |
| AC5: unit tests if product changed | Not applicable (no product change). The shared registry test is run as a cross-check. |

## 8. Risks

- **Later tests were never exercised on 1.5.0** (3.4). This is the main risk. If AC3 to AC7 expose a new failure, it
  belongs to this card's AC3. Record it and fix it at its source. If it is a product regression, it needs a builder
  shift for the product code, plus a unit test.
- **Missing log.** If DevOps has no copy, a fresh run of the unmodified spec on the tip is the evidence for card AC1.
