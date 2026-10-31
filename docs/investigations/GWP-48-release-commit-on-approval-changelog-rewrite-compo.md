# GWP-48: release commit on approval (changelog rewrite, component bumps, commit and push)

Part 3 of "Ship release". This design was first written before parts 1 (component rules, GWP-46) and 2 (Ship release
desk item, GWP-47) landed. Both are now on the working branch; section 0 records what the landed code changed. The
rest of the report is the design as revised.

## 0. Revision after GWP-46 and GWP-47 landed

| # | Assumption | Verdict | What the landed code says, and what changed here |
| --- | --- | --- | --- |
| 1 | GWP-46 exports `ComponentRule` and the helpers plus a semver schema from `repo/component-rules.ts` | **Did not hold (signatures)** | All helpers exist, but with other shapes: `readComponentVersion(rule, text)` (rule first) returns `{ok, version, start, end} \| {ok:false, reason, message}`; `replaceComponentVersion(rule, text, bump)` returns `{ok, from, to, text} \| {ok:false, …}`; `bumpVersion(v, bump)` returns a `BumpResult`; `compareSemver` returns `number \| null`; `componentRuleApplies` returns `{applies, matched}`. **There is no semver zod schema.** GWP-47 added `RELEASE_TAG_RE`, `tagVersion` and `validateReleaseVersion` in `packages/shared/src/release/`. The payload's `version` is now validated with `RELEASE_TAG_RE` on `v<version>` (4.1c). |
| 2 | Rules on `project_repos.component_rules` (jsonb), read by the server | Holds | Migration 2760. The one reader is `loadComponentRules(db, repoId)` in `apps/server/src/release/rules.ts`. |
| 3 | Approval is `approval/ship_release` through `desk.ts closeItem` | Holds | The branch calls `resolveShipReleaseIn` (`apps/server/src/release/approve.ts`), which appends `ReleaseApproved` and returns nothing. `startReleaseShipIn` goes in the same branch right after it, in the same transaction (4.3). |
| 4 | GWP-47 stores repoId, validated version, lastTag, per-rule owner `to`, notes and maybe a threadId | **Did not hold (shape)** | The proposal lives in `release_proposals` (one row per proposal, `state` proposed/approved/dismissed/released/closed, partial unique index "one live per repo"). The owner chooses a **level** per component (`patch\|minor\|major`), not a `to`; `ReleaseApproved.components` carries `{name, level, state, from, to, changedCount}` computed by the server. `notes` is the whole section body (intro + entries), `notesSource` is `changelog\|commits`. **No threadId.** Mapping: `shipPayloadFromProposal` reads the row; the payload carries the levels and the approved `to` (4.1c); messages go to a `notice` desk item (the planned fallback). |
| 5 | GWP-47 computes `from` at the last tag and default `to` as its patch bump | Holds | `componentBumps(rules, facts, levels)` in `packages/shared/src/release/components.ts` does exactly the `planComponent` rule, with states `bump \| already_set \| unchanged \| missing`. |
| 6 | GWP-47 has no changelog rewrite and no "approved" event | **Did not hold** | GWP-47 ships `releaseIntro(intro, bumps)` (strips existing `<Name> x.y.z[ (unchanged)].` sentences and prepends one per rule), `composeReleaseSection(version, date, intro, body)` and `componentBumps`, and the event `ReleaseApproved` ("the contract with GWP-48"). Consequences: `planComponent` and `componentSentence` are **dropped**; the runner calls `componentBumps` and `releaseIntro`. The new shared `releaseChangelog` only locates the Unreleased block and splices in `composeReleaseSection` output. `ReleaseShipApproved` is **dropped**; the ship starts from `ReleaseApproved` and a small `ReleaseShipStarted` (workstation and payload). |
| 7 | Tag name is `v<version>` | Holds | `validateReleaseVersion` checks `v${raw}` against existing tags, and `reconcileReleaseProposal` closes an approved proposal when `v${version}` exists. |

Also found in the landed code (follows from 3 and 4, no new assumption):

- A second approval of the same item already fails: `resolveShipReleaseIn` only accepts a proposal in state
  `proposed` (`proposal_closed`, 409). While a proposal is `approved`, `reconcileReleaseProposal` creates no new one
  for the repository, and it closes the proposal as `released` once the tag exists (GWP-49). So the server-side
  "committed → note only" branch of the first design is a backstop only.
