# Guildwise HQ

**Run an organization of AI agents.** Free and open source. Give your agents roles, a lean team, a board, your desk, approval gates, budgets and an audit trail, on your own machines and AI accounts, while you make the decisions. It comes set up for software delivery (spec, build, review, test, deploy) and extends to other work you hand to agents.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/exinarium/GuildwiseHQ)](https://github.com/exinarium/GuildwiseHQ/releases)
[![GitHub Discussions](https://img.shields.io/github/discussions/exinarium/GuildwiseHQ)](https://github.com/exinarium/GuildwiseHQ/discussions)
[![CI](https://github.com/exinarium/GuildwiseHQ/actions/workflows/ci.yml/badge.svg)](https://github.com/exinarium/GuildwiseHQ/actions/workflows/ci.yml)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20us-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/exinarium)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Sponsor-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/exinarium)
[![Commercial supporter](https://img.shields.io/badge/Commercial%20supporter-Guildwise-2ea44f)](https://guildwisehq.com/pricing)

---

## What is Guildwise HQ?

Guildwise HQ is a way to **run an organization of AI agents**. You hire agents into roles, give them work as cards on a board, and stay in charge: when an agent is unsure, or a step is risky, it asks you on your **Desk** and waits.

It comes **set up for software delivery by default**: you describe what you want as a card, and a team of agents turns it into a specification, builds it on a branch of your repository, has another agent review it, tests it and lands it. The same organization also runs other work: research projects that answer questions with cited sources, scheduled feeds and digests, and your own roles and workflows. Packs and playbooks teach agents how you work, and Discovery and the Boardroom help you think an idea or a decision through into a document.

- **The board** shows every piece of work and where it stands.
- **The Desk** is your inbox of decisions: questions, approvals and go-aheads that only you can give.
- **The agents** have roles, seniority and a place on the org chart. They run on *your* workstations, so your files, credentials and accounts stay where they are.
- **The ledger** remembers decisions and standing orders, so nobody asks you the same thing twice.
- **The guardrails** are budgets, approval gates, sandboxed sessions and an audit log.

The Guildwise HQ server holds the board, the desk and the records. It never holds your repository credentials, provider keys or vault contents.

---

## Key features

**Work, from idea to done** (software delivery is the default workflow)
- **Board and cards.** Cards move through spec, build, review, test, finalize and optional QA. Filters show what is blocked, in rework or waiting for you.
- **Backlog and intake.** Quick-add ideas, send them to the business analyst, or bring in tickets (Jira is supported on the runner).
- **Discovery.** Turn a rough idea into a requirements document (by default a PRD) with an analyst agent.
- **Boardroom.** A multi-persona discussion of any question or decision, run by a chair agent, with minutes you can pull into a PRD.
- **Phases, releases and environments.** Ship work in phases, through a release queue, with delivery recipes for your own apps.

**Agents and team**
- Roles in the default software workflow: business analyst, planner, architect (optional), builder, pre-reviewer, reviewer, tester and DevOps engineer.
- Hire agents with a role, seniority and a per-project allow-list. Pause, resume or change their model.
- A **CEO agent** in every organization handles routine items before they reach your Desk and writes a daily report.
- An **org chart**, plus custom roles, departments and workflows, so the organization can be shaped for work other than software.
- **Other kinds of project.** Research projects (questions answered with cited sources, results kept in your vault) and feeds (scheduled scans and digests) sit next to code projects.

**Runtimes**
- Claude Code, Codex CLI, Gemini CLI, opencode and direct model APIs. Each workstation signs in to the runtimes it uses.

**Control and safety**
- **Approval gates.** Choose what always needs your go-ahead, such as merging or pushing.
- **Sandboxed sessions.** Each agent works in its own git worktree with its own home directory. On Linux and WSL2 the sandbox uses bubblewrap and socat; on macOS it uses the built-in Seatbelt sandbox.
- **Budgets and costs.** Monthly budgets per project and per organization, a cost breakdown, and loop protection.
- **Governance.** A "What it may do" view per agent, an audit log with CSV export, and an offboarding checklist.
- **Isolation.** Organizations are separated from each other, and two-factor login is available for everyone.

**Knowledge**
- **Vaults.** Git repositories of notes, synced to the workstations that need them.
- **Ledger.** Decisions, requirements and standing orders that every agent reads at the start of a shift.
- **Capabilities and packs.** Skills and playbooks from git repositories, reviewed before an agent may use them.
- **Interests and automations.** Follow topics and run scheduled or triggered work.

**Operations**
- **Workstations.** Your own PC, a Mac, a Linux machine, WSL2, a server you rent over SSH, or a GitHub Codespace.
- **Git hosts.** GitHub, GitLab, Azure DevOps and Bitbucket Cloud.
- **Deploys.** Docker Compose deploys to your servers, with a database backup and an automatic rollback when the new version is not healthy.
- **Metrics.** Throughput, time blocked on you, bounce rate, escaped bugs and queue depth.
- **Help.** In-app articles, a glossary and short videos.

---

## How it works

```mermaid
flowchart LR
    You["You<br/>board, Desk, decisions"] <--> Web["Web app"]
    Web <--> Server["Guildwise server<br/>Fastify, Postgres, event log"]
    Runner["Runner on a workstation"] -- "outbound WebSocket (wss)" --> Server
    Runner --> Agents["Agents in sandboxed<br/>sessions"]
    Agents --> Repos[("Your repositories,<br/>files and vaults")]
```

- The **server** records every change as an event and keeps a projection for the board. It needs only Postgres.
- The **runner** is a small Node program on each workstation. It connects *out* to the server, so no inbound port is needed on the workstation.
- **Agents** run inside the runner, on the machine that holds the work (for software, in a separate git worktree per card).

Technical design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Product guide: [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

---

## Self-host in 10 minutes

You run the server on a machine you control, and connect your workstations to it. This is the whole path: a clean server, a domain name, and about ten commands.

### What you need

| Need | Notes |
| --- | --- |
| A Linux server | Any VPS or machine with a public address. We recommend 2 vCPUs, 4 GB of RAM and 20 GB of disk (the image build is the heavy part). |
| Docker with Compose v2 | Check with `docker compose version`. |
| A domain name | An `A` record that points at the server, for example `guildwise.example.com`. |
| Ports 80 and 443 open | Caddy uses them for HTTPS. |
| An SMTP relay | Sends invitation mail. Any provider that gives you an `smtp://` or `smtps://` URL works. (To only try the stack, add `--profile mail` to the compose commands below for a built-in mail catcher.) |
| Git | To clone the repository. |

### 1. Get the code

```bash
git clone https://github.com/exinarium/GuildwiseHQ.git
cd GuildwiseHQ
cp .env.prod.example .env
```

### 2. Generate two secrets

```bash
openssl rand -hex 32   # use this as POSTGRES_PASSWORD
openssl rand -hex 32   # use this as AOM_SECRET_KEY
```

Hex output is used on purpose: it contains no characters that break the database URL.

### 3. Fill in `.env`

Open `.env` and set these five values (everything else can stay as it is). The stack will not start without `POSTGRES_PASSWORD`, `AOM_PUBLIC_ORIGIN` and `AOM_SECRET_KEY`, and invitations will not send without a real `AOM_SMTP_URL`:

```dotenv
POSTGRES_PASSWORD=<first value from step 2>
AOM_DOMAIN=guildwise.example.com
AOM_PUBLIC_ORIGIN=https://guildwise.example.com
AOM_SMTP_URL=smtp://user:password@smtp.example.com:587
AOM_SECRET_KEY=<second value from step 2>
```

- `AOM_SECRET_KEY` is required. It encrypts two-factor secrets and stored account tokens at rest. Keep it with your backups. Changing it later invalidates enrolled authenticator apps.
- Keep `.env` private. It is in `.gitignore`; never commit it.

### 4. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
curl https://guildwise.example.com/api/health
# {"ok":true,"db":true}
```

The first build takes a few minutes. Migrations run automatically on first start.

### 5. Create the platform account

The platform account runs the service. It manages organizations and invitations, and it cannot see anyone's work.

```bash
docker compose -f docker-compose.prod.yml exec app node dist/superadmin-create.mjs \
  --email platform@example.com \
  --name "Platform" \
  --password 'use-a-long-passphrase'
```

Sign in at your public address with that account. You are asked to set up two-factor login. Keep the recovery codes.

### 6. Invite the first organization

As the platform account, open **Platform > Invitations**, enter the **Owner email** and the **Organization name**, and send the invitation. The owner opens the link in the mail, enters their name and a password, and lands in the new organization.

If you would rather create a user and an organization directly:

```bash
docker compose -f docker-compose.prod.yml exec app node dist/admin-create.mjs \
  --email you@example.com --name "You" --password 'use-a-long-passphrase' \
  --org "Your organization"
```

### 7. Connect a workstation

Sign in as the organization owner. Then:

1. Open **Workstations > Add a workstation** and copy the one-line command for your system (Linux, macOS or WSL2). Run it on the workstation. It installs the runner, pairs it and starts it as a background service.
2. Sign in to Claude on that workstation, either with `claude` (your subscription) or with an API key.
3. Choose the folders that hold your code. The runner finds the repositories in them.

To pair by hand instead, create a one-time code under **Workstations > Pair workstation** (it is valid for 10 minutes) and run:

```bash
aom-runner pair --server https://guildwise.example.com --code XXXX-XXXX --name "Desktop"
aom-runner repos add ~/src
aom-runner start
```

### 8. HTTPS

With `AOM_DOMAIN` set to a public name, Caddy gets a Let's Encrypt certificate by itself once the DNS record points at the server and ports 80 and 443 are reachable. Check progress with:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

Done. For upgrades, backups, optional features and troubleshooting, read **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

---

## Guildwise Cloud (hosted)

Prefer not to run a server? **Guildwise Cloud** at [guildwisehq.com](https://guildwisehq.com) runs it for you.

- **$30 per month** covers the organization and its owner, plus **$10 per month for each regular member**. VAT is included. A 7-day trial is available.
- **No backups, by design.** We don't own your data, so we don't keep copies of it. Export whenever you like.
- Hosted customers join the community, with free occasional webinars and training.
- Customization and setup support (custom workflow and agent development, and organizational planning) is quoted on request: contact us through the site.

**Self-hosted installs get every feature, and any number of organizations.** There is no plan, trial or limit on your own server.

---

## Support the project

Guildwise HQ is **free software** (Apache 2.0). Nothing in it is paywalled. If it is useful to you and you want to help keep it going:

- **Ko-fi:** [ko-fi.com/exinarium](https://ko-fi.com/exinarium)
- **GitHub Sponsors:** [github.com/sponsors/exinarium](https://github.com/sponsors/exinarium)
- **Commercial supporter:** an optional, pay-what-you-want (minimum $5) commercial license with a "Commercial supporter" badge. It is voluntary, because Apache 2.0 already allows commercial use. Details on the [pricing page](https://guildwisehq.com/pricing).

---

## Develop

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d postgres
pnpm db:migrate
pnpm dev                       # server on :4600, web app on :5173
```

Repository layout: `apps/server` (Fastify, Postgres, event sourced), `apps/web` (React), `apps/runner` (the workstation runner, `aom-runner`), `packages/shared` (schemas and shared logic), `e2e` (Playwright). The `@aom/*` package names, the `aom` command and the `AOM_*` variables keep their original names. The server and the web app have extension points that default to no-ops, so a hosted service can plug in billing, sign-up and support without a fork (`docs/ARCHITECTURE.md`, section 40). Tests, scripts and project rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Contributing

Everyone is welcome to:

- **Ask questions and share ideas** in [GitHub Discussions](https://github.com/exinarium/GuildwiseHQ/discussions).
- **Report bugs and request features** in [GitHub Issues](https://github.com/exinarium/GuildwiseHQ/issues).
- **Send pull requests.** Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It covers the dev setup, tests, the Developer Certificate of Origin (every commit needs `git commit -s`), and the review process.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Decisions about what is merged are described in [GOVERNANCE.md](GOVERNANCE.md).

---

## Security

**Do not report vulnerabilities in public issues.** Use GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/exinarium/GuildwiseHQ/security/advisories/new)**

We aim to fix confirmed issues within four weeks before public disclosure. Only the latest release receives security fixes. Details are in [SECURITY.md](SECURITY.md).

---

## License and trademarks

- Code: [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the copyright notice.
- The name and logo **Guildwise HQ** are not licensed for use as the name of a fork or a product. Factual references such as "based on Guildwise HQ" are fine. See [TRADEMARKS.md](TRADEMARKS.md).

Created by [Pieter Jordaan](https://github.com/exinarium). Copyright 2026 Pieter Jordaan.
