---
title: Cloud workstations (VPS and Codespaces)
summary: Run your agents on a server (VPS over SSH) or a GitHub Codespace instead of your own computer, with automatic pairing, sleeping when idle and a cost estimate.
keywords: [cloud, vps, ssh, codespaces, github, server, workstation, idle, office hours, cost, api key]
order: 19
---

A **cloud workstation** is a machine somewhere else that runs your agents, so your own computer can stay off. You choose where your agents run when you click **Add a workstation**:

- **My computer**: the installer for Windows, macOS or Linux (see [Workstations and the installer](/help/workstations-and-installer#add-a-workstation)).
- **A VPS (SSH)**: any Linux server you can log in to.
- **GitHub Codespaces**: a cloud machine from GitHub, for repositories on GitHub.

You pay the provider (your VPS company or GitHub) directly. Guildwise does not charge extra for them. By default an organization has **one** cloud workstation; it can be shared by all its projects.

## A VPS over SSH {#vps}

1. Click **Add a workstation** and choose **A VPS (SSH)**.
2. Enter the server's address, the SSH port (usually 22), the user, and either a password or an SSH key. Give it a name, and optionally what it costs a month so the page can show an estimate.
3. Click **Install and pair**. Guildwise logs in once, runs the same installer as for your own computer, and pairs the runner by itself. This takes a few minutes; the card on the Workstations page shows **Installing**, then **Running**.

The password or key is used for that one login. **It is not stored**: you will be asked again if you ever need to reinstall. Guildwise remembers only the server's public fingerprint, so it can tell if the server changes.

A normal user with sudo rights is safer than `root`. A VPS is always on: Guildwise cannot switch it off for you, so start and stop it at your VPS company. See "Bring your own VPS" in the repository's `docs/BYO-VPS.md` for sizes and providers.

## GitHub Codespaces {#codespaces}

1. Click **Add a workstation** and choose **GitHub Codespaces**.
2. **Connect GitHub**: create a token on GitHub with the `codespace` scope and paste it. Guildwise keeps it encrypted, only to wake and stop your codespace.
3. Enter the repository (`owner/name`), choose a machine type and see the estimated monthly cost.
4. **Add the generated file to the repository.** Guildwise shows a `devcontainer.json` made from the tools your project needs. It tells the Codespace to install the runner and pair itself. It contains no password or key. Commit it as `.devcontainer/guildwise/devcontainer.json`.
5. Add your Anthropic API key to GitHub as a Codespaces secret named `ANTHROPIC_API_KEY`, then click **Create the codespace**.

A Codespace **cannot run Docker**. If you deploy Docker images you still need a workstation of yours or a VPS for that, and your deploy targets must point there. The Workstations page tells you when you only have Codespaces.

You pay GitHub for a Codespace. Personal accounts get some free hours each month; check your GitHub billing page. If your credits or spending limit run out, or the codespace cannot start, Guildwise puts a notice on your desk and emails you once, and the card shows **Needs attention**. Fix it on GitHub, then press **Wake**.

GitHub itself stops a Codespace that has had no user activity for up to four hours, even while agents work. If that happens during a shift the work is picked up again later.

## Sleeping and waking {#sleep}

- A Codespace **stops after 30 minutes** with no agent working (choose 15 minutes to 2 hours with **Settings** on its card on the Workstations page).
- It **wakes by itself** when a card is queued that its agents can take.
- Optional **office hours** (days, hours and time zone) keep it asleep outside working time.
- **Wake** and **Stop** buttons are always there for you.

## What it costs {#cost}

Every cloud workstation shows an **estimated monthly cost**. For a VPS it is the price you entered. For a Codespace it is the running hours (your office hours, or about 8 hours on working days) times GitHub's hourly rate, plus disk. It is an estimate, not a bill.

## Signing in to Claude {#claude}

The recommended way is **your own Anthropic API key**. It stays on the cloud machine; Guildwise never receives or stores it.

- On a **VPS**: log in with SSH once and run `read -rs K; printf %s "$K" | aom-runner auth api-key`, then `systemctl --user restart aom-runner`.
- In a **Codespace**: add the key as the Codespaces secret `ANTHROPIC_API_KEY`.

You may also use your **Claude subscription**. This is meant for one person's own use, and many agents working in parallel can run into its limits, so Guildwise shows an "individual use" warning. For a team, use an API key.
