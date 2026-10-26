# Changelog

All notable changes to Guildwise HQ are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

## [1.0.0] - 2026-10-26

The first public release of Guildwise HQ, a way to run an organization of AI agents (set up for software delivery by default), under the Apache License 2.0. The repository keeps the development history, with the parts specific to the hosted service removed.

### Summary of what ships

**Work and delivery**

- Board with cards that move through spec, build, review, test, finalize and QA, with filters for blocked work, rework and items waiting for you.
- Project backlog, intake of tickets, and research cards.
- Discovery: turn an idea into a PRD with an analyst agent.
- Boardroom: a multi-persona discussion run by a chair agent, with minutes and "pull into PRD".
- Documents, including PRDs and minutes, with approval and version history.
- Phases, follow-ups, a release queue, environments and delivery recipes for deploys.

**Agents and team**

- Agent roles: business analyst, planner, architect (optional), builder, pre-reviewer, reviewer, tester and DevOps engineer.
- Hiring with seniority and per-project allow-lists; pausing, resuming and changing models.
- CEO agent in each organization, with a daily report and a desk for routine items.
- Org chart, custom roles, departments and workflows.
- Ledger of decisions, requirements and standing orders.

**Runtimes**

- Claude Code, Codex CLI, Gemini CLI, opencode and direct model APIs.

**Safety and control**

- Desk for questions, approvals and go-aheads; approval gates for risky steps.
- Sandboxed sessions: bubblewrap and socat on Linux and WSL2, Seatbelt on macOS, and a separate git worktree per session.
- Budgets and cost tracking per project and organization, with CSV export.
- Governance: "What it may do" per agent, audit log with CSV export, and an offboarding checklist.
- Two-factor login; organizations are isolated from each other.

**Knowledge**

- Vaults: git repositories of notes, synced to workstations.
- Capabilities and packs from git repositories, reviewed before use; playbooks and the `/` menu.
- Interests and automations.

**Operations**

- Workstations: runner for Linux, macOS and WSL2, with a guided installer; native Windows as an explicit, unsandboxed opt-in.
- Cloud workstations: a VPS over SSH, or a GitHub Codespace.
- Integrations: git hosts (GitHub, GitLab, Azure DevOps, Bitbucket Cloud) and Jira.
- Metrics, in-app help articles and a glossary.

**Self-hosting**

- Docker Compose stack: Caddy for HTTPS, the application, Postgres 18 and a media service for help videos.
- Migrations applied on boot. Platform account and organization invitations.
- Optional: Web Push, inbound mail, a landing-page assistant and a weekly blog digest.
- Every feature is included and organizations are unlimited: a self-hosted install has no plans, trials or limits.

### Notes for self-hosters

- Set `AOM_SECRET_KEY` and keep it with your backups.
- Back up the database before every upgrade. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- Update workstation runners together with the server.
