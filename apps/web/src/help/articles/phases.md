---
title: Phases and follow-ups
summary: Creating phases, adding cards, when a phase is done, follow-ups, deploy and regression.
keywords: [phase, follow-up, deploy, regression, release, shipment]
order: 12
---

A **phase** is a named slice of work you want to ship together: "Phase 2: autosave" or "Sprint 3". When all the cards in a phase are finished and merged, you decide what happens next: deploy, run regression tests, or something custom. Nothing runs until you approve.

## Setting up {#setting-up}

To set up what can happen after a phase is done, open the project's **Environments** page (in the sidebar, under the board). Where your app runs is set up there, in one place: see [Environments](/help/phases#delivery-recipes). The phase-specific parts are:

- **What a new phase does when it is finished** (on the Environments page, under **Rules**): the list every new phase starts with, for example "Release to the test site, then to the live site (it waits for you)". A follow-up that releases picks an **environment**, not a technical target. Click **Save** after changing it.
- **New phase** (project settings, **Phases**): enter a name and a description, set the follow-ups, then **Create phase**.

Deploy and regression follow-ups need a repository on the project, and regression needs a test stage. In research projects or projects without repositories, **Add deploy** and **Add regression run** are greyed out (a phase has at most 10 follow-ups; **Add custom** is the third kind).

## Creating a phase {#creating-a-phase}

To create a phase:

1. Open the project's settings and go to **Phases**.
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

## Environments: where your app runs {#delivery-recipes}

The **Environments** page of a project (sidebar, under the board) has one place for everything about running your app:

- **Your app: how to start it.** The steps that start the app. Test copies and environments on a computer that does not already run use them. Press **Scan with DevOps** (it reads the project and suggests the steps and the environments; it asks real questions with fields, and nothing is saved until you press **Use this**) or **Set up myself**.
- **Test copies**: one temporary copy per card, thrown away after the card. It shows how many run now and how long a failed copy is kept.
- **Environments**: the **test site** (always on, updates by itself after each merge), the **live site** (goes out only when you release it, after the test site is healthy, and you approve every release) and any extra site (a demo, a second live site). Each card shows the place it runs, its address, when it updates, its rules, and three steps: **Saved**, **Tried**, **Approved**. **Add an environment** is always there. A card has **Update now** or **Release**, and a **...** menu with **Edit**, **Change place** and **Remove**.
- **Places**: the computers and servers the project uses, each listed once, with what uses it and whether it can be reached. **Add a server** uses a sign-in this computer already has, or **Connect a new server** (address, user name, then a password used once, a key file, or a key you paste into your hosting panel; Guildwise shows the server's fingerprint for you to confirm first). A place nothing uses can be removed (optionally with Guildwise's own key on the server); a place that looks like another one offers **Merge**. **Move to a new server** copies the app and its data to another server and keeps the old one as a standby until the Owner retires it.
- **Rules** and **History**.

**What is already running is found first.** When you add an environment Guildwise looks at the place (read-only) and lists what it found: a Docker app, or an app that runs directly on the machine (a system service, a pm2 process or a program), with its folder and port. If it is not there, **My app is somewhere else** takes a folder, and the page says where it looked. Then it shows **Found and will be used**, **Each update will** and **Will not be touched**.

**How new versions get onto a server.** For a Docker app on a server you choose: **Build here and copy it** (the default), **Download a ready-made app from a registry**, or **Build it on the server**. For an app that runs directly on the machine each update gets the new version, builds it in a new folder, switches to it and restarts it the way you confirmed (the service, pm2, or a command), and keeps the last versions so you can go back. Docker apps and direct apps use the same cards.

**Try, then approve.** Press **Try it without changing anything** on each environment (it checks and prints what it would do), then the Owner presses **Approve**. Approval needs a successful try of exactly that version. Guildwise only restarts the app, never stops the database or the rest, backs up the database first when asked, and puts the previous version back if the site does not become healthy.

**Remove.** Removing an environment, a place or an old draft always says what happens and what is not touched: the running app is left exactly as it is.

A project can deploy in two ways, chosen under **Delivery**: **Instructions** (a DevOps request written in words) or **Recipe** (the guided setup above, kept in the project vault in a `delivery/` folder). **Stop using guided deploys** (under technical details) goes back to instructions and keeps your places.

- **You approve one exact version** with **Approve** (only the Owner). If anything changes afterwards it needs a new approval and nothing deploys from it meanwhile.
- **A model never runs a deploy command.** It can only ask Guildwise; Guildwise checks the approved version and the rules (a test site healthy on the same version, tests passed, a time window, a freeze), and your workstation runs the steps itself. Secrets are named in the setup, set on your workstation and never stored on the server or in the vault.
- **Releases** (sidebar, Organization) is where a ready version waits for you: **Waiting for you**, **What is live** (the version on every site, readable by everyone), **History** (with the rules that held and who released) and **Rules**. The Owner or an Admin presses **Release**; **Go back to an earlier version** (on the live card) puts an earlier release back at once, your data is not rolled back.

The recipe lives in the project vault. A git vault is backed up with its repository; a local vault is a folder on the Owner's workstation that you back up yourself (put it in OneDrive, iCloud or another backed-up folder).
