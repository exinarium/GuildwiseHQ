---
title: The daily report and what is watched
summary: What your CEO triages, the signals the server watches for, the daily report, scheduled tasks and the time zone.
keywords: [CEO, BA, reporter, business analyst, daily report, signal, routing]
order: 13
---

Your **CEO** is the AI agent that reports to you: it is woken when something needs a look, triages what agents raise, and writes one report a day. The **BA** (business analyst) is a spec writer only: it turns requests and tickets into cards and finishes finished work. It no longer reports on the floor (older reports it wrote stay on your desk).

## What goes through the CEO {#what-goes-through-the-ceo}

- **Urgent items reach your desk at once, unchanged**: blocking questions, approvals (DevOps, merges, outbound updates), pinned alerts and cards that keep failing. The CEO is woken for them too and acts within the rules you gave it.
- **Everything else** (for example "bug reported" or "posting failed" alerts) is held for the CEO for up to 10 minutes. The CEO passes it on, folds duplicates into one item, or dismisses noise it can show is covered.
- **The CEO never blocks anyone.** If an item has not been looked at within 10 minutes, it reaches you unchanged ("The CEO had not looked at this within the time limit"). When the CEO cannot run (its workstation is offline, or you paused it), nothing is held and everything reaches you at once; after 30 minutes of something urgent waiting you get a notice and an e-mail.
- **Blocking questions from agents** that nobody answers are passed on, to the CEO when it is active; see [Questions from agents and escalation](/help/your-ceo#escalation).
- There is no switch for this any more: the CEO is always there. **Pause** on the CEO page is the emergency stop.

## Signals the server watches for {#signals}

The server checks the floor every minute without using tokens. The CEO only works when something fires. Here are the signals it watches:

**A card keeps failing** (3 failed shifts in 10 minutes): you hear about it at once.

**Same approval again and again** (the same approval 3 times in 24 hours, or at once if rejected before): you hear about it in the daily report, or at once if it was rejected.

**Blocked too long** (a blocked card waits more than 4 hours): you hear about it in the daily report.

**Nobody can take it** (a queued card nobody is able to take for 30+ minutes): you hear about it in the daily report.

**Repeated failures** (a card in rework round 3, or failed finalize twice): you hear about it in the daily report.

**Repository hygiene problem** (DevOps could not resolve a conflict after two attempts, missing clone, etc.): you hear about it in the daily report under Failures. See [Repository hygiene](/help/devops-and-hygiene#hygiene).

**High-risk card waiting** (a card the reviewer rated high risk has waited more than 24 hours for the owner's approval or for a merge approval): you hear about it in the daily report under stuck cards. The CEO only reports it; it never approves or escalates by itself. Cards with no risk call (older runners, or after a rework round) do not count, and custom approval steps you add in the workflow builder are not covered.

**Budget** (a project used 80% of its monthly budget, or 100% and paused): at 80% it is in the daily report (the desk also gets a Budget warning); at 100% you get an urgent desk item at once.

A signal appears once however long it lasts and clears by itself when the cause is gone.

## The daily report {#floor-report}

At **08:00 on your clock** (change it on the CEO page, **Reporting & alerts** tab), the CEO writes your daily report (only on days with something to say; urgent notices never wait). On your desk the item is labelled **Daily report**; older daily reports, written by the BA, stay on the desk with the same label.

The report lists:
1. What needs you.
2. The decisions the CEO took, with Undo.
3. Phases waiting or open.
4. Stuck, blocked and backing-off cards, including high-risk cards waiting for approval.
5. Repeated approvals.
6. Failures, including interests that cannot run.
7. Open DevOps requests.
8. **High-risk cards finished**: cards the reviewer rated high risk that finished (merge, PR or push) since the last report (left out when there are none).
9. **Spend** and **Interests highlights**.

Click **The facts behind this report** to see the same data straight from the server. Discuss it in the CEO chat. If the CEO cannot run, the server posts a template report with the same facts.

Older daily reports, written by the BA, stay on your desk and in their chat as they were; nothing new is written there.

## Scheduled tasks {#scheduled-tasks}

A schedule's **Ask the BA** action (the name stays so old schedules keep working) now asks your **CEO**: it does what the instructions say, read-only, and delivers the answer as a notice on your desk. If the CEO could not run for two hours you get a notice that the task was skipped.

## Time zone and report time {#time-zone}

Under **Settings**, **Your time zone** sets the clock for your own account (the app takes it from your browser the first time you sign in; until one is set, reports use UTC). The daily report follows the **Owner's** time zone. The report time itself is on the CEO page.
