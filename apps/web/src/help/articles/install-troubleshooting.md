---
title: Installing a workstation: if something goes wrong
summary: Installer troubleshooting: expired links, restart, permissions, git version, sandbox.
keywords: [install, troubleshooting, error, fix, workstation, virtualization, BIOS]
order: 19
---

The installer is safe to run again at any time: it carries on where it stopped, repairs what is broken and keeps what works. Start with the step it stopped at (the last line marked with [x]), then look for it below.

## It says the link has expired or the pairing code was refused {#link-expired}

For safety the command works for 30 minutes and its pairing code can be used once. Open Workstations, click Add a workstation and copy the new command. Only the newest command works: starting the wizard again cancels the earlier one.

## This page keeps saying "Waiting for you to run the command" {#waiting-for-command}

The installer has not reported in yet. Check that you ran the command on the computer that will host your agents, and that it can open this site in a browser (a company firewall or VPN may block it). If the installer printed an error, the line starting with [x] says what to fix.

## Windows asked me to restart {#windows-restart}

Say yes. Turning on WSL2 (Linux inside Windows) can need more than one restart (up to two for WSL2 and one more for Ubuntu). After each restart, sign in as usual: the installer opens again by itself, and Windows may ask you to allow it. If it does not come back, run the command again. If WSL2 is still not ready after that, it stops and names what is still off: turn on virtualization in the BIOS/UEFI of the PC (see [virtualization is off](#windows-virtualization)), or run `wsl --install` in PowerShell, then run the command again.

## It says virtualization is off in the BIOS/UEFI (Windows) {#windows-virtualization}

WSL2 runs Ubuntu in a small virtual machine, so the PC must have virtualization turned on in its firmware. The installer stops at step 2 and says so when it is off. Open the BIOS/UEFI settings while the PC starts (often F2, F10, F12 or Del), or in Windows go to Settings > System > Recovery > Advanced start-up > UEFI firmware settings. Turn on **Intel VT-x** / **Virtualization Technology**, or **AMD SVM** / **AMD-V**, save, restart and run the installer command again. If the setting is on and it still stops, run `bcdedit /set hypervisorlaunchtype auto` in an administrator PowerShell and restart. On a virtual machine, turn on nested virtualization in its host. A PC with no such setting may have a processor that cannot run WSL2.

## Ubuntu asks me for a user name and password (Windows) {#ubuntu-user}

That is the Linux inside your PC, not your Windows login. Choose any name and a password you will remember: the installer asks for it again when it adds tools. Nothing shows on screen while you type a password; that is normal.

## It says systemd is not running {#systemd}

The runner starts by itself from a systemd service. On Windows the installer switches systemd on in Ubuntu (it writes systemd=true to /etc/wsl.conf); if you see this message, run wsl --shutdown in PowerShell and run the install command again. On a server or container without systemd the runner is started in the background only and will not come back after a restart.

## It says I need administrator rights {#administrator-rights}

Installing git, bubblewrap and socat uses your administrator (sudo) password once. Ask whoever manages your computer to install them, or to add you to the sudoers, and run the command again.

## git is too old {#git-too-old}

The runner needs git 2.40 or newer. The installer upgrades it on Ubuntu (from the official git PPA) and on Debian (it builds a recent git into your home folder, which takes a few minutes). On other systems install a newer git yourself and run the command again.

## The health check "sandbox" is not "enforced" {#sandbox}

Agents (all except the DevOps engineer) run inside a sandbox so they cannot read your SSH keys or other projects. On Linux and WSL2 it needs bubblewrap and socat; on Ubuntu 24.04 and newer an AppArmor setting can block bubblewrap (the Claude Code sandboxing documentation shows the one-line fix). macOS needs nothing. Until it says enforced, agents are not scheduled on that workstation.

## Which Claude sign-in should I choose? {#claude-sign-in-choice}

A Claude subscription (Pro, Max, Team or Enterprise): you sign in with your Claude account in a browser and the agents' work counts against your plan, with no per-use bill. An Anthropic API key: you pay for exactly what the agents use. Use whatever your organization gave you. You can also choose later and run claude on that computer when you are ready; the "claude" health check shows the state.

## Docker or yt-dlp show a warning {#optional-tools}

Both are optional. Docker is only needed if your testers run containers; yt-dlp lets agents read video transcripts. For yt-dlp, run `guildwise-runner extras install yt-dlp` on the workstation (the installer's line 6 does the same). For Docker, run `guildwise-runner setup` again and change line 3, or ignore the warning.

## The Approvals page says it is not signed in, or asks me to pair {#approvals-pair}

This browser is not paired with this runner, was forgotten, or the page moved to a new port. Click **Pair this browser**, copy the command, paste it in a terminal on that computer and type `yes`.

## The command asks for a password {#command-password}

`sudo` asks for your own password on that computer, the one you use to sign in to it. Nothing shows while you type. It is not a Guildwise password.

## The Approvals link does not open on Windows {#approvals-windows}

The link opens only in a browser on the same computer as the runner, and on Windows the runner lives inside WSL. Use the copy-paste commands from the Workstations page instead.

## Approvals page could not start: another program uses port N {#approvals-port}

Stop the other program, or run `guildwise-runner approvals port <new number>` on that computer and pair the browser again. The copy-paste commands keep working meanwhile.

## I still need help {#still-need-help}

If the workstation is already paired, **Ask DevOps** on it can often fix the problem for you. Otherwise use [Contact us](/help/writing-to-us#contact-us) and say which system you use and which step stopped. The form attaches the details we need. For a server or Codespace, see [Cloud workstations](/help/cloud-workstations).
