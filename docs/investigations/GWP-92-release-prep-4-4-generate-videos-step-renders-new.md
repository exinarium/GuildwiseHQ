# GWP-92 Release prep (4/4): the 'Generate videos' step

Revised on 2026-11-04 after GWP-89 landed in `main`. Section 0 lists what the landed code changed. Sections 5.0, 5.3,
5.5, 5.7, 5.9 and 9 are updated to match. The mapping rule, the preflight, the voice ruling and the render logic are
unchanged.

## 0. Assumption review against the landed GWP-89 code

| # | Assumption | Verdict | What the landed code does | Change in this design |
| --- | --- | --- | --- | --- |
| A1 | Registry, handler map, kept work ref, local step commits, a failed step fails the run before Commit results | **Holds** | `packages/shared/src/release/docs-prep.ts` (`STEPS`, `releaseDocsPrepSteps`, `enabledReleaseDocsPrepSteps`), `apps/runner/src/git/release-docs-prep-steps.ts` (`DOCS_PREP_STEP_HANDLERS`), `refs/guildwise/docs-prep/<runId>/work` with a local commit per content step (`contentStep`), `nextReleaseDocsPrepAction` finishes the run as failed on the first failed step row | None. The handler signature is widened in 5.0 (for A2, A4 and A6) |
| A2 | A step can run in several phases | **Does not hold** | Phases are hard-coded for `commit` only: `phases = step === 'commit' ? ['prepare','push'] : ['']` in `nextReleaseDocsPrepAction` and in the `ReleaseDocsPrepStarted` projector; `phase` is `z.enum(['prepare','push'])` in the payload and both events | 5.0 (a): `phases` on the step definition, a phase run by the server, and a skip action |
| A3 | A handler may manage its own worktree and take the lock only around git | **Does not hold** | `runReleaseDocsPrep` wraps the whole command, including the handler, in `withRepoLock`. `contentStep` runs the handler inside `withIntegrationWorktree` | 5.0 (b): an `unlocked` phase list on the handler entry; lock only for the prelude and for keeping the work. Plus single flight against redelivery (see the new risk below) |
| A4 | Step results carry a per-step report that is stored and rendered per step id | **Does not hold** | `ReleaseDocsPrepResultSchema` has no report; `release_docs_prep_steps` has no report column; `notices` are dropped by the server; the Releases tab (`RunView` in `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`) shows only state and error per step | 5.0 (c): `report jsonb` on the step row, in the result and the event, in the run DTO; a renderer map by step id in `RunView` |
| A5 | A non-card `release_prep` agent shift exists or is shared with GWP-90/91 | **Does not hold** | Nothing exists. GWP-90 and GWP-91 have not landed (their branches are at the GWP-89 merge). The nearest pattern is `ba_tasks` with shift kind `ba_task` (`apps/server/src/projections/phases.ts`, `sessions/delegate.ts` `SHIFT_KINDS`) | Fallback as planned: this card builds it generically (5.7). The same builder works GWP-90 and GWP-91 first: if either lands an equivalent, reuse it |
| A6 | A per-repo step state `skipped` counts as finished, and that repo still reaches Commit results | **Partly holds** | The planner treats a `skipped` row as finished (only `pending` is dispatched, only `failed` fails), and the repo row becomes `skipped` only for a skipped `analyse`, so the repo still reaches commit. But a handler cannot return `skipped` (its result is `{ok, files}` and `contentStep` always answers `passed`), and nothing skips the later phases of a step | 5.0 (a) and (c): the handler may return `state: 'skipped'` with a note; the planner skips the later phases of a step whose earlier phase was skipped |
| A7 | The summary carries `base.sha` and `headSha` per repo; the step computes the full diff | **Holds** | `ReleaseDocsPrepSummary.base.sha` and `.headSha`; the payload also carries `base: {sha, tag}`; the summary keeps 50 paths per area, so the full diff is still computed by the step | None |

New facts the design did not know:

- **Redelivery.** The runner runs every command concurrently (`void this.runCommand(...)`), but on a reconnect
  `requeueSentCommands` hands every `sent` command out again. A render that takes an hour would be started a second time
  after a network blip. 5.0 (b) adds single flight.
- **Paths.** The video Playwright config is `e2e/video/playwright.video.config.ts`, not at the root. The Release prep
  panel on the Releases page is `RunView` in `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`;
  `apps/web/src/components/ReleaseDocsPrepPanel.tsx` is the project settings checklist.
- **Skipped notes look like errors.** `RunView` prints `s.error` in the danger colour for every state, and GWP-89 puts
  the note of a skipped step in `error` (as `analyse` does for a missing release branch). 'skipped: no videos' must not
  look like a failure (5.9).
- **Phase order in the DTO.** `runDto` orders phases with `a.phase < b.phase ? 1 : -1`, which only works for
  `prepare`/`push`. `plan`/`author`/`render` must be ordered by their index in the step definition (5.0 a).

## 1. Question

Add a 'Generate videos' step to the release prep registry of GWP-89. It is off by default even when prep is on. For every
repository with a video harness, the step:

- works out from the change analysis which existing help videos show a screen that changed, and which new user-visible
  screens have no video;
- re-renders exactly those videos with the existing harness;
- has an agent write a new spec in the existing style for each new screen, then renders it;
- keeps the current voice;
- writes the files where the existing videos are kept;
- reports each video with its reason and any error.

Repositories with no harness are skipped. The step never commits, and an unchanged re-run does not render again. The
architect fixes the rule that maps changes to videos, and the step output must show it.

## 2. Findings

### 2.1 The help-video pipeline today (GuildwiseHQ)

- **One spec per video.** There are 32 specs in `e2e/video/<slug>.spec.ts`, each with `e2e/video/narration/<slug>.ts`
  (cues and chapters). The template is `e2e/video/template/slug.spec.ts` plus `narration/slug.ts`. A spec seeds demo data
  through the API, then calls `prepareVideo` (which speaks every cue first) and `startRecording` (Playwright
  `recordVideo` 1280x720, with overlays, `narrate`, `chapter` and `finish`).
