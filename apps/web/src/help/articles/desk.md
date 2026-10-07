---
title: The Decision desk
summary: Desk items and kinds, blocking, answering questions, standing orders and adding to the ledger.
keywords: [desk, question, approval, blocking, standing order, ledger]
order: 8
---

The **desk** is where every question and approval reaches you. Cards do not move forward until you answer. The Desk page shows every item waiting for your decision, ordered by how urgent it is.

## Desk items {#desk-items}

Each item shows:

- **What kind it is**: a label like Question, DevOps approval, Merge approval, Outbound update, Escalation or Vault conflict.
- **Who asked**: the agent and its role.
- **What they are doing**: which card or project.
- **The question**: with options and a recommendation.
- **How many cards are blocked**: a count of cards waiting on this answer.
- **Urgency**: the item's age, how many cards depend on it, and whether work is stopped.

Some items are urgent: approval requests, blocking questions, pinned alerts and cards that keep failing. Everything else can wait up to 10 minutes while your BA reviews it first (if you have routing on).

## Blocking {#blocking}

An item is **blocking** when cards cannot move until you answer it. For example, a large merge waits for your approval, or an agent needs a decision before it can continue.

Blocking items go to the top of the desk and show a count of blocked cards. Answer them first to keep work moving.

## Answering a question {#answering}

To answer a desk item:

1. Click the item.
2. Choose an option or type an answer (the recommended option is pre-selected).
3. Click **Answer**.

Your answer is recorded in the ledger (shared with future agents), the card is unblocked, and the asking agent's next shift includes your answer.

You can also add the answer to the ledger as a permanent decision or requirement at the same time, or skip that and answer the question only.

## Standing orders {#standing-orders}

**Standing orders** are recurring instructions that show up in every agent's shift. Use them for:
- Team policies (e.g., "all PRs must have unit tests").
- Context (e.g., "we are migrating from X to Y").
- Decisions that affect multiple cards (e.g., "use the new auth system").

To add a standing order:

1. Go to **Ledger**.
2. Click **Add standing order**.
3. Enter the text and choose the scope: whole organization, a specific project, or a specific role.

Standing orders show up in agents' shift instructions automatically.

You can also create standing orders when answering a desk question. Pick what kind of answer it is and it will be added when you click **Answer**.

## Adding to the ledger {#adding-to-ledger}

When you answer a desk question, you can save it to the ledger as:

- **Decision**: a one-time choice, recorded for history.
- **Requirement**: a permanent rule (appears like a standing order but is recorded as a rule, not an instruction).
- **Standing order**: a team-wide instruction (see above).

To add it, on the desk item click the menu or look for a "save this to the ledger" option, choose which kind, and click **Answer**. The ledger stores it and future agents can search it.

Even if you do not save the answer, it is kept in the ledger as part of the item's history.
