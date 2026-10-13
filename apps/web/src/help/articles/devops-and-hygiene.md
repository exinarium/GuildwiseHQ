---
title: DevOps and repository hygiene
summary: The DevOps engineer and Ask DevOps, approvals, conflicts, repository hygiene and saved work, the toolchain, the working branch and new repositories.
keywords: [DevOps, ask devops, chat, approval, two people, conflict, hygiene, saved work, repository, toolchain, packages, android sdk, sudo, working branch, git]
order: 7
---

Every workstation has a **DevOps engineer** agent: one per machine, free and always available. It handles system tasks that agents ask for or you request directly. It is not driven by cards like other agents. Repository hygiene is a daily tidy-up that pulls the latest changes, keeps your unsaved edits safe and removes finished work from disk.

## The DevOps engineer {#devops-engineer}

You get one DevOps engineer per workstation automatically. It cannot be fired, only reset (which clears its sandbox but keeps it assigned). It does not take cards from the queue.

The DevOps engineer handles:
- Cloning and setting up projects.
- Installing tools and the project's own packages.
- Running commands, Docker builds and deploys you ask for in a chat.
- Starting containers and databases.
- Fixing conflicts between changes before they reach you.
- Pulling and pushing vault changes.
- Repository hygiene (see below).

You can ask it directly from anywhere: click **Ask DevOps** in the top bar, choose **Ask DevOps...** in the command palette (Ctrl K), or use the **Ask DevOps** button on a card, on a desk item or on the workstation. The page, project, card or error you were looking at is attached (remove any chip you do not want to share), and the right workstation's engineer is chosen for you when it is obvious. **Start chat** talks to it; **Send as a task** files a request that you can follow on the Workstations page. See also [Chat with agents](/help/chat-with-agents).

The DevOps engineer works **as you, on your machine**, outside the safety box that other agents work in. In a chat with it, a command, a Docker build or a deploy you ask for runs right away. The tick boxes in the workstation's panel (install packages and tools, use Docker, use elevated privileges (sudo), write to extra paths) are instructions to it and decide what the automatic tool setup may do, but they do not physically stop it: only give this agent to a machine you are happy to hand it. Anything it decides is outside its instructions waits for approval on the desk.

**Requests about a card.** When a request is filed for a card (the **Ask DevOps** button on the card, or the agent working on it asks), the DevOps engineer gets that card in its brief: title, type, fields, project, repository and the latest comments. It can read the card, comment on it and set the card fields it needs, for example how to start the stack. It cannot change the card's title, stage or status, and it cannot read or change any other card.

**Who approves.** On a workstation that belongs to a team member, an Owner or Admin approves, and the person whose machine it is must agree as well. If you are an Owner approving on your own machine, one click is enough. When two people are needed, the desk item stays open after the first answer, and either of them can say no.

Because it is free, you cannot extend it with extra instructions, skills or custom permissions. Only its model, effort and runtime can change.

## When two branches conflict {#conflicts}

If a card's branch conflicts with the working branch (before testing or when finishing), or hygiene cannot combine your working branch with its remote, the DevOps engineer **tries to fix it first**, on a temporary branch, and runs the build and tests before it moves anything. You can see it happen: a note on the card, a notice on your desk and the request in the workstation's list. The card then goes to Rework so review and testing run again. If two attempts do not work, the conflict goes to your desk as an item for you to decide.

Builders can also run `git rebase` in their own checkout of a card to tidy up their branch.

## Repository hygiene {#hygiene}

Once a day per workstation by default, the DevOps engineer tidies the repositories on that machine. On the **Workstations** page, open the workstation and find **Repository hygiene**: **Run** sets how often (off, every hour, every 6 hours, every 12 hours, daily or weekly) and **Run hygiene now** starts a run at once. For each repository it:

