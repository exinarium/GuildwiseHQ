---
title: Testing and finalization
summary: The test stage, how finished work lands (working branch or pull request), the main and working branch, expert mode, the full suite and regression runs.
keywords: [test, finalize, merge, commit and push, main branch, working branch, PR, pull request, how finished work lands, protected branch, expert mode, simple mode, git, completion action, mark merged, regression, full suite]
order: 11
---

After a card is reviewed and approved, it moves to the Test stage where a tester runs E2E tests. Once tests pass, the card moves to Finalize where its work lands the way the project says: committed and pushed to the working branch, or as a pull request for you to approve. A full test suite runs after each finalized card, unless you switch that off in the project settings.

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

At the Finalize stage, your BA ships the work the way the project says. Every project repository has two branches, named in the project's repository settings:

- the **main branch** is where pull requests go (default: the repository's default branch);
- the **working branch** is where finished card work is combined. It can be the same branch as the main branch. If it does not exist, Guildwise creates it from the main branch and pushes it when the first card starts, and the repository settings say when.

Agents work on a card branch of their own. In each project's settings, **How finished work lands** is either **Commit and push to the working branch (no pull request)** (the default) or **Pull request I approve**. If the working branch is protected on the code host, Guildwise opens a pull request instead, switches the project to pull requests and tells you on the card. On the card you see plain results: *"Your change is live on main"* or *"Waiting for you to merge the pull request"*.

With **expert mode** on (Settings), each card also has its own **completion action**, which only you change (the BA never does):

- **Commit and push to the working branch**: no pull request. The card's branch is merged into the working branch and the working branch is pushed. Small cards go straight in; large cards wait for your approval on the desk (**Approve merge**).
- **Pull request**: push the card branch to the git host and open a pull request into the working branch (the main branch when you use one branch), when the workstation is connected to the host, or ask the desk if it cannot.

A card branch only reaches the git host when the work goes out as a pull request; with **Commit and push to the working branch** it stays on the workstation.

When the working branch is not the main branch, the project owner opens the pull request that carries the work to the main branch from the repository's row in the project settings (**Open pull request: develop to main**); a runner on a workstation that has the repository opens it through the git host.

After the action, the branch is removed and the card moves to Done. If the card's changes clash with other work on the way in, the DevOps engineer tries to fix that first (see [When two branches conflict](/help/devops-and-hygiene#conflicts)).

A change that is committed to the working branch is large when the card's risk tier is large (see Board and cards). The project owner can let large merges through without waiting for you: open the project's settings, go to **Merging**, and click **Merge large changes without my approval** (off by default; you are asked to confirm).

## Simple mode and expert mode {#expert-mode}

You do not need to know git to use Guildwise HQ. By default (simple mode) cards and the desk speak in results: *"Goes into the working branch after review and test"*, *"Your change is live on the working branch"*, *"Waiting for you to merge the pull request"*. Guildwise picks the repository's default branch as the main branch and working branch, keeps branch names out of sight, and only asks you about branches when it cannot work them out itself.

If you know git and want the details, open **Settings** and tick **Show me branches and git controls** under **Expert mode for code changes**. It is per person, off by default, and only changes what you see. With it on you also get:

- questions about keeping or changing the working branch when a new intake or phase starts (the main and working branch rows in the repository settings are shown to everyone);
- the **Completion action** per card (see above);
- branch names and commit details on cards;
- **Mark merged** on the phase page (see [Phases and follow-ups](/help/phases#phase-done));
- the folder questions in the workstation installer.

## Manual QA {#manual-qa}

After a card is finalized it goes to **QA** (when the project has it on, which is the default): the person who started the card gets a desk item and an agent writes test steps on the card. They **Pass** it, **Skip the test**, **Send back** with a comment (the card returns to rework and goes through finalize and QA again) or **Give it to someone else**. The update on the ticket is held until the card passes or the test is skipped; then the card moves to Done. Switch it off in the project's **Settings**, **Manual QA before done**.

## Full suite and regression {#full-suite}

After finalization, a **full suite** card is created for testers to run the entire E2E suite once. A test-side failure (a flaky test, data or environment) is fixed by the tester; a genuine bug becomes a new bug card and you get a notice. These failures do not block merges.

If you do not want these extra cards, open the project's **Settings**, find **Full test run after each card** and untick **Run the full end-to-end test suite after each finished card**. It is on by default. The project Owner and the organization's Owners and Admins can change it; everyone else sees it read-only. Turning it off only stops new suite cards; the normal testing of every card stays as it is.

To run a regression suite, open the project's board and click **Run regression**, pick the **Platform** (Web, Mobile or Both) and click **Run**. One regression card per platform is queued for the testers. The button only appears on projects with a test stage.
