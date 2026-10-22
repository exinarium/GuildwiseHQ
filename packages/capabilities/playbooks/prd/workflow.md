---
name: prd
description: Produce a product requirements document from a brief or a discovery session, using the template and checking it against the checklist before approval.
---

# PRD

Goal: a PRD that a delivery team can break into cards without asking the author what was meant.

Inputs: an approved brief or the notes of a discovery session, and the minutes of any boardroom session.

Assets:
- `assets/prd-template.md`: the structure of the document.
- `assets/prd-checklist.md`: the validation checklist.

Rules for the facilitator:
- Fill the template section by section with the owner. Do not leave placeholders in the final text.
- Every requirement has an identifier, a priority and at least one acceptance criterion that can be tested.
- Trace requirements back to the problem and the users. Remove any requirement you cannot trace.
- Read each step with `aom skill show playbook:prd --file steps/<name>`.

Steps:
1. `steps/step-01-gather.md`
2. `steps/step-02-goals-users.md`
3. `steps/step-03-requirements.md`
4. `steps/step-04-nonfunctional.md`
5. `steps/step-05-validate.md`
6. `steps/step-06-handoff.md`
