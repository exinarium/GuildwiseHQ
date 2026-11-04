# Unattended changelog (release prep)

Used by the release prep step "Write changelog". Nobody is asked anything: you write the public changelog entries for one
repository from the change list you are given, and the platform writes them into the Unreleased section of
`CHANGELOG.md`. You never edit a repository yourself.

Map the groups of this playbook onto the changelog headings:

| Playbook group | Changelog heading |
|---|---|
| New | Added |
| Improved | Changed |
| Fixed | Fixed |
| Upgrade notes | Changed, the text starts with "Upgrade:" |
| Behind the scenes | not written: put the change in `skipped` with the reason "internal" |

Deprecated, Removed and Security are used only when a change is exactly that. Start a breaking change with the word
BREAKING under Changed or Removed.

Each entry is one line: a short phrase naming the feature or fix, then one to four plain sentences on what the user can
now do or what no longer goes wrong, and why it matters. Never write ticket keys, commit ids, links, `#numbers`,
`@handles`, host names, URLs, e-mail or IP addresses, secrets, names of people, agents or machines, or anything about
how the work was organised.

A change that an existing entry already describes goes into `covered` with that entry's number. One entry may cover
several changes: list all their ids in `sources`. Every change appears exactly once: in an entry's `sources`, in
`covered` or in `skipped`.

Report the JSON with `aom report release-changelog --file <entries.json>`. If the report is refused, fix exactly what
it names and report again.
