# Manual QA after Finalize (#64)

Status: design and build, 2026-10-14. Backlog #64 (`docs/BACKLOG.md`). Builds on the workflow engine
(`packages/shared/src/workflows`, `docs/design/architect-and-workflows.md`, `docs/design/workflow-builder.md`), the
outbox (`apps/server/src/commands/outbox.ts`, `drafts.ts`), the desk and reopen (#27).

## 1. Problem

A card is finalized (merged, pushed or a pull request) and the owner does not test everything. When they do test and it
fails, the card must not pass, and today the only way back is to reopen a closed card by hand. The outgoing comment on
the ticket (the BA's resolution draft) goes out as soon as it is approved, i.e. before anybody tested.

## 2. Decisions

| # | Decision | Rejected |
| --- | --- | --- |
| D1 | **Two stages after `finalize` in a new built-in version `code` v3**: `qa_steps` (agent, writes the test steps, read-only, no worktree) and `manual_qa` (new stage kind `human`, completed by a person). | One stage that is both: an agent claim and a human wait cannot share a stage (claim, lease and `queued` semantics). Putting QA before finalize: the owner tests the merged result, and a rework round then needs no un-merge. |
| D2 | **Generic human stage kind**: `Stage.kind = 'human'` with `human: { purpose: 'qa' \| 'approval', assignee: 'starter' }`. Manual QA is `purpose: 'qa'`. Backlog #16 ("owner approves" step) reuses the kind with `purpose: 'approval'` (outcomes approve / send back); only the server handler and the panel for that purpose are missing. | A QA-only stage kind: #16 would add a second one. A flag on an agent stage: the dispatcher would have to special-case it. |
| D3 | **Skip guards on derived flags**: `manual_qa` has `when manualQa = true`, `qa_steps` has `when qaAgent = true`. The server derives the flags at the moment the card leaves Finalize (`manualQa` = the project setting is on and the card is not investigation-only; `qaAgent` = an active agent of the tester or BA role is hired for the project). Existing resolver (`skipInactive`) does the skipping, so a switched-off project or a project with no agent goes `finalize -> done` (or `-> manual_qa`) with no special path. | A card field copied at creation: cards that are already further along would not follow the setting. |
| D4 | **`CardFinalized.toStage` is `done`, `qa_steps` or `manual_qa`** (resolved with `resolveOutcome`). In the same append: `QaOpened` (assignee, desk item). A card that goes to QA is not done yet: `finalized_at`, the `card_done` trigger, sub-workflow completion and the archive timer (#51) count from `QaPassed` / `QaSkipped`. The merge itself (phase `merged_into_working_at`, full-suite card, worktree removal) happens at `CardFinalized` as before. | A new event for the merge: every consumer of `CardFinalized` would change. |
| D5 | **Versioning.** v1 and v2 stay registered. New cards pin v3. A card still pinned to v1/v2 when it leaves Finalize is **upgraded to v3 at that moment** (`CardFinalized.workflowVersionId`): v3 equals v2 up to Finalize, so nothing already done changes. This is how "existing projects: on, but only for cards that have not passed Finalize yet" is true for cards in flight. Project variants (#10) that extend v2 keep their stages until rebased (open point). | Leaving in-flight cards on v2: the owner's cards in progress would skip QA. |
| D6 | **Project setting `manualQa`** (event `ProjectManualQaSet`, column `projects.manual_qa`, default true, existing projects too). Project Owner and organization Owner/Admins change it. Shown near the full-suite setting. | Per card: not asked for. |
| D7 | **Assignee**: the person who started the card: `cards.owner_user_id` (the creator; for an intake chat or batch it is the person who ran the intake) while still an active project member, else the project owner. Reassign to any active project member. Stored in `cards.qa`. | A new `created_by` column: the card owner already is that. |
| D8 | **Who may act**: the assignee, the project owner and managers (`isProjectMember`), organization Owners and Admins. Everybody else sees the panel read-only. | Assignee only: nobody could unblock a card of someone on leave. |
| D9 | **Send back** moves to `build` with `rework_round + 1` (`QaSentBack`, outcome `send_back`, `rework: true`). The comment reaches the builder as a review comment ("Review comments to address", reviewer name "<name> (manual QA)"). The card goes through build, review, test, docs and finalize again, then QA again. No reopen. | Reusing `ChangesRequested`: it is written by a reviewer agent shift. |
| D10 | **Held outgoing comment.** While the card is before its QA decision and manual QA applies, the BA's `aom outbound draft` records the draft as `held` (`OutboundHeld`; no desk item, nothing posted). `QaPassed` / `QaSkipped` release it (`OutboundReleased`: status `pending` and the usual desk approval for the card owner, which then posts it from the owner's workstation as today). `QaSentBack` keeps it held; a second draft is refused as a duplicate (the BA's draft is once per card and kind). Without QA the behaviour is unchanged. | Auto-approving on release: the text was written before the test; the owner still reads it. |
| D11 | **QA steps task = an ordinary card shift** on `qa_steps` (`worktree: none`, `maxShiftMinutes: 20`, role tester with `fallbackRole: ba`). `Stage.fallbackRole` is new: the stage is claimable by the fallback role only when the organization has no active agent of `claimRole`. The steps are the outcome note (`aom outcome steps --note-file`), posted on the card as a comment, stored in `cards.qa.steps`. If no agent is hired (`qaAgent` false) the card opens `manual_qa` directly with a note, and the person can act at any time during `qa_steps` too. | A new background-task kind (like phase tasks): a second dispatcher path for the same thing. |
| D12 | **Desk item**: kind `question`, subkind `manual_qa`, options Pass / Skip / Send back, addressed to the assignee (`addressee_user_id`; the assignee, project owners and managers and organization Owners/Admins may act). The desk renders its own block (note, three buttons) that calls the same endpoints as the card panel; the generic desk "answer" refuses this subkind (`use_qa_actions`) so there is one code path. Acting closes the item (`QuestionAnswered`); a hand-over dismisses it and raises a new one for the new assignee. | An approval: approvals have two outcomes. Answering through `POST /api/desk/:id/answer`: it writes a ledger entry, which a test result is not. |
| D13 | **Rework after a merge.** Nothing new is needed on the runner: the server keeps `worktree_path` and `branch_name` after the merge, so the first claim after send-back is a `reuse`; `ensureWorktree` finds the card branch gone (deleted with the merge, `deleteBranch`, or by hygiene #28) and cuts it afresh from the working branch, which already contains the merged work. The second finalize merges only the new commits (the branch starts at the working branch head). With `pr` / `push_branch` the branch is on origin and continues there; the pull request is updated (#27). `QaSentBack` clears the finalize state of the first run (like a reopen) and keeps the merge history. Tests cover the git path. | Un-merging: never. |

## 3. How it fits the workflow engine

```
build -> review -> test -> docs? -> finalize -+-> qa_steps (agent, when qaAgent) -> manual_qa (human, when manualQa) -> done
                                              |                                        |-- pass / skip -> done
                                              |                                        '-- send_back -> build (rework)
                                              '-- (both skipped: manualQa false) -> done
```

- `Stage.kind = 'human'`: never dispatched (the candidate query requires `st.kind = 'agent'`), no claim, no lease. The
  card sits in status `waiting` in the stage's own column ("QA"; `columnFor` keeps human steps in their column).
- Time in stage, cost and metrics work unchanged: stage changes go through `mutateCard` / `recordTransition`.
- The finalize outcome is not reported by an agent: `applyFinalizeResult` resolves `finalize.finalized` with the derived
  view (`resolveOutcome`) to decide `toStage`.
- `qa_steps` is an ordinary agent stage: `StageCompleted` outcome `steps` to `manual_qa` plus `QaStepsPosted`.
- Validation: rule 11 (human block present, no role; `fallbackRole` only on agent stages and a known role); custom
  workflows cannot use `human` or `fallbackRole` yet. Derived fields are in the field catalogue (`DERIVED_BOOLEAN_FIELDS`).

## 4. Data and events

- Events: `QaOpened`, `QaStepsPosted`, `QaAssigned`, `QaPassed`, `QaSkipped`, `QaSentBack` (`events/qa.ts`),
  `ProjectManualQaSet`, `OutboundHeld`, `OutboundReleased`; `CardFinalized` gains `toStage` values and `workflowVersionId`.
- Migration `1930_manual_qa.sql`: `projects.manual_qa`, `cards.qa jsonb`, `workflow_stages.fallback_role` and the `human`
  kind, `outbound_drafts` status `held`.
- API: `POST /api/cards/:id/qa/{pass,skip,send-back,assign}`, `PUT /api/projects/:id/manual-qa`; `qa` on the card detail
  and the board card.

## 5. Web

QA panel on the card page (steps rendered as a checklist, the four actions, held comment, history), board column "QA"
with a "Waiting for my QA" filter, Project settings toggle, desk item with the three options.

## 6. Open points

- Project variants that extend v2 do not get the stages until rebased onto v3.
- `purpose: 'approval'` (#16) is reserved: the kind and config exist, the handler does not.
- The release of a held comment still needs the owner's desk approval (one more click); auto-approve could follow.
- A card whose home workstation has no tester or BA waits in `qa_steps` (the usual home-workstation rule applies to every agent stage); the person can pass, skip or send it back at any time, steps or not.
- Scheduled (automatic) and investigation-only cards have no QA; a bug child never finalizes on its own.
- No e-mail or push is sent for the QA desk item: the notification is the desk item, the card on the assignee's board and the note on the card thread (the desk has no outgoing channel today).
