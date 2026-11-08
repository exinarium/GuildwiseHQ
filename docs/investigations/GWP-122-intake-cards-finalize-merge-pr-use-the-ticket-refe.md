# GWP-122: finalize, merge and PR use the ticket reference; a guard flags the internal key on intake cards

Part 3 of 3 (GWP-120 work reference and branch names → GWP-121 prompts and client outputs → **GWP-122** completion and
the internal-key guard). All changes are in GuildwiseHQ (`packages/shared`, `apps/server`, `apps/runner`). There is no
change to guildwise-cloud.

## 1. Question

When the runner finalizes an intake card, how do the PR or merge-request title and description and the merge commit
come to reference the client ticket (ABC-1) and not the internal key (GWP-123)? And how does the runner flag, and block
finalize on, commits and branches of an intake card that use the internal key? Non-intake cards must stay byte-identical.

## 2. Findings (code as of main 104c3122)

### 2.1 Finalize already has a ticket, from a second, narrower source

`apps/server/src/commands/finalize.ts` `queueExecute` (l.139) builds `FinalizeExecutePayload`:

- `ticket = prBranchTicket(intakes.external_key, card.ref)` (l.147-153). It reads **only** `intakes.external_key`
  through `intake_cards`, and only Jira-shaped keys (`/^[A-Za-z][A-Za-z0-9]*-\d+$/`). Batch, CEO and BA-direct cards,
  whose ticket lives only in `fields.externalRef`, and every GitHub ticket all fall back to `card.ref`.
- `prTitle = ticket !== card.ref ? `${ticket}: ${card.title}` : card.title`, `prBody = card.title` (l.172-173).
- `prBranchPrefix` + `ticket` give the PR branch on origin `<prefix>/<ticket>` (runner `remoteBranchFor`).

Runner `apps/runner/src/git/completion.ts`:

- `outsideTicket(p)` (l.45) returns `p.ticket` when it differs from `p.ref`. `changeTitle` (l.47) gives `"<ticket>: <title>"`
  or `"<title>"`. `mergeMessage` (l.51) is `"Merge " + changeTitle`.
- The PR title is `p.prTitle ?? changeTitle(p)` (l.155 `executeCompletion`, l.318 `viaChange`), the body is
  `p.prBody ?? p.title`, and the merge message goes to `git merge --no-ff -m` (l.254 `mergeLocked`).
- The local card branch is **never pushed under its own name** when the server sends `prBranchPrefix` + `ticket`
  (it always does now, with `DEFAULT_PR_BRANCH_PREFIX`). `merge` does not push it at all. `pr` and the protected-branch
  fallback push `<local>:<prefix>/<ticket>` (`pushBranch`).