- Because an approved proposal blocks new proposals until a tag exists, **Dismiss on a `release_failed` alert must
  abandon the release** (append `ReleaseProposalClosed` reason `dismissed`), or a repository stays stuck after a
  failure the owner does not want to retry. Only allowed while the ship is `failed` (nothing was pushed).
- The approval text "Nothing is pushed, tagged or published yet." (reconcile.ts desk body, `ShipReleaseItem.tsx:212`)
  is now wrong and changes (4.4). GWP-47's report marked it for this card.
- The runner already has `apps/runner/src/git/release-facts.ts`, which reads the changed paths since the tag and the
  version files at head and tag. The ship reuses that logic (extract a helper) instead of new git code.
- The repository DTO already has `releaseProposal {state, deskItemId, version}`; the ship status is added to it.

## 1. Question

When the owner approves the "Ship release" desk item, how does the runner turn the working branch into a release
commit? The commit must move `## [Unreleased]` to `## [x.y.z] - date`, extend the intro line with one sentence per
component, bump the version files of changed components, commit as the project identity (signed off when the
repository requires DCO) and push the working branch, with no force-push. It must be idempotent and must support Retry
from the failed step. How does the server queue the command, record the result, show failures and offer Retry?

## 2. Findings (current code)

| Area | What exists | Use for this card |
| --- | --- | --- |
| `apps/runner/src/git/release-pr.ts` | `openReleasePr`, `resolveReleaseBase`: safe-ref checks, `auth(url, forge)`, fetch, push `head:head`, never throws for expected failures | Shape of the new `git/release-ship.ts` |
| `apps/runner/src/git/release-facts.ts` (GWP-47) | `readReleaseFacts`: fetch head/base/tags, last tag merged into head, `diff --name-only -z <tag> <head>`, `componentRuleApplies(...).matched.length`, `fileAt(repo, sha, path, max)` | Extract `componentFactsAt(repoPath, rules, lastTag, sha)` and reuse it at ship time |
| `apps/runner/src/git/completion.ts` | `mergeLocked`: `withRepoLock` → fetch → `requireCommitIdentity` + `commitEnv` → `withIntegrationWorktree` → push `HEAD:refs/heads/<base>` → `advanceLocalBase` (private) | Same flow, with a commit in place of a merge |
| `apps/runner/src/git/integration.ts` | `withIntegrationWorktree({repoPath, dir, root, tempBranch, startPoint}, fn)`; always removes worktree and temp branch | The "release's integration worktree" |
| `apps/runner/src/git/identity.ts` | `requireCommitIdentity(cwd, commitAs)`, `commitEnv(id)`, `NoCommitIdentityError` | The commit identity |
| `apps/runner/src/git/gh.ts` | `isProtectedBranchRejection(stderr)` | Clearer message for a protected working branch |
| `apps/runner/src/runner.ts` | `repo.open_pr` and `repo.release_facts` branches in `runCommand` | Add `release.ship` next to them |
| `packages/shared/src/repo/component-rules.ts` (GWP-46) | `ComponentRule(Schema)`, `ComponentRulesSchema`, `componentRuleApplies`, `readComponentVersion`, `replaceComponentVersion`, `bumpVersion`, `compareSemver` | Version file read/replace |
| `packages/shared/src/release/` (GWP-47) | `componentBumps`, `releaseIntro`, `composeReleaseSection`, `notesFromCommits`, `RELEASE_TAG_RE`, `validateReleaseVersion`, `BumpLevelSchema`, `ComponentBumpSchema` | The bump plan, the intro and the section text: the preview and the commit use the same functions |
| `packages/shared/src/events/release.ts` (GWP-47) | `ReleaseProposed`, `ReleaseApproved`, `ReleaseProposalClosed`; stream `streamId.release(proposalId)` | Add the ship events here |
| `apps/server/src/release/approve.ts` (GWP-47) | `resolveShipReleaseIn`: owner only, validates version against stored facts, recomputes bumps, appends `ReleaseApproved` | Start the ship right after it |
| `apps/server/src/release/facts.ts` (GWP-47) | `requestReleaseFacts`: workstation query (owner's own first, active, has the clone, capability) | Same query with `RELEASE_SHIP_CAPABILITY` |
| `apps/server/src/release/reconcile.ts` (GWP-47) | One live proposal per repo; approved → closed `released` when `v<version>` exists | Unchanged; GWP-49 tags |
| `apps/server/src/commands/repo-create.ts` | Approval → enqueue; failure → `repo_create_failed` alert with Retry/Dismiss → `retryRepoCreateIn` | The failure/Retry pattern to copy |
| `apps/server/src/commands/desk.ts` `closeItem` | `ship_release` branch (GWP-47); `retryClosedAlert` for `repo_create_failed` | Hook start; add `release_failed` retry/dismiss |
| `apps/server/src/blog/releases.ts` | `parseChangelog`, `parseUnreleased` (GWP-47): `intro` and `body` of Unreleased, server only | Not usable by the runner; the shared `releaseChangelog` must produce the same intro and body (4.1a) |
| `CHANGELOG.md` | `## [Unreleased]`, intro `Runner 0.1.63.`, then `### Fixed`. No link-reference footer | Target input |
| `apps/runner/src/version.ts` | `RUNNER_VERSION = '0.1.63'` (raised by hand after 1.3.0 shipped 0.1.62) | `componentBumps` gives `already_set`: no second bump |
| Last manual release | `chore(release): 1.3.0`, only CHANGELOG.md changed, `Signed-off-by:` trailer | The target output |
| DCO | Nothing in runner or server. GuildwiseHQ: `.github/workflows/dco.yml` checks `^Signed-off-by:`; `CONTRIBUTING.md` has a DCO section | Sign-off is required for GuildwiseHQ |
| Runner tests | `apps/runner/test/helpers.ts` `makeRepo()` = clone + bare `origin`; used by `release-pr.test.ts`, `release-facts.test.ts` | Bare-remote fixture exists |

## 3. Options compared

### 3.1 Who decides the component versions

| Option | For | Against |
| --- | --- | --- |
| A. The server sends final versions only, and the runner writes them blindly | Simple runner | Stale if the working branch moved after the approval |
| B. The runner recomputes everything and ignores the desk | Always fresh | The owner's level choice is lost |
| **C. The server sends the rules, the owner's level per rule and the approved `to`. The runner re-reads the facts at ship time and calls the shared `componentBumps(rules, facts, levels)`** | Fresh, respects the owner's level, handles a hand-bump, the same function made the preview | Slightly more payload |

**Choice: C.** If the recomputed `to` of a rule differs from the approved one (the branch moved after approval), the
recomputed value is used and a notice says so.

### 3.2 DCO: how "the repository requires sign-off" is known

| Option | For | Against |
| --- | --- | --- |
| A. New repository setting | Explicit | New UI and migration; out of scope |
| B. Always sign off | Trivial | A sign-off is an attestation; not where nobody asked for it |
| **C. Detect from the repository; the payload may override (`signOff?: boolean`, not sent by the server yet)** | Zero configuration, right for GuildwiseHQ | Heuristic (the override covers misses) |

**Choice: C.** Detection reads the integration worktree. Sign-off is required when any of these holds:
- `.github/dco.yml` exists.
- Any `.github/workflows/*.y{a,}ml` or `.gitlab-ci.yml` contains `Signed-off-by`.
- `CONTRIBUTING.md`, `.github/CONTRIBUTING.md` or `docs/CONTRIBUTING.md` matches `/Developer Certificate of Origin|Signed-off-by/i`.

### 3.3 Failed state and Retry

**Choice: a `release_failed` alert (Retry/Dismiss) carrying git's message, as `repo_create_failed` does.** The Ship
release item is closed by approval (GWP-47). Retry resends the stored payload. Dismiss abandons the release (section 0).

### 3.4 What "Retry continues from the failed step" means in a throwaway worktree

Each step checks whether its effect is already there and skips itself if so:
- **prepare** (fetch, worktree): always cheap.
- **Already released**: if `origin/<wb>:CHANGELOG.md` already has `## [x.y.z]`, report `alreadyDone` with that commit.
- **components** and **changelog**: no-ops when already applied (`already_set`; `already` from `releaseChangelog`).
- **commit** and **push**: the release commit is kept under `refs/guildwise/release/<version>` before the push. On
  Retry, if that commit's parent is still the tip of `origin/<wb>`, it is pushed as is (`resumed:true`, no new
  commit). If the working branch moved, the kept ref is dropped and the commit is made again (a notice says so). The
  ref is deleted after a successful push.

