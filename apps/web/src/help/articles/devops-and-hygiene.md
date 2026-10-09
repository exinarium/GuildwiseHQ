---
title: DevOps and repository hygiene
summary: The DevOps engineer, repository hygiene, the working branch and creating new repositories.
keywords: [DevOps, hygiene, repository, working branch, git]
order: 7
---

Every workstation has a **DevOps engineer** agent: one per machine, free and always available. It handles system tasks that agents ask for or you request directly. It is not driven by cards like other agents. Repository hygiene is a daily cleanup that commits changes, pushes branches and removes finished work from disk.

## The DevOps engineer {#devops-engineer}

You get one DevOps engineer per workstation automatically. It cannot be fired, only reset (which clears its sandbox but keeps it assigned). It does not take cards from the queue.

The DevOps engineer handles:
- Cloning and setting up projects.
- Installing tools and dependencies.
- Starting containers and databases.
- Pulling and pushing vault changes.
- Repository hygiene (see below).

You can ask it directly: open the workstation on the **Workstations** page, type what you need in **Ask DevOps** and click **Send request**. You can also start a chat with it (see Chat with agents). In the same panel you decide what it may do on its own: install packages and tools, use Docker, use elevated privileges (sudo) and write to extra paths. Anything outside that waits for your approval on the desk.

Because it is free, you cannot extend it with extra instructions, skills or custom permissions. Only its model, effort and runtime can change.

## Repository hygiene {#hygiene}

Once a day per workstation by default, the DevOps engineer tidies the repositories on that machine. On the **Workstations** page, open the workstation and find **Repository hygiene**: **Run** sets how often (off, every hour, every 6 hours, every 12 hours, daily or weekly) and **Run hygiene now** starts a run at once. For each repository it:

- Fetches and pulls the latest changes.
- Commits any uncommitted changes to the working branch.
- Pushes commits that have not been pushed yet.
- Removes branches and worktrees (temporary checkouts) of finished cards.

The panel shows the last and next run and any open findings.

If hygiene finds a conflict, uncommitted changes on the wrong branch, an authentication failure, or a missing clone, it does not force anything. These show as failures in your BA's daily report until a later run finds the repository clean.

## New repositories and the toolchain {#setup}

When you add a repository in **Project settings, Repositories**, the DevOps engineer of each workstation of the project puts it there. Pick **An existing repository** and it is cloned into the workstation's first repository folder (`aom-runner repos add`); a folder that already holds something else is never overwritten. Pick **Create a new repository** (owner/name and visibility) and the DevOps engineer creates it on GitHub with the workstation's `gh` login, then clones it. Under each repository you see **Cloning**, **Cloned on <workstation>** or **Failed: <reason>** with **Try again**.

Before the first build work on a new project, the DevOps engineer checks that the tools the repository needs are installed: .NET and the MAUI workloads, Node and its package manager, Python, Docker, Go, Rust, Java and more. It installs what is missing only if you ticked **Install packages and tools** (and **Docker**, **Elevated privileges** where needed). Until the workstation is ready, build and test cards wait there with the reason on the card, and **Project settings, Development environment** shows each tool, what is missing and how to fix it, with **Check again**.

## Rights and the sudo password {#rights}

A ticked right is checked on the machine itself. On the Workstations page each ticked right shows **verified** or **failed** with the reason and how to fix it (for Docker: add the runner user to the docker group, start the daemon; for sudo: enter the password or allow passwordless sudo). **Verify now** checks again.

If sudo asks for a password, enter it under the rights. Your browser encrypts it with a key that only that workstation's runner holds; Guildwise HQ's server only passes the encrypted text on. The runner keeps it in its own data folder, uses it only for the DevOps engineer's commands, never writes it to a log, and never shows it again. **Forget it** deletes it. To check that nobody swapped the key, compare the key id on the page with `aom-runner doctor` on the machine.

## The working branch {#working-branch}

The **working branch** is the main branch where agents commit their finished work. It is something you confirm: it is never guessed.

When a repository has no confirmed working branch (project settings show **not confirmed**), the DevOps engineer does not commit, pull or push in it. Instead, it asks you on the desk: **Which branch is the working branch of `<repository>`?**

When the repository has uncommitted changes waiting, the question is pinned and blocking; otherwise it is an ordinary question. Answer it by picking a branch from the options or typing its name. If the repository has exactly one branch (or its default branch is known), that one is preselected as the suggestion; nothing is stored until you answer. Your answer is stored for the repository.

If the working branch does not exist in the clone yet, you are not asked: when the next card starts, the runner creates the branch from the repository's default branch (`origin/HEAD`, else the only branch, else `main` or `master`), pushes it, and the card shows "Created working branch X from Y". Only if it cannot tell the default branch, or the push is refused (a protected repository, no access), does the question reach your desk, with the reason.

A repository added without a branch stays unconfirmed: `main` is never assumed. If an agent's workstation cannot start a card because the working branch does not exist there, the same question appears on the desk, linked to the card, naming the repository's default branch (for example `master`). There is one open question per repository however many cards fail, and a branch you confirmed is never changed without your answer.

When something changes (for example a new phase is created), the DevOps engineer asks again ("Keep `<branch>` as the working branch...?") so you can keep or change it.

You can also set or change it any time in **Project settings**, under **Repos**: use **Set** or **Change** on the repository row.

## Creating a new repository {#new-repository}

Agents cannot create GitHub repositories themselves: their sandbox has no GitHub login. When a project needs a new repository:

1. The BA or DevOps engineer asks with `aom repo create`.
2. The request appears on your desk as **Create repository `<owner/repo>`**.
3. You review it and click **Create repository** (or **Reject**).

On approval, your runner creates the repository using your GitHub login, pushes an initial commit to `main`, clones it on the workstation, and tells the server. The project gains the repository with `main` as the working branch. Agents are then told so they can continue.

Only the organization's Owner and Admins can approve. Your workstation must be connected and `gh` (the GitHub CLI) must be installed and logged in.

If something goes wrong (for example you have not run `gh auth login` yet), an alert lands on your desk. Fix the cause and click **Retry**: the same request tries again, and if a repository of that name was already created but left empty, it will be used.

**Dismiss** closes the alert and leaves the request failed; the agent can ask again.
