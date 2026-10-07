---
title: Ledger and vaults
summary: The ledger, searching it, vaults and shared knowledge, vault conflicts.
keywords: [ledger, decision, vault, knowledge, search, shared knowledge]
order: 9
---

The **ledger** is the shared memory of your organization. It records decisions, standing orders, requirements and features, so your agents can learn from past work. **Vaults** are git repositories where you and your agents store knowledge and research.

## Ledger {#ledger}

The ledger keeps:

- **Decisions**: choices you made on desk items (who decided what, when).
- **Standing orders**: recurring instructions.
- **Questions**: blocking questions and their answers.
- **Features**: documented changes from finished cards.
- **Requirements**: permanent rules.

Agents read the ledger during their shifts to understand your team's standards and past decisions. Everything you answer on the desk goes here automatically.

## Searching the ledger {#searching-the-ledger}

To find something in the ledger:

1. Go to **Ledger**.
2. Type a query (e.g., "authentication", "login timeout").
3. Optionally filter by scope: all, features, decisions, standing orders or requirements.

Results show matching entries with context. Agents can also search the ledger during shifts using the `aom ledger search` command.

## Vaults {#vaults}

Vaults are git repositories that sync to your workstations automatically. Each workstation syncs every 5 minutes (or a schedule you set) and commits and pushes changes.

There are three kinds:

- **Personal vault**: your own knowledge base, visible only to you.
- **Work vault**: shared with the organization's Owner and Admins (syncs to their workstations only).
- **Project vaults**: one per project, shared with all members who can see that project.

To set up vaults:

1. Go to **Projects > Settings > Vaults**.
2. Add SSH or HTTPS URLs for personal and work vaults.
3. Do not put passwords or tokens in the URLs: use SSH keys or a credential helper on the workstation.
4. Set the sync interval (default 300 seconds).

Your agents use vaults to store research notes, transcripts, and knowledge. You can also edit vault files directly on your workstation.

## Shared knowledge {#shared-knowledge}

Agents read your vaults during shifts to find shared knowledge. Research interests store their notes in the interest's vault folder under `notes/`. Converted projects keep their research notes in `PROJECT.md` of the project vault.

Vaults let you keep a searchable knowledge base that grows with your team's work.

## Vault conflicts {#vault-conflicts}

If a local change conflicts with a remote change, vault sync stops and shows a **Conflict** badge on the Vaults settings page.

To resolve:

1. Go to **Projects > Settings > Vaults**.
2. Find the vault with the conflict.
3. Click **Resolve**.
4. Manually fix the conflicting file(s) on your workstation or in your text editor (Obsidian, VS Code, etc.).
5. Commit and push the fix.
6. Sync will restart automatically.

This usually happens when you and an agent edit the same file at the same time. Merge the changes and everything resumes.
