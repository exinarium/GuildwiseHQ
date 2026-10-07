---
title: Board and cards
summary: Reading the board, creating and editing cards, moving cards, backing off, risk tiers and search.
keywords: [board, card, stage, workflow, risk, backing off, search]
order: 5
---

The board is your view of all work in a project. Cards move left to right through stages as agents work on them. Each card shows the title, who is working on it, how old it is, and how risky it is.

## Reading the board {#reading-the-board}

The board shows one column per stage. Each card tile shows:

- **Card reference** (e.g., `TOY-1`): a unique label for the card.
- **Title and type** (feature, bug, support, refactor, docs).
- **Assignee**: the agent working on it, if anyone.
- **Age**: how long the card has been in the current stage.
- **Risk tier** (small or large): how much review and testing it needs.
- **Waiting badge**: if the card is waiting on something (a bug, your approval, a decision).
- **Rework count**: how many times the card was sent back to review.

A **Blocked** column appears when cards are waiting for your answer from the desk.

## Why a card does not move {#why-a-card-does-not-move}

If a queued card has a warning icon, no agent can pick it up right now. Hover the icon to see why:

- **Red, "Not workable"**: no hired agent could ever take this stage. For example, you hired no builders, or the Review stage needs a senior reviewer and you only hired juniors. The tooltip has a **Hire** link to open the Hire form with the missing role and seniority pre-filled.
- **Amber, "Waiting"**: agents exist but cannot work right now. Their workstation is offline, the card's repository is not cloned on any of their machines, or they have been busy for too long. This clears by itself when the workstation comes back, the repository is cloned, or the agent is free.

## Creating a card {#creating-a-card}

To create a card:

1. Click **Create card** on the board or in a project, or press **n** anywhere.
2. Fill in the form:
   - **Title and type**: what the work is (e.g., "Fix login timeout, bug").
   - **Context**: why this exists, the current behaviour.
   - **Requirements**: what must be done.
   - **Acceptance criteria**: what done looks like.
   - **Affected areas**: which files or systems.
   - **Constraints**: limits and linked decisions.
   - **Test plan**: E2E test scenarios (for Code projects).
   - **Completion action**: how to ship it (PR, push branch, merge to main).
   - **Docs needed**: whether a technical writer should document it.
3. Save as a draft, or click **Specify** to move it to the queue (requires all fields).

Drafts can stay until you are ready to queue them.

## Editing a card {#editing-a-card}

You can edit a card while it is a draft or queued and unclaimed:

1. Click the card on the board or find it on the project page.
2. Click **Edit**.
3. Change what you need: title, requirements, completion action, priority, docs needed, or workflow fields.
4. Click **Save**.

You cannot edit a card an agent is working on. Release it first. Every edit is recorded in the card's timeline.

## Moving cards {#moving-cards}

To move a card to a different stage (for example to fix a stuck card):

1. Click the card.
2. Click **Move**.
3. Choose the stage.

You can also release the card back to the queue so another agent can claim it, or cancel it entirely.

## Backing off {#backing-off}

When three shifts on the same card end with no report within ten minutes (the agent crashed or timed out), the card shows an amber **backing off** badge. Guildwise HQ waits 1 minute before offering it again. If it fails again, the next wait is longer, up to 1 hour.

A report (any shift result) resets the wait. If the card fails again, the wait is longer. To fix it:

1. Find what the agent cannot do: maybe a tool is denied, or a required capability is missing.
2. Fix it.
3. On the card, click **Release back-off** to retry at once.

Moving the card to another stage also clears the back-off.

## Risk tier {#risk-tier}

Risk is auto-computed from the size of changes (small: <= 100 lines changed; large: > 100 lines). It sets how many reviewers must approve and whether the full test suite runs after merging.

You can override it:

1. Click the card.
2. Next to the risk tier, click **Change**.
3. Pick small, large, or go back to the computed tier.
4. Give a reason.

The override shows as a badge and the reason is recorded in the timeline. Once overridden, the diff no longer changes it.
