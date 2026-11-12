# GWP-195 PR-only mode: owner can add a project repository as PR-only

Design for the switch that the PR-only reviewer chain hangs on (PRD "Review Gates & Reviewer Workflow" v22, F1;
rollout order PRD section 10: F1 and F2 first).

## 1. Question

1. How does the owner mark a project repository as PR-only, switch it off again, and see which repositories are
   PR-only (requirements 1 and 4, AC1, AC2, AC5)?
2. Where does "a pull request was opened" come from, so that a newly opened PR on a PR-only repository is recorded
   as eligible for review with state `not_reviewed` (requirement 2, AC3), while nothing changes for other repositories
   (requirement 3, AC4)?

## 2. Findings

### 2.1 Per-repository owner settings already have one pattern

- Write path: `setRepoAccessMethod` in `apps/server/src/commands/repo-access.ts` loads the project with
  `loadVisibleProject`, refuses non-owners with `forbidden('only the project owner can do this')` when
  `p.my_role !== 'owner'` (`my_role` is `project_members.role`, so org Admins are not owners here), checks the repo
  row (`removed_at IS NULL`), returns early when nothing changes, then appends one event on `streamId.project(projectId)`
  inside `withAppendTx`.
- Route: `PATCH /api/projects/:id/repos/:repoId` in `apps/server/src/routes/projects.ts` (~497-516) calls one setter per
  field present in the body and answers with `getProjectDetail`.
- Body: `PatchRepoRequestSchema` in `packages/shared/src/api/projects.ts` (~584) with a `.refine` that requires at least
  one known field. A new field must be added to both the object and the refine, or a body with only the new field is
  refused with 400.
- Event: `ProjectRepoAccessSet` in `packages/shared/src/events/project.ts` (~165). Projection: same name in
  `apps/server/src/projections/projects.ts` (~480) updates `project_repos`.
- DTO: `ProjectRepoDtoSchema` (`packages/shared/src/api/projects.ts` ~42); mapping in `getProjectDetail`,
  `apps/server/src/queries/misc.ts` (~350-370). Optional fields keep existing web fixtures valid.
- UI: one control per setting in the repo row of `apps/web/src/pages/ProjectSettings.tsx` (~311-360), each a component
  in `apps/web/src/components/Repo*Control.tsx` with `isOwner`. Its hook sits in `apps/web/src/api/queries/forges.ts`
  (`useSetRepoAccessMethod`, PATCH plus invalidate `['project', projectId]`). On/off switches elsewhere use a labelled
  checkbox and an On/Off badge (`ManualQaPanel.tsx`).
- Precedent for a switch column: migration `2891_regression_loop.sql` adds `regression_loop boolean NOT NULL DEFAULT
  false`. Latest migration number: 2891.

### 2.2 No source of "PR opened" exists today

- No inbound forge webhook exists in apps or packages (no `pull_request` / `x-github-event` handler). The planner found
  the same thing.
- The forge APIs are only reached from the **runner**, with the user's own login on the workstation
  (`apps/runner/src/forge/*.ts`, the `Forge` interface in `types.ts`). GitHub already lists PRs with
  `gh pr list --json` (`existingChange`, `github.ts` ~136).
- The server already asks a workstation for repository facts and stores the answer. This is the
  `repo.release_facts` command: `apps/server/src/release/facts.ts` picks an active workstation that has the clone and
  the capability `RELEASE_FACTS_CAPABILITY` (`release-facts:1`, announced in `hello.capabilities`), stores a pending row,
  `enqueueRunnerCommand(...)`. The runner answers with `command.result` (`apps/runner/src/runner.ts` ~2246) and the
  gateway applies it (`apps/server/src/runner-gateway/handlers.ts` ~609, `applyCommandResult`).
- The server scheduler (`apps/server/src/scheduler/scheduler.ts`) runs a pass every 15 s. Each sweep there is
  idempotent and throttles itself.
- Standing order: GuildWise never stores user credentials or OAuth tokens, and runners run on the user's
  workstation.

### 2.3 PRD

