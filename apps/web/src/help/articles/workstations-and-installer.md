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

1. Go to **Workstations** (sidebar: Organization) and click **Add a workstation** (or the button in the middle if the list is empty).
2. **Pick the system**: Windows, Linux or macOS. The page guesses from your browser; change it if needed. Optionally type a name for the workstation.
3. **Read the steps and copy the command**: the command contains a link (works 30 minutes) and a pairing code (one time only). It never contains a password. If 30 minutes pass, choose your system again for a new one.
4. **Run the command on that computer**: open a terminal (Windows: PowerShell), paste and press Enter. Say yes when it asks permission. Windows may ask to restart; the installer carries on by itself when you sign in again.
5. **Watch this page**: it shows the installer starting, pairing ("Paired as..."), then health checks one by one, and finally **Ready**. The installer log shows each step. If it stops, the last line marked [x] says what to fix.

The installer asks only what it must: your password once (to install system tools), whether you want optional extras (yt-dlp for video transcripts; Docker, only if testers run containers), the folders that hold your code (it suggests `~/src`), and how Claude should sign in.

## Claude sign-in {#claude-sign-in}

The installer asks how agents should use Claude:

- **Claude subscription** (Pro, Max, Team or Enterprise): you sign in with your Claude account in a browser and work counts against your plan.
- **Anthropic API key**: you pay for exactly what agents use.

Choose whichever your organization provided. You can choose later and run `claude` on that computer any time; the health check "claude" shows the state.

## Installing by hand {#installing-by-hand}

Only needed when the guided setup is not an option:

1. Go to **Workstations** and click **Pair workstation**.
2. Copy the code `XXXX-XXXX` (valid 10 minutes).
3. On the computer, download or build the runner.
4. Pair it, add your repository folders, and start it as a service.

See the installer's help links for your system's commands. On Windows, install the runner inside WSL2 (Ubuntu): that is the only way to get a sandbox.

## Health checks {#health-checks}

After the installer finishes, go to **Workstations** and click on the workstation. It shows health checks: Node, git, Claude, the sandbox, Docker, yt-dlp, your repositories, and server connectivity.

A **red X** means something is missing or broken. Click it to see what and what to fix. Amber warnings (Docker, yt-dlp) are optional.

If you need to run checks again, click **Run doctor** on the workstation card.

## Windows {#windows}

**Default: WSL2** (recommended). Install the runner inside a WSL2 Ubuntu distribution and follow the Linux instructions. The installer turns on WSL2 for you; you just follow the steps. Agents run sandboxed inside WSL2 just like on Linux.

**Native Windows** (not recommended) cannot sandbox agents. Agents run without an OS sandbox and could read your SSH keys. The workstation shows an amber warning that cannot be dismissed. If you must run natively, set `"sandbox": "best_effort"` in the runner config.

For vault SSH keys on Windows, ensure git can find them (OpenSSH or PuTTY with Pageant).

## Unpairing {#health-checks}

If a workstation goes away (you sold the computer, decommissioned a server), go to **Workstations** and click its menu to **Unpair**. The runner stops connecting and any agents assigned to it show offline.
