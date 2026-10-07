---
title: Your BA reporter
summary: What goes through the BA, signals the server watches for, daily floor report and time zone.
keywords: [BA, reporter, business analyst, floor report, signal, routing]
order: 13
---

Your **BA** (business analyst) is an AI agent that acts as your eyes and ears on the floor. With routing on, it reviews every question and alert first, answers what it can from the ledger, and passes the rest to your desk with helpful context.

## What goes through the BA {#what-goes-through-the-ba}

With routing on (the default; the Owner and Admins can turn it off in **Settings**):

- **Urgent items reach your desk at once, unchanged**: blocking questions, approvals (DevOps, merges, outbound updates), pinned alerts and cards that keep failing. The BA adds a note a little later with how often it was asked, what the ledger says, and what it recommends.
- **Everything else** (e.g., "bug reported" or "posting failed" alerts) is held for the BA for up to 10 minutes. The BA passes it on (often with a note), folds duplicates into one item, or dismisses noise it can show is already covered.
- **Non-blocking questions** reach your BA before colleagues. It answers from the ledger when it can, otherwise escalates with the context you need.
- **The BA never blocks anyone.** If an item has not been looked at within 10 minutes, it reaches you unchanged ("Your BA had not looked at this in time"). With no BA online, nothing is held and everything reaches you at once.

Untick **Route agent-raised items through the BA first** in **Settings** to see everything as it is raised, with no BA filtering. This applies to the whole organization.

## Signals the server watches for {#signals}

The server checks the floor every minute without using tokens. The BA only works when something fires. Here are the signals it watches:

**A card keeps failing** (3 failed shifts in 10 minutes): you hear about it at once, with the BA's analysis in the loop alert.

**Same approval again and again** (the same approval 3 times in 24 hours, or at once if rejected before): you hear about it in the daily report, or at once if it was rejected.

**Blocked too long** (a blocked card waits more than 4 hours): you hear about it in the daily report.

**Nobody can take it** (a queued card nobody is able to take for 30+ minutes): you hear about it in the daily report.

**Repeated failures** (a card in rework round 3, or failed finalize twice): you hear about it in the daily report.

**Repository hygiene problem** (DevOps could not resolve a conflict, missing clone, etc.): you hear about it in the daily report under Failures.

**Budget** (a project used 80% of its monthly budget, or 100% and paused): at 80% it is in the daily report (the desk also gets a Budget warning); at 100% you get an urgent desk item at once.

A signal appears once however long it lasts and clears by itself when the cause is gone. A notice the BA posted is then acknowledged for you.

## Floor report {#floor-report}

At **08:00 on your clock**, the BA posts one **Floor report** on your desk (only on days with something to say; urgent notices never wait).

The report lists:
1. Phases waiting or open.
2. Stuck, blocked and backing-off cards.
3. Repeated approvals.
4. Failures, including interests that cannot run.
5. Open DevOps requests.
6. What the BA resolved without bothering you.
7. **Spend**: what the team cost since the last report and this month, which projects cost most, and projects near or over budget.
8. **Interests highlights**: the top items from each interest since the last report.

Click **The facts behind this report** to see the same data straight from the server with links. Ask "why?" in your BA's standing chat (one per organization) to discuss the report.

With no BA available, the server posts a template report and passes items on unchanged.

## Time zone and report time {#time-zone}

Under **Settings**, **Your time zone** sets the clock for your own account (the app takes it from your browser the first time you sign in; until one is set, reports use UTC). The daily floor report follows the **Owner's** time zone.

Also under **Settings**, **Daily floor report at** sets the time of the report itself (default 08:00): pick a different time if that does not work for you and click **Save time**. The Owner and Admins can change the time and the routing; other members see them read-only. Urgent notices never wait for this time.
