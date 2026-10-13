---
title: Ledger and vaults
summary: The ledger, searching it, vaults and shared knowledge, vault conflicts.
keywords: [ledger, decision, vault, knowledge, search, shared knowledge]
order: 9
---

The **ledger** is the shared memory of your organization. It records decisions, standing orders and requirements, so your agents can learn from past work. **Vaults** are git repositories where you and your agents store knowledge and research.

## Ledger {#ledger}

The ledger keeps three kinds of entry:

- **Decisions**: choices you made, kept as a project decision log.
- **Requirements**: what a card or project must do.
- **Standing orders**: rules and conventions every agent loads at the start of a shift. A standing order can apply to one project or to every project.

Agents search the ledger before they ask you a question, and the BA checks new questions against it. When you answer a desk item, the answer is written to the ledger (see **Add to ledger as** on the answer form). You can also add entries yourself with **Add entry** on the Ledger page.

## Searching the ledger {#searching-the-ledger}

To find something in the ledger:

1. Go to **Ledger**.
2. Type a query (e.g., "authentication", "login timeout").
3. Optionally pick a **Project**, and filter by kind with the chips: **All**, **Standing orders**, **Decisions** or **Requirements**.

Results show matching entries with context. Agents can also search the ledger during shifts using the `aom ledger search` command.

## Vaults {#vaults}

Vaults are git repositories of markdown notes that your DevOps engineers keep in sync on your workstations. By default each workstation syncs every 300 seconds (5 minutes); you can set another interval per vault.

There are two kinds:

- **Organization vault**: the knowledge of your organization, including your interests (under `interests/<name>/`). An organization has at most one.
- **Project vault**: one per project, shared with the members of that project.

There are no personal vaults any more: "personal" simply means your own organization. If you had a personal vault, its files were merged into the organization vault under `personal/`.

The organization vault syncs only to the workstations of the Owner and Admins. Project vaults sync to the workstations of the project's members. An agent only reads the vault of its card's project: the project vault if it has one, otherwise the organization vault (on an Owner's or Admin's workstation).

To register a vault (Owner and Admin for the organization vault; the project's owner for a project vault):

1. Open **Vaults** in the sidebar (under Knowledge).
2. Click **Register a vault** and choose the **Kind**.
3. Enter the **Git URL**. Use an SSH or HTTPS URL without passwords or tokens: use SSH keys or a credential helper on the workstation.
4. Set the **Sync interval (seconds)** (default 300).
5. Register it.

Your agents use vaults to store research notes, transcripts, and knowledge. You can also edit vault files directly on your workstation.

## Which vault an agent reads {#agents-and-vaults}

Agents only ever read a vault, never write it directly. What they can read depends on the work:

- **Card work, questions and the business analyst's tasks** on a project: the project's vault, or the organization vault when the project has none.
- **A chat about a project or a card:** the same vault, read-only. Its `PROJECT.md` and standing orders are part of what the agent knows.
- **A chat with no project** (for example an intake or a general chat): the organization vault, but only on the workstation of an Owner or Admin.

The vault must be cloned on the agent's workstation; if it is not, the agent tells you instead of guessing. Secret files (such as `.env` files and keys) stay blocked even inside a vault. A vault of another organization is never opened. Notes are saved with the commands made for it (for example publishing a research note), not by editing files.

## Shared knowledge {#shared-knowledge}

Agents read your vaults during shifts to find shared knowledge. Research interests store their notes in the interest's folder in the organization vault (`interests/<name>/`) under `notes/`. Converted projects keep their research notes in `PROJECT.md` of the project vault.

Vaults let you keep a searchable knowledge base that grows with your team's work.

## Vault conflicts {#vault-conflicts}

If a local change conflicts with a remote change, sync of that vault pauses on that workstation. The Vaults page shows a **Sync paused: conflict** badge with the conflicting files, and a desk item of kind Vault conflict appears.

To resolve:

1. Open **Vaults** in the sidebar and find the vault with the conflict.
2. Fix the conflicting file(s) in the clone on your workstation (the path is shown), with Obsidian, VS Code or any editor, and commit.
3. Click **I resolved it, resume**. Sync restarts.

This usually happens when you and an agent edit the same file at the same time. Merge the changes and everything resumes.
