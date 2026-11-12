# GWP-207: Architect size estimate and size verdict at design time; needs-split question only over budget

> Revised after GWP-205 and GWP-208 landed (main at `303cd397`). Assumptions 1 and 2 held. Assumption 3 held only in
> part: the transition can be called, but the proposal shape, the subkind and the routing differ. Assumption 4 did not
> hold: GWP-206 has not landed. Section 7 lists what changed. Sections 4.1 to 4.4 and 5 to 6 are updated to match.

## 1. Question

At the design handoff (`aom design`) the architect records a size estimate in the project's size unit, and the
server records the derived risk class in the existing design report. The server then gives a size verdict against
the project's budget: `within budget`, `over budget`, or no verdict with the card line `no size budget set`. Only an
over-budget verdict raises the needs-split question. The architect asks it, Johnny (the CEO) holds it first, then it
goes to the owner. Its "split" answer calls GWP-208's transition. High risk alone never raises it (GWP-206 sends that
case to the design gate once it lands).

## 2. Findings

### 2.1 PRD v22 (doc 61871304) and the F5 sub-items

The vault copy (`projects/gwp/docs/review-gates-reviewer-workflow.md`, v22) holds only sections 1-11 and the v22
edit instructions. It has **no F5 table**. The instruction "Rewrite F1.2, F1.3, F4.3, F5.2, F6.2 and F6.3 so each
separate behaviour becomes its own numbered sub-item" is there, but the sub-items themselves are not. The GWP-205,
GWP-206 and GWP-208 designs found the same gap. The ACs are therefore mapped to the PRD text that exists:

| PRD v22 / boardroom source | AC |
|---|---|
| §5 "Architect: Estimates size at design time ..."; §4 "No new plan artifact. The existing design report is the baseline."; boardroom "derive risk from a per-project path-to-risk map", "the declaration only able to raise it" | AC1 |
| §5 "... and raises the needs-split question"; boardroom "Johnny needs the approval yes, but the question should be raised by the architect"; "fires only when estimated size exceeds the project budget" | AC2 |
| boardroom "high risk alone goes to the design gate, not back to the BA" | AC3 |
| §4 "No default budgets or risk maps"; decision log "Budget and risk map set per project, no defaults" | AC4 |

### 2.2 The design handoff today

- **Runner** `apps/runner/src/aom/aom-cli.ts:749` `investigationReport()` builds the `investigation` outcome data
  `{ reportPath, summary, location, assumptions?, noAssumptions?, review? }`. `DESIGN_USAGE_EXTRA` is at `:744`.
- **Schema** `packages/shared/src/protocol/ipc.ts:100` `InvestigationDataSchema`. The runner's `prepareInvestigation`
  spreads `...data`, so new optional fields reach the server without runner changes beyond the CLI.
- **Server** `apps/server/src/commands/shifts.ts` (`case 'StageCompleted'`, `outcome.data === 'investigation'`,
  around lines 570-690). It validates the report and pushes `InvestigationReported` plus a thread comment into
  `followUps`. For an early design it sets `holdDesign` and emits `DesignHeld`. Otherwise it emits `StageCompleted`.
  The whole handoff runs in one transaction `tx`. The events are appended in this order (`shifts.ts:755-785`):
  `HandoffWritten`, then `main`/`mains` (none when `main` is undefined), then `followUps`, then `ClaimReleased`,
  then `after`.
- **Projection** `apps/server/src/projections/cards.ts:378` `InvestigationReported` rewrites `cards.investigation`
  (jsonb) and keeps the earlier `assumptions`.
- **Card DTO** `apps/server/src/queries/cards.ts` `investigationDto()` becomes `CardDto.investigation`. **Web**
  `apps/web/src/components/InvestigationPanel.tsx` shows the "Design report" panel on the card.
- **Architect brief** `packages/shared/src/prompt/shift-prompt.ts` `investigationContext()` reads
  `ShiftBrief.investigation`, which the server fills in `runner-gateway/brief.ts` `investigationBrief()`.

### 2.3 Risk and size today (do not touch)

- `cardSize(card)` in `commands/stop-loss.ts` is the **stop-loss** budget class, not a size verdict. Do not reuse the
  name.
- `riskTier` (runner diffstat) and `cards.high_risk` / `high_risk_paths` (build handoff, `HIGH_RISK_RULES`) are
  build-time and stay unchanged.

### 2.4 Question machinery that fits

