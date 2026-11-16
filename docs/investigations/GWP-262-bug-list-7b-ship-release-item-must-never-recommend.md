# GWP-262: Ship release item must never recommend a version at or below the newest release tag

Design for the fix. It follows the original Ship release design in
`docs/investigations/GWP-47-ship-release-desk-item-version-recommendation-chan.md`. Section 4 lists the two places where
this design changes GWP-47.

## 1. Question

Around 1.8.0 the Ship release desk item recommended a version equal to or lower than the newest release tag. Where does
the base version come from, why can it fall behind the newest tag, and what has to change so that:

- the recommendation, the manual version check and the component bumps all start from the highest released version;
- the server enforces the same check;
- the item shows which base it used?

## 2. Findings (read in code)

### 2.1 How the base is chosen today

`apps/server/src/release/proposal.ts:30`:

```ts
export function baseVersion(facts: ReleaseFacts): string {
  if (facts.lastTag) return facts.lastTag.name.replace(/^v/, '');
  if (facts.changelog) return parseChangelog(facts.changelog)[0]?.version ?? '0.0.0';
  return '0.0.0';
}
```

- When a tag exists, CHANGELOG.md is never looked at. A changelog that is ahead of the tags is ignored (requirement 1).
- `facts.lastTag` comes from the runner. It is **not** the newest release tag of the repository. See 2.2.

### 2.2 The runner picks only tags merged into the working branch

`apps/runner/src/git/release-facts.ts` `releaseTagsAt` (l.76-95) builds `last` from `git tag --merged <headSha>`.
`readReleaseFacts` uses that tag as `lastTag`, for:

- the commit range `lastTag..headSha` (the commit types behind major/minor/patch);
- the changed paths (`git diff lastTag headSha`) and `contentAtTag` of each component version file (`componentFactsAt`).

The release flow puts the tag **on the merge commit on main** (USER-GUIDE "Ship release": "Guildwise puts an annotated
tag `vX.Y.Z` on the merge commit"). Until main is merged back into the working branch (GWP-242, not done automatically
today; see commit `77a23d96 Merge main into development after release 1.9.0`, done by hand), that tag is not an ancestor
of the working branch head. So after 1.8.0 shipped:

| Fact | Value the item used | Correct value |
|---|---|---|
| `lastTag` | `v1.7.x` (newest *merged* tag) | `v1.8.0` |
| base | `1.7.x` | `1.8.0` (the tag; CHANGELOG.md on the branch already holds `## [1.8.0]` from the release commit) |
| commits | all of 1.8.0's commits plus the new ones (an extra `feat` can push the level to minor) | only the commits after the release |
| component base (`contentAtTag`) | version at `v1.7.x`, e.g. runner `2.2.0` | version at `v1.8.0`, e.g. `2.3.0` |
| recommendation | `1.7.(x+1)` or `1.8.0` (equal to an existing tag) | `1.8.1` / `1.9.0` / `2.0.0` |

The component case also breaks AC4. With head `2.3.0` (bumped by the 1.8.0 release commit), tag base `2.2.0` and
files changed, `componentBumps` computes target `2.2.1`. Head is higher, so `to = 2.3.0` with state `already_set`, and
the released `2.3.0` would be released again.

`existingTags` already holds **every** release tag, newest first (`newestFirst(all)`), so `existingTags[0]` is the
newest tag of the repository. Today it is used only for the "already exists as a tag" check.

### 2.3 Validation

- `packages/shared/src/release/validate.ts` `validateReleaseVersion(input, lastTag, existingTags)` rejects versions
  `<= lastTag`. But it gets the merged `lastTag`, so `1.7.9` passes when `v1.8.0` exists (only `1.8.0` itself is caught,
  by the "already exists" check).
- The web item (`ShipReleaseItem.tsx:43`) and the server (`approve.ts:84`) both call it with `lastTag`. The server
  answers `400 invalid_version` for every failure. The card's test plan asks for a **conflict** when the version is not
  above the newest tag.

### 2.4 What reaches the ship

`ReleaseApproved` already carries `lastTag`, but the `ReleaseApproved` projector (`apps/server/src/projections/release.ts`)
does not store it. `release_proposals.last_tag` is written only by `ReleaseProposed`, when the proposal is created.
`shipPayloadFromProposal` (`ship.ts:59`) sends that stored value to the runner, and the runner's release commit
(`release-ship.ts:217`) recomputes the component bumps from `componentFactsAt(wt, rules, p.lastTag, tip)`. A proposal
created before a newer tag existed therefore ships component versions computed from an old tag.

### 2.5 Display

