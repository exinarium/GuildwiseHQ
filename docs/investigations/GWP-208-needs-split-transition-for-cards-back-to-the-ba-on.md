# GWP-208 Needs-split transition for cards: back to the BA once, with folder scope and split seams

## 1. Question

When a card is over its project's size budget at design time, it needs a way back to the BA:

1. A new card transition, "needs split", sends the over-budget card back to the BA.
2. The card carries the architect's **folder scope** and **proposed split seams**.
3. The BA creates the child cards from it, and the parent links to them.
4. A card can take this route **once**. A second over-budget verdict goes to the owner's desk instead.

Open points from planning: who confirms needs-split (AC1 does not say), where the once-only marker is stored, how the
state names stay clear of GWP-209 (PR side), and how the F6.2/F6.3 sub-items map to the ACs.

## 2. Findings

### 2.1 The PRD (v22, doc 61871304) and the F6 sub-items

The v22 copy in the project vault (`projects/gwp/docs/review-gates-reviewer-workflow.md`) is the summary, users, decision
log and a list of edit instructions. **It does not contain the F6 table.** It says "Rewrite F1.2, F1.3, F4.3, F5.2, F6.2
and F6.3 so each separate behaviour becomes its own numbered sub-item", but the sub-items themselves are not in it.
GWP-205 and GWP-206 found the same thing. So the ACs are mapped to the PRD and boardroom text that does exist:

| Source | What it says | Where it lands |
|---|---|---|
| PRD 5, BA | "Receives a split card once and creates the child cards." | R1, R3, R4 / AC1, AC2, AC3 |
| PRD 5, Architect | "Estimates size at design time and raises the needs-split question." | GWP-207 raises it, and this card provides the transition the answer calls (section 4.2) |
| Decision log | "Needs-split transition to the BA once. Reason: one splitting route." (Johnny, confirmed) | The existing BA split (`spec_card` → `applySplit`) is reused, with no second split mechanism (2.3). Once-only: AC3 |
| Boardroom | "A card returned to the BA must carry the architect's folder scope and proposed split seams; one return only, after that the owner decides." | `NeedsSplitProposal` (AC1); owner desk item (AC3) |
| Boardroom | "scope is folders plus an in-repo allowlist, never exact paths" | Folder validation of the proposal (5.1) |
| Boardroom | "Johnny needs the approval yes, but the question should be raised by the architect." | Confirmation = an explicit call by the owner or a manager, or the answer to GWP-207's question (4.2) |
| Boardroom | "needs-split question fires only when estimated size exceeds the project budget; high risk alone goes to the design gate" | GWP-207 (verdict) and GWP-206 (gate). This card only consumes the result |
| PRD F6.1 / F1.5 / F3 edits | Over-budget **PR** goes back to the PR author as needs-split | GWP-209 and GWP-210, out of scope. The names here must not clash (7) |

### 2.2 What the code has today

- **The BA already splits cards.** `spec_card` BA tasks (`apps/server/src/commands/spec-card.ts`,
  `packages/shared/src/intake/spec-card.ts`) let the BA report `{ split: [{ title, cardType?, repo, fields, dependsOn? }] }`
  (2 to 8 cards). `planSplit` checks every child first (repository, card type, field parse, `missingForSpecify`, only
  earlier `dependsOn`). Then `applySplit`, in one transaction under a savepoint, creates the children with
  `parentCardId`, moves the parent's prerequisites to the root children and its dependents to the leaf children, and
  cancels the parent with `CardCancelled{cause:'split', childCardIds}`.
- **The links are already shown on both sides.** `splitLinks()` (`apps/server/src/queries/cards.ts:786`) gives
  `splitInto` on the cancelled parent and `splitFrom` on each child, read from that `CardCancelled` event.
  `SplitLinks` (`apps/web/src/components/SubworkflowsPanel.tsx`) renders them on `CardDetail`.
- **The split only runs today when the card has no repository.** `applySpecCardReport` refuses a `split` on a card
  that has a repository ("needs no repository from you: write its fields only") and requires `card.status === 'draft'`.
- **Today "back to the BA" means the manual `spec` stage.** In `code` v6 (`builtin/code-v6.ts`) the first stage is
  `spec` (`kind: 'manual'`, "moved on by the manager or the BA"). `moveCardWithNotice` (`commands/cards.ts:735`) moves
  a card into a manual stage with `status 'draft'`, releases the claim, dismisses the blockers that hold only this card,
  and appends `CardMovedByManager` plus a thread note.