- **Output.** `finish()` in `e2e/video/harness.ts` writes `OUT_DIR/<slug>.webm|.mp4|.vtt|.json`. `OUT_DIR` is
  `AOM_VIDEO_OUT` or `media/videos`. The voice is mixed in with `mux`, the MP4 comes from `toMp4`, and the captions from
  `vtt(timeline)`. The sidecar JSON holds `{title, src, type, sources[], captions, voice: VOICE_LABEL, duration,
  chapters}`. The WebM and the MP4 must each stay under 20 MB (`maxMb`), or the spec fails. One trap: if `mux` fails, the
  raw silent recording is copied to the destination before the error is thrown, so a failed run can leave a silent
  `.webm` in `OUT_DIR`.
- **A list of videos can already be rendered.** `e2e/video/record.sh <slug>...` records each slug on a fresh stack
  (`AOM_VIDEO_SLUG=<slug> pnpm --filter @aom/e2e video`), prints `== <slug> FAILED`, and exits 1 if any video failed. Each
  run needs its own `AOM_VIDEO_PORT` and `AOM_VIDEO_DB`. It also needs `pnpm build` first (the stack runs the built
  server, web and runner), Postgres on 127.0.0.1:5433, Mailpit on 1025/8025, Playwright browsers, the voice and ffmpeg
  (`e2e/video/setup-voice.sh` puts them in `~/.cache/aom-video`).
- **The voice.** `packages/video/src/voice.ts` uses `ENGINE = kokoro` unless `AOM_VIDEO_TTS=piper`, and
  `VOICE = AOM_VIDEO_VOICE ?? 'af_heart'`. `voiceAvailable()` checks the Kokoro python, the model and the voices file.
  `speak()` throws when the voice is missing, so the harness can never render silently. All 33 sidecars in
  `media/videos/*.json` say `"voice": "Kokoro af_heart"`. `af_heart` is an American voice. The only British voice in the
  code is the old Piper `en_GB-cori-high`.
  **Owner ruling:** use the configured voice, Kokoro `af_heart`, exactly as `voice.ts` resolves it with no override.
  'British' in the card describes the current voice incorrectly. Section 5.6 has the build rules.
- **The voice check works without a build.** Node 22.23 strips types, so
  `node --input-type=module -e "const m = await import('<worktree>/packages/video/src/voice.ts'); ..."` returns
  `voiceAvailable()` and `VOICE_LABEL` from the repo's own code. On this machine it returns
  `{available: false, label: 'Kokoro af_heart'}`: the voice is not installed here.
- **Where videos are used.**
  - `apps/web/src/lib/videos.ts` `SECTION_VIDEOS` maps a slug to `{title, nav, paths?, help, published}`. Nothing links to
    a video unless it is `published`.
  - `forms` is already registered with `published: false` and the comment "the video is made with the user guide for this
    release". It is a real "needs new video" case.
  - The media container serves `media/videos` as `/videos/*`. `media/build-manifest.mjs` builds the manifest from every
    file except dotfiles (`media/videos/manifest.json` is git-ignored).
  - `videoEmbedHtml` (`apps/server/src/blog/render.ts`) embeds YouTube ids for blog and release posts. It reads no local
    files, so it picks up a help video only through the existing YouTube push of `media/videos`. Writing the four files and
    the registry entry is therefore all that is needed: nothing else changes.
- **`renderVideo` (packages/video/src/render.ts)** renders blog and YouTube *scripts* made of clips of the help videos. It
  does not render help videos, so this step does not call it. It reuses `speak`, `mux`, `toMp4`, `vtt` and `findFfmpeg`
  through the harness, which is the "no second renderer" constraint.
- **guildwise-cloud** has `e2e/tests` but no `e2e/video`, so it has no harness.
- **Shared code to reuse.** `globToRegExp` (`packages/shared/src/workflows/high-risk.ts`) matches `**`/`*`/`?` path
  globs. `withRepoLock` (`apps/runner/src/git/repo-lock.ts`) serializes every git operation on a clone, so it must not be
  held for a render that takes an hour.

### 2.2 What GWP-89 provides (landed)

- `packages/shared/src/release/docs-prep.ts`: `ReleaseDocsPrepStepDef {id, label, description, order, defaultOn,
  producesFiles, last?}`, `STEPS = [ANALYSE_STEP, COMMIT_STEP]` ("sibling steps append one import and one entry here"),
  `enabledReleaseDocsPrepSteps` (`settings.steps[id] ?? defaultOn`), the pure planner `nextReleaseDocsPrepAction` and the
  ship gate. Order 40 is free for videos.
- `packages/shared/src/release/docs-prep-dto.ts`: the summary (`headSha`, `base {kind, sha, tag|branch}`, commits 300,
  merges with `cardKeys`, cards, areas with 50 paths each), the payload (`step`, `phase`, `summary`, `base`, `commitAs`,
  ...) and the result (`ok, state, error, files, notices, summary, commit, ...`).
- One runner command `release.docs_prep` per (step, phase, repo), dispatched by `advance()` in
  `apps/server/src/release/docs-prep.ts` to the repo's recorded workstation, answered through
  `applyReleaseDocsPrepResult`.
- Content steps: `DOCS_PREP_STEP_HANDLERS[step](ctx: {worktree, payload, summary}) => {ok:true, files} | {ok:false,
  error}`. `contentStep` runs it in an integration worktree started from the work ref (or the analysed head), refuses any
  change outside `files`, commits locally (`docs(release): <step>`) and moves `refs/guildwise/docs-prep/<runId>/work`.
  Nothing is pushed until `commit/push`.
- Handler contract: "a step must produce byte-identical files when its content is already on the branch".
- A failed step fails the run, Commit results is never reached and the ship gate stays closed.
- The 12-hour sweep (`releaseDocsPrepSweep`) fails a running step row that got no answer.

## 3. Options

### 3.1 The mapping rule: changed files to videos

| Option | Pro | Con |
| --- | --- | --- |
| A. Derive everything automatically (spec `goto`/nav clicks, then routes in `router.tsx`, then page components, then the import closure) | No file to maintain | Parses TSX in the runner. Shared components (shell, ui) put every video in the closure, so a release would re-render the whole library, which the card forbids. The result is hard to explain in the output |
| B. Re-render every video whose `nav` area has any changed file | Simple | Too coarse: only 21 specs start on `/p/SHOP/board`, and areas are folders, not screens |
| **C. A checked-in screen map `e2e/video/screens.json`, matched with path globs, plus fixed rules for shared, unmapped and new pages** | Exact, reviewable, the same rule in the runner, the tests and the output; a web unit test keeps it complete | Has to be kept up to date (the test enforces it, and the authoring agent adds the entry for each new video) |

