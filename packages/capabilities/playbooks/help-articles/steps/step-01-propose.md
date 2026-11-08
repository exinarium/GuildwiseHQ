# Step 1: Propose the edits

An article is named by its slug (the file name without `.md`). A section is named by its anchor id: the `{#id}` at the end
of its heading, or, when it has none, the heading text in lower case with dashes.

For each user-visible change:
- edit only the sections whose feature changed; leave every other article and section alone;
- correct sentences that no longer match the behaviour ("replace_text": the exact text to find once in that section, and
  its replacement);
- or add a paragraph to the section that covers the feature ("append");
- or, only for a new user-visible feature that has no home, add a section ("add_section" after the most related section,
  with a new lowercase "id" made of letters, digits and dashes that the article does not use yet).

Never change, move or remove a heading or its `{#id}` anchor: the app, the user guide and other articles link to them.
Never change an article's header (the lines between the two `---` at the top). Never write a heading line, a `{#` anchor,
a `---` line, an HTML comment or a fenced code block in the text. No ticket keys, commit ids, people or agent names.
A change that is not user-visible (tests, refactors, build, internal tools) goes to "skipped" with a reason.
A change the Help already describes goes to "covered" with the article and section.
Every edit lists the change ids it is for in "sources".

Output: only the JSON file `release-prep-proposal.json` in your working directory, in this shape:
{"edits":[{"op":"replace_text","article":"phases","section":"release-prep","find":"...","replace":"...","sources":["card:KEY-1"]},
          {"op":"append","article":"phases","section":"release-prep","text":"...","sources":[]},
          {"op":"add_section","article":"phases","after":"release-prep","title":"...","id":"new-id","body":"...","sources":[]}],
 "covered":[{"source":"...","article":"phases","section":"release-prep"}],"skipped":[{"source":"...","reason":"..."}],"notes":[]}
Change no other file. Then end with `aom prep done --summary "..."`; if the edits are refused, fix exactly what is named and run it again.
