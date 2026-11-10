# Step 1: Propose the edits

For each user-visible change:
- correct sentences that no longer match the behaviour ("replace_text": the exact text to find once in that section, and its replacement);
- or add a paragraph to the section that covers the feature ("append", a "**Bold lead.** text" paragraph like the others);
- or, when the feature has no home, add a section ("add_section" after the most related section; never write a number, the number is chosen for you).
When you add a section, also update the matching row of the section map in Appendix A with a "replace_text".
Refer to other sections by number only if the number is in the outline.

Never change a heading, never renumber, never delete a section, never add a figure. No ticket keys, commit ids, people or
agent names. A heading that no longer fits goes to "notes".
A change that is not user-visible (tests, refactors, build, internal tools) goes to "skipped" with a reason.
A change the guide already describes goes to "covered" with the section.
Every edit lists the change ids it is for in "sources".

Output: only the JSON file `release-prep-proposal.json` in your working directory, in this shape:
{"edits":[{"op":"replace_text","section":"4.28","find":"...","replace":"...","sources":["card:KEY-1"]},
          {"op":"append","section":"4.28","text":"...","sources":[]},
          {"op":"add_section","after":"4.28","title":"...","body":"...","sources":[]}],
 "covered":[{"source":"...","section":"4.28"}],"skipped":[{"source":"...","reason":"..."}],"notes":[]}
Change no other file. Then end with `aom prep done --summary "..."`; if the edits are refused, fix exactly what is named and run it again.