**Choice: C.** Section 5.2 has the rule.

### 3.2 Who writes the spec for a new video

| Option | Verdict |
| --- | --- |
| The runner starts the AI runtime itself inside the `release.docs_prep` command | Rejected: the run would not be a shift. Its cost, budget, Claude account choice, logs and live progress would bypass the existing shift machinery and be invisible to the owner |
| Fail with "needs new video" and leave it to a card | Rejected: AC 2 requires the spec to be written and rendered within the run |
| **A short non-card agent shift (kind `release_prep`), dispatched by the server in the step's `author` phase** | Chosen: it reuses the supervisor, the sandbox, accounts, costs and logs, as BA tasks already do. Built generically so GWP-91 (guide text) can use it too |

### 3.3 Where idempotency is recorded

Rendered videos are never byte-identical: recording timing varies. GWP-89's contract ("byte-identical when already on the
branch") can therefore only hold if the step *skips* a render whose inputs have not changed.

| Option | Verdict |
| --- | --- |
| A new key in the sidecar `<slug>.json` | Rejected: AC 3 asks for the same output format |
| `media/videos/.renders.json` | Rejected: it would be served under `/videos/` and sits in the media folder |
| **`e2e/video/renders.json` beside the specs (committed by Commit results), plus a render cache in the runner's data dir for retries of a failed run** | Chosen: no change in the media folder, it lives in git with the specs, and it is deterministic |

### 3.4 Lock and worktree

A video render takes 1 to 15 minutes (overview is about 12), plus `pnpm install` and `pnpm build`. Holding `withRepoLock`
for that long would stall every card shift on the clone. GWP-89 holds the lock for the whole command, so **this card
adds an `unlocked` opt-out to GWP-89's runner wrapper** (5.0 b): the lock is held only for the prelude (fetch, tip,
worktree add) and for keeping the work (add, commit, update-ref, worktree remove).

## 4. Recommendation

Build option C with a three-phase step: `plan` (runner, deterministic), `author` (server-dispatched `release_prep`
shifts, only when a new video is needed) and `render` (runner, `record.sh`-equivalent per slug, staged output, outside
the repo lock).

- First generalise GWP-89's frame (5.0): phases on the step definition, a server-run phase, skipped later phases, an
  unlocked handler phase with single flight, and a stored per-step report with a renderer per step id.
- The voice and environment are checked before anything else.
- Idempotency comes from `e2e/video/renders.json` input hashes and a runner-side render cache.

There is no change to `voice.ts`, the harness look, `renderVideo`, or `media/` (apart from the rendered files).

## 5. Design

### 5.0 Frame changes to GWP-89 (new in this revision)

These are generic. They keep `analyse` and `commit` behaving exactly as today; the GWP-89 tests
(`packages/shared/test/release-docs-prep.test.ts`, `apps/runner/test/release-docs-prep.test.ts`,
`apps/server/test/release-docs-prep.test.ts`, `apps/web/src/test/release-docs-prep.test.tsx`) must stay green unchanged.

**(a) Phases (A2, A6).** In `packages/shared/src/release/docs-prep.ts`:

```ts
export type ReleaseDocsPrepPhase = string;           // '' for a single-phase step
export type CommitPhase = 'prepare' | 'push';        // kept for the commit code
export interface ReleaseDocsPrepStepDef {
  /* ...existing fields... */
  /** Run in this order, every phase in every repo before the next phase. Default: one unnamed phase. */
  phases?: readonly string[];
  /** Phases the server runs itself (an agent shift), not a runner command. */
  serverPhases?: readonly string[];
}
COMMIT_STEP.phases = ['prepare', 'push'];
export const stepPhases = (id: string): readonly string[] => releaseDocsPrepStep(id)?.phases ?? [''];
```

- `nextReleaseDocsPrepAction` uses `stepPhases(step)` instead of `step === 'commit' ? ... : ['']`.
- New rule in the planner, before dispatching phase `k` of a step in a repo: if an earlier phase of the same step is
  `skipped` in that repo, return `{kind: 'skip', step, phase, repoIds, note}` (the note of the skipped phase). The server
  appends `ReleaseDocsPrepStepFinished {state: 'skipped', error: note}` for those rows in the same transaction and calls
  `advance` again (loop, bounded by the number of rows).
- A dispatch of a phase listed in `serverPhases` carries `by: 'server'`. `advance()` hands it to the step's server
  module (`apps/server/src/release/docs-prep-videos.ts` for `videos`) instead of `enqueueRunnerCommand`. That module may
  answer at once with "nothing to do" (no new videos), which is a `skipped` finish with the note `no new videos`.
- Payload and event schemas: `phase` becomes `z.string().max(20).optional()` (a widening: stored `prepare`/`push`
  events still parse). `applyReleaseDocsPrepResult` accepts a phase only if `stepPhases(step)` lists it.
- The `ReleaseDocsPrepStarted` projector creates one row per `stepPhases(step)` (import from `@aom/shared`).
- `runDto` sorts a repo's steps by run order, then by the phase's index in `stepPhases(step)`.
- Reset for the repair round (5.4): new event `ReleaseDocsPrepStepReset {runId, repoId, step, phase, attempt}`. Its
  projector sets the row back to `pending` (error, files, finished_at cleared, report kept) with the new `attempt`.

**(b) Unlocked handler phases and single flight (A3).** In `apps/runner/src/git/release-docs-prep-steps.ts`:

