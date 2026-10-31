# GWP-47: Ship release desk item (version recommendation, changelog preview, component bumps)

Part 2 of the release prep group (46 rules, 47 proposal, 48 release commit, 49 tag and forge release).
Base: `main` at `a4e789f6` (GWP-46 landed). Every path below is relative to the GuildwiseHQ repository.

> **Revision (after GWP-46 landed).** Section 7 checks every assumption against the landed code. Assumptions 1, 2,
> 4 and 5 hold. Assumption 3 does not: GWP-46 ships `readComponentVersion`, `replaceComponentVersion`,
> `bumpVersion` and `compareSemver` in `packages/shared/src/repo/component-rules.ts`. This design now uses those
> helpers and adds no second semver or extract implementation. The changed parts are 4.2 (semver and components),
> 4.3 (steps 7 and 8, payload) and 4.4 (loader, migration number). Everything else is unchanged.

## 1. Question

How does Guildwise build one "Ship release" desk item per repository, with a recommended version and its reason, a
changelog preview and component bumps, and record the owner's approval, without pushing, tagging or publishing
anything? Planning left one point open: the server holds no clone, so where do the last tag, the commits and the
changed files since that tag come from?

## 2. Findings

### 2.1 What exists

| Area | Where | What it gives us |
| --- | --- | --- |
| Release PR request | `apps/server/src/commands/release-pr.ts` (`requestReleasePr`, `applyReleasePrResult`) | Picks a workstation that has the clone (the owner's first), queues `repo.open_pr`, stores the answer in the plain table `repo_pr_requests` (state `pending/opened/nothing/failed`, url, message). |
| Release PR state on the repo row | `apps/server/src/queries/misc.ts` `releasePrOf` | The latest `repo_pr_requests` row per repo. Nothing records later whether that PR was merged or closed. |
| Runner side of the PR | `apps/runner/src/git/release-pr.ts` `openReleasePr`, dispatched in `apps/runner/src/runner.ts` (~l.1965) | Resolves the base branch (`resolveDefaultBranch` or the configured main branch), fetches with forge auth (`gitAuthFor`), and counts `ahead` with `rev-list --count base..head`. |
| Command result routing | `apps/server/src/runner-gateway/handlers.ts` `applyCommandResult` (~l.548) | One `else if (cmd?.type === ...)` branch per command: `completeCommand` and then `apply...Result`. |
| Periodic repo check | `apps/runner/src/git/sync-service.ts` (every 10 min) and `apps/server/src/commands/repo-sync.ts` `applyRepoSyncStatus` | Each workstation reports every repo it tracks every 10 minutes. This is a ready-made heartbeat for the "ahead of main" trigger. |
| Changelog parser | `apps/server/src/blog/releases.ts` `parseChangelog` | Parses Keep a Changelog. It **skips `[Unreleased]`** and undated sections. It maps Removed/Deprecated to `changed` and Security to `fixed`. Bullets under an unknown `###` heading go into `intro`: today "Summary of what ships" and "Notes for self-hosters" in CHANGELOG.md rely on that, so `/releases` must not change. |
| Component rules (GWP-46, landed) | `packages/shared/src/repo/component-rules.ts`, exported from `@aom/shared` | `ComponentRuleSchema` / `ComponentRulesSchema` (`{name ≤60, paths: string[] ≤20×200, versionFile ≤200, pattern ≤500}`, max 20 rules), `componentRuleApplies(rule, changedFiles)` (shared `globToRegExp`), `readComponentVersion(rule, text)` (regex flags `md`, first capture group, with offsets), `replaceComponentVersion(rule, text, bump)`, `bumpVersion(current, 'patch'|'minor'|'major'|{version})` returning `{ok, version}` or `{ok:false, reason, message}`, and `compareSemver(a, b)` (semver 2.0.0 precedence, `null` when not semver). |
| Component rules storage (GWP-46) | `project_repos.component_rules jsonb NOT NULL DEFAULT '[]'` (migration 2760), event `ProjectRepoComponentRulesSet`, read in `queries/misc.ts` with `ComponentRulesSchema.catch([]).parse(...)` | Rules per repository on the server. GuildwiseHQ's runner rule is seeded by the data migration `guildwisehq-runner-rule-2026-10`. |
| Runner semver | `apps/runner/src/update/semver.ts` (`parseVersion`, `compareVersions`, `isNewer`) | Used only by the runner's self-update. Left as it is (see 7.3). |
| Glob matching | `packages/shared/src/workflows/high-risk.ts` `globToRegExp` | Shared glob matcher, used by GWP-46's `componentRuleApplies`. |
| Desk dedup | `apps/server/src/commands/desk-coalesce.ts`, `DeskItemCreated.subjectKey`, index `desk_items_subject` (migration 2122) | One open item per `subject_key`. `raiseOrCoalesce` appends `DeskItemRepeated` on every repeat, which is wrong for a proposal that refreshes every 30 minutes (section 4.4). |
| Repo-scoped approval items | `apps/server/src/commands/repo-create.ts`, `closeItem` in `apps/server/src/commands/desk.ts` | Pattern for a `kind:'approval'` item with `data`, resolved by a subkind branch in `closeItem`. `ResolveDeskItemRequest` already carries a subkind-specific field (`workstationId`). |
| Live data on a desk item | `DeskItemDto.phase` (`packages/shared/src/api/desk.ts`) filled by `apps/server/src/queries/desk.ts` | Precedent for attaching live, computed data to a desk item DTO by subkind. |
| CEO policy | `packages/shared/src/ceo/policy.ts` | `approval:*` defaults to `recommend`, but an owner can delegate. `OWNER_RESERVED_KEYS` keeps an item at `recommend` unless that key is delegated on purpose. |
| Capability gating | `READONLY_DESIGN_CAPABILITY` in protocol/runner.ts, used at `apps/server/src/dispatcher/candidates.ts:217` | How to queue a new command only to runners that understand it. |

### 2.2 The facts the proposal needs, and who can supply them

The server cannot read git, so the last `vX.Y.Z` tag, the commits since it, the changed files, CHANGELOG.md at the
head of the working branch and the component version files (at the head and at the tag) must come from a
workstation. No existing command returns them. `repo.sync` only knows ahead/behind against origin's working
branch, not against main or tags. Forge APIs would work for GitHub only and would need tokens the server must not
hold (standing order: tokens stay on the workstation).

### 2.3 A trap in today's repository

The last tag v1.3.0 has `RUNNER_VERSION = '0.1.62'`. On the working branch it is already `'0.1.63'`, bumped by hand,
and the Unreleased intro already says "Runner 0.1.63.". A naive "current + patch" would propose 0.1.64, a double
bump. **The component bump must start from the version at the last tag.** When the head already holds the target
version (or a higher one), the bump is shown as already done and GWP-48 does not edit the file.

## 3. Options for the repository facts

| Option | Pros | Cons |
| --- | --- | --- |
| A. New read-only runner command `repo.release_facts` (request/answer, like `repo.open_pr`) | Same pattern as `repo.open_pr`: owner's workstation first, forge auth, result stored in a plain table. Works for every forge, including plain git. Read-only, apart from `git fetch`. GWP-49 can reuse it for the last-tag lookup. | One more command, plus a capability flag for older runners. |
| B. Add the fields to the 10-minute `repo.sync_status` report | No new command. | It runs every 10 min on every workstation for every repo (changelog plus tag scan cost). Sync knows neither the main branch nor the component rules. It mixes two concerns. |
| C. Forge API from the server | No runner work. | Needs server-held tokens (forbidden), GitHub only, no plain git. |

**Choice: A.** Option B's heartbeat is used only as a **trigger**: a sync status may queue a facts read, at most
once every 30 minutes per repo.

## 4. Design

### 4.1 Flow

```
release PR opened ─┐
sync heartbeat ────┼─> requestReleaseFacts(repo, trigger) ─> runner repo.release_facts (read-only)
"Prepare release" ─┘                                           │
                                                               v
                        applyReleaseFactsResult: upsert repo_release_facts, then reconcileReleaseProposal(repo)
                                                               │
          ┌──────────────────────────── no open proposal, ahead > 0, not suppressed ────────────────────────┐
          v                                                                                                   │
  one tx: insert release_proposals (via ReleaseProposed projection) + DeskItemCreated(ship_release, subjectKey)│
          │                                                                                                   │
  Desk shows live view (facts + rules -> recommendation, preview, bumps)                                     │
          │ owner approves (version, levels, notes, factsHeadSha)                                             │
          v                                                                                                   │
  one tx: validate -> ReleaseApproved + DeskItemResolved   (GWP-48 subscribes to ReleaseApproved; nothing else) │
```

### 4.2 Shared: `packages/shared/src/release/` (new module, exported from the package index)

Pure functions, used by the server, the web and (in GWP-48 and 49) the runner. Tests go in `packages/shared/test/release-*.test.ts`.

**Semver: one implementation, GWP-46's (revised).** The release module does **not** move
`apps/runner/src/update/semver.ts` and does **not** define a second `bumpVersion`, `parseVersion` or comparer (a
second `bumpVersion` export would also collide with GWP-46's in the package index). It imports `compareSemver` and
`bumpVersion` from `../repo/component-rules.ts`:

- `compareSemver(a, b)` is the comparer for tags, the validation and the component `max`. `null` means "not semver".
- `bumpVersion(base, level)` gives the recommended version and the component targets; callers unwrap `{ok, version}`
  (a base that is not semver cannot reach it: the base is a parsed tag or `0.0.0`).
- **One change to GWP-46's `bumpVersion` for pre-release bases (npm `semver.inc` semantics):** today patch already
  matches npm (`1.2.3-rc.1 → 1.2.3`), but minor and major always increment. Change only these two branches when
  `pre !== null`: minor `X.Y.0-pre → X.Y.0` (else `X.(Y+1).0`), major `X.0.0-pre → X.0.0` (else `(X+1).0.0`).
  So after tag `v1.4.0-rc.1`, a minor recommendation is `1.4.0`, not `1.5.0`. GWP-46's existing tests
  (`1.2.3-rc.1` minor → `1.3.0`, etc.) stay green; add tests for `1.2.0-rc.1` minor → `1.2.0` and `2.0.0-rc.1`
  major → `2.0.0`. Release bases without a pre-release behave exactly as today. 0.x: major still goes to 1.0.0.

```ts
// tags.ts
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;   // no "+build" in a release tag
export function tagVersion(tag: string): string | null;                         // "v1.3.0" -> "1.3.0", else null

// commits.ts
export interface ConventionalTitle { type: string; scope?: string; bang: boolean; subject: string }
export function parseConventionalTitle(title: string): ConventionalTitle | null; // /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/
export function hasBreakingFooter(body: string): boolean;                         // /^BREAKING[ -]CHANGE:/m

// recommend.ts
export type BumpLevel = 'patch' | 'minor' | 'major';   // the string arm of GWP-46's VersionBump
export interface ChangelogCounts { added: number; breaking: number; entries: number }
export interface ReleaseCommit { sha: string; subject: string; breakingFooter: boolean }
export interface Recommendation { version: string; level: BumpLevel; reason: string; base: string }
export function recommendVersion(input: {
  base: string;                       // last tag version, else latest CHANGELOG version, else "0.0.0"
  changelog: ChangelogCounts | null;  // null: no CHANGELOG.md
  commits: ReleaseCommit[];
}): Recommendation;                   // version = bumpVersion(base, level) from repo/component-rules.ts
//   level = max(changelog level, commit level)
//   major: changelog.breaking > 0 || a commit has bang || breakingFooter
//   minor: changelog.added > 0 || a commit has type === 'feat'
//   patch: otherwise
//   reason (exact strings, unit-tested):
//     "major: 1 BREAKING entry"  /  "major: 1 BREAKING entry, 2 breaking commits"  /  "major: 1 breaking commit (feat(api)!: drop v1 routes)"
//     "minor: 3 Added entries, no breaking changes"  /  "minor: 2 feat commits, no breaking changes"
//     "minor: 3 Added entries and 2 feat commits, no breaking changes"
//     "patch: 1 Fixed entry, no Added entries or breaking changes"  (with a changelog: name the non-empty sections)
//     "patch: 4 commits, no feat commits or breaking changes"        (no changelog)
//   singular/plural handled ("1 Added entry", "3 Added entries").

// validate.ts
export type VersionCheck = { ok: true; version: string } | { ok: false; message: string };
export function validateReleaseVersion(input: string, lastTag: string | null, existingTags: string[]): VersionCheck;
//   strips a leading "v", trims spaces; must match RELEASE_TAG_RE once "v" is added (so "+build" is refused)
//   "1.4" -> { ok:false, message: "1.4 is not a semantic version (use MAJOR.MINOR.PATCH, for example 1.4.0)" }
//   lastTag "v1.3.0", input "1.3.0" -> "1.3.0 is not higher than the last release v1.3.0" (compareSemver <= 0)
//   lower -> same message; a version already tagged elsewhere -> "v1.4.1 already exists as a tag"

// components.ts (revised: built on GWP-46's helpers, no extractComponentVersion)
export interface ComponentFacts { name: string; changedCount: number; contentAtHead: string | null; contentAtTag: string | null }
export type ComponentState = 'bump' | 'already_set' | 'unchanged' | 'missing';
export interface ComponentBump { name: string; level: BumpLevel; state: ComponentState; from: string | null;
  to: string | null; changedCount: number; under: string; message?: string }
export function componentBumps(rules: ComponentRule[], facts: ComponentFacts[], levels: Record<string, BumpLevel>): ComponentBump[];
//   head   = contentAtHead === null ? null : readComponentVersion(rule, contentAtHead)   (GWP-46)
//   tagged = contentAtTag  === null ? null : readComponentVersion(rule, contentAtTag)
//   head missing / !ok / compareSemver(version, version) === null
//                               -> 'missing', message: GWP-46's message, or "no version found in <file> with the rule's pattern" when the file is absent
//   changedCount 0              -> 'unchanged', from = to = current
//   else base = (tagged ok and semver) ? tagged.version : current
//        target = bumpVersion(base, level).version;  to = compareSemver(current, target) > 0 ? current : target
//        state = (to === current && current !== base) ? 'already_set' : 'bump'; from = base
//   under = literal prefixes of the globs ("apps/runner/**" -> "apps/runner/"), joined with ", "
export function componentLine(b: ComponentBump): string;
//   "runner 0.1.62 -> 0.1.63 (17 files changed under apps/runner/)"
//   "runner 0.1.63 (unchanged)"; 'already_set' adds " (already set in apps/runner/src/version.ts)"
export function releaseIntro(unreleasedIntro: string, bumps: ComponentBump[]): string;
//   drops leading "<Name> x.y.z." / "<Name> x.y.z (unchanged)." sentences for every rule name, then prefixes
//   one sentence per rule in rule order: bump/already_set -> "Runner 0.1.63."; unchanged -> "Runner 0.1.63 (unchanged)."
//   ('missing' rules add nothing). Name capitalised for the sentence. No rules: intro unchanged.
export function composeReleaseSection(version: string, date: string, intro: string, body: string): string;
//   `## [${version}] - ${date}\n\n${intro}\n\n${body}` with blank parts left out (GWP-48 writes exactly this)
export function notesFromCommits(commits: ReleaseCommit[]): string; // "- <subject>" per commit, newest first, chore(release) skipped

// dto.ts (zod)
export const ReleaseFactsSchema; export const ReleaseProposalViewSchema; export const ShipReleaseApprovalSchema;
```

Contract note for GWP-48: it writes a component with GWP-46's `replaceComponentVersion(rule, text, { version: to })`
only for `state === 'bump'`. For `already_set` it does not touch the file (the `{version}` form would answer
`not_higher` anyway). It never calls the plain `'patch'` form on the head file, which would double-bump (2.3).

Protocol (`packages/shared/src/protocol/runner.ts`): add `'repo.release_facts'` to `RunnerCommandNameSchema` and
`CommandPayloadSchemas`, plus `RELEASE_FACTS_CAPABILITY = 'release-facts:1'`.

```ts
export const RepoReleaseFactsPayloadSchema = z.object({
  requestId: z.uuid(), projectId: z.uuid(), repoId: z.uuid(),
  remoteUrlNormalized: z.string(), head: z.string().min(1), base: z.string().min(1).optional(),
  forge: ForgeKindSchema.optional(),
  components: ComponentRulesSchema.default([]),     // revised: the full GWP-46 rules (same caps), passed as stored
});
export const RepoReleaseFactsResultSchema = z.object({
  ok: z.boolean(), error: z.string().max(600).optional(),
  base: z.string().optional(), headSha: z.string().optional(), baseSha: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  lastTag: z.object({ name: z.string(), sha: z.string() }).nullable().optional(),
  existingTags: z.array(z.string()).max(500).default([]),           // every v* semver tag, newest first
  commits: z.array(z.object({ sha: z.string().max(40), subject: z.string().max(300),
    breakingFooter: z.boolean() })).max(1000).default([]),
  commitsTruncated: z.boolean().default(false),
  changedTotal: z.number().int().nonnegative().default(0),
  components: z.array(z.object({ name: z.string(), changedCount: z.number().int().nonnegative(),
    contentAtHead: z.string().max(262_144).nullable(), contentAtTag: z.string().max(262_144).nullable() })).default([]),
  changelog: z.string().max(1_048_576).nullable().optional(),       // CHANGELOG.md at headSha; null = absent
});
```

`ShipReleaseApprovalSchema` (new optional field `release` on `ResolveDeskItemRequestSchema`, next to `workstationId`):

```ts
z.object({
  version: z.string().trim().min(1).max(60),
  components: z.array(z.object({ name: z.string(), level: z.enum(['patch','minor','major']) })).max(20).default([]),
  notes: z.string().max(20_000).optional(),          // accepted only when the repo has no CHANGELOG.md
  factsHeadSha: z.string().max(40),                  // the head the owner looked at
})
```

Events (`packages/shared/src/events/release.ts`, registered in `events/index.ts`, stream `streamId.release(id)` = `release-<id>`):

```ts
ReleaseProposed  { proposalId, projectId, repoId, deskItemId, trigger: 'release_pr'|'ahead'|'manual',
                   recommendedVersion, level, reason, lastTag: string|null, headSha }
ReleaseApproved  { proposalId, projectId, repoId, deskItemId, version, lastTag: string|null, headSha,
                   components: [{ name, level, state, from, to, changedCount }],
                   notes,                      // the section body as it will read (intro + entries), no heading
                   notesSource: 'changelog'|'commits', approvedBy: userId }
ReleaseProposalClosed { proposalId, repoId, reason: 'dismissed'|'rejected'|'released'|'nothing_to_release', tag?: string }
```

`ReleaseApproved` is **the contract with GWP-48**. It carries everything the release commit needs. GWP-48 must
recompute the CHANGELOG rewrite with `releaseIntro` and `composeReleaseSection` on the real file, so the commit
reads like the preview.

CEO policy (`packages/shared/src/ceo/policy.ts`): add `'release_publish'` to `OWNER_RESERVED_KEYS` with the label
"Approving a release (version, changelog, tag and release page)". Map `ship_release` to it in `reservedKeyOfDesk`
and add `'approval:ship_release': 'recommend'`. The server also refuses `ship_release` approval from anyone but a
project owner (section 4.5).

### 4.3 Runner: `apps/runner/src/git/release-facts.ts` (new, read-only)

`readReleaseFacts({ payload, repoPath, auth }): Promise<RepoReleaseFactsResult>`. It never throws for expected
failures (`ok:false, error`), like `openReleasePr`.

1. `isSafeGitRef` on head and base; the clone needs an origin remote.
2. Resolve the base exactly like `openReleasePr`: **move that block into a shared helper**
   `resolveReleaseBase(repoPath, payload, auth)` in `release-pr.ts`, used by both.
3. Fetch with forge auth: `fetch -- origin <base>`, `fetch -- origin <head>`, then
   `fetch --no-recurse-submodules -- origin 'refs/tags/*:refs/tags/*'`. A failed tag fetch (for example "would
   clobber existing tag") is not fatal: carry on with the local tags. **Never push, never create a tag, never check out.**
4. `headRef` = `origin/<head>` when it exists, else the local `<head>`. `ahead = rev-list --count baseRef..headRef`.
5. `lastTag` = the highest `RELEASE_TAG_RE` tag among `git tag --merged <headSha> --list 'v*'` (compared with
   GWP-46's `compareSemver`; pre-release tags count). `existingTags` = every `v*` semver tag (capped at 500).
6. Commits: `git log --no-merges -n 1001 --format=%H%x1f%s%x1f%b%x1e <lastTag>..<headSha>` (no tag: `<headSha>`).
   Per commit: `{sha, subject (300), breakingFooter: hasBreakingFooter(body)}`; bodies are not sent.
7. Changed files: `git diff --name-only -z <lastTag> <headSha>` (no tag: `git ls-tree -r --name-only -z <headSha>`).
   Per component, `changedCount = componentRuleApplies(rule, paths).matched.length` (**GWP-46's helper, the same
   matcher GWP-48 uses**; no local glob code). `changedTotal` = all paths.
8. Files via `git cat-file -s` (size cap) and `git show <sha>:<path>`: `CHANGELOG.md` at head (1 MB, else null), and
   each component's `versionFile` at head and at the tag (256 KB each; missing gives null). The runner sends the raw
   content; the version is read on the server with `readComponentVersion` (one place).

Dispatch: a branch in `runner.ts` next to `repo.open_pr` (`findRepo`, `gitAuthFor`). Announce `RELEASE_FACTS_CAPABILITY`
in `hello.capabilities`. `apps/runner/src/update/semver.ts` stays as it is (runner self-update only).
Tests: `apps/runner/test/release-facts.test.ts` with a bare-origin fixture (as in `release-pr.test.ts`): no tag,
tag plus commits, a pre-release tag, a hand-bumped version file, a missing CHANGELOG, an unsafe ref, nothing pushed
(origin refs unchanged after the call).

### 4.4 Server

**Migration** `apps/server/migrations/2770_release_proposals.sql` (next free number after GWP-46's 2760):

```sql
CREATE TABLE repo_release_facts (            -- plain table, latest read per repo (like repo_pr_requests / repo_sync_status)
  project_repo_id uuid PRIMARY KEY REFERENCES project_repos(id) ON DELETE CASCADE,
  request_id uuid NOT NULL, workstation_id uuid, trigger text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','ready','failed')), message text,
  head_sha text, facts jsonb, requested_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE release_proposals (             -- projection of the Release* events
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, repo_id uuid NOT NULL,
  desk_item_id uuid NOT NULL, state text NOT NULL CHECK (state IN ('proposed','approved','dismissed','released','closed')),
  trigger text NOT NULL, recommended_version text NOT NULL, recommended_level text NOT NULL, reason text NOT NULL,
  last_tag text, head_sha text NOT NULL, version text, components jsonb, notes text, notes_source text,
  approved_by uuid, approved_at timestamptz, closed_reason text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE UNIQUE INDEX release_proposals_one_live ON release_proposals (repo_id) WHERE state IN ('proposed','approved');
```

The partial unique index is what guarantees "exactly one". GWP-48 and 49 extend the state list (committed, tagged,
published, failed) and the live set.

**`apps/server/src/release/` (new):**

- `facts.ts`:
  - `loadComponentRules(db, repoId): Promise<ComponentRule[]>` (revised to the landed storage):
    `SELECT component_rules FROM project_repos WHERE id=$1`, parsed with `ComponentRulesSchema.catch([]).parse(...)`
    exactly like `getProjectDetail` in `queries/misc.ts`. The only place this card reads rules.
  - `requestReleaseFacts(ctx, repoId, trigger, opts?)` picks the workstation like `requestReleasePr` (owner's first,
    else any active one with the clone), or the reporting workstation for `sync`, and it must have
    `RELEASE_FACTS_CAPABILITY`. It skips business-mode orgs (`assertDevMode`-style check), removed repos, repos whose
    main branch equals the working branch, and research-stage projects.
  - Throttle: a `pending` request younger than 5 min blocks a new one. For `sync`, a read younger than 30 min also blocks.
  - It upserts `repo_release_facts` (state pending), enqueues `repo.release_facts` with the component rules (as
    stored) and calls `gateway.deliverPending`.
  - `applyReleaseFactsResult(ctx, payload, ok, result, error)` parses with `RepoReleaseFactsResultSchema`, stores
    facts or the error, then calls `reconcileReleaseProposal`.
- `changelog.ts`: the server-side reading of the facts. It calls the **extended** `blog/releases.ts` (below) and returns
  `{ counts: ChangelogCounts, intro, body, latestVersion }` or null.
- `proposal.ts`:
  - `buildProposalView(facts, rules, levels?)` is pure: base, `recommendVersion`, `componentBumps`, `releaseIntro`,
    preview body, notes. It is unit-tested and feeds both the desk DTO and the approval.
  - `reconcileReleaseProposal(ctx, repoId, trigger)` runs in one `withAppendTx` and locks the repo row (`FOR UPDATE`
    on `project_repos`):
    1. A live `approved` proposal whose version ≤ `facts.lastTag` (tagged by hand or by GWP-49) gets
       `ReleaseProposalClosed{reason:'released', tag}`.
    2. A live `proposed` proposal while `facts.ahead === 0` gets `ReleaseProposalClosed{reason:'nothing_to_release'}`,
       and its desk item gets `DeskItemResolved{resolution:'dismissed', by:{kind:'system'}, note}`.
    3. No live proposal, `facts.ahead > 0`, and not suppressed: append `DeskItemCreated` (kind `approval`, subkind
       `ship_release`, title `Ship release: <repo name>`, `data:{repoId, proposalId}`,
       `subjectKey:'ship_release:<repoId>'`, `projectId`, `askedBy:{kind:'system'}`) and `ReleaseProposed`.
       Suppression: when the latest closed proposal of the repo was `dismissed`/`rejected` with the same `last_tag`,
       the `sync` trigger does not re-propose. `release_pr` and `manual` always do. On a unique violation (a race), do nothing.
    4. A live `proposed` proposal while the facts moved: nothing is appended. The desk view reads the new facts live.
       No `DeskItemRepeated`.
- `approve.ts`: `resolveShipReleaseIn(ctx, tx, user, item, resolution, req.release)`. Section 4.5.

**Extension of `apps/server/src/blog/releases.ts` (reuse, no second parser).** Turn the loop of `parseChangelog`
into an internal `scanChangelog(md, { unreleased })` that also records each block's raw line range. Then:

```ts
export function parseChangelog(md: string): ChangelogRelease[]          // same output as today (keep releases.test.ts green)
export interface UnreleasedSection {
  intro: string;                 // same normalisation as ChangelogRelease.intro
  sections: ReleaseSections;     // same item normalisation
  body: string;                  // raw markdown from the first "###" line of the block to the end of the block, trimmed
  breaking: number;              // items whose text has the word BREAKING (upper case) + bullets under a "### ...Breaking..." heading
  empty: boolean;
}
export function parseUnreleased(md: string): UnreleasedSection | null   // null when the file has no [Unreleased] block
```

Counts: `added = sections.added.length`, `entries` = all items plus breaking-heading bullets. Add tests to
`apps/server/test/releases.test.ts`: an unknown heading (for example "Notes for self-hosters") still lands in
`intro` for `parseChangelog` (regression guard), and `parseUnreleased` covers Added/Fixed/BREAKING/empty/absent.

Base version: `lastTag` (without the `v`), else the newest `parseChangelog(md)[0].version`, else `0.0.0`.

**Triggers:**
- `applyReleasePrResult` (release-pr.ts): when the state becomes `opened`, call `requestReleaseFacts(repo, 'release_pr')`.
- `applyRepoSyncStatus` (repo-sync.ts): after storing, call `requestReleaseFacts(repo, 'sync', { workstationId })`
  (throttled to 30 min).
- `POST /api/projects/:projectId/repos/:repoId/release-proposal` (owner only, in `routes/projects.ts`) calls
  `requestReleaseFacts(repo,'manual')` and returns `{requestId}`. It backs "Prepare release" on the repo row and
  "Refresh" on the desk item.
- Gateway: a `repo.release_facts` branch in `applyCommandResult` calls `completeCommand` and then `applyReleaseFactsResult`.

**Desk DTO:** add `release: ReleaseProposalViewSchema.nullable().optional()` to `DeskItemDtoSchema`, filled in
`queries/desk.ts` for `subkind === 'ship_release'` (load `repo_release_facts`, the rules through
`loadComponentRules` and the proposal; call `buildProposalView`). The view contains `{proposalId, repoId, repoName,
state, lastTag, base, recommended:{version, level, reason}, headSha, factsAt, factsState, factsMessage, ahead,
commitsTruncated, today (UTC YYYY-MM-DD), changelog:{present, empty, intro, body}|null, notes, notesEditable,
components: ComponentBump[] (default levels), rules: [{name, paths, versionFile}], existingTags}`.

### 4.5 Approval (`closeItem` branch in `commands/desk.ts`)

`item.kind === 'approval' && item.subkind === 'ship_release'` calls `resolveShipReleaseIn`:

- The caller must be the project **owner** (`projectRole === 'owner'`), else 403.
- `rejected` (or dismiss through `dismissDeskItem`, which takes a separate short path) appends
  `ReleaseProposalClosed{reason:'rejected'|'dismissed'}`.
- `approved` without `release` gives 400 `release_required`.
- `acknowledged` gives 400 `wrong_resolution`.
- `approved`:
  1. Load the proposal (state `proposed`, `FOR UPDATE`) and `repo_release_facts`. When the facts are not `ready`,
     answer 409 `facts_missing`.
  2. When `req.release.factsHeadSha !== facts.head_sha`, answer 409 `proposal_changed`: "The working branch moved
     since you opened this item. Check the refreshed proposal and approve again."
  3. `validateReleaseVersion(version, lastTag, existingTags)`. On failure, answer 400 `invalid_version` with the
     message (the same text the web shows inline).
  4. `componentBumps(rules, facts.components, levels)`: levels may only be `patch|minor|major`, unknown names give a
     400. The server recomputes `from`/`to`; values from the client are never trusted.
  5. Notes: with a CHANGELOG.md, `releaseIntro` + Unreleased body (and `req.release.notes` is ignored). Without one,
     `req.release.notes?.trim() || notesFromCommits(commits)`.
  6. Append `ReleaseApproved` (+ the normal `DeskItemResolved`). The projection sets `state='approved'`.
     **No runner command is queued by this card.** GWP-48 adds the handoff.

Idempotency: a second approve hits `already_resolved` (existing `closeItem` check). The unique index keeps one live
proposal.

### 4.6 Web

- `apps/web/src/components/ShipReleaseItem.tsx` (new), rendered from `Desk.tsx` in the action switch for
  `item.subkind === 'ship_release'` (add it to the exclusion list near l.433 so the generic approval buttons do not
  show as well).
  - Header: repo name, "Last release v1.3.0" (or "No release yet"), facts age and a **Refresh** button (calls the
    manual endpoint). When facts are pending, show a "reading the repository…" state. When facts failed, show the
    workstation's message.
  - **Version** field, prefilled with the recommendation. Under it: the reason in plain text ("minor: 3 Added
    entries, no breaking changes"). Live validation with `validateReleaseVersion`; the message shows **inline under
    the field** (`aria-invalid`, `aria-describedby`), never as a toast. The Approve button stays disabled while
    invalid. A server 400 or 409 message shows in the same place.
  - **Component versions**: one row per rule, `componentLine(...)`, and a native `<select>` patch/minor/major for
    changed rules (default patch). 'unchanged' rows have no select. 'missing' shows its message.
  - **Changelog preview**: `composeReleaseSection(version, today, releaseIntro(intro, bumps), body)` recomputed on
    every change of the version or a level, in a scrollable monospace block (max-height, wraps on small screens).
    Empty Unreleased: a note "The Unreleased section is empty; the recommendation uses the commits."
  - **Notes**: without CHANGELOG.md, an editable `<textarea>` prefilled from the commit titles. With one, notes are
    the preview (read only).
  - Text under the buttons: "Approving records this version and the component versions. Nothing is pushed, tagged
    or published yet." (GWP-48 changes this text.)
  - Approve sends `useResolveDeskItem({ resolution:'approved', release:{ version, components, notes?, factsHeadSha } })`.
    Reject and dismiss work as usual.
- Touch and all devices (standing order): the version input is `type="text"` with `inputMode="text"`,
  `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}` and `enterKeyHint="done"` (dots and `-rc.1`
  rule out a numeric keypad). It sits above the preview so the soft keyboard does not cover it; on focus,
  `scrollIntoView({block:'center'})` on mobile (`useIsMobile`). Buttons are full width under `sm`, touch targets
  ≥ 44px, and the selects are native.
- Repo row (`WorkingBranchControl.tsx` / project settings repo row): a **Prepare release** button (owner, working
  branch ≠ main) calling the manual endpoint, and a link "Ship release waiting on the desk" when a live proposal
  exists (add `releaseProposal: {state, deskItemId} | null` to the repo DTO in `queries/misc.ts`).
- Query hooks: `apps/web/src/api/queries/forges.ts` (or a new `release.ts`): `usePrepareRelease`.
- Tests (`apps/web/src/test/desk-ship-release.test.tsx`): it renders the recommendation, reason, preview (heading
  with today's date and the intro line) and component rows; typing `1.3.0` or `abc` shows the inline message and
  disables Approve; raising runner to minor updates the row and the preview; the no-CHANGELOG case shows an
  editable notes textarea; Approve posts the payload.

### 4.7 Docs

- `docs/USER-GUIDE.md`, near the release PR paragraph (and next to GWP-46's component rules text): the Ship release
  item, how the version is recommended, changing it, component versions, and that approval does not publish yet.
- `docs/ARCHITECTURE.md`: event catalogue rows for the three events, the two tables in the schema section, the
  `repo.release_facts` command in section 11, and a "Release flow: proposal" paragraph (triggers, throttle,
  suppression, one live proposal).
- `docs/RUNNER.md`: `repo.release_facts` (read-only: fetches the branches and tags, reads files with `git show`,
  never writes).

## 5. Risks and how the design handles them

| Risk | Handling |
| --- | --- |
| Desk noise: many projects keep a working branch ahead of main all the time | One live item per repo (unique index). A dismissal suppresses the automatic (`sync`) trigger until a new release tag appears. Explicit triggers (release PR, Prepare release) still work. Business-mode and research projects are skipped. If the owner wants the ahead-of-main trigger off entirely, a repo toggle is a small follow-up. |
| Proposal goes stale while open | Facts refresh every ≤30 min. The view is computed live. Approval carries `factsHeadSha` and a moved head gives a 409 with a clear message. |
| Double bump of a hand-bumped component | Bumps start from the version at the last tag; `already_set` (2.3). GWP-48 writes with `{version: to}` only for `bump`. |
| Two semver implementations drift | The release code uses only GWP-46's `compareSemver`/`bumpVersion`. The pre-release change to `bumpVersion` is additive and keeps GWP-46's tests green. The runner's self-update semver is untouched. |
| `/releases` output drifts | `parseChangelog` output unchanged and guarded by a test with an unknown heading. `parseUnreleased` shares the scanner. |
| Older runners | Capability `release-facts:1`. Without a capable workstation the manual endpoint answers 409 "update the runner". |
| Large repos or first release with no tag | Commits capped at 1000 (`commitsTruncated` shown), per-rule counts computed on the runner (no path list on the wire), file size caps. |
| CEO approving a release | Owner-reserved key, plus the server's owner-only check. |
| Race between two facts results | Repo row lock plus the unique index. A unique violation is a no-op. |

## 6. Acceptance criteria → design

| AC | Where |
| --- | --- |
| Exactly one Ship release item per repo with a release PR open or ahead of main | Triggers (4.4), `reconcileReleaseProposal` step 3, `subjectKey`, unique index `release_proposals_one_live`. Server integration test: `release_pr` result plus two sync results give one item. |
| Added entries, no breaking → next minor with the reason | `parseUnreleased` counts, `recommendVersion` reason strings. Unit tests in shared and server, web render test. |
| BREAKING entry or `!` commit → major; only fixes/other → patch | `parseUnreleased.breaking`, `parseConventionalTitle.bang`, `hasBreakingFooter`. Unit tests. |
| Owner types another version; non-semver or not higher is refused with a message | `validateReleaseVersion` in the web (inline) and the server (400 `invalid_version`). Unit, web and server tests. |
| Preview shows the Unreleased entries under `## [x.y.z] - <today>` with the intro line | `composeReleaseSection` + `releaseIntro`. Unit and web tests. |
| GuildwiseHQ runner: `runner a.b.c -> a.b.(c+1) (N files changed under apps/runner/)`, or unchanged | Rule seeded by GWP-46's data migration; runner `changedCount` via `componentRuleApplies`; `componentBumps` (from = version at the tag, read with `readComponentVersion`) + `componentLine`. Unit tests, including the hand-bumped case. |
| No CHANGELOG.md: commits only, notes = commit titles, editable | `changelog: null` path in `recommendVersion`, `notesFromCommits`, notes textarea, `notes` accepted on approval. |
| `release proposed` on creation, `release approved` on approval; nothing pushed, tagged or published | `ReleaseProposed` and `ReleaseApproved` events. The runner command is read-only (fixture test checks origin unchanged). Approval queues no command. |

## 7. Assumptions about GWP-46, checked against the landed code (`96089eab`)

1. **Rule shape: holds.** `ComponentRuleSchema {name, paths, versionFile, pattern}` and `ComponentRulesSchema`
   (max 20) in `packages/shared/src/repo/component-rules.ts`, exported from `@aom/shared` through `repo/index.ts`.
   The payload now reuses `ComponentRulesSchema` directly (its caps: paths 200 chars, not the 300 drafted here).
2. **Storage: holds.** `project_repos.component_rules jsonb NOT NULL DEFAULT '[]'` (migration 2760), written by the
   `ProjectRepoComponentRulesSet` projector. `loadComponentRules(db, repoId)` reads that column with
   `ComponentRulesSchema.catch([])`, as `getProjectDetail` does. This card's migration is 2770.
3. **Pattern: does not hold as written.** The pattern is a JS regex (flags `md`) with exactly one capture group,
   validated by `componentRuleProblems`, as assumed. But GWP-46 also ships the helpers: `readComponentVersion`,
   `replaceComponentVersion`, `bumpVersion` and `compareSemver`. Consequences, applied above:
   - `extractComponentVersion` is dropped; `componentBumps` uses `readComponentVersion` (4.2).
   - The planned move of `apps/runner/src/update/semver.ts` into shared and the release module's own `bumpVersion`
     / `parseVersion` / `compareVersions` are dropped: the release code uses GWP-46's `compareSemver` and
     `bumpVersion` (a second `bumpVersion` would also collide in the package index). The runner's self-update semver
     stays as it is.
   - GWP-46's `bumpVersion` gets npm pre-release semantics for minor/major (`X.Y.0-pre` minor → `X.Y.0`,
     `X.0.0-pre` major → `X.0.0`); its existing tests stay green.
   - GWP-48 writes component files with `replaceComponentVersion(rule, text, {version: to})` for `bump` only.
4. **Glob semantics: holds.** `componentRuleApplies` uses the shared `globToRegExp` (and normalises `\` and `./`).
   The runner calls `componentRuleApplies(rule, paths).matched.length` itself, so there is no second matcher.
5. **Seeding: holds.** The data migration `guildwisehq-runner-rule-2026-10` gives every repository on
   `github.com/exinarium/guildwisehq` with no rules the runner rule (`apps/runner/**`, `apps/runner/src/version.ts`,
   `RUNNER_VERSION = '(.*)'`). This card adds no seed.

## 8. Out of scope here

The release commit, the push, the tag, the forge release, the repository-row "last release" links and the failure
and Retry desk items belong to GWP-48 and GWP-49. Detecting a merged release PR belongs to GWP-49; this card only
closes an approved proposal once its tag is seen.