## 4. Design

### 4.1 Shared (`packages/shared`)

**a) `src/release/changelog-rewrite.ts`** (new, pure, exported from `release/index.ts`). It does **not** re-implement
the intro or the section text: it locates the Unreleased block, derives `intro` and `body` the same way the server's
`parseUnreleased` does, and splices in `composeReleaseSection(version, date, releaseIntro(intro, bumps), body)`.

```ts
export interface UnreleasedSplit { intro: string; body: string; start: number; end: number } // line indexes of the block
export function splitUnreleased(md: string): UnreleasedSplit | null;
export function hasReleaseSection(md: string, version: string): boolean;
export type ReleaseChangelogOutcome =
  | { kind: 'rewritten'; md: string; section: string }   // section = composeReleaseSection output (for GWP-49 notes)
  | { kind: 'already'; section: string }                 // '## [x.y.z]' exists
  | { kind: 'error'; message: string };                  // no '## [Unreleased]'
export function releaseChangelog(
  md: string,
  input: { version: string; date: string; bumps: readonly ComponentBump[] },
): ReleaseChangelogOutcome;
export function newChangelog(projectName: string, input: { version: string; date: string; bumps: readonly ComponentBump[]; notes: string }): string;
```

Rules (line-based; every line outside the Unreleased block stays byte-identical):
1. Keep the file's line ending (`\r\n` if present) and the trailing newline.
2. `^##\s+\[<escaped version>\]` found → `already` (section = that block, for the notes).
3. `^##\s+\[Unreleased\]` (case-insensitive) missing → `error: "CHANGELOG.md has no ## [Unreleased] section"`.
4. The block runs to the next `^##\s` heading, a link-reference line (`^\[[^\]]+\]:\s`) or the end of the file.
5. `intro` = the non-blank lines before the first `^###\s`, trimmed and joined with single spaces (what
   `parseUnreleased` yields for every Keep a Changelog heading). `body` = from the first `^###\s` line to the block
   end, trimmed (exactly `parseUnreleased(...).body`). The intro is then `releaseIntro(intro, bumps)` (GWP-47 strips
   the hand-written `Runner 0.1.63.` so there is no duplicate).
