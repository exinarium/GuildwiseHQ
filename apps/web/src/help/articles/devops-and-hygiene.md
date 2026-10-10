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

You can ask it directly from anywhere: click **Ask DevOps** in the top bar, choose **Ask DevOps...** in the command palette (Ctrl K), or use the **Ask DevOps** button on a card, on a desk item or on the workstation. The page, project, card or error you were looking at is attached (remove any chip you do not want to share), and the right workstation's engineer is chosen for you when it is obvious. **Start chat** talks to it; **Send as a task** files a request that you can follow on the Workstations page.

The DevOps engineer works **as you, on your machine**, outside the safety box that other agents work in. In a chat with it, a command, a Docker build or a deploy you ask for runs right away. The tick boxes in the workstation's panel (install packages and tools, use Docker, use elevated privileges (sudo), write to extra paths) are instructions to it and decide what the automatic tool setup may do, but they do not physically stop it: only give this agent to a machine you are happy to hand it. Anything it decides is outside its instructions waits for approval on the desk.

**Who approves.** On a workstation that belongs to a team member, an Owner or Admin approves, and the person whose machine it is must agree as well. If you are an Owner approving on your own machine, one click is enough. When two people are needed, the desk item stays open after the first answer, and either of them can say no.

Because it is free, you cannot extend it with extra instructions, skills or custom permissions. Only its model, effort and runtime can change.

## When two branches conflict {#conflicts}

If a card's branch conflicts with the working branch (before testing or when finishing), or hygiene cannot combine your working branch with its remote, the DevOps engineer **tries to fix it first**, on a temporary branch, and runs the build and tests before it moves anything. You can see it happen: a note on the card, a notice on your desk and the request in the workstation's list. The card then goes to Rework so review and testing run again. If two attempts do not work, the conflict goes to your desk as an item for you to decide.

Builders can also run `git rebase` in their own checkout of a card to tidy up their branch.

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

Before the first build work on a new project, the DevOps engineer checks that the tools the repository needs are installed: .NET and the MAUI workloads, Node and its package manager, Python, Docker, Go, Rust, Java and more. It installs what is missing only if you ticked **Install packages and tools** (and **Docker**, **Elevated privileges** where needed). Once the tools are in place it also installs **the project's own packages** (pnpm, yarn, npm or bun install; Python packages into the project's own environment; .NET restore; Go, Rust, Maven, Ruby and PHP packages), and for Android and .NET MAUI projects it installs the **Android SDK** (command-line tools, platform tools, and the Android version and build tools the project needs). Every step is logged where you can read it. Until the workstation is ready, **every agent's card in that project** waits there with the reason on the card, and **Project settings, Development environment** shows each tool, what is missing and how to fix it, with **Check again**. If the setup needs your help or fails, a notice appears on your desk (once), and it disappears when the workstation is ready.

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
