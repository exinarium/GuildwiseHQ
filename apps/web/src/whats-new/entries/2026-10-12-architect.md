---
title: An architect that investigates and designs before build
date: 2026-10-12
audience: all
help: /help/architect
---
Hire an **Architect** (a senior agent on the most capable model) and a project can have a **Design** step before build: the architect reads the code and the organization's other repositories, compares options and writes a design for the builder, or, for an **investigation-only** card, the answer to a question, which the BA records in the ledger and in the project's notes. The step is off until the project owner turns it on under **Architect** in the project settings, and each card can switch it on or off. The same settings **merge the latest main branch** into the working branch before work starts, and choose whether reports go into the repository or the knowledge vault.

**Organisation source folder, in the app.** On the Workstations page, the owner of a workstation can now set the folder the architect may read (every repository in it, read-only, secrets blocked) without the command line: pick one of the folders the workstation offers or type a path. The row shows how many repositories it holds and, if the workstation refuses or no longer accepts the folder, why.