The item shows `Last release ${rel.lastTag}` (`ShipReleaseItem.tsx:98`). `ReleaseProposalView.base` already exists but
is not shown, and nothing says when the base came from CHANGELOG.md.

### 2.6 Other users of the tag helpers (checked, unchanged)

- `lastReleaseTagAt` (merged-only) is used by Release prep (`release-docs-prep.ts:202`) for its commit range. That is
  Release prep (GWP-260/242/261 area) and stays unchanged in this card. See 7.3.
- `lastReleaseOf` / `isLatestRelease` are used by publish, not by the Ship path. Unchanged.
- `queries/misc.ts:347` reads `facts.lastTag.name` for the repository row's last release. With the runner change it
  shows the newest tag, which is correct for "last release".

## 3. Options

### Where the newest tag comes from

| Option | For | Against |
|---|---|---|
| A. Server only: base and validation from `max(facts.lastTag, existingTags[0])` | No runner change. Works with every runner. | Commits and component facts still come from the old merged tag: the level can be inflated, and AC4 is not met (component base from the old tag). |
| B. Runner only: `lastTag` = newest release tag of all tags | Commits, changed paths and `contentAtTag` all relative to the real last release. Fixes AC1-4 at the source. | Workstations on an older runner keep the bug until they update. |
| **C. Both: the runner reports the newest tag; the server also takes `max(lastTag, newest of existingTags)`** | Correct facts with an updated runner. With an older runner the recommendation, validation and display are still never at or below the newest tag, and the ship's component bumps are right too, because the server sends the newest tag to the ship (2.4). | Two small changes instead of one. |

**Recommended: C.**

### All tags or only "reachable" tags

