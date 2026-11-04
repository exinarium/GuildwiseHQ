# GWP-94: builders refused on rework with "excluded from <card>"

## Question

A builder who worked a card before is refused when the card comes back for rework: the CEO reassign says
`<name> is excluded from GWP-74`, the dispatcher never offers the card to them, and the workability view reports the
card as not workable. On GWP-74 (large card, 3 rework rounds) the only free senior builders, Ada and Ken, had both
worked it, so nobody could take it. Where does the exclusion come from, how is it removed without weakening any
other rule, and how is the previous builder made the preferred pick on rework?

## Findings

### 1. The exclusion is the review self-review guard, read at every stage

- `cards.excluded_agent_ids` is written in two places only (`apps/server/src/projections/cards.ts`):
  - `ReviewRequested` (l.619-640) sets it to `DISTINCT_EXCLUDED` (l.233): `original_builder_agent_id` and
    `last_agent_id`. This is the "nobody reviews their own work" guard.
  - `ReviewApproved` with `toStage = 'review'` (l.677-686) appends the reviewer, so a second approval of a high-risk
    card comes from someone else.
- It is cleared by `ChangesRequested`, `StageCompleted`, `TestPassed`, `ReviewApproved` (other stage),
  `CardMovedByManager`, `CardReopened`, `CardFinalized`, `QaSentBack`, `EvidenceLapsed` (`projections/code-v6.ts`).
- It is **not** cleared by `RebaseConflict` (l.734-737): `moveTo(..., 'build', 'rework_round = rework_round + 1')`.
  `RebaseConflict` is emitted from review stages with `rebaseBefore` (`commands/rebase.ts`) and from finalize
  (`dispatcher/bottleneck.ts` l.146, when DevOps could not resolve a conflict). A card that was in review with
  `excluded_agent_ids = {original builder, last builder}` therefore lands in Build with both builders still listed.
  That is the GWP-74 pattern: Ada built round 1, Ken built a later round, the review request excluded both, a merge
  conflict sent the card back to Build, and both seniors were shut out. `CardSpecified`, `ChildCardResolved` and
  `TestReworkRequested` also move without clearing, but they never run while the array is filled.
- The read side does not look at the stage. `eligibility()` in `apps/server/src/dispatcher/candidates.ts` l.100:
  `notExcluded: NOT (${A.id} = ANY (c.excluded_agent_ids))`, used by
  - `CANDIDATES_SQL` l.171: dispatcher pass, the builder's own claim (`claim()` -> `isCandidate()`), the overflow pass
    (`isCandidate()`), the `preferred` path (CEO reassign goes through `dispatcher.prefer()` then `claim()`) and
    `cloud/tick.ts` (wake-up of cloud workstations);
  - `reserveHolderCanTake()` l.155-158: a card affinity or a group builder reservation lapses when the holder is
    "excluded". After a rebase conflict, the affinity to the builder is dropped for the same reason;
  - `queries/workability.ts` l.50 and l.147-165 (step 4: "built this card and cannot review their own work" /
    "is excluded from this stage"), which is why GWP-74 showed as not workable with a review wording on a build stage;
  - `ceo/actions2.ts` `cannotWorkStage()` l.76 and l.95: the refusal text `${a.name} is excluded from ${card.ref}`.
- Nothing else shows the exclusion: `queries/org-chart.ts` only imports `ONLINE_WINDOW_MS`; the web app has no
  "excluded" text about cards (only the delegation-grant "excluded for this agent" badge, unrelated).
  `commands/shifts.ts` l.403 reads the array for the second high-risk reviewer (review stage, keep).

So the root cause is a guard that belongs to review stages being evaluated at build stages, with one projection
(`RebaseConflict`) that carries the review-time array into Build.

### 2. Today's rework preference uses the original builder, not the most recent one

- `freeAgents()` (`dispatcher/dispatcher.ts` l.193-203) sorts agents that are `original_builder_agent_id` of a
  queued rework/bug card first.
- `CANDIDATES_SQL` ORDER BY key 2 (l.232-236) ranks a rework card whose `original_builder_agent_id = $1` first for
  that agent.
- `original_builder_agent_id` is set once, at the first builder claim (`CardClaimed`, l.495), and never changes.
  After a round by another builder, the first builder is still "preferred": AC "most recent is preferred" fails.
