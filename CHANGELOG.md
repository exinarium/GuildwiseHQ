# Changelog

All notable changes to Guildwise HQ are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

### Added

- CEO: a new signal flags a high-risk card (review risk "high") that has waited more than 24 hours for approval, counted from when it started waiting. Report only; it does not wake the CEO unless you add it to the urgent signals.
- CEO: the daily report lists the day's high-risk cards finished (merged, PR or push).
- Runner: `guildwise-runner` is installed alongside `aom-runner`; both names run the same command.
- Webhooks: outgoing signed webhooks carry `X-Guildwise-Signature`. `X-AOM-Signature` is still sent with the same value until October 2027.

### Changed

- New projects use `guildwise/` card branches (existing projects keep their prefix), and the runner's temporary integration branches are `guildwise/integration/<card>`. Branch cleanup recognises the old and new names.
- New local vaults are marked `.guildwise-local-vault` (the old marker is still written for one release and both are read); agent commits to vault repositories use `agents.guildwise.invalid`.
- New environment setups default to `~/guildwise-backups`. Deploy scripts' markers are read under both their old and new names, ahead of renaming them in a later release.
- One name for the CEO's report: "Daily report", on the desk, in the e-mail digest option and subject, and in the Help.
- Wording: "Add a workstation" (with "Pair with a code" for pairing codes) everywhere; the BA designs the organization with the Owner and Admins; "Agents page" instead of "HR board".
- The in-app Help and page help were checked against the current app and updated section by section.
- Removed the unused CEO cooling-off setting (`delayMinutes`); saved policies that contain it still load.
- The retired `.aom/test-env.json` is no longer read.

### Fixed

- Skills given to an agent: the skills added to a role with Extend now reach every agent on the role, in chats, sessions and card shifts alike, as loadable skills in the `# Capabilities` index and the runtime's skills folder. Before, chats got only the skills stored on the agent at hire, and card shifts listed the extension's skills as plain text only.
- A bare pack skill name typed into the hire form or a role extension (`bmad-prd`) is stored as the pack's full key (`bmad-method:bmad-prd`) when exactly one pack has it, instead of showing as "not found in the registry". The data migration `pack-skill-keys-2026-10` does the same for existing agents and extensions.
- Hiring with an empty Skills box gives the agent its role's skills (the form sent an empty list, which hired with none).
- An agent's skills follow its role: a new role version brings its new skills, and the agent's own additions and removals stay (`AgentPermissionsRebased` carries the skills).
- Reopening a published research card marks its publication superseded: the Research tab, phase completion and interest counts no longer count it, and publishing again leaves one live note.
- Reopening a bug card that was cancelled after a test failure puts its parent back to waiting when the parent is still queued or claimed in Test; otherwise both cards get a warning and the parent is left as it is.
- Media: a paused video is no longer cut after 30 seconds. Only real upstream silence (30 seconds) cuts a stream; a client that makes no progress for 10 minutes is closed. An upstream error mid-stream ends the response instead of throwing.
- Costs: the project filter lists every project, not only the selected one.
- Settings: you see and set your own time zone; non-Owners are told the daily report follows the Owner's zone.
- Intake and vault registration are offered only to people who may use them (desk, palette, empty board, discovery, Vaults).
- New research card from the Research tab starts on the research type.
- The org chart draws escalation to the CEO when one is active, as the routing does.
- CEO chat shows the error when the CEO status cannot be loaded, instead of "not set up yet".

## [1.0.1] - 2026-10-26

### Security

- Resolved all open security advisories: 21 Dependabot alerts (5 high, 15 moderate, 1 low) and the further findings from `pnpm audit`, which now reports no known vulnerabilities. Upgrades include nodemailer 10.2.1, @fastify/static 10.1.7, fastify 5.12.6, undici 8.12.2, zod 4.6.6, vite 7.3.7 and vitest 4.1.12, plus `overrides` for transitive packages (shell-quote, fast-uri, esbuild, @vitest/mocker).

### Fixed

- Runner: the outbox no longer throws when its data directory is removed while a shift or chat is still finishing. Nothing is persisted, the frame is sent best-effort, and a warning is logged, instead of an unhandled rejection that could stop the runner.

### Changed

- The site assistant's open-source facts (repository, self-hosting, license) are on by default.

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
