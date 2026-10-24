---
title: The Decision desk
summary: Desk items and kinds, blocking, answering questions, standing orders and adding to the ledger.
keywords: [desk, question, approval, blocking, standing order, ledger]
order: 8
---

The **desk** is where every question and approval reaches you. Cards that wait on a question do not move forward until you answer. The **Decision desk** page shows every item waiting for you, with filters (**All**, **Blocking**, **Questions**, **Approvals**, **Notices**) and a sort order (Priority, Oldest, Newest). Items are grouped as **Needs you first**, **Blocking work**, **Decisions** and **Heads-up**.

## Desk items {#desk-items}

Each item shows:

- **What kind it is**: a label like Question, DevOps approval (on a team member's workstation both an Owner or Admin and the machine's user have to agree; the item stays open until they have, see [Who approves](/help/devops-and-hygiene#devops-engineer)), Merge approval, Outbound update, Escalation, Create repository, Budget paused, Phase done or Vault conflict.
- **Who asked**: the agent and its role.
- **What they are doing**: which card or project.
- **The question**: with options and a recommendation.
- **How many cards are blocked**: a count of cards waiting on this answer, and the item's age.

The desk also has the filters **Handled by CEO** and **CEO decisions**. A question that has a recommendation offers **Accept recommendation**, which answers with exactly what is recommended. The CEO's daily report arrives as a **Daily report** item.

Alerts, approvals and notices also have **Ask DevOps about this**, which opens a request to the DevOps engineer with the item attached.

Some items are urgent: approval requests, blocking questions, pinned alerts and cards that keep failing. Everything else can wait up to 10 minutes while your BA reviews it first (if you have routing on; with a CEO it reviews them first).

## CEO decisions {#ceo-decisions}

If you have a CEO, the things it decided for you appear under **CEO decisions** at the bottom of the desk (and under the **CEO decisions** filter). They are information: no notification, not blocking, and not counted in the open total. Each shows what was asked, the decision and the reason, the card and "CEO decision · name".

- **Acknowledge** marks it read; **Acknowledge all** marks every open one read at once.
- **Correct** is for a wrong decision: write what the right decision is. The CEO remembers it (visible on the CEO's **Memory** tab), then the CEO and the BA discuss it: the BA analyses why it went wrong, what already happened because of it, and proposes fix cards; the CEO replies (agrees or disagrees, what it got wrong, the lesson; your correction always stands); the BA creates the fix cards in the right projects. The item shows this as a timeline and a chip: **Under review**, then **Lesson recorded · N fix cards**. It needs nothing from you and sends no notification. Tick **Apply the correction now** (Owner) to also re-open the question where that is possible.

Owners and Admins can acknowledge and correct. See [Your CEO](/help/your-ceo#decisions).

## Blocking {#blocking}

An item is **blocking** when cards cannot move until you answer it. For example, a large merge waits for your approval, or an agent needs a decision before it can continue.

Blocking items sort to the top of the desk (after pinned ones) and show a count of blocked cards. Answer them first to keep work moving.

## Answering a question {#answering}

To answer a desk item:

1. Find the item on the desk.
2. Choose an option (the recommended one is pre-selected) and/or type your own text in the note box. Typed text replaces the option's text.
3. Pick what to **Add to ledger as** (see below).
4. Click **Answer**.

Your answer is recorded in the ledger (shared with future agents), the card is unblocked, and the asking agent's next shift includes your answer. **Dismiss** closes the item without an answer and tells the asker you declined.

Only people who may answer see the form; on a card with the default policy only the card's owner can answer, and others see the item read only (see the decision policy on the card).

## Reminders {#reminders}

A question, approval, escalation or digest rating that is still open after **3 days** reminds the person it is waiting for: a notification on their devices (the **Reminders for open items** category in notification settings) and a **Reminded** mark on the item. It repeats at most once per period. An item that sits with an agent is handed back to the agent once instead.

Use **Snooze** on an item to hold its next reminder back for a day up to two weeks. An Owner or Admin changes the period, or turns reminders off with 0, under **Settings > General > Reminders for open items**.

## Standing orders {#standing-orders}

**Standing orders** are recurring instructions that show up in every agent's shift. Use them for:
- Team policies (e.g., "all PRs must have unit tests").
- Context (e.g., "we are migrating from X to Y").
- Decisions that affect multiple cards (e.g., "use the new auth system").

To add a standing order:

1. Click **Add to ledger** on the Desk page, or **Add entry** on the Ledger page.
2. Choose the **Kind** (**Standing order**), leave the **Project** blank for every project or pick one, and give it a **Title** and the **Text**.
3. Click **Add to ledger**.

Standing orders show up in agents' shift instructions automatically.

You can also create standing orders when answering a desk question: choose **Standing order (this project)** or **Standing order (every project)** under **Add to ledger as**, and it is added when you click **Answer**.

## Adding to the ledger {#adding-to-ledger}

When you answer a desk question, **Add to ledger as** decides how it is saved:

- **Decision (project log)**: the default. A choice you made, recorded for history.
- **Requirement (this card)**: a rule for that card's work.
- **Standing order (this project)** or **Standing order (every project)**: an instruction every agent loads at the start of a shift.

The ledger stores it and future agents can search it. See [Ledger and vaults](/help/ledger-and-vaults#ledger).