6. Output: `## [Unreleased]`, blank line, `composeReleaseSection(...)`, blank line, then the rest of the file.
7. A `[unreleased]: <url>/compare/<prev>...HEAD` line, if present, becomes `.../compare/v<version>...HEAD` and gets
   `[<version>]: <url>/compare/<prev>...v<version>` under it. GuildwiseHQ has none.

`newChangelog` (no CHANGELOG.md): `# Changelog`, the "All notable changes to <Project> …" line as in GuildwiseHQ,
`## [Unreleased]`, then `composeReleaseSection(version, date, releaseIntro('', bumps), notes)`.

Optionally (builder's call, no behaviour change): make the server's preview call `splitUnreleased` too, so one
function decides intro/body. Otherwise add a parity test (4.6): for the real CHANGELOG.md and the fixtures,
`splitUnreleased(md).intro/body` equals `parseUnreleased(md).intro/body`.

**b) Component plan**: no new function. The runner calls GWP-47's `componentBumps(rules, facts, levels)` and writes a
file only for `state === 'bump'`, with `replaceComponentVersion(rule, text, { version: to })` (GWP-47's contract note:
never the plain `'patch'` form). `already_set` and `unchanged` leave the file untouched. `missing` fails the
`components` step with the bump's `message` (missing file, pattern not found). An unchanged rule whose version file is
missing is also a failure (the intro sentence would have no version).

**c) Protocol** (`src/protocol/runner.ts`, next to `RepoReleaseFacts*`):