The project vault copy of PRD v22 (`projects/gwp/docs/review-gates-reviewer-workflow.md`) holds F1 only as edit
instructions. The organization copy is still the template. The exact F1.1 wording is in neither, so it could not be
matched. What the PRD does fix and this design follows:
- "Owner: Adds a project as PR-only" (section 5).
- The reviewer has no write access, and the review works through a comment-only token. This belongs to later cards.
- "not reviewed" is a PR state (F1.6, F1.5, decision log).
- There are no default budgets (section 4).
- Later cards also get a daily cap of 20 automatic reviews (F1.4), so an unbounded backfill of old PRs would use up that
  cap.

The card's AC1 to AC5 are used as the IDs here. If F1.1 says more than "the owner can mark a repository PR-only", the BA
should attach it before review.

## 3. Options for the PR-open source (AC3)

| | A. Inbound forge webhook to the server | B. Server asks the runner to list open PRs (poll) | C. Owner adds PRs by hand |
|---|---|---|---|
| Fits "no credentials on the server" | No: needs a webhook secret per repo on the server, and the forge must reach the server | Yes: the forge login stays on the workstation, as for release facts | Yes |
| Owner setup | A webhook per repo on every forge | None beyond the switch | Every PR |
| Forges | One parser and signature check per forge | One `listOpenChanges` per forge adapter. GitHub exists almost as is | All |
| Works for self-hosted / local servers | Only if publicly reachable | Yes | Yes |
| Latency | Seconds | Poll interval (5 min) | Manual |
| Existing pattern | None | `repo.release_facts`, capability gate, `command.result` | None |
| Meets AC3 "newly opened PR is recorded" | Yes | Yes | No (not automatic) |

**Choice: B.** It is the only option that keeps the forge credential on the workstation, and it reuses a request and
answer path that is already proven. C stays possible later as the PRD's "owner triggers reviews by hand" (F1.5, a later
card).

## 4. Recommendation and design

### 4.1 Behaviour

1. The owner switches **PR-only review** on or off per repository in Project settings, Repos. Only the project owner
   can do this. Anyone else gets 403 (`forbidden`). The UI shows the switch read-only to them.
2. Turning it on records `pr_only_since = now`. Turning it off clears the flag. No value is set unless the owner sets
   it: a new or existing repository is not PR-only.
3. For every PR-only repository the server asks one workstation that holds the clone, at most every 5 minutes, for the
   repository's **open** pull requests (read-only, `repo.list_prs`).
4. The answer is compared with what is already recorded:
   - A PR not seen before, **opened at or after `pr_only_since`**, whose head branch is **not a card branch** of the
     project (`cards.branch_name`), is recorded with review state `not_reviewed` (event `PrReviewRecorded`).
   - PRs that were open before the switch was turned on are not "newly opened" and are skipped. This keeps a backfill
     from using up the later daily cap. The owner can add them later with the manual trigger (later card).
   - A recorded PR that is no longer in a **complete** open list is marked closed (`PrReviewClosed`, `closed_at`).
5. Nothing else happens: no card, no shift, no reviewer run (those come in later cards).
6. Off means off. The sweep only polls repositories that are PR-only. The apply step checks `pr_only` again in its
   transaction, so an answer that arrives after the switch was turned off records nothing. The eligibility query
   filters on `pr_only = true`, so rows recorded earlier are not queued for review while the repo is off. Turning it on
   again sets a new `pr_only_since`: PRs opened while it was off are not picked up.
7. Repositories that are not PR-only: the sweep never selects them and the apply step drops any answer for them. Card
   workflow code is not touched.

### 4.2 Data model (one new migration, `apps/server/migrations/2900_pr_only_review.sql`)

```sql
-- PR-only review (switch per project repository) and the pull requests recorded for review.
-- project_repos.pr_only / pr_only_since: projection of ProjectRepoPrOnlySet. pr_reviews: projection of
-- PrReviewRecorded / PrReviewClosed. pr_review_polls: operational (the last open-PR list request per repository).
-- No foreign keys (projection rebuild).
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS pr_only boolean NOT NULL DEFAULT false;
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS pr_only_since timestamptz;
CREATE TABLE IF NOT EXISTS pr_reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  project_repo_id uuid NOT NULL,
  change_id text NOT NULL,          -- forge id as text (GitHub number, GitLab iid, Azure id)
  url text NOT NULL,
  title text NOT NULL,
  author text,
  head_branch text NOT NULL,
  base_branch text NOT NULL,
  opened_at timestamptz NOT NULL,   -- the forge's created time
  recorded_at timestamptz NOT NULL,
  review_state text NOT NULL,       -- PrReviewStateSchema; later cards add states
  closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_reviews_repo_change ON pr_reviews (project_repo_id, change_id);
CREATE INDEX IF NOT EXISTS pr_reviews_open ON pr_reviews (project_repo_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS pr_review_polls (
  project_repo_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  workstation_id uuid,
  state text NOT NULL,              -- pending | ok | failed | unsupported
  detail text,
  requested_at timestamptz NOT NULL,
  checked_at timestamptz
);
```