- **The prompt of a BA task is rendered on the runner** (`packages/shared/src/prompt/ba-task.ts` →
  `renderSpecCardInstructions`). A new mode needs a minimum runner version, as with `MIN_RUNNER_FOR_REPO_SCOPING`
  (checked in `dispatcher/ba-tasks.ts:171`).
- **Owner decisions with options already exist.** The `tester_loop` question (`commands/tester-loop.ts`) is a
  `QuestionRaised` with options. `testerLoopAnswered` runs the chosen action inside `answerDeskItem`
  (`commands/desk.ts:250`). `routedTo:'manager', chainLevel:'desk'` with no `triage` hold puts it straight on the
  owner's or manager's desk.
- **No needs-split code exists**, and no size verdict either. GWP-207, which builds the verdict, is recorded as
  **depending on this card** (`aom card facts GWP-207`). So this card is built first. It cannot read a verdict field,
  so it must **provide the transition that GWP-207 calls**.

## 3. Options

### A. How the BA splits

| Option | For | Against |
|---|---|---|
| **A1: reuse `spec_card` with a new "needs split" mode** (the card moves to `spec`/draft, and the task carries the proposal) | One splitting route (decision log). `planSplit`/`applySplit`, dependency re-wiring, the cancel and `splitInto`/`splitFrom` come for free. AC2 mostly already works | The prompt changes on the runner, so a version gate is needed |
| A2: new BA task kind `needs_split` | Clean separation | A second split implementation, a new outcome set, new runner CLI help, new dispatcher branches. Goes against "one splitting route" |
| A3: no agent; the owner splits by hand in the UI | No runner change | Goes against PRD 5 ("BA creates the child cards"). There is no UI to split a card |

**Choice: A1.**

### B. Where the once-only marker lives

| Option | For | Against |
|---|---|---|
| **B1: columns on `cards`: `needs_split_count int NOT NULL DEFAULT 0` (times sent to the BA) + `needs_split jsonb` (latest record)** | Cheap to check, visible in the DTO, rebuildable from events | Two columns |
| B2: derive it from the events every time | No columns | A slow query in the hot rule, and harder for GWP-207 to read |

**Choice: B1.** A child created by a needs-split split **inherits** the marker (its parent's `needs_split.childCardIds`
contains it). Reason: "one return only, after that the owner decides" is about the work, not the card row. Without
inheritance, a badly cut seam could go through the BA again and again (child → grandchild → ...). The check is a single
condition (`needsSplitTaken`, 5.3), so it is easy to change if the owner rules otherwise.

### C. Who confirms needs-split (AC1 "when needs-split is confirmed")

The architect proposes (GWP-207 raises the question, carrying the proposal), and a person or the CEO confirms. This
card provides one server function, `requestNeedsSplitIn`, and **two callers**:

1. `POST /api/cards/:id/needs-split` (body: the proposal). The project owner or a manager can call it
   (`loadManageable`, the same rule as a manual move). This is the confirmation path in this card and in its tests.
2. GWP-207's answer handler for its needs-split question (owner or CEO), which calls `requestNeedsSplitIn` with the
   proposal stored on the question. **This is not built here.** Section 4.2 is the contract for GWP-207.

## 4. Recommendation

Build **A1 + B1 + C**: a needs-split transition that moves the card to `spec` (draft), records the architect's proposal
on the card and queues a `spec_card` BA task in needs-split mode. The BA must report a split. The existing `applySplit`
creates linked children and cancels the parent. A card that already took the route (or whose parent did) gets an owner
desk item `needs_split_decision` instead, with options. No BA task is queued and the card does not move.

### 4.1 Flow

