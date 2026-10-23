---
title: Boardroom
summary: Put a question to personas and agents, run by a Chair. Interject, keep a whiteboard, and turn the minutes into a PRD.
keywords: [boardroom, chair, persona, cast, debate, pre-mortem, six hats, red team, whiteboard, minutes, mention, budget, round, rooms, PRD]
order: 12
---

A **boardroom** is a group conversation about one question. A **Chair** runs it: it chooses who speaks, makes sure the room does not agree too early, records disagreements instead of smoothing them over, and stops to ask you whenever a decision is yours. You can speak at any time.

## Start a boardroom {#start}

1. Click **Boardroom** in the sidebar (Owner and Admin) and then **New boardroom**.
2. Write the **topic** and, if you like, a **brief** (context, constraints, and the options if you want them scored).
3. Pick a **format**: open discussion, pre-mortem, red and blue team, six hats, or option scoring.
4. Choose the **cast**, two to eight seats: library personas (devil's advocate, user advocate, creative strategist, cost hawk, security, ops, small-business customer), your own agents (they speak with their own role), and personas cast from a one-line brief ("a cautious compliance officer"). **Suggest a cast** asks the Chair to propose voices for your topic. **Save this cast as a room** to use it again.
5. Set a **round cap**, an optional **budget**, and the models if you want to choose them. Personas and the Chair run on cheap models by default; the minutes use a stronger one.

## How a session runs {#session}

- **Round 1** is independent: every seat answers using only your topic and brief. Answers stay sealed until the last one is in, then all are revealed together, so nobody follows the first speaker.
- After that the Chair picks two or three speakers for each round, never the same speaker twice in a row. The line "Chair picks" shows who and why.
- If the answers agree too easily, the Chair calls a **dissent round**: someone steel-mans the other side.
- When the Chair reaches a choice only you can make, it **pauses** and shows a decision card. Choose an option or write your own; the session goes on.
- **Disagreements are recorded, not reconciled.** They appear in the minutes as they stand.
- Replies are kept short (about 150 words); a longer one is cut.
- The session ends when you click **End session** or the round cap is reached.

## Talk to the room {#interject}

Type in the box at the bottom at any time; what you write is part of what the next round sees. Type **@** to call on a seat by name: a mentioned seat speaks in the next round. **@all** calls on everyone. **Pause** stops anything new from starting; nothing is lost.

## The whiteboard {#whiteboard}

Sticky notes in five columns: **Ideas**, **Risks**, **Questions**, **Decisions** and **Parked**. The seats add notes as they speak. You can add your own, edit, drag a note to another column (or use its Move menu), vote **+1**, **merge** several notes into one, and delete. Notes written during the sealed first round appear when it is revealed.

## Cost {#cost}

The meter shows what the session has cost and what the **next round** is estimated to cost (the number of speakers times what a turn has cost so far). With a **budget** set, no new turn starts once it is used up; raise it to continue, or end the session and still get the minutes.

## Minutes and the PRD {#minutes}

When the session ends, or when you click **Write minutes now**, the Chair writes the **minutes** with a stronger model: the topic, the cast, each participant's position, what was agreed, the unresolved disagreements, the decisions, a snapshot of the whiteboard and the open questions. They are saved as a document in **Documents**.

**Pull into PRD** starts a Discovery session in the capture phase (with your CEO, when you have one), with a PRD draft seeded from the minutes, the decisions and the whiteboard. Both sessions link to each other.