- Register `pr_reviews` in `PROJECTION_TABLES` (`apps/server/src/projections/index.ts`).
- Add `pr_review_polls` to `SAVED` in `apps/server/src/projections/rebuild.ts`
  (`restoreWhere: 'project_repo_id IN (SELECT id FROM project_repos)'`), like `repo_release_facts`.
- Do not name anything `repo_pr_requests`: that table already exists for the release PR.
- `DEFAULT false` is "off until the owner turns it on", not a limit. It is the same shape as `regression_loop`. The PRD
  "no defaults" rule is about budgets and risk maps, and this card introduces none.

### 4.3 Shared (`packages/shared`)

- `src/events/project.ts`, next to `ProjectRepoAccessSet`:
  ```ts
  /** The owner turned PR-only review on or off for a repository. On: open PRs opened from `at` are recorded for review. */
  defineEvent('ProjectRepoPrOnlySet', z.object({ projectId: Id, repoId: Id, prOnly: z.boolean(), at: z.iso.datetime(), by: Id })),
  ```
  Use the event-store time convention the other events use for `at`, if they use one.
- A new file `src/review/pr-review.ts`, exported from the package index:
  ```ts
  export const PR_REVIEW_STATES = ['not_reviewed'] as const;   // later cards extend
  export const PrReviewStateSchema = z.enum(PR_REVIEW_STATES);
  export const OpenChangeSchema = z.object({
    id: z.string().min(1).max(40), url: z.string().url().max(500), title: z.string().max(300),
    author: z.string().max(100).nullable(), head: z.string().max(200), base: z.string().max(200),
    createdAt: z.iso.datetime(),
  });
  export const RepoListPrsResultSchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), complete: z.boolean(), changes: z.array(OpenChangeSchema).max(200) }),
    z.object({ ok: z.literal(false), reason: z.enum(['no_clone', 'unsupported', 'not_connected', 'error']), error: z.string().max(400).optional() }),
  ]);
  ```
  Put the two events here or in `events/project.ts`, matching where the event registry expects them:
  `PrReviewRecorded {projectId, repoId, prReviewId, changeId, url, title, author|null, headBranch, baseBranch, openedAt, state:'not_reviewed'}`
  and `PrReviewClosed {projectId, repoId, prReviewId}`.
- `src/protocol/runner.ts`:
  - `export const PR_LIST_CAPABILITY = 'pr-list:1'`
  - add `'repo.list_prs'` to the command type list
  - add `RepoListPrsPayloadSchema = z.object({ requestId: z.uuid(), repoId: z.uuid(), remoteUrlNormalized, forge: ForgeKindSchema.optional() })`
    to `CommandPayloadSchemas`.
- `src/api/projects.ts`:
  - `ProjectRepoDtoSchema`: `prOnly: z.boolean().optional()` and
    `prReview: z.object({ waiting: z.number().int().nonnegative(), checkedAt: IsoTime.nullable(), problem: z.enum(['no_clone','old_runner','unsupported','not_connected','error']).nullable() }).nullable().optional()`.
    `waiting` counts open `not_reviewed` rows. `problem` explains why nothing is polled, so the owner can see that the
    switch works.
  - `PatchRepoRequestSchema`: `prOnly: z.boolean().optional()`. Add `b.prOnly !== undefined` to the refine and
    `prOnly` to its message.

### 4.4 Server (`apps/server`)

