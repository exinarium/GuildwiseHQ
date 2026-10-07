---
title: Testing and finalization
summary: Test stage, finalization with pull requests and merging, full suite and regression.
keywords: [test, finalize, merge, PR, regression, full suite]
order: 11
---

After a card is reviewed and approved, it moves to the Test stage where a tester runs E2E tests. Once tests pass, the card moves to Finalize where it is merged into the main branch. A full test suite runs after each merge.

## Test stage {#test-stage}

When a card reaches Test, a tester runs the E2E tests from the test plan. If tests pass:

- The card moves to Finalize (or Docs if documentation is needed).

If tests fail:

- A bug card is created on the same branch, linked to the original card.
- The original card shows a **waiting on bug** badge.
- The bug goes through the normal workflow (Build, Review, Test).
- Once the bug is fixed and passes, the tester re-runs the full suite on the original card.

Testers use browsers (Playwright and Chromium). Their sandbox allows Unix sockets so browsers work, but other system access is blocked.

Playwright's test output folders (`test-results/`, `playwright-report/`, `blob-report/`) are discarded after the shift and never committed to your repository.

## Finalization {#finalization}

At the Finalize stage, your BA chooses how to ship the work:

- **PR**: Push the branch to GitHub and create a pull request (if `gh` is available), or ask the desk if it is not.
- **Push branch**: Push the branch to GitHub without creating a PR.
- **Merge to main**: Merge the working branch directly (small cards only), or ask the desk for approval (large cards).

After the action, the branch is removed and the card moves to Done. If docs are needed, a tech writer card is spawned.

For large merges (> 100 lines changed), you can set a project preference to auto-merge without waiting for your approval. Go to **Projects > Settings > Large changes** and toggle **Merge large changes without my approval**.

## Full suite and regression {#full-suite}

After finalization, a **full suite** card is created for testers to run the entire E2E suite once. If the full suite fails, a bug is created and you get a notice.

To run the entire regression suite on all platforms (web and mobile), go to the **Projects** page and click **Run regression**. This tests the latest deployed version against all your platforms.
