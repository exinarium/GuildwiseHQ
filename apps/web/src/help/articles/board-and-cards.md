---
title: Board and cards
summary: Reading the board, creating and editing cards, moving cards, backing off, risk tiers and search.
keywords: [board, card, stage, workflow, risk, backing off, search]
order: 5
---

The board is your view of all work in a project. Cards move left to right through stages as agents work on them. Each card shows the title, who is working on it, how recently it changed, and flags such as large risk or rework.

## Reading the board {#reading-the-board}

The board shows one column per stage (for a Code project: Spec, To do, Rework, In progress, Blocked, Review, Test, Docs, Finalize and Done). Empty columns fold into a small strip; click one to open it. At the top you can search cards, filter by **Blocked**, **Rework** or **Unassigned**, and filter by priority. Each card tile shows:

- **Card reference** (e.g., `TOY-1`): a unique label for the card, and how long ago it last changed.
- **Title**.
- **Assignee**: the agent working on it, if anyone.
- **Priority**: only when it is not the default.
- **Risk tier**: shown only when it is **large** (a small risk tier is the quiet default).
- **Rework** badge with the round number: how many times review sent the card back.
- **Backing off** badge when the card is being held back after failed shifts (see below).
- **Badges** for the workflow it runs on (for example Research), its phase, **Blocked**, or a waiting reason such as **waiting on bug**, **Awaiting your approval**, **Finalizing** or **waiting on DevOps**.
- **Warning banners** under the card, written out in words, each with a link that fixes it when there is one:
  - **Blocked: the question** that holds the card, with a link to the Decision desk.
  - **Repository problem** (for example a conflict while updating, or a failed login) on the card's repository, linking to the project's repository settings.
  - **Monthly budget** nearly used up, used up (new work waits), or overridden, linking to the budget settings for Owners and Admins.
  - Plus the "nobody can take this card" and backing-off messages described below. Tap the arrow on a banner for the full reason.

The card type (feature, bug, support, refactor, docs, regression) shows on the card's own page.

A **Blocked** column holds cards that are waiting for your answer from the desk.

## Why a card does not move {#why-a-card-does-not-move}

If a queued card has a warning icon, no agent can pick it up right now. Hover the icon, focus it with the keyboard or click or tap it to see why (Esc closes the explanation):

- **Red, "Not workable"**: no hired agent could ever take this stage. For example, you hired no builders, the Review stage needs a senior reviewer and you only hired juniors, or the only reviewer built the card itself (a reviewer never reviews their own work, and a large change needs two different reviewers). The explanation has a **Hire** link to open the Hire form with the missing role and seniority pre-filled.
- **Amber, "Waiting"**: agents exist but cannot work right now. Their workstation is offline, the card's repository is not cloned on any of their machines, or they have all been busy with other work for more than ten minutes. This clears by itself when the workstation comes back, the repository is cloned, or the agent is free.
- **Amber, "Last attempt failed"**: an agent's workstation turned the last shift down, for example because the repository's working branch does not exist there and the runner could not create it from the default branch ("working branch 'main' does not exist in Barcode Camera (default branch is master)"). For a branch problem the explanation links to **Project settings, Repositories**, and the same question is waiting on your desk with the repository's branches as options and its default branch preselected. The card is retried with a growing pause meanwhile, and the message clears when you set the branch or a shift starts.

## Creating a card {#creating-a-card}

To create a card:

1. Click **New card** on the board, or press **n** anywhere.
2. Fill in the form:
   - **Project** and **Card type** (feature, bug, support, refactor, docs).
   - **Title**: what the work is (e.g., "Fix login timeout").
   - **Repository** and **Completion action**: how to ship it (`pr`, `push_branch` or `merge`).
   - **Priority**, and **Docs needed** (whether a technical writer should document it).
   - **Context**: why this exists, the current behaviour.
   - **Requirements**: what must be done.
   - **Acceptance criteria**: what done looks like, one per line.
   - **Affected areas**: which files or systems.
   - **Constraints**: limits and linked decisions.
   - **Test plan**: the E2E test scenarios.
3. Click **Save draft**, or click **Specify** to send it on (this requires every field a build needs; the form tells you what is missing).

Drafts can stay until you are ready to specify them. A draft saved with missing fields can be finished later on its card page, where **Specify** is also offered.

## Editing a card {#editing-a-card}

You can edit a card while it is a draft or queued and unclaimed:

1. Click the card on the board.
2. Click **Edit**.
3. Change what you need: title, requirements, completion action, priority, docs needed, or workflow fields.
4. Click **Save**.

You cannot edit a card an agent is working on. Release it first. Every edit is recorded in the card's timeline.

## Moving cards {#moving-cards}

To move a card to a different stage (for example to fix a stuck card):

1. Click the card.
2. Click **Move**.
3. Choose the **Target stage**, give a **Reason** (required) and click **Move card**.

The **More actions** menu (the three dots) also has **Release** (put the card back in the queue so another agent can claim it), **Re-home** (forget its workstation and worktree) and **Cancel card** (a reason is required). Only the project owner (Owner and Admins) or the card's creator sees these actions.

## Backing off {#backing-off}

When three shifts on the same card end with no report within ten minutes (the agent crashed or timed out), the card shows an amber badge such as "backing off until 14:32 (3 failures)", and a "keeps failing" item lands on your desk. Guildwise HQ waits 1 minute before offering it again; every further failure doubles the wait, up to 1 hour.

Any report from an agent ends the back-off. To fix it:

1. Find what the agent cannot do: maybe a tool is denied, or a required capability is missing.
2. Fix it.
3. On the card, click **Release back-off** to retry at once.

Moving the card to another stage also clears the back-off.

## Risk tier {#risk-tier}

Risk is computed when the builder hands off. A card is **large** when 200 or more lines changed, when the change touches the project's architectural paths (set in **Project settings > Basics** as architectural globs), or when it is a refactor; otherwise it is small. Small cards need one reviewer's approval, large cards two, and a large change that is merged into the working branch waits for your approval on the desk (unless you turned that off in the project's merging settings).

You can override it:

1. Click the card.
2. In **Details**, next to the risk tier, click **Change**.
3. Pick small, large, or (once overridden) back to the one computed from the diff.
4. Give a reason and click **Set risk tier**.

The override shows as a badge on the card and the reason is recorded. Once overridden, the diff no longer changes it.