- Fetches and pulls the latest changes.
- Stores any unsaved edits of yours in a **git stash** (`git stash list`, "saved work ...") on your machine, so nothing is lost. Nothing is pushed, no branch is added, your files stay exactly as they are, and nothing lands on main by surprise.
- Pushes commits that have not been pushed yet.
- Removes branches and worktrees (temporary checkouts) of finished cards.
- Pull requests are pushed to the git host as `<prefix>/<ticket>` (project setting "Pull request branch prefix", default `feature`).

The panel shows the last and next run and any open findings.

Files that look like passwords or keys (`.env` files, `*.pem`, names with *key* or *secret*) are never copied; the notice on your desk names them. Hygiene never force-pushes and never throws work away.

If hygiene finds a conflict, an authentication failure, or a missing clone, it does not force anything. These show as failures in your BA's daily report until a later run finds the repository clean.

## New repositories and the toolchain {#setup}

When you add a repository in **Project settings, Repositories**, the DevOps engineer of each workstation of the project puts it there. Pick **An existing repository** and it is cloned into the workstation's first repository folder (`aom-runner repos add`); a folder that already holds something else is never overwritten. Pick **Create a new repository**, choose the git host and fill in what it asks (for example owner and name, and the visibility), and the DevOps engineer creates it there with that workstation's login for the host, then clones it. The workstation must be connected to the host first (see [Git hosts](/help/workstations-and-installer#git-hosts)). Under each repository you see **Cloning**, **Cloned on <workstation>** or **Failed: <reason>** with **Try again**.

Before the first build work on a new project, the DevOps engineer checks that the tools the repository needs are installed (from the repository's **Project path** when the app lives in a folder of it; see [Projects](/help/projects)): .NET and the MAUI workloads, Node and its package manager, Python, Docker, Go, Rust, Java and more. It installs what is missing with the workstation's package manager (apt, dnf, yum, pacman, zypper or apk on Linux, Homebrew on Linux and macOS, winget or Chocolatey on Windows) only if you ticked **Install packages and tools** (and **Docker**, **Elevated privileges** where needed). Once the tools are in place it also installs **the project's own packages** (pnpm, yarn, npm or bun install; Python packages into the project's own environment; .NET restore; Go, Rust, Maven, Ruby and PHP packages), and for Android and .NET MAUI projects it installs the **Android SDK** (command-line tools, platform tools, and the Android version and build tools the project needs). Every step is logged where you can read it. Next to every tool that is missing or blocked, and next to a repository that failed to clone, there is a **Fix** button (see [Fix with DevOps](#fix)). Until the workstation is ready, **every agent's card in that project** waits there with the reason on the card, and **Project settings, Development environment** shows each tool, what is missing and how to fix it, with **Check again**. If the setup needs your help or fails, a notice appears on your desk (once), and it disappears when the workstation is ready.

## Fix with DevOps {#fix}

Next to every item that failed or is missing there is a **Fix** button: a tool of the **Development environment** (missing, failed or needs access), a ticked right on the Workstations page that failed **Verify now**, and a repository under **Repositories** that failed to clone. Click it and the DevOps engineer of that workstation gets a request with the error text, the workstation, the project and the repository, so you do not have to describe the problem yourself.

The status appears next to the item:

- **Requested**: waiting in the DevOps engineer's queue (it works on one request at a time).
- **DevOps is working on it**.
- **Needs your approval on the desk**: the fix is outside what you allowed, or destructive. Approve it on the desk and it continues.
- **Done**: the check runs again by itself (the environment check, the rights check or the clone). **Check again** runs it by hand.
- **DevOps could not fix it**: read its answer on the Workstations page, then use **Fix again** or fix it yourself with the "How to fix" text.

Only the project owner sees Fix on the project settings. A fix that needs a password or token (for example a sudo password) is never typed by the engineer: it tells you what to do.

## Rights and the sudo password {#rights}

A ticked right is checked on the machine itself. On the Workstations page each ticked right shows **verified** or **failed** with the reason and how to fix it (for Docker: add the runner user to the docker group, start the daemon; for sudo: enter the password or allow passwordless sudo). **Verify now** checks again.

If sudo asks for a password, enter it under the rights. Your browser encrypts it with a key that only that workstation's runner holds; Guildwise HQ's server only passes the encrypted text on. The runner keeps it in its own data folder, uses it only for the DevOps engineer's commands, never writes it to a log, and never shows it again. **Forget it** deletes it. To check that nobody swapped the key, compare the key id on the page with `aom-runner doctor` on the machine.

## The working branch {#working-branch}

The **working branch** is where finished work is combined: the repository's default branch (usually `main`) unless you name another such as `develop`, which is created from the **main branch** (where pull requests go; default: the repository's default branch) and pushed when it does not exist. Both are shown in the project's repository settings. Guildwise confirms it for you automatically the first time it sees the repository, so you are not asked. The rest of this section describes what you see with **expert mode** on (Settings, Expert mode for code changes); with it off, branch names stay out of sight and you only see plain results such as "Your change is live on main".

When a repository has no confirmed working branch and Guildwise cannot tell the default (project settings show **not confirmed**), the DevOps engineer does not commit, pull or push in it. Instead, it asks you on the desk: **Which branch is the working branch of `<repository>`?**

When the repository has uncommitted changes waiting, the question is pinned and blocking; otherwise it is an ordinary question. Answer it by picking a branch from the options or typing its name. If the repository has exactly one branch (or its default branch is known), that one is preselected as the suggestion; nothing is stored until you answer. Your answer is stored for the repository.

If the working branch does not exist in the clone yet, you are not asked: when the next card starts, the runner creates the branch from the repository's default branch (`origin/HEAD`, else the only branch, else `main` or `master`), pushes it, and the card shows "Created working branch X from Y". Only if it cannot tell the default branch, or the push is refused (a protected repository, no access), does the question reach your desk, with the reason.

A repository added without a branch stays unconfirmed: `main` is never assumed. If an agent's workstation cannot start a card because the working branch does not exist there, the same question appears on the desk, linked to the card, naming the repository's default branch (for example `master`). There is one open question per repository however many cards fail, and a branch you confirmed is never changed without your answer.

When something changes (for example a new phase is created), the DevOps engineer asks again ("Keep `<branch>` as the working branch...?") so you can keep or change it.

You can also set or change it any time in **Project settings**, under **Repos**: use **Set** or **Change** on the repository row.

## Creating a new repository {#new-repository}

Agents cannot create repositories themselves: their sandbox has no login for your git host. You can create one on any host yourself from the project settings (see above). When an agent needs a new repository, it asks, on GitHub, GitLab, Azure DevOps or Bitbucket Cloud:

1. The BA or DevOps engineer asks with `aom repo create`, naming the git host and the repository the way that host does: `owner/repo` (GitHub), `group/subgroup/project` (GitLab), `organization/project/repo` (Azure DevOps) or `workspace/repo` (Bitbucket Cloud).
2. The request appears on your desk as **Create repository `<name>`**, with the git host shown.
3. You review it and click **Create repository** (or **Reject**).

On approval, your runner creates the repository using your own login for that git host (the one saved under Connect on the Workstations page), pushes an initial commit to `main`, clones it on the workstation, and tells the server. The project gains the repository with `main` as the working branch. Agents are then told so they can continue.

Only the organization's Owner and Admins can approve. Your workstation must be connected to that git host (for GitHub, `gh` must be installed and logged in). The DevOps engineer can help with the connection: it starts a browser sign-in and shows you the address and code, but it never asks for or types a token; if one is needed it tells you what to run.

If something goes wrong (for example the workstation is not connected to that git host yet), an alert lands on your desk. Fix the cause and click **Retry**: the same request tries again, and if a repository of that name was already created but left empty, it will be used.

**Dismiss** closes the alert and leaves the request failed; the agent can ask again.
