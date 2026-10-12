---
title: The architect: investigate and design
summary: The optional design step before build, investigation-only cards, where reports go, the main branch merge, and what the architect may touch.
keywords: [architect, investigate, design, investigation, report, spike, comparison, design step, merge main, main branch, conflict, organization source folder, hire architect]
order: 11
---

The **architect** is a senior agent (the most capable model) that thinks before the builder builds. It reads the card's code and the organization's other repositories, searches the web for best practice and writes a report: a **design** for the builder, or the **answer** to a question. It never builds the change itself. The step is **off by default**, so nothing changes until a project's owner turns it on, and every card can still say otherwise.

## Turning it on {#turning-it-on}

1. **Hire an architect** (Agents, Hire agent, role Architect). It costs more per shift than a builder.
2. Open the project's settings, **Architect**, tick **Investigate & design before build on new cards** and **Save**. Without an architect the page and your desk warn you: cards would wait in the **Design** column.

On a card, **Investigate & design before build** overrides the project: off for a typo, on when the approach is uncertain. A card can be changed until its investigation has started.

## Investigation-only cards {#investigation-only}

Tick **Investigation only** for an answer, not a change (a comparison, "how should we ...", a spike). Nothing is built: the architect writes the report, the BA records the result in the ledger and in the project's `PROJECT.md`, and the card is done. It needs only a title, context, requirements and a repository. The card page shows the report with a link to the file when the git host is known.

## Where the report goes {#report-location}

By default a markdown file in the repository, `docs/investigations/<ref>-<title>.md`, merged with the card. In the **Architect** settings you can change the folder or choose the **knowledge vault** instead (nothing is committed; the card finishes without a merge). A card can name its own **Report path**, or `vault:<path>`. The runner refuses a report that contains a secret.

## Merge the latest main branch first {#merge-main}

When a repository has a main branch and a different working branch, the runner merges main into the working branch before work starts (on by default; a project or card can switch it off). If the working branch is protected or changed meanwhile, the card branch takes the merge. A **conflict** is resolved by the architect; on a card without one the merge is skipped with a note on the card and your desk.

## What the architect may touch {#access}

- It **writes** only documentation and its report; the runner checks this after each shift.
- It **reads** the card's repository and every repository of the organization's projects cloned on its workstation, read-only, secret files blocked. The workstation's owner can also set an **organisation source folder** (see below): every git repository under it is readable too.
- It **never pushes** itself: the runner publishes the card branch for it.
- A card's investigation waits for the cards it depends on.

## Organisation source folder {#source-folder}

Open **Workstations**, expand your workstation and find the row **Organisation source folder** (only the workstation's owner sees it; it is set per organization, for the one you are working in). The architect may read every repository in the folder, read-only; secret files stay blocked.

- Pick one of the folders the workstation offers, or type a path, then press **Set folder**. **Clear** removes it.
- The row shows the folder (or "not set"), how many repositories it holds and whether it is **ok** or **invalid**, with the reason.
- The workstation checks the folder itself and can refuse it: it must sit inside one of its repository folders (not be that folder), and never be your home folder, the runner's own folder or a credentials folder such as `~/.ssh`.
- The same can be done on the machine with `aom-runner org-folder set|clear|list`.