```ts
export interface DocsPrepStepContext {
  worktree: string;
  payload: ReleaseDocsPrepPayload;
  summary: ReleaseDocsPrepSummary | undefined;
  phase: string;                         // '' for a single-phase step
  input: Record<string, unknown> | undefined;   // payload.input (e.g. the plan for 'render')
  repoPath: string;                      // read-only use: git show / ls-tree / log
  dataDir: string;                       // the runner's data dir (render cache)
}
export type DocsPrepStepOutcome =
  | { ok: true; files: string[]; state?: 'passed' | 'skipped'; note?: string; report?: Record<string, unknown> }
  | { ok: false; error: string; report?: Record<string, unknown> };
export type DocsPrepStepHandler = (ctx: DocsPrepStepContext) => Promise<DocsPrepStepOutcome>;
export interface DocsPrepStepSpec { run: DocsPrepStepHandler; unlocked?: readonly string[] }
export const DOCS_PREP_STEP_HANDLERS: Record<string, DocsPrepStepHandler | DocsPrepStepSpec> = {};
```

In `apps/runner/src/git/release-docs-prep.ts`:

- Extract from `contentStep` a `keepWork(wt, out, identity, p)` helper (add, status check against `files`, commit,
  update-ref) so the locked and unlocked paths share it.
- Locked phase: as today.
- Unlocked phase (`videos/render`): lock #1 does the existing prelude (ref checks, fetch, tip, identity, start ref)
  plus `git worktree add --detach <integrationDir>/docs-prep-<repoId>-<step>-<phase> <start>`. The lock is released.
  The handler runs. Lock #2 runs `keepWork` and removes the worktree; the removal also runs in a `finally` under the
  lock. The `plan` phase of videos is short and stays locked.
- Single flight: a module-level `Map<'<runId>:<repoId>:<step>:<phase>', Promise<ReleaseDocsPrepResult>>`. A redelivered
  command (after `requeueSentCommands` on a reconnect) joins the running promise instead of starting a second render.
  The entry is dropped when the promise settles. A redelivery after the answer was sent re-runs the phase, and the render
  cache (5.5) makes that a copy, not a render.
- A handler returning `state: 'skipped'` answers `{ok: true, state: 'skipped', error: note, files: []}` (GWP-89's
  convention: the note of a skipped step travels in `error`). `report` is passed through on success and on failure.
- A plain-function entry behaves as today, with the wider context.

**(c) The per-step report (A4).**

- Migration `apps/server/migrations/<next>_release_docs_prep_step_report.sql` (the next free number after the siblings'
  migrations): `ALTER TABLE release_docs_prep_steps ADD COLUMN IF NOT EXISTS report jsonb, ADD COLUMN IF NOT EXISTS
  attempt int NOT NULL DEFAULT 0;`
- `ReleaseDocsPrepResultSchema.report: z.record(z.string(), z.unknown()).optional()`, the same on
  `ReleaseDocsPrepStepFinished`, written by its projector (`report = COALESCE($n::jsonb, report)`).
- `applyReleaseDocsPrepResult` refuses a report over 64 KB of JSON: it stores `{truncated: true}` and appends
  ` (report too large)` to the error. The videos code caps its own report before sending (5.8), so this is only a guard.
- `ReleaseDocsPrepPayloadSchema.input: z.record(z.string(), z.unknown()).optional()`: the server fills it for a phase
  that needs an earlier phase's report (videos `render` gets `{plan, authored}`).
- Run DTO step: `report: z.record(z.string(), z.unknown()).nullable()`, `attempt: z.number()`.

### 5.1 Registry entry (shared)

`packages/shared/src/release/docs-prep-videos.ts`, registered in GWP-89's `STEPS`:

```ts
export const VIDEOS_STEP: ReleaseDocsPrepStepDef = {
  id: 'videos', label: 'Generate videos',
  description: 'Re-render the help videos whose screens changed and record new ones (slow; needs the voice, ffmpeg and browsers on the workstation)',
  order: 40, defaultOn: false, producesFiles: true,
  phases: ['plan', 'author', 'render'],
  serverPhases: ['author'],
};
```

`defaultOn: false` means that `enabledReleaseDocsPrepSteps` leaves it out unless the owner ticks it, even with prep on.

### 5.2 The screen map and the mapping rule

**The repo-side contract.** A repository *has a video harness* if and only if `e2e/video/screens.json` exists at the
analysed head. Without it, the repo's videos `plan` phase is `skipped` with the note **"skipped: no videos"**, `author`
and `render` are skipped by the planner rule of 5.0 (a), and the run goes on. guildwise-cloud needs no change.

`e2e/video/screens.json` (new in GuildwiseHQ; zod schema `VideoScreenMapSchema` in the shared module):

```jsonc
{
  "version": 1,
  "ui": ["apps/web/src/**"],                      // only these files can select a video
  "pages": ["apps/web/src/pages/*.tsx", "apps/web/src/pages/platform/*.tsx"],  // page-level files (new-video detection)
  "shared": ["apps/web/src/components/shell/**", "apps/web/src/components/ui/**", "apps/web/src/index.css",
             "apps/web/src/tokens.css", "apps/web/src/router.tsx", "apps/web/src/main.tsx", "apps/web/src/api/**",
             "apps/web/src/hooks/**", "apps/web/src/lib/**", "apps/web/src/ws/**", "apps/web/src/test/**", "**/*.test.*"],
  "exclude": ["apps/web/src/pages/Login.tsx", "apps/web/src/pages/ForgotPassword.tsx",
              "apps/web/src/pages/ResetPassword.tsx", "apps/web/src/pages/AcceptInvite.tsx",
              "apps/web/src/pages/ChangePasswordRequired.tsx", "apps/web/src/pages/SecuritySetup.tsx",
              "apps/web/src/pages/DeskActionConfirm.tsx"],          // screens that never get a video
  "videos": {
    "backlog": { "screens": [
      { "name": "Backlog", "files": ["apps/web/src/pages/Backlog.tsx", "apps/web/src/components/backlog/**"] } ] },
    "releases": { "screens": [
      { "name": "Releases", "files": ["apps/web/src/pages/Releases.tsx", "apps/web/src/components/delivery/**"] } ] }
    // ... one entry per e2e/video/*.spec.ts
  },
  "planned": {                                    // registered screens that still need a first video
    "forms": { "title": "Forms: build a form",
               "pages": ["apps/web/src/pages/Forms.tsx", "apps/web/src/pages/FormBuilderPage.tsx"] }
  }
}
```