**Conclusion:** the client-facing shape is already right for Jira intakes recorded on `intakes.external_key`. What is
missing is the **source** (GWP-120's `workReference`, which covers every intake path and GitHub tickets) and a
**branch-safe ticket part** for GitHub keys (`acme/web#12` → `web-12`). `outsideTicket` is the one place to extend.

### 2.2 The forge `changeMergeCommit` does not write a message

`GitHubForge.changeMergeCommit` (github.ts:247) and `GitLabForge.changeMergeCommit` (gitlab.ts:208) only **read** the
SHA of an already merged PR/MR. The one caller is `release-publish.ts:299`. The runner never merges a PR on the forge.
When a person merges it, the forge writes the merge commit from its own template:

- GitHub: `Merge pull request #N from <owner>/<head branch>` + the PR title (squash: the PR title).
- GitLab: `Merge branch '<head branch>' into '<base>'` + the MR title + `See merge request …` (squash: the MR title).

Neither API lets the creator preset the merge commit message (it is set only at merge time). So, on both forge paths,
the merge commit references ABC-1 and only ABC-1 when **the head branch (`<prefix>/<ticket part>`) and the PR/MR title
do**. That is what `openChange` sends (`--head/--title/--body` for GitHub, `source_branch/title/description` for
GitLab). `changeMergeCommit` stays unchanged. The card's lead was a wrong assumption: the forge tests assert what
`openChange` is called with instead.

### 2.3 The shift guard and how a violation stops work

`runGuard` (guard.ts:472) runs when an agent reports (`supervisor.ts:2854`). A non-empty result **rejects the report**:
the agent gets `rule: detail` back, fixes it and reports again. The violations are also kept in `s.guardViolations`
and sent with `ShiftEnded`. `GuardViolation` is `{ rule: string; detail: string }` (`events/shift.ts:19`), so a new rule
needs no schema change. `otherBranchViolation` (l.589) is where branch moves are looked at. The guard gets `cardRef` and
`projectKey` from the brief (`guardInput`, supervisor.ts:2322).

The runner's own commits never carry the internal key: the autocommit is `"<externalRef>: Work in progress"` or
`"Work in progress"` (`autocommit.ts:184`, `ticketOf` supervisor.ts:387). The main-merge commits are
`"Merge <main> into the card branch"` / `"Merge <main> into <working>"`. Investigation commits are
`"Investigation: <title>"`. **Exception: the mock agent** commits `mock build round N: <card.ref>` and
`mock investigation: <card.ref>` (`adapters/mock-agent.ts:125, 301`). On an intake card that would trip the new guard
in E2E and mock runs. It must use the work reference (see 4.6).

Builders may `git rebase`, `git commit --amend` and `git reset --soft/--keep` in their worktree (`roles/builtin.ts:26`,
the builder's denied list drops `git rebase/checkout/switch`; only `git reset --hard` is denied). So a builder can fix a
flagged message itself.

### 2.4 Server-side "finalize" leads

`dispatcher/phases.ts` `mergeChecks` and `completionStep` are **phase** bookkeeping (is a finalized PR merged yet; is a
phase complete). They do not take part in finalizing a card and need no change. The server cannot read commit messages
(they exist only in the runner's clone), so the finalize-time check runs in the runner. The server reacts to its
result in `applyFinalizeResult` (`finalize.ts:378`). A finalize failure today either loops in Finalize (`FinalizeFailed`
→ `status='queued', finalize_state='failed'` + desk escalation) or goes to Rework (`RebaseConflict` → `moveTo('build',
rework_round+1)`). Only the second lets a builder fix the cause.

Both finalize entry points (`requestFinalize`, `resolveLargeMergeIn`, and `ba-finalize.ts:150`) go through
`queueExecute`, so one change there covers them all.

## 3. Options

### 3.1 Where completion reads the work reference

| Option | Verdict |
|---|---|
| **A. Server computes `workReference(card)` in `queueExecute` and sends `workRef` + `isClientRef` + a branch-safe `ticket`. Runner `outsideTicket` reads `workRef` (chosen)** | One source (GWP-120's shared function). Old runners still get a correct `prTitle`. The runner needs no card lookup. |
| B. Runner re-derives from `ticket` (today) | Rejected: `ticket` is a branch part (`web-12`), not the client's reference (`acme/web#12`), and it cannot say "client ref" when the ticket happens to equal the ref |
| C. Keep `prBranchTicket` and add `fields.externalRef` beside it | Rejected: a parallel path. GWP-120 explicitly hands its replacement to this card |

### 3.2 Which commits the guard checks

| Option | Verdict |
|---|---|
| **Shift guard: the commits this shift made (`HEAD --not <startSha> <base>`). Finalize: every card commit (`<base>..HEAD`) (chosen)** | A reviewer or tester is never rejected for the builder's commits (it could not fix them). Commits of earlier shifts, including those of shifts that ended without a report, are still caught before anything lands. |
| Whole card branch at every report | Rejected: rejects reports of roles that cannot fix the cause (reviewer, tester) and loops |
| Only at finalize | Rejected: the card asks for the shift guard too, and the builder learns late |

### 3.3 What a finalize-time violation does

| Option | Verdict |
|---|---|
| **New event `InternalRefInHistory` → card back to Build (rework round +1), card message lists commits and the fix (chosen)** | The builder fixes it in the next rework shift. Mirrors `RebaseConflict` / `EvidenceLapsed`, which already route pre-finalize findings to Build |
| `FinalizeFailed` + desk escalation | Rejected: the card waits in Finalize, the BA retries and hits the same wall, and nobody who can fix it is routed |
| Rewrite messages automatically | Forbidden by the card (unsafe history rewrite) |

### 3.4 Keys to flag

| Option | Verdict |
|---|---|
| **The card's own ref only, whole-key match, case-insensitive (chosen, requirement 4)** | Precise. `gwp-123` in a branch and `GWP-123` in a message both match. `GWP-1234` and `XGWP-123` do not |
| Any `<projectKey>-<n>` | Rejected (recorded decision): a client's Jira project can share the internal project key (`GWP-500` would be the client's own ticket), and references such as "see GWP-85" in a body are internal notes the card leaves out of scope. A follow-up can widen this if the owner wants |

## 4. Design

### 4.1 Shared (`packages/shared/src/cards/work-ref.ts`, GWP-120's module: add, don't fork)

```ts
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-key, case-insensitive match of the card's own internal ref (`GWP-123`, `gwp-123`); not `GWP-1234`, `XGWP-123`. */
export function internalRefPattern(ref: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${esc(ref)}(?![0-9])`, 'i');
}
export const mentionsInternalRef = (text: string, ref: string): boolean => internalRefPattern(ref).test(text);

/** The guard and the scrub apply: the card has a client ticket that differs from its internal ref. */
export const guardsInternalRef = (wr: { ref: string; isClientRef: boolean }, cardRef: string): boolean =>
  wr.isClientRef && wr.ref.toUpperCase() !== cardRef.toUpperCase();

/** What clients read as the change's title: `ABC-1: <title>` for an intake card, the plain title otherwise. The own ref in the title becomes the work ref. */
export function clientChangeTitle(wr: { ref: string; isClientRef: boolean }, cardRef: string, title: string): string {
  if (!guardsInternalRef(wr, cardRef)) return title;
  const t = title.replace(new RegExp(internalRefPattern(cardRef).source, 'gi'), wr.ref);
  return `${wr.ref}: ${t}`;
}
```

`clientChangeTitle` returns `title` unchanged for non-intake cards (AC3). Export these from `cards/index.ts`.

### 4.2 Protocol (`packages/shared/src/testing/index.ts` `FinalizeExecutePayloadSchema` / `FinalizeResultSchema`)

```ts
// FinalizeExecutePayloadSchema (both optional: old servers send neither, old runners ignore them)
/** The card's work reference (GWP-120 workReference): the client ticket (`ABC-1`, `acme/web#12`) or the internal ref. */
workRef: z.string().optional(),
/** `workRef` is the client's ticket: titles use it, and the runner refuses commits that carry the internal ref. */
isClientRef: z.boolean().optional(),

// FinalizeResultSchema
/** An intake card's commits carry its internal ref: nothing was pushed or merged. */
internalRef: z.object({
  ref: z.string(), workRef: z.string(),
  commits: z.array(z.object({ sha: z.string().max(64), subject: z.string().max(200) })).max(50),
}).optional(),
```

The doc comment of `ticket` changes to "the ticket part of the PR branch name".

### 4.3 Server: `apps/server/src/commands/finalize.ts` `queueExecute`

Replace `prBranchTicket` (and its intake-only query) with GWP-120's functions:

```ts
// Fallback for cards made before createDraft copied the intake key into fields (keeps today's PR names for them).
const intakeKey = card.fields?.externalRef ? null : (await one(tx, `SELECT i.external_key …`, [card.id]))?.external_key;
const wr = workReference({ ref: card.ref, fields: intakeKey ? { ...card.fields, externalRef: intakeKey } : card.fields });
const client = guardsInternalRef(wr, card.ref);
const ticket = (client && wr.ticket && ticketBranchPart(wr.ticket)) || card.ref;   // ABC-1 | web-12 | GWP-123 (non-intake: unchanged)
…
ticket,
...(client ? { workRef: wr.ref, isClientRef: true } : {}),
prTitle: clientChangeTitle(wr, card.ref, card.title),
prBody: client ? card.title.replace(new RegExp(internalRefPattern(card.ref).source, 'gi'), wr.ref) : card.title,  // R4
```

- Non-intake: `ticket = card.ref`, `prTitle = card.title`, and no `workRef`/`isClientRef`. The payload is byte-identical
  to today (AC3).
- Delete `prBranchTicket`, and replace its three cases in `apps/server/test/pr-branch-prefix.test.ts` with payload
  tests: Jira (`DCPL-4276` stays), none (`P4-3`), and GitHub (`acme/repo#12` → `ticket: 'repo-12'`, `workRef:
  'acme/repo#12'`, which is a deliberate change: GitHub intakes get a ticket-named PR branch).
- `remoteBranch` (a PR branch pushed by an earlier finalize) is still reused, so rework updates the same PR (see R2).

### 4.4 Runner completion: `apps/runner/src/git/completion.ts`

1. **Extend `outsideTicket`, no parallel path:**
   ```ts
   const outsideTicket = (p: FinalizeExecutePayload): string | null =>
     p.isClientRef && p.workRef ? (p.workRef !== p.ref ? p.workRef : null)
       : p.ticket && p.ticket !== p.ref ? p.ticket : null;           // older servers
   const changeTitle = (p) => { const t = outsideTicket(p);
     return t ? clientChangeTitle({ ref: t, isClientRef: true }, p.ref, p.title) : p.title; };
   ```
   `mergeMessage` stays `Merge ${changeTitle(p)}`. For a non-intake card the result is `Merge <title>`, as in
   `completion.test.ts:80` (AC3).
2. **Finalize preflight** (AC4): in `executeCompletion`, after the `expectedSha` check and the `alreadyLanded` early
   return (a landed branch is done, not blocked), and **before** `rebaseOntoBase` (nothing has changed yet):
   ```ts
   if (p.isClientRef && p.workRef && p.workRef.toUpperCase() !== p.ref.toUpperCase()) {
     const bad = await commitsWithInternalRef(wt, `${await baseTarget(wt, p.baseBranch)}..HEAD`, p.ref);
     if (bad.length) return { ok: false, action, internalRef: { ref: p.ref, workRef: p.workRef, commits: bad },
       error: `${bad.length} commit(s) on the card branch name ${p.ref}; use ${p.workRef}: ${bad.slice(0,5).map(c => `${c.sha.slice(0,10)} "${c.subject}"`).join(', ')}` };
   }
   ```
   This covers `merge`, `mergeLocked`→`viaChange` and `pr`, because all of them come after this point. Nothing is pushed,
   merged or opened.
3. Put the shared git helper in `apps/runner/src/git/internal-ref.ts` (used by both the guard and completion):
   ```ts
   /** Commits in `range` (rev-list args) whose full message names `ref`. */
   export async function commitsWithInternalRef(cwd: string, range: string | string[], ref: string) {
     const r = await git(cwd, ['log', '--format=%H%x1f%s%x1f%B%x1e', ...(Array.isArray(range) ? range : [range])]);
     const re = internalRefPattern(ref);
     return r.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => x.split('\x1f'))
       .filter(([, , body]) => re.test(body ?? '')).map(([sha, subject]) => ({ sha: sha!, subject: (subject ?? '').slice(0, 200) }));
   }
   ```

### 4.5 Runner guard: `apps/runner/src/shifts/guard.ts` + `supervisor.ts guardInput`

`GuardInput` gains:
```ts
/** The card's client ticket (brief.card.workRef when brief.card.isClientRef). Set: the internal-ref checks run. */
clientRef?: string;
```
`guardInput()` sets it when `msg.brief.card.isClientRef && msg.brief.card.workRef` and the work ref differs from
`msg.brief.card.ref` (case-insensitive).

In `runGuard`, after `otherBranchViolation`:
```ts
if (input.clientRef && input.cardRef && input.permissions.mayCommit)
  violations.push(...(await internalRefViolations(input)));
