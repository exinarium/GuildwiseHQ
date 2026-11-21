---
title: Open source and self-hosting
summary: Guildwise HQ is free and open source (Apache 2.0). Where the code is, what self-hosting needs, how to ask for a feature and how to help.
keywords: [without paying, company, use at work, open source, apache, license, github, self-host, self hosted, docker, compose, deploy, free, fork, contribute, sponsor, ko-fi, discussions, commercial use, feature request, idea]
order: 31
---

## The license {#license}

Guildwise HQ is licensed under Apache 2.0: any use, commercial use included, with no fee and no permission needed, so a company can use it without paying. Every feature is in the free version.

## Where the code is {#code}

The source is at github.com/exinarium/GuildwiseHQ, created by Pieter Jordaan. Questions and ideas go in GitHub Discussions, bugs in GitHub Issues, and contributions follow CONTRIBUTING.md in the repository.

## Feature requests {#feature-requests}

Anyone can suggest a feature: post it in GitHub Discussions under Ideas, or open an issue with the feature request template. Say what you are trying to do, not only what you want built.

## Self-hosting {#self-hosting}

Run it with Docker Compose (the app, Postgres and a Caddy proxy) on your own server with a domain name, an SMTP relay for invitation emails and ports 80 and 443 open. The guide is docs/DEPLOY.md in the repository. Agents still run on your own workstations.

## Security settings {#security-settings}

Two settings on **Platform > Security > Security settings** (platform administrators only; each change asks **Confirm it's you**):

- **Only signed runners** (`AOM_REQUIRE_SIGNED_RUNNERS`): off by default. On, only runners signed by your server's key may pair or connect. Others are unlinked and must be reinstalled.
- **Require two-factor login** (`AOM_ENFORCE_TWO_FACTOR`): off by default. On, everyone without two-factor login must set it up before using anything.

On Guildwise Cloud both are locked on and cannot be changed. On a self-hosted server a saved choice on the tab beats the environment value.

Signing is optional. The official image carries the project's signed runner. If you want to sign the runner yourself, you create your own minisign key, keep the secret key off the server, sign the runner release, set `AOM_RUNNER_RELEASE_PUBKEY` and build with `RUNNER_RELEASE=own-key`. The steps are in docs/SELF-HOSTING.md. See also [Account security](/help/account-security#enforcement).

## Upgrading to 1.10.0 {#upgrade-1-10}

Guildwise 1.10.0 is a security release and is a breaking change for self-hosted installs. With the defaults nobody is locked out: both settings stay off, old runners keep working and, with automatic updates on, update by themselves (normally within about a day). After that update, run `guildwise-runner setup` once on each workstation so DevOps and deploys can continue. Platform administrators sign in once more.

What changes for everyone: sign-in locks, password reset needs a code on accounts with two-factor login, **Confirm it's you**, invitation limits, member reset rules, ownership transfers need the Owner's consent, platform administrators lose access to organization content, and the remote render worker uses its own token. Read "Upgrading to 1.10.0" in https://github.com/exinarium/GuildwiseHQ/blob/main/docs/SELF-HOSTING.md for the full list and for how to switch the two settings on.

## What self-hosting does not include {#not-included}

Hosting, backups, updates and support are yours to run when you self-host. Customization and setup support (custom workflows, custom agent development and organizational planning) is quoted on request: use Contact us where a hosted service offers it.

## Supporting the project {#support}

Optional ways to say thanks: star the repository, or donate through GitHub Sponsors (github.com/sponsors/GuildwiseHQ) or Ko-fi (ko-fi.com/guildwisehq). Donations help cover running costs.