- `QuestionRaised` carries `askedBy` (an agent), `subkind`, `data`, `blocking`, `routedTo/routedAgentId`,
  `chainLevel`, `triage` (the CEO hold) and `topic`. A blocking question with `cardId` parks the card as `blocked`.
- `stopLossEvents` / `stopLossRoute` (`commands/stop-loss.ts`) is the template for a question the server raises:
  the CEO hold if the CEO is active and reachable, else the owner's desk.
- Option-specific answer actions run in both answer paths: `answerDeskItem` (`commands/desk.ts:250-261`, which
  already calls `testerLoopAnswered` and GWP-208's `needsSplitAnswered`), and the CEO `desk.answer_question` action
  (`ceo/actions.ts:248-260`, which has a `withAppendTx` branch for the tester loop that builds
  `{ user: env.owner, actor: userActor(env.owner.id) }`).
- `ClaimReleased` sets `queued` only when the status is `claimed`. A blocking question appended after it leaves the
  card `blocked`.

### 2.5 What landed (checked in the worktree)

**GWP-205**, in `packages/shared/src/projects/review-settings.ts`:
- `SizeUnitSchema` (`changed_lines | changed_files`) and `SIZE_UNIT_LABELS`.
- `RiskClassSchema = ReviewRisk`, `RiskClass` and `RISK_ORDER`.
- `ReviewSettings { sizeBudget, sizeUnit, riskMap }`, every field nullable, with no defaults.
- `REVIEW_SETTING_MISSING`: `sizeBudget 'inactive: no size budget set'`, `sizeUnit 'inactive: no size unit set'`,
  `riskMap 'inactive: no path-to-risk map set'`.
- `sizeChecksStatus()` needs a budget **and** a unit. `riskFromPathsStatus()` needs a non-empty map.
- `riskFromPaths({ paths, riskMap, declared })` returns `{ state:'inactive', reason }` when there is no map. It
  does **not** fall back to the declared class. Otherwise it returns
  `{ state:'active', derived, declared, final, raisedByDeclaration, matches }`.
- `riskPatternMatches(pattern, path)`: a bare pattern matches itself and everything below it.
- The columns are `projects.size_budget / size_unit / risk_map` (migration `2900_project_review_settings.sql`).

There is **no** `loadReviewSettings`. The server reads the settings with `reviewSettingsOf(projectRow)` in
`apps/server/src/queries/misc.ts:87`, which returns `{ sizeBudget, sizeUnit, riskMap, status }`. Budget and unit
can each be set without the other.

**GWP-208**, in `packages/shared/src/cards/needs-split.ts` and `apps/server/src/commands/needs-split.ts`. Its design
(§4.2) is the contract for this card:
- **Transition** `requestNeedsSplitIn(ctx, tx, card, proposal, by: NeedsSplitBy, opts?)` runs in the caller's
  transaction and **appends its own events** (it does not return them). It works like this:
  - it locks the card and calls `needsSplitRefusal` first, which **throws** `conflict` when the card is closed,
    already built, already with the BA, or has an open `needs_split_decision` item;
  - it reads `needsSplitTaken` (`cards.needs_split_count > 0`, or the card was split out of one that took the route);
  - `needsSplitRoute` then gives `ba` the first time, or `owner` when the route was taken or no BA is hired;
  - on the BA route: `CardNeedsSplitRequested`, then a move to the first stage as a draft (`moveCardIn`), then a
    `spec_card` task. On the owner route: a pinned owner desk item `needs_split_decision` (`askedBy` system), and the
    card does not move.
- `NeedsSplitBy = { actor, user: AuthSession['user'], name }`. `moveCardIn` needs a real user. For an agent or CEO
  caller, GWP-208 uses the card owner (`splitOwner` in `commands/spec-card.ts:419`, not exported).
- **Proposal** `NeedsSplitProposalSchema` (strict):
  ```ts
  { reason: string(1..2000),
    folderScope: NeedsSplitFolder[1..50] /* unique folders only: no files, no globs, no leading /, no .. */,
    seams: Array<{ title: string(1..200), folders: NeedsSplitFolder[1..20], repo?: string, note?: string }>[2..8],
    estimate?: { size: int>=0, budget: int>=1, unit: string } }
  ```
  `StoredNeedsSplitProposalSchema` is the lenient form of the same shape.
- **Marker**: the `cards.needs_split` record (`state`: `with_ba | owner | split | continued | cancelled | dropped`)
  plus `needs_split_count`. The contract says GWP-207 **must not ask again when `needs_split.state = 'continued'`**,
  because the owner has accepted the size.
- **Names already taken**: the subkind `NEEDS_SPLIT_DESK_SUBKIND = 'needs_split_decision'` (the owner's decision,
  `ROUTING_EXEMPT_SUBKINDS`, never held by the CEO) and the server function `needsSplitAnswered` (its answer
  handler, already called in `desk.ts:257`).
- There is no "Johnny first" routing in GWP-208. Johnny's approval belongs to the question this card raises.

**GWP-206 has not landed.** `pathsInText`, `designGateDecision` and `design_gate` are not in the worktree, and
GWP-206 is waiting in finalize. If it lands before this card is built, use its functions (see 7.4).

## 3. Options

### A. Where the estimate and risk class are stored

| Option | For | Against |
|---|---|---|
| A1: new fields on `InvestigationReported` | One event | `confirm` emits no `InvestigationReported`, so the verdict could not be computed again on release. It mixes the computed verdict into the report event. |
| **A2: a new small event `DesignSized` on every design handoff (`design`, `revise`, `confirm`), projected into `cards.investigation.sizing`** | Same record (the design report JSON), no new artifact, works for the assumption review | One more event and projector |
| A3: new `cards` columns | Queryable | A migration for data that only the card view reads |

**Choice: A2.**

### B. Where the card waits while the needs-split question is open

| Option | For | Against |
|---|---|---|
| B1: `StageCompleted` to build, then also block | The default unblock goes on to Build | An answer of "split" would then have to pull the card back out of Build. GWP-208 refuses once a build handoff exists, and so would race the builder. |
| **B2: the card stays in `investigate` with no `StageCompleted`, blocked by the question. The answer performs the choice: split (`requestNeedsSplitIn`) or build as designed (complete the design stage now)** | The design is not handed on while the split question is open. GWP-208's transition moves the card from `investigate` to the first stage, which is its tested path. | Needs an answer handler |

**Choice: B2.**

### C. Who is asked, and when (changed by GWP-208)

| Case | Action at the design handoff |
|---|---|
| over budget, `needs_split.state = 'continued'` (the owner kept the card whole) | Raise nothing. Complete the design stage (GWP-208 contract). |
| over budget, `needsSplitTaken` (already went to the BA once, or inherited) | Raise no architect question. Call `requestNeedsSplitIn` directly, which raises GWP-208's owner item `needs_split_decision` ("after that the owner decides"). The card stays in Design, blocked. |
| over budget, first time | Raise the architect's question (`askedBy` the architect). Johnny's CEO hold if active, else the owner's desk. o1 "split" calls `requestNeedsSplitIn`; o2 "build as designed" completes the design stage. |
| within budget, or no verdict | As today: `StageCompleted` (later, GWP-206's gate decides). |

In the second case the owner's question comes from GWP-208's code, but the architect is the actor on
`CardNeedsSplitRequested` and the thread note names the architect. Raising an architect question there as well
would ask the owner the same thing twice, because GWP-208's "split" answer would raise its own owner item.

### D. Which paths the risk class is derived from

There is no diff at design time. The architect names the folders and files the change will touch (`--path`,
repeatable). The server takes the **union** of these and the path tokens of the card's Affected areas, and passes it
to `riskFromPaths`. A declared risk (`--risk`) may only raise the class. The folder scope for GWP-208 is derived from
the same paths (a file becomes its folder), because GWP-208 accepts folders only.

## 4. Recommendation and design

### 4.1 Shared: verdict and sizing (new file `packages/shared/src/projects/size-verdict.ts`, export from `projects/index.ts`)

```ts
import {
  REVIEW_SETTING_MISSING, riskFromPaths, SIZE_UNIT_LABELS,
  type ReviewSettings, type RiskClass, type SizeUnit,
} from './review-settings.ts';
import { NeedsSplitFolderSchema, type StoredNeedsSplitProposal } from '../cards/needs-split.ts';

export type SizeVerdict = 'within_budget' | 'over_budget';
/** The card line when the project has no budget (AC4). */
export const NO_SIZE_BUDGET = 'no size budget set';
export const NO_SIZE_UNIT = 'no size unit set';
export const SIZE_VERDICT_TEXT: Record<SizeVerdict, string> = { within_budget: 'within budget', over_budget: 'over budget' };

/** Pure. Over when estimate > budget, equal is within. No verdict (null) when the budget or the unit is missing. */
export function sizeVerdict(
  estimate: number | null | undefined,
  s: Pick<ReviewSettings, 'sizeBudget' | 'sizeUnit'> | null | undefined,
): { verdict: SizeVerdict | null; text: string };
// budget null -> { null, NO_SIZE_BUDGET } (checked first); unit null -> { null, NO_SIZE_UNIT };
// estimate null -> { null, 'no size estimate' }

type Seam = StoredNeedsSplitProposal['seams'][number];   // { title, folders, repo?, note? }

export interface DesignSizing {
  estimate: number | null;
  unit: SizeUnit | null;
  budget: number | null;
  verdict: SizeVerdict | null;
  verdictText: string;
  risk: {
    class: RiskClass | null;            // riskFromPaths().final; null when inactive
    derived: RiskClass | null;
    declared: RiskClass | null;
    raisedByDeclaration: boolean;
    status: string | null;              // REVIEW_SETTING_MISSING.riskMap when there is no map, else null
    matches: Array<{ path: string; pattern: string; risk: RiskClass }>;  // <= 50
  };
  paths: string[];                      // what the architect named (--path), normalised
  folderScope: string[];                // folderScopeOf(paths): the folder scope for GWP-208
  seams: Seam[];                        // proposed split seams (--seam), GWP-208's seam shape
}

export function designSizing(i: {
  settings: Pick<ReviewSettings, 'sizeBudget' | 'sizeUnit' | 'riskMap'> | null;
  estimate?: number | null;
  paths: readonly string[];
  affectedAreaPaths: readonly string[];
  declaredRisk?: RiskClass | null;
  seams?: readonly Seam[];
}): DesignSizing;

/** A file becomes its folder; folders stay as they are; anything that still fails NeedsSplitFolderSchema is dropped; unique; <= 50. */
export function folderScopeOf(paths: readonly string[]): string[];

/** Path-like tokens in free text (Affected areas): `a/b`, `a/b/c.ts`; no URLs. Keep it minimal; GWP-206 reuses it. */
export function pathsInText(text: string): string[];

/** One plain line for the thread and the brief. */
export function sizingLine(s: DesignSizing): string;

/** GWP-208's proposal from the sizing; reason is generated, estimate carries the unit label. */
export function needsSplitProposalFrom(s: DesignSizing, summary: string): StoredNeedsSplitProposal;
// reason: `Estimated ${estimate} ${label} at design, over the project's size budget of ${budget}. ${summary}` clipped to 2000
```

- A test asserts `REVIEW_SETTING_MISSING.sizeBudget.endsWith(NO_SIZE_BUDGET)`, so the two strings cannot drift apart.
- `designSizing` calls `riskFromPaths({ paths: union(paths, affectedAreaPaths), riskMap, declared })`. When the result
  is inactive, `class` and `derived` are null, `declared` keeps the declared value and `status` gives the reason.
  GWP-205's rule is that a declaration does not stand in for a missing map.
- Trap: a bare folder such as `apps/server` does **not** match a narrower pattern such as `apps/server/src/auth/**`.
  The brief line therefore asks for the most specific folders or files. Do not change `riskFromPaths`.
- Do not name anything `cardSize`/`CardSize`.

### 4.2 Shared: protocol, events, subkind

- `protocol/ipc.ts` `InvestigationDataSchema`: add an optional
  ```ts
  size: z.object({
    estimate: z.number().int().min(0).max(10_000_000),
    paths: z.array(z.string().min(1).max(300)).max(100).default([]),
    risk: ReviewRisk.optional(),
    seams: z.array(StoredNeedsSplitProposalSchema.shape.seams.element).max(NEEDS_SPLIT_MAX_SEAMS).default([]),
  }).optional(),
  ```
  Keep it lenient here. The server validates the seams with `NeedsSplitSeamSchema` when they are needed (4.4 b5).
- `events/card.ts`: new event `DesignSized { cardId, sizing }`, lenient (plain strings and numbers, nullable
  strings, no refinements).
- `cards/needs-split.ts`: add `NEEDS_SPLIT_QUESTION_SUBKIND = 'needs_split_question'` and
  `NEEDS_SPLIT_QUESTION_OPTIONS = { split: 'split', build: 'build' } as const`. Do **not** reuse
  `needs_split_decision`: that subkind is the owner's decision, exempt from CEO routing, with a different handler.
  Do **not** add it to `ROUTING_EXEMPT_SUBKINDS`, because Johnny holds it first.
- `protocol/runner.ts` `ShiftBrief.investigation`: add an optional
  `sizing: { unit: string|null, budget: number|null, riskMapSet: boolean, sizeStatus: string|null, riskStatus: string|null }`.
- `api/cards.ts` `CardDto.investigation`: add `sizing` (optional, nullable, the DesignSizing shape, lenient).

### 4.3 Runner: `apps/runner/src/aom/aom-cli.ts` `investigationReport()`

New flags for `aom design` and `aom design revise` (not for `investigate` or `confirm`):

```
--size <n>                                       estimate in the project's size unit (whole number)
--path "<folder or file>"                        repeatable: what the change touches
--risk low|medium|high                           optional declared risk (may only raise the class)
--seam "<title>: <folder>[, <folder>...]"        repeatable: a proposed split seam and the folders it covers
```

- `--size` must be a non-negative integer, else `UsageError`.
- `--seam` is split at the **first** `": "`: the title on the left, the folders on the right, separated by commas and
  trimmed. A seam without `": "` or with no folder is a `UsageError` naming the expected form. An optional
  `[repo]` prefix on the title (`--seam "[web] Card panel: apps/web/src/components"`) sets `repo`.
- Send `size: { estimate, paths, risk?, seams }` only when `--size` or `--path` is given. Use the existing
  `many()`/`one()` helpers. Add the flags to `DESIGN_USAGE_EXTRA`. Do not change `commandForOutcome`.

### 4.4 Server

**a) Brief** (`runner-gateway/brief.ts` `investigationBrief`): `reviewSettingsOf(project)` (`queries/misc.ts`) gives
`investigation.sizing`. `sizeStatus` is `status.size.reason` when inactive, `riskStatus` is `status.risk.reason`. Add
`size_budget, size_unit, risk_map` to the project select if they are not already in it.

**b) Design handoff** in a new module `apps/server/src/commands/design-size.ts`, with only a few lines in
`shifts.ts`, inside `if (outcome.data === 'investigation')` for a card that is not investigation-only:

```ts
export async function designSizeStep(tx, card, project, inv: InvestigationData, mode: 'design'|'revise'|'confirm'):
  Promise<{ error?: string; sizing?: DesignSizing }>
```

1. `settings = reviewSettingsOf(project)`. `required = settings.sizeUnit != null`. Budget and unit are independent
   in GWP-205, and an estimate is needed whenever there is a unit to measure it in.
2. `confirm`: take the stored `card.investigation.sizing` (estimate, paths, risk, seams) and compute it again against
   the **current** settings. If nothing is stored and `required` is true, refuse:
   "this project measures size in <label>: re-run as `aom design revise ... --size <n> --path ...`".
3. `design | revise`: if `required` and (`inv.size` is missing or `inv.size.paths` is empty), refuse:
   `` this project measures size in <label> with a budget of <budget|'no budget'>: add --size <n> (your estimate in <label>) and at least one --path "<folder or file>" the change touches ``.
4. `sizing = designSizing({ settings, estimate, paths, affectedAreaPaths: pathsInText(card.fields?.affectedAreas ?? ''), declaredRisk, seams })`.
5. Over budget and `needs_split.state !== 'continued'`: validate
   `NeedsSplitProposalSchema.safeParse(needsSplitProposalFrom(sizing, inv.summary))`. On failure, refuse with the
   first issue and the hint:
   `` the estimate <n> <label> is over the budget <budget>: name at least 2 split seams with --seam "<title>: <folder>, <folder>" and the folders with --path, so the card can be split ``.
   The architect fixes this and reports again in the same shift.
6. Return the sizing. `shifts.ts` pushes `DesignSized { cardId, sizing }` into `followUps` **after**
   `InvestigationReported`, because that projector rewrites the JSON.

**Stage decision in `shifts.ts`** (`split = splitDecision(card, sizing)`, a pure helper in `design-size.ts` that
returns `'none' | 'continued' | 'owner' | 'ask'`):
- `holdDesign` (early design): keep `DesignHeld`, raise nothing, and add the size line to the thread comment.
- Over budget and `needs_split.state === 'continued'`: `StageCompleted` as usual, with a thread line "Over budget;
  the owner kept the card as one card."
- Over budget, not held, and not continued: **no `StageCompleted`** (`main` stays undefined). `acceptMessage`:
  "Recorded. The estimate is over the project's size budget: the needs-split question is raised in your name. Finish now."
  Then:
  - not taken: push `needsSplitQuestionEvents(...)` into `after` (it follows `ClaimReleased`, so the card ends
    `blocked`);
  - taken (`needsSplitTaken(tx, card).taken`): **after** `ctx.store.append(...)` in the same `tx`, call
    `requestNeedsSplitIn(ctx, tx, card, proposal, { actor: agent actor, user: card owner, name: agent name },
    { fromStage: card.stage })`. Export `splitOwner` from `spec-card.ts` (or move it to `common.ts`) for the user.
    Call `needsSplitRefusal(tx, card)` first. If it refuses (for example an owner item is already open), raise
    nothing and add the refusal message to the thread, so the handoff is never rolled back by a `conflict` thrown
    after the append.
- Otherwise: `StageCompleted` as today. A within-budget high-risk card goes on unchanged (AC3). When GWP-206 lands,
  its gate decision runs in this branch.
- Thread comment: append `sizingLine(sizing)` to the existing "Investigation report ..." message, for example
  `Size: 640 changed lines, over budget (budget 400). Risk class: high (derived from the path-to-risk map).`

**c) The architect's question** `needsSplitQuestionEvents(ctx, tx, card, agent, sizing, proposal)` in `design-size.ts`:

```ts
{ type: 'QuestionRaised', payload: {
    deskItemId, cardId: card.id, projectId: card.project_id, shiftId: shift.id,
    askedBy: { kind: 'agent', agentId: agent.id },          // raised by the architect (AC2)
    doing: `${card.ref} design: size estimate over the project budget`,
    question: `${card.ref} is estimated at ${estimate} ${label}, over the project's size budget of ${budget}. Split it (back to the BA once, along the seams below) or build it as designed?\n\n${needsSplitProposalLines(proposal).join('\n')}`,
    options: [{ id: 'split', label: 'Split: send the card back to the BA with the folder scope and split seams' },
              { id: 'build', label: 'Build it as designed (over budget)' }],
    recommendation: 'split', blocking: true, pinned: true, topic: 'design',
    subkind: NEEDS_SPLIT_QUESTION_SUBKIND,
    data: { sizing, proposal, fromStage: card.stage },
    routedTo, routedAgentId?, chainLevel, triage?,           // needsSplitQuestionRoute
    affectedCardIds: [card.id], dedupLedgerIds: [] } }
```

- `needsSplitQuestionRoute(ctx, tx, card)` works like `stopLossRoute` without calling it. If the CEO (Johnny) is
  active and reachable and the project is not paused, it uses the CEO hold
  (`triage: { deadline: now + CEO_STOP_LOSS_HOLD_MINUTES }`). Otherwise it uses the owner's desk. The "second time
  goes to the owner" case does not reach this function: it is GWP-208's owner route (case C).
- Never raise a second open `needs_split_question` for the same card (check `status='open'` first).
- Thread message: "Needs-split question raised by <architect>: <route note>."

**d) Answer handler** `needsSplitQuestionAnswered(ctx, tx, item, optionId, answer, by: NeedsSplitBy)` in
`design-size.ts`. **Do not name it `needsSplitAnswered`**, because GWP-208 already uses that name. Call it in
`commands/desk.ts` `answerDeskItem` right after GWP-208's `needsSplitAnswered` (same `by`). In `ceo/actions.ts`, add
a `withAppendTx` branch like the tester-loop one, with
`by = { user: env.owner, actor: userActor(env.owner.id), name: <CEO agent name> }`.

- Return early unless `item.subkind === NEEDS_SPLIT_QUESTION_SUBKIND`. If the card is done or cancelled, or no longer
  in `investigate*`, post a thread note that the answer was not carried out and stop.
- `split`: `requestNeedsSplitIn(ctx, tx, card, item.data.proposal, by, { fromStage: item.data.fromStage })`. GWP-208
  decides the route: BA, or the owner when no BA is hired. Catch its `conflict` and post the message as a thread note
  instead of failing the answer. The question is already answered and the card stays queued in Design, so the
  architect looks again.
- `build`, or a text answer with no option: `designCompletionEvents(ctx, tx, card)`, a helper extracted from
  `shifts.ts`. It resolves `toStage` with `resolveOutcome(wf, workflowView(card), card.stage, 'handoff')` and returns
  `StageCompleted { fromStage, toStage, outcome: 'handoff' }`. GWP-206 later adds its gate decision here. Also post
  the thread note "<who> keeps <REF> as one card over budget: on to Build."
- A dismissed item runs no handler. The card goes back to the design queue and the architect looks again. Document
  this.
- CEO desk mode follows `deskMode(policy, 'question', 'needs_split_question')`. With the default (recommend), Johnny
  recommends and the owner decides. Do not add the subkind to `LOOP_RELEASE_SUBKINDS`.

**e) Projection** (`projections/cards.ts`): `DesignSized` runs
`UPDATE cards SET investigation = jsonb_set(COALESCE(investigation,'{}'::jsonb), '{sizing}', $2::jsonb), updated_at=$3 WHERE id=$1`.
`InvestigationReported` keeps the earlier `sizing` the way it keeps `assumptions`. Add `DesignSized` to the card
projector list and the rebuild set.

**f) DTO** (`queries/cards.ts` `investigationDto`): pass `sizing` through (null when it is absent). One optional
"Size: ..." line in `card-facts`.

### 4.5 Agent instructions (architect brief)

`shift-prompt.ts` `investigationContext()`: when `inv.sizing` is present, the stage is `investigate*` and the card
is not investigation-only, add **one** line:

- unit set: ``- Size: estimate this change in <label> and add `--size <n>` and `--path "<folder or file>"` (repeat; name the most specific folders or files) to `aom design`. The budget is <budget|'not set: no size budget set'>. Over budget, also name at least 2 split seams with `--seam "<title>: <folder>, <folder>"`: the needs-split question is then raised in your name. A declared `--risk low|medium|high` can only raise the risk class from the path-to-risk map. <riskStatus if inactive>``
- no unit: ``- Size: this project has no size unit or budget set (no size budget set): no size estimate is needed.``

Leave `roles/builtin.ts` and `prompt/commands.ts` unchanged, so no inline snapshot changes
(`packages/shared/test/prompt.test.ts`, `packages/shared/test/work-ref-prompts.test.ts`). If the role text does
change, list the exact snapshot path in the handoff.

### 4.6 Web

`apps/web/src/components/InvestigationPanel.tsx`: when `inv.sizing` is set, show a `<dl data-testid="design-sizing">`
(`grid-cols-1 sm:grid-cols-2`) with:
- Size estimate: `640 changed lines`, using `SIZE_UNIT_LABELS`.
- Size verdict: Badge `amber` "Over budget (budget 400)", Badge `green` "Within budget (budget 400)", or plain text
  with the exact string `no size budget set` (AC4).
- Risk class, with "raised by the architect's declaration" when that applies, or "None: inactive: no path-to-risk map set".
- Folder scope and split seams (title: folders).

The panel is read only and has no inputs, so it does not open the soft keyboard. The over-budget question and the
split itself already show in GWP-208's `NeedsSplitPanel` and on the desk.

### 4.7 Docs

- `apps/server/src/assistant/pack/topics/architect.md`: a short "Size estimate and verdict" paragraph covering the
  flags, the `--seam` form, and the rules (over budget raises the needs-split question; high risk alone leads to
  the design gate).
- `docs/design/architect-and-workflows.md`: a new section "3.6 Size estimate and size verdict at design time"
  covering the data, the verdict rule, held and confirmed designs, the question, its answers, and the GWP-208
  hand-over.
- `docs/USER-GUIDE.md`: one paragraph next to the Review settings bullet.

## 5. Acceptance criteria mapping

| AC | Design | Test (new files) |
|---|---|---|
| AC1 the report holds the estimate (project unit) and the derived risk class | `aom design --size --path [--risk]`, then `InvestigationDataSchema.size`, then `designSizeStep`, then `DesignSized`, then `cards.investigation.sizing`, then the DTO and `InvestigationPanel` | `apps/server/test/design-size.test.ts`: stores the estimate and unit plus the class derived from the map; a lower declared risk does not lower the class; refused without `--size` when a unit is set. `apps/runner/test/aom-design-size.test.ts`: flag parsing, the `--seam` form, a bad `--size` is refused. |
| AC2 over budget: verdict 'over budget', question raised by the architect | `sizeVerdict` (>); no `StageCompleted`; `QuestionRaised { askedBy architect, subkind needs_split_question, data.proposal }`; card `blocked` in Design | `packages/shared/test/size-verdict.test.ts` (over, equal = within, under; `folderScopeOf`; `needsSplitProposalFrom` passes `NeedsSplitProposalSchema`). Server: an over-budget design gets one architect question, routed to the CEO hold or the desk, and the card stays in Design; fewer than 2 seams is refused; `split` moves the card to the first stage with a `spec_card` task (GWP-208); `build` completes Design to Build; a taken card gets GWP-208's `needs_split_decision` item and no architect question; `continued` raises nothing and goes to Build. |
| AC3 within budget: no question, whatever the risk | Normal `StageCompleted` | Shared test (within). Server: within budget with a high-risk path gives `within_budget`, no `needs_split_*` item, and Build. |
| AC4 no budget: no verdict, card shows 'no size budget set' | `sizeVerdict` gives `null` plus `NO_SIZE_BUDGET`; the panel renders it | Shared test (budget null; budget without unit). Server: no budget gives `verdict null`, `verdictText 'no size budget set'` and no question. `apps/web/src/test/design-sizing.test.tsx`. |

Regression tests:
- A held design records the sizing and raises no question. A `confirm` against a budget recomputes the verdict and
  raises the question when the estimate is over.
- `cards.high_risk` stays false after an over-budget design.
- GWP-208's `needsSplitAnswered` ignores `needs_split_question` items.

The server tests need Postgres 5433, so the testers run them and the builder lists them in the handoff. The shared,
runner and web tests run in the build shift.

## 6. Risks and traps

- **Event order:** `DesignSized` must follow `InvestigationReported`. The architect's `QuestionRaised` goes in
  `after`, and the taken-case `requestNeedsSplitIn` call comes after the append, so both follow `ClaimReleased`.
  Otherwise the card can end `queued` in Design.
- **`requestNeedsSplitIn` throws:** a `conflict` thrown inside the handoff transaction rolls back the whole handoff.
  Pre-check with `needsSplitRefusal`, and catch the throw in the answer handler.
- **Name clashes:** use the subkind `needs_split_question` (not `needs_split_decision`) and the handler
  `needsSplitQuestionAnswered` (not `needsSplitAnswered`).
- **One open question per card**, checked by hand: the repeat guard covers only agent `aom question` reports.
- **Owner keeps it whole after a second return:** GWP-208's `continue` re-queues the card in Design. The next design
  handoff sees `state = 'continued'` and goes on to Build without asking again.
- **Folder-only scope:** GWP-208 refuses files and globs. `folderScopeOf` turns files into their folders. The seams
  are validated with GWP-208's schema at the handoff, so the BA never gets a proposal it cannot use.
- **Older runners** do not know `--size`. If the architect's runner is older than the release that carries the
  flags, the refusal in 4.4 b3 would trap it. Gate the "required" rule on
  `runnerAtLeast(runnerVersion, MIN_RUNNER_FOR_DESIGN_SIZE)` (the same pattern as GWP-208's
  `MIN_RUNNER_FOR_NEEDS_SPLIT`) and set the constant to the runner version this change ships in.
- **Do not change:** stop-loss, `cards.high_risk`, `riskTier`, `HIGH_RISK_RULES`, `riskFromPaths`,
  GWP-208's routing rule.
- **Investigation-only cards** get no sizing and no verdict.

## 7. Assumptions about the dependencies (review after landing)

1. **Held.** GWP-205's names are as assumed. The server has no `loadReviewSettings`: use `reviewSettingsOf` from
   `queries/misc.ts`. Budget and unit are independent, so the estimate is required whenever a unit is set.
2. **Held.** `riskFromPaths` is inactive with no map and does not fall back to the declared class.
3. **Partly held, revised.** GWP-208 provides the callable transition `requestNeedsSplitIn`, the marker
   (`needs_split_count`, `needsSplitTaken`, the `needs_split` record) and the routing (BA once, then the owner).
   It differs in five ways:
   - (a) The proposal needs `reason`, a folder-only `folderScope`, and **2-8 structured seams**
     `{ title, folders }`. The `--seam` form, `DesignSizing.seams/folderScope`, `folderScopeOf`,
     `needsSplitProposalFrom` and the handoff validation follow from this.
   - (b) GWP-208 owns the second-time route (the owner item `needs_split_decision`), so this card calls the
     transition directly for a taken card instead of asking.
   - (c) The contract forbids asking again after `continued`.
   - (d) The names `needs_split_decision` and `needsSplitAnswered` are taken, so this card uses
     `needs_split_question` and `needsSplitQuestionAnswered`.
   - (e) The transition appends its own events and throws on refusal.
4. **Did not hold.** GWP-206 has not landed. This card adds a minimal `pathsInText` in `size-verdict.ts` and an
   extracted `designCompletionEvents` with no gate step. If GWP-206 lands before the build, use its `pathsInText`
   and call `designGateDecision` in the "otherwise" branch and in `designCompletionEvents`. Over budget still wins
   over the gate.

## 8. Out of scope

The hard CI size check and the exceptions (GWP-210, GWP-211). The BA split itself (GWP-208). The design gate
(GWP-206). Any change to the PR-only reviewer flow. The F5 sub-item wording (not in the vault copy of the PRD).
