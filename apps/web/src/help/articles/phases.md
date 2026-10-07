---
title: Phases and follow-ups
summary: Creating phases, adding cards, when a phase is done, follow-ups, deploy and regression.
keywords: [phase, follow-up, deploy, regression, release, shipment]
order: 12
---

A **phase** is a named slice of work you want to ship together: "Phase 2: autosave" or "Sprint 3". When all the cards in a phase are finished and merged, you decide what happens next: deploy, run regression tests, or something custom. Nothing runs until you approve.

## Setting up {#setting-up}

To set up what can happen after a phase is done, go to **Projects > Settings > Phases** and configure:

- **Deploy targets**: where a phase can be deployed. A local Docker stack deploys on every workstation. A remote host deploys over SSH using a workstation's runner.
- **Default follow-ups**: the list every new phase starts with (e.g., Deploy to local, then Regression run).

Deploy and regression follow-ups need a repository on the project, and regression needs a test stage. In research projects or projects without repositories, these buttons are greyed out.

## Creating a phase {#creating-a-phase}

To create a phase:

1. Go to **Projects > Settings > Phases**.
2. Click **New phase**.
3. Enter a name and description.
4. Pick which cards belong to it (optional: you can add cards later).
5. Set the follow-ups that should happen when it is done.
6. Click **Create**.

You can also let the BA propose a phase during intake: it will suggest the cards and follow-ups, and you confirm them on the desk.

## Phase done {#phase-done}

A phase is **done** when:

- Every card is finalized and its work is merged into the working branch, OR
- The card is closed by hand or cancelled.
- Research cards count as done when their note is published.
- Cards finalized with PR or push branch count once the runner confirms the branch is merged (it checks every few minutes).

If the runner cannot see the merge (a squash merge or deleted branch), click **Mark merged** on the phase page.

Full E2E suites that run after a merge never delay a phase: they are listed as passed, failed or still running.

## The "phase done" desk item {#followups}

When all cards are done, your BA writes a report and the desk shows **Phase done: approve N follow-ups?**

You can:

- **Edit follow-ups**: add, remove, reorder or change deployment targets.
- **Approve all**: the follow-ups run in order (one at a time).
- **Reject**: nothing runs.
- **Reopen the phase**: it waits for its cards again (possible until you approve).

With no follow-ups the item is just an acknowledgement.

If no BA is online (none hired or offline for 15 minutes), the server writes a template report so you are never left waiting.

## What runs after you approve {#what-runs-after}

Once you approve, the follow-ups are locked and run one at a time in order:

- **Deploy**: becomes DevOps request(s) with the target's details.
- **Regression run**: becomes a regression card pinned to the workstation you just deployed, testing against that target.
- **Custom item**: goes to DevOps, a tester or the BA.

If any follow-up fails, the ones after it are skipped. At the end, a **Phase results** notice lists each result with evidence (pinned when something failed).

The phase page shows live progress, the DevOps requests, regression cards and the full results thread.
