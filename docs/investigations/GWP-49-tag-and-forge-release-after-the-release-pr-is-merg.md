# GWP-49: Tag and forge release after the release PR is merged; release on the repository row

Part 4 of the release prep group (46 rules, 47 proposal, 48 release commit, 49 tag and forge release).
Every path below is relative to the GuildwiseHQ repository.

This design was written before GWP-48 (the release commit) landed. Section 0 records what the landed code changed.
Where section 0 and a later section disagree, **section 0 wins**; the later sections were updated where the change
touches them.

## 0. Revision after GWP-47 and GWP-48 landed

| # | Assumption | Verdict | What the landed code says, and what changes here |
| --- | --- | --- | --- |
| 1 | `ReleaseCommitted {proposalId, commitSha, branch, workstationId}` moves `release_proposals` to `committed` with `release_commit_sha` | **Did not hold (shape)** | GWP-48 keeps the ship in its **own table `release_ships`** (migration 2780, `id = release_proposals.id`, `UNIQUE(repo_id, version)`): `status` committing/committed/failed, `step`, `commit_sha`, `error`, `alert_desk_item_id`, `workstation_id`, `payload` (the `release.ship` payload without `commitAs`). `ReleaseCommitted` is `{shipId, commit, alreadyDone, resumed, signedOff, components}`. Its projection sets `release_ships.status='committed'`, `commit_sha`. **`release_proposals` stays `approved`** through the whole ship. Changes: `landModeFor` runs inside `applyReleaseShipResult` (`apps/server/src/release/ship.ts`), in the same transaction, right after `ReleaseCommitted` is appended. `releaseCommitSha` = `release_ships.commit_sha`. The workstation = `release_ships.workstation_id`. For `alreadyDone` the runner reports the commit that added the version section, so `R` is still right. |
| 2 | GWP-48 adds `committed`/`failed` to `release_proposals.state`, a `ReleaseFailed{step}` and a `release_failed` alert; this card adds `tagged`/`published` | **Did not hold (place)** | The states are on `release_ships.status`, not on the proposal. `ReleaseFailed` is `{shipId, step: string (free text, "so later steps can use it"), error, alertDeskItemId?}`, and its projection writes `status='failed'`, `step`, `error`, `alert_desk_item_id`. The alert is `DESK_SUBKIND.releaseFailed` (`'release_failed'`, `packages/shared/src/testing/index.ts`) with options retry/dismiss and `data {repoId, shipId, step, summary}`. `desk.ts closeItem` routes it to `retryReleaseShipIn` / `dismissReleaseShipIn`. There is also a `release_committed` notice (`DESK_SUBKIND.releaseCommitted`). Changes: (a) all publish columns go on **`release_ships`**, and its `status` CHECK gains `'tagged'` and `'published'` (4.4). (b) `ReleaseFailed` is **reused as is** with step `land`/`tag`/`publish`. No new failure event and no new alert subkind: the failure alert is the same `release_failed` alert, built by the same code (extract GWP-48's alert block into one helper). (c) **`retryReleaseShipIn` branches on `ship.step`.** For `land`/`tag`/`publish` it appends the new `ReleasePublishRetried` (projection: status back to `committed`, or `tagged` when `tag_name` is set, `error=NULL`) and enqueues `release.publish`. It must **not** append `ReleaseShipStarted`, because that projection resets the row to `committing` and resends `release.ship`. The owner-only check (`failedShipOf`) and `not_failed` stay. (d) `dismissReleaseShipIn` works unchanged: it closes the approved proposal as `dismissed`. A pushed tag stays. (e) New alert subkind `release_published` goes next to `releaseCommitted` in `DESK_SUBKIND`. |
| 3 | GWP-48 knows whether the repository needs DCO and uses `commitAs` | **Held in part** | `commitAs` holds: `loadCommitAs(tx, projectId)` is read on every send. DCO is **not stored**. The runner detects it at ship time with `detectSignOff(worktreeDir)` (`apps/runner/src/git/dco.ts`), unless the payload has `signOff`. `ReleaseCommitted.signedOff` records the outcome, but no column keeps it. Change: the merge-mode `land.signoff` becomes **optional**. When it is absent, the runner calls `detectSignOff` on the integration worktree (main plus the merge), the same way `release-ship.ts` does. The server does not pass it. |
| 4 | GWP-48 may already open or refresh the release PR; `repo_pr_requests` holds its url | **Did not hold** | GWP-48 does not open the release PR. It only reads the newest `repo_pr_requests` row with `state='opened'` for the notice text. So the fallback in 3.4 step 2 is **required**: when the project's `default_completion` is `'pr'` and no opened request exists, `landModeFor` asks for the release PR with the internals of `requestReleasePr` (`apps/server/src/commands/release-pr.ts:18`), as the system actor, on `release_ships.workstation_id`. `applyReleasePrResult` then fills `repo_pr_requests.url`, and `enqueueReleasePublish` reads the newest opened url on every send. It does not freeze the url at commit time. |
| 5 | GWP-47's shared module (semver, `RELEASE_TAG_RE`), `release_proposals`, `ReleaseApproved.notes/notesSource`, the `release_publish` key, `repo_release_facts.lastTag`, the DTO `releaseProposal` | **Held in part (names and shapes)** | These exist: `RELEASE_TAG_RE` and `tagVersion` (`packages/shared/src/release/tags.ts`), `release_proposals`, `ReleaseApproved.notes/notesSource`, `resolveReleaseBase` (`apps/runner/src/git/release-pr.ts`), and the owner-reserved `release_publish` key in `ceo/policy.ts`. They differ in these ways: there is **no `parseVersion`/`compareVersions`**, so semver ordering is `compareSemver(a, b): number \| null` from `packages/shared/src/repo/component-rules.ts`. **`releaseSectionOf(md, version)` already exists** (`release/changelog-rewrite.ts`: the heading is included, it stops at the next version heading or link reference). `changelogSection` is therefore `releaseSectionOf` minus its first line, not a new parser. `facts.lastTag` is `{name, sha} \| null` (not a string), and `facts.existingTags` lists the tags. `release_publish` is only mapped from `ship_release`, so the `release_failed` mapping is still this card's (4.4). The DTO `releaseProposal` is `{state: proposed\|approved, deskItemId, version, ship: {version, status, step, commit, error, branch, updatedAt} \| null}`: this card **extends `ship`** instead of adding fields to `releaseProposal`. GWP-47's reconcile (`release/reconcile.ts`, step 1) closes an **approved** proposal as `released` as soon as `v<version>` is in `facts.existingTags`. Since the proposal stays `approved` during the publish flow, the narrowing changes: step 1 **skips a proposal whose `release_ships` row exists and is not `published`**. The publish flow closes the proposal itself (`ReleaseProposalClosed{reason:'released', tag}`, together with `ReleasePublished`). Without this, the first facts read after the tag push would close the proposal, and a later publish failure would drop off the repository row. |

Not an assumption, but confirmed while checking: the owner (through the CEO, ledger 33453cfb) accepted the
**Release name** repository setting (3.5). Conditions: one resolved name for the tag message, the release title and
the desk item; USER-GUIDE and RUNNER.md say that the AC's "<Project name>" is read as the release name, which defaults
to the project name; tests cover the case with the setting and the case without it. `ReleaseShipPayload.projectName`
is the project name only; the publish payload carries the resolved `title`.

## 1. Question

Once the owner has approved a "Ship release" desk item (GWP-47) and the release commit is on the working branch
(GWP-48), how does Guildwise:

1. notice that the release reached the main branch (a release PR merged on the forge, or Guildwise merging the working
   branch itself when the project lands work without PRs);
2. put an annotated tag `vX.Y.Z` on the right commit of main and push it;
3. create the forge release (GitHub, GitLab), or say that the forge has no release pages (plain git, Azure DevOps,
   Bitbucket);
4. do all of this idempotently, with a failed step on the desk and a Retry that continues from that step;
5. record the events, and show the last release on the repository row?

Planning left three open points. The answers are in section 3:

- Which branch does the tag go on? The repository's **main branch** (`project_repos.main_branch`, else the forge's
  default branch). For GuildwiseHQ the release PR goes from the working branch to `main`.