- **New** `src/commands/pr-only.ts`:
  - `setRepoPrOnly(ctx, user, projectId, repoId, prOnly)`: a copy of the `setRepoAccessMethod` guard (owner only,
    repo exists and is not removed, no event when unchanged). It appends `ProjectRepoPrOnlySet` with
    `at = ctx.clock.now()` and `by = user.id`. Turning it on also kicks one poll (`requestPrList(ctx, repoId)`, ignoring
    the result) so the owner sees the status soon.
  - `requestPrList(ctx, repoId)`: modelled on `requestReleaseFacts`.
    - Skips simulation orgs and repos that are not `pr_only`.
    - Throttles: a pending request younger than 2 min, or a last answer younger than `PR_POLL_MS = 5 * 60_000`.
    - Picks `workstation_repos ⋈ workstations(status='active') ⋈ workstation_capabilities ∋ PR_LIST_CAPABILITY`,
      preferring the owner's workstation and then `last_seen_at`.
    - With no such workstation, it upserts `pr_review_polls` with `state='failed'` and detail `no_clone` or
      `old_runner` (no command).
    - Otherwise it upserts a pending row and calls `enqueueRunnerCommand(..., 'repo.list_prs', payload)` and
      `deliverPending`.
  - `pollPrOnlyRepos(ctx)`: selects `project_repos WHERE pr_only AND removed_at IS NULL` (project active, not archived)
    and calls `requestPrList` for each. Wire it into `Scheduler.run()` with `.catch(log)`, like the other sweeps.
  - `applyPrListResult(ctx, payload, ok, result, error)`, in one transaction:
    1. Ignore the answer if `request_id` is not the current one.
    2. Update `pr_review_polls`.
    3. Lock the repo row and **return if `pr_only` is false** (AC2).
    4. Otherwise, for each change with `createdAt >= pr_only_since`, no existing `pr_reviews` row, and `head` not in
       `SELECT branch_name FROM cards WHERE project_id=$1 AND branch_name IS NOT NULL`: append `PrReviewRecorded`
       (`state:'not_reviewed'`).
    5. When `complete`, append `PrReviewClosed` for open rows of the repo that are missing from the list.
    6. Use `SYSTEM_ACTOR` and `projectScope`.
  - `listReviewEligiblePrs(db, projectId)`: open rows with `review_state='not_reviewed'` joined to
    `project_repos.pr_only = true AND removed_at IS NULL`. It is the single query the later reviewer cards pick work
    from, and it is what AC2 and AC4 assert on.
- `src/routes/projects.ts` PATCH `/api/projects/:id/repos/:repoId`: add
  `if (req.body.prOnly !== undefined) await setRepoPrOnly(...)`. Update the route's doc comment.
- `src/runner-gateway/handlers.ts` `applyCommandResult`: add a `repo.list_prs` branch (terminal:
  `completeCommand(...)`, then `applyPrListResult(...)`), next to `repo.release_facts`.
- `src/projections/projects.ts`:
  - `ProjectRepoPrOnlySet`: `UPDATE project_repos SET pr_only=$2, pr_only_since=CASE WHEN $2 THEN $3 ELSE NULL END WHERE id=$1`.
  - `PrReviewRecorded`: `INSERT ... ON CONFLICT (project_repo_id, change_id) DO NOTHING`.
  - `PrReviewClosed`: `UPDATE pr_reviews SET closed_at=$event_time`.
  - These can go in a new projector file if that is how other areas are split. Register it in `projections/index.ts`.
- `src/queries/misc.ts` repo DTO: `prOnly: r.pr_only ?? false` and `prReview` (only when `pr_only`), from one grouped
  query over `pr_reviews` and `pr_review_polls` for the project's repos. Map the poll `state`/`detail` to `problem`.
- `ProjectRepoRemoved` needs no change. Removed repos are excluded by `removed_at` in every query above.

### 4.5 Runner (`apps/runner`), needed for AC3 to happen outside tests

- `src/forge/types.ts`: optional `listOpenChanges?(repo: RemoteRepo, limit: number): Promise<{ changes: OpenChange[]; complete: boolean }>`
  and `caps.listChanges`. It is optional, so existing fake forges in runner tests still compile.
- `src/forge/github.ts`: `gh pr list --repo <fullName> --state open --json number,url,title,author,headRefName,baseRefName,createdAt --limit <limit+1>`.
  `complete = rows.length <= limit`. Exit 127 throws `ForgeUnavailableError`. Map `author.login`.
