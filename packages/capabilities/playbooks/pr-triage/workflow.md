---
name: pr-triage
description: Sort a pile of open pull requests into merge now, needs work, needs a decision and close, with one reason per pull request and a suggested order of review.
---

# Pull request triage

Goal: the owner knows in a few minutes which pull requests to look at first and which to leave alone.

Rules for the facilitator:
- Work from what the owner pastes or what you can read with your read tools. Do not guess at pull requests you have not seen.
- One question at a time. Allow skip and park.
- Never approve, merge or close anything. You only recommend; the owner acts.
- Give every pull request exactly one verdict and one reason of at most twenty words.
- Read each step with `aom skill show playbook:pr-triage --file steps/<name>`.

Steps:
1. `steps/step-01-scope.md`
2. `steps/step-02-sort.md`
3. `steps/step-03-order.md`

The result is a table with these columns: Pull request, Verdict (merge now, needs work, needs a decision, close), Reason,
Who acts next.
