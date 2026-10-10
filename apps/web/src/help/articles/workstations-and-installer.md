---
title: Workstations and the installer
summary: What a workstation is, the Add a workstation wizard, installing by hand, Claude credentials and Windows.
keywords: [workstation, installer, runner, WSL2, setup, wizard, credentials]
order: 18
---

A **workstation** is a computer of yours (Windows, macOS or Linux) where your agents run and work on your code. The **runner** is the software on that computer that pairs with Guildwise HQ and lets agents work. The guided installer sets everything up; you do not need to know about servers.

## What is a workstation {#what-is-a-workstation}

A workstation is your own machine: a laptop, desktop or server. It holds your git repositories and is where agents run their work. You can have one workstation or many. Each agent is assigned to one workstation and only that one.

The runner on each workstation:
- Stays connected to Guildwise HQ.
- Sandboxes agents so they cannot read your SSH keys or other projects.
- Manages git, Docker and other tools.
- Syncs vaults (your shared knowledge base).
- Runs repository hygiene (commit changes, push branches, clean up).

## Add a workstation {#add-a-workstation}

First choose **where your agents should run**: **My computer** (below), **A VPS (SSH)** or **GitHub Codespaces**. The last two are explained in "Cloud workstations (VPS and Codespaces)".

1. Go to **Workstations** (sidebar: Organization) and click **Add a workstation** (or the button in the middle if the list is empty).
2. **Pick the system**: Windows, Linux or macOS. The page guesses from your browser; change it if needed. Optionally type a name for the workstation.
3. **Read the steps and click Copy command**: the command contains a link (works 30 minutes) and a pairing code (one time only). It never contains a password. You can also read the whole script first with **Download the script**. If 30 minutes pass, choose your system again for a new one.
4. **Run the command on that computer**: open a terminal (Windows: PowerShell), paste and press Enter. Say yes when it asks permission. Windows may ask to restart; the installer carries on by itself when you sign in again.
5. **Watch this page**: it shows the installer starting, pairing ("Paired as..."), then **Health checks** one by one, and finally **Ready**. The **Installer log** shows each step. If it stops, the last line marked [x] in the terminal (shown as [fail] in the log) says what to fix.

The installer asks only what it must: your password once (to install system tools), whether you want optional extras (yt-dlp for video transcripts; Docker, only if testers run containers), and how Claude should sign in. Your code lives in `~/src`; the installer asks about folders only if you turned on expert mode in Settings (or run it with `--choose-folders`). On Windows it names its start-up task "Guildwise HQ runner" and removes the older "WSL Boot" task when you run it again.

## Claude sign-in {#claude-sign-in}

The installer asks how agents should use Claude:

- **Claude subscription** (Pro, Max, Team or Enterprise): you sign in with your Claude account in a browser and work counts against your plan.
- **Anthropic API key**: you pay for exactly what agents use.

Choose whichever your organization provided. You can choose later and run `claude` on that computer any time; the health check "claude" shows the state.

## Installing by hand {#installing-by-hand}

Only needed when the guided setup is not an option:

1. Go to **Workstations** and click **Pair workstation** (or **Pair it with a code instead** in the Add a workstation window).
2. Click **Generate pairing code** and copy the command it shows. The code (`XXXX-XXXX`) is valid for 10 minutes.
3. On the computer, download or build the runner.
4. Run the pair command, add your repository folders (`aom-runner repos add`), and start the runner as a service.

See the installer's help links for your system's commands. On Windows, install the runner inside WSL2 (Ubuntu): that is the only way to get a sandbox.

## Health checks {#health-checks}

While the installer runs, this page lists the health checks as they finish: Node, git, Claude, the sandbox, Docker, yt-dlp, your repositories and server connectivity. Each shows **ok**, **warn** or **fail**. A **fail** means something is missing or broken and the line says what. A **warn** (Docker, yt-dlp) is optional.

Afterwards, a workstation's card on the **Workstations** page shows whether it is **Connected** or **Offline**, its runtimes (with a sandbox warning if one cannot sandbox agents), how many shifts are running, and its repositories. To run the checks again, run `aom-runner doctor` on that computer.

## Windows {#windows}

**Default: WSL2** (recommended). Install the runner inside a WSL2 Ubuntu distribution and follow the Linux instructions. The installer turns on WSL2 for you; you just follow the steps. Agents run sandboxed inside WSL2 just like on Linux.

**Native Windows** (not recommended) cannot sandbox agents. Agents run without an OS sandbox and could read your SSH keys. The workstation shows an amber warning that cannot be dismissed. If you must run natively, set `"sandbox": "best_effort"` in the runner config.

For vault SSH keys on Windows, ensure git can find them (OpenSSH or PuTTY with Pageant).

## Git hosts {#git-hosts}

Each repository of a project has a git host: GitHub, GitLab, Bitbucket Cloud, Azure DevOps, or a plain git server. For pull requests, the repository list and creating new repositories, the workstation must be **connected** to that host. Your login or token stays on the workstation; Guildwise HQ only learns whether it works.

Open the workstation card on the **Workstations** page: **Git hosts** shows Connected or Not connected for each host. Click **Connect** for the one command to run in a terminal on that workstation:

- `aom-runner git-connect github` opens a browser to sign in (GitHub CLI).
- `aom-runner git-connect gitlab` signs in with the GitLab CLI or asks for a personal access token.
- `aom-runner git-connect bitbucket-cloud` asks for your Atlassian e-mail and an API token (old app passwords no longer work).
- `aom-runner git-connect azure-devops --organization <name>` asks for a personal access token, or uses your Azure sign-in (`az login`). Use a token for one organization: global tokens stop working on 1 December 2026.
- Add `--ssh-key` to any of them to create an SSH key and see where to upload it.

Then click **Check again**. The DevOps engineer can walk you through any of these in a chat.

A **plain git** server needs no connection, but no pull request is opened: the branch is pushed and the desk tells you to open the request yourself. If a project's working branch is protected on the host, finishing a card with Merge opens a pull request instead.

## Unpairing {#unpairing}

If a workstation goes away (you sold the computer, decommissioned a server), go to **Workstations** and click **Unpair** on its card, then confirm. Its runner token stops working and the runner shuts down, cards claimed there go back to the queue, and its agents wait until you re-home them. To use the machine again, pair it with a new code.