The builder seeds `videos` once. For every spec: the page file of its `nav` route (from nav-config `to` to the route in
`router.tsx` to the page file), the component folders or files that page imports directly (excluding `shared`), and the
extra pages the spec visits (its `page.goto(...)` and `nav-*` clicks). For example, `desk` visits `/desk` and card
pages. `overview` and `getting-started` cover many screens: list their screens honestly. Rule 3 applies to them the same
way. Check each glob against the files at the time of seeding (the web test below enforces it).

**The rule** (pure: `mapChangesToVideos(input)` in `docs-prep-videos.ts`; the step output carries a fixed one-line text
of it, `VIDEO_RULE_TEXT`):

Input:

- `changes: {path, status: 'A'|'M'|'D'|'R', oldPath?}[]`, the full diff of `base.sha..<start>` where `<start>` is the
  commit the step's worktree starts from (the work ref, else `summary.headSha`). It is computed in the runner
  (`git diff --name-status -z -M`), because the summary keeps only 50 paths per area. `base.sha` comes from
  `payload.base.sha` (or `summary.base.sha`).
- the map;
- the spec slugs present (`e2e/video/*.spec.ts`);
- `commitsByPath` (card keys per path, from `git log --format=%H%x00%B --name-only base..start`), used to name the
  reasons.

Rules, in order, for each changed path:

1. **Script changed.** `e2e/video/<slug>.spec.ts` or `e2e/video/narration/<slug>.ts` changed: select `<slug>`, reason
   `script changed: <path>`.
2. **Shared UI.** The path matches `shared`: it selects nothing and is listed under "shared UI changed (no video
   re-rendered by rule)". This is what keeps a sidebar or token change from re-rendering the whole library.
3. **Screen changed.** The path matches the `files` of screen S in `videos[slug]`: select `slug`, reason
   `screen <S.name> changed: <path>[ (<card keys>)]`. Every video that lists the path is selected. Reasons are grouped
   per video and screen as the first 5 paths plus "and N more".
4. **New screen.** The path matches `pages`, is in no video's screens and not in `exclude`, and has status A or M:
   - if a `planned` entry lists the path, add **needs new video** `<planned slug>` (reason
     `new screen <title>: <path>`);
   - otherwise add **needs new video** `<kebab(stem)>` (for example `JourneyDesigner.tsx` becomes `journey-designer`),
     with the title from the file stem.
   Several pages of one planned entry give one video.
5. **Unmapped UI.** The path matches `ui` but none of the above: listed as "UI files with no video (nothing
   selected)".
6. **Not UI** (server, runner, docs, harness, packages): ignored. The output shows only the count.

Deleted page files (D) never ask for a new video. When a selected video's spec no longer exists, the reason gets the note
"spec missing" and that video fails.

Output: `{rule, selected: [{slug, reasons[]}], newVideos: [{slug, title, pages[], reasons[]}], shared: string[],
unmapped: string[], ignoredCount}`, sorted by slug.

**Keeping it honest.** Add a web unit test `apps/web/src/test/video-screens.test.ts` that reads `e2e/video/screens.json`
and checks that:

- it parses with the schema;
- every `e2e/video/*.spec.ts` has a `videos` entry, and every entry has a spec;
- every published `SECTION_VIDEOS` slug has an entry, and every unpublished one is in `planned`;
- every glob matches at least one file;
- every page in `pages` is in a video, in `planned` or in `exclude`. This makes a new page in a feature card fail the
  test until it is mapped or planned, so the step never has to guess.

### 5.3 Phase `plan` (runner, deterministic, short, under the lock)

Handler `videos` (a `DocsPrepStepSpec` with `unlocked: ['render']`) in
`apps/runner/src/git/release-docs-prep-videos.ts`, branching on `ctx.phase`. For `plan`:

1. Read `e2e/video/screens.json` from the worktree. If it is missing, return
   `{ok: true, files: [], state: 'skipped', note: 'skipped: no videos', report: {harness: false, ...}}`.
2. **Voice and ffmpeg preflight** (section 5.6). On failure: `{ok: false, error: 'voice unavailable: <detail>'}` (or
   `ffmpeg unavailable: ...`), with the report. Nothing else runs.
3. Compute `changes` and run `mapChangesToVideos`.
4. **Idempotency.** For every selected slug, compute `inputsHash`. It is a sha256 over the sorted `path blobSha` pairs
   (`git ls-tree -r <start>`) of:
   - the files matched by the video's screens;
   - its spec and narration;
   - the harness set: `e2e/video/{harness,captions,seed,seed-history,seed-deploy,platform,ceo-act,defaults,voice}.ts`,
     `e2e/video/playwright.video.config.ts`, `packages/video/src/{voice,ffmpeg,captions,audio}.ts`;
   - `VOICE_LABEL`.

   If `e2e/video/renders.json` has the same hash for the slug, the action is `up_to_date` (reason
   `already rendered for this release (inputs unchanged since <sourceSha>)`) and the slug is not rendered. A new video has
   no hash before it is authored.
5. Return `{ok: true, files: [], report: <plan report, 5.8> + needsAuthoring: newVideos}`. The plan writes no files
   (the GWP-89 wrapper then answers `passed` with "no changes").

### 5.4 Phase `author` (server, only when `needsAuthoring` is not empty)

`apps/server/src/release/docs-prep-videos.ts` `dispatchAuthor(tx, run, repo)`, called by `advance()` for the server
phase. It reads the plan report from the repo's `videos/plan` row. With no `needsAuthoring`, it finishes the row as
`skipped` with the note `no new videos`. Otherwise it dispatches one `release_prep` shift per new video, in order (5.7).
It runs on the repo's recorded workstation, with the project's builder agent (the first active `builder` seat on that
workstation). If there is none, that video fails with "no builder agent on <workstation> to write the <slug> video" and
the step fails.

- **cwd.** A detached worktree that the supervisor adds from `refs/guildwise/docs-prep/<runId>/work` (else the analysed
  head), under the repo lock.
- **Writable files, exactly:** `e2e/video/<slug>.spec.ts`, `e2e/video/narration/<slug>.ts`, `e2e/video/screens.json`,
  `apps/web/src/lib/videos.ts` and `docs/guide/VIDEO-PLAN.md`. There is no web access and the shell is read-only. The
  agent does not render: the render phase does that.
