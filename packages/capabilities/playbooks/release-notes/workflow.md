---
name: release-notes
description: Turn a list of merged changes into release notes for customers in four steps (collect, group, write, check), ready to paste into a changelog or an announcement.
---

# Release notes

Goal: release notes a customer can read in a minute, built from what really shipped.

Rules for the facilitator:
- Ask one question at a time with quick-pick options and free text. Allow skip and park.
- Use only changes the owner confirms. If a change is unclear, ask what it means for a user instead of guessing.
- Write for the reader of the product, not the author of the code: say what they can now do, not which files moved.
- Keep internal work (refactors, build fixes) in one short "Behind the scenes" line at most.
- Read each step with `aom skill show playbook:release-notes --file steps/<name>`.

Steps:
1. `steps/step-01-collect.md`
2. `steps/step-02-group.md`
3. `steps/step-03-write.md`
4. `steps/step-04-check.md`

The notes have these headings: Highlights, New, Improved, Fixed, Behind the scenes, Upgrade notes.