```

`internalRefViolations(input)` returns up to two named violations:

- **`internal_ref_in_commits`**: `commitsWithInternalRef(wt, ['HEAD', '--not', input.startSha, ...(baseBranch ?
  [await baseTarget(wt, baseBranch)] : [])], cardRef)`. These are the commits this shift added that are not on the base
  (after a builder's own rebase, the rewritten card commits, which are the builder's to fix). Detail:
  `Commit messages on this intake card must use ABC-1, not GWP-123: <sha10> "<subject>", … Reword them (the branch is not pushed): the last one with git commit --amend -m "ABC-1: …"; older ones with git reset --soft $(git merge-base HEAD <base>) and one new commit.`
- **`internal_ref_in_branch`**: candidate branches = the current branch when it is not `input.branchName`, plus every
  branch created or moved in this shift (`snapshotBranches` vs `branchesAtStart`, skipping `isRunnerOwnedBranch` and
  `isSyncOnly`, same filters as `otherBranchViolation`). Flag names where `mentionsInternalRef(name, cardRef)`. Detail:
  `Branches of this intake card must use ABC-1, not GWP-123: aom/gwp-123-fix. Work on <branchName> and delete that branch.`
- **The assigned card branch (`input.branchName`) is never flagged** (decision D3): it is the runner's choice, not the
  agent's. It carries the internal key only for an in-flight card whose branch predates GWP-120 (GWP-120 requirement 6
  keeps it) or for GWP-120's unsafe-ticket fallback. It is never published under that name (see 2.1), and the agent
  could not rename it (`wrong_branch`).

The existing `wrong_branch` / `commits_on_other_branch` findings still fire alongside, unchanged. A violation rejects
the report through the existing path, so nothing else is needed for "stops work".

Non-intake cards: `clientRef` is unset, so neither check runs (AC6).

### 4.6 Server: route a finalize-time violation to Build

- `packages/shared/src/events/card.ts`: a new event
  `defineEvent('InternalRefInHistory', z.object({ cardId: Id, stage: Stage, ref: z.string(), workRef: z.string(), commits: z.array(z.object({ sha: z.string(), subject: z.string() })).max(50) }))`.
- `applyFinalizeResult`: a new branch **before** the conflict branch:
  `else if (ok && result?.internalRef)` appends the event (actor `runnerActor(workstationId)` or `SYSTEM_ACTOR`, as for
  `RebaseConflict`) and `cardMessage(card, {kind:'system'}, 'system', text, { commits })`, where `text` says: nothing
  was merged or pushed; these commits name GWP-123; reword them to ABC-1 (the same instructions as the guard detail); the
  card is back in Build.
- Projections: `projections/cards.ts`: `moveTo(tx, e, p.cardId, 'build', 'rework_round = rework_round + 1')`, as for
  `RebaseConflict`, plus clearing the claim and `build_evidence` the way `EvidenceLapsed` does (code-v6.ts:71). Rewording
  changes the head, so fresh evidence is due anyway. `projections/testing.ts`: clear `finalize_state/finalize_error/
  finalize_desk_item_id`, as for `RebaseConflict`.
- Add `'InternalRefInHistory'` to the dispatcher trigger list (`dispatcher/dispatcher.ts:65`, beside `RebaseConflict`)
  so the rework is picked up at once.
- **Mock agent** (`apps/runner/src/adapters/mock-agent.ts:125, 301`): use `brief.card.workRef ?? brief.card.ref` in the
  commit messages, or the E2E and mock intake flows trip the new guard.

### 4.7 Must not change

`integrationBranchName` (integration.ts) and the integration temp branch / dir in `mergeLocked` keep using `p.ref`
(internal, never pushed). The same goes for `commitRef` in `release-docs-prep.ts`, for `branchName` in `ids.ts`, for the
working and release branches, for `changeMergeCommit` on both forges, and for `packages/shared/src/hygiene` (the
violation is a guard violation, not a hygiene problem).

## 5. Risks

- **R1 In-flight intake cards** whose branch already holds commits that name the internal key get sent back to Build
  once at their next finalize. This is intended (AC4, the parent AC "all commits reference ABC-1"). The message tells the
  builder exactly how to reword. On lean team, the approval lapses because the head moves.
- **R2 An earlier PR branch** (`remoteBranch`, e.g. `<prefix>/GWP-123` from a PR opened before this change for a batch
  card) is still reused, so the open PR keeps receiving updates. Dropping it would open a second PR and orphan the first.
  This is accepted for PRs opened before this lands. New PRs always get `<prefix>/<ticket part>`.
- **R3 The ticket equals the internal ref** (a client Jira project with the same key, and the same number). Then
  `guardsInternalRef` is false: no guard and no prefix, the same as today's `ticket !== ref` rule. Otherwise every
  correct commit would be flagged.
- **R4 Card title/body**: the title's own ref is replaced in the PR title and the merge message. The PR body is
  `card.title` raw. Apply the same replace to `prBody` for an intake card (one line, server side) so AC1 "description
  contains no internal key" holds even for a title that mentions it.
- **R5 Older runners** ignore `workRef`/`isClientRef`: no preflight, but `prTitle` from the server is still correct.
  The shift guard then does not run. There is no false block.
- **R6 Different `baseTarget` freshness**: a stale `origin/<base>` only widens the range with commits of other cards,
  which do not carry this card's ref. There is no false positive.

## 6. Acceptance criteria → design → tests

| AC | Design | Test (unit unless noted) |
|---|---|---|
| PR/MR title and description reference ABC-1, no internal key | 4.3 `prTitle = clientChangeTitle`, prBody scrub (R4), `ticket` = branch part; 4.4 `outsideTicket` reads `workRef` | runner `completion.test.ts`: payload `{ref:'TOY-1', workRef:'ABC-1', isClientRef:true, ticket:'ABC-1', prBranchPrefix:'p'}` with no `prTitle` → `FakePr.calls[0]` title `ABC-1: Add thing`, branch `p/ABC-1`, `not.toMatch(/TOY-1/i)` in title/body/branch. Same for `viaChange` (`completion-protected.test.ts`). Server `pr-branch-prefix.test.ts`: `queueExecute` payload for `fields.externalRef='abc-1'` → `workRef 'ABC-1'`, `prTitle 'ABC-1: …'`, no `GWP-` |
| Merge commit references ABC-1 on GitHub and GitLab paths | merge: `mergeMessage` (4.4). PR paths: forge template from head branch + title (2.2) | runner: merge test → `originLog` first line `Merge ABC-1: Add thing`, `not.toMatch(/TOY-1/)`. `forge.test.ts`: GitHub `openChange` exec args contain `--head p/ABC-1 --title "ABC-1: …"`, GitLab POST body `source_branch: 'p/ABC-1', title: 'ABC-1: …'`, both without the internal key |
| Non-intake: same PR title, description and merge message | `clientChangeTitle` returns the title; payload without `workRef` | existing `completion.test.ts:80` (`Merge Add thing`) unchanged. Server: snapshot of `queueExecute` payload for a non-intake card equal to today (`ticket: ref`, `prTitle: title`, no new keys). Shared: `clientChangeTitle({ref:'GWP-1',isClientRef:false},'GWP-1','T') === 'T'` |
| Commit with internal key → named violation listing it; finalize blocked | 4.5 `internal_ref_in_commits`. 4.4 preflight → 4.6 `InternalRefInHistory` → Build | `guard.test.ts`: intake card (`clientRef:'ABC-1', cardRef:'GWP-123'`) commit `GWP-123: fix` → rule `internal_ref_in_commits`, detail contains the short SHA and `ABC-1`. Clean history (`ABC-1: fix`) → none. `completion.test.ts`: same commit → `ok:false`, `internalRef.commits[0].sha`, origin `main` unchanged, `FakePr.calls` empty, no remote branch. Server: `applyFinalizeResult` with `internalRef` → `InternalRefInHistory` + message, card in `build`, rework_round +1 |
| Branch with internal key → violation naming the branch | 4.5 `internal_ref_in_branch` | `guard.test.ts`: intake card commits on `aom/gwp-123-x` (or checks it out) → rule `internal_ref_in_branch`, detail names `aom/gwp-123-x`. Assigned `branchName` `aom/gwp-123-old` (legacy) → no internal-ref violation |
| Non-intake card with own key in commits: no violation | `clientRef` unset | `guard.test.ts`: `cardRef:'GWP-5'`, no `clientRef`, commit `GWP-5: x` on `aom/gwp-5-x` → `[]`. Completion without `isClientRef` and commit `TOY-1 x` → merges |
| Integration/release branch names unchanged | 4.7 | existing `integration`/`release-docs-prep` tests stay green; completion merge test asserts the integration dir/branch still use `toy-1` |

Shared unit: `internalRefPattern` (`GWP-123` ✓, `gwp-123-x` ✓, `GWP-1234` ✗, `XGWP-123` ✗, `see GWP-85` with ref
`GWP-123` ✗) and `clientChangeTitle` (scrub, R3 equal-ref case).

Regression to run: shared, runner (`completion*.test.ts`, `forge*.test.ts`, `guard.test.ts`, `architect-guard`,
`tester-guard`, `devops-guard`), server unit (`pr-branch-prefix`, finalize/ba-finalize tests). Server tests that need
Postgres, the integration finalize run against a test repository, and the E2E non-intake finalize flow are for the
testers.

## 7. Assumptions about unlanded dependencies (GWP-120)

1. `packages/shared/src/cards/work-ref.ts` exports `workReference(card) → { ref, isClientRef, ticket }` and
   `ticketBranchPart(ticket) → string | null`, as in its design. If the names differ, only the imports in
   `finalize.ts` change.
2. `ShiftBrief.card` carries optional `workRef` and `isClientRef` (GWP-120 4.2.3). If they are absent, `guardInput`
   cannot set `clientRef` and the shift guard stays off. The finalize preflight still works (the server computes it).
3. New intake branches are ticket-named (`aom/ABC-1-…`) and in-flight branches keep their names. The decision to exempt
   the assigned branch (D3) depends on this.
4. GWP-120 leaves `finalize.ts` `prBranchTicket` to this card (its 4.4). If GWP-120 already replaced it, adapt 4.3 to
   add only `workRef`/`isClientRef`/`prTitle` from the same `wr`.

## 8. Decisions recorded

- **D1** One work-reference path: the server computes it with `workReference` in `queueExecute`. The runner's
  `outsideTicket` reads `p.workRef`, with `p.ticket` kept only for older servers.
- **D2** The finalize check runs in the runner (only it can read the commits). Its result sends the card to Build
  through a new event. `mergeChecks`/`completionStep` are unrelated.
- **D3** The assigned card branch is not flagged (GWP-120 requirement 6 and its fallback). Other branches the shift
  creates, moves or checks out that carry the own key are flagged.
- **D4** Only the card's own internal ref is flagged (requirement 4). Other keys such as "see GWP-85" stay out of scope,
  because a client's Jira project may share the internal project key, which would flag the client's own tickets.
- **D5** Shift guard = this shift's commits (roles that may commit). Finalize = every card commit.