- **Prompt.** The template spec and narration, two existing specs with their narration as style examples (the one with
  the nearest `nav`, plus `backlog`), the `VIDEO-PLAN.md` rules (plan rule 3: start on the page through the sidebar, about
  2.4 words a second, demo data only), the new screen's page files and the cards that changed them (from the summary),
  and the target slug and title.
- **What the agent must do:**
  - write the spec and the narration from the template;
  - add the `videos[slug]` entry to `screens.json` and remove the `planned` entry;
  - add or update the `SECTION_VIDEOS[slug]` entry with `published: true`, choosing `nav`/`paths`/`help` from nav-config
    and the Help articles;
  - add a short entry to `VIDEO-PLAN.md`.
- **Ending.** The agent ends the shift with `aom prep done --summary "..."` or `aom prep fail --reason "..."`.
- **At the end of the shift the supervisor:**
  - checks that the changed files are a subset of the writable list (anything else fails the video, with the paths
    named);
  - commits the files to the work ref under the lock with `requireCommitIdentity` + `commitEnv`. This is a local commit
    only, as in GWP-89 content steps (reuse `keepWork` from 5.0 b);
  - removes the worktree and reports the result to the server, which finishes the `videos/author` row (`passed` with the
    authored slugs in its report, or `failed` with `<slug>: could not write the video script: <reason>`).
- **Repair round.** If the render of a newly written spec fails (5.5) and the `author` row's `attempt` is 0, the server,
  in the transaction that receives the render result, does not finish the run: it appends
  `ReleaseDocsPrepStepReset` for `videos/author` and `videos/render` with `attempt: 1` and calls `advance`. The author
  phase then dispatches **one** repair shift per failed new slug with the render error tail in the prompt, then renders
  again (the videos already rendered come from the render cache). A failure at `attempt` 1 fails the step. Existing
  specs get no repair round: their failure is reported as it is (AC 5).

### 5.5 Phase `render` (runner, long, outside the lock)

Same handler, `ctx.phase === 'render'`, unlocked (5.0 b). `ctx.input` is `{plan, authored: [slug]}`: the plan's
selected slugs minus `up_to_date`, plus the authored new slugs.

1. The wrapper gives the handler its own detached worktree from the work ref (lock held only to add it).
2. Run the full preflight (section 5.6). Then `pnpm install --frozen-lockfile --prefer-offline` and `pnpm build`, both
   with a time limit and the output tail kept. A failure fails the step with `build failed: <tail>`.
