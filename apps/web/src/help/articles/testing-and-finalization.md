---
title: Testing and finalization
summary: The test stage, how finished work lands (main or a pull request), simple and expert mode, the full suite and regression runs.
keywords: [test, finalize, merge, PR, pull request, how finished work lands, protected branch, expert mode, simple mode, git, completion action, mark merged, regression, full suite]
order: 11
---

After a card is reviewed and approved, it moves to the Test stage where a tester runs E2E tests. Once tests pass, the card moves to Finalize where its work lands the way the project says: straight into main, or as a pull request for you to approve. A full test suite runs after each finalized card, unless you switch that off in the project settings.

## Test stage {#test-stage}

When a card reaches Test, a tester runs the E2E tests from the test plan. If tests pass:

- The card moves to Finalize, or to Docs first if the card is marked **Docs needed** (a technical writer documents it, then it moves on to Finalize).

If tests fail:

- A bug card is created on the same branch, linked to the original card.
- The original card shows a **waiting on bug** badge.
- The bug goes to a builder, then Review, on the same branch.
- Once the fix has passed review, the original card is tested again.

Testers use browsers (Playwright and Chromium). Their sandbox allows Unix sockets so browsers work, but other system access is blocked.

Playwright's test output folders (`test-results/`, `playwright-report/`, `blob-report/`) are discarded after the shift and never committed to your repository.

## Finalization {#finalization}

At the Finalize stage, your BA ships the work the way the project says. In each project's settings, **How finished work lands** is either **Straight into main after review and test** (the default) or **As a pull request I approve**. If the main line is protected on the code host, Guildwise opens a pull request instead, switches the project to pull requests and tells you on the card. On the card you see plain results: *"Your change is live on main"* or *"Waiting for you to merge the pull request"*.

With **expert mode** on (Settings), each card also has its own **completion action**, which the BA may revise:

- **PR**: Push the branch to the git host and open a pull request (when the workstation is connected to the host), or ask the desk if it cannot.
- **Push branch**: Push the branch to the git host without opening a pull request.
- **Merge**: Merge the card's branch into the project's working branch. Small cards merge directly; large cards wait for your approval on the desk (**Approve merge**).

After the action, the branch is removed and the card moves to Done. If the card's changes clash with other work on the way in, the DevOps engineer tries to fix that first (see [When two branches conflict](/help/devops-and-hygiene#conflicts)).

A merge is large when the card's risk tier is large (see Board and cards). The project owner can let large merges through without waiting for you: open the project's settings, go to **Merging**, and click **Merge large changes without my approval** (off by default; you are asked to confirm).

## Simple mode and expert mode {#expert-mode}

You do not need to know git to use Guildwise HQ. By default (simple mode) cards and the desk speak in results: *"Goes into main after review and test"*, *"Your change is live on main"*, *"Waiting for you to merge the pull request"*. Guildwise picks the repository's default branch as the main line, keeps branch names out of sight, and only asks you about branches when it cannot work them out itself.

If you know git and want the details, open **Settings** and tick **Show me branches and git controls** under **Expert mode for code changes**. It is per person, off by default, and only changes what you see. With it on you also get:

- the working-branch field in the project's repository settings, and questions about keeping or changing the working branch when a new intake or phase starts;
- the **Completion action** per card (see above);
- branch names and commit details on cards;
- **Mark merged** on the phase page (see [Phases and follow-ups](/help/phases#phase-done));
- the folder questions in the workstation installer.

## Full suite and regression {#full-suite}

After finalization, a **full suite** card is created for testers to run the entire E2E suite once. A test-side failure (a flaky test, data or environment) is fixed by the tester; a genuine bug becomes a new bug card and you get a notice. These failures do not block merges.

If you do not want these extra cards, open the project's **Settings**, find **Full test run after each card** and untick **Run the full end-to-end test suite after each finished card**. It is on by default. The project Owner and the organization's Owners and Admins can change it; everyone else sees it read-only. Turning it off only stops new suite cards; the normal testing of every card stays as it is.

To run a regression suite, open the project's board and click **Run regression**, pick the **Platform** (Web, Mobile or Both) and click **Run**. One regression card per platform is queued for the testers. The button only appears on projects with a test stage.
