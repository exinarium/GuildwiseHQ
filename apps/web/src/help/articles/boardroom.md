---
title: Boardroom
summary: Put a question to personas and agents, run by a Chair. Interject, keep a whiteboard, and turn the minutes into a PRD.
keywords: [boardroom, chair, persona, cast, optimist, devil's advocate, debate, pre-mortem, six hats, red team, whiteboard, minutes, mention, budget, time limit, score, round, rooms, PRD, archive]
order: 12
---

A **boardroom** is a group conversation about one question, run by a **Chair** who picks the speakers, avoids early agreement, records disagreements and asks you when a decision is yours.

## Start a boardroom {#start}

Sidebar, **Boardroom**, **New boardroom** (any member).

1. Click **Boardroom** in the sidebar and then **New boardroom**.
2. Write the **topic** and, if you like, a **brief** (context, constraints, and the options if you want them scored).
3. Pick a **format**: open discussion, pre-mortem, red and blue team, six hats, or option scoring.
4. Choose the **cast**: always an **Optimist** (argues the upside) and a **Devil's Advocate** (attacks edge cases and failure modes), which cannot be removed, plus 3 or 4 other seats (5 or 6 in all): library personas, approved pack personas, your own agents, or personas cast from a one-line brief. **Suggest a cast** asks the Chair for the others; **Save this cast as a room** reuses it.
5. Pick the **workstation** (one of yours), a **round cap**, an optional **cost limit** and **time limit** (empty means none), and the models if you want to choose them. Personas and the Chair run on cheap models by default; the minutes use a stronger one.

You manage the boardroom you start. Others in it can talk, add notes and vote; an Owner or Admin who is in it can override you.

## How a session runs {#session}

Round 1 is independent: each seat answers from your topic and brief alone, then all are revealed.

- Then the Chair picks two or three speakers per round (the line "Chair picks" says who and why). If answers agree too easily it calls a **dissent round**.
- When only you can decide, it **pauses** with a decision card. Disagreements are recorded, not reconciled. Replies are short.
- The session ends on **End session** or the round cap.

## Talk to the room {#interject}

Type in the box at the bottom at any time. **@name** (or **@all**) calls on a seat: one that has not spoken in this round speaks next. **Pause** stops anything new from starting.

## The whiteboard {#whiteboard}

Sticky notes in five columns (Ideas, Risks, Questions, Decisions, Parked). Seats add notes; you can add, edit, drag, vote **+1**, **merge** and delete. In **option scoring**, a table shows each seat's 1 to 5 score per option and the totals; it is in the minutes too.

## Cost and time limits {#cost}

The meter shows the cost so far and the estimate for the **next round**. With a **cost limit**, no new turn starts once it is used up; raise it or end the session. If it runs out before the Chair can write the minutes, you choose: **Write minutes without the Chair's summary**, or **Raise the limit**.

A **time limit** is a countdown. About 5 minutes before the end the Chair moves to a final round. At time-up nothing new starts until you **Extend** (+10, +15, +30) or **Wrap up now** (minutes). Paused time does not count, but time spent waiting for your decision does. You get a push notification at the warning and at time-up (switch it off under Notifications).

## Minutes and the PRD {#minutes}

When the session ends, or on **Write minutes now**, the Chair writes the **minutes** (positions, agreements, open disagreements, decisions, whiteboard) into **Documents**.

**Pull into PRD** starts a Discovery session in the capture phase (with your CEO, when you have one), with a PRD draft seeded from the minutes, the decisions and the whiteboard. Both sessions link to each other.

A finished boardroom can be **archived** (read-only). Archiving one that is still running asks you to confirm: it ends the room and writes the minutes first, then archives it.

A boardroom can be **deleted** by its creator or an Owner or Admin; an archived or **deleted** by its creator or an Owner or Admin.
