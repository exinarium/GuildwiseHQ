---
title: Workstations and the installer
summary: What a workstation is, the Add a workstation wizard, installing by hand, Claude sign-in, Windows and connecting git hosts.
keywords: [workstation, installer, runner, WSL2, setup, wizard, credentials, src folder, windows task, git host, git-connect, github, gitlab, bitbucket, azure devops, plain git, connect]
order: 18
---

A **workstation** is a computer of yours (Windows, macOS or Linux) where your agents run and work on your code. The **runner** is the software on that computer that pairs with Guildwise HQ and lets agents work. The guided installer sets everything up; you do not need to know about servers. Agents can also run on a server you rent or in a GitHub Codespace: see [Cloud workstations](/help/cloud-workstations).

## What is a workstation {#what-is-a-workstation}

A workstation is your own machine: a laptop, desktop or server. It holds your git repositories and is where agents run their work. You can have one workstation or many. Each agent is assigned to one workstation and only that one.

The runner on each workstation:
- Stays connected to Guildwise HQ.
- Sandboxes agents so they cannot read your SSH keys or other projects. The DevOps engineer is the exception: it works as you (see [DevOps and repository hygiene](/help/devops-and-hygiene#devops-engineer)).
- Manages git, Docker and other tools.
- Syncs vaults (your shared knowledge base).
- Runs repository hygiene (pull the latest changes, keep your unsaved edits safe, clean up finished work).

## Add a workstation {#add-a-workstation}

First choose **where your agents should run**: **My computer** (below), **A VPS (SSH)** or **GitHub Codespaces**. The last two are explained in [Cloud workstations](/help/cloud-workstations).

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

Open the workstation card on the **Workstations** page: **Git hosts** shows Connected, Not connected (no token saved), Token refused (hover for the HTTP status and the likely missing scope) or Could not check (the host could not be reached) for each host. Click **Connect** for the one command to run in a terminal on that workstation:

- `aom-runner git-connect github` opens a browser to sign in (GitHub CLI).
- `aom-runner git-connect gitlab` signs in with the GitLab CLI or asks for a personal access token.
- `aom-runner git-connect bitbucket-cloud` asks for your Atlassian e-mail and an API token (old app passwords no longer work).
- `aom-runner git-connect azure-devops` uses a **Microsoft Entra service principal** if the workstation has one (the best way for a team; see below), or your Azure sign-in (`az login`). As a fallback, add `--organization <name>` to paste a personal access token. Use a token for one organization: global tokens stop working on 1 December 2026.
- Add `--ssh-key` to any of them to create an SSH key and see where to upload it.

Then click **Check again**. The DevOps engineer can walk you through any of these in a chat (**Ask DevOps** on the workstation). It can start a browser sign-in for you and show you the web address and code to enter; it never asks for or types a token. When a token is needed it tells you to run the command above yourself or to use the **Connect** helper.

**Azure DevOps: use a Microsoft Entra service principal.** Personal access tokens that are not limited to one organization stop working on 1 December 2026, so for Azure DevOps use a service principal (an app identity in Microsoft Entra) or workload identity:

1. In Microsoft Entra register an application and create a client secret (or a federated credential for workload identity).
2. In Azure DevOps, under Organization settings, Users, add the application with Basic access, and give it Contributor on the project's repositories.
3. On the workstation set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` for the runner (with workload identity, `AZURE_FEDERATED_TOKEN_FILE` instead of the secret), and optionally `AZURE_DEVOPS_ORGANIZATION`.
4. Restart the runner and click **Check again**: Azure DevOps shows Connected.

A personal access token for one organization and `az login` (also `az login --service-principal`) keep working as fallbacks.

A **plain git** server needs no connection, but no pull request is opened: the branch is pushed and the desk tells you to open the request yourself. If a project's main line is protected on the host, finished work arrives as a pull request instead of going straight in (see [Testing and finalization](/help/testing-and-finalization#finalization)).

## Runner updates {#runner-updates}

The runner on a workstation keeps itself up to date. A few minutes after it starts, and then once a day, it asks the server which runner version is current. When a newer one exists it downloads it, checks that the file is intact, and waits until no agent is working on that workstation before it restarts into the new version. It never cuts a running job short. If the workstation stays busy for a very long time (about six hours) it updates anyway.

The runner version is shown under the workstation's name. When there is something to know, a small label appears next to it:

- **Update to 0.2.0 pending**: downloaded, waiting for the agents to finish.
- **Updating**: restarting into the new version (a few seconds).
- **Update failed**: it could not install the new version (the tip on the label says why). It keeps running the old one and tries again at the next daily check.
- **Update rolled back**: the new version did not connect within a few minutes, so the runner went back to the previous version by itself. It will not try that version again on this machine.
- **Updates paused**: the platform administrator paused automatic updates. Runners stay on their version until they resume.
- **Updates by hand**: this runner was started by hand and not by the installer's service, so it cannot restart itself. Run the install command again to update it.

You do not need to do anything. Running the install command again still upgrades a runner at any time. To switch automatic updates off on one computer, set `AOM_RUNNER_AUTO_UPDATE=0` for the runner.

## Unpairing {#unpairing}

If a workstation goes away (you sold the computer, decommissioned a server), go to **Workstations** and click **Unpair** on its card, then confirm. Its runner token stops working and the runner shuts down, cards claimed there go back to the queue, and its agents wait until you re-home them. To use the machine again, pair it with a new code.