- GitLab, Azure DevOps, Bitbucket: leave `listOpenChanges` out. The runner answers `{ ok:false, reason:'unsupported' }`
  and the UI says that PR-only review is not available for that git host yet. A backlog suggestion covers the other
  forges.
- `src/runner.ts`:
  - Announce `PR_LIST_CAPABILITY` in `hello.capabilities` (~1559, next to `RELEASE_FACTS_CAPABILITY`).
  - Add a `repo.list_prs` branch next to `repo.release_facts` (~2246): find the clone (`findRepo`), resolve the forge
    as the other forge commands do, and call `done(true, result)`.
  - Never write to the repo. Never put a token in the result.

### 4.6 Web (`apps/web`)

- **New** `src/components/RepoPrOnlyControl.tsx`:
  - A labelled checkbox switch ("PR-only review"), `data-testid="repo-pr-only-<name>"`, with an On/Off badge
    (`data-testid="repo-pr-only-state-<name>"`).
  - Disabled when `!isOwner` or while the mutation is pending. Non-owners see "Only the project owner can change
    this."
  - When on: "N pull requests waiting for review", or the `problem` text (no workstation has the clone, runner needs
    an update, not supported for this git host, not signed in to the git host, could not list pull requests), plus
    the last check time.
  - Help text: "Open pull requests are recorded for review; no card is started for them. Pull requests opened before
    you turned this on are not picked up."
  - Touch: the whole label row is the hit target (`min-h-11`, `flex items-center gap-3`), with no hover-only content
    and no text input (no soft keyboard). The switch must stay usable at 320 px width.
- `src/api/queries/forges.ts`: `useSetRepoPrOnly(projectId)`: PATCH `{ prOnly }` and invalidate
  `['project', projectId]`, like `useSetRepoAccessMethod`.
- `src/pages/ProjectSettings.tsx`: render `<RepoPrOnlyControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />`
  in the repo row under `traits.usesRepos`, after `RepoAccessControl`. Requirement 4: also show a small "PR-only" badge
  next to the repo name in the row header when `r.prOnly`, so it is visible without opening anything.

### 4.7 Docs

`docs/USER-GUIDE.md`:
- Add **PR-only review** to the "Repos" bullet in 4.3.
- Add a new subsection **4.3c PR-only repositories** after 4.3b:
  - what it does, who can switch it on or off, and that it is off unless the owner turns it on
  - that open PRs from the moment it is turned on are recorded as "not reviewed", polled from a workstation that has
    the clone about every 5 minutes, using your own git login there
  - that PRs opened by cards are left out, and no card is started
  - that it works on GitHub only for now
  - that reviewer runs come later
  - that turning it off stops new PRs being recorded or queued
- Plain text only, no new screenshots. A later card can capture one.

## 5. Acceptance criteria mapped to the design and tests

All tests go in **new files**. No existing test file needs to change. Server tests need the test DB (Postgres 5433):
if it is not up in the builder shift, the builder says so in the handoff and the tester runs them.