- *Only merged into head* (today): misses the tag on main's merge commit. This is the bug.
- *Merged into head or main*: covers the release flow but still allows a recommendation at or below a tag that exists
  elsewhere, and that version would then be refused as "already exists". It contradicts requirement 2 ("strictly greater
  than the newest release tag of the repository").
- **All release tags (`RELEASE_TAG_RE`, semver order, pre-releases count, as today)**: matches the requirement. The
  newest tag is already `existingTags[0]`. `git log <tag>..<head>` and `git diff <tag> <head>` work for a tag that is
  not an ancestor: the range drops everything reachable from the tag, so the release commit merged into main is
  excluded. **Chosen.**

This answers planning question (1): the newest tag comes from all release tags, and the change stays in this card. It
touches `readReleaseFacts` only. Release prep's `lastReleaseTagAt` (the GWP-260/242 area) is left alone.

Planning question (2): the base goes into `ReleaseProposalView` (`base`, already there, plus `baseSource`). The
approval record needs no new field: `ReleaseApproved.lastTag` already exists. It is filled with the newest tag and now
projected into `release_proposals.last_tag`, so the ship uses the same tag.

## 4. Changes to the GWP-47 design (recorded)

1. GWP-47 step 5 (runner facts): `lastTag` = the highest release tag of the repository, no longer only tags merged into
   the head. `existingTags` is unchanged.
2. GWP-47 "Base version": base = the **higher** (by `compareSemver`) of the newest release tag and the highest dated
   version in CHANGELOG.md, else `0.0.0`. When they are equal, the tag is the source, so the behaviour is unchanged when
   they agree.

Everything else in GWP-47 stays: recommendation rules, `bumpVersion` semantics (including pre-release), component
`already_set` logic, events, and the desk item flow.

## 5. Design

### 5.1 Shared: `packages/shared/src/release/tags.ts`

Add one helper and export it from the package index:

```ts
/** The highest release tag (semver order, pre-releases count) among `tags`; null when none is a release tag. */
export function newestReleaseTag(tags: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const t of tags) {
    if (!t || !RELEASE_TAG_RE.test(t)) continue;
    if (best === null || (compareSemver(t.slice(1), best.slice(1)) ?? 0) > 0) best = t;
  }
  return best;
}
```

(`compareSemver` comes from `../repo/component-rules.ts`. Check that importing it into `tags.ts` makes no import
cycle. If it does, put the helper in `validate.ts`, which already imports both.)

### 5.2 Shared: `validateReleaseVersion` (`packages/shared/src/release/validate.ts`)

```ts
export type VersionCheck =
  | { ok: true; version: string }
  | { ok: false; reason: 'not_semver' | 'not_higher' | 'exists'; message: string };

export function validateReleaseVersion(
  input: string,
  lastTag: string | null,
  existingTags: readonly string[],
  opts: { base?: string } = {},
): VersionCheck
```

- Floor tag = `newestReleaseTag([lastTag, ...existingTags])`, never only `lastTag`. Keep the existing message (it names
  the tag): `"<v> is not higher than the last release <tag>"`, reason `not_higher`.
- If `opts.base` is higher than the floor tag (the base came from CHANGELOG.md) and the input is `<= base`:
  `"<v> is not higher than <base>, the newest version in CHANGELOG.md"`, reason `not_higher`. Without this, the owner
  could approve a version that already has a dated section, which the ship treats as already released and commits
  nothing (see the ledger ruling on the undated 1.5.0 heading).
- `not_semver` and `exists` as today. Check order: semver, then tag floor, then changelog floor, then exists.
- Callers that pass three arguments keep working.

### 5.3 Shared: `componentBumps` (`packages/shared/src/release/components.ts`)

Requirement 4 / AC4: never below the released component version. The base already comes from `contentAtTag`. With
the runner change, that is the newest tag. Add one guard so that a head version *below* the released version is never
shown or shipped:

```ts
const tagged = f.contentAtTag === null ? null : readComponentVersion(rule, f.contentAtTag);
const released = tagged?.ok && compareSemver(tagged.version, tagged.version) !== null ? tagged.version : null;
const behind = released !== null && (compareSemver(current, released) ?? 0) < 0;
if (f.changedCount === 0 && !behind) return { ...common, state: 'unchanged', from: current, to: current };
const base = released ?? current;
// rest unchanged: target = bumpVersion(base, level); to = max(current, target); state as today
```

A component released at `2.3.0` therefore gets at least `2.3.1` whenever it changed, or whenever its head is behind the
release. An unchanged component whose head equals the released version stays "unchanged" (the same version, not
released again). The runner's release commit uses the same function, so the shipped files follow the same rule.

### 5.4 Server: `apps/server/src/release/proposal.ts`

Replace `baseVersion` with a function that returns where the base came from. Keep `baseVersion` as a thin wrapper,
because tests import it.

```ts
export interface ReleaseBase {
  version: string;                      // without "v"
  source: 'tag' | 'changelog' | 'none';
  tag: string | null;                   // newest release tag of the repository, with "v"
  changelogVersion: string | null;      // highest dated version in CHANGELOG.md
}

export function releaseBase(facts: ReleaseFacts): ReleaseBase {
  const tag = newestReleaseTag([facts.lastTag?.name, ...(facts.existingTags ?? [])]);
  const tagV = tag ? tagVersion(tag) : null;
  const cl = facts.changelog
    ? parseChangelog(facts.changelog)
        .map((r) => r.version)
        .reduce<string | null>((a, v) => (a === null || (compareSemver(v, a) ?? 0) > 0 ? v : a), null)
    : null;
  if (tagV && cl && (compareSemver(cl, tagV) ?? 0) > 0)
    return { version: cl, source: 'changelog', tag, changelogVersion: cl };
  if (tagV) return { version: tagV, source: 'tag', tag, changelogVersion: cl };
  if (cl) return { version: cl, source: 'changelog', tag: null, changelogVersion: cl };
  return { version: '0.0.0', source: 'none', tag: null, changelogVersion: null };
}
export const baseVersion = (facts: ReleaseFacts): string => releaseBase(facts).version;
```

- `parseChangelog` already keeps only dated `X.Y.Z` sections. Take the highest, not just the first, so an out-of-order
  file cannot lower the base.
- `buildProposal`: `const b = releaseBase(facts)`. Pass `b.version` to `recommendVersion` (rules unchanged). Add
  `baseSource: b.source` and `newestTag: b.tag` to `BuiltProposal`.
- Invariant (covered by a test): `compareSemver(recommended.version, tagVersion(newestTag)) > 0` whenever there is a
  tag. It holds because base >= tag and `bumpVersion` is strictly increasing for a semver base. A pre-release base
  `1.9.0-rc.1` with patch gives `1.9.0`, which is still higher.

### 5.5 Server: approval (`apps/server/src/release/approve.ts`)

In `resolveShipReleaseIn`:

```ts
const b = releaseBase(facts);
const check = validateReleaseVersion(release.version, b.tag, facts.existingTags, { base: b.version });
if (!check.ok)
  throw check.reason === 'not_semver'
    ? badRequest('invalid_version', check.message)
    : conflict(check.reason === 'exists' ? 'version_exists' : 'version_not_higher', check.message);
```

- `ReleaseApproved.lastTag` = `b.tag` (the newest tag), not `facts.lastTag?.name`.
- `releaseViewBase`:
  - `lastTag: built.newestTag`, `base: built.base`, `baseSource: built.baseSource`.
  - Without facts (fallback path): `baseSource: proposal.last_tag ? 'tag' : 'none'`, and `base` as today.

### 5.6 Server: projection (`apps/server/src/projections/release.ts`)

`ReleaseApproved` also sets `last_tag = p.lastTag`. The payload already carries the field, so this needs no event or
schema change, and it is replay-safe (the value comes from the event). The ship payload (`shipPayloadFromProposal`)
then sends the tag the owner approved against, and the runner's release commit computes component bumps from it. That
works even on an older runner.

### 5.7 Server: reconcile (`apps/server/src/release/reconcile.ts`), consistency only

Two reads of `facts.lastTag?.name` (l.107 suppression compare and l.151 `ReleaseProposed.lastTag`) must use the same
newest tag: `newestReleaseTag([facts.lastTag?.name, ...facts.existingTags])`. **Do not change the rules themselves.**
Without this, with an older runner, `ReleaseProposed` would store one tag and the suppression check would compare it
with another, and a dismissed proposal would come straight back. GWP-261 (same group, built first) owns the reconcile
rules. Build 262 on top of 261's result and touch only these two expressions.

### 5.8 Shared DTO (`packages/shared/src/release/dto.ts`)

`ReleaseProposalViewSchema`: add

```ts
/** Where `base` came from: the newest release tag, a newer dated section of CHANGELOG.md, or nothing (0.0.0). */
baseSource: z.enum(['tag', 'changelog', 'none']),
```

`lastTag` now means "newest release tag of the repository". Update its doc comment. `ReleaseFactsSchema` is unchanged.

### 5.9 Runner (`apps/runner/src/git/release-facts.ts`)

- `releaseTagsAt`: also return `newest: { name, sha } | null` = `newestFirst(all)[0]` with its `rev-parse
  refs/tags/<name>`. Keep `last` (merged) as it is for `lastReleaseTagAt` / Release prep.
- `readReleaseFacts`: use `newest` as `lastTag`, which also drives the commit range and `componentFactsAt`.
- Update the doc comment of `releaseTagsAt` and the comment at the call site.
- Bump `RUNNER_VERSION` (`apps/runner/src/version.ts`) by one patch over what main has when you build. No new
  capability flag is needed: the answer shape is unchanged, and the server copes with older runners (5.4-5.6).

### 5.10 Web (`apps/web/src/components/ShipReleaseItem.tsx`)

- Validation: `validateReleaseVersion(version, rel.lastTag, rel.existingTags, { base: rel.base })` (add `rel.base` to
  the memo deps). It is still shown inline under the field (`error=`), never as a toast.
- Server message: `serverMsg` already shows `resolve.error.message`. A 409 `version_not_higher` appears under the field
  in the same way. Check that `ApiError` maps the 409 body message (it does for `proposal_changed`).
- Base line (AC5): replace the `Last release …` span with:

```tsx
<span data-testid="ship-base">{baseLabel(rel)}</span>

function baseLabel(rel: ReleaseProposalView): string {
  if (rel.baseSource === 'changelog')
    return `Last release: ${rel.base} (from CHANGELOG.md; ${rel.lastTag ? `newest tag ${rel.lastTag}` : 'no tag yet'})`;
  if (rel.lastTag) return `Last release: ${rel.lastTag}`;
  return 'No release yet (starting from 0.0.0)';
}
```

  The row already wraps (`flex-wrap`). Add `break-words` to the span so it wraps on a narrow phone screen. No layout
  change for touch: the version field keeps its `scrollIntoView` on focus when the soft keyboard opens.

### 5.11 Docs

- `docs/USER-GUIDE.md` "Ship release": the base is the newest release tag of the repository (also one on main that the
  working branch has not merged yet) or a newer version in CHANGELOG.md, whichever is higher. The item shows it as
  "Last release: …". A version must be higher than that.
- `docs/ARCHITECTURE.md` l.2291-2294: the base rule, the runner's `lastTag` = newest tag, the 409 `version_not_higher` /
  `version_exists` (400 `invalid_version` stays for a value that is not semver), and `ReleaseApproved` projecting
  `last_tag`.
- CHANGELOG.md Unreleased, under Fixed: one line.

## 6. Acceptance criteria → design → tests

| AC | Design | Test (file) |
|---|---|---|
| 1. Newest tag v1.8.0, changelog 1.7.x or missing → recommendation > 1.8.0 | 5.4 `releaseBase` takes the newest tag from `lastTag` and `existingTags`. 5.9 the runner reports the newest tag. | `apps/server/test/release-proposal.test.ts`: (a) `lastTag v1.7.2`, `existingTags ['v1.8.0','v1.7.2']`, changelog last section 1.7.2 → base 1.8.0, source `tag`. Changelog missing → same. `feat` commit → 1.9.0. Only `fix` → 1.8.1. Breaking → 2.0.0. `apps/runner/test/release-facts.test.ts`: tag `v1.8.0` on a commit on main not merged into develop → `lastTag.name === 'v1.8.0'`, the commits exclude the released ones, `contentAtTag` read at v1.8.0. |
| 2. Agreement → unchanged | 5.4: equal versions → source `tag`, same base as today. | `release-proposal.test.ts`: the existing fixture (tag v1.3.0, changelog 1.3.0) gives the same recommendation as before. Keep the existing assertions unchanged. |
| 3. Equal or lower refused before ship, naming the tag; server refuses too | 5.2 floor = newest tag (+ changelog base). 5.5 409 `version_not_higher`. 5.10 inline error. | `packages/shared/test/release.test.ts`: with `lastTag null`/`v1.7.2` and `existingTags ['v1.8.0']`, `1.8.0` and `1.7.9` are rejected with a message containing `v1.8.0`, and `1.8.1` is accepted. Changelog base 1.9.0 → `1.9.0` rejected. `apps/server/test/release-reconcile.test.ts` (l.197 test): non-semver → 400 `invalid_version`; equal/lower → 409 `version_not_higher`. Add a case where `facts.lastTag` is older than `existingTags[0]`. `apps/web/src/test/desk-ship-release.test.tsx`: typing 1.7.9 with view `lastTag v1.8.0` shows the message and disables Approve. |
| 4. Component bumps never below the newest release | 5.3 guard. 5.9 `contentAtTag` from the newest tag. 5.6 the ship gets the approved tag. | `packages/shared/test/` (components): released 2.3.0, head 2.3.0, changed → `to 2.3.1`. Head 2.2.5 behind released 2.3.0, unchanged → `bump` 2.3.0 → 2.3.1. Existing `already_set` and `unchanged` cases unchanged. Server projection test: `ReleaseApproved` sets `last_tag`, and `shipPayloadFromProposal` sends it. |
| 5. Base visible | 5.8 `baseSource`. 5.10 `baseLabel`. | `desk-ship-release.test.tsx`: `ship-base` shows `Last release: v1.8.0`. With source `changelog`, it shows `Last release: 1.9.0 (from CHANGELOG.md; newest tag v1.8.0)`. With none, `No release yet…`. |
| 6. Tests for changelog behind tags, tags behind changelog, no tags | 5.4 | `release-proposal.test.ts`: `releaseBase`/`baseVersion` (a) changelog 1.7.2 / tag v1.8.0 → 1.8.0 `tag`; (b) changelog 1.8.0 / tag v1.7.2 → 1.8.0 `changelog`, recommendation 1.8.1 (fix) / 1.9.0 (feat); (c) no tags → changelog version, as today; (d) no tags and no changelog → 0.0.0 `none`. Invariant check: for each case with a tag, recommended > tag. |

Run (unit only): `packages/shared`, `apps/runner` (release-facts), `apps/web` (desk-ship-release),
`apps/server/test/release-proposal.test.ts`. `release-reconcile.test.ts` and the projection test need Postgres: run
them against your own test database as CLAUDE.md describes, or leave them for the testers and name them in the handoff.

## 7. Risks and traps

1. **Group order with GWP-261.** Both touch `apps/server/src/release/reconcile.ts` and `approve.ts`. 261's behaviour
   (when prep runs, phantom release) must not change here. In reconcile, only the two `lastTag` expressions in 5.7
   change.
2. **One-time new proposal after the deploy.** The newest tag may now differ from the `last_tag` stored on a closed
   proposal (old merged semantics). For a repository whose working branch is ahead of main, the suppression check can
   then let one new proposal through. That is correct: there is something unreleased. When `ahead === 0`, nothing is
   proposed.
3. **Release prep keeps the merged-only tag** (`lastReleaseTagAt`). It has the same blind spot for a tag on main.
   That is outside this card (Release prep, GWP-260/242 group). I am suggesting a backlog follow-up instead of widening
   this card.
4. **A stray higher tag** (for example `v2.0.0-alpha` pushed on a feature branch) now raises the base. This is what
   requirement 2 asks for. The owner can still see the base in the item and type a version.
5. **Changed paths against a non-ancestor tag** also count files that changed only on main (hotfixes not merged
   back). At worst a component is bumped when it did not strictly need to be. That direction is safe for AC4.
6. **Error code change.** Equal or lower versions now get 409 instead of 400. The web item shows the message the same
   way. Update the server test and ARCHITECTURE.md. No other client sends this request.
7. Do not create, move or delete tags. Every change here is a read or a computation.
