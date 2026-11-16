# GWP-260: refuse to ship a repository whose submodule pointer is behind the latest release of the project repository it points to

## 1. Question

guildwise-cloud 0.2.9 and 0.2.10 shipped while their `core` submodule pointed at a GuildwiseHQ commit from before core 1.8.0.
Nothing in the release flow (release facts, the Ship release item, approve, start, retry) looks at submodule pointers.
How do we add a generic pointer gate? It should list each submodule at the commit being released, compare a submodule
that points at another repository of the same project with that repository's latest release tag, show the state on the
Ship release item, and refuse the ship (in the UI and on the server) while a pointer is `behind` or `not on a release tag`.

## 2. Findings (code read on `main` at 77a23d96)

### 2.1 Release facts (runner)

- `apps/runner/src/git/release-facts.ts` `readReleaseFacts` fetches the main branch, the working branch and the tags,
  then reads everything at `headSha` (the head of the working branch, `origin/<head>`). This answers `repo.release_facts`.
  It never checks out and never throws for expected failures (`fail()`).
- `releaseTagsAt(repoPath, sha)` gives every `RELEASE_TAG_RE` tag of the clone (`all`), a `newestFirst` sorter
  (`compareSemver`, pre-release tags count, the same rule `validateReleaseVersion` uses) and `last`, the newest tag merged
  into `sha`. `revParse` peels to `^{commit}`, so annotated tags (GuildwiseHQ's `v1.9.0` is a `tag` object) resolve to
  their commit. This is the one tag rule to reuse. Do not write a second parser.
- The runner handles the command in `apps/runner/src/runner.ts:2490`. It finds the clone with
  `findRepo(remoteUrlNormalized)` (matched with `normalizeRemoteUrl`) and passes `auth: this.scopeFor(p.postAs).auth`
  (a `GitAuth = (url, forge?) => {args, env}`). The same `findRepo` gives the runner's registered clone of **any**
  project repository on that workstation. This answers planning question (2): the pointed repository's tags come from
  its own registered clone, never from the submodule directory inside the superproject.
- Submodule helpers exist already:
  - `apps/runner/src/git/submodule-pin.ts` `readSubmodules(worktree, originUrl)` parses `.gitmodules` with
    `git config --file .gitmodules --list -z` and resolves relative URLs (`resolveRelativeSubmoduleUrl`) to a
    `normalized` form. It reads the **working-tree file**. Facts must read the file at a commit without checking it out.
  - `apps/runner/src/git/submodule-fill.ts` `resolveSubmoduleSource` shows the pattern for touching another registered
    clone: `withRepoLock(mirror, …)`, then the auth of **that clone's** origin, `fetch origin`, then
    `fetch origin <sha>` when the commit is missing. It also exports `redactGitError`, `isSafeSubmodulePath` and
    `FindRepo`.
  - `submodule-drift.ts` and `submodule-fill.ts` list gitlinks from the **index** (`ls-files -s`). Facts need the
    gitlinks of a commit (`ls-tree <sha> -- <path>`), so that part is new but small.

### 2.2 Shared types

- `packages/shared/src/protocol/runner.ts`: `RepoReleaseFactsPayloadSchema` (server → runner) and
  `RepoReleaseFactsResultSchema` (runner → server). Both are plain `z.object` (unknown keys are stripped, not refused),
  so a new optional field is backward compatible both ways.
- `packages/shared/src/release/dto.ts`: `ReleaseFactsSchema` (stored as JSON in `repo_release_facts.facts`, so no
  migration is needed) and `ReleaseProposalViewSchema` (the desk item's `release` field, `packages/shared/src/api/desk.ts:89`).

### 2.3 Server

- `apps/server/src/release/facts.ts` `requestReleaseFacts` builds the `repo.release_facts` payload. It does not tell the
  runner which other repositories belong to the project today. `applyReleaseFactsResult` parses the result into
  `ReleaseFacts` and stores it. `loadFacts` reads it back.
- All three entry points go through `POST /api/desk/:id/resolve` (`apps/server/src/commands/desk.ts:434-446`) in one
  transaction:
  - `ship_release` approved → `resolveShipReleaseIn` (approve.ts; validates against the stored facts, appends
    `ReleaseApproved`), then `startReleaseShipIn` (ship.ts; queues `release.ship`). A thrown `conflict` rolls back both.
  - `release_failed` alert, Retry → `retryReleaseShipIn` (ship.ts). It either resends the stored `release.ship` payload
    (steps before the release commit was pushed) or, for `land`/`tag`/`publish`, goes to `enqueueReleasePublishFor`.
- `startReleaseShipIn` already has a gate to copy: `loadReleaseDocsPrepGate` → `throw conflict(code, message, details)`
  before `shipWorkstation` and `queue`. So a refusal queues nothing.
- `release.ship` on the runner (`release-ship.ts:91`) cuts the release commit from the **current** `origin/<working
  branch>`, not from the approved `headSha`. The commit that ships is the working-branch head, which is why the pointer is
  read at `headSha`. The card's "release base" means the commit the release is cut from, not the main branch (`base`
  still has the old pointer until the release PR lands).

### 2.4 Web

- `apps/web/src/components/ShipReleaseItem.tsx` already shows a server gate in advance: `rel.docsPrep.blocked` puts a
  warning `Callout` on the item and disables **Approve release**, and the 409 code `release_docs_prep_required` is shown
  in the same place. The pointer gate copies this exactly. The test is `apps/web/src/test/desk-ship-release.test.tsx`.

### 2.5 The real repositories

- guildwise-cloud `.gitmodules`: `[submodule "core"] path = core, url = git@github.com:exinarium/GuildwiseHQ.git`.
  The registered GuildwiseHQ remote is `https://github.com/exinarium/GuildwiseHQ.git`. `normalizeRemoteUrl` gives
  `github.com/exinarium/guildwisehq` for both, so URL matching works across ssh/https and `.git` (planning question 1).
- Today the cloud pin is `dfcc2f8e` = `v1.9.0^{commit}` (annotated tag). So it would read `pinned` now, and the AC2
  scenario has to be built in tests or on the test environment.

## 3. Options

| | Option | For | Against |
|---|---|---|---|
| A | **Runner classifies, server enforces** (recommended). The server sends the other project repositories (id, name, normalized URL) in the facts payload. The runner lists the submodules at `headSha`, matches the URL, reads the pointed repository's tags from its own registered clone and classifies each one. The facts store the list. A shared pure function turns the list into "blocked + message". The server calls it in approve/start/retry, and the web calls it for the disabled button. | One tag rule (`releaseTagsAt`). Uses the existing clone, lock and auth. Old runners send no field (= not checked). Server enforcement does not trust the UI. | The payload grows by one small list. |
| B | Server classifies from the stored facts of the pointed repository (`existingTags`). The runner only lists path, URL and pin. | Less runner code. | The server cannot tell "ancestor of" (behind vs ahead) without the git graph. `existingTags` has names, not SHAs. Breaks the AC. |
| C | Gate inside `release.ship` on the runner. | Checks the exact commit that ships. | No UI state before Approve. The card wants the refusal at start/retry/resolve with "no ship command queued". Changes the ship flow, which the card forbids. |

**Recommendation: A**, plus a cheap server-side staleness check (5.4.3) that closes the "core released after the cloud
facts were read" window.

## 4. Decisions

1. **Commit read**: the pointer is read at `headSha` of the release facts (the working-branch head, which the release
   commit is cut from). This is the "release base" of the card.
2. **URL match**: `readSubmodules(...).normalized` (relative URLs resolved against the superproject's origin) compared
   with `project_repos.remote_url_normalized` of the **other** active repositories of the same project, sent by the
   server. No names are hard-coded.
3. **Latest release tag of the pointed repository** = `newestFirst(all)[0]` from `releaseTagsAt(pointedClone, pinned)`:
   the highest `RELEASE_TAG_RE` tag of that clone after a tag fetch. Pre-release tags count, the same rule as everywhere
   else in the release flow (`validateReleaseVersion`, RUNNER.md "pre-release tags count"). From the same call, `last`
   gives "contains x.y.z" (the newest release tag merged into the pinned commit).
4. **States** (`SubmodulePointerState`):
   - `pinned`: pinned commit = latest tag commit (peeled).
   - `behind`: latest tag commit is not an ancestor of the pinned commit (`git merge-base --is-ancestor <tag> <pinned>`
     exits 1). This includes a pin that diverged from the tag.
   - `not_on_release_tag`: latest tag commit is an ancestor of the pinned commit, but they are not equal (an untagged
     commit ahead of the tag).
   - `not_checked`: the URL is not another repository of this project; the pointed repository has no release tags; the
     server sent no repository list (older server). **Never blocks.**
   - `unknown`: a project repository, but no registered clone on this workstation, the tag fetch fails, the pinned commit
     is not in the clone after a fetch, or `merge-base` errors. Shown as a **warning** with the reason. **Never blocks**,
     on approve, start or retry (card constraint). This answers planning question 2b.
   - Absent `submodules` field (older runner) = nothing checked = no block.
5. **What blocks**: any entry in `behind` or `not_on_release_tag`, and nothing else. The same shared function is used on
   the server (enforcement) and in the web (button), so the reason text is identical.
6. **Retry scope**: the gate applies wherever `release.ship` would be queued: approve (resolve), start, and Retry at a
   step before the release commit was pushed (prepare/commit/push, where `retryReleaseShipIn` resends `release.ship`).
   Retry at `land`/`tag`/`publish` (`enqueueReleasePublishFor`) is **not** gated. That release commit already exists and
   passed the gate when it was approved. The automatic land/tag after a merged release PR is not gated either, and
   gating only the Retry button there would be inconsistent. The card also forbids changing how releases are
   published. The builder states this in the handoff.
7. **Credentials**: the facts store the **normalized** URL (`host/path`), never the raw `.gitmodules` URL, which can carry
   userinfo. Fetch errors go through `redactGitError`.

## 5. Design

### 5.1 Shared: `packages/shared/src/release/submodules.ts` (new, exported from `release/index.ts`)

```ts
import { z } from 'zod';
import { tagVersion } from './tags.ts';

export const SubmodulePointerStateSchema = z.enum(['pinned', 'behind', 'not_on_release_tag', 'not_checked', 'unknown']);
export type SubmodulePointerState = z.infer<typeof SubmodulePointerStateSchema>;

/** One submodule of the released commit and how its pin compares with the pointed repository's latest release. */
export const ReleaseSubmoduleFactsSchema = z.object({
  path: z.string().max(500),
  /** normalizeRemoteUrl of the submodule url (never the raw url: it may carry credentials). */
  url: z.string().max(500),
  pinned: z.string().max(40),
  /** The project repository it points to (absent: outside the project). */
  repoId: z.uuid().optional(),
  repoName: z.string().max(200).optional(),
  latestTag: z.object({ name: z.string().max(100), sha: z.string().max(40) }).nullable().optional(),
  /** Newest release tag merged into the pinned commit ("contains 1.7.2"). */
  containsTag: z.string().max(100).nullable().optional(),
  state: SubmodulePointerStateSchema,
  /** Why not_checked / unknown (plain words, shown on the item). */
  reason: z.string().max(300).optional(),
});
export type ReleaseSubmoduleFacts = z.infer<typeof ReleaseSubmoduleFactsSchema>;
export const ReleaseSubmodulesSchema = z.array(ReleaseSubmoduleFactsSchema).max(50);

/** Another repository of the same project, sent with repo.release_facts. */
export const ReleaseProjectRepoSchema = z.object({ repoId: z.uuid(), name: z.string().max(200), remoteUrlNormalized: z.string().max(500) });

export const RELEASE_SUBMODULE_GATE_CODE = 'release_submodule_behind';

/** "core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0" */
export function submoduleLine(s: ReleaseSubmoduleFacts): string { … }

export interface ReleasePointerGate {
  blocked: boolean;
  /** The refusal with the fix, identical on the server (409) and on the item. */
  message: string | null;
  blocking: ReleaseSubmoduleFacts[];
  warnings: ReleaseSubmoduleFacts[]; // state 'unknown'
}
/** Absent or empty list: nothing checked, never blocked. */
export function releasePointerGate(subs: readonly ReleaseSubmoduleFacts[] | undefined, repoName: string): ReleasePointerGate { … }
```

Line formats (`short` = first 7 characters; the version is `tagVersion(name)` for display, the tag name in the fix):

- pinned: `core: pinned - abc1234 is release 1.8.0`
- behind: `core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0`, or `(contains no release)` when
  `containsTag` is null
- not on a release tag: `core: not on a release tag - pinned abc1234 (contains 1.8.0), latest release 1.8.0`
- not checked: `core: not checked - <reason>` (for example `points outside this project`,
  `GuildwiseHQ has no release tags`)
- unknown: `core: unknown - <reason>` (for example `no clone of GuildwiseHQ on this workstation`,
  `could not fetch the tags of GuildwiseHQ: …`)

Message when blocked (one sentence per blocking submodule, then the fix):
`Cannot ship guildwise-cloud: core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0 of GuildwiseHQ. Bump the submodule core to v1.8.0 in guildwise-cloud and refresh the release.`
For `not_on_release_tag`, the same fix sentence.

Wire it in:
- `protocol/runner.ts`: `RepoReleaseFactsPayloadSchema` gains `projectRepos: z.array(ReleaseProjectRepoSchema).max(200).optional()`,
  and `RepoReleaseFactsResultSchema` gains `submodules: ReleaseSubmodulesSchema.optional()`.
- `release/dto.ts`: `ReleaseFactsSchema` gains `submodules: ReleaseSubmodulesSchema.optional()`, and
  `ReleaseProposalViewSchema` gains `submodules: ReleaseSubmodulesSchema.optional()`.
- Keep the field **optional, no default**. Absent means "this runner did not look", and the gate treats absent and `[]`
  the same (not blocked).

### 5.2 Runner: `apps/runner/src/git/release-facts.ts`

1. `ReleaseFactsInput` gains `findRepo?: FindRepo` (type from `submodule-fill.ts`).
2. Change `runner.ts:2497` to pass `findRepo: (n) => this.findRepo(n)`.
3. Change `readSubmodules` in `submodule-pin.ts` to take an optional `at?: string`. With it, read
   `['config', '--blob', `${at}:.gitmodules`, '--list', '-z']` instead of `--file .gitmodules`. Existing callers do not
   change. Do not copy the parser.
4. New `submodulePointersAt(repoPath, headSha, payload, input)` in the same file, called at the end of
   `readReleaseFacts`. The result is added as `submodules` only when `.gitmodules` exists at `headSha` (so GuildwiseHQ
   facts look exactly as today):

```ts
const origin = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
const declared = (await readSubmodules(repoPath, origin, { at: headSha })).slice(0, 50);
for (const sub of declared) {
  if (!isSafeSubmodulePath(sub.path)) continue;
  const entry = (await git(repoPath, ['ls-tree', '-z', headSha, '--', sub.path])).stdout; // "160000 commit <sha>\t<path>"
  const pinned = /^160000 commit ([0-9a-f]{40})\t/.exec(entry)?.[1]; if (!pinned) continue;
  const base = { path: sub.path, url: sub.normalized, pinned };
  if (!p.projectRepos) { out.push({ ...base, state: 'not_checked', reason: "not compared with the project's repositories" }); continue; }
  const repo = p.projectRepos.find((r) => r.remoteUrlNormalized === sub.normalized && r.repoId !== p.repoId);
  if (!repo) { out.push({ ...base, state: 'not_checked', reason: 'points outside this project' }); continue; }
  const local = await input.findRepo?.(repo.remoteUrlNormalized).catch(() => undefined);
  if (!local) { out.push({ ...base, repoId, repoName, state: 'unknown', reason: `no clone of ${repo.name} on this workstation` }); continue; }
  out.push(await classify(local.localPath, base, repo, input.auth));
}
```

`classify` runs under `withRepoLock(local.localPath, …)`, like `resolveSubmoduleSource`. The superproject is not locked
by `readReleaseFacts`, so there is no lock-order problem:

- auth for **that clone's** origin (`git remote get-url origin`, then `input.auth?.(url)`);
  `fetch --no-recurse-submodules -- origin refs/tags/*:refs/tags/*`. Exit ≠ 0 → `unknown`,
  `could not fetch the tags of <name>: <redactGitError(first line)>`.
- if `cat-file -e <pinned>^{commit}` fails: `fetch origin`, then `fetch origin <pinned>`. Still missing → `unknown`,
  `pinned commit abc1234 is not in <name>`.
- `const { all, newestFirst, last } = await releaseTagsAt(path, pinned)`. `latest = newestFirst(all)[0]`. None →
  `not_checked`, `<name> has no release tags`. `latestSha = await revParse(path, `refs/tags/${latest}`)` (peeled).
- `pinned === latestSha` → `pinned`. Else `merge-base --is-ancestor latestSha pinned`: exit 0 →
  `not_on_release_tag`, exit 1 → `behind`, other → `unknown` (reason: git's redacted message).
- always fill `latestTag {name, sha}` and `containsTag: last?.name ?? null` when known.
- never throws: wrap each submodule in try/catch → `unknown`.

The facts stay read-only for the superproject. The only writes are tag and object fetches into the pointed project
repository's own clone, under its lock with its own auth, as `submodule-fill` already does.

### 5.3 Server: facts

`apps/server/src/release/facts.ts` `requestReleaseFacts`: add to the payload

```ts
projectRepos: (await rows(ctx.pool,
  `SELECT id AS "repoId", name, remote_url_normalized AS "remoteUrlNormalized" FROM project_repos
    WHERE project_id=$1 AND id<>$2 AND removed_at IS NULL AND remote_url_normalized IS NOT NULL`,
  [repo.project_id, repoId])),
```

`applyReleaseFactsResult` passes `submodules` through `ReleaseFactsSchema.parse({...r, …})`. It already spreads `r`, so
the only change is the schema field. Nothing else changes in storage (JSON column, no migration).

### 5.4 Server: the gate, `apps/server/src/release/pointer-gate.ts` (new)

```ts
export async function releasePointerGateFor(db: Queryable, repoId: string): Promise<ReleasePointerGate> {
  const repo = await one(db, 'SELECT name FROM project_repos WHERE id=$1', [repoId]);
  const stored = await loadFacts(db, repoId);
  const subs = await withServerStaleness(db, stored?.facts?.submodules); // 5.4.3
  return releasePointerGate(subs, repo?.name ?? 'this repository');
}
export async function assertReleasePointers(db: Queryable, repoId: string): Promise<void> {
  const g = await releasePointerGateFor(db, repoId);
  if (g.blocked) throw conflict(RELEASE_SUBMODULE_GATE_CODE, g.message ?? '', {
    repoId,
    submodules: g.blocking.map(({ path, pinned, latestTag, state }) => ({ path, pinned, latestTag: latestTag?.name ?? null, state })),
  });
}
```

#### 5.4.1 Call sites (each one before anything is appended or queued)

- `approve.ts` `resolveShipReleaseIn`: after the `proposal_changed` check, before `validateReleaseVersion`:
  `await assertReleasePointers(tx, proposal.repo_id)`. The 409 rolls back the transaction, so no `ReleaseApproved` is
  stored and the item stays open.
- `ship.ts` `startReleaseShipIn`: after the `done` check, before `loadReleaseDocsPrepGate`:
  `await assertReleasePointers(tx, proposal.repo_id)`. This is defence in depth, for a proposal approved through another
  path.
- `ship.ts` `retryReleaseShipIn`: after the `release_not_approved` check, **inside the non-publish branch** (after the
  `RELEASE_PUBLISH_STEPS` `if`, before `shipWorkstation`): `await assertReleasePointers(tx, ship.repo_id)`. It uses the
  repository's **current** stored facts, because the retried `release.ship` cuts from the current working-branch head.
  So after a bump and a refresh, Retry goes through.

#### 5.4.2 View

`approve.ts` `releaseViewBase`: when `facts.submodules?.length`, add `submodules` (after `withServerStaleness`) to
the returned view. The view is unchanged for repositories without submodules.

#### 5.4.3 Staleness check (small, server data only)

Between two facts reads (the `sync` trigger reads at most every 30 minutes), the pointed repository can ship a newer
release. That is how the cloud bug happened: core 1.8.0 shipped, cloud did not notice. `withServerStaleness`: for each
entry with a `repoId` in state `pinned` or `not_on_release_tag`, take the server's newest known version of that
repository. That is the highest of `release_ships.version WHERE repo_id=$1 AND tag_name IS NOT NULL` (the projection in
`apps/server/src/projections/release.ts` sets `tag_name` when the tag is pushed; it stays set on `tagged`, `published`
and a publish that failed after the tag) and the first entry of that repository's stored
`repo_release_facts.facts.existingTags`, compared with `compareSemver`. When it is higher than `latestTag`, the entry
becomes `behind` with `latestTag` set to that version (`sha` unknown → `''`) and
`reason: '<name> released <v> after this repository was read'`. The line then reads
`core: behind - pinned abc1234 (contains 1.8.0), latest release 1.9.0`, and the fix (bump, refresh) is the same. Pure
read, no new table.

### 5.5 Web: `apps/web/src/components/ShipReleaseItem.tsx`

- `const pointer = releasePointerGate(rel.submodules, rel.repoName)`.
- A `Submodules` block (`data-testid="ship-submodules"`), only when `rel.submodules?.length`: one `<li>` per entry with
  `submoduleLine(s)` in `font-mono text-xs break-words`. Entries in `behind`/`not_on_release_tag` use the danger text
  colour, and `unknown` entries use the warning colour with a "not verified" note. Keep it readable on a narrow phone:
  wrap, no horizontal scroll.
- `pointerErr = resolve.error instanceof ApiError && resolve.error.code === 'release_submodule_behind'`. The message
  shown is `pointer.blocked ? pointer.message : pointerErr?.message`, in a `Callout tone="warning" role="alert"`
  (`data-testid="ship-submodule-blocked"`), like the docs-prep one, with a hint to press **Refresh** after the bump.
  Exclude `pointerErr` from `serverMsg`, the same way as `gateErr`, so it is not shown twice under the version field.
- **Approve release** `disabled={… || pointer.blocked}`. **Reject** stays enabled.
- The **Release stopped** alert's Retry shows the 409 through the existing generic desk error path. Check that it does,
  as it does for `release_not_approved`. No new UI is needed there.

### 5.6 Docs

- `docs/USER-GUIDE.md` (Ship release paragraph, line ~775): a sentence on the submodule states, the refusal and its fix
  (bump the submodule to the tag in that repository, then **Refresh**), `unknown` as a warning that does not block, and
  that Retry after the release commit was pushed is not re-checked.
- `docs/RUNNER.md` `repo.release_facts` (line ~1653): the submodule listing at the working-branch head, the
  `projectRepos` payload field, tag fetches into the pointed project repository's own clone under its lock, the states.
- `docs/ARCHITECTURE.md`, release section: one line on the gate (server enforces, shared function).
- If `docs/guide/guide.html` and the help articles are generated from USER-GUIDE / `user-guide.ts`, regenerate them the
  way the repository does. Do not edit generated output by hand.
- CHANGELOG `## [Unreleased]` → Fixed: "A release is refused while a submodule points behind the latest release of the
  project repository it points to."

## 6. Acceptance criteria → design

| AC | Where it is met | Test |
|---|---|---|
| Facts include path, pinned commit, latest tag of the pointed repo and the state | 5.1 schema, 5.2 `submodulePointersAt`, 5.3 payload/storage | runner `release-facts.test.ts`: superproject + submodule repo (pinned, behind, not on a release tag); shared schema test |
| Cloud with core pointer pre-1.8.0: item shows `behind` with pinned commit and latest tag; Ship disabled with the reason | 5.1 `submoduleLine`/`releasePointerGate`, 5.4.2 view, 5.5 | `desk-ship-release.test.tsx`: behind entry → line text, callout, Approve disabled |
| start/retry/resolve return a conflict naming submodule, pinned commit, latest tag; no ship command queued | 5.4 `assertReleasePointers` at the three call sites | server `release-ship.test.ts`: approve 409 `release_submodule_behind`, message contains `core`, `abc1234`, `v1.8.0`; `SELECT count(*) FROM runner_commands WHERE type='release.ship'` = 0; no `ReleaseApproved`; retry of a failed `prepare` ship 409, no new command |
| After bump + refresh: `pinned`, ship proceeds | runner re-read at the new head; gate reads current facts | runner: pinned case; server: facts with `pinned` → approve queues `release.ship`; retry with refreshed `pinned` facts → queued |
| Untagged commit ahead of latest tag → `not on a release tag` | 5.2 `merge-base --is-ancestor` exit 0 | runner case; server 409 for `not_on_release_tag` |
| No submodules / outside project / pointed repo without tags → as today | absent field; `not_checked` never blocks | runner: no `.gitmodules` → `submodules` absent; outside URL → `not_checked`; untagged pointed repo → `not_checked`; unresolvable (no clone, broken origin) → `unknown`; shared: absent/`[]`/`not_checked`/`unknown` → not blocked; server: `not_checked`/`unknown` and legacy facts without the field → approve queues |
| GuildwiseHQ itself unchanged | no `.gitmodules` → field absent, view unchanged | existing runner/server/web release tests stay green; one explicit "no field" assertion |

Runner test fixture: reuse the bare-origin helpers in `apps/runner/test/release-facts.test.ts`. Make a second bare repo
`pointed` with commits and annotated tags `v1.7.2` and `v1.8.0`, plus its registered clone. In the superproject, add the
gitlink with `git update-index --add --cacheinfo 160000,<sha>,core` and a `.gitmodules` whose URL is the pointed bare
path (relative or `file://`). Commit, push. Pass `findRepo` returning the pointed clone and
`projectRepos: [{repoId, name: 'pointed', remoteUrlNormalized: normalizeRemoteUrl(url)}]`. The suite runs with no
network (file remotes only).

The end-to-end check on the test environment (cloud with a behind pointer refused, bump + refresh ships, GuildwiseHQ
unchanged) is for the testers. Builders run unit suites only.

## 7. Risks

- **Stale UI / direct API**: covered. The server enforces the gate at all three entry points in the same transaction.
- **Facts older than a pointed release**: 5.4.3 covers it with server-known releases. What remains: a release of the
  pointed repository made outside Guildwise and not yet fetched by any facts read. Refresh covers it.
- **Push between the facts read and the ship**: `release.ship` cuts from the current `origin/<wb>`, not from the
  approved `headSha`. This is a pre-existing gap for every fact (changelog, components), not new here. Out of scope
  (it would change the ship). A backlog suggestion is reasonable: "release.ship refuses when origin/<wb> moved past the
  approved head".
- **Old runner**: no `submodules` → not checked → ships as before (card constraint). Upgrading the runner turns the gate on.
- **Lock contention**: tag fetch into the pointed clone takes that clone's repo lock (same as worktree submodule fill).
  The fetch is bounded (tags only, plus at most one object fetch).
- **Pre-release as latest**: a pointed `v1.9.0-rc.1` above `v1.8.0` counts as the latest release (existing rule). That is
  consistent with how the flow tags pre-releases. Note it in USER-GUIDE.
- **Size**: shared + runner + server + web + docs, well over 200 lines → recorded as large.

## 8. Files to change

- `packages/shared/src/release/submodules.ts` (new), `packages/shared/src/release/index.ts`,
  `packages/shared/src/release/dto.ts`, `packages/shared/src/protocol/runner.ts`
- `packages/shared/test/release-submodules.test.ts` (new)
- `apps/runner/src/git/release-facts.ts`, `apps/runner/src/git/submodule-pin.ts` (`readSubmodules` `at` option),
  `apps/runner/src/runner.ts` (pass `findRepo`)
- `apps/runner/test/release-facts.test.ts`, and `submodule-pin.test.ts` for the `at` option
- `apps/server/src/release/pointer-gate.ts` (new), `facts.ts`, `approve.ts`, `ship.ts`
- `apps/server/test/release-ship.test.ts` (or a new `release-pointer-gate.test.ts` following its setup)
- `apps/web/src/components/ShipReleaseItem.tsx`, `apps/web/src/test/desk-ship-release.test.tsx`
- `docs/USER-GUIDE.md`, `docs/RUNNER.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`
