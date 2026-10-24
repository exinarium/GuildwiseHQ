### Ledger and vaults
The ledger, searching it, vaults and shared knowledge, vault conflicts.
- Ledger: The ledger keeps three kinds of entry:
- Editing a standing order: The Owner and Admins (a project's owner for its own) can press Edit on a standing order to change its title or text. Agents get the new wording from their next shift or chat, the DevOps engineer included, and History keeps the earlier versions.
- Searching the ledger: To find something in the ledger:
- Vaults: Vaults are folders of markdown notes. A git vault is a repository that your DevOps engineers keep in sync on your workstations; a project vault can also be a local folder on one workstation, which is not synced and has no copy anywhere else, so back it up yourself.…
- Which vault an agent reads: Agents only ever read a vault, never write it directly. What they can read depends on the work:
- Shared knowledge: Agents read your vaults during shifts to find shared knowledge. Research interests store their notes in the interest's folder in the organization vault (interests/<name>/) under notes/. Converted projects keep their research notes in PROJECT.md of the project vault.
- Vault conflicts: If a local change conflicts with a remote change, sync of that vault pauses on that workstation. The Vaults page shows a Sync paused: conflict badge with the conflicting files, and a desk item of kind Vault conflict appears.