| AC | Design | Test (new file) |
|---|---|---|
| AC1 on, saved, shown after reload | `setRepoPrOnly`, `ProjectRepoPrOnlySet` projection, DTO `prOnly`, `RepoPrOnlyControl` | `apps/server/test/pr-only-setting.test.ts`: the owner PATCHes `{prOnly:true}` and GET `/api/projects/:id` shows `prOnly:true`; a PATCH with only `prOnly` is accepted (refine); setting the same value twice appends one event. `apps/web/src/test/repo-pr-only.test.tsx`: the toggle sends PATCH `{prOnly:true}`, the state badge reads On after the refetch, and the control is disabled for a non-owner |
| AC2 off, saved, nothing new queued | Off clears the flag. The sweep skips the repo, `applyPrListResult` re-checks `pr_only`, and `listReviewEligiblePrs` filters `pr_only` | `pr-only-setting.test.ts`: off then reload gives `prOnly:false`. `apps/server/test/pr-only-eligibility.test.ts`: turn on, enqueue a poll, turn off, then answer with a new PR. No `pr_reviews` row is added, `listReviewEligiblePrs` is empty for that repo, and the next scheduler pass enqueues no `repo.list_prs` |
| AC3 new PR recorded as not reviewed | `pollPrOnlyRepos` → `repo.list_prs` → `applyPrListResult` → `PrReviewRecorded` | `pr-only-eligibility.test.ts`: the fake runner (hello with `capabilities:['pr-list:1']` and the toy repo) receives `repo.list_prs` and answers `command.result` with one PR created after `pr_only_since`, one created before it, and one whose head is a card's `branch_name`. Exactly one row is recorded, with `review_state='not_reviewed'`, and `listReviewEligiblePrs` returns it. A second identical answer adds nothing. A complete list without it marks it closed. `apps/runner/test/forge-list-prs.test.ts`: GitHub `listOpenChanges` parses `gh pr list` JSON (stubbed exec) and computes `complete`, and a forge without the method answers `unsupported` |
| AC4 normal repo: nothing queued, card workflow unchanged | The sweep selects only `pr_only` repos, and the apply step drops answers for others. No card code changed | `apps/server/test/pr-only-regression.test.ts`: with `pr_only=false`, a scheduler pass enqueues no `repo.list_prs`, a forged answer records nothing, and no cards are created. Run the existing card flow tests unchanged: `apps/server/test/dispatch-full.test.ts` and `apps/server/test/project-workflows.test.ts` must still pass |
| AC5 only the owner | Guard copied from `repo-access.ts` | `pr-only-setting.test.ts`: a member added with `addMember` (helpers/members.ts) gets 403 on PATCH `{prOnly:true}` and the flag is unchanged |

## 6. Risks and traps

- **Refine:** forgetting `prOnly` in the `PatchRepoRequestSchema` refine makes `{prOnly:true}` a 400.
- **Late answers:** apply must re-check `pr_only` and `request_id` in the same transaction (AC2).
- **Card PRs:** the exclusion is by `cards.branch_name` in the same project, so card PRs keep going through the
  existing review stage. Without it every card PR of a PR-only repo would also be queued for the reviewers.
- **Old runners:** the capability gate means an old runner never gets a command it does not know. The UI shows "runner
  needs an update" (`old_runner`).
- **Rate limits:** one `gh pr list` per PR-only repo per 5 minutes per project, capped at 200 PRs (`complete=false`
  above that, and then nothing is marked closed).
- **Time zones:** compare `createdAt` (forge, UTC ISO) against `pr_only_since` as timestamptz. The test pins both.
- **Simulation orgs:** skip them, as release facts does.
- **Scope:** reviewer runs, comments, caps, size checks and the manual trigger all belong to later cards. Do not add a
  card, shift or desk item here.
- **Affected areas:** this design adds `apps/runner` (forge adapter, command handler, capability) to the card's areas.
  No existing test file changes.

## 7. Files

New:
- `apps/server/migrations/2900_pr_only_review.sql`
- `apps/server/src/commands/pr-only.ts`
- `packages/shared/src/review/pr-review.ts`
- `apps/web/src/components/RepoPrOnlyControl.tsx`

Changed:
- `packages/shared/src/events/project.ts`
- `packages/shared/src/api/projects.ts`
- `packages/shared/src/protocol/runner.ts`
- the shared index exports
- `apps/server/src/routes/projects.ts`
- `apps/server/src/projections/projects.ts`
- `apps/server/src/projections/index.ts`
- `apps/server/src/projections/rebuild.ts`
- `apps/server/src/queries/misc.ts`
- `apps/server/src/runner-gateway/handlers.ts`
- `apps/server/src/scheduler/scheduler.ts`
- `apps/runner/src/forge/types.ts`
- `apps/runner/src/forge/github.ts`
- `apps/runner/src/runner.ts`
- `apps/web/src/api/queries/forges.ts`
- `apps/web/src/pages/ProjectSettings.tsx`
- `docs/USER-GUIDE.md`

New tests:
- `apps/server/test/pr-only-setting.test.ts`
- `apps/server/test/pr-only-eligibility.test.ts`
- `apps/server/test/pr-only-regression.test.ts`
- `apps/runner/test/forge-list-prs.test.ts`
- `apps/web/src/test/repo-pr-only.test.tsx`
