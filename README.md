# Agent Org Manager

A self-hosted site for running an organization of AI coding agents. A manager creates projects and cards; builder, reviewer and other agents claim cards exclusively, work in git worktrees on the manager's own workstations (through a small runner), and hand work off through a board. State is event sourced in Postgres.

- Product: `docs/SPEC.md`
- Design (the contract): `docs/ARCHITECTURE.md`
- Build order: `docs/PLAN.md`

## Layout

```
packages/shared   @aom/shared: zod schemas (events, API, protocol), workflows, roles, prompt rendering
apps/server       Fastify API, event store, dispatcher
apps/runner       aom-runner + in-session `aom` CLI
apps/web          React SPA
e2e               Playwright tests
```

## Requirements

Node 22.23 (`nvm use`), pnpm 12 (`corepack enable`), Docker (for dev Postgres).

## Quickstart (development)

```sh
nvm use && corepack enable
pnpm install
docker compose -f docker-compose.dev.yml up -d      # Postgres on 127.0.0.1:5433 (aom/aom; dbs aom and aom_test)
pnpm db:migrate                                     # apply migrations to `aom`
pnpm --filter @aom/server admin:create --email you@example.com --name "You" --password 'at-least-12-chars'
pnpm dev                                            # server on :4600, web on :5173 (proxies /api and /api/ws)
```

Invitation mail goes to SMTP `127.0.0.1:1025` by default (run Mailpit, UI on :8025). Sign in at http://localhost:5173, invite a member from Admin, accept the mailed link.

Pair a runner (token-free mock agents, or Claude Code once credentials are set):

```sh
pnpm --filter @aom/runner build
# Web: Workstations > Pair workstation > Generate pairing code
node apps/runner/dist/aom-runner.mjs pair --server http://localhost:4600 --code XXXX-XXXX --name Desktop --mock --data-dir .dev/runner
node apps/runner/dist/aom-runner.mjs repos add ~/src --data-dir .dev/runner
node apps/runner/dist/aom-runner.mjs start --mock --data-dir .dev/runner      # or: pnpm runner:dev
```

Then create project `TOY` with the repo's remote URL (the Workstations page lists a repo once a project has it), hire builder/reviewer agents with runtime `mock`, create and specify a card. A card's `Mock script` field (`{"review":["changes","ok"]}`) scripts the mock agent.

Run the tests:

```sh
pnpm typecheck && pnpm lint && pnpm test            # unit and integration (needs the dev Postgres for the server suite)
pnpm e2e                                            # builds, then Playwright: server :4601 + db aom_e2e + web + mock runner
pnpm e2e:prod                                       # AC10: prod compose + Caddy HTTPS + runner pairing (needs Docker)
```

`pnpm e2e` needs Chromium (`pnpm --filter @aom/e2e exec playwright install chromium`), Postgres on 127.0.0.1:5433 and Mailpit (SMTP 1025, API 8025). It recreates the database `aom_e2e` and works in `/tmp/aom-e2e` (`AOM_E2E_DIR`). Specs run in order (auth, pairing, core-loop) in one worker.

Deployment and runner packaging: `docs/DEPLOY.md`.

## Workspace scripts

| Script | Does |
| --- | --- |
| `pnpm dev` | server and web in watch mode |
| `pnpm runner:dev` | runner against `.dev/runner` |
| `pnpm test` | all vitest suites |
| `pnpm build` | build every package (web, server, runner) |
| `pnpm e2e` | Playwright end-to-end tests (M1 AC 1-9) |
| `pnpm e2e:prod` | scripted prod-compose check (AC 10) |
| `pnpm package:runner` | `release/aom-runner-<version>.tgz` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | Biome check (`pnpm format` to fix) |
| `pnpm db:migrate` | apply SQL migrations |