3. For each slug, one at a time, in a **staging dir** (`AOM_VIDEO_OUT=<tmp>/out-<slug>`, outside the worktree), so that a
   failed mux never leaves a silent file in `media/videos`:
   - **Command:** `AOM_VIDEO_SLUG=<slug> pnpm --filter @aom/e2e video`. This is the command `record.sh` runs. Calling it
     once per slug gives a separate exit code and log per video, so record.sh and the harness need no change.
   - **Environment:** the runner's env with `AOM_VIDEO_PORT=<free port>`, `AOM_VIDEO_DB=aom_prep_video_<8 hex of
     runId>`, `AOM_VIDEO_DIR_BASE=<runner tmp>`, and nothing set for the voice (section 5.6).
   - **Time limit:** 20 minutes per video (the Playwright test timeout is 15).
   - **Exit 0 and four files present:**
     - check each file is under 20 MB (or `maxMb`; the harness already enforces this);
     - check the sidecar `voice` equals the library label;
     - copy the four files to `media/videos/`;
     - update `e2e/video/renders.json[slug] = {inputs, sourceSha: <start>, voice}`, with no timestamps, sorted keys
       and a trailing newline;
     - store the four files in the render cache `<dataDir>/release-prep/videos/<repoId>/<slug>/<inputs>/`, keeping only
       the newest entry per slug.
   - **Failure:** record `{slug, error: <last 40 lines of the output, cut to 2000 chars>}` and go on with the next slug, so
     every error is reported in one run. The step fails at the end.
   - **Cache hit:** if the render cache already holds the slug's `inputs` (a retry after another video failed, a repair
     round, or a redelivered command), copy instead of rendering, with the action `reused render (inputs unchanged)`.
4. If every video passed, return `{ok: true, files: ['media/videos/<slug>.webm', ..., 'e2e/video/renders.json'],
   report}`. The wrapper takes the lock, commits them locally to the work ref (`keepWork`) and removes the worktree.
   Drop the database (`DROP DATABASE IF EXISTS`) in a `finally`. Commit results then squashes and pushes these files with
   the others.
5. If any video failed, return `{ok: false, error: '<n> video(s) failed: <slug>: <first line>; ...', report}`. The
   report carries the full error per video. The run fails (unless the repair round of 5.4 applies), nothing is
   committed for any repo, and the ship stays blocked.

When the step is disabled, it is not in `run.steps`: no row, no command, no worktree, no file and no spec is touched
(AC 8).

### 5.6 The voice and the environment check

The owner's ruling, as a build rule:

- The step **never sets** `AOM_VIDEO_TTS`, `AOM_VIDEO_VOICE`, `AOM_VIDEO_SPEED` or `AOM_VIDEO_LENGTH_SCALE`.
- **Library label** = the `voice` of the existing `media/videos/*.json`. All of them must agree; if they do not, fail with
  `voice unavailable: the existing videos use different voices (<labels>)`. With no videos yet, the label is the repo's
  default label.
- **Probe** (in the worktree, before any render):
  `node --input-type=module -e "<import packages/video/src/voice.ts and ffmpeg.ts; print JSON {available, label, engine, voice, ffmpeg}>"`
  using the runner's own environment.
  - `available === false`: fail with **`voice unavailable: <label> is not installed on <workstation> (run e2e/video/setup-voice.sh; ask DevOps)`**.
  - `label !== library label` (an override in the runner's environment): fail with
    **`voice unavailable: the workstation's environment selects <label> (AOM_VIDEO_TTS/AOM_VIDEO_VOICE), the videos use <library label>`**.
  - `findFfmpeg()` throws: fail with `ffmpeg unavailable: <message>`.
- **Render phase only:**
  - Playwright chromium must be present (`chromium.executablePath()` from the worktree's `playwright-core` must exist):
    otherwise `browsers unavailable: ...`;
  - Postgres 127.0.0.1:5433 and Mailpit 1025 must answer a TCP connect within 2 s: otherwise `postgres unavailable` or
    `mailpit unavailable` (the ports from `e2e/support/env.ts`).
- The voice and ffmpeg checks run in `plan` whenever the step is enabled and the repo has a harness, even if nothing is
  selected (AC 4 literally). They cost about a second. `speak()` still throws inside the harness if the voice goes
  missing mid-run, so a render can never be silent.

### 5.7 Server

- **Phases.** `advance()` works through `stepPhases('videos')` with the generic planner (5.0 a):
  1. `plan`: runner command `release.docs_prep {step: 'videos', phase: 'plan'}`;
  2. `author` (server phase): `dispatchAuthor` (5.4): skipped when nothing needs authoring, else the `release_prep`
     shifts one after the other;
  3. `render`: runner command `{phase: 'render', input: {plan, authored}}`;
  4. a failed render of an authored slug at `attempt` 0 triggers the reset and the single repair round (5.4).
- **Report storage.** The step result carries `report` (5.8), stored on the step row (5.0 c) and in
  `ReleaseDocsPrepStepFinished`.
- **The `release_prep` shift (built here, generic).** Modelled on `ba_tasks` and shift kind `ba_task`:
  - a table `release_docs_prep_tasks (id, run_id, repo_id, step, phase, task jsonb, status, agent_id, shift_id, note,
    created_at, updated_at)` in the same migration as 5.0 (c), written by projectors of new events
    `ReleaseDocsPrepTaskQueued/Started/Finished`;
  - shift kind `release_prep` (add it wherever `ba_task` is listed: `SHIFT_KINDS` in `sessions/delegate.ts`, the shift
    joins in `projections/costs.ts` and `projections/sessions.ts`, the dispatcher that picks queued BA tasks), with
    `task: {kind: 'new_video', slug, title, pages, cards, repairOf?}`;
  - the runner supervisor gets a `release_prep` mode: detached worktree from the work ref, the writable-file list from
    the task, the `aom prep done|fail` terminal commands, and the end-of-shift check and local commit of 5.4;
  - the panel shows the author row with "writing the <slug> video (<agent>)"; its cost goes on the agent as for any
    shift; the 12-hour sweep covers the author row because it is a normal step row in `running`.
  - If GWP-90 or GWP-91 (built before this card by the same builder) lands an equivalent, reuse it and add only the
    `new_video` task kind.
- **No new route.** Settings, start, retry and skip are GWP-89's.

### 5.8 The step report (shared schema `VideoStepReportSchema`)

```ts
{ harness: boolean,                 // false -> note 'skipped: no videos'
  rule: string,                     // VIDEO_RULE_TEXT
  voice: string | null,             // 'Kokoro af_heart'
  base: string, head: string,
  videos: [{ slug, title, action: 'regenerate'|'create'|'up_to_date'|'reused',
             reasons: string[], state: 'rendered'|'failed'|'skipped'|'pending',
             error?: string, mb?: { webm, mp4 }, duration?: number, files?: string[] }],
  shared: string[], unmapped: string[], ignoredCount: number,
  needsAuthoring?: [{ slug, title, pages: string[], reasons: string[] }] }   // plan only
```

`capVideoReport` (shared) cuts it below 64 KB: at most 20 reasons per video, error tails at 2000 characters, the shared
and unmapped lists at 200 entries each with a count of the rest.

### 5.9 Web

In `RunView` (`apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`):

- Add a renderer map `STEP_REPORTS: Record<string, (report) => ReactNode>` keyed by step id. A step with several phases
  shows one report: the one from its latest phase that has one (render, else author, else plan). `videos` uses
  `apps/web/src/components/delivery/VideoStepReport.tsx`. Steps with no renderer look as today.
- Show `s.error` in the danger colour only when `s.state === 'failed'`; for `skipped` show it as subtle text (so
  "skipped: no videos" and "no new videos" do not look like errors).
- `VideoStepReport`:
  - a "skipped: no videos" line for a repo without a harness;
  - the voice, then the rule in a collapsible "How videos are chosen" block;
  - one row per video: slug and title, an action badge (Re-render / New / Up to date / Reused), the reasons as a list,
    and the state. A failed row shows the error in a monospace block that can be expanded;
  - the shared and unmapped lists, collapsed;
  - new videos get the note "New video: watch it on the test site before you approve Ship release".

Touch: rows stack on narrow screens, targets are `min-h-11` (as the existing `<details>` summaries), there are no
hover-only controls, and errors are inline, never a toast.

The project settings checklist (`apps/web/src/components/ReleaseDocsPrepPanel.tsx`) already lists every registered step
with its description: nothing to add there. The step shows unticked by default.

### 5.10 Docs (builder)

- `docs/guide/README.md`, 'Recording a video': explain `screens.json`, `renders.json` and that the release prep step
  records new and changed videos.
- `docs/guide/VIDEO-PLAN.md`: a short section on the screen map.
- `docs/ARCHITECTURE.md` (the release prep section GWP-89 added): the videos step, phases, server phases and the report.
- `docs/RUNNER.md`: what the workstation needs (voice, ffmpeg, browsers, Postgres 5433, Mailpit) and that the render
  runs outside the repo lock.
- `docs/USER-GUIDE.md` Releases: the step and its output.

## 6. Acceptance criteria mapping

| AC | Design | Tests (unit/package/server in the build; e2e for the testers) |
| --- | --- | --- |
| 1. A changed screen re-renders exactly its videos; the output names each with its reason | 5.2 rules 1-3, 5.3, 5.5, report 5.8, 5.9 | shared `docs-prep-videos.test.ts`: a changed screen selects its specs, two videos sharing a screen are both selected, an unrelated or server change selects none, shared UI selects none, reasons and card keys appear. Runner temp-repo test: only the selected slugs are run (fake `video` script) |
| 2. A new feature gets a new spec in the existing style, and its video is added | rule 4, 5.4 author shift, 5.5 render, `published: true` and the map entry | shared: a new page gives `needs new video`, a `planned` page gives the planned slug, an excluded page gives nothing. Server: the plan with `needsAuthoring` dispatches a `release_prep` shift, then a render with the authored slug; the repair round runs once (`attempt` 0 to 1, then fails). Runner: the supervisor refuses files outside the writable list |
| 3. Same voice, captions and output format | the harness is unchanged; the library-label check; four files copied from staging; sidecar voice checked | packages/video or shared test: the library label from fixture sidecars, mismatch and agreement. Runner test: a fake render output with the wrong `voice` is refused |
| 4. No voice: the step fails with 'voice unavailable', nothing committed, ship blocked | 5.6 preflight in `plan`; GWP-89 fails the run before commit | runner: the probe with `available: false`, and an env override label mismatch, both give `voice unavailable: ...`, with no worktree and no files. Server: a failed videos plan means no author, no render, no commit dispatch, and the gate refuses |
| 5. Any render failure fails the step, naming the video and error | 5.5 step 3 failure path; all slugs attempted | runner: a fake `video` script failing for one slug gives `failed`, the error names the slug and holds the tail, the other slug is still rendered but not committed |
| 6. No harness: 'skipped: no videos', the step passes | 5.2 contract, 5.3 step 1, 5.0 (a) skip rule | shared planner: a skipped `plan` gives `skip` actions for `author` and `render`, and the repo reaches `commit`. Runner: a temp repo without `screens.json` gives `skipped` with the note. Web: the note is not shown as an error |
| 7. Videos of a passed run are on the release branch and play where embedded | files in `media/videos` and the registry entry, committed by Commit results | runner: after render, the work ref holds `media/videos/<slug>.*` and `renders.json`; the render worktree is gone and the lock was free during the render. Web: `video-screens.test.ts` and `section-videos.test.tsx` stay green. E2E (testers): prep with Analyse, Videos and Commit, then the files on the release branch, then the Help video plays |
| 8. Step disabled: no video files or specs change | `defaultOn: false`; the step is not in `run.steps` | shared registry test: videos is off by default and on only when ticked. Runner/server: a run without `videos` creates no videos rows and touches no `e2e/video` or `media` path |
| Idempotent re-run | `renders.json` inputs hash, render cache, single flight | runner: a second plan on the same head gives `up_to_date` for every slug and no files; a retry with the cache gives `reused` and no render call; two concurrent deliveries of the same render command run the fake render once |
| Frame (no regression) | 5.0 | the existing GWP-89 shared, runner, server and web tests pass unchanged; new shared tests for `stepPhases`, commit phases still `prepare` then `push`, a server phase, the skip rule; a server test that a stored `prepare`/`push` event still projects |

The fake render: tests set `AOM_PREP_VIDEO_CMD` (test-only, read only when `NODE_ENV=test`) to a script that writes the
four fixture files into `AOM_VIDEO_OUT`, or fails. No real Playwright, voice or ffmpeg is used in unit tests.

## 7. Tests the builder runs, and what is left for the testers

- **Runs in the build:**
  - `packages/shared` (mapping, schemas, registry, the generalised planner);
  - `packages/video/test` (library label helper, if added there);
  - `apps/runner` (videos handler with temp repos and the fake render; the unlocked wrapper and single flight;
    supervisor writable-list check for `release_prep`);
  - `apps/server` DB tests for the phase sequencing, the server phase, the repair reset and the report column
    (Postgres 5433, as the existing release tests);
  - `apps/web` (map completeness test; `VideoStepReport` states; skipped notes not shown as errors).
- **Left for the testers:** the e2e scenario in the card's test plan (a real render on GuildwiseHQ, then with the voice
  missing). It needs the voice installed on the test workstation, which DevOps does (`e2e/video/setup-voice.sh`). The
  voice is **not** installed on this machine today.

## 8. Risks

- **Changing GWP-89's frame.** The phase generalisation touches the planner, both events, the projector and the DTO
  order. Mitigation: widen only (stored events still parse), keep `commit` defined through the same mechanism, and run
  GWP-89's tests unchanged. GWP-90 and GWP-91 may also touch `STEPS` and the handler map: one line each, merge by hand.
- **Redelivery of a long command.** Covered by single flight in the runner plus the render cache.
- **Existing specs break when their screen changed** (selectors). The render fails, which is the intended outcome (AC 5).
  The owner fixes the spec in a card and retries, or skips prep. A follow-up could offer an agent repair round for
  existing specs too.
- **Duration.** The build plus N videos in real time. The overview alone is about 12 minutes. This is within the 12-hour
  sweep, and the runner runs commands concurrently, so other commands are not blocked; with the lock released, card
  shifts on the clone are not blocked either.
- **Machine services.** Postgres and Mailpit are shared with the testers. The step uses its own port and database, so the
  only risk is load.
- **Size.** The repo grows by about 4-10 MB per re-rendered video per release. This is the existing scheme; the card
  forbids a new one.
- **The map goes stale.** The web test fails a feature card that adds a page without mapping it.
- **Agent quality for new specs.** One repair round. Then it fails clearly, with the slug and error, rather than shipping
  a bad video. The owner watches new videos on UAT before approving Ship release.

## 9. Assumptions about GWP-89 (reviewed after it landed; see section 0)

- **A1. Holds.** Registry, handler map, kept work ref, local step commits, failed step fails the run before commit.
- **A2. Revised.** Phases were commit-only; 5.0 (a) adds `phases`/`serverPhases` to the step definition.
- **A3. Revised.** The whole command ran under the lock; 5.0 (b) adds unlocked phases and single flight.
- **A4. Revised.** No report existed; 5.0 (c) adds the column, the result field, the event field and the renderer map.
- **A5. Revised.** No `release_prep` shift exists and no sibling has landed one; 5.7 builds it generically.
- **A6. Revised.** The planner already treats `skipped` as finished, but handlers could not return it and later phases
  were not skipped; 5.0 (a) and (b) add both.
- **A7. Holds.** `base.sha` and `headSha` are in the summary and the payload; the step computes the full diff itself.

## 10. Owner decision

- **Voice:** Kokoro `af_heart`, as `voice.ts` resolves it with no override. 'British' in the card is inaccurate. A real
  British voice would be a new card to switch the voice and re-record the library.