```ts
export const RELEASE_SHIP_CAPABILITY = 'release-ship:1';
const ReleaseVersionSchema = z.string().min(1).max(60).refine((v) => RELEASE_TAG_RE.test(`v${v}`), 'not a release version');
export const ReleaseShipStepSchema = z.enum(['prepare', 'components', 'changelog', 'commit', 'push']);
export const ReleaseShipPayloadSchema = z.object({
  shipId: z.uuid(),                              // = proposalId
  projectId: z.uuid(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string().min(1).max(500),
  projectName: z.string().max(200),
  workingBranch: z.string().min(1).max(200),
  version: ReleaseVersionSchema,                 // without 'v'
  tag: z.string().min(1).max(100),               // 'v' + version
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastTag: z.string().max(100).nullable(),
  components: z.array(ComponentRuleSchema.extend({
    level: BumpLevelSchema,                      // the owner's choice (ReleaseApproved.components[].level)
    approvedTo: z.string().nullable(),           // ReleaseApproved.components[].to, for the "moved" notice
  })).max(20).default([]),
  notes: z.string().max(50_000).optional(),      // only used when there is no CHANGELOG.md (notesSource 'commits')
  commitAs: CommitAsSchema.nullable().optional(),
  signOff: z.boolean().optional(),               // absent: detect (3.2)
  forge: ForgeKindSchema.optional(),
});
export const ReleaseShipResultSchema = z.object({
  ok: z.boolean(),
  step: ReleaseShipStepSchema.optional(),        // failed step (ok:false) or 'push' (ok:true)
  commit: z.string().optional(),
  alreadyDone: z.boolean().optional(),
  resumed: z.boolean().optional(),
  signedOff: z.boolean().optional(),
  signOffReason: z.string().max(300).optional(),
  components: z.array(ComponentBumpSchema.pick({ name: true, state: true, from: true, to: true, changedCount: true })).default([]),
  section: z.string().max(50_000).optional(),    // the version's changelog section (GWP-49 notes)
  notices: z.array(z.string().max(500)).default([]),
  error: z.string().max(4000).optional(),        // git's own words
});
```
Add `'release.ship'` to `RunnerCommandNameSchema` and `CommandPayloadSchemas`. (Check for an import cycle: the
protocol file already imports from `../repo/index.ts`; `RELEASE_TAG_RE`, `BumpLevelSchema` and `ComponentBumpSchema`
come from `../release/tags.ts` and `../release/dto.ts`, which only import zod and `repo/component-rules.ts`.)

