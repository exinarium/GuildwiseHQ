# Guildwise HQ

_Guildwise HQ: your guild of AI agents. Many hands. One master._

Guildwise HQ is the product name you see in the web app, the emails and the guides. The internal identifiers keep their names: the `@aom/*` packages, the `aom` CLI, `aom-runner`, the `AOM_*` environment variables and the database.

A self-hosted site for running an organization of AI coding agents. A manager creates projects and cards; builder, reviewer and other agents claim cards exclusively, work in git worktrees on the manager's own workstations (through a small runner), and hand work off through a board. State is event sourced in Postgres.

- **Product spec**: `docs/SPEC.md`
- **Design contract**: `docs/ARCHITECTURE.md`
- **Build plan**: `docs/PLAN.md` (all 10 milestones implemented)
- **Deployment guide**: `docs/DEPLOY.md`
- **User guide**: `docs/USER-GUIDE.md` (plain-language guide for every role), with an illustrated PDF: `docs/guide/Guildwise-HQ-User-Guide.pdf`
- **Runner guide**: `docs/RUNNER.md`

## Features

### Core workflow
- Single board showing all cards, stages, assignees, age and risk tier
- Exclusive claims: one agent per card, no idle waiting
- Work flows through: Spec → Build → Review → Test → Finalize, with Rework and bug loops
- Builder, reviewer, tester and technical writer roles on code projects
- Research and feed projects with scout/curator/researcher/checker roles

### Manager tools
- **Decision desk**: every question and approval reaches the manager with context
- **Ledger**: answers recorded once, shared with future agents
- **Vaults**: git-backed knowledge repositories: one organization vault and an optional vault per project
- **Standing orders**: recurring instructions for teams of agents
- **Chat with agents**: real-time conversations with builders on the board (Claude-powered)
- **Intake from Jira/GitHub**: BA maps tickets to projects and drafts cards with specs and test plans
- **Outbox approvals**: controlled posting back to Jira/GitHub (no agent names or internal details)
- **HR board**: agent performance, recommendations, track records

### Organization design
- Hire agents with roles, models, skills and capacity (default 1 card at a time)
- Fire agents: resets sandbox, releases claimed cards, keeps official record
- DevOps engineer: one per workstation, always available for setup and maintenance
- Custom roles and workflows via the BA design chat (validated, owner-approved)
- Shared projects: invite other users as additional managers per project only

