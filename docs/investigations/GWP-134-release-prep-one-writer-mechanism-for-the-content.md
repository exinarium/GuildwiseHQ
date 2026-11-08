# GWP-134 Release prep: one writer mechanism for the content steps

Status: design, ready to build. Base: `release/1.6.0` (the checkout is at b648d067, the same commit as
`origin/release/1.6.0`, so everything below was read on the 1.6.0 code).

## 1. Question

Release prep has three content steps: Write changelog, Update user guide and Generate videos. Each step reaches a model in
its own way. The card asks for one way (or one shared abstraction) so that every content step gets its writer from the
same place, uses the same contract, runs the same checks before anything is committed, and fails or falls back the same
way. It also asks that a repository with no user guide is skipped without needing a writer.

## 2. R0: what release/1.6.0 already does

The planning note said "two writer paths". There are actually **three**: Generate videos (GWP-92) landed its own
mechanism, the `release_prep` agent shift.

| Req | State on release/1.6.0 | Evidence |
| --- | --- | --- |
| R1 one mechanism decided | **Not done.** GWP-91 11.5 kept two mechanisms and logged this card as the follow-up. GWP-92 3.2 then added a third one, a generic `release_prep` shift, written "so GWP-91 (guide text) can use it too". Nothing has been moved onto it. | `docs/investigations/GWP-91-…md` rows 538 and 566, 11.5; `docs/investigations/GWP-92-…md` 3.2 |
| R2 changelog and guide share one path | **Not done.** Changelog: `queueChangelogTask` creates a BA task `release_changelog` (any BA in the org, on any workstation). `applyReleaseChangelogReport` checks the proposal with `checkChangelogProposal` and sends the entries to the runner, and `runReleaseChangelogFallback` fails the step. Guide: `DOCS_PREP_STEP_HOOKS.guide.needsWriter` and `docsPrepWriter` (architect, then ba, then builder on the repo's workstation) put `payload.writer` in the command, and the runner makes one headless `startChat` call through `docsPrepModel`. | `apps/server/src/release/docs-prep-changelog.ts:134`, `docs-prep-changelog-task.ts:175,259`, `docs-prep-steps.ts:43-74`, `docs-prep.ts:499-530`; `apps/runner/src/git/release-docs-prep-model.ts`, `runner.ts:2209`; commits 322e206f (changelog BA task), 34af464b (guide headless call) |
| R3 videos uses it | **The videos step exists, on a third path.** Phases `plan` (runner), `author` (server phase, `release_prep` tasks), `render` (runner). `releasePrepTaskPass` gives each task to a **builder** on the repo's workstation, as a full shift with accounts, costs, logs, retries and a 2-hour queue limit. `aom prep done` is checked against a writable list and committed to the work ref by the runner. | `apps/server/src/release/docs-prep-tasks.ts`, `docs-prep-videos.ts`; `apps/runner/src/git/release-prep-task.ts`, `shifts/supervisor.ts:1085,2810`; `packages/shared/src/release/docs-prep-task.ts`; commit afd255e1 |
| R4 one failure model | **Not done.** There are three different messages and behaviours. Changelog: "No BA was available to write the changelog. Retry prep, or write the entries under ## [Unreleased] by hand." (fallback after the BA timeout). Guide: "no agent on the workstation that has X can write the release documentation" (fails at dispatch), and a runtime failure on the runner gives "the writer failed: …". Videos: "no builder agent on W to write the S video" (at once) or "…within 2 hours". | `docs-prep-changelog-task.ts:272`, `docs-prep.ts:525`, `release-docs-prep-model.ts:20,114`, `docs-prep-tasks.ts:289,293` |
| R5 no guide means skipped, no writer | **Half done.** The runner returns early when the guide file is missing, but as `ok:true` with `output.skipped='no user guide'` and no `state:'skipped'`, so the step shows **passed**, not skipped. Worse, the server refuses to dispatch the guide step at all when there is no writer agent (`needsWriter`), so a repository with no guide and no writer **fails**. A missing CHANGELOG.md is not a skip case: GWP-90 creates it from `changelogSkeleton` (a supported setup), and that stays. Videos already skip in `plan` when the repo has no harness. | `release-docs-prep-guide.ts:148-149`, `docs-prep.ts:515-529`, `release-docs-prep-changelog.ts:47` |
| R6 checks before commit | **Done, per path.** Changelog: `checkChangelogProposal` on the server (deny list, public text, sources), then `checkChangelog` and `mergeUnreleased` on the runner. Guide: `checkGuideUpdate` before and after the edits, and after the PDF assemble. Videos: writable-list subset check, required files, and the render itself. | `docs-prep-changelog-task.ts:228`, `release-docs-prep-changelog.ts:34`, `release-docs-prep-guide.ts:176,227,321`, `release-prep-task.ts:75-79` |
| R7 no visible regression | Baseline recorded: step ids and labels (`changelog` "Write changelog" 20, `guide` "Update user guide" 30, `videos` 40, `commit` 1000) are in `packages/shared/src/release/docs-prep.ts`. Commit identity is `requireCommitIdentity(commitAs)`. The work commits are squashed into one commit `docs(release): prepare the release documentation for <branch>`. | `docs-prep.ts:55-78`, `release-docs-prep.ts:316-401` |

**Conclusion:** only part of the card is done, so this is not a no-change card. The build covers R1 to R5. R6 and R7 must
be kept as they are.

## 3. Findings that drive the decision

1. **Where each path runs and who pays.** All three run the model on the user's workstation with the agent's own login.
   None puts secrets on the server, which matches the standing order. They differ in what they record:
   - BA task: a real shift (cost, logs, account choice, retries), but on a workstation that may **not** have the
     repository. The BA sees only the brief.
   - Headless call: bypasses the shift machinery. There is no account choice, no usage-limit handling, no cost
     row and no live progress. Only a JSONL log goes into `shiftLogs`. GWP-92 3.2 rejected it for this reason.
   - `release_prep` shift: a real shift **on the repo's workstation**, in a detached worktree of the release work, with
     accounts (`accountForAgent`), costs, logs, heartbeat, retry and rejection limits and a queue limit. The role's own
     text is not used, because the task is self-contained (`renderReleasePrepInstructions`).
2. **What each step needs from its writer.**
   - Changelog: data only (a proposal of entries). The deep checks need the database (deny list of agent, member and
     workstation names, and `publicText` from `server/src/blog/releases.ts`), so they must stay on the server.
   - Guide: needs to **read the repository** (the guide, its assets, the help articles). Its checks (`checkGuideUpdate`)
     need the files, so they must run on the runner. The PDF build is deterministic runner work.
   - Videos: writes repository files directly (spec, narration and three index files), with a subset check.
3. **Availability.** The repo's workstation always hosts the agents that build that repository's cards (normally a
   builder; often an architect too). A BA may live on another workstation. Today's guide writer already needs an agent on
   the repo's workstation, and so does the video author.
4. **Repair.** The changelog BA fixes a refused proposal in the same shift (the report is refused with the findings).
   The guide headless call gets exactly one re-ask. The video author gets one repair round after a failed render.

## 4. Options

| | (a) Every step is a BA task | (b) Every step is a headless writer call on the runner | **(c) Every step's writing is a release prep task (the `release_prep` shift), behind one step abstraction** |
| --- | --- | --- | --- |
| Guide (needs the repo) | Bad: the BA has no repo. The guide text and assets would have to be sent in the brief, and runner-side checks would have to be relayed back to the BA | Works (today) | Works: the shift runs in a worktree of the release work |
| Videos (writes files) | Does not fit (no worktree) | Would have to rebuild the subset check, commit and retries inside a command | Already works this way |
| Model credentials | Workstation (BA's login) | Workstation, but outside the account model | Workstation, through the existing account choice (`accountForAgent`) |
| Cost, logs, audit | Shift | **None** (no cost row, no account, no live view) | Shift: cost, session, transcript, plus the proposal stored on the task |
| Writer availability | Any BA in the org; fails if there is none | Agent on the repo's workstation | Agent on the repo's workstation, role order per task kind |
| In-shift repair of a refused proposal | Yes | One re-ask only | Yes (the report is refused with the findings, same as the BA) |
| New infrastructure | Repo access for BA shifts | Accounts, usage limits and costs for commands | Two new task kinds and a "proposal" ending; the queue, dispatch, shift, supervisor and checks exist |
| Code paths left | 1 (but the guide gets worse) | 1 (but videos gets worse and audit is lost) | **1** |

## 5. Decision (R1)

**Option (c).** Every content step that needs a writer gets its text from **release prep tasks**. These are the generic
`release_prep` shifts GWP-92 built, extended from one task kind to three:

- `changelog_entries` (Write changelog),
- `guide_edits` (Update user guide),
- `new_video` (Generate videos; unchanged).

Reasons:

- **Availability.** The writer is an agent on the workstation that has the repository. That workstation hosts the
  repo's builders anyway, so no BA is needed elsewhere.
- **Credentials stay on the workstation**, through the existing account choice. Nothing new reaches the server.
- **Cost and audit.** Every writer run is a shift with cost, session and transcript. The accepted proposal is stored on
  the task row, so the owner can see exactly what was proposed and accepted.
- **One code path.** The BA task kind `release_changelog` and the headless runner call (`docsPrepModel`,
  `payload.writer`, `docsPrepWriter`, `runModel`) are removed.
- **Videos is already on it.** R3 is met by construction.

### The shared abstraction (the "content step" shape)

A content step that needs a writer is a phased step:

```
[ check ]  runner, deterministic (optional): does the target exist? what is new? -> skipped | passed(report) | failed
  write    server phase: queue release prep tasks of the step's kind from the earlier report (none -> skipped)
  apply    runner, deterministic: apply the accepted proposal (or render), check again, keep the work commit
```

| Step | Phases | Writer kind |
| --- | --- | --- |
| changelog | `write` (server), `apply` (runner) | `changelog_entries` |
| guide | `check` (runner), `write` (server), `apply` (runner) | `guide_edits` |
| videos | `plan` (runner), `author` (server), `render` (runner), unchanged names | `new_video` |

The rule for **R5** comes from the existing planner (`nextReleaseDocsPrepAction`): *only the first phase decides that a
step does not apply to a repository*. When the first phase is `skipped`, every later phase is skipped with the same
note, so **no writer is looked for and no task is queued**. A step whose target can only be seen on the runner gets a
deterministic first phase: guide `check`, videos `plan`.

### One place where the writer is chosen

The registry `PREP_TASK_KINDS` lives in `packages/shared/src/release/docs-prep-task.ts`. For each kind it gives the
writer roles in order, a label for messages, the writable files, whether the result is a proposal or files, and an
optional manual hint:

```ts
export const PREP_TASK_KINDS = {
  new_video:         { roles: ['builder'],                  result: 'files',    what: (t) => `the ${t.slug} video` },
  changelog_entries: { roles: ['ba', 'architect', 'builder'], result: 'proposal', what: () => 'the changelog entries',
                       manual: 'Or write the entries under ## [Unreleased] by hand and Skip prep.' },
  guide_edits:       { roles: ['architect', 'ba', 'builder'], result: 'proposal', what: () => 'the user guide update' },
} as const;
```

The role orders keep today's choices: the BA writes the changelog (GWP-90), the guide order is the one `docsPrepWriter`
uses, and the builder writes videos. The single chooser is `releasePrepTaskPass` in `apps/server/src/release/docs-prep-tasks.ts`.
Its hard-coded `a.role_key = 'builder'` becomes
`a.role_key = ANY($roles) ORDER BY array_position($roles, a.role_key), a.last_shift_ended_at NULLS FIRST, a.hired_at, a.id`.
No other code picks a writer.

### One contract

- **Server to runner, writer work:** `shift.start` with `kind: 'release_prep'` and `releasePrep`
  (`ReleasePrepShiftSchema`). Back comes `aom prep done | fail`, as today.
- **Server to runner, deterministic work:** the `release.docs_prep` command, where `input` comes from `PHASE_INPUTS`, as
  videos already does.
- `payload.writer` is no longer sent.

### Proposal tasks (new): how the text comes back and is checked

1. **Proposal file.** For a proposal kind, `writableFilesFor(task)` returns one file, `PREP_PROPOSAL_FILE =
   'release-prep-proposal.json'` at the worktree root. The agent writes its JSON there and runs
   `aom prep done --summary "…"`. There is no CLI change.
2. **Runner checks first** (supervisor, at `prep_done`, new `finishPrepProposal` in
   `apps/runner/src/git/release-prep-proposal.ts`):
   - Any changed path other than the proposal file is refused.
   - The JSON must parse against the kind's schema (`ReleaseChangelogProposal…` / `GuideProposalSchema`).
   - `guide_edits` only: `applyGuideEdits` plus `checkGuideUpdate` run against the guide in the shift's worktree, with
     the same check context as the apply phase (see the shared helper below).
   - A refusal is returned as `rejected(findings)`, **not** turned into `prep_failed`. The agent fixes it in the same
     shift, as the changelog BA does today. Files tasks keep today's refusal, which ends the task as failed.
   - When accepted, the runner adds `proposal` to the report data, commits nothing and removes the worktree as usual.
3. **Server checks second** (`applyReleasePrepReport`):
   - `changelog_entries`: `checkChangelogProposal(proposal, { uncovered, existingCount, publicText, denyList:
     changelogDenyList(org) })`. When the check fails, the server answers
     `{ accepted:false, error:'The entries were not accepted. Fix these and report again:\n- …' }`, the same text as
     today.
   - `guide_edits`: the schema parse only (the file checks ran on the runner).
   - When accepted, the server calls `finishReleasePrepTask(…, { result })`. `result` is the checked proposal: for the
     changelog `{ entries, covered, skipped }`, for the guide `{ proposal }`.
4. **Runner checks again in the apply phase**:
   - Changelog: `checkChangelog` and `mergeUnreleased`, the existing `changelogStep`.
   - Guide: `applyGuideEdits`, `checkGuideUpdate`, the PDF build, then `checkGuideUpdate` again on the assembled guide.
     This is the existing code with the model call taken out.

   Nothing unchecked reaches a commit (R6).

### One failure model (R4)

Every writer failure is decided in `releasePrepTaskPass` / `endReleasePrepShift` for every kind, and is worded by one
helper, `prepWriterUnavailable(...)` in `packages/shared/src/release/docs-prep-task.ts`:

| Case | When | Message (step label from the registry, `what` from the kind) |
| --- | --- | --- |
| `no_writer` | No active, unpaused, non-DevOps agent of the kind's roles on the repo's workstation (and allowed on the project) | `Write changelog: no agent on <ws> can write the changelog entries. It needs an active BA, architect or builder agent on that workstation. Hire or move one there (or turn the step off), then Retry prep.` plus the kind's manual hint |
| `writer_unreachable` | There are candidates, but none was online with a usable model account within `RELEASE_PREP_QUEUE_LIMIT_MS` (2 h) | `… no agent on <ws> could write <what> within 2 hours (<last reason: the runner is offline / no working model account / every writer was busy>). Check the runner and the agents' model accounts, then Retry prep.` |
| `writer_failed` | The agent ran `aom prep fail`, or ran out of attempts (crash, timeout, no report) | `… <what> could not be written: <reason>` (videos keeps `authorFailure(slug, reason)`) |

`ReleaseDocsPrepTaskFinished` gets an optional `code` (`no_writer | writer_unreachable | writer_failed`). The phase
finishers (`changelog/write`, `guide/write`, `videos/author`) copy the helper's text into the step error unchanged when
the code is `no_writer` or `writer_unreachable`, so every step shows the same sentence. **The fallback is the same for
all steps:** the step fails, nothing is written, the run fails, and Retry and Skip are offered (today's GWP-89 behaviour).
This replaces `runReleaseChangelogFallback`.

**Old runner (protocol).** Add the capability `RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY = 'release-docs-prep-writer-tasks:1'`
(shared `docs-prep-dto.ts`, advertised in `runner.ts` next to `RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY`). Every step
whose definition has a `writerPhase` (changelog, guide, videos) is gated **before its first phase runs**. One helper,
`writerStepGate(tx, run, repoId, step)`, is called in two places: in `dispatchAction`, when the first phase is a runner
phase (guide `check`, videos `plan`), and in the server-phase branch of `advance()`, when the first phase is a server
phase (changelog `write`; `advance` runs server phases inline and never reaches `dispatchAction`). If the workstation
lacks the capability, the gate fails the row with
`<Step label> needs a newer runner on the workstation that has <repo>. Update the runner and retry prep.`. This
replaces the `NEEDS_RUNNER` check in `decideChangelogDispatch`. In the other direction, a new runner that receives an old
server's `guide` command with phase `''` fails with `this runner needs a newer server for Update user guide: update the
server`. Changelog phase `''` keeps working, because `changelogStep` reads `payload.changelog` either way.

## 6. Design for the builder

### 6.1 Shared (`packages/shared/src/release/`)

- `docs-prep.ts`
  - `CHANGELOG_STEP.phases = ['write','apply']`, `serverPhases: ['write']`, `writerPhase: 'write'`.
  - `GUIDE_STEP.phases = ['check','write','apply']`, `serverPhases: ['write']`, `writerPhase: 'write'`.
  - Add `writerPhase?: string` to `ReleaseDocsPrepStepDef`.
  - Labels, order, ids and `requires` do not change.
- `docs-prep-videos.ts`: `VIDEOS_STEP.writerPhase = 'author'`.
- `docs-prep-task.ts`
  - `ChangelogEntriesTaskSchema`: `{ kind:'changelog_entries', projectName, repoName, releaseBranch, changes, existing }`,
    the fields of today's `ReleaseChangelogTask`.
  - `GuideEditsTaskSchema`: `{ kind:'guide_edits', guidePath, changes (with hints), coveredSources }`.
  - Both go into the `ReleasePrepTaskSchema` union.
  - `PREP_TASK_KINDS`, `PREP_PROPOSAL_FILE`, `prepWriterUnavailable`.
  - `writableFilesFor` handles every kind.
  - `renderReleasePrepInstructions` and `renderReleasePrepPrompt` per kind. The video rules stay word for word. The
    changelog prompt uses the built-in playbook `release-notes`, the guide prompt the playbook `user-guide`. Both say
    "write `release-prep-proposal.json` and change no other file".
  - Extend `ReleasePrepTaskResultSchema` with `proposal?: unknown`.
- `docs-prep-dto.ts`
  - The writer-tasks capability.
  - Keep `writer` in `ReleaseDocsPrepPayloadSchema` as optional and ignored for one version, with a comment, so that an
    old server's payload still parses.
- `changelog-task.ts` and `phases/index.ts`: remove the `release_changelog` BA brief and outcomes
  (`RELEASE_CHANGELOG_OUTCOME`, `releaseChangelogBriefOutcomes`). Keep `checkChangelogProposal` and its types.
  `prompt/commands.ts` loses the `release_changelog_*` lines.
- `events`: `ReleaseDocsPrepTaskFinished` gets `code?` and `result?`, both optional, so old events stay valid.

### 6.2 Server (`apps/server/src/release/`)

- **Migration** `<next>_release_prep_task_result.sql`: `ALTER TABLE release_docs_prep_tasks ADD COLUMN result jsonb,
  ADD COLUMN code text;`. The projector stores `result` (capped at 256 KB serialised; above that, the server refuses the
  report with "the proposal is too large (N KB, max 256 KB): propose fewer or shorter edits") and `code`. The migration
  is DDL only, so no data script is needed.
- `docs-prep-tasks.ts`
  - Role-aware chooser (see 5).
  - `prepWriterUnavailable` messages and `code`, plus a last-seen reason per task (offline, no account, busy) for the
    2-hour message.
  - `taskLabel` per kind.
  - `buildReleasePrepShiftStart`: the title per kind (`Write the changelog entries (<branch>)`,
    `Update the user guide (<branch>)`, the video title as now).
  - `applyReleasePrepReport`: call `checkPrepProposal(kind)` for proposal kinds, then `finishReleasePrepTask(..., { result })`.
- **New `docs-prep-writer.ts`**: the server phases `changelog/write` and `guide/write`, their finishers, and `PHASE_INPUTS`
  for `changelog/apply` and `guide/apply`.
  - `changelog/write`: `changelogDispatchFor`.
    - `fail`: the phase fails with the reason.
    - `apply`: passed, report `{ entries: 0 }`.
    - `write`: queue one `changelog_entries` task, built by today's `buildReleaseChangelogTask` code (moved here), and
      return `running`.
  - Finisher: the task is done, so the phase passes with report `{ entries: n, covered: n, skipped: n }`, or fails with
    the unified error.
  - `changelog/apply` input: the done task's `result`, or `entries: []`. `dispatchAction` sends it as today's
    `payload.changelog = { projectName, entries, proposal:{covered,skipped} }` (old runners can apply it).
  - `guide/write`: read the `guide/check` report. No uncovered changes means skipped with `no new changes`. Otherwise
    queue one `guide_edits` task with `{ guidePath, changes, coveredSources }`.
  - `guide/apply` input: `{ proposal }`, or nothing.
  - Register these in `SERVER_PHASES` / `PHASE_INPUTS` (in `docs-prep-videos.ts` today; move the three maps to
    `docs-prep-writer.ts` or a small `docs-prep-phases.ts` so that they are not owned by videos).
- `docs-prep.ts` `dispatchAction`:
  - Remove the changelog BA branch and the `needsWriter` / `docsPrepWriter` branch.
  - Add `writerStepGate` on the first phase of a `writerPhase` step, here and in the server-phase branch of `advance()`
    (see 5).
  - Apply `DOCS_PREP_STEP_HOOKS[step].stepInput` to **every** phase of the step (today it applies to phase `''` only), so
    `guide/check` and `guide/apply` both get `guidePath`, `coveredSources` and `denyList: []`.
- `docs-prep-steps.ts`: delete `docsPrepWriter`, `WRITER_ROLES` and `needsWriter`. In `guideCoveredSources`, read the
  rows with `s.step='guide' AND s.phase IN ('','apply')` (old runs and new runs).
- `docs-prep-changelog.ts`
  - Delete `queueChangelogTask`.
  - In `coveredSourcesFor`, use `s.step='changelog' AND s.phase IN ('','apply')`.
  - Remove the capability check from `decideChangelogDispatch`, since the gate is generic now. Keep `NEEDS_ANALYSE` and
    the malformed-file failure.
  - Move `changelogDenyList` here from `docs-prep-changelog-task.ts`.
- `docs-prep-changelog-task.ts`: delete the file, after moving the brief-building code to `docs-prep-writer.ts` and the
  deny list to `docs-prep-changelog.ts`.
- `commands/ba-tasks.ts` and `runner-gateway/ba-task-brief.ts`: remove the `release_changelog` branches. Keep one
  **legacy** branch for tasks queued before the upgrade: a report or fallback for kind `release_changelog` completes the
  task as `cancelled` with "Write changelog now uses a release prep task" and fails that run's changelog row (phase `''`,
  if still running) with `Write changelog was interrupted by an update. Retry prep.`. Leave the kind in
  `ba_tasks_kind_check` (it is history). Mark the branch for removal in 1.7.

### 6.3 Runner (`apps/runner/src/`)

- `git/release-docs-prep-guide.ts`: split `runGuideStep` by `ctx.phase`.
  - `check`:
    - Input and path checks as today.
    - **No guide:** `{ ok:true, state:'skipped', note:'skipped: no user guide in this repository', files:[], output:{…empty('passed'), skipped:'no user guide'} }`.
    - No summary: fail, as today.
    - Pre-check errors: fail, as today.
    - Nothing uncovered: passed, with report `{ changes: [] }`.
    - Otherwise: passed, with report `{ guidePath, changes }`, where `changes` are the uncovered items with their
      `locateSections` hints, capped to fit `REPORT_MAX_BYTES`. The section texts are not sent, because the writer reads
      the guide in its worktree.
  - `apply`:
    - No `input.proposal`: passed with output `nothing:'no new changes'` (the output is the same as today).
    - Otherwise: `attempt(proposal)` on the real guide, then write it, the PDF build, the post-check and the outside-files
      check (the current lines 223-330, unchanged).
    - A refusal here fails the step with `the guide update was refused: …`. The writer has gone by this point. It can
      only happen if the work moved between the shift and the apply phase.
  - Phase `''`: fail with "needs a newer server" (see 5).
  - Move `checkCtx` and `attempt` into exported helpers (`guideCheckContext(wt, guidePath, denyList)`,
    `tryGuideEdits(before, edits, ctx)`). `finishPrepProposal` and `apply` both use them, so the check is the same code
    in both places.
- `git/release-docs-prep-changelog.ts`: unchanged. It ignores the phase and applies `payload.changelog`.
- `git/release-docs-prep.ts` `keepWork`: the commit label stays `docs(release): <step>` when the phase is `apply`. Only
  the work commits are affected, and the squash message does not change.
- **New `git/release-prep-proposal.ts`**: `finishPrepProposal(wt, rp)`.
  - Changed files must be exactly `[PREP_PROPOSAL_FILE]`, or empty with the file present but untracked.
  - It reads and parses the JSON. For guide only, it runs `tryGuideEdits` against `<wt>/<guidePath>`.
  - It returns `{ ok:true, proposal }` or `{ ok:false, findings }`.
- `shifts/supervisor.ts` around line 2810: when `PREP_TASK_KINDS[rp.task.kind].result === 'proposal'`, call
  `finishPrepProposal`. A refusal goes back through `rejected('The proposal was not accepted. Fix these and run aom prep done again:\n- …')`
  so the agent stays in the shift. When accepted, `toSend.data = { ...data, proposal }`. Files kinds keep `finishPrepTask`.
- Delete `git/release-docs-prep-model.ts` and its test. Remove `runModel` from `DocsPrepStepContext` and
  `ReleaseDocsPrepInput`, `noModel`, and the `docsPrepModel` wiring in `runner.ts` (lines 128 and 2209-2213). Advertise
  the new capability.
- `aom/aom-cli.ts`: remove `report release-changelog` and `report release-changelog-fail` from the usage text and the
  switch (lines 449-450, 501-507 and 2869). `prep done` and `prep fail` do not change.

### 6.4 Web

`apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx` already lists one row per (step, phase) for videos, so the
new phases show as `changelog (write)`, `changelog (apply)`, `guide (check)`, and so on. The step names and their order
do not change.

- Show `ChangelogStepOutput` on the `apply` (or `''`) row, and on the `write` row only while it is running, so that
  "Writing entries…" still shows while the writer works.
- Show `GuideStepOutput` where the output is (the `apply` or `check` row; the existing `s.output != null` test already
  does that).

### 6.5 Docs

- `docs/RUNNER.md`, release prep workstation needs: "Write changelog and Update user guide need an active agent (BA,
  architect or builder; videos: a builder) with a working model account **on the workstation that has the repository**.
  A BA elsewhere is no longer used." Also mention the new capability and that the runner must be updated.
- Add a short pointer section to `docs/investigations/GWP-90…`, `GWP-91…` and `GWP-92…`: "Superseded by GWP-134: the
  writer is a release prep task". Do not rewrite their bodies.
- `docs/ARCHITECTURE.md`, release prep section, if it describes the BA task or the headless call: replace that with the
  shape in 5.
- `USER-GUIDE.md`, the release prep section: the new phase rows, the one "no writer" message, and "a repository without a
  user guide shows Update user guide as skipped".

## 7. Videos extension point (R3)

Videos already runs on the mechanism. The only change is that its writer is now chosen through `PREP_TASK_KINDS.new_video.roles`
and its no-writer message comes from `prepWriterUnavailable`.

Any further content step plugs in like this:

1. Add a task kind with its schema in `docs-prep-task.ts`.
2. Add a `PREP_TASK_KINDS` entry: roles, `result: 'files' | 'proposal'`, `what`.
3. Add the step definition with `phases` / `serverPhases` / `writerPhase`.
4. Register a server phase that queues tasks, and a phase finisher.
5. If the result is a proposal: write a runner and/or server check.
6. Add a runner handler for the deterministic phases.

None of these steps adds a writer path. A test pins this (see 9, server 4).

## 8. Risks

- **Changelog writer location.** A BA on another workstation no longer writes the changelog. If the repo's workstation
  has no BA, architect or builder, Write changelog now fails with the `no_writer` message where it used to work. That is
  unlikely, because the repo's workstation builds its cards. The message names the fix. Owner-visible, so it goes in
  RUNNER.md.
- **Proposal size.** Guide proposals can reach about 100 KB (40 edits). The `shift.report` frame, the task `result` and
  the command payload must all carry it. The builder checks the gateway's frame limit and keeps the 256 KB cap below it.
- **Phase rows** are a visible change in the run view (new sub-rows). Step names and order do not change. Update the e2e
  `e2e/tests/release-docs-prep.spec.ts` selectors that use `prep-step-note-changelog-` and `-guide-` (now with the phase
  suffix). Testers run that suite.
- **In-flight runs at upgrade:** a run waiting on an old BA task is handled by the legacy branch (6.2). A guide row in
  phase `''` that is still running is failed by the 12-hour sweep, or by the user with Retry or Skip.
- **Group sibling GWP-135** ("changelog writer: tidy-ups found in review") is the next card in the group. Most of the BA
  path it would tidy is deleted here. Its investigation should check, against this branch once merged, which tidy-ups
  still apply.
- The guide `denyList` stays `[]`, as today, because turning the scrub on for the guide would change what passes. That is
  a separate decision, offered as a follow-up.

## 9. Acceptance criteria mapping and tests

| AC | Where it is met | Test (builder unless marked) |
| --- | --- | --- |
| R0 recorded with references | Section 2 of this report, plus the card comment | n/a |
| Decision and reasons on the card and in a doc | Section 5, plus the pointers in GWP-90/91/92 docs and RUNNER.md | n/a |
| One place chooses the writer; one server/runner contract | `PREP_TASK_KINDS` + `releasePrepTaskPass`; `release_prep` shift + `release.docs_prep` `input` | Server 1, 2; Runner 3 |
| Videos uses it or documented extension point with test | Section 7 | Server 4 |
| No writer means the same failure for every step, one message; tests for changelog and guide | `prepWriterUnavailable` + `code` | Server 3 |
| No guide means skipped (not failed), no writer or BA, run continues; test | Guide `check` phase skip, planner rule | Runner 1; Server 5 |
| Invalid proposal rejected under the new mechanism | Runner `finishPrepProposal` + server `checkChangelogProposal` | Runner 2, 4; Server 6 |
| Same commits and identity; existing tests pass | `keepWork` / squash unchanged; changelog handler unchanged | Runner 5; existing suites |
| No change in guildwise-cloud | All files above are in GuildwiseHQ | n/a |

**Runner** (`apps/runner/test/`):

1. `release-docs-prep-guide.test.ts`
   - check with no guide gives `state:'skipped'` and the note `skipped: no user guide in this repository`;
   - check with uncovered changes gives a report with the changes and hints;
   - apply with a valid proposal writes the guide and runs the PDF steps (existing fake `exec`);
   - apply with no proposal gives `nothing:'no new changes'`;
   - phase `''` gives the "newer server" failure.
2. New `release-prep-proposal.test.ts`
   - a valid guide proposal is accepted;
   - edits that break the TOC or structure are refused with the `checkGuideUpdate` findings;
   - a changed file other than the proposal is refused;
   - invalid JSON is refused;
   - a changelog proposal that is only shape-checked is accepted.
3. Supervisor report path (`supervisor.test.ts`, next to the existing `finishPrepTask` cases in
   `release-docs-prep-videos.test.ts`)
   - for a proposal kind, a refused `aom prep done` comes back as a rejected report and the shift continues; an accepted
     one sends `proposal` and makes no commit;
   - `new_video` behaviour does not change.
4. `release-docs-prep-changelog.test.ts`: unchanged. Add a case that phase `apply` behaves like phase `''`.
5. `release-docs-prep.test.ts`: changelog apply plus guide apply in one run produce work commits with the `commitAs`
   identity, and the squash commit message does not change.
6. Delete `release-docs-prep-model.test.ts`.

**Server** (`apps/server/test/`: `release-prep-shift.test.ts`, `release-docs-prep*.test.ts`; DB-backed suites are for
testers if they need Postgres):

1. Writer selection: one chooser. `changelog_entries` prefers ba, then architect, then builder; `guide_edits` prefers
   architect, then ba, then builder; `new_video` takes builders only. All on the repo's workstation.
2. `release-docs-prep-changelog-flow.test.ts` rewritten:
   - write queues a `changelog_entries` task, not a BA task;
   - an accepted report stores `result`, and apply is sent with `payload.changelog` entries;
   - nothing new: write passes and apply gets `entries: []` with no task.
3. No writer: with no agents on the workstation, changelog/write and guide/write both fail with the
   `prepWriterUnavailable('no_writer')` text, and the run fails with Retry and Skip available. The 2-hour case gives
   `writer_unreachable` for both.
4. Extension point: a stub task kind registered in a test, with a server phase and a finisher, runs through
   `releasePrepTaskPass` without any new chooser.
5. No guide: guide/check reported `skipped`, so guide/write and guide/apply are skipped, no task is queued and no agent
   is looked up, and the run reaches `commit` and passes with no agents on the workstation.
6. An invalid changelog proposal (an uncovered source missing, or a deny-list name) gets `accepted:false` with the
   findings, and the task stays running. A valid one afterwards is accepted.
7. Capability gate: a workstation without `release-docs-prep-writer-tasks:1` fails the step before dispatch with the
   "newer runner" message.
8. Legacy BA task: a `release_changelog` report is cancelled, and the run's changelog row fails with the retry message.
9. `guideCoveredSources` and `coveredSourcesFor` read both `''` rows and `apply` rows.

**Shared**: `release-docs-prep-task.test.ts` covers the new schemas, `writableFilesFor` per kind and the
`prepWriterUnavailable` texts. `release-docs-prep.test.ts` covers the planner: a skipped changelog/guide first phase skips
the later phases; changelog and guide `write` are dispatched by the server.

**Left for testers:** the server DB suites (Postgres), `e2e/tests/release-docs-prep.spec.ts`, and manual steps 4 to 6
of the card's test plan on a workstation.

Typecheck and lint: `apps/server`, `apps/runner`, `packages/shared`, `apps/web`.