**d) Events** (in GWP-47's `src/events/release.ts`, stream `streamId.release(proposalId)`):
- `ReleaseApproved` (GWP-47, unchanged) is the approval. **`ReleaseShipApproved` is dropped.**
- `ReleaseShipStarted { shipId, proposalId, repoId, version, tag, date, workstationId, retry: boolean, payload }`
  (payload without `commitAs`). Appended on approval (`retry:false`) and on Retry (`retry:true`); it replaces the
  former `ReleaseShipRetried`.
- `ReleaseCommitted { shipId, commit, alreadyDone, resumed, signedOff, components[] }`
- `ReleaseFailed { shipId, step, error, alertDeskItemId? }`: `step` is a free string so GWP-49 adds `tag`/`publish`.
- Dismissing a failed release reuses `ReleaseProposalClosed` with reason `dismissed`.

`DESK_SUBKIND.releaseFailed = 'release_failed'`.

### 4.2 Runner (`apps/runner`)

**New `src/git/release-ship.ts`**: `shipReleaseCommit(input): Promise<ReleaseShipResult>`. It never throws for expected
failures and maps every error to `{ ok:false, step, error }`.

```ts
export interface ReleaseShipInput { payload: ReleaseShipPayload; repoPath: string; integrationDir: string; auth?: GitAuth }
```
Flow, all inside `withRepoLock(repoPath, …)`:
1. **prepare**:
   - `isSafeGitRef` for `workingBranch`, `tag`, `lastTag`. No origin → fail "no origin remote".
   - `fetch origin <wb>`; fetch tags as `release-facts.ts` does (`refs/tags/*:refs/tags/*`, a failure is not fatal).
   - `ls-remote --tags origin refs/tags/<tag>`: exists → fail "tag <tag> already exists: this version was released; choose a higher version".
2. **Already released?** `git show origin/<wb>:CHANGELOG.md` + `hasReleaseSection`. If yes: commit =
   `git log -1 --format=%H --grep='^chore(release): <escaped>$' origin/<wb>`, else
   `git log -1 --format=%H -G'^## \[<escaped>\]' origin/<wb> -- CHANGELOG.md`. Return `{ ok:true, alreadyDone:true, step:'push', commit }`.
3. **Resume?** `refs/guildwise/release/<version>` exists and its parent is the `origin/<wb>` tip → step 8 with that
   commit (`resumed:true`). Stale → `update-ref -d` and a notice.
4. `withIntegrationWorktree({ dir: join(integrationDir, \`release-${repoId}\`), root: integrationDir, tempBranch: integrationBranchName(\`release-${version}\`), startPoint: origin/<wb> })`.
5. **components**: `componentFactsAt(repoPath, rules, lastTag, HEAD)` (extracted from `readReleaseFacts`: changed
   paths since the tag, or all tracked files without a tag; `contentAtHead`; `contentAtTag`), then
   `componentBumps(rules, facts, levels)`. `missing` → fail. For `bump`: `replaceComponentVersion(rule, text, {version: to})`
   (a `!ok` → fail with its message) and write. Recomputed `to` ≠ `approvedTo` → notice.
6. **changelog**: CHANGELOG.md present → `releaseChangelog(md, { version, date, bumps })`; `error` fails the step;
   `already` cannot happen here (step 2) but is treated as no-op. Absent → `newChangelog(projectName, …notes)`; no
   notes → fail. Write; `git add -- CHANGELOG.md <written version files>`; `git status --porcelain` must show only those.
7. **commit**: `requireCommitIdentity(worktree, commitAs)` (`NoCommitIdentityError` → `NO_IDENTITY_WIRE`);
   `signOff = payload.signOff ?? detectSignOff(worktree)`; `git commit -m 'chore(release): <version>' [--signoff]`
   with `env: commitEnv(id)`. Never `--no-verify`, never disable gpg signing. `update-ref refs/guildwise/release/<version> HEAD`.
8. **push**: `git push origin <sha>:refs/heads/<wb>` with auth, **no `--force`, no `+`**. Failure → `step:'push'`,
   git's stderr (or the protected-branch message when `isProtectedBranchRejection`); the kept ref stays. Success →
   `update-ref -d` the kept ref, `advanceLocalBranch(repoPath, wb, sha)`.

**Small refactors**: move `advanceLocalBase` from `completion.ts` to `git.ts` as `advanceLocalBranch` (no behaviour
change); extract `componentFactsAt` from `release-facts.ts` (no behaviour change; `release-facts.test.ts` covers it).

**`detectSignOff(dir)`** in `src/git/dco.ts` (rules in 3.2; plain `readFile`/`readdir`).

**`runner.ts`**: `RELEASE_SHIP_CAPABILITY` in `hello.capabilities`; a `release.ship` branch next to
`repo.release_facts` ("no clone" → `{ ok:false, step:'prepare', error }`); after `ok`, `void this.sync.sync(...)` as
finalize does.

### 4.3 Server (`apps/server`)

**Migration** `2780_release_ships.sql`:

```sql
CREATE TABLE IF NOT EXISTS release_ships (
  id uuid PRIMARY KEY,                 -- = release_proposals.id
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  version text NOT NULL,
  tag text NOT NULL,
  release_date date NOT NULL,
  payload jsonb NOT NULL,              -- without commitAs (reloaded on send)
  status text NOT NULL CHECK (status IN ('committing','committed','failed')),  -- GWP-49 extends
  step text, commit_sha text, error text, alert_desk_item_id uuid, workstation_id uuid,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE (repo_id, version)
);
```
`release_proposals` is not changed: the proposal stays `approved` until GWP-49's tag closes it as `released`, which
already keeps a second proposal away.

- Projectors in GWP-47's `projections/release.ts`: `ReleaseShipStarted` → INSERT … ON CONFLICT (id) DO UPDATE
  status='committing', workstation_id, error=NULL, step=NULL. `ReleaseCommitted` → committed + commit_sha.
  `ReleaseFailed` → failed + step, error, alert id. Add `release_ships` to `PROJECTION_TABLES` and to the project delete.
- **`release/ship.ts`** (new, next to `approve.ts`):
  - `shipPayloadFromProposal(tx, proposalRow, date)`: maps `release_proposals` (version, last_tag, components
    `[{name, level, to}]`, notes, notes_source) + `loadComponentRules` (rules joined by name; a rule removed since
    approval is left out) + repo (`remote_url_normalized`, working branch `repo.working_branch ?? project.working_branch`,
    `forge_kind`) + project name; `tag = 'v' + version`; `notes` only when `notes_source = 'commits'`.
  - `startReleaseShipIn(ctx, tx, user, deskItemId): Promise<string>`: called from the `ship_release` branch of
    `closeItem` right after `resolveShipReleaseIn`, only when `resolution === 'approved'`. Reads the proposal just
    approved (`desk_item_id`, state `approved`), picks the workstation with the `requestReleaseFacts` query using
    `RELEASE_SHIP_CAPABILITY`; none → `conflict('no_clone' | 'runner_too_old')`, which **rolls back the whole
    transaction, `ReleaseApproved` included**, so the item stays open and nothing happened. A `release_ships` row
    already `committed` for (repo, version) → note only, no command (backstop). Date = `ctx.clock.now()` UTC
    `YYYY-MM-DD` (as the view's `today`), stored so a Retry keeps it. Appends `ReleaseShipStarted`, enqueues
    `release.ship` with `commitAs: await loadCommitAs(tx, projectId)`, returns the workstation id
    (`workstationToDeliver`).
  - `retryReleaseShipIn(ctx, tx, user, alertItem)`: ship by `alert_desk_item_id`, must be `failed`
    (`conflict('not_failed')`), owner only, capable workstation again, `ReleaseShipStarted{retry:true}`, enqueue the
    stored payload with fresh `commitAs`. Allowed on an acknowledged alert (like `retryClosedAlert`).
  - `dismissReleaseShipIn(ctx, tx, user, alertItem)`: ship `failed` → `ReleaseProposalClosed{reason:'dismissed'}`
    for the proposal (the next facts read may propose again). Otherwise nothing extra.
  - `applyReleaseShipResult(ctx, workstationId, payload, ok, result, error)`: lock the row; ignore unless
    `committing` and the workstation matches. Success → `ReleaseCommitted` + a `notice` desk item on the project
    (acknowledgeable): "Release commit `chore(release): x.y.z` (<sha7>) pushed to <wb>; it is in the release PR <url
    from latest repo_pr_requests opened>. Runner 0.1.64 / Runner 0.1.63 (unchanged). Signed off (<reason>)." With
    `alreadyDone`: "was already on <wb>; nothing new committed". Failure → `DeskItemCreated` alert `release_failed`
    (title "Release x.y.z stopped at <step>", body: git's message + "Nothing was force-pushed and no tag was made. Fix
    the cause, then Retry: it continues from this step." / Dismiss abandons this release; options Retry/Dismiss;
    `projectId` set; not blocking) + `ReleaseFailed`.
- `runner-gateway/handlers.ts`: `cmd?.type === 'release.ship'` → `completeCommand` + `applyReleaseShipResult` (terminal).
- `desk.ts closeItem`: the start call in the `ship_release` branch; a `release_failed` branch (approved → retry,
  dismissed/acknowledged → dismiss); widen `retryClosedAlert` to `release_failed`.
- Repository DTO (`queries/misc.ts`): extend GWP-47's `releaseProposal` with
  `ship: { version, status, step, commit, error, updatedAt } | null` (row by proposal id).
- Text: the reconcile desk body and the approval text say "Approving prepares the release commit (changelog and
  component versions) and pushes it to <wb>. Nothing is tagged or published yet."

### 4.4 Web (`apps/web`)

- `lib/desk.ts`: `release_failed: 'Release stopped'`.
- `pages/Desk.tsx`: Retry button for `subkind === 'release_failed'` (toast "Retrying"), like `repo_create_failed`.
- `ShipReleaseItem.tsx:212`: the approval text above; after approval the toast reads "Approved: preparing the release commit".
- Project settings > Repositories row (where `releaseProposal` shows): "Release 1.4.0: preparing the release commit…" /
  "Release commit abc1234 pushed to <wb>, in the release PR" / "Release 1.4.0 stopped at push: <first line> (Retry on the desk)".
- Touch: existing `Button` sizes; the status line wraps (no hover-only content).
- Tests: `desk.test.tsx` label + Retry; `desk-ship-release.test.tsx` approval text; a settings test for the three lines.

### 4.5 Docs

- `docs/RUNNER.md`: `release.ship` in the command list; the "Releasing" paragraph: the Ship release item raises
  `RUNNER_VERSION` when `apps/runner/**` changed; packaging and publishing the tgz stay manual.
- `docs/ARCHITECTURE.md`: extend GWP-47's release-flow part: `ReleaseApproved` → `release.ship` → integration worktree
  → components + changelog → commit (sign-off detection) → push; idempotency, Retry/Dismiss, `release_ships`.
- `docs/USER-GUIDE.md` (releases): what approving does now, a failure, Retry, Dismiss.
- `CHANGELOG.md` `[Unreleased]` → `### Added` entry. No second runner bump by hand (`already_set`).

### 4.6 Test plan (for the builder)

- **Shared unit** (`packages/shared/test/release-changelog.test.ts`): real head of CHANGELOG.md → 1.4.0 with the
  runner `already_set` → intro `Runner 0.1.63.` once; `unchanged` → `Runner 0.1.62 (unchanged).`; 1.3.0-style intro
  with more text; no intro and no rules; CRLF; `already`; `error` without Unreleased; compare links; `newChangelog`;
  a body with `### Deprecated`/`### Removed`.
- **Server parity unit**: `splitUnreleased(md)` intro/body equal `parseUnreleased(md)` intro/body on the same inputs
  (skip if the server is switched to `splitUnreleased`).
- **Runner unit**: `detectSignOff` per signal and none.
- **Runner integration** (`apps/runner/test/release-ship.test.ts`, `makeRepo()` + `develop` + tag `v1.0.0` +
  CHANGELOG.md + `apps/runner/src/version.ts`): (1) one release commit on origin `develop` with message, identity and
  Signed-off-by (CONTRIBUTING.md DCO), version bumped after a change under `apps/runner/`; (2) no runner change →
  file untouched, `(unchanged)`; (3) hand-bumped file → untouched, `Runner <current>.`; (4) second run →
  `alreadyDone`, one commit; (5) `pre-receive` hook exit 1 → `step:'push'` with git's message, hook removed → Retry
  `resumed:true`, one commit, kept ref gone; (6) missing version file → `step:'components'`; (7) existing tag →
  `step:'prepare'`; (8) fast-forward only on origin (no `--force`/`+`); (9) no DCO signal → no Signed-off-by.
- **Regression**: `completion*.test.ts` and `release-facts.test.ts` green after the two extractions.
- **Server** (test Postgres; if unreachable, name the suites for the tester): approval queues exactly one
  `release.ship` with the mapped payload; no capable workstation → 409 and the proposal stays `proposed` (rollback);
  proposal without approval queues none; a failed result → `release_failed` alert + status failed; Retry queues the
  stored payload with fresh `commitAs`; Retry when not failed → 409; Dismiss → proposal closed `dismissed`; a result
  from another workstation is ignored; `release-proposal.test.ts` and `release-reconcile.test.ts` stay green.
- **Web**: as in 4.4. E2E is left for the testers.

## 5. Acceptance criteria → design

| AC | Covered by |
| --- | --- |
| CHANGELOG has `## [x.y.z] - <date>` with the former Unreleased entries and a new empty `## [Unreleased]` above | `releaseChangelog` (4.1a) using GWP-47's `composeReleaseSection`; runner step 6; shared unit tests |
| apps/runner/** changed → RUNNER_VERSION bumped (patch or chosen level), intro `Runner x.y.z.`; not changed → untouched, `Runner x.y.z (unchanged).` | GWP-47's `componentBumps` + `releaseIntro`, runner step 5 writes `bump` only; integration tests 1–3 |
| `chore(release): x.y.z` by the project identity, signed off when DCO is required, pushed, in the open release PR | Steps 7–8; the PR head is `<wb>`; integration tests 1, 8, 9 |
| Approving again / Retry after success → no second commit | GWP-47 refuses a second approval (`proposal_closed`); `release_ships` UNIQUE + `committed` backstop; runner step 2 `alreadyDone`; integration test 4 |
| A failed step leaves the desk item failed with git's message; Retry continues from that step | `release_failed` alert with step and git's message; `retryReleaseShipIn`; runner resume (3.4); integration test 5 |
| Nothing committed or pushed before approval; never force-push | Only enqueue sites: `startReleaseShipIn` (after `ReleaseApproved`, same tx) and `retryReleaseShipIn`; push argv without `--force`/`+`; server and integration tests |

## 6. Risks

- **Pre-commit hooks** or **gpg signing** in the integration worktree: surface as `step:'commit'` with the output;
  Retry after the fix. Same as card merges today.
- **The working branch moved** after approval: the runner recomputes bumps (notice when `to` differs) and the
  changelog takes the Unreleased of the ship-time tip. GWP-49 takes the notes from the committed section.
- **Preview vs commit drift**: two code paths read Unreleased (server `parseUnreleased`, shared `splitUnreleased`);
  the parity test guards it.
- **Protected working branch**: reported clearly; no PR fallback in this card.
- **Stuck proposal after a failure**: handled by Dismiss closing the proposal (section 0).
