---
title: Testing and finalization
summary: Test stage, finalization with pull requests and merging, full suite and regression.
keywords: [test, finalize, merge, PR, regression, full suite]
order: 11
---

After a card is reviewed and approved, it moves to the Test stage where a tester runs E2E tests. Once tests pass, the card moves to Finalize where its work is shipped (pull request, pushed branch or merge). A full test suite runs after each finalized card.

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

- **PR**: Push the branch to GitHub and create a pull request (if `gh` is available), or ask the desk if it is not.
- **Push branch**: Push the branch to GitHub without creating a PR.
- **Merge**: Merge the card's branch into the project's working branch. Small cards merge directly; large cards wait for your approval on the desk (**Approve merge**).

After the action, the branch is removed and the card moves to Done.

A merge is large when the card's risk tier is large (see Board and cards). The project owner can let large merges through without waiting for you: open the project's settings, go to **Merging**, and click **Merge large changes without my approval** (off by default; you are asked to confirm).

## Full suite and regression {#full-suite}

After finalization, a **full suite** card is created for testers to run the entire E2E suite once. A test-side failure (a flaky test, data or environment) is fixed by the tester; a genuine bug becomes a new bug card and you get a notice. These failures do not block merges.

To run a regression suite, open the project's board and click **Run regression**, pick the **Platform** (Web, Mobile or Both) and click **Run**. One regression card per platform is queued for the testers. The button only appears on projects with a test stage.
