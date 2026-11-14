# GWP-206 Design gate: optional owner gate after the design step, off by default

## 1. Question

Add an owner gate after Investigate & design in the lean `code` workflow:

1. Per project, the owner can switch it on. It is off by default.
2. It can only be switched on for a card once that card has a design report.
3. With the gate on, the card waits after the design hand-off until the owner approves (on to Build) or returns it (with a note).
4. A card whose derived risk is high goes to the design gate, not back to the BA, even when the gate is off.
5. The owner reviews the existing design report. There is no new artifact.

Constraints: do not add a skip guard (PRD 9, open item 2). The existing owner approval policy (large or high-risk cards / every card) keeps working, with a regression test.

## 2. Findings

### 2.1 The PRD and the F4 sub-items

The linked PRD is `projects/gwp/docs/review-gates-reviewer-workflow.md` (v22, document 61871304) in the project vault. The vault copy holds only the v22 change instructions: sections 1 to 11, plus edits to F1, F2, F1.5 and F6. **It does not contain the F4 table.** The instruction "rewrite F4.3 ... into sub-items" is there, but the sub-items themselves are not. So the F4 sub-items cannot be mapped one by one from the repository or the vault. Instead, the ACs below are mapped to the PRD text that is available:

| Source (PRD v22 / boardroom background) | AC |
|---|---|
| "a design gate after the design step ... off by default" | AC1 |
| "... can only be turned on once a design is in place" | AC2 (card switch needs a design report); the project switch also needs a design stage in the workflow (2.6) |
| §4 / §8 "No new plan artifact. The existing design report is the baseline." | AC3 (the desk item and card carry the existing report) |
| "the user is allowed to decide ... continue or return the card" | AC4 |
| "high risk alone goes to the design gate, not back to the BA"; "derive risk from a ... path-to-risk map" | AC5 |
| §9 item 2 "Design gate skips when in a hurry (parked, no guard yet)" | Constraint: no skip guard |

The ACs on the card stand as written. None needed changing.

### 2.2 Where "high risk goes back to the BA" lives (the planner's open question)

There is **no** BA route for high risk today. Checked in `apps/server/src/commands/shifts.ts`, `review-risk.ts` and `approval.ts`. High risk today is computed only at the **build** hand-off, from the diff paths (`leanHandoff`, `highRiskPaths`). It asks for a second Opus review (`ReviewApproved`, `required = 2`) and forces owner approval (`ownerApprovalDecision` → `high_risk`). The "back to the BA" route is the **future needs-split transition** (GWP-207 architect size verdict, GWP-208 needs-split to the BA). The boardroom line reads: "Architect's needs-split question fires only when estimated size exceeds the project budget; high risk alone goes to the design gate, not back to the BA."

So AC5 means: at the design hand-off, a card whose paths are high risk stops at the design gate. When GWP-207/208 land, their rule is **over budget → needs-split to the BA (wins); high risk only → design gate**. This card adds no BA route.

### 2.3 The workflow and how built-ins reach installs

- `packages/shared/src/workflows/builtin/code-v6.ts`: `investigate` (`when designNeeded`, `handoff` → `build`) → `build` → `pre_review` → `review` → `owner_approval` (`kind: 'human'`, `purpose: 'approval'`, `when ownerApproval`) → …
- `apps/server/src/catalogue/boot.ts` registers a built-in **only when its `(key, version)` is missing**. Editing `code-v6.ts` in place therefore **never reaches an existing install**: the stored v6 definition stays as it is, and cards are pinned to `workflow_version_id`. ARCHITECTURE.md §35 records the rollout rule: a new behaviour in the stage graph ships as a new version. New cards take the newest active version, and cards in flight keep theirs. `reviewApprovedPlan` uses `resolveWorkflow(..., {classic: true})`, which skips lean versions, so no in-flight card moves into v7.

### 2.4 The approval-step machinery is generic and reusable