### Intelligence
- Scheduling: scheduled tasks fire on time, agents pull side projects when idle
- Dispatcher: smart ordering (scheduled work first, then own rework, then the organization's project ranking, then card priority and age; dependencies block)
- Risk assessment: auto-computed from diff size, overridable to "large" (needs two reviewer approvals)
- Double review on large cards and full-suite failures
- Bottleneck detection: desk alert when testers are busy and E2E work waits
- Recommendations: rule-based prompts for model changes, role splits, hiring, policy fixes

### Agent adapters
- **Claude Code baseline**: agents run `claude` CLI in a session
- **Mock runtime**: token-free test adapter; card script specifies behavior per stage
- Integration via MCP for Jira, GitHub and custom tools

### Work guarantee
- No agent ever blocks waiting on another
- Testing runs in parallel with building
- Card history and handoffs are immutable
- Vaults and ledger stay local and separate from company systems
- Nothing leaves without manager approval

## Repository layout

```
packages/shared           @aom/shared: zod schemas (events, API, protocol), workflows, roles
apps/server               Fastify API, event store, dispatcher, scheduler
apps/runner               CLI (aom-runner) + in-session `aom` command, git worktrees
apps/web                  React SPA
e2e                       Playwright tests
```

## Requirements

Node 22.23 (use `nvm use`), pnpm 12 (via `corepack enable`), Docker for dev Postgres.

## Quick start — development

1. Start Postgres and Mailpit (for testing):

```sh
docker compose -f docker-compose.dev.yml up -d
```

2. Set up the database and create your admin account:

```sh
nvm use && corepack enable
pnpm install
pnpm db:migrate
pnpm --filter @aom/server admin:create --email you@example.com --name "You" --password 'at-least-12-chars'
```

3. Start the server and web UI:

```sh
pnpm dev
# Server: http://localhost:4600 (also serves /api)
# Web UI: http://localhost:5173 (proxies /api to server)
# Mailpit: http://localhost:8026 (invitation emails; SMTP on 1026, see docker-compose.dev.yml)
```

4. In the web UI, create a Workstations pairing code, then pair a runner and add repos:

```sh
pnpm --filter @aom/runner build
node apps/runner/dist/aom-runner.mjs pair --server http://localhost:4600 --code XXXX-XXXX --name Desktop --mock
node apps/runner/dist/aom-runner.mjs repos add ~/src --data-dir .dev/runner
node apps/runner/dist/aom-runner.mjs start --mock --data-dir .dev/runner
# Or simply: pnpm runner:dev
```

5. Create a project, hire agents, and specify a card:

- **Board** page: create project `TOY` with your repo URL
- **Agents** page: hire a builder and reviewer (mock runtime)
- **Board** page: create a card with spec, requirements, acceptance criteria, test plan; fill the **Mock script** field (shown because `pnpm dev` runs the server with `AOM_MOCK_UI=true`) with `{"review": ["changes", "ok"]}` to bounce review once; specify it
- Watch the card move through the board as the mock agents work

## Running tests

```sh
pnpm typecheck && pnpm lint && pnpm test      # unit + integration (needs postgres on 5433)
pnpm e2e                                      # Playwright E2E (needs fresh aom_e2e DB, Mailpit, Chromium)
pnpm e2e:prod                                 # Runs prod compose setup (M1 AC 10: full stack HTTPS, Docker)
```

**E2E prerequisites**: Postgres on 127.0.0.1:5433 (aom/aom), a Mailpit (SMTP 1025 / API 8025 by default; point the suite at another one with `AOM_E2E_SMTP_URL` and `AOM_MAILPIT_API`, for example the dev Mailpit on 1026 / 8026), Chromium (`pnpm --filter @aom/e2e exec playwright install chromium`). Tests run in `/tmp/aom-e2e` and create/drop the `aom_e2e` database.

## Workspace scripts

| Script | Does |
| --- | --- |
| `pnpm dev` | server and web in watch mode (ports 4600, 5173) |
| `pnpm runner:dev` | runner against `.dev/runner` data dir |
| `pnpm test` | all vitest unit and integration tests |
| `pnpm build` | build web, server and runner bundles |
| `pnpm e2e` | Playwright end-to-end tests |
| `pnpm e2e:prod` | scripted production compose check |
| `pnpm package:runner` | builds `release/aom-runner-<version>.tgz` |
| `pnpm typecheck` | TypeScript check all packages |
| `pnpm lint` | Biome lint and format check |
| `pnpm db:migrate` | apply SQL migrations to the aom DB |
| `pnpm projections:rebuild` | replay all events to rebuild projection tables |

## Architecture and design

The system is event-sourced: every state change (cards moving, questions asked, agents hired) is appended as an immutable event to the database. Projections (denormalized query tables) are updated synchronously in the same transaction, ensuring consistency.

Agents run on your workstations via the runner, which connects outbound to the server over WebSocket. Each agent works in an isolated git worktree with its own config and sandbox (for Claude Code, its own `CLAUDE_CONFIG_DIR`). Work handoffs are written back through the `aom` CLI (IPC over HTTP).

The manager's workspace is a React SPA that polls and listens for updates over WebSocket. No agent credentials or code leave the workstation. Card history is immutable and scoped to the org and projects the manager owns or shares.

See `docs/ARCHITECTURE.md` for the complete design, including the event envelope, projections, dispatcher ordering, runner protocol, and IPC schema.

## Next steps

- For deployment: `docs/DEPLOY.md`
- For running agents: `docs/RUNNER.md` or `apps/runner/README.md`
- For using the product (every role): `docs/USER-GUIDE.md`, or the illustrated PDF `docs/guide/Guildwise-HQ-User-Guide.pdf`
- For customization and organization design: `docs/SPEC.md` §6 and §10
