---
title: Phases and follow-ups
summary: Creating phases, adding cards, when a phase is done, follow-ups, deploy and regression.
keywords: [phase, follow-up, deploy, regression, release, shipment]
order: 12
---

A **phase** is a named slice of work you want to ship together: "Phase 2: autosave" or "Sprint 3". When all the cards in a phase are finished and merged, you decide what happens next: deploy, run regression tests, or something custom. Nothing runs until you approve.

## Setting up {#setting-up}

To set up what can happen after a phase is done, open the project's settings (the gear on its board) and go to **Phases and deploys**. There you configure:

- **Set up deploys**: a guided wizard for non-coders. Pick a test copy or the live site, say where it runs (this computer or your own server), and Guildwise looks at what is already running, shows what it found, what each update will do and what it will not touch, then saves the steps. Try it without changing anything, and the Owner approves. Never stops your database or other containers. **Let DevOps look at it first** suggests the whole setup for you to review.
- **Deploy targets**: where a phase can be deployed. A local Docker stack deploys on every member workstation (not in a GitHub Codespace, which cannot run Docker: see [Cloud workstations](/help/cloud-workstations#codespaces)). A remote host deploys over SSH, using the DevOps engineer of the workstation you choose. No passwords or keys are stored in the app.
- **Default follow-ups**: the list every new phase starts with (e.g., Deploy to local, then Regression run). Click **Save defaults** after changing it.

Deploy and regression follow-ups need a repository on the project, and regression needs a test stage. In research projects or projects without repositories, **Add deploy** and **Add regression run** are greyed out (a phase has at most 10 follow-ups; **Add custom** is the third kind).

## Creating a phase {#creating-a-phase}

To create a phase:

1. Open the project's settings and go to **Phases and deploys**.
2. Click **New phase**.
3. Enter a name and an optional description.
4. Set the follow-ups that should happen when it is done (it starts with your defaults).
5. Click **Create phase**.

Cards join the phase afterwards: from the card's own page, or with **Add a card** on the phase page (reached from the list in the same settings section).

You can also let the BA propose a phase during intake: it will suggest the cards and follow-ups, and you confirm them on the desk.

## Phase done {#phase-done}

A phase is **done** when:

- Every card is finalized and its work is live on main, OR
- The card is closed by hand or cancelled.
- Research cards count as done when their note is published.
- Cards that arrived as a pull request count once the runner sees the pull request merged (it checks every few minutes).

With [expert mode](/help/testing-and-finalization#expert-mode) on, and if the runner cannot see the merge (a squash merge or deleted branch), click **Mark merged** on the phase page.

Full E2E suites that run after a merge never delay a phase: they are listed as passed, failed or still running.

## The "phase done" desk item {#followups}

When all cards are done, your BA writes a report and the desk shows a **Phase done** item titled like "PH-1 Autosave is done: approve 2 follow-ups?".

You can:

- **Edit follow-ups**: add, remove, reorder or change deployment targets, then **Save**.
- **Approve all N** (or **Approve the follow-up** when there is one): the follow-ups run in order, one at a time.
- **Reject**: nothing runs.
- **Reopen phase**: give a reason and the phase waits for its cards again (possible until you approve).

With no follow-ups the item is just an acknowledgement (**Acknowledge**).

If no BA is online (none hired or offline for 15 minutes), the server writes a template report so you are never left waiting.

## What runs after you approve {#what-runs-after}

Once you approve, the follow-ups are locked and run one at a time in order:

- **Deploy**: becomes DevOps request(s) with the target's details.
- **Regression run**: becomes a regression card pinned to the workstation you just deployed, testing against that target.
- **Custom item**: goes to DevOps, a tester or the BA.

If any follow-up fails, the ones after it are skipped. At the end, a **Phase results** notice lists each result with evidence (pinned when something failed); click **Acknowledge** to close it.

The phase page shows live progress, the DevOps requests, regression cards and the full results thread.

## Deploying with a recipe {#delivery-recipes}

A project can deploy in two ways, chosen under **Delivery** in the project settings: **Instructions** (a DevOps request written in words, as before) or **Recipe**. A recipe is a small script kept in the project's vault, in a `delivery/` folder, that always does the same steps: deploy, wait until the app is healthy, run a smoke check. It names its environments, where each one goes, when it runs (after a merge, after a phase, or on request) and **who releases it**: you (the release queue), the CEO, or automatically once its gate holds.

- **Set it up by talking to the CEO**: "set up deploys for this project". The CEO asks about the environments, targets, gate and secrets, and DevOps writes the scripts and tries them. You then see the recipe under Delivery, with what it will do and what changed since the last version.
- **You approve one exact version** with the **Approve this version** button (only the Owner). If anyone edits the recipe afterwards, it needs a new approval and nothing deploys from it meanwhile.
- **A model never runs a deploy command.** It can only ask Guildwise; Guildwise checks the approved version and the gate (an earlier environment healthy on the same commit, tests passed, a time window, a freeze), and your workstation runs the script itself. Secrets are named in the recipe, set on your workstation from the Delivery section and never stored on the server or in the vault.
- **The release queue** (under **Deploys**) lists releases that are ready: the commit, the environment and the servers. An Owner or an Admin presses **Release** and, when an environment has several servers, ticks the ones to release to. The CEO releases by itself only where the recipe names it.

The recipe lives in the project vault. A git vault is backed up with its repository; a local vault is a folder on the Owner's workstation that you back up yourself (put it in OneDrive, iCloud or another backed-up folder).