`apps/server/src/commands/approval.ts` handles any `human` stage with `purpose: 'approval'`:
- `enterHumanStep` opens a desk item (`QuestionRaised`, subkind `approvalStep`, addressee = approver) plus `ApprovalRequested` and a thread message.
- `approveStep` / `sendBackStep` (the comment is required) resolve the `approve` / `send_back` outcomes, emit `ApprovalDecided` + `StageCompleted` (`rework: true` on send back), resolve the desk item and post the comment in the thread.
- `mayDecide` lets the approver, the project owner or an org Owner/Admin decide. `resolveApprover({kind:'project_owner'})` falls back to the org Owner.
- The web already renders it (`ApprovalPanel.tsx`, CardDetail, desk, "Waiting for my approval").

The owner approval stage is skipped or entered through a **derived** flag (`workflowView` → `ownerApproval: c.owner_approval_required`), which is decided by the server and stored on the card. The design gate can use exactly the same pattern.

### 2.5 The design report as the server holds it

`InvestigationReported` → `cards.investigation = { reportPath, location, summary, commit, body?, assumptions? }`. The runner (`apps/runner/src/shifts/supervisor.ts` `prepareInvestigation`) sends the report **text** only when there is no card branch yet (`body`, which the builder commits later). For the normal worktree case it sends only path and commit. The card branch is not pushed until the PR, so `inv.url` (a forge link) does not resolve during the gate. **Today the owner could read only the summary (≤ 2000 chars) and a path.** To meet AC3 in a real sense ("a desk item with the design report"), the runner should attach the text it already reads. This is the same report, not a new artifact.

### 2.6 Project settings pattern

`setOwnerApprovalPolicy` (`apps/server/src/commands/lean-project.ts`) → `ProjectOwnerApprovalSet` (`events/code-v6.ts`, projector in `projections/code-v6.ts`) → `projects.owner_approval_policy` → `ProjectDto.ownerApprovalPolicy` (`queries/misc.ts`) → `PUT /api/projects/:id/owner-approval` → web `OwnerApprovalPanel.tsx` in ProjectSettings. The design gate setting copies this pattern.

## 3. Options

| | A. New built-in `code` v7 with a `design_gate` approval stage | B. Hold the card inside `investigate` (like `DesignHeld`) with a bespoke gate doc |
|---|---|---|
| Reaches installs | Yes, through the normal rollout (new cards). In-flight v6 cards are not gated. | Yes, for every version with a design stage, including in-flight v6 cards |
| New code | One stage definition plus a derived flag. Desk item, decide API, permissions, web panel and timeline come for free from `approval.ts` | New events, desk subkind, approve/return endpoints, permissions, web panel, dispatcher exclusions: a second approval system |
| Board | Own stage "Design gate" (column Design), standard "Awaiting your approval" badge | Card sits in Design with a custom waiting state |
| Fit with the card | "workflow step/gate after design", "workflow stage" (Affected areas) | Does not add a stage |
| Risk | Tests that pin "newest code = v6" change; the test helper must register v7 with `lean: true` | Duplicate approval logic drifts from the owner approval step |

Rejected: **C. Edit v6 in place.** It does nothing on existing installs (2.3), and rewriting a stored built-in breaks the immutable-version rule.

## 4. Recommendation

**Option A.** Ship built-in `code` **version 7**: v6 plus one human approval stage `design_gate` between `investigate` and `build`, entered through a server-decided flag `designGate`. A project setting (off by default) and a per-card switch (only with a design report) feed the decision. A path-derived high risk at the design hand-off forces it.

Out of scope, with a backlog suggestion filed: the boardroom's "owner views every card while the reviewer flags the areas to look at first" mode. It is a review/owner-approval feature, not a design gate.

## 5. Design

### 5.1 Workflow: `packages/shared/src/workflows/builtin/code-v7.ts` (new)

Build v7 from v6. Do not copy-paste the whole definition: map the v6 stages and insert one.