- The pass is agent-major: each free agent, in order, takes its own top candidate. An agent sorted before the
  previous builder can still take the card first (for example another builder that is also an "original" of a
  card it cannot take). So ordering alone does not guarantee AC3.
- The card's own history has what is needed without a migration: `shifts (card_id, agent_id, stage, kind,
  started_at, outcome)` with index `shifts_card (card_id, started_at)`. The builder stages are the card workflow's
  stages with `claim_role = 'builder'` (`workflow_stages`). Bug child cards have no shifts of their own;
  `projections/testing.ts` gives them the parent's `original_builder_agent_id`, which is the fallback.

## Options

| Option | What | Verdict |
|---|---|---|
| A. Clear the array in `RebaseConflict` (and the other non-clearing moves) | Data fix in the projection | Fixes the GWP-74 path only. Any future path that forgets to clear brings the bug back, and the read side keeps telling build stages a builder is "excluded". Changes replay output. Not chosen. |
| B. Make the guard stage-aware on the read side | `notExcluded` (renamed) only applies to non-builder stages; same in `reserveHolderCanTake` | One clause, every path (dispatch, claim, overflow, preferred, reassign, workability, cloud tick) follows. The review self-review guard stays exactly as it is. **Chosen.** |
| C. Drop the guard entirely | | Breaks the self-review rule and the second-reviewer rule (`double-review.test.ts`). Rejected. |

For the preference:

| Option | What | Verdict |
|---|---|---|
| P1. Only change the sort source and the ORDER BY key to "most recent builder" | Small | Leaves the steal case open (another prior builder processed earlier takes the card). |
| P2. A pre-loop that claims every rework card for its previous builder first (like `preferred`) | Strict | Overrides the previous builder's own priorities (its affinity, group card or scheduled card would wait). Not a tie-breaker. |
| P3. P1 plus a pass-local yield: an agent skips a card only when that card is the previous builder's own first pick in this same pass and that builder has not had its turn yet | Strict for AC3, no waiting, no change to the previous builder's own order | **Chosen.** |

## Recommendation and design

### 1. Stage-aware self-review guard (`apps/server/src/dispatcher/candidates.ts`)

Rename the clause so its purpose is clear, and never apply it on a builder stage:

```ts
// The review guard: nobody reviews their own work, and a second approval comes from someone else. The list is
// filled when review is requested (projections/cards.ts); a build stage never reads it (GWP-94: a builder is never
// kept from a card because they worked it before).
reviewGuard: `(st.claim_role = 'builder' OR NOT (${A.id} = ANY (c.excluded_agent_ids)))`,
```

`st` is joined in every query that uses the clauses (`CANDIDATES_SQL`, `workability.ts` AGENTS_SQL, `actions2.ts`
`cannotWorkStage`). Use `'builder'` as the test: it is the same role key `CardClaimed` uses to set
`original_builder_agent_id`, so "build stage" means the same everywhere.

`reserveHolderCanTake(a)` (l.155) gets the same condition:

```ts
`(st.claim_role = 'builder' OR NOT (${a}.id = ANY (c.excluded_agent_ids)))
 AND (c.risk_tier IS NULL OR ...)`   // tier part unchanged
```

Update its doc comment ("not excluded from it" -> "and, at a review stage, did not build or already review it").
Replace `${E.notExcluded}` with `${E.reviewGuard}` in `CANDIDATES_SQL` (l.171). No projection change; the
`RebaseConflict` array becomes harmless at Build and is rewritten on the next `ReviewRequested`.

### 2. Previous builder (`candidates.ts`, shared by the dispatcher)

```ts
/**
 * The builder who most recently worked card `c` at a build stage (its shifts; a shift the runner turned away does not
 * count), else its original builder (a bug card inherits it). Ordering only: it never makes anyone eligible.
 */
export const previousBuilderSql = (c: string): string => `COALESCE((
  SELECT s.agent_id FROM shifts s
    JOIN workflow_stages ps ON ps.workflow_version_id = ${c}.workflow_version_id AND ps.stage_id = s.stage
   WHERE s.card_id = ${c}.id AND s.kind = 'card' AND ps.claim_role = 'builder'
     AND s.outcome IS DISTINCT FROM 'rejected'
   ORDER BY s.started_at DESC, s.id DESC LIMIT 1), ${c}.original_builder_agent_id)`;