- `checkBranchMerged` or `Forge.changeState`? Both. The ancestor test from `merged.ts` is the primary signal. It is
  pulled out into a helper that never deletes anything. The forge state is the fallback for squash and rebase merges.
- How is the tag target found when Guildwise merges by itself? The runner makes the merge commit itself and tags
  exactly that commit.

## 2. Findings

### 2.1 What exists

| Area | Where | What it gives us / the trap |
| --- | --- | --- |
| Merged-branch check | `apps/runner/src/git/merged.ts` `checkBranchMerged` | `merge-base --is-ancestor <card branch> <working branch>`, then it **deletes the branch** (local, and remote for `push_branch`). Cannot be called as is: it would delete the working branch. The ancestor test is the reusable part. |
| Server merge polling | `apps/server/src/dispatcher/phases.ts` `mergeChecks` (every `MERGE_CHECK_INTERVAL_SECONDS` = 180 s) | Pattern for "enqueue one command per subject unless one is pending or recent" (`NOT EXISTS runner_commands ... payload->>'cardId'`). |
| PR state from the forge | `Forge.changeState(repo, id)` (GitHub `gh pr view --json state`, GitLab MR `state`, Azure, Bitbucket) | Only used from the agent CLI (`hygiene.change_state` rpc). It gives open/merged/closed, but not the merge commit. |
| Release PR | `apps/runner/src/git/release-pr.ts` (`openReleasePr`, `resolveReleaseBase`), server `commands/release-pr.ts` (`requestReleasePr`, `applyReleasePrResult`), table `repo_pr_requests` (state, url) | The PR url (when Guildwise opened it) is the only link between a repository and its release PR. GWP-48 does not open it (section 0, #4). |
| Release commit (GWP-48) | runner `git/release-ship.ts` (`shipReleaseCommit`), `git/dco.ts` (`detectSignOff`); server `release/ship.ts` (`startReleaseShipIn`, `retryReleaseShipIn`, `dismissReleaseShipIn`, `applyReleaseShipResult`); table `release_ships`; projection `projections/release.ts` | The state, failure alert, Retry and Dismiss this card extends (section 0, #1–#2). |
| Forge adapters | `apps/runner/src/forge/{types,github,gitlab,azure,bitbucket,plain}.ts`, `index.ts` (`forgeForUrl`, `gitAuthFor`) | `caps` has no release capability. GitHub goes through `gh` (`ForgeEnv.exec`, `ghBin`), GitLab through REST `jsonCall(env.fetch, ...)`. Tests inject both. `bitbucket-dc` and unknown hosts are `PlainGitForge`. |
| Executor stdin | `apps/runner/src/toolchain/exec.ts` `ExecOptions.input` | `gh release create --notes-file -` can take the notes on stdin. No temp file is needed. |
| Integration worktree, identity, lock | `git/integration.ts` `withIntegrationWorktree`, `git/identity.ts` `requireCommitIdentity` + `commitEnv`, `git/repo-lock.ts` `withRepoLock`, `git/completion.ts` (merge + push + protected fallback) | Everything the "Guildwise merges into main" path needs. `commitEnv` sets `GIT_COMMITTER_*`, which git also uses as the **tagger** of an annotated tag. |
| Protected-branch refusal | `git/gh.ts` `isProtectedBranchRejection` | Lets the merge path fall back to a release PR. |
| Repository row | `queries/misc.ts` `getProjectDetail` (`releasePr`, `releaseProposal.ship` from `release_ships`), `packages/shared/src/api/projects.ts` `ProjectRepoDtoSchema`, web `WorkingBranchControl.tsx` | Place for "last release" and the publish progress. |
| Forge web links | `packages/shared/src/forge/index.ts` `repoFileUrl` | URL shapes per forge. A `repoTagUrl` fits next to it, so the server can link tags without a runner. |
| Changelog section | `packages/shared/src/release/changelog-rewrite.ts` `releaseSectionOf` | One version's block, heading included. |
| Existing tags | GuildwiseHQ `v1.0.1` … `v1.3.0` | All annotated, message `Guildwise HQ x.y.z`. The project in Guildwise is called **"Guildwise HQ Platform"** (3.5). |

### 2.2 Merge shapes the detector must handle

| How the release reached main | Release commit `R` vs `origin/main` | Commit to tag |
| --- | --- | --- |
| Merge commit (GitHub "Create a merge commit", GitLab default, Guildwise's own `--no-ff`) | `R` is an ancestor | The first-parent commit of main that brought `R` in (the merge commit `M`) |
| Fast-forward (GitLab ff, a manual `git merge --ff-only`) | `R` is an ancestor, on main's first-parent line | `R` itself |
| Squash or rebase merge | `R` is **not** an ancestor | The commit the forge reports (`mergeCommit`, `merge_commit_sha`/`squash_commit_sha`), after checking it is on main |
| Not merged yet | not an ancestor, forge says `open` (or unknown) | none: wait |
| PR closed without merging | not an ancestor, forge says `closed` | none: failed step `land` |

Finding `M`: `git rev-list --first-parent --ancestry-path R..origin/main` lists the first-parent commits of main
that descend from `R`, newest first. The last one (`O`) is the commit that brought `R` in. If `O^1 == R`, `R` was
fast-forwarded and the target is `R`. If the list is empty, main is `R` and the target is `R`. Otherwise the target
is `O`.

### 2.3 Forge release APIs

- **GitHub** (`gh`): `gh release view <tag> --repo <o/r> --json url,isDraft,isPrerelease`. Exit 0 means it exists.
  "release not found" means absent. Anything else is an error. To create:
  `gh release create <tag> --repo <o/r> --verify-tag --title <t> --notes-file - [--latest | --latest=false] [--prerelease]`.
  `--verify-tag` makes gh refuse when the tag is not on the remote, so gh never creates or moves a tag itself. The
  release URL is the last `https://` line of the output.
- **GitLab** REST: `GET /projects/:id/releases/:tag_name` (404 means absent) and
  `POST /projects/:id/releases {tag_name, name, description}`. 409 "Release already exists" means re-read it and
  report it. The URL is `_links.self`, else `https://<host>/<path>/-/releases/<tag>`.
- **Azure DevOps Repos, Bitbucket Cloud, Bitbucket DC, plain git**: no release pages. The tag is the release.

## 3. Options and decisions

### 3.1 Detecting the merge

| Option | Pros | Cons |
| --- | --- | --- |
| A. Call `checkBranchMerged` as is | Literal reading of the card | It deletes the branch it checks (here the working branch), and it checks against the working branch, not main. Unusable. |
| B. Forge `changeState` only | Knows squash merges | Needs the PR url and a forge login. Plain git and "merged by hand" are never seen. |
| **C. Ancestor test first (extracted from `merged.ts`), forge state as fallback** | Works on every forge, with or without the PR url. Catches squash/rebase when the url is known. Closed PRs are reported. | Squash merges of a PR Guildwise did not open are not detected (the repository row says so). |

**Choice: C.** Extract `isAncestor(repoPath, a, b)` from `merged.ts` (export it there or move it to `git/git.ts`).
`checkBranchMerged` keeps calling it, so its behaviour stays the same and `branch-merged.test.ts` stays green. The
release path calls the helper and **never deletes a branch**.

### 3.2 One command or two

GWP-48 owns `release.ship` (release commit and push, steps prepare/components/changelog/commit/push). It runs once,
right after approval. Tagging happens later, possibly days later, after a person merges the PR. **A sibling command
`release.publish`**, polled by the server, keeps the two lifetimes apart. It shares the `release_ships` row, the
`ReleaseFailed` event and the `release_failed` alert with GWP-48 (section 0, #2).

### 3.3 Where the step state lives

The runner is **stateless and works out every step again from git and the forge** on each run: is `R` on main, does
the tag exist (and where), does the release exist. That makes a rerun and Retry idempotent by construction: steps
already done are seen as done and skipped, and the run continues from the failed step. The server keeps the outcome
per step on the **`release_ships`** row, for the desk, the events and the repository row.

### 3.4 Landing without a PR

The server decides the land mode when the release commit is reported (inside `applyReleaseShipResult`, right after
`ReleaseCommitted`):

1. The latest `repo_pr_requests` row of the repository is `opened` with a url: mode `pr`.
2. Else the project's `default_completion` is `'pr'`: ask for the release PR (the internals of `requestReleasePr`,
   system actor, `release_ships.workstation_id`), then mode `pr`. **GWP-48 does not do this, so this step is
   required** (section 0, #4).
3. Else (`'merge'`): mode `merge`. The runner merges the **release commit** (`R`, not the moving tip of the working
   branch, so exactly what was approved lands) into main in an integration worktree, with `--no-ff` and the project's
   commit identity (`--signoff` when `detectSignOff` on that worktree says so, section 0, #3), and pushes
   `HEAD:refs/heads/<main>` without force. If the host refuses because main is protected
   (`isProtectedBranchRejection`), it opens the release PR through `forgePrCreator` and answers `waiting` with mode
   `pr` and the url, as `completion.ts` does.

In mode `pr` the payload's `prUrl` is read again on every send from the newest opened `repo_pr_requests` row.

### 3.5 Tag message and release title: the release name

The project is "Guildwise HQ Platform", but the card and every existing tag want "Guildwise HQ 1.4.0". **Decision
(confirmed by the owner, ledger 33453cfb): a repository setting `releaseName`** (expert mode, next to GWP-46's
component rules). It defaults to the project name when empty. The GuildwiseHQ repository is seeded with
`Guildwise HQ`, the same way GWP-46 seeds the runner rule. The tag message, the release title and the desk item all use
`releaseTitle(name, version)` = `"<name> <version>"`.

### 3.6 Release notes

"Exactly the version's changelog section" is read **at the tag target**, so the notes match what is tagged:
`changelogSection(md, version)` = `releaseSectionOf(md, version)` (landed in GWP-48) without its first, heading line,
trimmed. When the approval said `notesSource: 'commits'` (no CHANGELOG.md), the notes are the approved text
(`release_proposals.notes`) sent in the payload. When CHANGELOG.md exists at the target but has no `[x.y.z]` section,
the step fails ("CHANGELOG.md on main at <sha> has no section for 1.4.0"). That is also the safety check that the
target really holds the release commit.

### 3.7 "Latest"

`--latest` only when the version is not a pre-release **and** is the highest semver (`compareSemver`) among the remote
release tags (`RELEASE_TAG_RE`). That way a 1.3.1 hotfix after 1.4.0 does not take "latest". Otherwise
`--latest=false`, plus `--prerelease` for a pre-release.

## 4. Design

### 4.1 Flow

```
applyReleaseShipResult (GWP-48) appends ReleaseCommitted
   └─ same tx: landModeFor (3.4) -> ReleasePublishPlanned {landMode, prUrl?}; release_ships.step='land'; enqueue at once
                                     │
dispatcher releaseChecks (every 180 s, hourly after 24 h; at once after commit and on Retry)
   enqueue release.publish only for release_ships status committed|tagged whose proposal is approved
                                     │
runner publishRelease:  fetch main + R ─> land (detect | merge) ─> tag (decide/create/push) ─> forge release
                                     │
result ─> applyReleasePublishResult (only while status committed|tagged):
   waiting          -> step_message, publish_checked_at (no event, no desk item)
   landed           -> ReleaseLanded
   tag created/existed -> ReleaseTagged (status 'tagged')
   release created/existed/none -> release_published alert + ReleasePublished (status 'published')
                                   + ReleaseProposalClosed{reason:'released', tag}
   failed(step, message) -> release_failed alert + ReleaseFailed{step} (GWP-48's event, status 'failed')
Retry on release_failed: step land|tag|publish -> ReleasePublishRetried + enqueue release.publish
                         step prepare..push   -> GWP-48's path (ReleaseShipStarted + release.ship)
```

### 4.2 Shared (`packages/shared`)

`packages/shared/src/release/` (GWP-47/48). Add `publish.ts` and export it from `index.ts`:

```ts
export const RELEASE_PUBLISH_STEPS = ['land', 'tag', 'publish'] as const;
export type ReleasePublishStep = (typeof RELEASE_PUBLISH_STEPS)[number];
export const releaseTitle = (name: string, version: string): string => `${name.trim()} ${version}`;

/** Raw markdown of one version's section, without its heading: releaseSectionOf minus its first line; null when absent. */
export function changelogSection(md: string, version: string): string | null;

export type TagDecision =
  | { action: 'create' }
  | { action: 'push' }                                 // local tag on target, not on the remote yet
  | { action: 'report'; where: 'remote' }              // remote tag already points at target
  | { action: 'refuse'; message: string };             // remote or local tag on another commit: never moved
export function decideTag(input: { target: string; remote: string | null; local: string | null; tag: string }): TagDecision;

/** --latest only for the highest non-pre-release version among the remote release tags (compareSemver). */
export function isLatestRelease(version: string, remoteTags: string[]): boolean;
```

The tag name stays `v${version}` (as `ReleaseShipPayload.tag` already does).

`packages/shared/src/forge/index.ts`, next to `repoFileUrl`:

```ts
export function repoTagUrl(remoteUrl: string, tag: string, override?: ForgeKind | null): string | null;
//   github  https://host/o/r/tree/<tag>            gitlab  https://host/ns/r/-/tags/<tag>
//   bitbucket-cloud https://host/ws/r/src/<tag>    azure   https://host/org/proj/_git/r?version=GT<tag>
//   plain git / bitbucket-dc: null
export function forgeHasReleasePages(kind: ForgeKind): boolean;       // github, gitlab
export function noReleasePageText(kind: ForgeKind, tag: string): string;
```

`DESK_SUBKIND` (`packages/shared/src/testing/index.ts`): add `releasePublished: 'release_published'` next to
`releaseCommitted`.

Protocol (`packages/shared/src/protocol/runner.ts`, next to the `release.ship` block): `'release.publish'` in the
command names and `CommandPayloadSchemas`, and `RELEASE_PUBLISH_CAPABILITY = 'release-publish:1'`.

```ts
export const ReleasePublishPayloadSchema = z.object({
  requestId: z.uuid(), shipId: z.uuid(), projectId: z.uuid(), repoId: z.uuid(),
  remoteUrlNormalized: z.string(), forge: ForgeKindSchema.optional(),
  version: z.string().max(60).refine((v) => RELEASE_TAG_RE.test(`v${v}`)), tag: z.string().max(100),
  title: z.string().max(200),                                                        // releaseTitle(releaseName, version)
  workingBranch: z.string().min(1).max(200), mainBranch: z.string().max(200).optional(), // absent: resolveReleaseBase
  releaseCommitSha: z.string().regex(/^[0-9a-f]{40}$/),                              // release_ships.commit_sha
  land: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('pr'), prUrl: z.string().max(500).optional() }),
    z.object({ mode: z.literal('merge'), signoff: z.boolean().optional() }),          // absent: detectSignOff
  ]),
  notesSource: z.enum(['changelog', 'commits']),
  notes: z.string().max(50_000).optional(),             // only for 'commits'
  commitAs: CommitAsSchema.nullable().optional(),       // merge commit and tagger identity (loadCommitAs on send)
});
export const ReleasePublishResultSchema = z.object({
  ok: z.boolean(),
  stage: z.enum(['waiting', 'done', 'failed']),
  failedStep: z.enum(['land', 'tag', 'publish']).optional(),
  error: z.string().max(4000).optional(),               // git's or the forge's message
  waiting: z.object({ reason: z.string().max(300), prState: z.enum(['open', 'closed', 'merged']).nullable() }).optional(),
  land: z.object({ mode: z.enum(['pr', 'merge']), mergeSha: z.string(), by: z.enum(['forge', 'guildwise', 'found']),
    prUrl: z.string().optional(), signedOff: z.boolean().optional() }).optional(),
  tag: z.object({ name: z.string(), target: z.string(), state: z.enum(['created', 'existed']), url: z.string().nullable() }).optional(),
  release: z.object({ state: z.enum(['created', 'existed', 'none']), url: z.string().nullable(),
    latest: z.boolean().optional(), message: z.string().max(300).optional() }).optional(),
});
```

`land`, `tag` and `release` are filled for every step that finished in this run, even when a later step failed.

Events (`packages/shared/src/events/release.ts`, stream `streamId.release(shipId)`):

```ts
ReleasePublishPlanned { shipId, landMode: 'pr'|'merge', prUrl?: string }
ReleaseLanded    { shipId, mergeSha, mode: 'pr'|'merge', by: 'forge'|'guildwise'|'found', prUrl? }
ReleaseTagged    { shipId, tag, targetSha, state: 'created'|'existed', tagUrl: string|null }
ReleasePublished { shipId, forge, state: 'created'|'existed'|'none', releaseUrl: string|null, latest?: boolean, deskItemId }
ReleasePublishRetried { shipId, step: 'land'|'tag'|'publish', workstationId }
// failures: GWP-48's ReleaseFailed { shipId, step: 'land'|'tag'|'publish', error, alertDeskItemId } as is
```

API DTO (`packages/shared/src/api/projects.ts`, `ProjectRepoDtoSchema`):

```ts
lastRelease: z.object({
  version: z.string(), tag: z.string(), tagUrl: z.string().nullable(),
  releaseUrl: z.string().nullable(), releasePage: z.boolean().nullable(),   // null: tagged outside Guildwise, unknown
  at: IsoTime, source: z.enum(['guildwise', 'tag']),
}).nullable().optional(),
// GWP-48's releaseProposal.ship is extended (not releaseProposal itself):
ship: { ...,
  status: z.enum(['committing', 'committed', 'tagged', 'published', 'failed']),
  step: z.string().nullable(),            // GWP-48's steps plus land/tag/publish
  landMode: z.enum(['pr','merge']).nullable().optional(), prUrl: z.string().nullable().optional(),
  message: z.string().nullable().optional(),                 // waiting reason (step_message)
  tag: z.string().nullable().optional(), tagUrl: z.string().nullable().optional(),
  alertDeskItemId: z.uuid().nullable().optional(),           // the release_failed alert for Retry
}
```

### 4.3 Runner

**Forge interface (`forge/types.ts`):**

```ts
caps: { ...; releases: boolean };
export interface ForgeRelease { url: string; draft?: boolean }
export interface CreateReleaseInput { tag: string; title: string; notes: string; latest: boolean; prerelease: boolean }
findRelease?(repo: RemoteRepo, tag: string): Promise<ForgeRelease | null>;   // null = no release for the tag
createRelease?(repo: RemoteRepo, r: CreateReleaseInput): Promise<ForgeRelease>;
changeMergeCommit?(repo: RemoteRepo, id: string): Promise<string | null>;    // squash/rebase merges
```

- `github.ts`: `caps.releases = true`. `findRelease` and `createRelease` as in 2.3 (`gh(...)` with
  `{ input: notes }`: extend the private `gh()` helper with an optional `input`). Exit 127 throws
  `ForgeUnavailableError('gh is not available')`. A non-zero exit throws `gh release create failed: <stderr>`. If
  create says "already exists", run `findRelease` again and return it. `changeMergeCommit`:
  `gh pr view <id> --json mergeCommit --jq .mergeCommit.oid`.
- `gitlab.ts`: `caps.releases = true`. `findRelease` maps a 404 `ForgeHttpError` to null. `createRelease` maps a 409
  to `findRelease`. Notes go in `description`. `changeMergeCommit`: `merge_commit_sha ?? squash_commit_sha`.
- `azure.ts`, `bitbucket.ts`, `plain.ts`: `caps.releases = false`, no methods.

**`apps/runner/src/git/release-publish.ts` (new):** `publishRelease({ payload, repoPath, integrationDir, forgeEnv, auth })`
returns `ReleasePublishResult`. It never throws for expected failures (like `shipReleaseCommit`). It runs under
`withRepoLock(repoPath)`.

1. Guards: `isSafeGitRef` on the branches and the tag, an origin remote, `RELEASE_TAG_RE` on the tag.
2. `base` = `payload.mainBranch` ?? `resolveReleaseBase` (from `release-pr.ts`). Fetch with auth:
   `fetch -- origin <base>`, `fetch -- origin <workingBranch>`. **Never fetch tags with force, never check out in the
   clone.**
3. **Land.** If `R` is not present (`cat-file -e R^{commit}`), the step is `land`, error "the release commit R is not
   in this clone (was the working branch rewritten?)".
   - If `isAncestor(R, origin/<base>)`, compute the target as in 2.2: `by:'found'`.
   - Else, when `land.mode === 'pr'` and a `prUrl` is given and `forge.changeState` exists: `merged` leads to
     `changeMergeCommit`, then fetch the base again; that sha must be on `origin/<base>`, else wait. `closed` means
     failed `land` with "The release pull request <url> was closed without merging." `open` or unknown means
     `{stage:'waiting', waiting:{reason:'the release pull request is not merged yet', prState}}`.
   - Else, when `land.mode === 'merge'`: in `withIntegrationWorktree` from `origin/<base>`, sign-off =
     `land.signoff ?? (await detectSignOff(worktree)).required`, then
     `git merge --no-ff [--signoff] -m "Merge <workingBranch> into <base> for release <version>" <R>` with
     `commitEnv(requireCommitIdentity(...))`, then `push origin HEAD:refs/heads/<base>` (with auth, no force). A
     conflict means failed `land` ("Merging the release into <base> conflicts in <files>. Merge <base> into
     <workingBranch> first, then Retry."), and the merge is aborted. A protected refusal opens the release PR
     (`forgePrCreator`) and answers `waiting` with `land:{mode:'pr', prUrl}`. Any other push failure means failed
     `land` with git's message. On success the target is the new merge commit, `by:'guildwise'`.
4. **Tag.** `remote` = the peeled commit of `git ls-remote --tags origin refs/tags/<tag> refs/tags/<tag>^{}` (with
   auth). `local` = `rev-parse -q --verify refs/tags/<tag>^{commit}`. Then `decideTag`:
   - `create`: first the notes check (step 5 reads CHANGELOG.md at the target; a missing section fails step `tag`
     and no tag is made). Then `git tag -a <tag> -m "<title>" <target>` with `commitEnv(identity)` (the tagger is
     the commit identity), then `git push origin refs/tags/<tag>` (never `--tags`, never `--force`). If the push
     fails, step `tag` fails with git's message. The local tag stays, so the next run finds `local === target` and
     takes the `push` action. That is the Retry path.
   - `push`: push as above. `report`: `state:'existed'`. `refuse`: fail `tag` with the message.
   - `tag.url = repoTagUrl(originUrl, tag, payload.forge)`.
5. **Notes.** `notesSource === 'changelog'`: `git show <target>:CHANGELOG.md`, then `changelogSection(md, version)`,
   which must not be null (3.6). `'commits'`: `payload.notes`. Empty notes become `"Release <version>."`.
6. **Publish.** `forgeForUrl(forgeEnv, originUrl, payload.forge)`:
   - No `createRelease`: `release:{state:'none', url:null, message: noReleasePageText(kind, tag)}`.
   - `findRelease(tag)` finds one: `state:'existed'` (never edited; for a draft the message is "a draft release
     exists; publish it on the forge"). It finds none: `createRelease({tag, title, notes, latest:
     isLatestRelease(version, remoteTags), prerelease})`, `state:'created'`. `remoteTags` comes from
     `git ls-remote --tags origin 'refs/tags/v*'`.
   - An exception fails `publish` with `errText(err)`, the forge's message.
7. `stage:'done'`.

Dispatch: in `runner.ts`, a `release.publish` branch next to `release.ship` (`findRepo`; no clone means
`{ok:false, stage:'failed', failedStep:'land', error:'no local clone for ...'}`), with
`auth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge)`. Announce `RELEASE_PUBLISH_CAPABILITY` in
`hello.capabilities`. After a `merge`-mode land, `void this.sync.sync(...)` for the working branch, as `finalize.execute`
does.

### 4.4 Server

**Migration** `apps/server/migrations/2790_release_publish.sql` (next free number after 2780):

```sql
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS release_name text;   -- null: the project name (3.5)
UPDATE project_repos SET release_name = 'Guildwise HQ' WHERE <same match as the GWP-46 runner-rule seed> AND release_name IS NULL;
ALTER TABLE release_ships
  ADD COLUMN land_mode text CHECK (land_mode IN ('pr','merge')), ADD COLUMN pr_url text,
  ADD COLUMN merge_sha text, ADD COLUMN landed_at timestamptz,
  ADD COLUMN tag_name text, ADD COLUMN tag_sha text, ADD COLUMN tag_url text, ADD COLUMN tag_state text, ADD COLUMN tagged_at timestamptz,
  ADD COLUMN release_url text, ADD COLUMN release_state text CHECK (release_state IN ('created','existed','none')),
  ADD COLUMN release_latest boolean, ADD COLUMN published_at timestamptz, ADD COLUMN published_desk_item_id uuid,
  ADD COLUMN step_message text,
  ADD COLUMN publish_checked_at timestamptz, ADD COLUMN publish_checks int NOT NULL DEFAULT 0;
-- widen the status CHECK: drop the generated constraint of 2780 and add
--   CHECK (status IN ('committing','committed','tagged','published','failed'))
```

The existing `step`, `error`, `alert_desk_item_id` and `workstation_id` of `release_ships` are reused (`step` gets
`land`/`tag`/`publish`).

Projection (`projections/release.ts`): `ReleasePublishPlanned` sets `land_mode`, `pr_url`, `step='land'`.
`ReleaseLanded` sets `merge_sha`, `landed_at`, `step='tag'`. `ReleaseTagged` sets `tag_*`, `status='tagged'`,
`step='publish'`. `ReleasePublished` sets `release_*`, `status='published'`, `published_at`, `step=NULL`.
`ReleasePublishRetried` sets `status = CASE WHEN tag_name IS NULL THEN 'committed' ELSE 'tagged' END`, `error=NULL`.
GWP-48's `ReleaseFailed` projection already writes `status='failed'`, `step`, `error`, `alert_desk_item_id`. Add the
new tables to nothing: `release_ships` is already in the project delete list.

**`apps/server/src/release/publish.ts` (new):**

- `landModeFor(ctx, tx, ship)`: section 3.4. Called from `applyReleaseShipResult` right after `ReleaseCommitted`, in
  the same transaction. It appends `ReleasePublishPlanned`, then calls `enqueueReleasePublish`.
- `releaseChecks(ctx)` joins the dispatcher pass next to `mergeChecks`. It selects `release_ships` with
  `status IN ('committed','tagged')` **whose proposal is `approved`** (`JOIN release_proposals p ON p.id = s.id AND
  p.state='approved' AND p.approved_by IS NOT NULL`), in active projects of dev-mode orgs. It skips any ship with a
  `release.publish` pending or sent for `payload->>'shipId'`, and any ship that had one created within the interval
  (180 s for the first 24 h after `committed`, then 1 h). For each remaining ship it calls `enqueueReleasePublish`.
  **Ships in `committing` or `failed`, and proposals in `proposed`, never get this command. That is the "nothing
  without approval" guard.**
- `enqueueReleasePublish(tx, ship)`: the workstation is `release_ships.workstation_id` if it is active and announces
  `release-publish:1`, else the query of `shipWorkstation` with `RELEASE_PUBLISH_CAPABILITY`. If none can run it, it
  sets `step_message = 'Waiting for a workstation with an up-to-date runner and this repository'` and enqueues nothing.
  The payload is as in 4.2: `title = releaseTitle(repo.release_name ?? project.name, version)`, `releaseCommitSha =
  commit_sha`, `prUrl` = the newest opened `repo_pr_requests.url`, `notes` from `release_proposals.notes` when
  `notes_source='commits'`, `commitAs` via `loadCommitAs`.
- `applyReleasePublishResult(ctx, workstationId, payload, ok, result, error)`: a gateway branch in `handlers.ts` next
  to `release.ship`. In one `withAppendTx` it locks the ship `FOR UPDATE` and ignores the result unless the status is
  `committed` or `tagged` (a late or duplicate answer changes nothing). Then:
  - `land` present and `merge_sha` null: `ReleaseLanded`.
  - `tag` present and `tag_name` null: `ReleaseTagged`.
  - `release` present: the `release_published` alert (subject key `release_published:<shipId>`, title
    `Released <title>`, body with the tag link and the release link, or `noReleasePageText`, `data {repoId, shipId,
    tagUrl, releaseUrl}`), then `ReleasePublished{deskItemId}` and `ReleaseProposalClosed{proposalId: shipId,
    reason:'released', tag}`.
  - `stage:'waiting'`: update `step_message`, `publish_checked_at`, `publish_checks`, and `land_mode`/`pr_url` (via
    `ReleasePublishPlanned`) when the merge path fell back to a PR. No other event, no desk item.
  - `stage:'failed'` (or `ok:false` from the gateway): the `release_failed` alert through the helper extracted from
    `applyReleaseShipResult` (title `Release <version> stopped at <step>`, body = the message plus "Steps that already
    ran are not repeated.", options retry/dismiss, data `{repoId, shipId, step, summary}`), then GWP-48's
    `ReleaseFailed{shipId, step, error, alertDeskItemId}`. For a failure after the tag was pushed, the body does not
    say "no tag was made".
- **Retry** (section 0, #2c): `retryReleaseShipIn` in `release/ship.ts` gets a branch. When `ship.step` is in
  `RELEASE_PUBLISH_STEPS`, it appends `ReleasePublishRetried` and calls `enqueueReleasePublish`, returning its
  workstation. Otherwise the GWP-48 path stays. Owner-only (`failedShipOf`) and `not_failed` are unchanged.
  `dismissReleaseShipIn` is unchanged.
- **CEO policy** (`packages/shared/src/ceo/policy.ts`): map subkind `release_failed` to the owner-reserved key
  `release_publish` (today only `ship_release` maps to it), so the CEO never retries a release by itself.
- **GWP-47 reconcile** (`release/reconcile.ts`, step 1): close an approved proposal as `released` only when
  `NOT EXISTS (SELECT 1 FROM release_ships WHERE id = live.id AND status <> 'published')`. While a ship is being
  published, the proposal belongs to this flow, which closes it on publish. A tag made by hand is reported as
  `existed` by the runner, and the release still gets its page.
- The approval body in `reconcile.ts` and the `release_committed` notice ("Nothing is tagged or published yet.")
  gain one sentence: "Once the release PR is merged, Guildwise tags it and creates the release page."

**Repository row (`queries/misc.ts` `getProjectDetail`):**
- `lastRelease`: the newest `release_ships` row with `status='published'` for the repository (source `guildwise`:
  version, `tag_name`, `tag_url`, `release_url`, `releasePage = release_state <> 'none'`, `published_at`). When there
  is none, it comes from `repo_release_facts.facts->'lastTag'->>'name'` (source `tag`, `version = tagVersion(name)`,
  `tagUrl = repoTagUrl(remote_url, name, forge_kind)`, `releaseUrl` null, `releasePage` null, `at` = facts
  `updated_at`). Otherwise null.
- `releaseProposal.ship` gains `landMode`, `prUrl`, `message` (`step_message`), `tag`, `tagUrl`, `alertDeskItemId`,
  and the wider `status`.

**Docs:** `docs/ARCHITECTURE.md` (release flow: tag and publish; the events; the columns; `release.publish` in the
command list), `docs/RUNNER.md` (`release.publish`: what it fetches, what it may push: one tag and, in merge mode,
main; never force; the release name), `docs/USER-GUIDE.md` near the release PR paragraph (what happens after
approval, the "waiting for the merge" state, Retry, the forges without release pages, the Release name setting and
that it is what the card calls "<Project name>").

### 4.5 Web

- `WorkingBranchControl.tsx`: a new `ReleaseStatus` next to the release PR and the GWP-48 ship status
  (`data-testid="release-status-<repo>"`):
  - Last release: "Last release **1.4.0** · [Tag v1.4.0] · [Release page]". When `releasePage === false`: "no release
    page (Azure DevOps has none)". When `source === 'tag'`: "Last release 1.3.0 · [Tag v1.3.0]". With no tag URL
    (plain git): plain text `v1.4.0`.
  - Progress, from `releaseProposal.ship` with status `committed`/`tagged`/`failed` and a publish step: committed
    gives "Release 1.4.0: waiting for the release pull request to be merged" (link to `prUrl`) or "merging into main";
    tagged gives "Release 1.4.0: tagged, creating the release page"; failed (step land/tag/publish) gives the danger
    text `error` plus a **Retry** button. The button calls `useResolveDeskItem` on `alertDeskItemId` with `approved`
    and shows the server's 403/409 text inline under the button, never as a toast. Keep GWP-48's existing display of
    committing/failed in prepare..push as it is.
  - Links: `target="_blank" rel="noreferrer"`. Touch: the links and the button are at least 44 px high under `sm`,
    the text wraps, nothing relies on hover.
- Repository settings, expert mode (next to GWP-46's component rules): a **Release name** text field (placeholder =
  project name, `autoCapitalize="words"`, `enterKeyHint="done"`, validation message inline; on a phone the soft
  keyboard opens and the field stays visible above it). It is saved through the same repository `PATCH` that takes
  `componentRules` (`apps/server/src/routes/projects.ts:487`): one more optional field `releaseName` (max 100,
  trimmed, empty = null), owner only, with its own small setter next to `setRepoComponentRules`.
- Desk: `release_failed` (already rendered by GWP-48) and `release_published` render as normal alerts. Add a renderer
  for `release_published` that shows `item.data.{tagUrl, releaseUrl}` as anchors.
- Tests (`apps/web/src/test/repo-release-status.test.tsx`): last release with both links; no-release-page text;
  source `tag`; waiting with the PR link; failed with Retry (posts `approved` to the alert); the inline error on 409.

## 5. Risks

| Risk | Handling |
| --- | --- |
| Tagging the wrong commit | Target computed from `R` (2.2), checked to be on `origin/<main>`, and CHANGELOG.md at the target must hold the version's section before any tag is made. |
| Moving or duplicating a tag or release | `decideTag` refuses another commit; push without force and never `--tags`; `gh --verify-tag`; find before create; "already exists" reads again. The runner works out the state again on every run. |
| Silent wait forever (squash merge of a PR Guildwise did not open) | The repo row shows the waiting reason. After 24 h the poll slows to hourly. The owner can open the release PR from Guildwise (then the url is known) or tag by hand (then the run reports `existed` and publishes). |
| Late or duplicate runner answers | The result is applied only in `committed`/`tagged`. Each event is appended only when its column is still null. |
| GWP-47 reconcile closing the proposal mid-flow | Step 1 skips proposals whose ship is not `published` (4.4). |
| Retry resending the wrong command | `retryReleaseShipIn` branches on `step`; publish steps never append `ReleaseShipStarted`. |
| Merge mode pushes to main | Only after approval, only the approved commit, no force, protected main falls back to a PR. |
| Older runners | Capability `release-publish:1`; the row explains the wait. |
| Desk noise | One open failure alert per ship (`alert_desk_item_id`), one published alert (subject key). "Waiting" is never a desk item. |

## 6. Acceptance criteria → design

| AC | Where | Test |
| --- | --- | --- |
| Annotated `vX.Y.Z` with message '<name> x.y.z' on the merge commit on main, pushed | 4.3 steps 3–4 | Runner integration (`apps/runner/test/release-publish.test.ts`, bare origin): PR-style `--no-ff` merge made in a second clone, then the tag object is of type `tag` with the right message, peels to M, and is on origin. Fast-forward case, then R. Merge mode with a DCO workflow file: the merge commit is signed off. |
| GitHub release, title, changelog section notes, latest | 4.3 step 6, `github.ts createRelease`, `changelogSection`, `isLatestRelease` | `forge-release.test.ts` with fake exec: the args include `--verify-tag --title "Guildwise HQ 1.4.0" --notes-file - --latest`, stdin = section. Shared test for `changelogSection` on the real CHANGELOG.md shape. Server test: title from `release_name` and, without it, from the project name (ledger condition 3). |
| GitLab release through the Releases API | `gitlab.ts createRelease/findRelease` | Fake fetch: POST body `{tag_name,name,description}`; 409 means read again. |
| No-release forges: tag pushed, desk says no page | `caps.releases=false`, `noReleasePageText`, `release_published` alert body | Runner test with `PlainGitForge` (`release.state 'none'`, message). Server test: the alert body has the text. |
| Rerun or Retry: no duplicate, existing reported, never moved or edited | `decideTag`, find-before-create, stateless runner, guarded apply | Rerun after success: `existed` for both, origin refs unchanged. Tag on another commit: `refuse`, tag unchanged. Release exists: `existed`, no create call. Duplicate result: no second event. |
| Failed tag push or release creation: desk failed with the message; Retry continues | `release_failed` alert + `ReleaseFailed`, `retryReleaseShipIn` publish branch | Runner: the bare origin's `pre-receive` hook rejects `refs/tags/*`, so `failedStep 'tag'` with git's text; remove the hook and rerun, so the local tag is pushed. Fake gh exits 1, so `failedStep 'publish'`. Server (`release-publish.test.ts`): alert; Retry appends `ReleasePublishRetried` (not `ReleaseShipStarted`) and enqueues `release.publish`; owner only; `not_failed`; a commit-step failure still retries `release.ship`. |
| Events tagged, published, failed; repo row last release with links | 4.2 events, 4.4 `lastRelease` | Server test: events appended once. DTO test for `lastRelease` (both sources). Reconcile test: an approved proposal with a `tagged` ship is not closed by a facts read that shows the tag. Web test. |
| Nothing tagged or published without approval | `releaseChecks` selects only committed/tagged ships of approved proposals; the runner tags only in `release.publish`; Retry is owner only | Server test: a `proposed` proposal, and an approved one whose ship is `committing`, get no command; a non-owner Retry gets 403. |

Suites the testers run and the builder does not: the E2E on a GitHub test repository (release PR, Ship release,
merge, then the tag and release on the repository row).

## 7. Dependencies (checked against the landed code, section 0)

GWP-46, GWP-47 and GWP-48 have landed. Section 0 lists what differed from the first design. The repository settings
endpoint for `releaseName` is the existing repository `PATCH` that already takes `componentRules`.

## 8. Out of scope

Deploying. Signing tags (GPG/SSH). Editing or deleting releases or tags. Release assets (binaries). Detecting squash
merges of PRs Guildwise did not open (shown as waiting, with a hint).