```
over-budget verdict (GWP-207) ──► confirmed (owner/manager API, or the answer to GWP-207's question)
        │
        ▼
requestNeedsSplitIn(card, proposal)
  ├─ refusal? (closed / build started / one already open) ──► 409
  ├─ needsSplitTaken(card) && !force ──► owner desk item needs_split_decision (reason second_time | inherited)   [AC3]
  ├─ no active BA ──► owner desk item (reason no_ba); the card is not marked
  └─ else: CardNeedsSplitRequested(route ba) + move to spec/draft + spec_card task (needs-split mode)          [AC1]
            │
            ▼ BA shift (runner ≥ MIN_RUNNER_FOR_NEEDS_SPLIT)
      report { split: [...] } ──► applySplit: children with parentCardId, parent cancelled (cause split)        [AC2]
                                  + CardNeedsSplitResolved(outcome split, childCardIds)
      report fields only     ──► refused ("this card was returned to be split")
      spec-card-fail / no BA in time ──► owner desk item (reason ba_failed | no_ba)
```

### 4.2 Contract for GWP-207 (and GWP-206)

- GWP-207 calls `requestNeedsSplitIn(ctx, tx, card, proposal, by)` when its needs-split question is answered with
  "split". It reads `needsSplitTaken(db, card)` to word its question ("a second over-budget card goes to the owner, not
  the BA"). It **must not ask again** when `cards.needs_split->>'state' = 'continued'` (the owner accepted the size).
- GWP-207 builds the `NeedsSplitProposal` (folder scope, seams, estimate) and may narrow `estimate.unit` to GWP-205's
  `SizeUnitSchema`. This card keeps `unit` a plain string so it does not depend on GWP-205.
- GWP-206: over budget → needs-split wins over the design gate. `design_gate` is an allowed source stage here (the rule
  is generic, 5.3). Moving out of it dismisses the open approval item through the existing move logic.

## 5. Design

### 5.1 Shared: `packages/shared/src/cards/needs-split.ts` (new, exported from `cards/index.ts`)

```ts
import { z } from 'zod';
import { SPEC_CARD_MAX_SPLIT } from '../intake/spec-card.ts';

/** A folder inside a repository (boardroom: scope is folders, never exact paths). */
export const NeedsSplitFolderSchema = z.string()
  .transform((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
  .pipe(z.string().min(1).max(300)
    .refine((p) => !p.startsWith('/'), 'a folder inside the repository, not starting with /')
    .refine((p) => !p.split('/').includes('..'), 'no .. in a folder')
    .refine((p) => !/[*?[\]]/.test(p), 'a folder, not a pattern')
    // last segment looks like a file (name.ext, not a dot-folder such as .github)
    .refine((p) => !/[^/.][^/]*\.[A-Za-z0-9]{1,8}$/.test(p), 'a folder, not a file: name the folder that holds it'));

export const NeedsSplitSeamSchema = z.object({
  title: z.string().trim().min(1).max(200),
  folders: z.array(NeedsSplitFolderSchema).min(1).max(20),
  /** Repository name for multi-repository projects; absent: the card's repository. */
  repo: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** The architect's proposal that goes with the card to the BA (strict: request input). */
export const NeedsSplitProposalSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  folderScope: z.array(NeedsSplitFolderSchema).min(1).max(50),
  seams: z.array(NeedsSplitSeamSchema).min(2).max(SPEC_CARD_MAX_SPLIT),
  /** The size verdict it came from (GWP-207); unit stays a string here. */
  estimate: z.object({ size: z.number().int().min(0), budget: z.number().int().min(1), unit: z.string().min(1).max(40) }).optional(),
}).refine(noDuplicateFolders, 'each folder appears once in the folder scope');
export type NeedsSplitProposal = z.infer<typeof NeedsSplitProposalSchema>;

/** Stored/DTO form: the same shape with no transform or refine (old events must always parse). */
export const StoredNeedsSplitProposalSchema = z.object({ /* same keys, plain z.string() / arrays */ });

export const NeedsSplitState = z.enum(['with_ba', 'owner', 'split', 'continued', 'cancelled']);
export const NeedsSplitReason = z.enum(['first', 'second_time', 'inherited', 'no_ba', 'ba_failed', 'owner_again']);
export const NEEDS_SPLIT_DESK_SUBKIND = 'needs_split_decision';
export const NEEDS_SPLIT_OPTIONS = { continue: 'continue', baAgain: 'ba_again', cancel: 'cancel' } as const;
export const NEEDS_SPLIT_REASON_TEXT: Record<z.infer<typeof NeedsSplitReason>, string> = {
  first: 'over budget: back to the BA to split (the one return this card gets)',
  second_time: 'over budget again after it already went back to the BA once',
  inherited: 'over budget, and it was itself split out of a card that already went back to the BA',
  no_ba: 'over budget, but no BA is hired to split it',
  ba_failed: 'the BA could not split it',
  owner_again: 'the owner sent it to the BA again',
};

/** The once-only rule as a pure function (server passes the facts). */
export function needsSplitRoute(i: { taken: boolean; force?: boolean; hasBa: boolean }):
  { route: 'ba' | 'owner'; reason: z.infer<typeof NeedsSplitReason> } { ... }
```

Also add `MIN_RUNNER_FOR_NEEDS_SPLIT` next to `MIN_RUNNER_FOR_REPO_SCOPING` in `intake/spec-card.ts`. Set it to the
runner release that ships this (today `RUNNER_VERSION` is `0.1.72`, so `0.1.73` unless a bump lands first).

`SpecCardTaskSchema` gets an optional `needsSplit`:

```ts
needsSplit: z.object({
  proposal: StoredNeedsSplitProposalSchema,
  round: z.number().int().min(1),
  design: z.object({ reportPath: z.string(), summary: z.string() }).nullable(),
  repos: z.array(z.object({ name: z.string() })),     // names the BA may use for child.repo
  defaultRepo: z.string(),                            // the card's repository name
}).optional(),
```

`renderSpecCardInstructions` / `renderSpecCardPrompt`: when `task.needsSplit` is set, render a **needs-split job**
(new `renderNeedsSplitJob`):
- "Card X is over its size budget. The architect proposes to split it along these seams. Create 2 to 8 child cards."
- Show the folder scope and each seam: title, folders, repository, note. Then the reason, the estimate and the design
  summary.
- Rules: report `{ "split": [...] }` only. Each child names its `repo` (default: the card's). Its `affectedAreas` are its
  seam's folders (folders, not files). Every acceptance criterion of the card lands in exactly one child. `dependsOn`
  orders them. A seam may be merged or cut differently if the BA explains why in the child's context. If the card
  cannot be split, report `spec-card-fail` with the reason (it goes to the owner).
- The card text is untrusted data (same wording as today).

### 5.2 Shared: events and API

`packages/shared/src/events/card.ts` (next to `CardCancelled`). Keep the events lenient, with no refinements:

```ts
defineEvent('CardNeedsSplitRequested', z.object({
  cardId: Id,
  route: z.enum(['ba', 'owner']),
  reason: NeedsSplitReason,
  fromStage: z.string(),
  proposal: StoredNeedsSplitProposalSchema,
  taskId: Id.optional(),        // route ba
  deskItemId: Id.optional(),    // route owner
  inheritedFromCardId: Id.optional(),
})),
defineEvent('CardNeedsSplitResolved', z.object({
  cardId: Id,
  outcome: z.enum(['split', 'ba_failed', 'owner_continue', 'owner_cancel']),
  childCardIds: z.array(Id).optional(),
  note: z.string().max(4000).optional(),
})),
```

`packages/shared/src/api/cards.ts`:
- `NeedsSplitRequestSchema = NeedsSplitProposalSchema` (body of `POST /api/cards/:id/needs-split`).
- `NeedsSplitResponseSchema = CardDetailResponseSchema.extend({ needsSplitRoute: z.enum(['ba','owner']), notice: z.string() })`.
- `CardDetailResponseSchema` gets:
  ```ts
  needsSplit: z.object({
    state: NeedsSplitState, reason: NeedsSplitReason, round: z.number().int(),
    fromStage: z.string(), requestedAt: z.string(),
    proposal: StoredNeedsSplitProposalSchema,
    taskId: z.uuid().nullable(), deskItemId: z.uuid().nullable(),
    childCardIds: z.array(z.uuid()).default([]), note: z.string().nullable(),
  }).nullable().optional(),
  /** The card (or the card it was split from) already went back to the BA once: a new over-budget verdict goes to the owner. */
  needsSplitTaken: z.boolean().optional(),
  ```
- `packages/shared/src/reporter/index.ts`: add `NEEDS_SPLIT_DESK_SUBKIND` to `ROUTING_EXEMPT_SUBKINDS`, so the item is
  never held for CEO or BA triage ("after that the owner decides").

### 5.3 Server

**Migration** `apps/server/migrations/29xx_card_needs_split.sql` (take the next free number on main when you build;
GWP-205 and GWP-206 also add migrations):

```sql
-- Needs-split (projection of CardNeedsSplitRequested/Resolved): the latest record and how often the card went to the BA.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS needs_split jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS needs_split_count integer NOT NULL DEFAULT 0;
```

**Projector** (`apps/server/src/projections/cards.ts`):
- `CardNeedsSplitRequested`: `needs_split = { state: route==='ba' ? 'with_ba' : 'owner', reason, fromStage, proposal, taskId, deskItemId, inheritedFromCardId, requestedAt: e.at, round: needs_split_count + (route==='ba'?1:0), childCardIds: [] }`,
  `needs_split_count = needs_split_count + (route = 'ba' ? 1 : 0)`.
- `CardNeedsSplitResolved`: `state` = `split` | `owner` (ba_failed) | `continued` | `cancelled`, plus `childCardIds` and `note`.
  `jsonb_set`/`||` on the existing record.

**New module** `apps/server/src/commands/needs-split.ts`:

```ts
/** The card, or the card it was split out of by a needs-split, already went to the BA once. */
export async function needsSplitTaken(db: Queryable, card: Row): Promise<{ taken: boolean; inheritedFrom?: Row }> {
  if ((card.needs_split_count ?? 0) > 0) return { taken: true };
  if (!card.parent_card_id) return { taken: false };
  const p = await one(db, `SELECT id, ref FROM cards WHERE id=$1 AND needs_split->'childCardIds' ? $2`,
                      [card.parent_card_id, card.id]);
  return p ? { taken: true, inheritedFrom: p } : { taken: false };
}

/** Why needs-split cannot start on this card now (null: it can). */
export async function needsSplitRefusal(db, card, wf): Promise<{ code: string; message: string } | null>;
//  needs_split_closed     card done/cancelled
//  needs_split_no_spec    the workflow's initial stage is not a manual stage (nowhere to send it back to)
//  needs_split_too_late   a build handoff exists (card_handoffs stage='build'), or stage='build' and status='claimed',
//                         or the card is at the initial stage already: "an over-budget PR goes back to its author, not to the BA"
//  needs_split_open       needs_split.state in ('with_ba','owner'), or an open spec_card task / open needs_split_decision item

export async function requestNeedsSplitIn(
  ctx: Ctx, tx: Tx, card: Row, proposal: NeedsSplitProposal,
  by: { actor: Actor; user: AuthSession['user']; name: string },
  opts: { force?: boolean } = {},   // force: the owner's "send to the BA again"
): Promise<{ route: 'ba' | 'owner'; taskId?: string; deskItemId?: string; notice: string }>;
```

`requestNeedsSplitIn` steps, in the caller's transaction, under `SELECT ... FOR UPDATE` of the card:
1. `needsSplitRefusal` → throw `conflict(code, message)`. With `force`, skip only the "taken" check, not the refusals,
   except `needs_split_open` for the item being answered.
2. `taken = await needsSplitTaken(tx, card)`, `hasBa = await hasActiveBa(tx, card.org_id)`,
   `{route, reason} = needsSplitRoute({ taken: taken.taken, force, hasBa })`.
3. **Owner route** (AC3, or no BA): append the `QuestionRaised` from `needsSplitDecisionEvents()` (below) plus
   `CardNeedsSplitRequested{route:'owner', reason, deskItemId, inheritedFromCardId}`. The card is **not** moved and
   `needs_split_count` does not change. No `ba_tasks` row is created.
4. **BA route** (AC1): append `CardNeedsSplitRequested{route:'ba', reason, taskId}` **before** the move, so the
   projected record exists when the task is built. Then move the card to the workflow's initial stage (`spec`) with
   status `draft` through `moveCardIn` (see below; reason "Over budget: back to the BA to split along the architect's
   seams"). Then `queueSpecCardTask(ctx, tx, card, by.actor)`. Pass the `taskId` you generate in, or read it back, so
   the event carries it. Post a thread message listing the folder scope and seams (visible on the card at once).

**Refactor (small):** extract the body of `moveCardWithNotice` into
`moveCardIn(ctx, tx, card, toStage, reason, { actor, actorUserId, by })`, with no permission check and no transaction of
its own. `moveCardWithNotice` keeps its signature and calls `loadManageable` + `moveCardIn`. `releaseEvents` needs a
user id: pass `by.user.id`. For a CEO/agent caller, the user is the card owner (as `splitOwner` does).

**Owner desk item** `needsSplitDecisionEvents(ctx, tx, card, proposal, reason)`: one open item per card (dedupe on
`subkind` + `card_id` + `status='open'`):
- `QuestionRaised{ subkind: NEEDS_SPLIT_DESK_SUBKIND, askedBy:{kind:'system'}, routedTo:'manager', chainLevel:'desk', pinned:true, blocking: card.status !== 'draft', affectedCardIds:[card.id], topic:'code', data:{ reason, proposal, fromStage } }`, with no `triage`.
- `doing`: "`<REF>` (title) is over its size budget". `question`: `NEEDS_SPLIT_REASON_TEXT[reason]`, then a short
  list of the folder scope and the seams, then "One return to the BA is allowed; you decide how it goes on."
- Options: `continue` "Keep it as one card" (the size is accepted; the design goes on), `ba_again` "Send it to the BA
  to split anyway" (hidden when `reason === 'no_ba'` and still no BA), `cancel` "Cancel the card". Recommendation:
  none, because this is the owner's call.

**Answer handler** `needsSplitAnswered(ctx, tx, item, optionId, answer, by)`. Call it in `answerDeskItem` right after
`testerLoopAnswered` (`commands/desk.ts:250`):
- `continue`, or no option: append `CardNeedsSplitResolved{outcome:'owner_continue', note: answer}`. If the card is in
  `spec` (reason `ba_failed`), move it back to `needs_split.fromStage` with `moveCardIn`. Otherwise `QuestionAnswered`
  has already put it back in its queue. Post a thread note for the architect: "The owner keeps `<REF>` as one card:
  finish the design."
- `ba_again`: `requestNeedsSplitIn(..., { force: true })` with the stored proposal, reason `owner_again`. The count
  goes to 2.
- `cancel`: `cancelCardIn(...)` + `CardNeedsSplitResolved{outcome:'owner_cancel'}`.
- If the card is closed meanwhile, post a thread note that the answer was not carried out (as `testerLoopAnswered`
  does).

**Route** `apps/server/src/routes/cards.ts`:
```ts
app.post('/api/cards/:id/needs-split',
  { schema: { params: CardParamsSchema, body: NeedsSplitRequestSchema } },
  async (req) => {
    const s = await requireUser(ctx, req);
    const r = await confirmNeedsSplit(ctx, s.user, req.params.id, req.body); // withAppendTx + loadManageable + requestNeedsSplitIn
    ctx.services.dispatcher.trigger();
    return { ...(await getCardDetail(ctx, s.user.id, r.cardId)), needsSplitRoute: r.route, notice: r.notice };
  });
```
A bad body gets a 400 from the schema. A manager-only check comes through `loadManageable` (403/404).

**BA task** (`commands/spec-card.ts`):
- `buildSpecCardTask`: when `card.needs_split?.state === 'with_ba'`, add `needsSplit` (proposal, round, the design's
  `investigation.reportPath` + `summary`, `scopingRepos` names, the card's repository name). `missing` stays `[]`.
- `applySpecCardReport`: derive the mode from the card (as `scoping` is), with no new `ba_tasks` column:
  `const splitMode = card.needs_split?.state === 'with_ba'`. Check this **before** the `!scoping && data.split` refusal:
  - `splitMode && !data.split` → refuse: "`<REF>` was returned to be split: report a split of 2 to 8 cards, or report
    that it cannot be split".
  - `splitMode && data.split` → `applySplit(...)`. On success, also append
    `CardNeedsSplitResolved{outcome:'split', childCardIds}` (inside the same savepoint; the ids are already in `made`).
  - `spec-card-fail` in split mode: append `CardNeedsSplitResolved{outcome:'ba_failed', note}` plus the owner item
    (`needsSplitDecisionEvents`, reason `ba_failed`) **instead of** `needsSpecifyingItem`.
- `runSpecCardFallback` in split mode: the owner item with reason `no_ba` instead of the `spec_needed` alert.
- `applySplit`'s cancel note says "one per repository or section". In split mode, say "one per seam of the needs-split".

**Dispatcher** (`dispatcher/ba-tasks.ts`): for a `spec_card` task whose card has `needs_split.state = 'with_ba'`, skip
BAs whose `runner_version` is below `MIN_RUNNER_FOR_NEEDS_SPLIT` (same place as the scoping gate, line ~171). The role
stays `'ba'`: the card has a repository, so `scopingPlan` does not apply.

**Card detail** (`queries/cards.ts`): map `needs_split` into `needsSplit` (safe-parse with the stored schema; null when
absent or unparsable). Set `needsSplitTaken` from `needsSplitTaken()`. `splitLinks` needs no change.

### 5.4 Web

- `apps/web/src/components/NeedsSplitPanel.tsx` (new), on `CardDetail` above `<SplitLinks>` (`CardDetail.tsx:487`),
  shown when `data.needsSplit` is set:
  - Heading "Needs split" with a state badge: "With the BA to split" / "Waiting for the owner" / "Split" / "Kept as
    one card" / "Cancelled". Then the reason text and the estimate ("1 400 changed lines, budget 400").
  - **Folder scope**: the folders as wrapping chips (`font-mono`, `break-all`, so long paths never overflow a phone
    screen).
  - **Proposed seams**: a numbered list, one block per seam: title, repository (if not the card's), folders as chips,
    note.
  - When the state is `owner`, a link "Decide on your desk" to the desk item. When it is `split`, a pointer to the
    "Split into" list below.
  - Touch (standing order "design"): read-only, so no text input and no soft keyboard. Stack everything vertically,
    give links and buttons at least 44 px tap height, and use no hover-only content.
  - `data-testid="needs-split-panel"`, `needs-split-folder`, `needs-split-seam`.
- `apps/web/src/pages/Desk.tsx` `DeskItem`: for `item.subkind === 'needs_split_decision'`, render a compact
  `NeedsSplitSummary` (reason, folder scope chips, seam titles) above the standard question options. Reuse the same
  presentational pieces as the panel.
- Optional, if cheap: a "Needs split" chip on the board card when `needsSplit.state === 'with_ba'`. Not required by an AC.

### 5.5 Docs

- `docs/USER-GUIDE.md` §4.26 (lean team workflow): a **Needs split** paragraph. An over-budget card goes back to the BA
  once, with the architect's folder scope and seams. The BA creates 2 to 8 linked cards and the original shows "Split
  into". A second over-budget verdict (also on a card split out of one) lands on your desk with Keep as one card / Send
  to the BA anyway / Cancel. No BA, or a BA that cannot split, also lands on your desk. It needs runner
  `MIN_RUNNER_FOR_NEEDS_SPLIT` on the BA's workstation. Add a line in §4.20 (architect) pointing to it.
- `docs/ARCHITECTURE.md`: a new §45 "Needs-split transition": the events, the columns, `requestNeedsSplitIn` and
  `needsSplitTaken` (inheritance), the reuse of `spec_card`/`applySplit`, the owner item and its options, the runner
  gate, and the GWP-207 contract (4.2). Add one sentence at the end of the repository-scoping paragraph (~line 1345):
  "The same split also serves the needs-split mode (§45)."

## 6. Acceptance criteria → design → tests

| AC | Design | Test |
|---|---|---|
| AC1 first over-budget + confirmed → to the BA with folder scope and seams visible | `POST /api/cards/:id/needs-split` → `requestNeedsSplitIn` (route `ba`) → `CardNeedsSplitRequested` + move to `spec`/draft + `spec_card` task; `CardDetail.needsSplit` (folder scope, seams); `SpecCardTask.needsSplit` in the BA brief; thread note | `apps/server/test/needs-split.test.ts` "first needs-split sends the card to the BA with the folder scope and seams": a card at `investigate` → 200, `needsSplitRoute 'ba'`, stage `spec`, status `draft`, `needs_split_count 1`, one queued `spec_card` task, detail `needsSplit.proposal.folderScope/seams`, dispatched `shift.start` has `baTask.specCard.needsSplit` with the same seams (runner at `MIN_RUNNER_FOR_NEEDS_SPLIT`). Refusals: build handoff → 409 `needs_split_too_late`; a file path in the scope → 400; a non-manager → 403 |
| AC2 BA creates child cards → linked to the parent | The split-mode report goes through `applySplit`; children get `parent_card_id`; parent `CardCancelled{cause:'split'}` + `CardNeedsSplitResolved{split, childCardIds}`; `splitInto`/`splitFrom` | same file, "the BA's split creates children linked to the parent": report `{split:[2 children]}` → both children exist with `parent_card_id`, parent cancelled, parent detail `splitInto` lists both and `needsSplit.state 'split'`, each child detail `splitFrom` = parent. Also: a fields-only report is refused with the "returned to be split" error |
| AC3 already took the route + over budget again → owner's desk, not the BA | `needsSplitTaken` (own count, or inherited from the parent's `childCardIds`) → `needsSplitRoute` → `QuestionRaised{subkind:'needs_split_decision', chainLevel:'desk'}`; no task, no move | same file, "a second over-budget goes to the owner's desk": card with `needs_split_count 1` (send it once, BA `spec-card-fail` → owner `continue` → card back at `investigate`), request again → `needsSplitRoute 'owner'`, an open `needs_split_decision` item, still one `spec_card` task in total, stage unchanged. And "a child of a needs-split split goes to the owner": request on a child → `owner`, reason `inherited` |
| Owner options | `needsSplitAnswered` | same file: `continue` resolves and unblocks; `ba_again` queues a task (count 2); `cancel` cancels |
| Regression: repository scoping split unchanged | `scoping` path untouched; split mode derived only from `needs_split.state` | run `apps/server/test/repo-scoping.test.ts`, `spec-card-dropped.test.ts`, `ba-tasks.test.ts` unchanged |
| Pure rules | `NeedsSplitProposalSchema`, `needsSplitRoute`, `renderNeedsSplitJob` | `packages/shared/test/needs-split.test.ts`: folder normalising (`./a/b/` → `a/b`); `a/b.ts`, `/a`, `a/../b`, `a/*` refused; `.github/workflows` accepted; 1 seam refused, 9 refused; duplicate folders refused; `needsSplitRoute` table (taken/force/hasBa); the rendered prompt contains every folder and seam title and asks for `split` |
| Web | `NeedsSplitPanel`, desk summary | `apps/web/src/test/needs-split-panel.test.tsx`: renders the folder chips and seams for `with_ba`, the desk link for `owner`, nothing when `needsSplit` is null |

Template for the server test: `apps/server/test/repo-scoping.test.ts` (`createWorld`, `connectRunner`, `baTaskPass`,
`r.report(... 'spec_card_done' ...)`, `runner_version` set to the minimum). The server suite needs Postgres 5433, so
name it in the handoff for the testers.

## 7. Risks and traps

- **Runner gate.** The needs-split prompt is rendered on the runner. Until the BA's workstation runs
  `MIN_RUNNER_FOR_NEEDS_SPLIT`, the task waits. After `BA_TASK_STALL_MS` it falls back to the owner item (`no_ba`).
  That is acceptable, and the user guide says so.
- **State names vs GWP-209.** The card side uses `CardNeedsSplitRequested`/`Resolved`, `cards.needs_split*` and the
  desk subkind `needs_split_decision`. GWP-209 (PR side) should use PR-scoped names (for example `pr_needs_split`), never
  these.
- **Do not build the verdict or the question.** GWP-207 computes the over-budget verdict and raises the architect's
  question, and its answer handler calls `requestNeedsSplitIn`. This card has no size logic at all.
- **`applySpecCardReport` order.** The split-mode branch must come before the existing `!scoping && data.split` refusal,
  or every needs-split report is refused.
- **Event before move.** Append `CardNeedsSplitRequested` before the move and the `BaTaskQueued`, so the dispatcher
  and `buildSpecCardTask` see `state 'with_ba'`.
- **`moveCardIn` extraction.** This is a pure refactor of `moveCardWithNotice`. Its callers (route, CEO act, tests) must
  behave exactly as before. Run the existing move tests.
- **Parent branch.** The parent's design report stays on its unmerged branch when it is cancelled. The children get
  their own design. The report path and summary travel in the BA task, so the BA can quote them in the children's
  context.
- **Blocking a draft.** The owner item is non-blocking when the card is already `draft` in `spec` (`ba_failed`), so the
  blocker projection does not flip a draft to `blocked`.
- **Inheritance (B1)** is a design choice that follows "one return only". If the owner wants children to get their own
  BA return, drop the parent check in `needsSplitTaken`. Nothing else changes.
- **Migration number.** Take the next free number on main when you build, and check again after a merge of main.