```

In `CANDIDATES_SQL`:

- SELECT: `c.id, c.stage, c.project_id, CASE WHEN st.claim_role = 'builder' THEN ${previousBuilderSql('c')} END AS prev_builder_id`
  (extend the return type of `candidateCards`; `isCandidate` is unchanged).
- ORDER BY key 2 becomes:
  ```sql
  CASE
    WHEN st.claim_role = 'builder' AND ${previousBuilderSql('c')} = $1 THEN 0   -- the card this agent built last
    WHEN c.is_rework_or_bug THEN 1
    ELSE 2
  END,
  ```
  Keys 0, 0b, 1 (affinity, group, scheduled) stay ahead, so the previous builder's own priorities do not change.

### 3. Dispatcher (`apps/server/src/dispatcher/dispatcher.ts`)

- `freeAgents()` l.194-203: build the "originals" set from the previous builder of queued, unclaimed build-stage
  cards instead of `original_builder_agent_id`:
  ```sql
  SELECT DISTINCT ${previousBuilderSql('c')} AS id
    FROM cards c JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
   WHERE c.status='queued' AND c.claim_id IS NULL AND st.claim_role = 'builder'
  ```
  (filter NULL ids in JS). Rename the set to `previousBuilders` and fix the comment.
- `pass()` main loop (l.296-315): a pass-local yield so an agent processed earlier does not take a card its
  previous builder is about to take:
  ```ts
  const pending = new Set(agents.map((a) => a.row.id));          // not yet had their turn in this loop
  const firstPick = new Map<string, string | null>();             // agentId -> its first claimable card this pass
  const firstPickOf = async (a: FreeAgent): Promise<string | null> => { /* cached:
       null if a.active >= capacity, skip(), full(); else candidateCards(view(a)) and the first card with
       accountOf(a.row, c.project_id, a.capped) */ };
  for (const agent of agents) {
    pending.delete(agent.row.id);
    ...
    for (const c of cands) {
      const prev = c.prev_builder_id && c.prev_builder_id !== row.id && pending.has(c.prev_builder_id)
        ? agents.find((x) => x.row.id === c.prev_builder_id) : undefined;
      if (prev && (await firstPickOf(prev)) === c.id) continue;   // its previous builder takes it later in this pass
      ...claim as today
    }
  }
  ```
  The yield only happens when the previous builder is free, not cooling down, its workstation is not full, it has an
  account for the project, the card passes all its eligibility clauses (it is in its candidate list) and the card is
  its first pick. Then it takes the card in this same pass. In every other case (busy, at cap, paused or retired:
  not in `agents`; junior on a large card: not in its candidates; prefers its own affinity or group card: first
  pick is another card), the other agent claims at once. Nothing is held across passes, so it is a tie-breaker, not
  a reservation.
- The `preferred` loop (CEO reassign) runs first and is unchanged, so an explicit reassignment beats the
  previous-builder preference. `overflowPass` handles late scheduled cards only, and `claim()` needs no change: both
  already call `isCandidate()`, which now accepts the prior builder. Claim locking (`claim_id IS NULL` in the
  transaction, the dispatch advisory lock) is untouched, so two builders still cannot claim the same card.

### 4. Texts

- `queries/workability.ts` step 4 (l.147-165): use the `reviewGuard` column (`review_guard_ok`). At a build stage it is
  always true, so step 4 never fires there. Rewrite the comment, rename `builderIsExcluded` to `builtByThem`, and
  replace the last fallback (l.163) `"every eligible X (...) is excluded from this stage"` with
  `"every eligible ${seniorWord}${roleLower} (${others}) built or already reviewed this card, and nobody reviews their own work. Hire another ${seniorWord}${roleLower}."`.
  Keep the review wordings at l.157-161.
- `ceo/actions2.ts` `cannotWorkStage()` l.76 and l.95: use `reviewGuard`; the refusal becomes
  `${a.name} built or already reviewed ${card.ref} and cannot review it` (review stages only). Update the doc
  comment at l.67-71 ("an exclusion" -> "the review guard").
- `docs/ARCHITECTURE.md` l.1203: change the comment to say the list applies at review stages only.

### Data model, API, migration

No migration, no new event, no new setting, no API change. History comes from `shifts` (existing index
`shifts_card`).

## Risks

- **Existing tests that expect another builder after a return to Build.** The preference now follows the most recent
  builder. Run the full apps/server suite; update only tests that asserted the exclusion or the old "original
  builder" choice, and say which in the handoff.
- **Query cost.** `previousBuilderSql` is a correlated sub-select on the candidate rows only (after the WHERE) and on
  queued build-stage cards in `freeAgents()`; it uses `shifts_card`. `firstPickOf` runs one extra `candidateCards`
  only when a conflict exists, cached per pass.
- **Self-review guard.** Only build stages skip it. `pre_review`, `review`, `merge_review` and custom review roles keep
  it. `double-review.test.ts`, `dispatcher-order.test.ts` "review goes only to senior reviewers other than the builder"
  and `runner-gateway.test.ts` l.144 must stay green unchanged.
- Pre-existing, out of scope: `StageCompleted` (pre_review -> review) clears the array, so the Review stage itself
  does not exclude the builder (role matching keeps builders out anyway). Not changed here.

## Acceptance criteria -> design

| AC | Design | Test |
|---|---|---|
| Prior builder can claim it again on rework, no "excluded" refusal | `reviewGuard` true on builder stages (candidates.ts) -> `isCandidate`/`claim` succeed | T1 |
| CEO/manager reassign to a prior builder is not refused | `cannotWorkStage` uses `reviewGuard`; `preferred` claim passes `isCandidate` | T2 |
| Previous builder free and eligible gets it, even with others free | `freeAgents` sort + ORDER BY key 2 + pass-local yield | T3 |
| Busy/at cap/paused/retired/ineligible previous builder: another builder at once | yield only when the card is the previous builder's first claimable pick | T4, T5 |
| Most recent of several builders preferred | `previousBuilderSql` (latest builder-stage shift) | T7 |
| GWP-74: large card, only prior seniors free, workable and claimed, no "excluded" reason | guard + preference + workability step 4 not reached at Build | T6 |
| No other rule changes; existing tests pass except the exclusion ones | only `notExcluded` (renamed) and the ORDER BY key change | T8 |
| No user/agent text says a builder is excluded for prior work | workability.ts and actions2.ts texts rewritten; review-only wording kept | T1, T2, T6 assert no `/excluded/` |

## Test plan for the builder (apps/server/test)

Put the new cases in a new `apps/server/test/rework-previous-builder.test.ts` (world helpers as in
`dispatcher-order.test.ts`: `createWorld`, `w.hire`, `w.card`, `markOnline`, `drain`). Record prior work by inserting
`shifts` rows (`kind='card'`, `stage='build'`, `status='ended'`, `card_id`, distinct `started_at`; columns as in
`agent-gates.test.ts` l.49) or by running real shifts with the code-v6 harness. To reproduce the real leak, put the
card in `review` with `excluded_agent_ids` = the builders, then append a `RebaseConflict` event (or set
`stage='build', status='queued'` and keep the array).

- T1 re-claim: A worked X, X back in Build with A in `excluded_agent_ids`; `isCandidate(A, X)` is true and
  `claim()` returns a claim for A.
- T2 reassign: `card.reassign` of X to A (see `ceo-authority.test.ts`) is not refused; the message has no "excluded".
- T3 preference: A (previous) and B free and eligible, B ordered first by `last_shift_ended_at`; one `runPass()`
  gives X to A.
- T4 fallback: same, A at capacity (or `paused_at` set, or retired); X goes to B in the same `runPass()`.
- T5 seniority: X `risk_tier='large'`, A a junior with `riskTiers ['small']` who worked it, B senior; X goes to B.
- T6 GWP-74: large card, `rework_round=3`, Ada (round 1) and Ken (round 3) seniors, both in
  `excluded_agent_ids`, no other builder; `cardWorkability` gives ok (no `/excluded/`), `runPass()` gives X to Ken.
- T7 several prior builders: A round 1 and C round 2, both free and eligible; C gets X.
- Also: a "steal" case: B is the previous builder of another queued card Y it cannot take (tier) and is ordered
  before A; X still goes to A.
- Update `code-v6.test.ts` l.638-657: at a build stage an affinity holder listed in `excluded_agent_ids` keeps the
  reservation (`offered(ben)` does not contain the card); keep the tier part. Optionally add the review-stage
  variant where the reservation still lapses.
- Keep unchanged and green: `double-review.test.ts`, `dispatcher-order.test.ts` l.321-344, `workability.test.ts`
  l.101-114 (review stage), `runner-gateway.test.ts` l.144.
- T8: run the full apps/server unit suite (DB-backed, as the project runs it).
