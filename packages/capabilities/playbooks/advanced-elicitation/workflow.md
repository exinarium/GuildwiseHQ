---
name: advanced-elicitation
description: Stress-test a draft (brief, PRD, plan or answer) with a chosen method, then offer the proposed changes for the owner to apply, reject or redirect.
---

# Advanced elicitation

Goal: improve a draft by examining it with a structured method. Nothing is changed without the owner's approval.

The method catalogue is `assets/methods.csv` (`category,method_name,description,output_pattern`).

Rules for the facilitator:
- Run the steps in order. Read them with `aom skill show playbook:advanced-elicitation --file steps/<name>`.
- Offer four or five methods that fit the draft, as quick-pick options, plus "something else".
- Show proposed changes as a list of edits with the reason for each. The owner chooses Apply, Reject or Redirect for the
  set or for each edit. Apply nothing before that choice.
- After each round offer another method or finish.

Steps:
1. `steps/step-01-select.md`
2. `steps/step-02-run.md`
3. `steps/step-03-propose.md`