```ts
export const DESIGN_GATE_STAGE = 'design_gate';
export const codeWorkflowV7: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...codeWorkflowV6,
  version: 7,
  stages: codeWorkflowV6.stages.flatMap((s) => {
    if (s.id !== 'investigate') return [s];
    const investigate = {
      ...s,
      outcomes: s.outcomes.map((o) => (o.id === 'handoff' ? { ...o, to: DESIGN_GATE_STAGE } : o)),
    };
    const gate = {
      id: DESIGN_GATE_STAGE,
      label: 'Design gate',
      column: 'Design',
      kind: 'human',
      human: { purpose: 'approval', approver: { kind: 'project_owner' } },
      claimRole: null,
      doneCriteria:
        "The project owner read the design report and approved it (on to Build), or returned it to design with a note.",
      outcomes: [
        { id: 'approve', label: 'Approve the design', kind: 'success', to: 'build', event: 'StageCompleted' },
        { id: 'send_back', label: 'Return to design', kind: 'failure', to: 'investigate', event: 'StageCompleted', rework: true },
      ],
      // Decided by the server at the design hand-off (project setting, card switch, high risk); otherwise skipped.
      when: { field: 'designGate', equals: true },
    };
    return [investigate, gate];
  }),
});
```

- Register v7 in `builtin/index.ts` (`BUILTIN_WORKFLOWS`, export). `getBuiltinWorkflow('code')` then returns v7.
- `skipInactive` already skips the gate when `designGate` is false: `investigate.handoff` → `design_gate` (inactive) → its first success outcome → `build`. A v7 card with the gate off behaves exactly like v6.
- `apps/server/src/start.ts` `noLeanTeam` filter (`version >= 6`) already covers v7.
- Return goes to **design** (the architect revises the report with the owner's note). If the owner wants the BA, the existing manager move to Spec still works. No new route is added.

### 5.2 Pure rules: `packages/shared/src/workflows/design-gate.ts` (new, export from the workflows index)

```ts
export type DesignGateReason = 'high_risk' | 'card' | 'project' | 'off';
export const DESIGN_GATE_REASON_TEXT: Record<DesignGateReason, string> = {
  high_risk: 'the design touches high-risk paths (authentication, permissions or secrets, data and migrations, tenancy or billing)',
  card: 'the design gate is switched on for this card',
  project: 'the project asks for the owner approval of every design',
  off: 'the design gate is off and the design touches no high-risk paths',
};

/** Path-like tokens (at least one `/`) in free text: `apps/server/src/db/x.ts`, `packages/shared/src/orgs/`. */
export function pathsInText(text: string): string[];

/**
 * High-risk paths a design touches, derived before any code exists: the path tokens of the card's Affected areas, the
 * planner's note, the design summary and the Card Brief. A token without an extension also counts as a folder
 * (`apps/server/src/db` is tested as `apps/server/src/db/x`). Derived from paths, never from a declared risk: a source
 * can only add paths. `isHighRisk` is injectable so the per-project path-to-risk map (GWP-205) replaces the built-in
 * rules here and at the build hand-off together.
 */
export function designRiskPaths(
  sources: { affectedAreas?: string | null; planningNote?: string | null; designSummary?: string | null; cardBrief?: string | null },
  isHighRisk: (path: string) => boolean = isHighRiskPath,
): string[];

export function designGateDecision(i: { projectGate: boolean; cardGate: boolean; highRiskPaths: readonly string[] }):
  { required: boolean; reason: DesignGateReason } {
  if (i.highRiskPaths.length > 0) return { required: true, reason: 'high_risk' };
  if (i.cardGate) return { required: true, reason: 'card' };
  if (i.projectGate) return { required: true, reason: 'project' };
  return { required: false, reason: 'off' };
}

export const workflowHasDesignGate = (def: Pick<WorkflowDefinition, 'stages'>) =>
  def.stages.some((s) => s.id === DESIGN_GATE_STAGE);
```

`HIGH_RISK_EXEMPT_GLOBS` (docs, tests, `*.md`) apply through `isHighRiskPath`. A design whose text only mentions the report file does not trip it.

### 5.3 Data model: migration `apps/server/migrations/29xx_design_gate.sql` (next free number)

```sql
ALTER TABLE projects ADD COLUMN design_gate boolean NOT NULL DEFAULT false;        -- AC1: new project = off
ALTER TABLE cards ADD COLUMN design_gate_card boolean NOT NULL DEFAULT false;      -- the owner's per-card switch
ALTER TABLE cards ADD COLUMN design_gate_required boolean;                         -- decided at the design hand-off
ALTER TABLE cards ADD COLUMN design_gate_reason text;
ALTER TABLE cards ADD COLUMN design_gate_paths text[] NOT NULL DEFAULT '{}';
```

No data backfill: existing projects read `false`.

### 5.4 Events: `packages/shared/src/events/design-gate.ts` (new, added to the event union like `events/code-v6.ts`)

- `ProjectDesignGateSet { projectId, on: boolean, by }`
- `CardDesignGateSet { cardId, on: boolean, by }`
- `DesignGateDecided { cardId, required, reason: DesignGateReason, highRiskPaths: string[] (≤ 50) }`
- `InvestigationReported`: add optional `reportText?: string` (≤ 200 000). Stored as `investigation.text`. **Not** `body`: `body` means "commit this later" (2.5).

Projectors go in `apps/server/src/projections/design-gate.ts` (new; register it next to `code-v6.ts`). They write the columns above. `InvestigationReported` in `projections/cards.ts` keeps `text` in the JSON.

### 5.5 Server

**Project setting** (`apps/server/src/commands/lean-project.ts`, add `setDesignGate`): same `loadManaged` permission as the owner approval policy. Refuse `409 design_gate_not_supported` ("this project's workflow has no design gate: new cards must run on a workflow with Investigate & design and the design gate") when the workflow `resolveWorkflow` gives a new card has no `design_gate` stage. No-op when unchanged. Route `PUT /api/projects/:id/design-gate` `{ on: boolean }` in `routes/projects.ts`, returning `getProjectDetail`. `ProjectDto.designGate: boolean` (`api/projects.ts`, `queries/misc.ts`).

**Card switch** (new `setCardDesignGate` in `apps/server/src/commands/cards.ts`, or a small `commands/design-gate.ts`): `PUT /api/cards/:id/design-gate` `{ on: boolean }`. The project owner or an org Owner/Admin may use it (same rule as `loadManaged`); anyone else gets 403.
- `on: true` refusals, in this order:
  1. `409 design_gate_not_supported`: the card's workflow has no `design_gate` stage (a v6 card).
  2. `409 no_design_report` (**AC2**), when `card.investigation?.reportPath` is missing or the card is investigation-only: "`<REF>` has no design report yet. The design gate reviews the design report, so it can be switched on once the architect has handed one off."
  3. `409 design_gate_too_late`: the card is past the start of Build. Allowed: `investigate*` (held design, assumption review, a returned design), `design_gate` (no-op), or `build` with `status='queued'` and no claim. Message: "`<REF>` is already being built: return it to design instead."
- Effect: `CardDesignGateSet`. If the card is at `build`, queued and unclaimed, also append `DesignGateDecided {required:true, reason:'card'}` and move it to `design_gate`. Reuse the manager move (`moveCard` / `CardMovedByManager` in `commands/cards.ts`), so the reactor's `enterHumanStep` opens the desk item. Otherwise the switch takes effect at the next design hand-off.
- `on: false`: `CardDesignGateSet false`. No guard and no other effect. It does not close an open gate: the owner approves it. This follows the no-skip-guard constraint.

**Design hand-off decision** (`apps/server/src/commands/shifts.ts`, `case 'StageCompleted'`, inside `outcome.data === 'investigation'`): when the card is not investigation-only, the design is not held (`!holdDesign`), and `workflowHasDesignGate(wf.definition)`:

```ts
const project = await one(tx, 'SELECT design_gate FROM projects WHERE id=$1', [card.project_id]);
const planning = await one(tx, `SELECT note FROM card_handoffs WHERE card_id=$1 AND stage='planning'
                                ORDER BY created_at DESC, event_seq DESC LIMIT 1`, [cardId]);
const paths = designRiskPaths({ affectedAreas: card.fields?.affectedAreas, planningNote: planning?.note,
                                designSummary: inv.summary, cardBrief: card.card_brief });
const gate = designGateDecision({ projectGate: project?.design_gate === true, cardGate: card.design_gate_card === true, highRiskPaths: paths });
const toStage = resolveOutcome(wf.definition, { ...workflowCard, designGate: gate.required }, card.stage, outcome.id).toStage;
```

- Append `DesignGateDecided` **before** the `StageCompleted` (so the projected flag is set when the reactor looks). Use `toStage` in the `StageCompleted` payload. Post a system thread message ("Design gate required for `<REF>`: <reason text>." / "Design gate not required ...") as the owner approval decision does. Record it on every design hand-off of a v7 card, so the reason is visible.
- `resolved` is computed earlier with `workflowView(card)`, which has no `designGate`. Recompute as above. The **required-fields check** (line ~284) must also check `build`'s required fields when the target is `design_gate`, because an approval at the gate does not check them.
- `acceptMessage` when gated: "Recorded. The card waits at the design gate for the owner's approval. Finish now."
- The assumption review path (`aom design confirm|revise`) is also an investigation hand-off and gets the same decision.

**`workflowView`** (`commands/cards.ts`): add `designGate: c.design_gate_required === true`, next to `ownerApproval`.

**Approval step for the gate** (`commands/approval.ts`):
- `enterHumanStep`: for `stage.id === DESIGN_GATE_STAGE`, do **not** bind `sha` (the approval is for the design, not a commit; a rework card may carry an old `head_sha`). The desk item `doing` reads "`<REF>` waits for your design approval: <reason text>. Design report: <reportPath>." The `data` gets `design: { reportPath, commit, summary }` so the desk can show it without opening the card.
- `cardApprovalDto`: for the gate, omit `review` (no diff) and add `design: { reportPath, location, commit, summary, text (≤ 200 000), cardBrief, reason, reasonText, highRiskPaths }`. Schema: `CardApprovalSchema.design` optional (`api/approval.ts`).
- `decide`: no change. Send back already requires a comment, posts "Sent back from "Design gate": <note>" in the thread, and `StageCompleted { rework: true }` re-queues `investigate`. Check that the architect's rework brief shows the note (`runner-gateway/brief.ts`, recent thread or review comments). Add it there if it does not appear.

**Runner** (`apps/runner/src/shifts/supervisor.ts` `prepareInvestigation`, worktree `repo` branch): read the committed report file it already resolves, run `secretsIn(text)` (refuse on a leak, as in the other branch) and attach `reportText: text` (cap 200 000). Add `reportText` to `InvestigationDataSchema` (`protocol/ipc.ts`). Vault reports may attach the same text. An older runner sends none, and the UI then shows the summary and path.

### 5.6 Web (`apps/web`)

- `components/DesignGatePanel.tsx` (new), in ProjectSettings next to `OwnerApprovalPanel`. Shown when `project.leanTeam`. Badge "Off" / "Every design". Checkbox "Stop every card after the design for my approval" (`data-testid="design-gate-on"`). Text: "High-risk designs always stop here." It is read-only for non-owners, like the owner approval panel. Hook `useSetDesignGate` in `api/queries/projects.ts`. Error `design_gate_not_supported` goes through `ErrorBox`.
- Card detail: a "Design gate for this card" switch near `InvestigationPanel`, for owners on a v7 card. It is disabled, with the server's reason as hint text, when there is no design report. The server refuses anyway, and the AC2 test hits the API.
- `ApprovalPanel.tsx`: when `approval.design` is present, show the reason, the high-risk paths, the summary, `reportPath @ commit`, the full report (`text`, rendered as markdown, collapsible, scrollable) and the Card Brief, in place of "Show the diff". The buttons read "Approve the design" and "Return to design" (the comment stays required).
- Touch (standing order "design"): no new text inputs beyond the existing required return comment. Use full-width buttons and checkbox labels with at least 44 px tap height. The report block scrolls inside the panel so the action buttons stay reachable when the soft keyboard is open for the comment.

### 5.7 Docs

- `docs/USER-GUIDE.md`: in the lean team section (near "Owner approval", ~line 988/1312/1320) add **Design gate**: the stage order (Investigate & design → Design gate → Build), the project setting, the card switch and its refusals, high risk always stops, approve/return, and the fact that a returned design goes to the architect. Add a settings line next to "Owner approval after the review" (~line 511).
- `docs/ARCHITECTURE.md` §35: a "`code` version 7" paragraph covering the stage, the `designGate` derived flag, `designGateDecision`/`designRiskPaths`, the events, the migration, `reportText`, and the rule for GWP-207/208 (over budget → needs-split wins; high risk only → gate).

## 6. Acceptance criteria → design → tests

| AC | Design | Test (new files) |
|---|---|---|
| AC1 new project → gate off | `projects.design_gate DEFAULT false`; `ProjectDto.designGate=false`; a low-risk v7 card goes `investigate` → `build` | `apps/server/test/design-gate.test.ts` "a new project has the design gate off and a low-risk design goes straight to Build" |
| AC2 no report → refused with reason | `PUT /api/cards/:id/design-gate` → `409 no_design_report` plus message; also `design_gate_too_late`, `design_gate_not_supported`, 403 | same file, "switching the gate on for a card without a design report is refused with the reason" |
| AC3 gate on + hand-off → waits, desk item with the report | `DesignGateDecided(project)` → `design_gate` → `enterHumanStep` desk item (`approvalStep`, `data.design`); `CardApproval.design` with summary, path, commit, text | same file, "with the project gate on the card waits at the design gate and the owner's desk item carries the design report" |
| AC4 approve → Build; return → back with note | `approveStep` → `build`; `sendBackStep(comment)` → `investigate` rework, comment in the thread and the architect brief | same file, two tests |
| AC5 high risk, gate off → design gate, not the BA | `designRiskPaths` over Affected areas / planner note / summary / brief; `reason 'high_risk'` | same file, "a design touching apps/server/src/db/** stops at the design gate with the gate off"; plus `packages/shared/test/design-gate.test.ts` for `pathsInText`, `designRiskPaths` (folder tokens, exempt docs/tests) and `designGateDecision` |
| Regression: owner approval policy | Unchanged `ownerApprovalDecision`; v7 keeps `owner_approval` | `apps/server/test/design-gate-owner-approval.test.ts`: on v7, `large_or_high_risk` auto-approves a small low-risk card, `always` asks, and a high-risk diff asks, with the design gate on and off |
| Stage graph | v7 `resolveOutcome` | `packages/shared/test/design-gate.test.ts`: `investigate.handoff` → `build` (designGate false) / `design_gate` (true); gate `approve` → `build`; `send_back` → `investigate`; `validateWorkflow(codeWorkflowV7, BUILTIN_ROLES)` is empty |
| Web | panel and approval design block | `apps/web/src/test/design-gate-panel.test.tsx` |

## 7. Risks and traps

- **Existing tests that pin v6 as the newest `code`** must move to v7: `packages/shared/test/workflows.test.ts:69` and `packages/shared/test/lean-v6.test.ts:278-282`. The v6 assertions about v6's own stages stay. These are the only edits to existing test files.
- **Test helper**: `apps/server/test/helpers/app.ts` registers `code >= 6` only with `lean: true`, so lean suites will run new cards on v7. Run the lean suites (`code-v6*.test.ts`, `design-before-landing`, `design-held-rebuild`, `approval-step`, owner approval). If a fixture's Affected areas name a high-risk path, the card now stops at the gate. Fix the fixture, not the rule.
- **Ordering**: `DesignGateDecided` must be projected before the reactor runs `enterHumanStep` (append it before `StageCompleted` in the same batch).
- **Stale SHA**: do not bind `sha` for the gate, or a rework card with an old `head_sha` could be reported stale.
- **False positives** in `designRiskPaths` (a text that names a high-risk path it will not touch) only add a gate stop. That is accepted: only raising is allowed.
- **GWP-205** (per-project path-to-risk map) is not a blocker: pass its matcher as `isHighRisk` when it lands, at the build hand-off and here together.
- **GWP-207/208**: when needs-split arrives, the design hand-off order is over budget → needs-split (BA); otherwise `designGateDecision`.
- **No skip guard** (PRD 9 item 2): the manager move and switching the card or project gate off stay unguarded.
- Cards in flight on v6 are not gated. This is expected under the rollout rule (ARCHITECTURE §35).
